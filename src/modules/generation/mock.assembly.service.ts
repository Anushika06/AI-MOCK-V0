import { db } from '../../db/index.js';
import { mocks, generationJobs, mockQuestions, questions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { examProfileService } from '../exams/exam.service.js';
import { sectionLayoutByName } from '../exams/section.layout.js';

export class MockAssemblyService {
  /**
   * Finalizes the mock by verifying its persisted questions against the exam profile.
   * On success, marks the mock READY and the job COMPLETED.
   * On failure, marks the job FAILED to preserve data for debugging.
   */
  async finalizeMock(jobId: string): Promise<void> {
    const job = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1).then(r => r[0]);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const mock = await db.select().from(mocks).where(eq(mocks.id, job.mockId)).limit(1).then(r => r[0]);
    if (!mock) throw new Error(`Mock not found: ${job.mockId}`);

    const profile = await examProfileService.getExamProfileById(mock.examProfileId);

    const qs = await db.select({
      id: mockQuestions.questionId,
      number: mockQuestions.questionNumber,
      subject: questions.subject,
      language: questions.language,
      examProfileId: questions.examProfileId
    })
    .from(mockQuestions)
    .innerJoin(questions, eq(mockQuestions.questionId, questions.id))
    .where(eq(mockQuestions.mockId, mock.id))
    .orderBy(mockQuestions.questionNumber);

    try {
      if (qs.length !== profile.totalQuestions) {
        throw new Error(`Mock assembly failed: Expected ${profile.totalQuestions} questions, found ${qs.length}`);
      }

      for (const q of qs) {
        if (q.examProfileId !== profile.id) {
          throw new Error(`Mock assembly failed: Question ${q.id} belongs to profile ${q.examProfileId}, expected ${profile.id}`);
        }
      }

      const subjectCounts = qs.reduce((acc, q) => {
        acc[q.subject] = (acc[q.subject] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      for (const section of profile.sectionsConfig) {
        if (subjectCounts[section.name] !== section.questionCount) {
          throw new Error(`Mock assembly failed: Subject ${section.name} expected ${section.questionCount} questions, found ${subjectCounts[section.name] || 0}`);
        }
      }

      for (let i = 0; i < qs.length; i++) {
        if (qs[i].number !== i + 1) {
          throw new Error(`Mock assembly failed: Question numbers are not contiguous, missing ${i + 1}`);
        }
      }

      // Every question must sit inside its section's block (profile section order).
      const layout = sectionLayoutByName(profile);
      for (const q of qs) {
        const slot = layout.get(q.subject)!;
        if (q.number < slot.startNumber || q.number > slot.endNumber) {
          throw new Error(`Mock assembly failed: Question ${q.number} (${q.subject}) is outside its section block ${slot.startNumber}-${slot.endNumber}`);
        }
        if (q.language !== mock.language) {
          throw new Error(`Mock assembly failed: Question ${q.number} is in '${q.language}', mock language is '${mock.language}'`);
        }
      }

      await db.transaction(async (tx) => {
        await tx.update(mocks)
          .set({ status: 'READY', updatedAt: sql`now()` })
          .where(eq(mocks.id, mock.id));

        await tx.update(generationJobs)
          .set({ 
            status: 'COMPLETED',
            completedSubjects: job.totalSubjects,
            completedAt: sql`now()`,
            currentSubject: null,
            updatedAt: sql`now()`
          })
          .where(eq(generationJobs.id, job.id));
      });

    } catch (err: any) {
      await db.update(generationJobs)
        .set({
          status: 'FAILED',
          errorMessage: err.message.substring(0, 500),
          completedAt: sql`now()`,
          updatedAt: sql`now()`
        })
        .where(eq(generationJobs.id, job.id));
      throw err;
    }
  }
}

export const mockAssemblyService = new MockAssemblyService();
