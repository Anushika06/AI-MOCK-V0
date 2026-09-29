/**
 * GET /api/health — 200 when the database is reachable, 503 otherwise.
 */

import { type FastifyInstance } from 'fastify';
import { checkDatabaseHealth } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    const database = await checkDatabaseHealth();
    return reply.status(database.connected ? 200 : 503).send({
      status: database.connected ? 'ok' : 'degraded',
      database,
      timestamp: new Date().toISOString(),
    });
  });
}
