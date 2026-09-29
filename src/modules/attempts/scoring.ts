/**
 * Deterministic, pure scoring. No I/O — the caller loads the authoritative
 * correct options from the questions table and the marking rules from the
 * attempt's ExamProfile, never from the client.
 */

export type OptionId = 'A' | 'B' | 'C' | 'D';

export interface ScoringRules {
  marksPerCorrect: number;
  negativeMarking: boolean;
  /** Magnitude deducted per wrong answer (e.g. 1 for "−1"). Ignored unless negativeMarking. */
  negativeMarksPerQuestion: number | null;
}

export interface ScorableQuestion {
  questionId: string;
  correctOption: string;
  /** Section / subject name, for the per-section breakdown. */
  subject: string;
}

export type AnswerOutcome = 'CORRECT' | 'INCORRECT' | 'UNATTEMPTED';

export interface QuestionOutcome {
  questionId: string;
  selectedOption: OptionId | null;
  outcome: AnswerOutcome;
}

export interface Tally {
  correct: number;
  incorrect: number;
  unattempted: number;
  score: number;
}

export interface ScoreResult extends Tally {
  perQuestion: QuestionOutcome[];
  perSection: Array<Tally & { subject: string; total: number }>;
}

/**
 * Converts marks to integer hundredths so sums are exact (numeric(7,2) in DB).
 */
const toCents = (marks: number) => Math.round(marks * 100);

export function scoreAttempt(
  questions: ScorableQuestion[],
  answers: ReadonlyMap<string, string | null>,
  rules: ScoringRules,
): ScoreResult {
  const plus = toCents(rules.marksPerCorrect);
  const minus = rules.negativeMarking ? toCents(rules.negativeMarksPerQuestion ?? 0) : 0;

  const total = { correct: 0, incorrect: 0, unattempted: 0, cents: 0 };
  const sections = new Map<string, { correct: number; incorrect: number; unattempted: number; cents: number; total: number }>();
  const perQuestion: QuestionOutcome[] = [];

  for (const q of questions) {
    const raw = answers.get(q.questionId) ?? null;
    const selected = raw === 'A' || raw === 'B' || raw === 'C' || raw === 'D' ? raw : null;

    let outcome: AnswerOutcome;
    let delta = 0;
    if (selected === null) {
      outcome = 'UNATTEMPTED';
    } else if (selected === q.correctOption) {
      outcome = 'CORRECT';
      delta = plus;
    } else {
      outcome = 'INCORRECT';
      delta = -minus;
    }

    const section = sections.get(q.subject) ?? { correct: 0, incorrect: 0, unattempted: 0, cents: 0, total: 0 };
    section.total++;
    section.cents += delta;
    total.cents += delta;
    if (outcome === 'CORRECT') { total.correct++; section.correct++; }
    else if (outcome === 'INCORRECT') { total.incorrect++; section.incorrect++; }
    else { total.unattempted++; section.unattempted++; }
    sections.set(q.subject, section);

    perQuestion.push({ questionId: q.questionId, selectedOption: selected, outcome });
  }

  return {
    correct: total.correct,
    incorrect: total.incorrect,
    unattempted: total.unattempted,
    score: total.cents / 100,
    perQuestion,
    perSection: [...sections.entries()].map(([subject, s]) => ({
      subject,
      total: s.total,
      correct: s.correct,
      incorrect: s.incorrect,
      unattempted: s.unattempted,
      score: s.cents / 100,
    })),
  };
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

/** Per-topic tallies in first-appearance order. */
export function aggregateByTopic(
  rows: Array<{ subject: string; topic: string; outcome: AnswerOutcome; timeSpentSeconds?: number }>,
): TopicStat[] {
  const map = new Map<string, TopicStat>();
  for (const r of rows) {
    const key = `${r.subject}\u0000${r.topic}`;
    const s = map.get(key) ?? {
      subject: r.subject, topic: r.topic, total: 0, correct: 0, incorrect: 0, unattempted: 0, accuracy: null, timeSpentSeconds: 0,
    };
    s.total++;
    s.timeSpentSeconds += r.timeSpentSeconds ?? 0;
    if (r.outcome === 'CORRECT') s.correct++;
    else if (r.outcome === 'INCORRECT') s.incorrect++;
    else s.unattempted++;
    map.set(key, s);
  }
  return [...map.values()].map((s) => ({ ...s, accuracy: accuracyPercent(s.correct, s.incorrect) }));
}

/**
 * Topics to revise: those where fewer than half the questions were answered
 * correctly (skips count as not correct), weakest first, larger topics first on ties.
 */
export function weakestTopics(topics: TopicStat[], limit = 5): TopicStat[] {
  return topics
    .filter((t) => t.total > 0 && t.correct / t.total < 0.5)
    .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total)
    .slice(0, limit);
}

/** Accuracy over attempted questions, as a percentage with 2 decimals; null if none attempted. */
export function accuracyPercent(correct: number, incorrect: number): number | null {
  const attempted = correct + incorrect;
  if (attempted === 0) return null;
  return Math.round((correct / attempted) * 10000) / 100;
}
