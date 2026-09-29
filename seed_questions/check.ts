/**
 * Offline check of seed question files (no database): schema, exact subject/topic
 * names, the same local validator generated questions go through, duplicate stems,
 * and per-subject counts / answer-letter / difficulty spread.
 *
 *   npx tsx seed_questions/check.ts                       # super_tet_seed.json
 *   npx tsx seed_questions/check.ts parts/gk.json ...     # specific files
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { seedEntrySchema, SEED_FILE } from '../src/modules/generation/seed.bank.js';
import { superTetPrimary2026 } from '../src/modules/exams/profiles/super-tet-primary.js';
import { normalizeText, validateItem } from '../src/modules/generation/question.quality.js';

const topics = superTetPrimary2026.canonicalTopics as Record<string, string[]>;
const files = process.argv.slice(2).map((f) => resolve('seed_questions', f));
let problems = 0;
const stems = new Map<string, string>();

for (const file of files.length ? files : [SEED_FILE]) {
  const entries = z.array(seedEntrySchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  const stats = new Map<string, { n: number; letters: Record<string, number>; diff: Record<string, number> }>();
  entries.forEach((e, i) => {
    const where = `${file.split(/[\\/]/).pop()}#${i} (${e.topic})`;
    if (!topics[e.subject]?.includes(e.topic)) {
      console.log(`✗ ${where}: unknown subject/topic "${e.subject}" / "${e.topic}"`);
      problems++;
      return;
    }
    for (const language of ['hi', 'en'] as const) {
      const v = e[language] ?? e.hi ?? e.en!;
      const slot = { slot: 1, subject: e.subject, topic: e.topic, difficulty: e.difficulty, level: '' };
      const r = validateItem({ slot: 1, ...v, correctAnswer: e.correctAnswer }, new Map([[1, slot]]), language);
      if (!r.ok) {
        console.log(`✗ ${where} [${language}]: ${r.reason} — ${v.questionText.slice(0, 70)}`);
        problems++;
      }
      const key = `${language}|${e.subject}|${normalizeText(v.questionText)}`;
      if (stems.has(key)) {
        console.log(`✗ ${where} [${language}]: duplicate stem of ${stems.get(key)}`);
        problems++;
      }
      stems.set(key, where);
    }
    const s = stats.get(e.subject) ?? { n: 0, letters: {}, diff: {} };
    s.n++;
    s.letters[e.correctAnswer] = (s.letters[e.correctAnswer] ?? 0) + 1;
    s.diff[e.difficulty] = (s.diff[e.difficulty] ?? 0) + 1;
    stats.set(e.subject, s);
  });
  for (const [subject, s] of stats) {
    const missing = topics[subject].filter((t) => !entries.some((e) => e.subject === subject && e.topic === t));
    console.log(`${subject}: ${s.n} · letters ${JSON.stringify(s.letters)} · ${JSON.stringify(s.diff)}${missing.length ? ` · MISSING TOPICS ${missing.join(', ')}` : ''}`);
    problems += missing.length;
  }
}
console.log(problems === 0 ? '✅ no problems' : `❌ ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
