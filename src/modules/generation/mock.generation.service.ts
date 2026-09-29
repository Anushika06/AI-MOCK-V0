import { db, isUniqueViolation } from '../../db/index.js';
import { mocks, generationJobs, generationJobSubjects } from '../../db/schema.js';
import { examProfileService } from '../exams/exam.service.js';
import { BadRequestError } from '../../common/errors.js';

export class DuplicateGenerationJobError extends Error {
  constructor(mockId: string) {
    super(`Generation job already exists for mock: ${mockId}`);
    this.name = 'DuplicateGenerationJobError';
  }
}

export type PaperLanguage = 'hi' | 'en';

export class MockGenerationService {
  /**
   * Initializes a new Mock and its corresponding Generation Job and Subject Jobs in one transaction.
   *
   * @param language Medium of the paper; must be one of the profile's paperLanguages.
   *                 Defaults to the profile's first paper language.
   */
  async initializeMockGeneration(
    userId: string,
    examId: string,
    title?: string,
    language?: PaperLanguage,
  ) {
    const profile = await examProfileService.getActiveExamProfile(examId);

    const mockLanguage = language ?? (profile.paperLanguages[0] as PaperLanguage);
    if (!profile.paperLanguages.includes(mockLanguage)) {
      throw new BadRequestError(
        `Language '${mockLanguage}' is not offered for ${profile.name} (allowed: ${profile.paperLanguages.join(', ')})`,
        'UNSUPPORTED_LANGUAGE',
      );
    }

    return await db.transaction(async (tx) => {
      const [mock] = await tx.insert(mocks).values({
        examProfileId: profile.id,
        createdByUserId: userId,
        title: title || `${profile.name} Mock`,
        language: mockLanguage,
        status: 'GENERATING',
      }).returning();

      const job = await this.initializeGenerationJobForMock(tx, mock.id, profile);

      return { mock, generationJob: job };
    });
  }

  /**
   * Initializes the generation job and subject jobs for a given mock.
   * Can be used independently if a mock was already created.
   */
  async initializeGenerationJobForMock(tx: any, mockId: string, profile: any) {
    let job;
    try {
      const [insertedJob] = await tx.insert(generationJobs).values({
        mockId: mockId,
        status: 'PENDING',
        totalSubjects: profile.sectionsConfig.length,
        completedSubjects: 0,
        failedSubjects: 0,
      }).returning();
      job = insertedJob;
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        throw new DuplicateGenerationJobError(mockId);
      }
      throw error;
    }

    const subjectInserts = profile.sectionsConfig.map((section: any) => ({
      generationJobId: job.id,
      subject: section.name,
      targetCount: section.questionCount,
      status: 'PENDING' as const,
      attemptCount: 0,
    }));

    await tx.insert(generationJobSubjects).values(subjectInserts);

    return job;
  }
}

export const mockGenerationService = new MockGenerationService();
