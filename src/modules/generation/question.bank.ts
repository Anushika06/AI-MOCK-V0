import { and, desc, eq, gte, inArray, notExists, notInArray, sql } from 'drizzle-orm';
import { db, type DbTransaction } from '../../db/index.js';
import { mockQuestions, mocks, questions } from '../../db/schema.js';
import type { Difficulty, GeneratedQuestion, Language } from './question.types.js';
import { OPTION_LETTERS } from './question.types.js';
import { fingerprint, type BankFingerprint } from './question.quality.js';

/**
 * The question bank: every question ever generated, reused across mocks.
 *
 * "Seen" = part of any mock this user created (full papers and practice sets).
 * Flagged questions are never handed out again.
 */

export interface BankQuestionRef {
  id: string;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  correctOption: string;
}

const refColumns = {
  id: questions.id,
  subject: questions.subject,
  topic: questions.topic,
  difficulty: questions.difficulty,
  correctOption: questions.correctOption,
};

function seenByUser(userId: string) {
  return db
    .select({ one: sql`1` })
    .from(mockQuestions)
    .innerJoin(mocks, eq(mocks.id, mockQuestions.mockId))
    .where(and(eq(mockQuestions.questionId, questions.id), eq(mocks.createdByUserId, userId)));
}

function inAnyMock() {
  return db.select({ one: sql`1` }).from(mockQuestions).where(eq(mockQuestions.questionId, questions.id));
}

export const availabilityKey = (subject: string, topic: string, difficulty?: string) =>
  `${subject}\u0000${topic}\u0000${difficulty ?? '*'}`;

/**
 * Unseen, unflagged bank questions per (subject, topic, difficulty) and per
 * (subject, topic) — one grouped query for the whole paper.
 */
export async function bankAvailability(params: {
  examProfileId: string;
  language: Language;
  userId: string;
  subjects: string[];
}): Promise<Map<string, number>> {
  if (params.subjects.length === 0) return new Map();
  const rows = await db
    .select({ subject: questions.subject, topic: questions.topic, difficulty: questions.difficulty, n: sql<number>`count(*)::int` })
    .from(questions)
    .where(and(
      eq(questions.examProfileId, params.examProfileId),
      eq(questions.language, params.language),
      eq(questions.isFlagged, false),
      inArray(questions.subject, params.subjects),
      notExists(seenByUser(params.userId)),
    ))
    .groupBy(questions.subject, questions.topic, questions.difficulty);

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(availabilityKey(r.subject, r.topic, r.difficulty), r.n);
    const any = availabilityKey(r.subject, r.topic);
    counts.set(any, (counts.get(any) ?? 0) + r.n);
  }
  return counts;
}

/**
 * Random unseen, unflagged candidates for one subject. `seen: true` instead returns
 * questions this user HAS seen, least recently seen first (last-resort fallback).
 */
export async function bankCandidates(params: {
  examProfileId: string;
  subject: string;
  language: Language;
  userId: string;
  excludeIds: string[];
  limit: number;
  topics?: string[];
  seen?: boolean;
}): Promise<BankQuestionRef[]> {
  const conditions = [
    eq(questions.examProfileId, params.examProfileId),
    eq(questions.subject, params.subject),
    eq(questions.language, params.language),
    eq(questions.isFlagged, false),
  ];
  if (params.topics) conditions.push(inArray(questions.topic, params.topics));
  if (params.excludeIds.length > 0) conditions.push(notInArray(questions.id, params.excludeIds));

  if (!params.seen) {
    return db.select(refColumns).from(questions)
      .where(and(...conditions, notExists(seenByUser(params.userId))))
      .orderBy(sql`random()`)
      .limit(params.limit);
  }

  const lastSeen = sql<Date>`max(${mocks.createdAt})`;
  return db.select(refColumns).from(questions)
    .innerJoin(mockQuestions, eq(mockQuestions.questionId, questions.id))
    .innerJoin(mocks, and(eq(mocks.id, mockQuestions.mockId), eq(mocks.createdByUserId, params.userId)))
    .where(and(...conditions))
    .groupBy(questions.id)
    .orderBy(lastSeen)
    .limit(params.limit);
}

/**
 * Questions banked since `since` that are in no mock yet — typically batches this
 * job wrote before it was interrupted. Resuming reuses them instead of paying again.
 */
export async function findOrphans(params: {
  examProfileId: string;
  language: Language;
  subjects: string[];
  since: Date;
}): Promise<BankQuestionRef[]> {
  if (params.subjects.length === 0) return [];
  return db.select(refColumns).from(questions)
    .where(and(
      eq(questions.examProfileId, params.examProfileId),
      eq(questions.language, params.language),
      eq(questions.isFlagged, false),
      inArray(questions.subject, params.subjects),
      gte(questions.createdAt, params.since),
      notExists(inAnyMock()),
    ));
}

/** Duplicate-check fingerprints of every bank question in these subject topics. */
export async function loadFingerprints(params: {
  examProfileId: string;
  language: Language;
  topicsBySubject: Map<string, string[]>;
}): Promise<Map<string, BankFingerprint[]>> {
  const result = new Map<string, BankFingerprint[]>();
  for (const [subject, topics] of params.topicsBySubject) {
    const rows = await db.select({ topic: questions.topic, text: questions.questionText, options: questions.options, correct: questions.correctOption })
      .from(questions)
      .where(and(
        eq(questions.examProfileId, params.examProfileId),
        eq(questions.language, params.language),
        eq(questions.subject, subject),
        inArray(questions.topic, topics),
      ));
    for (const r of rows) {
      const options = r.options as Array<{ id: string; text: string }>;
      const correctText = options.find((o) => o.id === r.correct)?.text ?? '';
      const key = availabilityKey(subject, r.topic);
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(fingerprint(r.text, correctText));
    }
  }
  return result;
}

/** Most recent stems per topic (shortened), sent to the model as "do not repeat" hints. */
export async function recentStems(params: {
  examProfileId: string;
  language: Language;
  subjectTopics: Array<{ subject: string; topic: string }>;
  perTopic: number;
  maxLength?: number;
}): Promise<Record<string, string[]>> {
  const maxLength = params.maxLength ?? 90;
  const avoid: Record<string, string[]> = {};
  for (const { subject, topic } of params.subjectTopics) {
    const rows = await db.select({ text: questions.questionText })
      .from(questions)
      .where(and(
        eq(questions.examProfileId, params.examProfileId),
        eq(questions.language, params.language),
        eq(questions.subject, subject),
        eq(questions.topic, topic),
      ))
      .orderBy(desc(questions.createdAt))
      .limit(params.perTopic);
    const stems = rows.map((r) => {
      const oneLine = r.text.replace(/\s+/g, ' ').trim();
      return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
    });
    if (stems.length > 0) avoid[`${subject} › ${topic}`] = stems;
  }
  return avoid;
}

/** Adds accepted questions to the bank; returns their ids in input order. */
export async function persistToBank(accepted: GeneratedQuestion[], examProfileId: string): Promise<string[]> {
  if (accepted.length === 0) return [];
  const inserted = await db.insert(questions)
    .values(accepted.map((q) => ({
      examProfileId,
      subject: q.subject,
      topic: q.topic,
      language: q.language,
      difficulty: q.difficulty,
      questionText: q.questionText,
      options: OPTION_LETTERS.map((id) => ({ id, text: q.options[id] })),
      correctOption: q.correctAnswer,
      explanation: q.explanation ?? null,
      sourceType: 'ai_generated',
    })))
    .returning({ id: questions.id });
  return inserted.map((r) => r.id);
}

/** Inserts mock_questions rows numbered startNumber, startNumber+1, … in id order. */
export async function associateQuestions(
  tx: DbTransaction,
  mockId: string,
  questionIds: string[],
  startNumber: number,
): Promise<void> {
  if (questionIds.length === 0) return;
  await tx.insert(mockQuestions).values(questionIds.map((questionId, i) => ({
    mockId,
    questionId,
    questionNumber: startNumber + i,
  })));
}
