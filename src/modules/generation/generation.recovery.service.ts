import { and, eq, inArray, lt, or, sql, isNull, between } from 'drizzle-orm';
import { db, type DbTransaction } from '../../db/index.js';
import {
  generationJobs,
  generationJobSubjects,
  mockQuestions,
  mocks,
} from '../../db/schema.js';
import { examProfileService } from '../exams/exam.service.js';
import { sectionLayoutByName, type SectionSlot } from '../exams/section.layout.js';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';

type JobRow = typeof generationJobs.$inferSelect;

/**
 * Keeps generation jobs recoverable:
 *
 *  - recoverStaleJobs(): IN_PROGRESS jobs whose worker stopped heart-beating
 *    (crash, kill -9, deploy) are put back to PENDING so a worker resumes them.
 *  - releaseJob():       the same for one job, used on graceful shutdown.
 *  - retryFailedJob():   user-initiated retry of a FAILED job.
 *
 * Resuming never regenerates COMPLETED subjects. Any association rows found in
 * the blocks of unfinished subjects are removed first, so a resumed run can
 * never produce duplicate or out-of-block mock_questions.
 */
export class GenerationRecoveryService {
  /** Returns the ids of jobs that were recovered. */
  async recoverStaleJobs(staleAfterSeconds = env.GENERATION_STALE_AFTER_SECONDS): Promise<string[]> {
    const candidates = await db
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(and(eq(generationJobs.status, 'IN_PROGRESS'), this._staleCondition(staleAfterSeconds)));

    const recovered: string[] = [];
    for (const { id } of candidates) {
      if (await this.releaseJob(id, staleAfterSeconds)) recovered.push(id);
    }
    return recovered;
  }

  /**
   * Puts an IN_PROGRESS job back to PENDING (unfinished subjects → PENDING).
   * When `onlyIfStaleSeconds` is given, the job is released only if its heartbeat is
   * still stale under the row lock (guards against racing a live worker).
   * Returns true if the job was released.
   */
  async releaseJob(jobId: string, onlyIfStaleSeconds?: number): Promise<boolean> {
    const [snapshot] = await db.select({ mockId: generationJobs.mockId }).from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!snapshot) return false;
    const layout = await this._layoutForMock(snapshot.mockId);

    return db.transaction(async (tx) => {
      const conditions = [eq(generationJobs.id, jobId), eq(generationJobs.status, 'IN_PROGRESS')];
      if (onlyIfStaleSeconds !== undefined) conditions.push(this._staleCondition(onlyIfStaleSeconds)!);

      const [job] = await tx.select().from(generationJobs).where(and(...conditions)).for('update');
      if (!job) return false;

      await this._resetUnfinishedSubjects(tx, job, layout, 'Interrupted — will resume');

      await tx.update(generationJobs)
        .set({
          status: 'PENDING',
          currentSubject: null,
          heartbeatAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(generationJobs.id, job.id));

      return true;
    });
  }

  /**
   * User-initiated retry of a FAILED generation job. Keeps COMPLETED subjects,
   * resets failed/unfinished ones with a fresh attempt budget. If every subject had
   * completed (i.e. final assembly failed), the whole paper is regenerated.
   */
  async retryFailedJob(mockId: string): Promise<JobRow> {
    const layout = await this._layoutForMock(mockId);

    return db.transaction(async (tx) => {
      const [job] = await tx.select().from(generationJobs)
        .where(eq(generationJobs.mockId, mockId))
        .for('update');
      if (!job) throw new NotFoundError('Generation job not found for this mock');
      if (job.status !== 'FAILED') {
        throw new ConflictError(`Only FAILED generations can be retried (current status: ${job.status})`, 'GENERATION_NOT_FAILED');
      }

      const subjects = await tx.select().from(generationJobSubjects)
        .where(eq(generationJobSubjects.generationJobId, job.id));
      const hasUnfinished = subjects.some((s) => s.status !== 'COMPLETED');

      if (hasUnfinished) {
        await this._resetUnfinishedSubjects(tx, job, layout, null, { resetAttempts: true });
      } else {
        // Assembly-level failure: start the paper over.
        await tx.delete(mockQuestions).where(eq(mockQuestions.mockId, job.mockId));
        await tx.update(generationJobSubjects)
          .set({ status: 'PENDING', attemptCount: 0, generatedCount: 0, errorMessage: null, updatedAt: sql`now()` })
          .where(eq(generationJobSubjects.generationJobId, job.id));
      }

      const [{ completed }] = await tx
        .select({ completed: sql<number>`count(*)::int` })
        .from(generationJobSubjects)
        .where(and(
          eq(generationJobSubjects.generationJobId, job.id),
          eq(generationJobSubjects.status, 'COMPLETED'),
        ));

      const [updated] = await tx.update(generationJobs)
        .set({
          status: 'PENDING',
          completedSubjects: completed,
          failedSubjects: 0,
          errorMessage: null,
          currentSubject: null,
          completedAt: null,
          heartbeatAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(generationJobs.id, job.id))
        .returning();

      await tx.update(mocks)
        .set({ status: 'GENERATING', updatedAt: sql`now()` })
        .where(eq(mocks.id, job.mockId));

      return updated;
    });
  }

  private _staleCondition(staleAfterSeconds: number) {
    const cutoff = sql`now() - make_interval(secs => ${staleAfterSeconds})`;
    return or(
      lt(generationJobs.heartbeatAt, cutoff),
      and(isNull(generationJobs.heartbeatAt), lt(generationJobs.updatedAt, cutoff)),
    );
  }

  /**
   * Unfinished (IN_PROGRESS / FAILED / PENDING) subjects → PENDING, and removal of
   * any mock_questions inside their question-number blocks.
   */
  /**
   * Profile-derived number blocks for a mock. Loaded outside transactions so a
   * transaction never waits on a second pool connection.
   */
  private async _layoutForMock(mockId: string): Promise<Map<string, SectionSlot>> {
    const [mock] = await db.select().from(mocks).where(eq(mocks.id, mockId));
    if (!mock) throw new NotFoundError('Mock not found');
    const profile = await examProfileService.getExamProfileById(mock.examProfileId);
    return sectionLayoutByName(profile);
  }

  private async _resetUnfinishedSubjects(
    tx: DbTransaction,
    job: JobRow,
    layout: Map<string, SectionSlot>,
    note: string | null,
    options: { resetAttempts?: boolean } = {},
  ) {

    const unfinished = await tx.select().from(generationJobSubjects)
      .where(and(
        eq(generationJobSubjects.generationJobId, job.id),
        inArray(generationJobSubjects.status, ['IN_PROGRESS', 'FAILED', 'PENDING']),
      ));

    for (const subject of unfinished) {
      const slot = layout.get(subject.subject);
      if (slot) {
        await tx.delete(mockQuestions).where(and(
          eq(mockQuestions.mockId, job.mockId),
          between(mockQuestions.questionNumber, slot.startNumber, slot.endNumber),
        ));
      }

      await tx.update(generationJobSubjects)
        .set({
          status: 'PENDING',
          generatedCount: 0,
          ...(options.resetAttempts ? { attemptCount: 0 } : {}),
          errorMessage: note ?? (options.resetAttempts ? null : subject.errorMessage),
          updatedAt: sql`now()`,
        })
        .where(eq(generationJobSubjects.id, subject.id));
    }
  }
}

export const generationRecoveryService = new GenerationRecoveryService();
