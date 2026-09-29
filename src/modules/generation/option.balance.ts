import type { GeneratedQuestion } from './question.types.js';
import { shuffle, type RandomSource } from './section.plan.js';
import { isNumericOption, numericValue } from './question.quality.js';

type Letter = 'A' | 'B' | 'C' | 'D';
const LETTERS: Letter[] = ['A', 'B', 'C', 'D'];

/**
 * Options whose meaning depends on their position or on other options
 * ("Both A and B", "All of the above", "इनमें से कोई नहीं") must not be moved.
 */
const POSITION_DEPENDENT = [
  /\b(all|none|both|neither)\b[^.]*\b(above|these|of them|options?)\b/i,
  /\b[A-D]\s*(and|or|&|,)\s*[A-D]\b/,
  /\b(option|choice)\s*\(?[A-D]\)?\b/i,
  /\(\s*[A-D]\s*\)/,
  /उपर्युक्त|उपरोक्त|इनमें से|इनमे से|उक्त सभी|दोनों|सभी सही|कोई नहीं|विकल्प\s*\(?[A-D]/,
];

/** Numeric options are printed in ascending order (exam convention), so their letters are fixed by value. */
export function sortNumericOptions(question: GeneratedQuestion): GeneratedQuestion | null {
  if (!LETTERS.every((l) => isNumericOption(question.options[l]))) return null;
  const values = LETTERS.map((l) => ({ text: question.options[l], value: numericValue(question.options[l]), correct: l === question.correctAnswer }));
  if (values.some((v) => Number.isNaN(v.value))) return null;
  values.sort((a, b) => a.value - b.value);
  const options = Object.fromEntries(LETTERS.map((l, i) => [l, values[i].text])) as GeneratedQuestion['options'];
  return { ...question, options, correctAnswer: LETTERS[values.findIndex((v) => v.correct)] };
}

export function hasPositionDependentOptions(question: GeneratedQuestion): boolean {
  return LETTERS.some((l) => POSITION_DEPENDENT.some((re) => re.test(question.options[l])));
}

/**
 * Moves the correct option of `question` to `target` and shuffles the other three
 * into the remaining positions. The option texts and which text is correct are
 * unchanged — only letters move.
 */
export function placeCorrectOption(
  question: GeneratedQuestion,
  target: Letter,
  random: RandomSource = Math.random,
): GeneratedQuestion {
  const correctText = question.options[question.correctAnswer];
  const others = shuffle(LETTERS.filter((l) => l !== question.correctAnswer).map((l) => question.options[l]), random);
  const options = {} as GeneratedQuestion['options'];
  for (const letter of LETTERS) {
    options[letter] = letter === target ? correctText : others.shift()!;
  }
  return { ...question, options, correctAnswer: target };
}

/**
 * Keeps the correct-answer letters of a section evenly spread across A–D.
 * Each question's correct option is moved to a currently least-used letter
 * (random tie-break), so across a section the counts differ by at most one.
 * Questions with position-dependent options are left untouched and numeric options
 * are sorted ascending (both still counted).
 */
export class OptionBalancer {
  private readonly counts: Record<Letter, number> = { A: 0, B: 0, C: 0, D: 0 };

  constructor(private readonly random: RandomSource = Math.random) {}

  balance(questions: GeneratedQuestion[]): GeneratedQuestion[] {
    return questions.map((q) => {
      const numeric = sortNumericOptions(q);
      if (numeric) {
        this.counts[numeric.correctAnswer]++;
        return numeric;
      }
      if (hasPositionDependentOptions(q)) {
        this.counts[q.correctAnswer]++;
        return q;
      }
      const min = Math.min(...LETTERS.map((l) => this.counts[l]));
      const candidates = LETTERS.filter((l) => this.counts[l] === min);
      const target = candidates[Math.floor(this.random() * candidates.length)];
      this.counts[target]++;
      return placeCorrectOption(q, target, this.random);
    });
  }

  /** Counts a correct letter that is already fixed (e.g. a reused bank question). */
  observe(letter: string): void {
    if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') this.counts[letter]++;
  }

  get distribution(): Readonly<Record<Letter, number>> {
    return this.counts;
  }
}
