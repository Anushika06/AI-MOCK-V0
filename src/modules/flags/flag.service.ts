import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { attempts, mockQuestions, mocks, questionFlags, questions } from '../../db/schema.js';
import { BadRequestError, NotFoundError } from '../../common/errors.js';

export const flagSchema = z.object({
  reason: z.enum(['WRONG_ANSWER', 'AMBIGUOUS_QUESTION', 'TYPO_OR_TRANSLATION', 'OUT_OF_SYLLABUS', 'OTHER']),
  comment: z.string().trim().max(1000).optional(),
  attemptId: z.string().uuid().optional(),
}).strict();

export type FlagInput = z.infer<typeof flagSchema>;

/**
 * Question flagging. A user may flag a question only if it appears in one of
 * their own mocks. One flag per (user, question): flagging again updates it.
 * questions.is_flagged mirrors "has at least one OPEN flag".
 */
export class FlagService {
  async upsertFlag(userId: string, questionId: string, input: FlagInput) {
    await this._assertQuestionAccessible(userId, questionId);

    if (input.attemptId) {
      const [attempt] = await db
        .select({ id: attempts.id })
        .from(attempts)
        .innerJoin(mockQuestions, and(
          eq(mockQuestions.mockId, attempts.mockId),
          eq(mockQuestions.questionId, questionId),
        ))
        .where(and(eq(attempts.id, input.attemptId), eq(attempts.userId, userId)));
      if (!attempt) {
        throw new BadRequestError('attemptId does not belong to you or does not contain this question', 'INVALID_ATTEMPT');
      }
    }

    return db.transaction(async (tx) => {
      const [flag] = await tx.insert(questionFlags)
        .values({
          questionId,
          userId,
          attemptId: input.attemptId ?? null,
          reason: input.reason,
          comment: input.comment || null,
        })
        .onConflictDoUpdate({
          target: [questionFlags.userId, questionFlags.questionId],
          set: {
            reason: input.reason,
            comment: input.comment || null,
            attemptId: input.attemptId ?? null,
            status: 'OPEN',
            updatedAt: sql`now()`,
          },
        })
        .returning();

      await tx.update(questions).set({ isFlagged: true }).where(eq(questions.id, questionId));

      return {
        id: flag.id,
        questionId: flag.questionId,
        attemptId: flag.attemptId,
        reason: flag.reason,
        comment: flag.comment,
        status: flag.status,
        createdAt: flag.createdAt.toISOString(),
        updatedAt: flag.updatedAt.toISOString(),
      };
    });
  }

  async removeFlag(userId: string, questionId: string) {
    await this._assertQuestionAccessible(userId, questionId);

    await db.transaction(async (tx) => {
      const deleted = await tx.delete(questionFlags)
        .where(and(eq(questionFlags.userId, userId), eq(questionFlags.questionId, questionId)))
        .returning({ id: questionFlags.id });
      if (deleted.length === 0) throw new NotFoundError('You have not flagged this question');

      await tx.update(questions)
        .set({
          isFlagged: sql`EXISTS (SELECT 1 FROM ${questionFlags} WHERE ${questionFlags.questionId} = ${questionId} AND ${questionFlags.status} = 'OPEN')`,
        })
        .where(eq(questions.id, questionId));
    });

    return { removed: true };
  }

  private async _assertQuestionAccessible(userId: string, questionId: string) {
    const [row] = await db
      .select({ questionId: mockQuestions.questionId })
      .from(mockQuestions)
      .innerJoin(mocks, eq(mocks.id, mockQuestions.mockId))
      .where(and(eq(mockQuestions.questionId, questionId), eq(mocks.createdByUserId, userId)))
      .limit(1);
    if (!row) throw new NotFoundError('Question not found');
  }
}

export const flagService = new FlagService();
