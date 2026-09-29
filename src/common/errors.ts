/**
 * Typed HTTP-aware application errors.
 *
 * Services throw these; the global Fastify error handler turns them into the
 * standard `{ error, message, statusCode, code?, details? }` response shape.
 * `name` doubles as the `error` field, matching the existing convention
 * (e.g. ExamProfileService throws errors named 'NotFoundError').
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    name: string,
    message: string,
    /** Stable machine-readable code for clients (e.g. ATTEMPT_CLOSED). */
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST', details?: unknown) {
    super(400, 'BadRequestError', message, code, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(404, 'NotFoundError', message, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) {
    super(409, 'ConflictError', message, code, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, code = 'TOO_MANY_REQUESTS') {
    super(429, 'TooManyRequestsError', message, code);
  }
}
