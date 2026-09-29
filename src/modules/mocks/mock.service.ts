import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import {
  attempts,
  examProfiles,
  generationJobs,
  generationJobSubjects,
  mockQuestions,
  mocks,
  questions,
} from '../../db/schema.js';
import { env } from '../../config/env.js';
import { NotFoundError, TooManyRequestsError } from '../../common/errors.js';
import { examProfileService } from '../exams/exam.service.js';
import { effectiveExamSummary } from '../exams/exam.summary.js';
import { computeSectionLayout, paperSectionsFromQuestions } from '../exams/section.layout.js';
import { mockGenerationService } from '../generation/mock.generation.service.js';
import { generationRecoveryService } from '../generation/generation.recovery.service.js';
import { generationEvents, JOB_QUEUED_EVENT } from '../generation/generation.worker.js';
import { attemptService, paperSizes } from '../attempts/attempt.service.js';
import { SUPER_TET_EXAM_ID } from '../exams/profiles/super-tet-primary.js';

export const createMockSchema = z.object({
  examId: z.string().min(1).max(100).default(SUPER_TET_EXAM_ID),
  title: z.string().trim().min(1).max(120).optional(),
  language: z.enum(['hi', 'en']).optional(),
}).strict();

type MockRow = typeof mocks.$inferSelect;
type JobRow = typeof generationJobs.$inferSelect;
type SubjectRow = typeof generationJobSubjects.$inferSelect;

function generationProgress(job: JobRow | null, subjects: SubjectRow[] | null, totalQuestions: number) {
  if (!job) return null;
  // Completed sections count fully; the running section counts its finished batches.
  const questionsReady = subjects
    ? subjects.reduce((sum, s) => sum + (s.status === 'COMPLETED' ? s.targetCount : s.generatedCount), 0)
    : null;
  return {
    jobId: job.id,
    status: job.status,
    totalSubjects: job.totalSubjects,
    completedSubjects: job.completedSubjects,
    failedSubjects: job.failedSubjects,
    currentSubject: job.currentSubject,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    questionsReady,
    totalQuestions,
    // How the paper was filled (known once generation completes).
    reusedCount: job.reusedCount,
    newCount: job.newCount,
    percent: job.status === 'COMPLETED'
      ? 100
      : questionsReady !== null
        ? Math.floor((questionsReady / totalQuestions) * 100)
        : Math.floor((job.completedSubjects / Math.max(job.totalSubjects, 1)) * 100),
  };
}

export class MockService {
  async createMock(userId: string, input: z.infer<typeof createMockSchema>) {
    const [{ generating }] = await db
      .select({ generating: count() })
      .from(mocks)
      .where(and(eq(mocks.createdByUserId, userId), eq(mocks.status, 'GENERATING')));

    if (generating >= env.MAX_CONCURRENT_GENERATIONS_PER_USER) {
      throw new TooManyRequestsError(
        `You already have ${generating} mock(s) generating. Wait for them to finish before creating another.`,
        'TOO_MANY_GENERATIONS',
      );
    }

    const { mock } = await mockGenerationService.initializeMockGeneration(
      userId,
      input.examId,
      input.title,
      input.language,
    );

    generationEvents.emit(JOB_QUEUED_EVENT);
    return this.getMock(userId, mock.id);
  }

  async listMocks(userId: string) {
    const rows = await db
      .select({ mock: mocks, job: generationJobs, profile: examProfiles })
      .from(mocks)
      .innerJoin(examProfiles, eq(mocks.examProfileId, examProfiles.id))
      .leftJoin(generationJobs, eq(generationJobs.mockId, mocks.id))
      .where(eq(mocks.createdByUserId, userId))
      .orderBy(desc(mocks.createdAt))
      .limit(200);

    if (rows.length === 0) return [];

    await attemptService.finalizeExpiredAttempts({ userId });
    const mockIds = rows.map((r) => r.mock.id);
    const practiceSizes = await paperSizes(rows.filter((r) => r.mock.kind === 'PRACTICE').map((r) => r.mock.id));
    const attemptRows = await db.select().from(attempts)
      .where(and(eq(attempts.userId, userId), inArray(attempts.mockId, mockIds)))
      .orderBy(desc(attempts.startedAt));

    return rows.map(({ mock, job, profile }) => {
      const mine = attemptRows.filter((a) => a.mockId === mock.id);
      const finished = mine.filter((a) => a.status !== 'IN_PROGRESS' && a.score !== null);
      const inProgress = mine.find((a) => a.status === 'IN_PROGRESS');
      return {
        ...this._mockBase(mock),
        exam: {
          name: profile.name,
          version: profile.version,
          ...(practiceSizes.has(mock.id)
            ? {
                totalQuestions: practiceSizes.get(mock.id)!,
                totalMarks: Math.round(practiceSizes.get(mock.id)! * Number(profile.marksPerCorrect) * 100) / 100,
                durationMinutes: mock.durationMinutes ?? profile.durationMinutes,
              }
            : {
                totalQuestions: profile.totalQuestions,
                totalMarks: profile.totalMarks,
                durationMinutes: profile.durationMinutes,
              }),
        },
        generation: generationProgress(job, null, profile.totalQuestions),
        attempts: {
          count: mine.length,
          inProgressAttemptId: inProgress?.id ?? null,
          latestAttemptId: mine[0]?.id ?? null,
          latestStatus: mine[0]?.status ?? null,
          bestScore: finished.length ? Math.max(...finished.map((a) => Number(a.score))) : null,
        },
      };
    });
  }

  async getMock(userId: string, mockId: string) {
    const mock = await this._ownedMock(userId, mockId);
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.mockId, mock.id));
    const subjects = job
      ? await db.select().from(generationJobSubjects).where(eq(generationJobSubjects.generationJobId, job.id))
      : [];

    let sections;
    let paperSize = profile.totalQuestions;
    if (mock.status === 'READY') {
      const paper = await db
        .select({ number: mockQuestions.questionNumber, subject: questions.subject })
        .from(mockQuestions)
        .innerJoin(questions, eq(mockQuestions.questionId, questions.id))
        .where(eq(mockQuestions.mockId, mock.id))
        .orderBy(asc(mockQuestions.questionNumber));
      sections = paperSectionsFromQuestions(paper);
      paperSize = paper.length;
    } else {
      sections = computeSectionLayout(profile).map(({ name, startNumber, endNumber, questionCount }) =>
        ({ name, startNumber, endNumber, questionCount }));
    }

    return {
      ...this._mockBase(mock),
      exam: effectiveExamSummary(profile, mock, paperSize),
      sections,
      generation: generationProgress(job ?? null, subjects, profile.totalQuestions),
      attempts: await attemptService.listAttemptsForMock(userId, mock.id),
    };
  }

  async getGenerationStatus(userId: string, mockId: string) {
    const mock = await this._ownedMock(userId, mockId);
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.mockId, mock.id));
    if (!job) throw new NotFoundError('No generation job for this mock');

    const subjects = await db.select().from(generationJobSubjects)
      .where(eq(generationJobSubjects.generationJobId, job.id));
    const order = new Map(computeSectionLayout(profile).map((s) => [s.name, s.index]));
    subjects.sort((a, b) => (order.get(a.subject) ?? 99) - (order.get(b.subject) ?? 99));

    return {
      mock: this._mockBase(mock),
      generation: generationProgress(job, subjects, profile.totalQuestions),
      subjects: subjects.map((s) => ({
        subject: s.subject,
        targetCount: s.targetCount,
        generatedCount: s.status === 'COMPLETED' ? s.targetCount : s.generatedCount,
        status: s.status,
        attemptCount: s.attemptCount,
        maxAttempts: s.maxAttempts,
        errorMessage: s.errorMessage,
      })),
    };
  }

  async retryGeneration(userId: string, mockId: string) {
    await this._ownedMock(userId, mockId);
    await generationRecoveryService.retryFailedJob(mockId);
    generationEvents.emit(JOB_QUEUED_EVENT);
    return this.getGenerationStatus(userId, mockId);
  }

  private _mockBase(mock: MockRow) {
    return {
      id: mock.id,
      title: mock.title,
      language: mock.language,
      status: mock.status,
      kind: mock.kind,
      sourceAttemptId: mock.sourceAttemptId,
      createdAt: mock.createdAt.toISOString(),
      updatedAt: mock.updatedAt.toISOString(),
    };
  }

  /** 404 (not 403) for other users' mocks so ids cannot be probed. */
  private async _ownedMock(userId: string, mockId: string): Promise<MockRow> {
    const [mock] = await db.select().from(mocks)
      .where(and(eq(mocks.id, mockId), eq(mocks.createdByUserId, userId)));
    if (!mock) throw new NotFoundError('Mock not found');
    return mock;
  }
}

export const mockService = new MockService();
