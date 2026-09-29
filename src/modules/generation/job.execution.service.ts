import { and, between, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { generationJobs, generationJobSubjects, mockQuestions, mocks } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { examProfileService } from '../exams/exam.service.js';
import { sectionLayoutByName, type SectionSlot } from '../exams/section.layout.js';
import type { ExamProfile } from '../exams/types.js';
import { seededRandom } from '../../common/random.js';
import { mockAssemblyService } from './mock.assembly.service.js';
import { apportion, planSection, shuffle, type PlannedSlot } from './section.plan.js';
import { OptionBalancer } from './option.balance.js';
import {
  associateQuestions,
  availabilityKey,
  bankAvailability,
  bankCandidates,
  findOrphans,
  loadFingerprints,
  persistToBank,
  recentStems,
  type BankQuestionRef,
} from './question.bank.js';
import { fingerprint, isDuplicate, validateItem, type BankFingerprint } from './question.quality.js';
import {
  CallBudget,
  CallBudgetExhaustedError,
  type Difficulty,
  type GeneratedQuestion,
  type Language,
  type QuestionWriter,
  type WriteSlot,
} from './question.types.js';
import { QuotaExhaustedError, isRetryableProviderError } from './llm/gemini.client.js';

export interface JobExecutionOptions {
  /** How often the running job's heartbeat_at is refreshed. */
  heartbeatIntervalMs?: number;
  /** Questions per LLM request. */
  batchSize?: number;
  /** Fresh questions per full paper when the bank could supply everything. */
  newPerMock?: number;
  /** Hard ceiling on fresh questions per full paper, even when the bank runs short. */
  maxNewPerMock?: number;
  /** Hard cap on LLM requests (including retries) for one mock. */
  maxCallsPerMock?: number;
  /** LLM requests run at the same time (the Gemini limiter also enforces pacing). */
  concurrency?: number;
  /** Recent bank stems per topic sent as "do not repeat" hints. */
  avoidPerTopic?: number;
}

export class JobNotExecutableError extends Error {
  constructor(jobId: string, status: string | undefined) {
    super(`Job ${jobId} is not executable. Status: ${status}`);
    this.name = 'JobNotExecutableError';
  }
}

/** The job stopped being IN_PROGRESS under this executor (released or recovered). */
export class JobReleasedError extends Error {
  constructor(jobId: string, status: string | undefined) {
    super(`Job ${jobId} was released while executing (status now: ${status})`);
    this.name = 'JobReleasedError';
  }
}

const MAX_ERROR_LENGTH = 500;
const truncate = (message: string) => message.substring(0, MAX_ERROR_LENGTH);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Human-readable steps shown on the progress screen (stored in generation_jobs.current_subject). */
export const STAGE = {
  selecting: 'Selecting questions',
  writing: (done: number, total: number) => `Writing new questions (${done} of ${total})`,
  finalising: 'Finalising paper',
} as const;

type SlotSource = 'bank' | 'new';

/** One section of the paper being filled. */
interface SectionFill {
  subjectJobId: string;
  subject: string;
  block: SectionSlot;
  slots: PlannedSlot[];
  assigned: Array<string | null>;
  source: Array<SlotSource | null>;
  balancer: OptionBalancer;
  /** Slots that may be written fresh (quota + allowance); others come from the bank only. */
  writable: Set<number>;
}

interface OpenSlot {
  section: SectionFill;
  index: number;
}

/** Why the writing stage stopped early; later batches are skipped instead of burning calls. */
interface WriteState {
  budget: CallBudget;
  stopReason: string | null;
  errors: string[];
  fingerprints: Map<string, BankFingerprint[]>;
  batchesDone: number;
  batchesPlanned: number;
}

/**
 * Builds a mock paper mostly from the question bank, topped up with a few freshly
 * generated questions:
 *
 *  1. Plan: every section's slots get a topic + difficulty from the exam profile
 *     (seeded by job and subject, so a resumed job re-plans identically).
 *  2. Select: ~GENERATION_NEW_PER_MOCK slots (default 18 of 120) are reserved for fresh
 *     questions on the topics the bank covers worst, so the bank grows evenly. Every
 *     other slot gets an unseen, unflagged bank question — planned topic first, then any
 *     topic of the subject. Only if the bank has nothing unseen left may a slot be written
 *     fresh, up to GENERATION_MAX_NEW_PER_MOCK; beyond that the user's least-recently-seen
 *     questions are reused. The section's difficulty mix is kept exact throughout.
 *  3. Write: reserved slots go to the LLM in mixed-subject batches (GENERATION_BATCH_SIZE
 *     per request), paced by the Gemini limiter and capped by GENERATION_MAX_CALLS_PER_MOCK.
 *     Every item is validated locally; valid, non-duplicate questions are balanced and
 *     banked immediately. Missing slots get ONE repair pass. Quota exhaustion or an error
 *     a retry cannot fix stops writing at once.
 *  4. Fallback: anything still open is filled from the bank with relaxed matching.
 *  5. Commit: sections' mock_questions + COMPLETED status in one transaction, then the
 *     assembled paper is validated and the mock marked READY.
 */
export class JobExecutionService {
  private readonly heartbeatIntervalMs: number;
  private readonly batchSize: number;
  private readonly newPerMock: number;
  private readonly maxNewPerMock: number;
  private readonly maxCallsPerMock: number;
  private readonly concurrency: number;
  private readonly avoidPerTopic: number;

  constructor(private readonly writer: QuestionWriter, options: JobExecutionOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? env.GENERATION_HEARTBEAT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? env.GENERATION_BATCH_SIZE;
    this.newPerMock = options.newPerMock ?? env.GENERATION_NEW_PER_MOCK;
    this.maxNewPerMock = Math.max(options.maxNewPerMock ?? env.GENERATION_MAX_NEW_PER_MOCK, this.newPerMock);
    this.maxCallsPerMock = options.maxCallsPerMock ?? env.GENERATION_MAX_CALLS_PER_MOCK;
    this.concurrency = options.concurrency ?? env.LLM_MAX_CONCURRENCY;
    this.avoidPerTopic = options.avoidPerTopic ?? 6;
  }

  async executeJob(jobId: string): Promise<void> {
    // Atomically claim the job.
    const [job] = await db.update(generationJobs)
      .set({
        status: 'IN_PROGRESS',
        startedAt: sql`now()`,
        heartbeatAt: sql`now()`,
        completedAt: null,
        errorMessage: null,
        currentSubject: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'PENDING')))
      .returning();

    if (!job) {
      const existing = await this._loadJob(jobId);
      throw new JobNotExecutableError(jobId, existing?.status);
    }

    const heartbeat = setInterval(() => {
      db.update(generationJobs)
        .set({ heartbeatAt: sql`now()` })
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'IN_PROGRESS')))
        .catch(() => { /* next tick retries; staleness threshold tolerates misses */ });
    }, this.heartbeatIntervalMs);
    heartbeat.unref();

    try {
      const [mock] = await db.select().from(mocks).where(eq(mocks.id, job.mockId)).limit(1);
      if (!mock) throw new Error(`Mock not found for job ${jobId}`);

      // A retried mock goes back to GENERATING while it runs.
      if (mock.status === 'FAILED') {
        await db.update(mocks).set({ status: 'GENERATING', updatedAt: sql`now()` }).where(eq(mocks.id, mock.id));
      }

      const profile = await examProfileService.getExamProfileById(mock.examProfileId);
      const sections = await this._startSections(job, mock.id, profile);

      if (sections.length > 0) {
        const ctx: FillContext = {
          jobId, jobCreatedAt: job.createdAt, profile, language: mock.language, userId: mock.createdByUserId, used: new Set(),
        };
        await this._setStage(jobId, STAGE.selecting);
        await this._selectFromBank(ctx, sections);
        await this._writeNewQuestions(ctx, sections);
        const short = await this._fallbackFromBank(ctx, sections);
        // Complete sections are kept even when others fall short, so a retry only redoes the rest.
        await this._commitSections(jobId, mock.id, profile, sections.filter((s) => !short.includes(s)));
        if (short.length > 0) {
          throw new Error(
            `Not enough questions for: ${short.map((s) => s.subject).join(', ')}. The question bank is too small and new ` +
            'questions could not be written right now. Import the seed bank (npm run bank:seed) or try again in a few minutes.',
          );
        }
      }

      await mockAssemblyService.finalizeMock(jobId);
    } catch (error) {
      if (error instanceof JobReleasedError) throw error; // someone else owns the job now

      await db.transaction(async (tx) => {
        // finalizeMock marks the job FAILED itself on assembly errors, hence both statuses.
        const failed = await tx.update(generationJobs)
          .set({
            status: 'FAILED',
            errorMessage: truncate(messageOf(error)),
            currentSubject: null,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(generationJobs.id, jobId), inArray(generationJobs.status, ['IN_PROGRESS', 'FAILED'])))
          .returning({ id: generationJobs.id });

        if (failed.length > 0) {
          const failedSubjects = await tx.update(generationJobSubjects)
            .set({ status: 'FAILED', errorMessage: truncate(messageOf(error)), updatedAt: sql`now()` })
            .where(and(eq(generationJobSubjects.generationJobId, jobId), eq(generationJobSubjects.status, 'IN_PROGRESS')))
            .returning({ id: generationJobSubjects.id });
          if (failedSubjects.length > 0) {
            await tx.update(generationJobs)
              .set({ failedSubjects: sql`${generationJobs.failedSubjects} + ${failedSubjects.length}` })
              .where(eq(generationJobs.id, jobId));
          }
          await tx.update(mocks)
            .set({ status: 'FAILED', updatedAt: sql`now()` })
            .where(and(eq(mocks.id, job.mockId), eq(mocks.status, 'GENERATING')));
        }
      });

      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  1. Plan
  // ───────────────────────────────────────────────────────────────────────────

  /** Marks unfinished sections IN_PROGRESS and plans their slots. COMPLETED sections are kept. */
  private async _startSections(
    job: typeof generationJobs.$inferSelect,
    mockId: string,
    profile: ExamProfile,
  ): Promise<SectionFill[]> {
    const layout = sectionLayoutByName(profile);
    const rows = await db.select().from(generationJobSubjects).where(eq(generationJobSubjects.generationJobId, job.id));
    const pending = rows
      .filter((r) => r.status !== 'COMPLETED')
      .sort((a, b) => (layout.get(a.subject)?.index ?? 99) - (layout.get(b.subject)?.index ?? 99));

    for (const row of pending) {
      if (!layout.has(row.subject)) {
        throw new Error(`Subject ${row.subject} is not a section of profile ${profile.examId}@${profile.version}`);
      }
      if (row.attemptCount >= row.maxAttempts) {
        throw new Error(`Subject ${row.subject} failed: attempts exhausted (${row.attemptCount}/${row.maxAttempts})`);
      }
    }
    if (pending.length === 0) return [];

    await db.transaction(async (tx) => {
      for (const row of pending) {
        const block = layout.get(row.subject)!;
        // Defensive: sections commit atomically, so there should be no stray rows.
        await tx.delete(mockQuestions).where(and(
          eq(mockQuestions.mockId, mockId),
          between(mockQuestions.questionNumber, block.startNumber, block.endNumber),
        ));
      }
      await tx.update(generationJobSubjects)
        .set({
          status: 'IN_PROGRESS',
          attemptCount: sql`${generationJobSubjects.attemptCount} + 1`,
          generatedCount: 0,
          errorMessage: null,
          updatedAt: sql`now()`,
        })
        .where(inArray(generationJobSubjects.id, pending.map((r) => r.id)));
    });

    return pending.map((row) => {
      const topics = profile.canonicalTopics[row.subject];
      // Group the section by topic in syllabus order (as a printed paper would).
      const slots = planSection(profile, row.subject, row.targetCount, seededRandom(`${job.id}:${row.subject}`))
        .map((slot, i) => ({ slot, i }))
        .sort((a, b) => topics.indexOf(a.slot.topic) - topics.indexOf(b.slot.topic) || a.i - b.i)
        .map(({ slot }) => slot);
      return {
        subjectJobId: row.id,
        subject: row.subject,
        block: layout.get(row.subject)!,
        slots,
        assigned: new Array(slots.length).fill(null),
        source: new Array(slots.length).fill(null),
        balancer: new OptionBalancer(),
        writable: new Set<number>(),
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  2. Select from the bank
  // ───────────────────────────────────────────────────────────────────────────

  private async _selectFromBank(ctx: FillContext, sections: SectionFill[]): Promise<void> {
    const subjects = sections.map((s) => s.subject);
    // Difficulties still to place per section. Bank matches consume them and fresh
    // questions are written for whatever is left, so every section keeps its exact mix.
    const mix = new Map(sections.map((s) => [s, countMix(s.slots)]));

    // (a) Questions this job already paid for before an interruption.
    const orphans = await findOrphans({
      examProfileId: ctx.profile.id, language: ctx.language, subjects, since: ctx.jobCreatedAt,
    });
    let orphansUsed = 0;
    for (const section of sections) {
      orphansUsed += this._matchWithinMix(section, orphans.filter((o) => o.subject === section.subject), mix.get(section)!, ctx.used, 'new');
    }

    // (b) Fresh-question quota per section, spent on the topics the bank covers worst.
    const availability = await bankAvailability({
      examProfileId: ctx.profile.id, language: ctx.language, userId: ctx.userId, subjects,
    });
    const openCounts = sections.map((s) => s.assigned.filter((id) => id === null).length);
    const pendingTotal = sections.reduce((n, s) => n + s.slots.length, 0);
    const scale = pendingTotal / ctx.profile.totalQuestions;
    const quotaTotal = Math.max(Math.round(this.newPerMock * scale) - orphansUsed, 0);
    const quotas = apportion(Math.min(quotaTotal, openCounts.reduce((a, b) => a + b, 0)), openCounts);
    // Hard ceiling on fresh questions for this paper (the quota plus any the bank cannot supply).
    let newAllowance = Math.max(Math.round(this.maxNewPerMock * scale) - orphansUsed, 0);

    for (const [k, section] of sections.entries()) {
      const random = seededRandom(`${ctx.jobId}:${section.subject}:new`);
      const sectionMix = mix.get(section)!;
      const open = shuffle(section.slots.flatMap((_, i) => (section.assigned[i] === null ? [i] : [])), random);
      const supply = (i: number) => availability.get(availabilityKey(section.subject, section.slots[i].topic)) ?? 0;
      open.sort((a, b) => supply(a) - supply(b));
      const reserved = new Set(open.slice(0, Math.min(quotas[k], openCounts[k], newAllowance)));
      newAllowance -= reserved.size;

      const search = (seen: boolean, topics?: string[]) => bankCandidates({
        examProfileId: ctx.profile.id,
        subject: section.subject,
        language: ctx.language,
        userId: ctx.userId,
        excludeIds: [...ctx.used],
        topics,
        limit: 800,
        seen,
      });
      const stillOpen = () => section.slots.some((_, i) => section.assigned[i] === null && !reserved.has(i));

      // (c) Unseen bank questions of the planned topic, then of other topics of the subject.
      if (stillOpen()) {
        const wantedTopics = [...new Set(section.slots.filter((_, i) => section.assigned[i] === null).map((s) => s.topic))];
        this._matchWithinMix(section, await search(false, wantedTopics), sectionMix, ctx.used, 'bank', reserved);
      }
      if (stillOpen()) {
        this._matchWithinMix(section, await search(false), sectionMix, ctx.used, 'bank', reserved, false);
      }

      // (d) The bank has no unseen question left for a slot: write it fresh while the
      //     allowance lasts, otherwise reuse what this user saw longest ago.
      section.slots.forEach((_, i) => {
        if (section.assigned[i] === null && !reserved.has(i) && newAllowance > 0) {
          reserved.add(i);
          newAllowance--;
        }
      });
      if (stillOpen()) {
        this._matchWithinMix(section, await search(true), sectionMix, ctx.used, 'bank', reserved, false);
      }
      section.writable = reserved;

      // (e) Fresh slots take the difficulties the section still needs.
      const leftover = shuffle([...sectionMix].flatMap(([d, n]) => new Array<Difficulty>(n).fill(d)), random);
      section.slots.forEach((slot, i) => {
        if (section.assigned[i] === null && slot.difficulty !== undefined) {
          section.slots[i] = { ...slot, difficulty: leftover.pop() ?? slot.difficulty };
        }
      });
    }

    await this._reportProgress(sections);
  }

  /**
   * Places candidates into open slots without breaking the section's difficulty mix:
   * exact difficulty first, then any difficulty the section still needs (the slot takes
   * the question's difficulty). With `sameTopic` false, any topic of the subject is
   * accepted, preferring topics this section uses least. Returns how many were placed.
   */
  private _matchWithinMix(
    section: SectionFill,
    candidates: BankQuestionRef[],
    mix: Map<Difficulty, number>,
    used: Set<string>,
    source: SlotSource,
    skip: Set<number> = new Set(),
    sameTopic = true,
  ): number {
    let filled = 0;
    const topicUse = (topic: string) => section.slots.filter((s, i) => section.assigned[i] !== null && s.topic === topic).length;
    for (const exact of [true, false]) {
      section.slots.forEach((slot, i) => {
        if (section.assigned[i] !== null || skip.has(i)) return;
        const fits = (c: BankQuestionRef) => !used.has(c.id) && (!sameTopic || c.topic === slot.topic) &&
          (slot.difficulty === undefined || ((exact ? c.difficulty === slot.difficulty : true) && (mix.get(c.difficulty) ?? 0) > 0));
        const eligible = candidates.filter(fits);
        if (eligible.length === 0) return;
        const match = sameTopic ? eligible[0] : eligible.reduce((best, c) => (topicUse(c.topic) < topicUse(best.topic) ? c : best));
        if (slot.difficulty !== undefined) mix.set(match.difficulty, mix.get(match.difficulty)! - 1);
        used.add(match.id);
        this._place(section, i, match, source);
        filled++;
      });
    }
    return filled;
  }

  /** Puts a bank question into slot `i`; the slot takes the question's own topic and difficulty. */
  private _place(section: SectionFill, i: number, question: BankQuestionRef, source: SlotSource): void {
    const slot = section.slots[i];
    section.slots[i] = {
      topic: question.topic,
      ...(slot.difficulty !== undefined ? { difficulty: question.difficulty } : {}),
    };
    section.assigned[i] = question.id;
    section.source[i] = source;
    section.balancer.observe(question.correctOption);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  3. Write fresh questions
  // ───────────────────────────────────────────────────────────────────────────

  private async _writeNewQuestions(ctx: FillContext, sections: SectionFill[]): Promise<void> {
    const openSlots = () => sections.flatMap((section) =>
      section.slots.flatMap((_, index) => (section.assigned[index] === null && section.writable.has(index) ? [{ section, index }] : [])));

    let open = openSlots();
    if (open.length === 0) return;

    const state: WriteState = {
      budget: new CallBudget(this.maxCallsPerMock),
      stopReason: null,
      errors: [],
      fingerprints: await loadFingerprints({
        examProfileId: ctx.profile.id,
        language: ctx.language,
        topicsBySubject: new Map(sections.map((s) => [s.subject, [...new Set(s.slots.map((x) => x.topic))]])),
      }),
      batchesDone: 0,
      batchesPlanned: Math.ceil(open.length / this.batchSize),
    };

    try {
      // First pass, then one repair pass for slots whose items were missing or rejected.
      for (let pass = 0; pass < 2 && open.length > 0 && state.stopReason === null; pass++) {
        const batches = this._batches(open);
        if (pass > 0) state.batchesPlanned += batches.length;
        await this._runPool(batches, (batch) => this._writeBatch(ctx, batch, state));
        open = openSlots();
      }
    } finally {
      await db.update(generationJobs)
        .set({ llmCalls: sql`${generationJobs.llmCalls} + ${state.budget.spent}` })
        .where(eq(generationJobs.id, ctx.jobId));
    }

    if (open.length > 0 && state.errors.length > 0) {
      console.warn(`[generation] job ${ctx.jobId}: ${open.length} slot(s) left for bank fallback — ${state.stopReason ?? state.errors.slice(-3).join(' | ')}`);
    }
  }

  /** Groups open slots by subject (in paper order) and cuts them into request-sized batches. */
  private _batches(open: OpenSlot[]): OpenSlot[][] {
    const batches: OpenSlot[][] = [];
    for (let i = 0; i < open.length; i += this.batchSize) batches.push(open.slice(i, i + this.batchSize));
    return batches;
  }

  /** Runs batches with bounded concurrency; stops scheduling once the writer must stop. */
  private async _runPool(batches: OpenSlot[][], run: (batch: OpenSlot[]) => Promise<void>): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        await run(batch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, lane));
  }

  private async _writeBatch(ctx: FillContext, batch: OpenSlot[], state: WriteState): Promise<void> {
    if (state.stopReason !== null) return;
    await this._assertStillOwned(ctx.jobId);
    if (state.budget.remaining === 0) {
      state.stopReason = `request budget of ${state.budget.limit} used up`;
      return;
    }

    const writeSlots: WriteSlot[] = batch.map(({ section, index }, k) => ({
      slot: k + 1,
      subject: section.subject,
      topic: section.slots[index].topic,
      difficulty: section.slots[index].difficulty ?? 'medium',
      level: levelFor(ctx.profile, section.subject),
    }));

    try {
      const avoid = await recentStems({
        examProfileId: ctx.profile.id,
        language: ctx.language,
        subjectTopics: uniqueBy(writeSlots.map((s) => ({ subject: s.subject, topic: s.topic })), (x) => `${x.subject}|${x.topic}`),
        perTopic: this.avoidPerTopic,
      });

      const { items } = await this.writer.write(
        { examName: ctx.profile.name, language: ctx.language, slots: writeSlots, avoid },
        state.budget,
      );

      // Validate each item on its own; the first valid answer per slot wins.
      const slotMap = new Map(writeSlots.map((s) => [s.slot, s]));
      const accepted = new Map<number, GeneratedQuestion>();
      const rejected: string[] = [];
      for (const raw of items) {
        const result = validateItem(raw, slotMap, ctx.language);
        if (!result.ok) {
          rejected.push(`#${result.slot ?? '?'} ${result.reason}`);
          continue;
        }
        if (accepted.has(slotNumberOf(raw))) continue;
        const q = result.question;
        const key = availabilityKey(q.subject, q.topic);
        const print = fingerprint(q.questionText, q.options[q.correctAnswer]);
        const known = state.fingerprints.get(key) ?? [];
        if (isDuplicate(print, known)) {
          rejected.push(`#${slotNumberOf(raw)} duplicate of a bank question`);
          continue;
        }
        known.push(print);
        state.fingerprints.set(key, known);
        accepted.set(slotNumberOf(raw), q);
      }

      // Balance answer letters per section, bank immediately, then place in the paper.
      const placed = [...accepted.entries()].map(([slotNumber, q]) => {
        const target = batch[slotNumber - 1];
        return { target, question: target.section.balancer.balance([q])[0] };
      });
      const ids = await persistToBank(placed.map((p) => p.question), ctx.profile.id);
      placed.forEach(({ target }, k) => {
        target.section.assigned[target.index] = ids[k];
        target.section.source[target.index] = 'new';
        ctx.used.add(ids[k]);
      });

      if (rejected.length > 0 || accepted.size < batch.length) {
        state.errors.push(`batch: ${accepted.size}/${batch.length} accepted${rejected.length ? ` (${rejected.slice(0, 5).join('; ')})` : ''}`);
      }
    } catch (error) {
      if (error instanceof JobReleasedError) throw error;
      state.errors.push(messageOf(error));
      // Quota, budget, or an error a retry cannot fix (bad key, unknown model, 4xx):
      // stop writing now instead of spending the rest of the budget on it.
      if (error instanceof QuotaExhaustedError || error instanceof CallBudgetExhaustedError || !isRetryableProviderError(error)) {
        state.stopReason = messageOf(error);
      }
    } finally {
      state.batchesDone++;
      await this._setStage(ctx.jobId, STAGE.writing(Math.min(state.batchesDone, state.batchesPlanned), state.batchesPlanned));
      await this._reportProgress(batchSections(batch));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  4. Fallback
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Relaxed bank matching for slots the writer could not fill.
   * Returns the sections that are still short (the job then fails, retryable).
   */
  private async _fallbackFromBank(ctx: FillContext, sections: SectionFill[]): Promise<SectionFill[]> {
    const short: SectionFill[] = [];
    for (const section of sections) {
      const openCount = () => section.assigned.filter((id) => id === null).length;
      if (openCount() === 0) continue;

      for (const seen of [false, true]) {
        if (openCount() === 0) break;
        const candidates = await bankCandidates({
          examProfileId: ctx.profile.id,
          subject: section.subject,
          language: ctx.language,
          userId: ctx.userId,
          excludeIds: [...ctx.used],
          limit: Math.min(openCount() * 10, 800),
          seen,
        });
        // Same topic (any difficulty) first, then any topic of the subject.
        for (const sameTopic of [true, false]) {
          section.slots.forEach((slot, i) => {
            if (section.assigned[i] !== null) return;
            const match = candidates.find((c) => !ctx.used.has(c.id) && (!sameTopic || c.topic === slot.topic));
            if (!match) return;
            ctx.used.add(match.id);
            this._place(section, i, match, 'bank');
          });
        }
      }
      if (openCount() > 0) short.push(section);
    }

    await this._reportProgress(sections);
    return short;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  5. Commit
  // ───────────────────────────────────────────────────────────────────────────

  private async _commitSections(jobId: string, mockId: string, profile: ExamProfile, sections: SectionFill[]): Promise<void> {
    if (sections.length === 0) return;
    // Bank matches can change a slot's topic, so order each section by topic (syllabus order) again.
    for (const section of sections) {
      const topics = profile.canonicalTopics[section.subject];
      const order = section.slots.map((_, i) => i)
        .sort((a, b) => topics.indexOf(section.slots[a].topic) - topics.indexOf(section.slots[b].topic) || a - b);
      section.slots = order.map((i) => section.slots[i]);
      section.assigned = order.map((i) => section.assigned[i]);
      section.source = order.map((i) => section.source[i]);
    }
    await this._setStage(jobId, STAGE.finalising);
    const reused = sections.reduce((n, s) => n + s.source.filter((x) => x === 'bank').length, 0);
    const fresh = sections.reduce((n, s) => n + s.source.filter((x) => x === 'new').length, 0);

    await db.transaction(async (tx) => {
      for (const section of sections) {
        const completed = await tx.update(generationJobSubjects)
          .set({ status: 'COMPLETED', errorMessage: null, generatedCount: section.slots.length, updatedAt: sql`now()` })
          .where(and(eq(generationJobSubjects.id, section.subjectJobId), eq(generationJobSubjects.status, 'IN_PROGRESS')))
          .returning({ id: generationJobSubjects.id });
        // Recovery reset this section while we worked: roll back so the resumed run is the only writer.
        if (completed.length === 0) throw new JobReleasedError(jobId, 'reset');
        await associateQuestions(tx, mockId, section.assigned as string[], section.block.startNumber);
      }
      await tx.update(generationJobs)
        .set({
          completedSubjects: sql`${generationJobs.completedSubjects} + ${sections.length}`,
          reusedCount: sql`${generationJobs.reusedCount} + ${reused}`,
          newCount: sql`${generationJobs.newCount} + ${fresh}`,
          heartbeatAt: sql`now()`,
        })
        .where(eq(generationJobs.id, jobId));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async _reportProgress(sections: Iterable<SectionFill>) {
    for (const section of sections) {
      const ready = section.assigned.filter((id) => id !== null).length;
      await db.update(generationJobSubjects)
        .set({ generatedCount: ready })
        .where(and(eq(generationJobSubjects.id, section.subjectJobId), eq(generationJobSubjects.status, 'IN_PROGRESS')));
    }
  }

  private async _setStage(jobId: string, stage: string) {
    await db.update(generationJobs)
      .set({ currentSubject: stage, heartbeatAt: sql`now()` })
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'IN_PROGRESS')));
  }

  private async _assertStillOwned(jobId: string) {
    const current = await this._loadJob(jobId);
    if (current?.status !== 'IN_PROGRESS') throw new JobReleasedError(jobId, current?.status);
  }

  private async _loadJob(jobId: string) {
    const jobs = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
    return jobs.length > 0 ? jobs[0] : null;
  }
}

interface FillContext {
  jobId: string;
  jobCreatedAt: Date;
  profile: ExamProfile;
  language: Language;
  userId: string;
  /** Ids already placed in this paper (shared by selection, writing and fallback). */
  used: Set<string>;
}

function countMix(slots: PlannedSlot[]): Map<Difficulty, number> {
  const mix = new Map<Difficulty, number>();
  for (const s of slots) if (s.difficulty) mix.set(s.difficulty, (mix.get(s.difficulty) ?? 0) + 1);
  return mix;
}

function levelFor(profile: ExamProfile, subject: string): string {
  const section = profile.sectionsConfig.find((s) => s.name === subject);
  if (section?.levelCategory === 'academic') return profile.difficultyConfig.academicSubjects;
  if (section?.levelCategory === 'professional') return profile.difficultyConfig.professionalSubjects;
  return 'general awareness expected of a graduate';
}

function slotNumberOf(raw: unknown): number {
  return Number((raw as { slot?: unknown }).slot);
}

function batchSections(batch: OpenSlot[]): Set<SectionFill> {
  return new Set(batch.map((b) => b.section));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
}
