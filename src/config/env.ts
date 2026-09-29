/**
 * Environment configuration — validated at startup with Zod.
 * The application will fail fast with a clear error if any required
 * variable is missing or invalid.
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

// Load .env file (no-op in production where env vars come from the host)
loadDotenv();

const intFromString = (fallback: string, min = 0) =>
  z
    .string()
    .default(fallback)
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(min));

const boolFromString = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z
    .string()
    .default('3000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(65535)),

  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://', {
      message: 'DATABASE_URL must be a valid postgresql:// connection string',
    }),

  // gemini = real questions; demo = keyless placeholder questions for trying the app;
  // fake = deterministic output used by the automated tests.
  LLM_PROVIDER: z
    .enum(['fake', 'demo', 'gemini'])
    .default('fake'),

  LLM_MODEL: z
    .string()
    .default('gemini-3.8-flash'),

  GEMINI_API_KEY: z
    .string()
    .optional(),

  // Optional Gemini thinking level (minimal | low | medium | high). Unset = model default.
  LLM_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  LLM_MAX_OUTPUT_TOKENS: intFromString('32768', 1024),

  // Authoring specification sent with every generation request. Relative paths
  // resolve from the project root. Edited without touching code.
  PROMPT_SPEC_PATH: z.string().default('prompt.md'),

  // ─── Gemini request limits ───────────────────────────────────────────────
  // Hard timeout for a single Gemini HTTP call.
  LLM_REQUEST_TIMEOUT_MS: intFromString('180000', 1000),
  // Retries of one request on per-minute rate limits (429) / 5xx / timeouts.
  // Daily-quota 429s are never retried. Every retry counts against the mock's call budget.
  LLM_RATE_LIMIT_MAX_RETRIES: intFromString('2', 0),
  // Minimum gap between the starts of two Gemini requests (6000 ms ≈ 10 requests/minute).
  LLM_MIN_REQUEST_INTERVAL_MS: intFromString('6000', 0),
  // Gemini requests allowed in flight at the same time.
  LLM_MAX_CONCURRENCY: intFromString('2', 1),

  // ─── Question bank ───────────────────────────────────────────────────────
  // Fresh questions written for every full mock (15% of a 120-question paper); the
  // rest comes from unseen bank questions (pre-filled by `npm run bank:seed`).
  GENERATION_NEW_PER_MOCK: intFromString('18', 0),
  // Hard ceiling on fresh questions per mock, used only when the bank has no unseen
  // question for a slot. Beyond it the user's least-recently-seen questions are reused.
  GENERATION_MAX_NEW_PER_MOCK: intFromString('30', 0),
  // Questions requested per Gemini call (18 fresh = 2 calls).
  GENERATION_BATCH_SIZE: intFromString('15', 1),
  // Hard cap on Gemini requests (including retries and the repair pass) for one mock.
  GENERATION_MAX_CALLS_PER_MOCK: intFromString('4', 1),

  // ─── Background generation worker ────────────────────────────────────────
  GENERATION_WORKER_ENABLED: boolFromString('true'),
  GENERATION_POLL_INTERVAL_MS: intFromString('3000', 250),
  GENERATION_HEARTBEAT_INTERVAL_MS: intFromString('15000', 1000),
  // A job whose heartbeat is older than this is considered interrupted and is recovered.
  GENERATION_STALE_AFTER_SECONDS: intFromString('120', 10),
  // Maximum mocks a single user may have in GENERATING state at once.
  MAX_CONCURRENT_GENERATIONS_PER_USER: intFromString('2', 1),

  // ─── Exam attempts ───────────────────────────────────────────────────────
  // How often expired IN_PROGRESS attempts are auto-submitted in the background.
  ATTEMPT_SWEEP_INTERVAL_MS: intFromString('30000', 1000),
});

// Parse and validate — throws a descriptive ZodError on failure.
// Empty values (e.g. `GEMINI_API_KEY=` copied from .env.example) count as unset so defaults apply.
const parsed = EnvSchema.safeParse(
  Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')),
);

if (!parsed.success) {
  console.error('❌  Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
