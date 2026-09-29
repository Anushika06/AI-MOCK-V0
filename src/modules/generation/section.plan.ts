import type { ExamProfile } from '../exams/types.js';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface PlannedSlot {
  topic: string;
  /** Absent when the profile defines no difficulty distribution. */
  difficulty?: Difficulty;
}

export type RandomSource = () => number;

export function shuffle<T>(items: T[], random: RandomSource = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Splits `total` into integer parts proportional to `weights` (largest remainder
 * method), so e.g. 16 questions at 30/50/20 → 5/8/3 and the parts always sum to total.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const parts = exact.map(Math.floor);
  let remaining = total - parts.reduce((s, p) => s + p, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    parts[i]++;
    remaining--;
  }
  return parts;
}

/**
 * Decides, before any LLM call, which topic and difficulty every question of a
 * section must have:
 *  - topics: shuffled then dealt round-robin, so every canonical topic is used as
 *    evenly as possible (and, when there are fewer questions than topics, a
 *    different random subset is covered in each mock);
 *  - difficulty: the profile's distribution apportioned exactly, then shuffled.
 */
export function planSection(
  profile: Pick<ExamProfile, 'canonicalTopics' | 'difficultyConfig'>,
  subject: string,
  count: number,
  random: RandomSource = Math.random,
): PlannedSlot[] {
  const topics = profile.canonicalTopics[subject];
  if (!topics || topics.length === 0) {
    throw new Error(`No canonical topics for subject "${subject}"`);
  }

  const order = shuffle(topics, random);
  const slotTopics = Array.from({ length: count }, (_, i) => order[i % order.length]);

  const distribution = profile.difficultyConfig.distribution;
  let difficulties: Array<Difficulty | undefined> = new Array(count).fill(undefined);
  if (distribution) {
    const [easy, medium, hard] = apportion(count, [distribution.easy, distribution.medium, distribution.hard]);
    difficulties = shuffle<Difficulty>([
      ...new Array<Difficulty>(easy).fill('easy'),
      ...new Array<Difficulty>(medium).fill('medium'),
      ...new Array<Difficulty>(hard).fill('hard'),
    ], random);
  }

  return slotTopics.map((topic, i) => (difficulties[i] ? { topic, difficulty: difficulties[i] } : { topic }));
}
