/**
 * Imports the seed question bank (seed_questions/super_tet_seed.json) into the
 * active exam profile. Safe to run repeatedly: questions already present are skipped.
 *
 *   npm run bank:seed
 */
import { pool } from './index.js';
import { examProfileService } from '../modules/exams/exam.service.js';
import { SUPER_TET_EXAM_ID } from '../modules/exams/profiles/super-tet-primary.js';
import { importSeedQuestions, loadSeedFile, SEED_FILE } from '../modules/generation/seed.bank.js';

async function main() {
  const entries = loadSeedFile();
  const profile = await examProfileService.getActiveExamProfile(SUPER_TET_EXAM_ID);
  const report = await importSeedQuestions(entries, profile);

  console.log(`Seed bank: ${entries.length} entries in ${SEED_FILE}`);
  console.log(`  inserted ${report.inserted}, already present ${report.alreadyPresent}, rejected ${report.rejected.length}`);
  for (const [subject, n] of Object.entries(report.perSubject)) {
    console.log(`  ${subject.padEnd(40)} hi ${String(n.hi).padStart(3)}   en ${String(n.en).padStart(3)}`);
  }
  for (const r of report.rejected) console.warn(`  ✗ entry #${r.index} (${r.language}): ${r.reason}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
