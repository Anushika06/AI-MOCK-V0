import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput, uuidParam } from '../../common/validation.js';
import { currentUser, requireUser } from '../users/current-user.js';
import { attemptService } from '../attempts/attempt.service.js';
import { createMockSchema, mockService } from './mock.service.js';

const mockParams = z.object({ mockId: uuidParam });

/** Mounted at /api/mocks. Every route requires authentication and ownership. */
export async function mockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Create a mock and queue its generation job.
  app.post('/', async (request, reply) => {
    const input = parseInput(createMockSchema, request.body ?? {});
    const mock = await mockService.createMock(currentUser(request).id, input);
    return reply.status(202).send(mock);
  });

  app.get('/', async (request) => {
    return { mocks: await mockService.listMocks(currentUser(request).id) };
  });

  app.get('/:mockId', async (request) => {
    const { mockId } = parseInput(mockParams, request.params);
    return mockService.getMock(currentUser(request).id, mockId);
  });

  app.get('/:mockId/generation', async (request) => {
    const { mockId } = parseInput(mockParams, request.params);
    return mockService.getGenerationStatus(currentUser(request).id, mockId);
  });

  app.post('/:mockId/generation/retry', async (request, reply) => {
    const { mockId } = parseInput(mockParams, request.params);
    const status = await mockService.retryGeneration(currentUser(request).id, mockId);
    return reply.status(202).send(status);
  });

  // Start (or resume) the user's attempt on a READY mock.
  app.post('/:mockId/attempts', async (request, reply) => {
    const { mockId } = parseInput(mockParams, request.params);
    const result = await attemptService.startAttempt(currentUser(request).id, mockId);
    return reply.status(result.resumed ? 200 : 201).send(result);
  });
}
