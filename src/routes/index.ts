/**
 * Route registry. Everything lives under /api; other GET paths serve the web app.
 */

import { type FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { examRoutes } from '../modules/exams/exam.routes.js';
import { mockRoutes } from '../modules/mocks/mock.routes.js';
import { attemptRoutes } from '../modules/attempts/attempt.routes.js';
import { flagRoutes } from '../modules/flags/flag.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(async (api) => {
    await api.register(healthRoutes);
    await api.register(examRoutes, { prefix: '/exams' });
    await api.register(mockRoutes, { prefix: '/mocks' });
    await api.register(attemptRoutes, { prefix: '/attempts' });
    await api.register(flagRoutes, { prefix: '/questions' });
  }, { prefix: '/api' });
}
