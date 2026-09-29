import { z } from 'zod';
import type { GeneratedQuestion, Language, OptionLetter, WriteSlot } from './question.types.js';
import { OPTION_LETTERS } from './question.types.js';

/**
 * Deterministic, local quality gate for model output — no second model call.
 * Each item is checked on its own, so one bad question never costs the batch.
 */

const rawItemSchema = z.object({
  slot: z.coerce.number().int(),
  questionText: z.string(),
  options: z.object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() }),
  explanation: z.string().optional().default(''),
  correctAnswer: z.string().transform((v) => v.trim().toUpperCase()),
});

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;

/** Topics whose content is meant to be in another language than the paper medium. */
const ENGLISH_CONTENT_TOPICS = /english/i;
const INDIC_CONTENT_TOPICS = /hindi|sanskrit|gadyansh|padyansh/i;

const PLACEHOLDER = /lorem ipsum|\bTODO\b|\bTBD\b|\?\?\?|\[(insert|placeholder|passage)[^\]]*\]|option [A-D] (text|here)|<\/?(p|br|b|i|u|em|strong|span|div|sup|sub|li|ul|ol|table|tr|td)\b[^<>]*>/i;

// Options that name other options by letter break when options are reordered.
const LETTER_REFERENCE = /\b(both|only|either|neither)\s+\(?[A-D]\)?\s*(and|or|&|,|nor)\s*\(?[A-D]\)?|\b[A-D]\s*(and|&)\s*[A-D]\b|\b(option|choice)\s*\(?[A-D]\)?|विकल्प\s*\(?[A-D]\)?|\(?[A-D]\)?\s*(और|तथा|एवं)\s*\(?[A-D]\)?/i;
// "All / none of the above" style options are allowed only as option D (they are never moved).
const ABOVE_STYLE = /\b(all|none|any) of (the )?(above|these|them)\b|\bnone of these\b|उपर्युक्त|उपरोक्त|इनमें से (कोई|सभी)|इनमे से|उक्त सभी|सभी सही/i;

/** Lower-cased, punctuation-free, whitespace-collapsed text (Devanagari preserved). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter((t) => t.length > 1));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

function letterCount(text: string): number {
  return (text.match(DEVANAGARI)?.length ?? 0) + (text.match(LATIN)?.length ?? 0);
}

function share(text: string, re: RegExp): number {
  const letters = letterCount(text);
  if (letters === 0) return 0;
  return (text.match(re)?.length ?? 0) / letters;
}

/** Numbers appearing in a text, normalised ("1,250.50" → "1250.5"; Devanagari digits → ASCII). */
function numbersIn(text: string): string[] {
  const ascii = text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  return (ascii.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ''))));
}

export const isNumericOption = (text: string) => /^[^\p{L}]*\d[^\p{L}]*$/u.test(text.replace(/[₹%°]|rs\.?|रु\.?|रुपये|सेमी|मी|cm|m|km|kg|वर्ष|years?|दिन|days?|घंटे|hours?/giu, ''));

/** First number in an option, for ordering numeric options ("₹1,250" → 1250, "3/4" → 0.75). */
export function numericValue(text: string): number {
  const ascii = text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)).replace(/,/g, '');
  const fraction = ascii.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  const n = ascii.match(/-?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : Number.NaN;
}

const CALCULATION_SUBJECTS = new Set(['Mathematics', 'Logical Reasoning', 'Science']);

export type ValidationResult =
  | { ok: true; question: GeneratedQuestion }
  | { ok: false; slot: number | null; reason: string };

/**
 * Validates one raw item against the slot it claims to fill. Subject, topic and
 * difficulty come from the slot (the plan is authoritative), not from the model.
 */
export function validateItem(raw: unknown, slots: Map<number, WriteSlot>, language: Language): ValidationResult {
  const parsed = rawItemSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, slot: null, reason: 'malformed item' };
  const item = parsed.data;
  const fail = (reason: string): ValidationResult => ({ ok: false, slot: item.slot, reason });

  const slot = slots.get(item.slot);
  if (!slot) return fail(`unknown slot ${item.slot}`);

  const questionText = item.questionText.trim();
  const options = Object.fromEntries(OPTION_LETTERS.map((l) => [l, item.options[l].trim()])) as Record<OptionLetter, string>;
  const explanation = item.explanation.trim();

  if (!OPTION_LETTERS.includes(item.correctAnswer as OptionLetter)) return fail('correctAnswer is not A–D');
  const correctAnswer = item.correctAnswer as OptionLetter;

  if (questionText.length < 12) return fail('question text too short');
  if (questionText.length > 4000) return fail('question text too long');
  if (OPTION_LETTERS.some((l) => options[l].length === 0)) return fail('empty option');
  if (OPTION_LETTERS.some((l) => options[l].length > 300)) return fail('option too long');
  // Symbols matter here: "(x − 3)(x + 3)" and "(x + 3)²" are different options.
  const optionKey = (t: string) => t.toLowerCase().normalize('NFC').replace(/\s+/g, '').replace(/[.,।]+$/, '');
  if (new Set(OPTION_LETTERS.map((l) => optionKey(options[l]))).size !== 4) return fail('duplicate options');

  const allText = [questionText, ...OPTION_LETTERS.map((l) => options[l]), explanation].join('\n');
  if (PLACEHOLDER.test(allText)) return fail('placeholder or markup text');
  if (/\*\*|^#{1,6}\s/m.test(questionText)) return fail('markdown in question text');
  if (/\b(answer|उत्तर)\s*[:：]\s*\(?[A-D]\)?/i.test(questionText)) return fail('answer leaked into the stem');
  // "(a) …", "A) …", "A: …" ("A. …" is not checked: it is indistinguishable from initials like "C. Rajagopalachari").
  if (OPTION_LETTERS.some((l) => /^(\(?[A-Da-d]\)|[A-Da-d]:)\s/.test(options[l]))) return fail('option text carries its own letter label');
  // In Reasoning, letters usually name people or terms ("A and C are truth-tellers"), not options.
  if (slot.subject !== 'Logical Reasoning' && OPTION_LETTERS.some((l) => LETTER_REFERENCE.test(options[l]))) {
    return fail('option refers to another option by letter');
  }
  if ((['A', 'B', 'C'] as const).some((l) => ABOVE_STYLE.test(options[l]))) return fail('"all/none of the above" option not in position D');

  // Medium: the stem must be in the paper language unless the topic tests another language.
  // Stems made of symbols ("2, 6, 12, 20, ?", "CAT : DBU :: DOG : ?") are the same in both mediums.
  const wordy = letterCount(questionText) >= 15;
  if (wordy && language === 'hi' && !ENGLISH_CONTENT_TOPICS.test(slot.topic) && share(questionText, DEVANAGARI) < 0.5) {
    return fail('question is not in Hindi');
  }
  if (wordy && language === 'en' && !INDIC_CONTENT_TOPICS.test(slot.topic) && share(questionText, LATIN) < 0.6) {
    return fail('question is not in English');
  }

  // Calculation consistency: for numeric keys the worked explanation must arrive at
  // the keyed value, and must not end on a different option's value.
  if (OPTION_LETTERS.every((l) => isNumericOption(options[l])) && explanation) {
    const keyNumbers = numbersIn(options[correctAnswer]);
    const explained = numbersIn(explanation);
    if (keyNumbers.length > 0 && !keyNumbers.every((n) => explained.includes(n))) {
      return fail('explanation does not reach the keyed value');
    }
    const finalValue = explained.at(-1);
    // Only for calculation subjects: elsewhere explanations often list every option's value.
    const otherHit = CALCULATION_SUBJECTS.has(slot.subject) && OPTION_LETTERS.some((l) => l !== correctAnswer &&
      numbersIn(options[l]).length > 0 && numbersIn(options[l]).every((n) => n === finalValue) &&
      !keyNumbers.includes(finalValue ?? ''));
    if (otherHit) return fail('explanation ends on a different option');
  }

  return {
    ok: true,
    question: {
      subject: slot.subject,
      topic: slot.topic,
      difficulty: slot.difficulty,
      language,
      questionText,
      options,
      correctAnswer,
      ...(explanation ? { explanation } : {}),
    },
  };
}

/** A question already in the bank, reduced to what duplicate checks need. */
export interface BankFingerprint {
  normalized: string;
  tokens: Set<string>;
  correctText: string;
}

export function fingerprint(questionText: string, correctText: string): BankFingerprint {
  return { normalized: normalizeText(questionText), tokens: tokenSet(questionText), correctText: normalizeText(correctText) };
}

/**
 * True when `candidate` repeats an existing question: identical normalised stem, or a
 * near-identical stem (≥ 0.8 token overlap) with the same correct answer. Passage-based
 * questions share long passages, so a high overlap alone is not treated as a duplicate.
 */
export function isDuplicate(candidate: BankFingerprint, existing: Iterable<BankFingerprint>, threshold = 0.8): boolean {
  for (const other of existing) {
    if (candidate.normalized === other.normalized) return true;
    if (candidate.correctText === other.correctText && jaccard(candidate.tokens, other.tokens) >= threshold) return true;
  }
  return false;
}
