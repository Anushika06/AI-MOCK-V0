/**
 * Fastify application factory.
 *
 * Returns a configured Fastify instance WITHOUT starting it.
 * This separation makes it easy to test the app without binding to a port.
 * Background services (generation worker, attempt sweeper) are started by
 * server.ts, never here, so tests stay deterministic.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { registerRoutes } from './routes/index.js';
import { AppError } from './common/errors.js';

/** Built frontend (web/dist). Served when present so one process hosts the whole app. */
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../web/dist');

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
                colorize: true,
              },
            },
          }
        : {}),
    },
  });

  // @fastify/sensible adds http-errors helpers + reply.notFound() etc.
  await app.register(sensible);

  await app.register(cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((s) => s.trim()) : '*',
    credentials: false,
  });

  // Populated by the requireUser preHandler.
  app.decorateRequest('appUser', null);

  // Register all routes
  await registerRoutes(app);

  const serveWeb = existsSync(resolve(WEB_DIST, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
  }

  // Unknown /api routes → JSON 404; other GETs → SPA index.html (client-side routing).
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api');
    if (serveWeb && request.method === 'GET' && !isApi) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      error: 'NotFoundError',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  // Global error handler — keeps error shape consistent.
  // Fastify types the error parameter as FastifyError (extends Error + statusCode).
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode: number =
      error.statusCode ?? (error.name === 'NotFoundError' ? 404 : 500);

    if (statusCode >= 500) {
      app.log.error({ err: error }, 'Unhandled request error');
    } else {
      app.log.debug({ err: error }, 'Request rejected');
    }

    const message: string =
      env.NODE_ENV === 'production' && statusCode >= 500
        ? 'An internal server error occurred'
        : error.message;

    void reply.status(statusCode).send({
      error: error.name ?? 'InternalServerError',
      message,
      statusCode,
      ...(error instanceof AppError && error.code ? { code: error.code } : {}),
      ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
    });
  });

  return app;
}
