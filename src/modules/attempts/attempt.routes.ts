import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput, uuidParam } from '../../common/validation.js';
import { currentUser, requireUser } from '../users/current-user.js';
import { attemptService, practiceSchema, saveAnswersSchema } from './attempt.service.js';

const attemptParams = z.object({ attemptId: uuidParam });

/** Mounted at /api/attempts. Every route requires authentication and ownership. */
export async function attemptRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Attempt history.
  app.get('/', async (request) => {
    return { attempts: await attemptService.listAttempts(currentUser(request).id) };
  });

  // Exam payload (questions without answers + saved selections); safe to call on refresh.
  app.get('/:attemptId', async (request) => {
    const { attemptId } = parseInput(attemptParams, request.params);
    return attemptService.getAttemptForExam(currentUser(request).id, attemptId);
  });

  // Save one or more answers (selectedOption null clears). Rejected after the deadline.
  app.put('/:attemptId/answers', async (request) => {
    const { attemptId } = parseInput(attemptParams, request.params);
    const input = parseInput(saveAnswersSchema, request.body);
    return attemptService.saveAnswers(currentUser(request).id, attemptId, input);
  });

  // Submit (idempotent). The server decides SUBMITTED vs AUTO_SUBMITTED.
  app.post('/:attemptId/submit', async (request) => {
    const { attemptId } = parseInput(attemptParams, request.params);
    return attemptService.submitAttempt(currentUser(request).id, attemptId);
  });

  // Create (once) a practice set from this attempt's mistakes; idempotent.
  app.post('/:attemptId/practice', async (request, reply) => {
    const { attemptId } = parseInput(attemptParams, request.params);
    const input = parseInput(practiceSchema, request.body ?? {});
    const result = await attemptService.createPracticeSet(currentUser(request).id, attemptId, input);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  // Score, breakdown and question-wise review. Only after submission.
  app.get('/:attemptId/result', async (request) => {
    const { attemptId } = parseInput(attemptParams, request.params);
    return attemptService.getResult(currentUser(request).id, attemptId);
  });
}
