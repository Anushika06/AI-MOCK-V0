import { db } from '../../db/index.js';
import { examProfiles } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { ExamProfile, validateExamProfile } from './types.js';

export class ExamProfileService {
  /**
   * Retrieves the active exam profile for a given examId.
   * Enforces that exactly one active profile exists to prevent silent misconfigurations.
   */
  async getActiveExamProfile(examId: string): Promise<ExamProfile> {
    const activeProfiles = await db
      .select()
      .from(examProfiles)
      .where(
        and(
          eq(examProfiles.examId, examId),
          eq(examProfiles.isActive, true)
        )
      );

    if (activeProfiles.length === 0) {
      const err = new Error(`Active exam profile not found for examId: ${examId}`);
      err.name = 'NotFoundError';
      throw err;
    }

    if (activeProfiles.length > 1) {
      const err = new Error(`Configuration integrity error: Multiple active exam profiles found for examId: ${examId}`);
      err.name = 'ConfigurationError';
      throw err;
    }

    // Validate the raw database row before returning
    return validateExamProfile(activeProfiles[0]);
  }

  /**
   * Retrieves an exam profile by its primary key UUID.
   */
  async getExamProfileById(id: string): Promise<ExamProfile> {
    const profiles = await db
      .select()
      .from(examProfiles)
      .where(eq(examProfiles.id, id))
      .limit(1);

    if (profiles.length === 0) {
      const err = new Error(`Exam profile not found for id: ${id}`);
      err.name = 'NotFoundError';
      throw err;
    }

    return validateExamProfile(profiles[0]);
  }
}

export const examProfileService = new ExamProfileService();
