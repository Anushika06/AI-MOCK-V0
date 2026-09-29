import type { FastifyInstance } from 'fastify';
import { examProfileService } from './exam.service.js';

export async function examRoutes(app: FastifyInstance) {
  // The active exam profile (pattern, sections, marking) for an exam id.
  app.get<{ Params: { examId: string } }>('/:examId', async (request, reply) => {
    try {
      return await examProfileService.getActiveExamProfile(request.params.examId);
    } catch (error: any) {
      if (error.name === 'NotFoundError') return reply.notFound(error.message);
      if (error.name === 'ConfigurationError') return reply.internalServerError(error.message);
      throw error;
    }
  });
}
