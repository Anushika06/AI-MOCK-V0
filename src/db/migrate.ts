/**
 * Database migration runner.
 *
 * Applies all pending Drizzle migrations using the node-postgres driver.
 * This is the reliable alternative to `drizzle-kit migrate` for CI/production.
 *
 * Usage:
 *   npx tsx src/db/migrate.ts
 *   (or via: npm run db:migrate:run)
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL is required');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../../drizzle');

async function runMigrations() {
  console.log('🔄  Running database migrations…');
  console.log(`    Migrations folder: ${migrationsFolder}`);

  const pool = new Pool({ connectionString: DATABASE_URL as string });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder });
    console.log('✅  Migrations applied successfully.');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
