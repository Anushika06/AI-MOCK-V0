import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput, uuidParam } from '../../common/validation.js';
import { currentUser, requireUser } from '../users/current-user.js';
import { flagSchema, flagService } from './flag.service.js';

const questionParams = z.object({ questionId: uuidParam });

/** Mounted at /api/questions. */
export async function flagRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Create or update the caller's flag on a question.
  app.put('/:questionId/flag', async (request) => {
    const { questionId } = parseInput(questionParams, request.params);
    const input = parseInput(flagSchema, request.body);
    return { flag: await flagService.upsertFlag(currentUser(request).id, questionId, input) };
  });

  app.delete('/:questionId/flag', async (request) => {
    const { questionId } = parseInput(questionParams, request.params);
    return flagService.removeFlag(currentUser(request).id, questionId);
  });
}
