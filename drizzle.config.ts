import { defineConfig } from 'drizzle-kit';

// drizzle.config.ts runs in the CLI context where dotenv is not pre-loaded.
// We read DATABASE_URL directly from process.env after loading .env manually.
import { config } from 'dotenv';
config();

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL environment variable is required for drizzle-kit commands.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
