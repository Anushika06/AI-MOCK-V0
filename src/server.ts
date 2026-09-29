/**
 * Application entry point.
 *
 * Responsible for:
 *  1. Building the Fastify app
 *  2. Starting the HTTP server
 *  3. Starting background services:
 *       - generation worker (runs queued mock generation jobs, resumes interrupted ones)
 *       - attempt sweeper   (auto-submits attempts whose deadline has passed)
 *  4. Graceful shutdown on SIGTERM / SIGINT
 */

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/index.js';
import { createJobExecutionService } from './modules/generation/container.js';
import { GenerationWorker } from './modules/generation/generation.worker.js';
import { attemptService } from './modules/attempts/attempt.service.js';
import { examProfileService } from './modules/exams/exam.service.js';
import { SUPER_TET_EXAM_ID } from './modules/exams/profiles/super-tet-primary.js';
import { seedQuestionCount } from './modules/generation/seed.bank.js';

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }

  app.log.info(
    { llm: env.LLM_PROVIDER, model: env.LLM_MODEL, newPerMock: env.GENERATION_NEW_PER_MOCK, maxNewPerMock: env.GENERATION_MAX_NEW_PER_MOCK, batchSize: env.GENERATION_BATCH_SIZE, maxCallsPerMock: env.GENERATION_MAX_CALLS_PER_MOCK },
    'Generation providers',
  );

  // Mocks are built mostly from the bank; without the seed bank the first papers would
  // depend on Gemini for almost every question.
  try {
    const profile = await examProfileService.getActiveExamProfile(SUPER_TET_EXAM_ID);
    if ((await seedQuestionCount(profile.id)) === 0) {
      app.log.warn('The seed question bank is not imported — run `npm run bank:seed` (or `npm run db:setup`).');
    }
  } catch (err) {
    app.log.warn({ err }, 'Could not check the question bank');
  }

  // ─── Background services ──────────────────────────────────────────────────
  let worker: GenerationWorker | null = null;
  if (env.GENERATION_WORKER_ENABLED) {
    worker = new GenerationWorker(createJobExecutionService(), { logger: app.log });
    worker.start();
    app.log.info('Generation worker started');
  }

  const sweeper = setInterval(() => {
    attemptService.finalizeExpiredAttempts()
      .then((closed) => {
        if (closed > 0) app.log.info({ closed }, 'Auto-submitted expired attempts');
      })
      .catch((err) => app.log.error({ err }, 'Attempt sweeper failed'));
  }, env.ATTEMPT_SWEEP_INTERVAL_MS);
  sweeper.unref();

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully…`);
    try {
      clearInterval(sweeper);
      await worker?.stop();   // releases an in-flight generation job for resumption
      await app.close();      // stop accepting new connections
      await pool.end();       // drain pg pool
      app.log.info('Server and database pool closed. Goodbye.');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
