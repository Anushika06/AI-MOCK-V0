/**
 * Database module — single pg Pool + Drizzle client for the application.
 *
 * Import `db` anywhere you need to run queries.
 * Import `pool` only if you need raw pg Pool access (e.g. transaction helpers).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// One connection pool for the entire process lifetime.
// pg Pool is safe to share across the application.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Keep idle connections alive so the health check stays fast.
  idleTimeoutMillis: 30_000,
  // Never queue more than this many waiting clients.
  max: 10,
});

pool.on('error', (err) => {
  // Log unexpected pool-level errors (e.g. network drops).
  // These don't crash the process but should be monitored.
  console.error('[db] Unexpected pool error:', err.message);
});

// Drizzle client bound to our schema for full type inference.
export const db = drizzle(pool, { schema });

/** Transaction handle passed to `db.transaction(async (tx) => …)` callbacks. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Postgres error code for unique_violation, unwrapping drizzle's error cause. */
export function isUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/** Verifies that the database is reachable. Used by the health endpoint. */
export async function checkDatabaseHealth(): Promise<{ connected: boolean; error?: string }> {
  try {
    await pool.query('SELECT 1');
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}
