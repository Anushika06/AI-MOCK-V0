import { and, asc, desc, eq, getTableColumns, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, isUniqueViolation } from '../../db/index.js';
import {
  attemptAnswers,
  attempts,
  examProfiles,
  mockQuestions,
  mocks,
  questionFlags,
  questions,
} from '../../db/schema.js';
import { examProfileService } from '../exams/exam.service.js';
import { effectiveExamSummary, practiceDurationMinutes } from '../exams/exam.summary.js';
import { paperSectionsFromQuestions } from '../exams/section.layout.js';
import type { ExamProfile } from '../exams/types.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors.js';
import {
  accuracyPercent, aggregateByTopic, scoreAttempt, weakestTopics, type OptionId, type ScoringRules,
} from './scoring.js';
import { associateQuestions } from '../generation/question.bank.js';

type AttemptRow = typeof attempts.$inferSelect;
type MockRow = typeof mocks.$inferSelect;

export const ATTEMPT_CLOSED = 'ATTEMPT_CLOSED';

export const saveAnswersSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    /** An option letter selects, null clears, omitted leaves the answer unchanged. */
    selectedOption: z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    /** Cumulative seconds spent on the question (client-measured; analytics only). */
    timeSpentSeconds: z.number().int().min(0).max(86_400).optional(),
  }).strict().refine(
    (a) => a.selectedOption !== undefined || a.timeSpentSeconds !== undefined,
    'each entry needs selectedOption and/or timeSpentSeconds',
  )).min(1).max(500),
}).strict();

export const practiceSchema = z.object({
  /** Which questions of the source attempt to practise. */
  scope: z.enum(['INCORRECT', 'INCORRECT_AND_UNATTEMPTED']).default('INCORRECT_AND_UNATTEMPTED'),
}).strict();

export type SaveAnswersInput = z.infer<typeof saveAnswersSchema>;

interface QuestionOption { id: OptionId; text: string }

/** Public attempt representation. Never contains correct answers. */
export interface AttemptView {
  id: string;
  mockId: string;
  status: AttemptRow['status'];
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  /** Server clock at response time — clients derive their countdown offset from it. */
  serverNow: string;
  remainingSeconds: number;
  score: number | null;
  totalCorrect: number | null;
  totalIncorrect: number | null;
  totalUnattempted: number | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toAttemptView(a: AttemptRow): AttemptView {
  const now = Date.now();
  return {
    id: a.id,
    mockId: a.mockId,
    status: a.status,
    startedAt: a.startedAt.toISOString(),
    deadlineAt: a.deadlineAt.toISOString(),
    submittedAt: iso(a.submittedAt),
    serverNow: new Date(now).toISOString(),
    remainingSeconds: a.status === 'IN_PROGRESS'
      ? Math.max(0, Math.floor((a.deadlineAt.getTime() - now) / 1000))
      : 0,
    score: a.score === null ? null : Number(a.score),
    totalCorrect: a.totalCorrect,
    totalIncorrect: a.totalIncorrect,
    totalUnattempted: a.totalUnattempted,
  };
}

function scoringRules(profile: ExamProfile): ScoringRules {
  return {
    marksPerCorrect: profile.marksPerCorrect,
    negativeMarking: profile.negativeMarking,
    negativeMarksPerQuestion: profile.negativeMarksPerQuestion,
  };
}

/** Number of questions in each given mock's paper. */
export async function paperSizes(mockIds: string[]): Promise<Map<string, number>> {
  if (mockIds.length === 0) return new Map();
  const rows = await db
    .select({ mockId: mockQuestions.mockId, count: sql<number>`count(*)::int` })
    .from(mockQuestions)
    .where(inArray(mockQuestions.mockId, [...new Set(mockIds)]))
    .groupBy(mockQuestions.mockId);
  return new Map(rows.map((r) => [r.mockId, Number(r.count)]));
}

/** Seconds from start to submission, capped at the deadline. */
function timeTakenSeconds(a: AttemptRow): number | null {
  if (!a.submittedAt) return null;
  const end = Math.min(a.submittedAt.getTime(), a.deadlineAt.getTime());
  return Math.max(0, Math.round((end - a.startedAt.getTime()) / 1000));
}

/**
 * Exam-taking lifecycle. The server is authoritative for:
 *  - the deadline (started_at + profile.durationMinutes, computed with DB now()),
 *  - which answers count (saves are rejected once the deadline passes),
 *  - the final status (SUBMITTED vs AUTO_SUBMITTED) and the score.
 */
export class AttemptService {
  // ───────────────────────────────────────────────────────────────── start ──

  async startAttempt(userId: string, mockId: string): Promise<{ attempt: AttemptView; resumed: boolean }> {
    const mock = await this._ownedMock(userId, mockId);
    if (mock.status !== 'READY') {
      throw new ConflictError('This mock is not ready yet', 'MOCK_NOT_READY');
    }
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);

    const existing = await this._inProgressAttempt(userId, mockId);
    if (existing) {
      if (!(await this._isExpired(existing.id))) {
        return { attempt: toAttemptView(existing), resumed: true };
      }
      await this.finalizeAttempt(existing.id, 'auto');
    }

    try {
      const [attempt] = await db.insert(attempts).values({
        userId,
        mockId,
        status: 'IN_PROGRESS',
        startedAt: sql`now()`,
        // PRACTICE sets carry their own (shorter) duration.
        deadlineAt: sql`now() + make_interval(mins => ${mock.durationMinutes ?? profile.durationMinutes})`,
      }).returning();
      return { attempt: toAttemptView(attempt), resumed: false };
    } catch (error) {
      // Concurrent start (double click / two tabs): the partial unique index
      // attempts_one_in_progress_per_user_mock admits exactly one — resume it.
      if (isUniqueViolation(error)) {
        const winner = await this._inProgressAttempt(userId, mockId);
        if (winner) return { attempt: toAttemptView(winner), resumed: true };
      }
      throw error;
    }
  }

  // ───────────────────────────────────────────────────────── exam payload ──

  /**
   * Everything the exam screen needs to (re)render after a refresh or reconnect:
   * attempt timing, the paper WITHOUT correct answers, and the saved answers.
   * An attempt found past its deadline is auto-submitted first.
   */
  async getAttemptForExam(userId: string, attemptId: string) {
    let attempt = await this._ownedAttempt(userId, attemptId);
    if (attempt.status === 'IN_PROGRESS' && (await this._isExpired(attempt.id))) {
      attempt = (await this.finalizeAttempt(attempt.id, 'auto')).attempt;
    }

    const mock = await this._mock(attempt.mockId);
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);
    const paperSize = await this._paperSize(mock.id);
    const base = {
      attempt: toAttemptView(attempt),
      mock: this._mockInfo(mock),
      exam: effectiveExamSummary(profile, mock, paperSize),
    };

    if (attempt.status !== 'IN_PROGRESS') {
      return {
        ...base,
        sections: [],
        questions: [],
        answers: {} as Record<string, OptionId>,
        timeSpent: {} as Record<string, number>,
      };
    }

    const rows = await db
      .select({
        questionId: questions.id,
        number: mockQuestions.questionNumber,
        subject: questions.subject,
        topic: questions.topic,
        questionText: questions.questionText,
        options: questions.options,
      })
      .from(mockQuestions)
      .innerJoin(questions, eq(mockQuestions.questionId, questions.id))
      .where(eq(mockQuestions.mockId, mock.id))
      .orderBy(asc(mockQuestions.questionNumber));

    const saved = await db
      .select({
        questionId: attemptAnswers.questionId,
        selected: attemptAnswers.selectedAnswer,
        timeSpentSeconds: attemptAnswers.timeSpentSeconds,
      })
      .from(attemptAnswers)
      .where(eq(attemptAnswers.attemptId, attempt.id));

    const answers: Record<string, OptionId> = {};
    const timeSpent: Record<string, number> = {};
    for (const a of saved) {
      if (a.selected) answers[a.questionId] = a.selected as OptionId;
      if (a.timeSpentSeconds > 0) timeSpent[a.questionId] = a.timeSpentSeconds;
    }

    return {
      ...base,
      sections: paperSectionsFromQuestions(rows),
      questions: rows.map((r) => ({
        questionId: r.questionId,
        number: r.number,
        subject: r.subject,
        topic: r.topic,
        text: r.questionText,
        options: r.options as QuestionOption[],
      })),
      answers,
      timeSpent,
    };
  }

  // ──────────────────────────────────────────────────────────────── answers ──

  /**
   * Saves answer selections and/or per-question time. Within one batch the last
   * selection wins; time is cumulative, so the highest value wins (idempotent on
   * retries) and it is capped at the attempt's duration.
   */
  async saveAnswers(userId: string, attemptId: string, input: SaveAnswersInput) {
    const selections = new Map<string, OptionId | null>();
    const times = new Map<string, number>();
    for (const a of input.answers) {
      if (a.selectedOption !== undefined) selections.set(a.questionId, a.selectedOption);
      if (a.timeSpentSeconds !== undefined) {
        times.set(a.questionId, Math.max(times.get(a.questionId) ?? 0, a.timeSpentSeconds));
      }
    }
    const questionIds = [...new Set(input.answers.map((a) => a.questionId))];

    const outcome = await db.transaction(async (tx) => {
      // FOR SHARE: concurrent saves proceed together, but submission (FOR UPDATE)
      // waits for in-flight saves and saves wait for a running submission.
      const [row] = await tx
        .select({
          mockId: attempts.mockId,
          status: attempts.status,
          startedAt: attempts.startedAt,
          deadlineAt: attempts.deadlineAt,
          open: sql<boolean>`${attempts.deadlineAt} > now()`,
        })
        .from(attempts)
        .where(and(eq(attempts.id, attemptId), eq(attempts.userId, userId)))
        .for('share');

      if (!row) throw new NotFoundError('Attempt not found');
      if (row.status !== 'IN_PROGRESS') {
        throw new ConflictError('This attempt has already been submitted', ATTEMPT_CLOSED, { status: row.status });
      }
      if (!row.open) return 'expired' as const;

      const valid = await tx
        .select({ questionId: mockQuestions.questionId })
        .from(mockQuestions)
        .where(and(eq(mockQuestions.mockId, row.mockId), inArray(mockQuestions.questionId, questionIds)));
      if (valid.length !== questionIds.length) {
        throw new BadRequestError('One or more questions do not belong to this mock', 'QUESTION_NOT_IN_MOCK');
      }

      const maxSeconds = Math.floor((row.deadlineAt.getTime() - row.startedAt.getTime()) / 1000);
      const timeFor = (questionId: string) => Math.min(times.get(questionId) ?? 0, maxSeconds);
      const keepMaxTime = sql`GREATEST(${attemptAnswers.timeSpentSeconds}, excluded.time_spent_seconds)`;

      // Selections (with any time): overwrite the answer, keep the larger time.
      const selectionIds = questionIds.filter((id) => selections.has(id));
      if (selectionIds.length > 0) {
        await tx.insert(attemptAnswers)
          .values(selectionIds.map((questionId) => ({
            attemptId,
            questionId,
            selectedAnswer: selections.get(questionId) ?? null,
            isCorrect: null,
            answeredAt: sql`now()`,
            timeSpentSeconds: timeFor(questionId),
          })))
          .onConflictDoUpdate({
            target: [attemptAnswers.attemptId, attemptAnswers.questionId],
            set: {
              selectedAnswer: sql`excluded.selected_answer`,
              isCorrect: null,
              answeredAt: sql`excluded.answered_at`,
              timeSpentSeconds: keepMaxTime,
              updatedAt: sql`now()`,
            },
          });
      }

      // Time-only updates: never touch the answer.
      const timeOnlyIds = questionIds.filter((id) => !selections.has(id));
      if (timeOnlyIds.length > 0) {
        await tx.insert(attemptAnswers)
          .values(timeOnlyIds.map((questionId) => ({
            attemptId,
            questionId,
            selectedAnswer: null,
            timeSpentSeconds: timeFor(questionId),
          })))
          .onConflictDoUpdate({
            target: [attemptAnswers.attemptId, attemptAnswers.questionId],
            set: { timeSpentSeconds: keepMaxTime, updatedAt: sql`now()` },
          });
      }

      return 'saved' as const;
    });

    if (outcome === 'expired') {
      const { attempt } = await this.finalizeAttempt(attemptId, 'auto');
      throw new ConflictError('Time is up — your attempt was submitted automatically', ATTEMPT_CLOSED, {
        status: attempt.status,
      });
    }

    return { saved: questionIds.length, savedAt: new Date().toISOString() };
  }

  // ─────────────────────────────────────────────────────────────── submit ──

  async submitAttempt(userId: string, attemptId: string) {
    await this._ownedAttempt(userId, attemptId);
    const { attempt, alreadyFinal } = await this.finalizeAttempt(attemptId, 'manual');
    return { attempt: toAttemptView(attempt), alreadySubmitted: alreadyFinal };
  }

  /**
   * Grades and closes an attempt. Idempotent: a closed attempt is returned as-is.
   *
   * mode 'manual' → SUBMITTED if before the deadline, else AUTO_SUBMITTED.
   * mode 'auto'   → only closes attempts whose deadline has passed (AUTO_SUBMITTED).
   * AUTO_SUBMITTED attempts record submitted_at = deadline_at.
   */
  async finalizeAttempt(attemptId: string, mode: 'manual' | 'auto'): Promise<{ attempt: AttemptRow; alreadyFinal: boolean }> {
    // Marking rules are loaded BEFORE opening the transaction so the transaction
    // never waits on a second pool connection (pool-exhaustion deadlock).
    const [owner] = await db.select({ mockId: attempts.mockId }).from(attempts).where(eq(attempts.id, attemptId));
    if (!owner) throw new NotFoundError('Attempt not found');
    const mock = await this._mock(owner.mockId);
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ ...getTableColumns(attempts), expired: sql<boolean>`now() >= ${attempts.deadlineAt}` })
        .from(attempts)
        .where(eq(attempts.id, attemptId))
        .for('update');

      if (!row) throw new NotFoundError('Attempt not found');
      const { expired, ...attempt } = row;
      if (attempt.status !== 'IN_PROGRESS') return { attempt, alreadyFinal: true };
      if (mode === 'auto' && !expired) return { attempt, alreadyFinal: false };

      const status = expired ? 'AUTO_SUBMITTED' as const : 'SUBMITTED' as const;

      const paper = await tx
        .select({ questionId: questions.id, correctOption: questions.correctOption, subject: questions.subject })
        .from(mockQuestions)
        .innerJoin(questions, eq(mockQuestions.questionId, questions.id))
        .where(eq(mockQuestions.mockId, attempt.mockId))
        .orderBy(asc(mockQuestions.questionNumber));

      const saved = await tx
        .select({ questionId: attemptAnswers.questionId, selected: attemptAnswers.selectedAnswer })
        .from(attemptAnswers)
        .where(eq(attemptAnswers.attemptId, attemptId));

      const result = scoreAttempt(
        paper,
        new Map(saved.map((a) => [a.questionId, a.selected])),
        scoringRules(profile),
      );

      // Persist per-answer correctness from the authoritative correct_option.
      await tx.execute(sql`
        UPDATE ${attemptAnswers} AS aa
        SET is_correct = CASE WHEN aa.selected_answer IS NULL THEN NULL
                              ELSE aa.selected_answer = q.correct_option END
        FROM ${questions} AS q
        WHERE aa.attempt_id = ${attemptId} AND q.id = aa.question_id
      `);

      const [updated] = await tx.update(attempts)
        .set({
          status,
          submittedAt: status === 'AUTO_SUBMITTED' ? sql`${attempts.deadlineAt}` : sql`now()`,
          score: result.score.toFixed(2),
          totalCorrect: result.correct,
          totalIncorrect: result.incorrect,
          totalUnattempted: result.unattempted,
          updatedAt: sql`now()`,
        })
        .where(eq(attempts.id, attemptId))
        .returning();

      return { attempt: updated, alreadyFinal: false };
    });
  }

  /** Auto-submits every IN_PROGRESS attempt past its deadline. Returns how many were closed. */
  async finalizeExpiredAttempts(options: { userId?: string; limit?: number } = {}): Promise<number> {
    const conditions = [eq(attempts.status, 'IN_PROGRESS'), lte(attempts.deadlineAt, sql`now()`)];
    if (options.userId) conditions.push(eq(attempts.userId, options.userId));

    const expired = await db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(...conditions))
      .limit(options.limit ?? 200);

    let closed = 0;
    for (const { id } of expired) {
      const { attempt, alreadyFinal } = await this.finalizeAttempt(id, 'auto');
      if (!alreadyFinal && attempt.status !== 'IN_PROGRESS') closed++;
    }
    return closed;
  }

  // ─────────────────────────────────────────────────────────────── results ──

  async getResult(userId: string, attemptId: string) {
    let attempt = await this._ownedAttempt(userId, attemptId);
    if (attempt.status === 'IN_PROGRESS') {
      if (!(await this._isExpired(attempt.id))) {
        throw new ConflictError('Results are available after the attempt is submitted', 'ATTEMPT_IN_PROGRESS');
      }
      attempt = (await this.finalizeAttempt(attempt.id, 'auto')).attempt;
    }

    const mock = await this._mock(attempt.mockId);
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);

    const rows = await db
      .select({
        questionId: questions.id,
        number: mockQuestions.questionNumber,
        subject: questions.subject,
        topic: questions.topic,
        difficulty: questions.difficulty,
        questionText: questions.questionText,
        options: questions.options,
        correctOption: questions.correctOption,
        explanation: questions.explanation,
        selected: attemptAnswers.selectedAnswer,
        timeSpentSeconds: attemptAnswers.timeSpentSeconds,
      })
      .from(mockQuestions)
      .innerJoin(questions, eq(mockQuestions.questionId, questions.id))
      .leftJoin(attemptAnswers, and(
        eq(attemptAnswers.attemptId, attempt.id),
        eq(attemptAnswers.questionId, questions.id),
      ))
      .where(eq(mockQuestions.mockId, mock.id))
      .orderBy(asc(mockQuestions.questionNumber));

    const scored = scoreAttempt(rows, new Map(rows.map((r) => [r.questionId, r.selected])), scoringRules(profile));
    const outcomeById = new Map(scored.perQuestion.map((q) => [q.questionId, q]));
    const exam = effectiveExamSummary(profile, mock, rows.length);

    const reviewed = rows.map((r) => ({
      subject: r.subject,
      topic: r.topic,
      outcome: outcomeById.get(r.questionId)?.outcome ?? ('UNATTEMPTED' as const),
      timeSpentSeconds: r.timeSpentSeconds ?? 0,
    }));
    const topics = aggregateByTopic(reviewed);
    const sectionTime = new Map<string, number>();
    for (const r of reviewed) sectionTime.set(r.subject, (sectionTime.get(r.subject) ?? 0) + r.timeSpentSeconds);

    const flags = rows.length === 0 ? [] : await db
      .select({
        questionId: questionFlags.questionId,
        reason: questionFlags.reason,
        comment: questionFlags.comment,
        status: questionFlags.status,
      })
      .from(questionFlags)
      .where(and(eq(questionFlags.userId, userId), inArray(questionFlags.questionId, rows.map((r) => r.questionId))));
    const flagById = new Map(flags.map((f) => [f.questionId, f]));

    // Stored totals are the record of truth; they are recomputed identically above.
    const correct = attempt.totalCorrect ?? scored.correct;
    const incorrect = attempt.totalIncorrect ?? scored.incorrect;
    const unattempted = attempt.totalUnattempted ?? scored.unattempted;
    const score = attempt.score !== null ? Number(attempt.score) : scored.score;

    const practice = await db.select({ id: mocks.id }).from(mocks).where(eq(mocks.sourceAttemptId, attempt.id));

    return {
      attempt: { ...toAttemptView(attempt), timeTakenSeconds: timeTakenSeconds(attempt) },
      mock: this._mockInfo(mock),
      exam,
      summary: {
        score,
        totalMarks: exam.totalMarks,
        percentage: exam.totalMarks > 0 ? Math.round((score / exam.totalMarks) * 10000) / 100 : 0,
        correct,
        incorrect,
        unattempted,
        attempted: correct + incorrect,
        totalQuestions: rows.length,
        accuracy: accuracyPercent(correct, incorrect),
        trackedTimeSeconds: reviewed.reduce((sum, r) => sum + r.timeSpentSeconds, 0),
      },
      sections: scored.perSection.map((s) => ({
        ...s,
        accuracy: accuracyPercent(s.correct, s.incorrect),
        timeSpentSeconds: sectionTime.get(s.subject) ?? 0,
      })),
      topics,
      weakTopics: weakestTopics(topics),
      practiceMockId: practice[0]?.id ?? null,
      questions: rows.map((r) => {
        const flag = flagById.get(r.questionId);
        return {
          questionId: r.questionId,
          number: r.number,
          subject: r.subject,
          topic: r.topic,
          difficulty: r.difficulty,
          text: r.questionText,
          options: r.options as QuestionOption[],
          correctOption: r.correctOption,
          explanation: r.explanation,
          selectedOption: outcomeById.get(r.questionId)?.selectedOption ?? null,
          outcome: outcomeById.get(r.questionId)?.outcome ?? 'UNATTEMPTED',
          timeSpentSeconds: r.timeSpentSeconds ?? 0,
          flag: flag ? { reason: flag.reason, comment: flag.comment, status: flag.status } : null,
        };
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────── history ──

  async listAttempts(userId: string) {
    await this.finalizeExpiredAttempts({ userId });

    const rows = await db
      .select({
        attempt: attempts,
        mock: mocks,
        examName: examProfiles.name,
        examVersion: examProfiles.version,
        totalMarks: examProfiles.totalMarks,
        totalQuestions: examProfiles.totalQuestions,
        marksPerCorrect: examProfiles.marksPerCorrect,
      })
      .from(attempts)
      .innerJoin(mocks, eq(attempts.mockId, mocks.id))
      .innerJoin(examProfiles, eq(mocks.examProfileId, examProfiles.id))
      .where(eq(attempts.userId, userId))
      .orderBy(desc(attempts.startedAt))
      .limit(200);

    const practiceSizes = await paperSizes(rows.filter((r) => r.mock.kind === 'PRACTICE').map((r) => r.mock.id));

    return rows.map((r) => {
      const a = r.attempt;
      const correct = a.totalCorrect ?? 0;
      const incorrect = a.totalIncorrect ?? 0;
      const size = practiceSizes.get(r.mock.id);
      return {
        ...toAttemptView(a),
        mock: this._mockInfo(r.mock),
        exam: {
          name: r.examName,
          version: r.examVersion,
          totalMarks: size === undefined ? r.totalMarks : Math.round(size * Number(r.marksPerCorrect) * 100) / 100,
          totalQuestions: size ?? r.totalQuestions,
        },
        accuracy: a.status === 'IN_PROGRESS' ? null : accuracyPercent(correct, incorrect),
        timeTakenSeconds: timeTakenSeconds(a),
      };
    });
  }

  /** Attempts of one mock, newest first (used by the mock detail view). */
  async listAttemptsForMock(userId: string, mockId: string): Promise<AttemptView[]> {
    const rows = await db.select().from(attempts)
      .where(and(eq(attempts.userId, userId), eq(attempts.mockId, mockId)))
      .orderBy(desc(attempts.startedAt));
    return rows.map(toAttemptView);
  }

  // ────────────────────────────────────────────────────────────── practice ──

  /**
   * Builds (once) a PRACTICE set from a submitted attempt's incorrect — and
   * optionally unattempted — questions, in their original order. It is READY
   * immediately; its duration follows the profile's minutes-per-question pace.
   */
  async createPracticeSet(
    userId: string,
    attemptId: string,
    input: z.infer<typeof practiceSchema>,
  ): Promise<{ mockId: string; created: boolean; questionCount: number }> {
    let attempt = await this._ownedAttempt(userId, attemptId);
    if (attempt.status === 'IN_PROGRESS') {
      if (!(await this._isExpired(attempt.id))) {
        throw new ConflictError('Submit the attempt before practising its mistakes', 'ATTEMPT_IN_PROGRESS');
      }
      attempt = (await this.finalizeAttempt(attempt.id, 'auto')).attempt;
    }

    const existing = await this._practiceFor(attempt.id);
    if (existing) return { ...existing, created: false };

    const source = await this._mock(attempt.mockId);
    const profile = await examProfileService.getExamProfileById(source.examProfileId);

    const rows = await db
      .select({
        questionId: mockQuestions.questionId,
        correctOption: questions.correctOption,
        subject: questions.subject,
        selected: attemptAnswers.selectedAnswer,
      })
      .from(mockQuestions)
      .innerJoin(questions, eq(questions.id, mockQuestions.questionId))
      .leftJoin(attemptAnswers, and(
        eq(attemptAnswers.attemptId, attempt.id),
        eq(attemptAnswers.questionId, mockQuestions.questionId),
      ))
      .where(eq(mockQuestions.mockId, source.id))
      .orderBy(asc(mockQuestions.questionNumber));

    const scored = scoreAttempt(rows, new Map(rows.map((r) => [r.questionId, r.selected])), scoringRules(profile));
    const wanted = new Set(input.scope === 'INCORRECT' ? ['INCORRECT'] : ['INCORRECT', 'UNATTEMPTED']);
    const questionIds = scored.perQuestion.filter((q) => wanted.has(q.outcome)).map((q) => q.questionId);
    if (questionIds.length === 0) {
      throw new BadRequestError('There are no questions to practise from this attempt', 'NOTHING_TO_PRACTICE');
    }

    const title = `Practice: ${source.title}`.slice(0, 255);
    try {
      const mockId = await db.transaction(async (tx) => {
        const [practice] = await tx.insert(mocks).values({
          examProfileId: source.examProfileId,
          createdByUserId: userId,
          title,
          language: source.language,
          status: 'READY',
          kind: 'PRACTICE',
          sourceAttemptId: attempt.id,
          durationMinutes: practiceDurationMinutes(profile, questionIds.length),
        }).returning({ id: mocks.id });
        await associateQuestions(tx, practice.id, questionIds, 1);
        return practice.id;
      });
      return { mockId, created: true, questionCount: questionIds.length };
    } catch (error) {
      // Double click: the unique source_attempt_id index admits one practice set.
      if (isUniqueViolation(error)) {
        const winner = await this._practiceFor(attempt.id);
        if (winner) return { ...winner, created: false };
      }
      throw error;
    }
  }

  private async _practiceFor(attemptId: string): Promise<{ mockId: string; questionCount: number } | null> {
    const [row] = await db.select({ id: mocks.id }).from(mocks).where(eq(mocks.sourceAttemptId, attemptId));
    return row ? { mockId: row.id, questionCount: await this._paperSize(row.id) } : null;
  }

  // ─────────────────────────────────────────────────────────────── helpers ──

  private _mockInfo(mock: MockRow) {
    return {
      id: mock.id,
      title: mock.title,
      language: mock.language,
      kind: mock.kind,
      sourceAttemptId: mock.sourceAttemptId,
    };
  }

  private async _paperSize(mockId: string): Promise<number> {
    return (await paperSizes([mockId])).get(mockId) ?? 0;
  }

  private async _ownedMock(userId: string, mockId: string): Promise<MockRow> {
    const [mock] = await db.select().from(mocks)
      .where(and(eq(mocks.id, mockId), eq(mocks.createdByUserId, userId)));
    if (!mock) throw new NotFoundError('Mock not found');
    return mock;
  }

  private async _mock(mockId: string): Promise<MockRow> {
    const [mock] = await db.select().from(mocks).where(eq(mocks.id, mockId));
    if (!mock) throw new NotFoundError('Mock not found');
    return mock;
  }

  /** 404 (not 403) for other users' attempts so ids cannot be probed. */
  private async _ownedAttempt(userId: string, attemptId: string): Promise<AttemptRow> {
    const [attempt] = await db.select().from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.userId, userId)));
    if (!attempt) throw new NotFoundError('Attempt not found');
    return attempt;
  }

  private async _inProgressAttempt(userId: string, mockId: string): Promise<AttemptRow | undefined> {
    const [row] = await db.select().from(attempts).where(and(
      eq(attempts.userId, userId),
      eq(attempts.mockId, mockId),
      eq(attempts.status, 'IN_PROGRESS'),
    ));
    return row;
  }

  private async _isExpired(attemptId: string): Promise<boolean> {
    const [row] = await db
      .select({ expired: sql<boolean>`now() >= ${attempts.deadlineAt}` })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    return row?.expired ?? false;
  }
}

export const attemptService = new AttemptService();
