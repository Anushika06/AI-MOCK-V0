/**
 * Drizzle ORM schema — Super TET Mock Exam Engine
 *
 *  - UUID primary keys (or composite PKs for join/relational tables)
 *  - TIMESTAMPTZ for all timestamps
 *  - JSONB for structured blobs (options, languages, difficulty, sections, topics)
 *  - CHECK / UNIQUE constraints enforced at database level
 *  - Enums for constrained domains
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  numeric,
  jsonb,
  pgEnum,
  timestamp,
  unique,
  index,
  check,
  primaryKey,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
//  Enums
// ─────────────────────────────────────────────────────────────────────────────

export const questionLanguageEnum = pgEnum('question_language', ['hi', 'en']);

export const questionDifficultyEnum = pgEnum('question_difficulty', [
  'easy',
  'medium',
  'hard',
]);

export const mockStatusEnum = pgEnum('mock_status', [
  'GENERATING',
  'READY',
  'FAILED',
]);

// FULL = generated paper following the exam profile; PRACTICE = built from the
// incorrect / unattempted questions of a submitted attempt.
export const mockKindEnum = pgEnum('mock_kind', ['FULL', 'PRACTICE']);

export const generationJobStatusEnum = pgEnum('generation_job_status', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
]);

export const subjectJobStatusEnum = pgEnum('subject_job_status', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
]);

export const attemptStatusEnum = pgEnum('attempt_status', [
  'IN_PROGRESS',
  'SUBMITTED',
  'AUTO_SUBMITTED',
]);

export const flagReasonEnum = pgEnum('flag_reason', [
  'WRONG_ANSWER',
  'AMBIGUOUS_QUESTION',
  'TYPO_OR_TRANSLATION',
  'OUT_OF_SYLLABUS',
  'OTHER',
]);

export const flagStatusEnum = pgEnum('flag_status', [
  'OPEN',
  'REVIEWED',
  'DISMISSED',
]);

// ─────────────────────────────────────────────────────────────────────────────
//  users
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: varchar('email', { length: 255 }).unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  exam_profiles
//
//  Source of truth for exam rules and question distribution.
//  Versioned by (exam_id, version) so historical mocks are unaffected
//  when UPESSC updates its syllabus.
// ─────────────────────────────────────────────────────────────────────────────

export const examProfiles = pgTable('exam_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: varchar('exam_id', { length: 100 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  totalQuestions: integer('total_questions').notNull(),
  totalMarks: integer('total_marks').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  optionsPerQuestion: integer('options_per_question').notNull().default(4),
  marksPerCorrect: numeric('marks_per_correct', { precision: 5, scale: 2 }).notNull(),
  negativeMarking: boolean('negative_marking').notNull().default(false),
  negativeMarksPerQuestion: numeric('negative_marks_per_question', { precision: 5, scale: 2 }),
  paperLanguages: jsonb('paper_languages').notNull(),
  difficultyConfig: jsonb('difficulty_config').notNull(),
  sectionsConfig: jsonb('sections_config').notNull(),
  canonicalTopics: jsonb('canonical_topics').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  unique('exam_profiles_exam_id_version_unique').on(t.examId, t.version),
  check('exam_profiles_total_questions_positive', sql`${t.totalQuestions} > 0`),
  check('exam_profiles_duration_positive', sql`${t.durationMinutes} > 0`),
  check(
    'exam_profiles_negative_marking_check',
    sql`NOT ${t.negativeMarking} OR ${t.negativeMarksPerQuestion} IS NOT NULL`,
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  questions
//
//  The question bank. Each row is one language-specific question, reused across mocks.
//  Options stored as JSONB: [{ id: "A"|"B"|"C"|"D", text: "…" }]
// ─────────────────────────────────────────────────────────────────────────────

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  examProfileId: uuid('exam_profile_id')
    .notNull()
    .references(() => examProfiles.id),
  subject: varchar('subject', { length: 100 }).notNull(),
  topic: varchar('topic', { length: 100 }).notNull(),
  language: questionLanguageEnum('language').notNull(),
  difficulty: questionDifficultyEnum('difficulty').notNull(),
  sourceType: text('source_type').notNull().default('ai_generated'),
  questionText: text('question_text').notNull(),
  options: jsonb('options').notNull(),
  correctOption: varchar('correct_option', { length: 1 }).notNull(),
  // Short worked solution written by the generator; shown in answer review.
  explanation: text('explanation'),
  isFlagged: boolean('is_flagged').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  check(
    'questions_correct_option_valid',
    sql`${t.correctOption} IN ('A', 'B', 'C', 'D')`,
  ),
  index('questions_exam_profile_subject_idx').on(t.examProfileId, t.subject),
  index('questions_exam_profile_subject_topic_idx').on(t.examProfileId, t.subject, t.topic),
  index('questions_difficulty_idx').on(t.difficulty),
  index('questions_language_idx').on(t.language),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  mocks
// ─────────────────────────────────────────────────────────────────────────────

export const mocks = pgTable('mocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  examProfileId: uuid('exam_profile_id')
    .notNull()
    .references(() => examProfiles.id),
  createdByUserId: uuid('created_by_user_id')
    .notNull()
    .references(() => users.id),
  title: varchar('title', { length: 255 }).notNull(),
  // Medium of the paper. Must be one of the exam profile's paperLanguages.
  language: questionLanguageEnum('language').notNull().default('hi'),
  status: mockStatusEnum('status').notNull().default('GENERATING'),
  kind: mockKindEnum('kind').notNull().default('FULL'),
  // PRACTICE mocks: the submitted attempt whose mistakes they contain.
  sourceAttemptId: uuid('source_attempt_id')
    .references((): AnyPgColumn => attempts.id, { onDelete: 'set null' }),
  // Overrides the profile duration (PRACTICE mocks are shorter). NULL = profile duration.
  durationMinutes: integer('duration_minutes'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('mocks_created_by_user_idx').on(t.createdByUserId),
  index('mocks_status_idx').on(t.status),
  uniqueIndex('mocks_source_attempt_unique').on(t.sourceAttemptId),
  check('mocks_duration_positive', sql`${t.durationMinutes} IS NULL OR ${t.durationMinutes} > 0`),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  mock_questions  (join table: mocks ↔ questions)
//
//  Composite PK: (mock_id, question_number)
//  Unique: (mock_id, question_id) prevents duplicates in a single mock.
// ─────────────────────────────────────────────────────────────────────────────

export const mockQuestions = pgTable('mock_questions', {
  mockId: uuid('mock_id')
    .notNull()
    .references(() => mocks.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id')
    .notNull()
    .references(() => questions.id),
  questionNumber: integer('question_number').notNull(),
}, (t) => [
  primaryKey({ columns: [t.mockId, t.questionNumber] }),
  unique('mock_questions_mock_question_unique').on(t.mockId, t.questionId),
  index('mock_questions_mock_idx').on(t.mockId),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  generation_jobs
//
//  One job per mock. Tracks the overall generation lifecycle and subject counters.
// ─────────────────────────────────────────────────────────────────────────────

export const generationJobs = pgTable('generation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  mockId: uuid('mock_id')
    .notNull()
    .unique()
    .references(() => mocks.id, { onDelete: 'cascade' }),
  status: generationJobStatusEnum('status').notNull().default('PENDING'),
  totalSubjects: integer('total_subjects').notNull().default(0),
  completedSubjects: integer('completed_subjects').notNull().default(0),
  failedSubjects: integer('failed_subjects').notNull().default(0),
  currentSubject: varchar('current_subject', { length: 100 }),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Touched periodically by the executing worker. A stale heartbeat on an
  // IN_PROGRESS job means the worker was interrupted and the job is recoverable.
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  // How the paper was filled: questions reused from the bank, freshly generated,
  // and LLM requests spent (including retries).
  reusedCount: integer('reused_count').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  llmCalls: integer('llm_calls').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  check('gen_jobs_completed_subjects_non_negative', sql`${t.completedSubjects} >= 0`),
  check('gen_jobs_failed_subjects_non_negative', sql`${t.failedSubjects} >= 0`),
  check(
    'gen_jobs_completed_plus_failed_bounded',
    sql`${t.completedSubjects} + ${t.failedSubjects} <= ${t.totalSubjects}`,
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  generation_job_subjects
//
//  One row per subject per generation job.
//  Tracks per-subject retry count and failure reason.
// ─────────────────────────────────────────────────────────────────────────────

export const generationJobSubjects = pgTable('generation_job_subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  generationJobId: uuid('generation_job_id')
    .notNull()
    .references(() => generationJobs.id, { onDelete: 'cascade' }),
  subject: varchar('subject', { length: 100 }).notNull(),
  targetCount: integer('target_count').notNull(),
  status: subjectJobStatusEnum('status').notNull().default('PENDING'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  // Questions of this subject ready so far in the current attempt (batch progress).
  generatedCount: integer('generated_count').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  unique('gen_job_subjects_job_subject_unique').on(t.generationJobId, t.subject),
  check('gen_job_subjects_attempts_bounded', sql`${t.attemptCount} <= ${t.maxAttempts}`),
  check('gen_job_subjects_generated_bounded', sql`${t.generatedCount} >= 0 AND ${t.generatedCount} <= ${t.targetCount}`),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  attempts
//
//  One attempt per (user, mock) that is IN_PROGRESS at a time.
//  Server stores started_at + deadline_at — frontend timer is display only.
// ─────────────────────────────────────────────────────────────────────────────

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  mockId: uuid('mock_id')
    .notNull()
    .references(() => mocks.id),
  status: attemptStatusEnum('status').notNull().default('IN_PROGRESS'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  score: numeric('score', { precision: 7, scale: 2 }),
  totalCorrect: integer('total_correct'),
  totalIncorrect: integer('total_incorrect'),
  totalUnattempted: integer('total_unattempted'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('attempts_user_mock_idx').on(t.userId, t.mockId),
  index('attempts_status_idx').on(t.status),
  check('attempts_deadline_after_start', sql`${t.deadlineAt} > ${t.startedAt}`),
  // No non-negative check on score: with −1 per wrong answer a net score can be negative.
  check('attempts_total_correct_non_negative', sql`${t.totalCorrect} IS NULL OR ${t.totalCorrect} >= 0`),
  check('attempts_total_incorrect_non_negative', sql`${t.totalIncorrect} IS NULL OR ${t.totalIncorrect} >= 0`),
  check('attempts_total_unattempted_non_negative', sql`${t.totalUnattempted} IS NULL OR ${t.totalUnattempted} >= 0`),
  check(
    'attempts_submitted_requirements',
    sql`${t.status} = 'IN_PROGRESS' OR (${t.submittedAt} IS NOT NULL AND ${t.score} IS NOT NULL)`,
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  attempt_answers
//
//  Composite PK: (attempt_id, question_id)
//  Persisted incrementally as the user selects answers.
//  is_correct remains nullable until deterministic grading runs.
// ─────────────────────────────────────────────────────────────────────────────

export const attemptAnswers = pgTable('attempt_answers', {
  attemptId: uuid('attempt_id')
    .notNull()
    .references(() => attempts.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id')
    .notNull()
    .references(() => questions.id),
  selectedAnswer: varchar('selected_answer', { length: 1 }),
  isCorrect: boolean('is_correct'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  // Client-reported time spent viewing the question (analytics only, never scoring).
  timeSpentSeconds: integer('time_spent_seconds').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.attemptId, t.questionId] }),
  check(
    'attempt_answers_selected_answer_valid',
    sql`${t.selectedAnswer} IS NULL OR ${t.selectedAnswer} IN ('A', 'B', 'C', 'D')`,
  ),
  index('attempt_answers_attempt_idx').on(t.attemptId),
  check('attempt_answers_time_spent_non_negative', sql`${t.timeSpentSeconds} >= 0`),
]);

// ─────────────────────────────────────────────────────────────────────────────
//  question_flags
//
//  Manual safety/review mechanism. Users can flag problematic questions.
//  reason constrained via flagReasonEnum.
// ─────────────────────────────────────────────────────────────────────────────

export const questionFlags = pgTable('question_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => questions.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  attemptId: uuid('attempt_id').references(() => attempts.id),
  reason: flagReasonEnum('reason').notNull(),
  // Optional free-text explanation from the user raising the flag.
  comment: text('comment'),
  status: flagStatusEnum('flag_status').notNull().default('OPEN'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('question_flags_question_idx').on(t.questionId),
  index('question_flags_user_idx').on(t.userId),
  index('question_flags_status_idx').on(t.status),
  // One flag per user per question; re-flagging updates the existing row.
  unique('question_flags_user_question_unique').on(t.userId, t.questionId),
]);
