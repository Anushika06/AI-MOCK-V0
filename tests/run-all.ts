/**
 * Runs the whole verification suite against a SEPARATE test database.
 *
 * The suites clear the question bank, so they must never run against the
 * database you use for real mocks.
 *
 *   TEST_DATABASE_URL  (default: DATABASE_URL with the database name suffixed "_test")
 *
 * Steps: create the test database if missing → apply
 * migrations → seed → run each verify script in order (stops at first failure).
 *
 *   npm test                  # everything
 *   npm test -- api unit   # only scripts whose name contains one of the filters
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

config();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SUITE = [
  'tests/verify-unit.ts',
  'tests/verify-database.ts',
  'tests/verify-profile.ts',
  'tests/verify-mock-init.ts',
  'tests/verify-bank.ts',
  'tests/verify-api.ts',
];

function testDatabaseUrl(): string {
  if (process.env['TEST_DATABASE_URL']) return process.env['TEST_DATABASE_URL'];
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) in .env');
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
  return url.toString();
}

async function ensureDatabase(url: string) {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/_test$|test/.test(dbName)) {
    throw new Error(`Refusing to run destructive tests against "${dbName}" — test database names must contain "test".`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      console.log(`Creating test database "${dbName}"…`);
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

function runScript(file: string, env: NodeJS.ProcessEnv): boolean {
  const res = spawnSync(process.execPath, ['--import', 'tsx', file], { cwd: root, env, stdio: 'inherit' });
  return res.status === 0;
}

async function main() {
  const url = testDatabaseUrl();
  await ensureDatabase(url);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    NODE_ENV: 'test',
    // Tests inject their own writers; keep the default offline.
    LLM_PROVIDER: 'fake',
  };

  console.log(`\n▶ Test database: ${new URL(url).pathname.slice(1)}`);
  for (const step of ['src/db/migrate.ts', 'src/db/seed.ts']) {
    if (!runScript(step, env)) {
      console.error(`\n❌ ${step} failed`);
      process.exit(1);
    }
  }

  const filters = process.argv.slice(2);
  const selected = filters.length ? SUITE.filter((f) => filters.some((x) => f.includes(x))) : SUITE;
  const passed: string[] = [];
  for (const file of selected) {
    console.log(`\n━━━ ${file} ━━━`);
    if (!runScript(file, env)) {
      console.error(`\n❌ FAILED: ${file}  (${passed.length}/${selected.length} passed before it)`);
      process.exit(1);
    }
    passed.push(file);
  }
  console.log(`\n✅ All ${passed.length} verification scripts passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
