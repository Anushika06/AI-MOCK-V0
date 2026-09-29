import { EventEmitter } from 'node:events';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { generationJobs } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { JobExecutionService, JobNotExecutableError, JobReleasedError } from './job.execution.service.js';
import { GenerationRecoveryService, generationRecoveryService } from './generation.recovery.service.js';

/**
 * In-process signal that a new job was queued, so an idle worker starts at once
 * instead of waiting for its next poll. Routes emit; the worker listens.
 * With no worker running (tests), emitting is a no-op.
 */
export const generationEvents = new EventEmitter();
export const JOB_QUEUED_EVENT = 'job-queued';

interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface GenerationWorkerOptions {
  pollIntervalMs?: number;
  staleAfterSeconds?: number;
  logger?: Logger;
  recoveryService?: GenerationRecoveryService;
}

/**
 * Sequential background worker: runs one generation job at a time.
 *
 * Loop: recover stale jobs (periodically) → claim the oldest PENDING job →
 * JobExecutionService.executeJob → repeat. Several processes may run workers
 * safely: claiming is an atomic conditional UPDATE inside executeJob.
 */
export class GenerationWorker {
  private running = false;
  private currentJobId: string | null = null;
  private wakeUp: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private lastRecoveryAt = 0;
  private readonly pollIntervalMs: number;
  private readonly staleAfterSeconds: number;
  private readonly logger: Logger;
  private readonly recoveryService: GenerationRecoveryService;
  private readonly onQueued = () => this.wakeUp?.();

  constructor(
    private readonly executor: JobExecutionService,
    options: GenerationWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? env.GENERATION_POLL_INTERVAL_MS;
    this.staleAfterSeconds = options.staleAfterSeconds ?? env.GENERATION_STALE_AFTER_SECONDS;
    this.logger = options.logger ?? console;
    this.recoveryService = options.recoveryService ?? generationRecoveryService;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    generationEvents.on(JOB_QUEUED_EVENT, this.onQueued);
    this.loopPromise = this._loop();
  }

  /**
   * Stops polling. A job that is mid-flight is released back to PENDING right away
   * so the next process start resumes it without waiting for the stale timeout.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    generationEvents.off(JOB_QUEUED_EVENT, this.onQueued);
    this.wakeUp?.();

    const jobId = this.currentJobId;
    if (jobId) {
      try {
        await this.recoveryService.releaseJob(jobId);
        this.logger.info({ jobId }, 'Released in-flight generation job for resumption');
      } catch (err) {
        this.logger.error({ err, jobId }, 'Failed to release in-flight generation job');
      }
    } else {
      await this.loopPromise;
    }
  }

  private async _loop(): Promise<void> {
    while (this.running) {
      try {
        await this._maybeRecover();
        const jobId = await this._nextPendingJobId();
        if (jobId) {
          await this._run(jobId);
          continue; // look for more work immediately
        }
      } catch (err) {
        this.logger.error({ err }, 'Generation worker iteration failed');
      }
      await this._idle();
    }
  }

  private async _run(jobId: string): Promise<void> {
    this.currentJobId = jobId;
    const started = Date.now();
    this.logger.info({ jobId }, 'Generation job started');
    try {
      await this.executor.executeJob(jobId);
      this.logger.info({ jobId, ms: Date.now() - started }, 'Generation job completed — mock READY');
    } catch (err) {
      if (err instanceof JobNotExecutableError) return; // another worker claimed it
      if (err instanceof JobReleasedError) return; // released (shutdown or recovery)
      if (!this.running) return; // shutting down; job was released
      this.logger.error({ err, jobId }, 'Generation job failed');
    } finally {
      this.currentJobId = null;
    }
  }

  private async _maybeRecover(): Promise<void> {
    const interval = Math.max(this.staleAfterSeconds * 1000 / 2, this.pollIntervalMs);
    if (Date.now() - this.lastRecoveryAt < interval) return;
    this.lastRecoveryAt = Date.now();
    const recovered = await this.recoveryService.recoverStaleJobs(this.staleAfterSeconds);
    if (recovered.length > 0) {
      this.logger.info({ jobIds: recovered }, 'Recovered interrupted generation jobs');
    }
  }

  private async _nextPendingJobId(): Promise<string | null> {
    const [row] = await db
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(eq(generationJobs.status, 'PENDING'))
      .orderBy(asc(generationJobs.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  private _idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.pollIntervalMs);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wakeUp = null;
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
