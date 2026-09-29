export type Language = 'hi' | 'en';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type OptionLetter = 'A' | 'B' | 'C' | 'D';

export const OPTION_LETTERS: OptionLetter[] = ['A', 'B', 'C', 'D'];

/** One question as it is stored in the bank (before it gets a database id). */
export interface GeneratedQuestion {
  subject: string;
  topic: string;
  difficulty: Difficulty;
  language: Language;
  questionText: string;
  options: Record<OptionLetter, string>;
  correctAnswer: OptionLetter;
  /** Short worked solution; optional for older rows. */
  explanation?: string;
}

/** A position in the paper that needs a question of this subject / topic / difficulty. */
export interface WriteSlot {
  /** 1-based number the model must echo back, so answers map to slots in any order. */
  slot: number;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  /** Level the question must be pitched at, from the exam profile (e.g. "up to Class 12"). */
  level: string;
}

export interface WriteRequest {
  examName: string;
  language: Language;
  slots: WriteSlot[];
  /** Existing bank stems per topic the model should not repeat. */
  avoid: Record<string, string[]>;
}

/**
 * Raw model output. Items are untrusted: every one is validated locally and
 * invalid items are dropped individually (the rest of the batch is kept).
 */
export interface WriteResult {
  items: unknown[];
}

/**
 * Writes a batch of questions in ONE model request (plus bounded transport retries).
 * Implementations must call `budget.take()` before every HTTP request they send.
 */
export interface QuestionWriter {
  readonly name: string;
  write(request: WriteRequest, budget: CallBudget): Promise<WriteResult>;
}

/** Thrown when a mock has spent its whole LLM request budget. */
export class CallBudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(`LLM request budget of ${limit} call(s) for this mock is used up`);
    this.name = 'CallBudgetExhaustedError';
  }
}

/** Counts LLM requests (including retries) against a hard per-mock limit. */
export class CallBudget {
  private used = 0;

  constructor(public readonly limit: number) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(this.limit - this.used, 0);
  }

  take(): void {
    if (this.used >= this.limit) throw new CallBudgetExhaustedError(this.limit);
    this.used++;
  }
}
