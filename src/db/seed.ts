import { db, pool } from './index.js';
import { examProfiles } from './schema.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import { superTetPrimary2026 } from '../modules/exams/profiles/super-tet-primary.js';
import { validateExamProfile } from '../modules/exams/types.js';

type ExamProfileSeed = typeof examProfiles.$inferInsert;

/**
 * Idempotent seed.
 *
 * - Upserts every known profile version by (exam_id, version).
 * - Guarantees exactly one active version per exam_id (the one flagged isActive),
 *   all inside one transaction so readers never observe zero or two active rows.
 * - Validates every seeded row through the same validator the app uses.
 */
async function upsertProfile(tx: typeof db, profile: ExamProfileSeed) {
  const [row] = await tx
    .insert(examProfiles)
    .values(profile)
    .onConflictDoUpdate({
      target: [examProfiles.examId, examProfiles.version],
      set: {
        name: profile.name,
        description: profile.description,
        totalQuestions: profile.totalQuestions,
        totalMarks: profile.totalMarks,
        durationMinutes: profile.durationMinutes,
        optionsPerQuestion: profile.optionsPerQuestion,
        marksPerCorrect: profile.marksPerCorrect,
        negativeMarking: profile.negativeMarking,
        negativeMarksPerQuestion: profile.negativeMarksPerQuestion,
        paperLanguages: profile.paperLanguages,
        difficultyConfig: profile.difficultyConfig,
        sectionsConfig: profile.sectionsConfig,
        canonicalTopics: profile.canonicalTopics,
        isActive: profile.isActive,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  validateExamProfile(row);
  return row;
}

async function seed() {
  console.log('Starting seed...');

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;

    const active = await upsertProfile(txDb, superTetPrimary2026);

    // Deactivate any other version of the same exam (e.g. ad-hoc rows).
    await tx
      .update(examProfiles)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(
        and(
          eq(examProfiles.examId, active.examId),
          ne(examProfiles.id, active.id),
          eq(examProfiles.isActive, true),
        ),
      );

    console.log(`Active profile: ${active.examId}@${active.version} (${active.totalQuestions} Q / ${active.totalMarks} marks / ${active.durationMinutes} min)`);
  });

  console.log('Seed complete!');
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
