import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { questions } from '../../db/schema.js';
import type { ExamProfile } from '../exams/types.js';
import { seededRandom } from '../../common/random.js';
import { shuffle } from './section.plan.js';
import { hasPositionDependentOptions, sortNumericOptions } from './option.balance.js';
import { normalizeText, validateItem } from './question.quality.js';
import { OPTION_LETTERS, type GeneratedQuestion, type Language, type OptionLetter } from './question.types.js';

/**
 * Seed question bank: hand-reviewed, bilingual, PYQ-style questions shipped with the
 * app (seed_questions/super_tet_seed.json) so the very first mock is built from the
 * bank and Gemini only tops it up.
 *
 * Each entry has a Hindi and/or English version with options in the same order.
 * Language topics carry one version, used in both mediums (a Hindi-grammar question
 * stays in Hindi in an English-medium paper, exactly as in the printed exam).
 */

export const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../seed_questions/super_tet_seed.json');

const versionSchema = z.object({
  questionText: z.string().min(1),
  options: z.object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() }).strict(),
  explanation: z.string().optional(),
}).strict();

export const seedEntrySchema = z.object({
  subject: z.string().min(1),
  topic: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  correctAnswer: z.enum(['A', 'B', 'C', 'D']),
  hi: versionSchema.optional(),
  en: versionSchema.optional(),
}).strict().refine((e) => e.hi || e.en, 'entry needs a "hi" or "en" version');

export type SeedEntry = z.infer<typeof seedEntrySchema>;

export interface SeedImportReport {
  inserted: number;
  alreadyPresent: number;
  rejected: Array<{ index: number; language: Language; reason: string }>;
  perSubject: Record<string, { hi: number; en: number }>;
}

export function loadSeedFile(path = SEED_FILE): SeedEntry[] {
  return z.array(seedEntrySchema).parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Reorders options by `order` (new position k gets old option order[k]); texts and key stay paired. */
function permute(q: GeneratedQuestion, order: OptionLetter[]): GeneratedQuestion {
  const options = Object.fromEntries(OPTION_LETTERS.map((l, k) => [l, q.options[order[k]]])) as GeneratedQuestion['options'];
  return { ...q, options, correctAnswer: OPTION_LETTERS[order.indexOf(q.correctAnswer)] };
}

/**
 * The option order for an entry, shared by both language versions:
 * numeric options ascending, position-dependent options untouched, otherwise the key
 * moves to the letter used least so far in the subject (even spread of answers).
 */
function optionOrder(base: GeneratedQuestion, counts: Record<OptionLetter, number>, seed: string): OptionLetter[] {
  const identity = [...OPTION_LETTERS];
  const numeric = sortNumericOptions(base);
  if (numeric) {
    return OPTION_LETTERS.map((l) => identity.find((o) => base.options[o] === numeric.options[l])!);
  }
  if (hasPositionDependentOptions(base)) return identity;
  const random = seededRandom(seed);
  const min = Math.min(...OPTION_LETTERS.map((l) => counts[l]));
  const targets = OPTION_LETTERS.filter((l) => counts[l] === min);
  const target = targets[Math.floor(random() * targets.length)];
  const others = shuffle(OPTION_LETTERS.filter((l) => l !== base.correctAnswer), random);
  return OPTION_LETTERS.map((l) => (l === target ? base.correctAnswer : others.shift()!));
}

/**
 * Validates every entry with the same local checks as generated questions and inserts
 * both mediums into the bank. Idempotent: a question whose normalised text is already
 * in the bank (for that profile, subject and language) is skipped.
 */
export async function importSeedQuestions(entries: SeedEntry[], profile: ExamProfile): Promise<SeedImportReport> {
  const report: SeedImportReport = { inserted: 0, alreadyPresent: 0, rejected: [], perSubject: {} };
  const existing = new Set(
    (await db.select({ subject: questions.subject, language: questions.language, text: questions.questionText })
      .from(questions).where(eq(questions.examProfileId, profile.id)))
      .map((r) => `${r.language}|${r.subject}|${normalizeText(r.text)}`),
  );
  const letterCounts = new Map<string, Record<OptionLetter, number>>();
  const rows: Array<typeof questions.$inferInsert> = [];

  entries.forEach((entry, index) => {
    const topics = profile.canonicalTopics[entry.subject];
    if (!topics) {
      report.rejected.push({ index, language: 'hi', reason: `unknown subject "${entry.subject}"` });
      return;
    }
    if (!topics.includes(entry.topic)) {
      report.rejected.push({ index, language: 'hi', reason: `"${entry.topic}" is not a topic of ${entry.subject}` });
      return;
    }

    // Validate each medium with the generation validator.
    const versions: Array<[Language, GeneratedQuestion]> = [];
    for (const language of ['hi', 'en'] as const) {
      const version = entry[language] ?? entry.hi ?? entry.en!;
      const slot = { slot: 1, subject: entry.subject, topic: entry.topic, difficulty: entry.difficulty, level: '' };
      const result = validateItem({ slot: 1, ...version, correctAnswer: entry.correctAnswer }, new Map([[1, slot]]), language);
      if (!result.ok) {
        report.rejected.push({ index, language, reason: result.reason });
        continue;
      }
      versions.push([language, result.question]);
    }
    if (versions.length === 0) return;

    const counts = letterCounts.get(entry.subject) ?? { A: 0, B: 0, C: 0, D: 0 };
    letterCounts.set(entry.subject, counts);
    const order = optionOrder(versions[0][1], counts, `${entry.subject}|${index}`);
    counts[permute(versions[0][1], order).correctAnswer]++;

    for (const [language, question] of versions) {
      const key = `${language}|${entry.subject}|${normalizeText(question.questionText)}`;
      if (existing.has(key)) {
        report.alreadyPresent++;
        continue;
      }
      existing.add(key);
      const q = permute(question, order);
      rows.push({
        examProfileId: profile.id,
        subject: q.subject,
        topic: q.topic,
        language,
        difficulty: q.difficulty,
        questionText: q.questionText,
        options: OPTION_LETTERS.map((id) => ({ id, text: q.options[id] })),
        correctOption: q.correctAnswer,
        explanation: q.explanation ?? null,
        sourceType: 'seed',
      });
      const stats = report.perSubject[entry.subject] ?? { hi: 0, en: 0 };
      stats[language]++;
      report.perSubject[entry.subject] = stats;
    }
  });

  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(questions).values(rows.slice(i, i + 200));
  }
  report.inserted = rows.length;
  return report;
}

/** Number of seed questions already in the bank for a profile (used to warn at startup). */
export async function seedQuestionCount(profileId: string): Promise<number> {
  const rows = await db.select({ id: questions.id }).from(questions)
    .where(and(eq(questions.examProfileId, profileId), eq(questions.sourceType, 'seed')));
  return rows.length;
}
