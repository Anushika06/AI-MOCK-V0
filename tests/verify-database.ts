/**
 * Database verification: connection, tables, triggers, health endpoint.
 *
 * Run after `npm run docker:up` and `npm run db:migrate` to confirm:
 *  1. PostgreSQL accepts connections
 *  2. All tables exist
 *  3. Drizzle can execute a simple query
 *
 * Usage:
 *   npx tsx tests/verify-database.ts
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from 'dotenv';

config();

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set');
  process.exit(1);
}

const EXPECTED_TABLES = [
  'users',
  'exam_profiles',
  'questions',
  'mocks',
  'mock_questions',
  'generation_jobs',
  'generation_job_subjects',
  'attempts',
  'attempt_answers',
  'question_flags',
];

async function verify() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  let passed = 0;
  let failed = 0;

  function ok(msg: string) {
    console.log(`  ✅  ${msg}`);
    passed++;
  }

  function fail(msg: string, err?: unknown) {
    console.error(`  ❌  ${msg}`);
    if (err) console.error('     ', err instanceof Error ? err.message : err);
    failed++;
  }

  console.log('\n🔍  Database Verification\n');

  // ── 1. PostgreSQL connection ─────────────────────────────────────────────
  const client = await pool.connect().catch((err: unknown) => {
    fail('PostgreSQL connection', err);
    return null;
  });

  if (!client) {
    console.log(`\n❌  Cannot proceed without a database connection.\n`);
    await pool.end();
    process.exit(1);
  }

  ok('PostgreSQL connection established');

  try {
    // ── 3. Drizzle ORM query ──────────────────────────────────────────────
    try {
      const db = drizzle(pool);
      await db.execute('SELECT 1 AS ping');
      ok('Drizzle ORM can execute queries');
    } catch (err) {
      fail('Drizzle ORM query', err);
    }

    // ── 4. All tables exist ───────────────────────────────────────────────
    const tableResult = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const existingTables = tableResult.rows.map((r) => r.tablename);

    for (const table of EXPECTED_TABLES) {
      if (existingTables.includes(table)) {
        ok(`Table exists: ${table}`);
      } else {
        fail(`Table MISSING: ${table} — run \`npm run db:migrate\``);
      }
    }

    // ── 5. updated_at trigger exists ─────────────────────────────────────
    try {
      const triggerResult = await client.query<{ trigger_name: string }>(
        `SELECT trigger_name FROM information_schema.triggers
         WHERE trigger_schema = 'public'
           AND trigger_name LIKE 'set_%_updated_at'
         LIMIT 1`,
      );
      if (triggerResult.rows.length > 0) {
        ok('updated_at trigger exists');
      } else {
        fail('updated_at trigger not found (expected after migration)');
      }
    } catch (err) {
      fail('updated_at trigger check', err);
    }

    // ── 6. Fastify server & GET /api/health check ────────────────────────────
    try {
      const { buildApp } = await import('../src/app.js');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      if (res.statusCode === 200) {
        const payload = JSON.parse(res.payload);
        if (payload.status === 'ok' && payload.database?.connected) {
          ok(`Fastify GET /api/health returned 200 OK: ${JSON.stringify(payload)}`);
        } else {
          fail(`Fastify GET /api/health returned unexpected payload: ${res.payload}`);
        }
      } else {
        fail(`Fastify GET /api/health returned status ${res.statusCode}: ${res.payload}`);
      }
      await app.close();
      const { pool: appPool } = await import('../src/db/index.js');
      await appPool.end();
    } catch (err) {
      fail('Fastify app /health check', err);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  console.log(`${'─'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

verify().catch((err) => {
  console.error('Verification script error:', err);
  process.exit(1);
});
