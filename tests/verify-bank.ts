/**
 * Question bank + generation, end to end on a real database (no network):
 *
 *  1. Empty bank: fresh questions are capped, so the paper fails safely with a clear
 *     message instead of spending Gemini calls on all 120 questions.
 *  2. The seed bank imports cleanly (every entry valid, every section and topic covered,
 *     both mediums) and re-importing is a no-op; Retry then completes the failed paper.
 *  3. A paper is ~85% bank / ~15% fresh (18 questions in 2 requests); fresh questions are
 *     saved to the bank; sections keep their block, exact difficulty mix and topic order.
 *  4. A user never gets a question they have already seen; flagged questions never come back.
 *  5. Prompts follow prompt.md and carry the slot table and do-not-repeat stems.
 *  6. Bad model output is dropped per item and repaired once, within budget.
 *  7. Quota exhaustion or a non-retryable error stops Gemini at once; the paper is
 *     completed from the bank.
 *  8. An interrupted job resumes and reuses what it already paid for.
 *
 * Runs only against a database whose name contains "test" (it clears the bank).
 */
import assert from 'node:assert';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { attempts, generationJobs, mockQuestions, mocks, questionFlags, questions, users } from '../src/db/schema.js';
import { examProfileService } from '../src/modules/exams/exam.service.js';
import { computeSectionLayout } from '../src/modules/exams/section.layout.js';
import { apportion } from '../src/modules/generation/section.plan.js';
import { mockGenerationService } from '../src/modules/generation/mock.generation.service.js';
import { generationRecoveryService } from '../src/modules/generation/generation.recovery.service.js';
import { JobExecutionService } from '../src/modules/generation/job.execution.service.js';
import { FakeQuestionWriter, fakeItem } from '../src/modules/generation/llm/offline.writers.js';
import { QuotaExhaustedError } from '../src/modules/generation/llm/gemini.client.js';
import { buildAuthoringPrompt } from '../src/modules/generation/authoring.prompt.js';
import { importSeedQuestions, loadSeedFile } from '../src/modules/generation/seed.bank.js';
import type { CallBudget, WriteRequest, WriteResult } from '../src/modules/generation/question.types.js';
import { SUPER_TET_EXAM_ID } from '../src/modules/exams/profiles/super-tet-primary.js';

// Production defaults: 18 fresh per paper, at most 30, 15 per request, at most 4 requests.
const OPTIONS = { newPerMock: 18, maxNewPerMock: 30, batchSize: 15, maxCallsPerMock: 4, concurrency: 2, heartbeatIntervalMs: 60_000 };

/** Counts requests and checks every prompt could be built from prompt.md. */
class RecordingWriter extends FakeQuestionWriter {
  override readonly name: string = 'recording';
  calls = 0;
  prompts: string[] = [];
  override async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
    this.calls++;
    this.prompts.push(buildAuthoringPrompt(request));
    return super.write(request, budget);
  }
}

/** Fails every request the way Gemini does. */
class FailingWriter extends RecordingWriter {
  constructor(private readonly error: () => Error) { super(); }
  override async write(_request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
    this.calls++;
    budget.take();
    throw this.error();
  }
}

async function clearBank(profileId: string) {
  const dbName = (await pool.query('select current_database() as n')).rows[0].n as string;
  assert.ok(/test/.test(dbName), `refusing to clear the question bank of "${dbName}"`);
  await db.delete(questionFlags);
  await db.delete(attempts);
  await db.delete(mocks); // cascades mock_questions + generation jobs
  await db.delete(questions).where(eq(questions.examProfileId, profileId));
}

async function main() {
  const profile = await examProfileService.getActiveExamProfile(SUPER_TET_EXAM_ID);
  await clearBank(profile.id);
  const stamp = Date.now();
  const newUser = async (name: string) =>
    (await db.insert(users).values({ name, email: `bank-${name}-${stamp}@example.com` }).returning())[0];

  const newMock = async (userId: string, language: 'hi' | 'en' = 'hi') => {
    const { mock, generationJob } = await mockGenerationService.initializeMockGeneration(userId, SUPER_TET_EXAM_ID, undefined, language);
    return { mockId: mock.id, jobId: generationJob.id };
  };
  const paper = (mockId: string) => db
    .select({
      id: questions.id, number: mockQuestions.questionNumber, subject: questions.subject, topic: questions.topic,
      difficulty: questions.difficulty, language: questions.language, source: questions.sourceType,
    })
    .from(mockQuestions).innerJoin(questions, eq(questions.id, mockQuestions.questionId))
    .where(eq(mockQuestions.mockId, mockId)).orderBy(mockQuestions.questionNumber);
  const job = async (jobId: string) => (await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)))[0];
  const mockStatus = async (mockId: string) => (await db.select().from(mocks).where(eq(mocks.id, mockId)))[0].status;
  const bankSize = async (where = sql`true`) => (await db.select({ n: sql<number>`count(*)::int` }).from(questions)
    .where(and(eq(questions.examProfileId, profile.id), where)))[0].n;

  const checkPaper = (rows: Awaited<ReturnType<typeof paper>>, language: 'hi' | 'en') => {
    assert.strictEqual(rows.length, 120);
    assert.deepStrictEqual(rows.map((q) => q.number), Array.from({ length: 120 }, (_, i) => i + 1));
    assert.strictEqual(new Set(rows.map((q) => q.id)).size, 120, 'no duplicates inside a paper');
    assert.ok(rows.every((q) => q.language === language), 'paper medium');
    for (const block of computeSectionLayout(profile)) {
      const section = rows.filter((q) => q.number >= block.startNumber && q.number <= block.endNumber);
      assert.strictEqual(section.length, block.questionCount, `${block.name} count`);
      assert.ok(section.every((q) => q.subject === block.name), `${block.name} in its block`);
      const topics = profile.canonicalTopics[block.name];
      const order = section.map((q) => topics.indexOf(q.topic));
      assert.ok(order.every((x) => x >= 0), `${block.name}: canonical topics only`);
      assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), `${block.name}: grouped in syllabus order`);
      const [e, m, h] = apportion(block.questionCount, [30, 50, 20]);
      assert.deepStrictEqual(['easy', 'medium', 'hard'].map((d) => section.filter((q) => q.difficulty === d).length), [e, m, h], `${block.name}: difficulty mix`);
    }
  };

  try {
    // ── 1. Empty bank: capped, fails safely ───────────────────────────────────
    console.log('Test 1: Empty bank → fresh questions capped, paper fails safely without burning requests...');
    const alice = await newUser('alice');
    const w0 = new RecordingWriter();
    const m0 = await newMock(alice.id);
    await assert.rejects(new JobExecutionService(w0, OPTIONS).executeJob(m0.jobId), /bank:seed/);
    const j0 = await job(m0.jobId);
    assert.strictEqual(j0.status, 'FAILED');
    assert.ok(w0.calls <= OPTIONS.maxCallsPerMock, `requests capped (${w0.calls})`);
    assert.ok(await bankSize() <= OPTIONS.maxNewPerMock, 'at most the fresh allowance was written');
    console.log(`  ✅ Test 1 passed (${w0.calls} requests)`);

    // ── 2. Seed import ────────────────────────────────────────────────────────
    console.log('Test 2: Seed bank imports cleanly, covers every section and topic in both mediums...');
    const entries = loadSeedFile();
    assert.ok(entries.length >= 400, `several hundred seed questions (${entries.length})`);
    const before = await bankSize();
    const report = await importSeedQuestions(entries, profile);
    assert.deepStrictEqual(report.rejected, [], 'every seed entry passes the local validator');
    for (const section of profile.sectionsConfig) {
      for (const language of ['hi', 'en'] as const) {
        const n = report.perSubject[section.name]?.[language] ?? 0;
        assert.ok(n >= section.questionCount * 3, `${section.name} (${language}): ${n} ≥ 3 papers' worth`);
        const topicRows = await db.select({ topic: questions.topic }).from(questions).where(and(
          eq(questions.examProfileId, profile.id), eq(questions.subject, section.name),
          eq(questions.language, language), eq(questions.sourceType, 'seed')));
        const covered = new Set(topicRows.map((r) => r.topic));
        const missing = profile.canonicalTopics[section.name].filter((t) => !covered.has(t));
        assert.deepStrictEqual(missing, [], `${section.name} (${language}): every topic seeded`);
      }
    }
    const again = await importSeedQuestions(entries, profile);
    assert.strictEqual(again.inserted, 0, 're-import is a no-op');
    assert.strictEqual(await bankSize(), before + report.inserted);
    await generationRecoveryService.retryFailedJob(m0.mockId);
    await new JobExecutionService(new RecordingWriter(), OPTIONS).executeJob(m0.jobId);
    assert.strictEqual(await mockStatus(m0.mockId), 'READY', 'Retry completes the paper once the bank is seeded');
    console.log(`  ✅ Test 2 passed (${entries.length} entries → ${report.inserted} bank rows)`);

    // ── 3. Normal paper: ~85% bank, 18 fresh in 2 requests ────────────────────
    console.log('Test 3: Paper is ~85% bank, 18 fresh questions in 2 requests, all saved to the bank...');
    const bob = await newUser('bob');
    const w1 = new RecordingWriter();
    const m1 = await newMock(bob.id);
    const bankBefore = await bankSize();
    await new JobExecutionService(w1, OPTIONS).executeJob(m1.jobId);
    const j1 = await job(m1.jobId);
    assert.deepStrictEqual([j1.status, j1.newCount, j1.reusedCount, j1.llmCalls], ['COMPLETED', 18, 102, 2]);
    assert.strictEqual(w1.calls, 2);
    assert.ok(w1.requests.every((r) => r.slots.length <= 15));
    assert.strictEqual(await bankSize(), bankBefore + 18, 'fresh questions are saved to the bank');
    const p1 = await paper(m1.mockId);
    checkPaper(p1, 'hi');
    // The 102 reused come from the bank: mostly seed, plus AI questions banked earlier in this run.
    assert.ok(p1.filter((q) => q.source === 'seed').length >= 90);
    // English medium works from the same bilingual seed.
    const m1en = await newMock(bob.id, 'en');
    await new JobExecutionService(new RecordingWriter(), OPTIONS).executeJob(m1en.jobId);
    checkPaper(await paper(m1en.mockId), 'en');
    console.log('  ✅ Test 3 passed');

    // ── 4. Seen questions excluded; flagged never reused ──────────────────────
    console.log('Test 4: A user never sees a question twice; flagged questions are never reused...');
    const unseenByBob = await db.select({ id: questions.id }).from(questions)
      .where(and(eq(questions.examProfileId, profile.id), eq(questions.language, 'hi'), eq(questions.sourceType, 'seed'),
        sql`${questions.id} not in (select question_id from mock_questions where mock_id = ${m1.mockId})`)).limit(5);
    const flagged = unseenByBob.map((r) => r.id);
    await db.update(questions).set({ isFlagged: true }).where(inArray(questions.id, flagged));
    const seen = new Set(p1.map((q) => q.id));
    for (let k = 0; k < 2; k++) {
      const m = await newMock(bob.id);
      await new JobExecutionService(new RecordingWriter(), OPTIONS).executeJob(m.jobId);
      const p = await paper(m.mockId);
      checkPaper(p, 'hi');
      assert.ok(p.every((q) => !seen.has(q.id)), `paper ${k + 2}: nothing bob has seen`);
      assert.ok(p.every((q) => !flagged.includes(q.id)), 'flagged questions are not reused');
      p.forEach((q) => seen.add(q.id));
    }
    console.log('  ✅ Test 4 passed');

    // ── 5. Prompt contents ────────────────────────────────────────────────────
    console.log('Test 5: Prompts follow prompt.md, carry the slot table and do-not-repeat stems...');
    const prompt = w1.prompts[0];
    assert.ok(prompt.includes('Final quality checklist') && prompt.includes('Paper medium: Hindi'));
    assert.ok(/\| 1 \| .+ \| .+ \| (easy|medium|hard) \| .+ \|/.test(prompt), 'slot table');
    assert.ok(prompt.includes('Already in the question bank'), 'stems to avoid are sent');
    console.log('  ✅ Test 5 passed');

    // ── 6. Bad output → per-item drop + one repair pass ───────────────────────
    console.log('Test 6: Invalid items are dropped individually and repaired once, within budget...');
    class SloppyWriter extends RecordingWriter {
      override async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
        this.calls++;
        budget.take();
        this.requests.push(request);
        const first = this.calls <= 2;
        const items = request.slots.map((s, i) => {
          const item = fakeItem(s, request.language);
          if (first && i % 3 === 0) return { ...item, options: { ...item.options, D: item.options.A } }; // duplicate options
          if (first && i % 3 === 1) return { ...item, questionText: 'Answer: A — trivia?' };
          return item;
        });
        return { items };
      }
    }
    const sloppy = new SloppyWriter();
    const carol = await newUser('carol');
    const m2 = await newMock(carol.id);
    await new JobExecutionService(sloppy, OPTIONS).executeJob(m2.jobId);
    const j2 = await job(m2.jobId);
    assert.strictEqual(j2.status, 'COMPLETED', j2.errorMessage ?? '');
    assert.ok(sloppy.calls <= OPTIONS.maxCallsPerMock, `first pass + one repair pass (${sloppy.calls})`);
    assert.ok(j2.newCount > 0 && j2.newCount <= 18);
    checkPaper(await paper(m2.mockId), 'hi');
    console.log(`  ✅ Test 6 passed (${sloppy.calls} requests, ${j2.newCount} fresh)`);

    // ── 7. Quota exhausted / non-retryable error ──────────────────────────────
    console.log('Test 7: Quota exhaustion or a non-retryable error stops Gemini; the paper comes from the bank...');
    for (const [label, error] of [
      ['daily quota', () => new QuotaExhaustedError('Gemini quota exhausted: GenerateRequestsPerDay', null)],
      ['bad request', () => Object.assign(new Error('400 INVALID_ARGUMENT: model not found'), { status: 400 })],
    ] as const) {
      const failing = new FailingWriter(error);
      const m = await newMock(carol.id);
      await new JobExecutionService(failing, OPTIONS).executeJob(m.jobId);
      const j = await job(m.jobId);
      assert.deepStrictEqual([j.status, j.newCount, j.reusedCount], ['COMPLETED', 0, 120], label);
      assert.ok(failing.calls <= OPTIONS.concurrency, `${label}: no further requests (${failing.calls})`);
    }
    console.log('  ✅ Test 7 passed');

    // ── 8. Interrupted job resumes and reuses what it paid for ────────────────
    console.log('Test 8: Interrupted generation resumes without paying twice...');
    const erin = await newUser('erin');
    const m3 = await newMock(erin.id, 'en');
    const allFresh = { ...OPTIONS, newPerMock: 120, maxNewPerMock: 120, maxCallsPerMock: 12 };
    class InterruptingWriter extends RecordingWriter {
      override async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
        const result = await super.write(request, budget);
        if (this.calls === 3) await generationRecoveryService.releaseJob(m3.jobId); // simulated crash/shutdown
        return result;
      }
    }
    const aiBefore = await bankSize(sql`${questions.sourceType} = 'ai_generated'`);
    await assert.rejects(new JobExecutionService(new InterruptingWriter(), { ...allFresh, concurrency: 1 }).executeJob(m3.jobId), /released/);
    const paidFor = (await bankSize(sql`${questions.sourceType} = 'ai_generated'`)) - aiBefore;
    assert.strictEqual(paidFor, 45, 'the 3 batches written before the interruption stay in the bank');
    const resume = new RecordingWriter();
    await new JobExecutionService(resume, allFresh).executeJob(m3.jobId);
    assert.strictEqual(await mockStatus(m3.mockId), 'READY');
    assert.strictEqual(resume.calls, Math.ceil((120 - paidFor) / 15), `resume only writes what is missing (${resume.calls})`);
    assert.strictEqual((await bankSize(sql`${questions.sourceType} = 'ai_generated'`)) - aiBefore, 120, 'nothing written twice');
    console.log(`  ✅ Test 8 passed (resume used ${resume.calls} requests)`);

    console.log('\nQuestion-bank verification passed completely!');
  } finally {
    await clearBank(profile.id);
    await db.delete(users).where(sql`${users.email} like ${`bank-%-${stamp}@example.com`}`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Question-bank verification failed:', err);
  process.exit(1);
});
