import { setTimeout as sleep } from 'node:timers/promises';
import { GoogleGenAI } from '@google/genai';
import { env } from '../../../config/env.js';
import type { CallBudget } from '../question.types.js';

/**
 * Shared Gemini client construction: every HTTP call gets a hard timeout, and the
 * SDK's own retries are disabled so withGeminiRetry is the single retry policy.
 */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: env.LLM_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
    },
  });
}

/** Gemini refused because a quota (usually the daily one) is used up; retrying now is pointless. */
export class QuotaExhaustedError extends Error {
  constructor(message: string, public readonly retryAfterMs: number | null) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | null {
  const e = error as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  const match = typeof e?.message === 'string' ? e.message.match(/\b(408|429|50[0234])\b/) : null;
  return match ? Number(match[1]) : null;
}

function isTimeout(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' ||
    (typeof e?.message === 'string' && /timed? ?out|aborted/i.test(e.message));
}

/**
 * Server-suggested wait, from google.rpc.RetryInfo ("retryDelay": "31s") or a
 * "retry in 12.5s" hint in the message. Returns milliseconds, or null.
 */
export function parseRetryDelayMs(error: unknown): number | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const match = message.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/i) ?? message.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * A 429 caused by a per-day quota (quotaId "...PerDay...") or with a suggested wait
 * longer than we are willing to sit out. Per-minute limits are retried instead.
 */
export function isQuotaExhausted(error: unknown, maxWaitMs = 60_000): boolean {
  if (statusOf(error) !== 429) return false;
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (/per ?day|PerDay|daily/i.test(message)) return true;
  const suggested = parseRetryDelayMs(error);
  return suggested !== null && suggested > maxWaitMs;
}

export function isRetryableProviderError(error: unknown): boolean {
  const status = statusOf(error);
  return (status !== null && RETRYABLE_STATUS.has(status)) || isTimeout(error);
}

/**
 * Process-wide pacing for Gemini: at most `maxConcurrency` requests in flight and at
 * least `minIntervalMs` between request starts, so a mock can never burst past the
 * per-minute request limit. After a daily-quota refusal the limiter trips and every
 * later request fails fast (no network call) until the cooldown ends.
 */
export class RequestLimiter {
  private active = 0;
  private nextStartAt = 0;
  private blockedUntil = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxConcurrency: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Trips the breaker: requests fail fast until `ms` from now. */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  get blockedForMs(): number {
    return Math.max(this.blockedUntil - this.now(), 0);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.blockedForMs > 0) {
      throw new QuotaExhaustedError('Gemini quota is exhausted; skipping the request until it resets', this.blockedForMs);
    }
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      const wait = this.nextStartAt - this.now();
      this.nextStartAt = Math.max(this.now(), this.nextStartAt) + this.minIntervalMs;
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export const geminiLimiter = new RequestLimiter(env.LLM_MIN_REQUEST_INTERVAL_MS, env.LLM_MAX_CONCURRENCY);

/** How long the limiter stays tripped after a daily-quota refusal without a hint. */
const QUOTA_COOLDOWN_MS = 15 * 60_000;

/**
 * Sends one logical request with a small, bounded retry policy:
 *  - every attempt is paced by the limiter and costs one unit of `budget`;
 *  - per-minute 429 / 5xx / timeouts are retried up to `maxRetries` times, waiting the
 *    server's suggested delay (capped) or exponential backoff with jitter;
 *  - a daily-quota 429 is never retried: it trips the limiter and throws QuotaExhaustedError.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  budget: CallBudget,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; limiter?: RequestLimiter } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? env.LLM_RATE_LIMIT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? 4000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const limiter = options.limiter ?? geminiLimiter;

  for (let attempt = 0; ; attempt++) {
    budget.take();
    try {
      return await limiter.run(fn);
    } catch (error) {
      if (error instanceof QuotaExhaustedError) throw error;
      if (isQuotaExhausted(error, maxDelayMs)) {
        const retryAfter = parseRetryDelayMs(error);
        limiter.block(retryAfter ?? QUOTA_COOLDOWN_MS);
        throw new QuotaExhaustedError(`Gemini quota exhausted: ${messageOf(error)}`, retryAfter);
      }
      if (attempt >= maxRetries || !isRetryableProviderError(error) || budget.remaining === 0) throw error;
      const suggested = parseRetryDelayMs(error);
      const backoff = baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(suggested ?? backoff, maxDelayMs));
    }
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
