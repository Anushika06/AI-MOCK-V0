// Response shapes of the backend API (src/modules/*). Kept in one place so a
// backend change shows up as a type error here.

export type OptionId = 'A' | 'B' | 'C' | 'D';
export type Language = 'hi' | 'en';
export type MockStatus = 'GENERATING' | 'READY' | 'FAILED';
export type JobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED';
export type Outcome = 'CORRECT' | 'INCORRECT' | 'UNATTEMPTED';
export type MockKind = 'FULL' | 'PRACTICE';
export type FlagReason = 'WRONG_ANSWER' | 'AMBIGUOUS_QUESTION' | 'TYPO_OR_TRANSLATION' | 'OUT_OF_SYLLABUS' | 'OTHER';

export interface ExamProfile {
  id: string;
  examId: string;
  version: string;
  name: string;
  description: string | null;
  totalQuestions: number;
  totalMarks: number;
  durationMinutes: number;
  optionsPerQuestion: number;
  marksPerCorrect: number;
  negativeMarking: boolean;
  negativeMarksPerQuestion: number | null;
  paperLanguages: Language[];
  difficultyConfig: { academicSubjects: string; professionalSubjects: string };
  sectionsConfig: Array<{ name: string; questionCount: number; levelCategory?: 'academic' | 'professional' | 'general' }>;
  canonicalTopics: Record<string, string[]>;
}

export interface ExamSummary {
  profileId: string;
  examId: string;
  version: string;
  name: string;
  totalQuestions: number;
  totalMarks: number;
  durationMinutes: number;
  optionsPerQuestion: number;
  marksPerCorrect: number;
  negativeMarking: boolean;
  negativeMarksPerQuestion: number | null;
  paperLanguages: Language[];
}

export interface GenerationProgress {
  jobId: string;
  status: JobStatus;
  totalSubjects: number;
  completedSubjects: number;
  failedSubjects: number;
  currentSubject: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  questionsReady: number | null;
  totalQuestions: number;
  percent: number;
  /** Questions taken from the saved question collection. */
  reusedCount?: number;
  /** Freshly written questions. */
  newCount?: number;
}

export interface Section {
  name: string;
  startNumber: number;
  endNumber: number;
  questionCount: number;
}

export interface AttemptView {
  id: string;
  mockId: string;
  status: AttemptStatus;
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  serverNow: string;
  remainingSeconds: number;
  score: number | null;
  totalCorrect: number | null;
  totalIncorrect: number | null;
  totalUnattempted: number | null;
}

export interface MockBase {
  id: string;
  title: string;
  language: Language;
  status: MockStatus;
  kind: MockKind;
  sourceAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MockListItem extends MockBase {
  exam: { name: string; version: string; totalQuestions: number; totalMarks: number; durationMinutes: number };
  generation: GenerationProgress | null;
  attempts: {
    count: number;
    inProgressAttemptId: string | null;
    latestAttemptId: string | null;
    latestStatus: AttemptStatus | null;
    bestScore: number | null;
  };
}

export interface MockDetail extends MockBase {
  exam: ExamSummary;
  sections: Section[];
  generation: GenerationProgress | null;
  attempts: AttemptView[];
}

export interface GenerationStatus {
  mock: MockBase;
  generation: GenerationProgress;
  subjects: Array<{
    subject: string;
    targetCount: number;
    generatedCount: number;
    status: JobStatus;
    attemptCount: number;
    maxAttempts: number;
    errorMessage: string | null;
  }>;
}

export interface QuestionOption {
  id: OptionId;
  text: string;
}

export interface ExamQuestion {
  questionId: string;
  number: number;
  subject: string;
  topic: string;
  text: string;
  options: QuestionOption[];
}

export interface MockInfo {
  id: string;
  title: string;
  language: Language;
  kind: MockKind;
  sourceAttemptId: string | null;
}

export interface ExamPayload {
  attempt: AttemptView;
  mock: MockInfo;
  exam: ExamSummary;
  sections: Section[];
  questions: ExamQuestion[];
  answers: Record<string, OptionId>;
  /** Seconds already recorded per question. */
  timeSpent: Record<string, number>;
}

export interface FlagInfo {
  reason: FlagReason;
  comment: string | null;
  status: 'OPEN' | 'REVIEWED' | 'DISMISSED';
}

export interface ReviewQuestion extends ExamQuestion {
  difficulty: 'easy' | 'medium' | 'hard';
  correctOption: OptionId;
  /** Short worked solution (questions generated before explanations existed have none). */
  explanation?: string | null;
  selectedOption: OptionId | null;
  outcome: Outcome;
  timeSpentSeconds: number;
  flag: FlagInfo | null;
}

export interface Tally {
  correct: number;
  incorrect: number;
  unattempted: number;
  score: number;
}

export interface TopicStat {
  subject: string;
  topic: string;
  total: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  accuracy: number | null;
  timeSpentSeconds: number;
}

export interface ResultPayload {
  attempt: AttemptView & { timeTakenSeconds: number | null };
  mock: MockInfo;
  exam: ExamSummary;
  summary: {
    score: number;
    totalMarks: number;
    percentage: number;
    correct: number;
    incorrect: number;
    unattempted: number;
    attempted: number;
    totalQuestions: number;
    accuracy: number | null;
    trackedTimeSeconds: number;
  };
  sections: Array<Tally & { subject: string; total: number; accuracy: number | null; timeSpentSeconds: number }>;
  topics: TopicStat[];
  weakTopics: TopicStat[];
  practiceMockId: string | null;
  questions: ReviewQuestion[];
}

export interface HistoryItem extends AttemptView {
  mock: MockInfo;
  exam: { name: string; version: string; totalMarks: number; totalQuestions: number };
  accuracy: number | null;
  timeTakenSeconds: number | null;
}
