import { z } from 'zod';
import { BadRequestError } from './errors.js';

/**
 * Parses untrusted request input with a Zod schema, converting failures into a
 * 400 BadRequestError that carries the flattened issues as `details`.
 */
export function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    throw new BadRequestError(
      `Invalid request${where}: ${first?.message ?? 'validation failed'}`,
      'VALIDATION_ERROR',
      result.error.flatten(),
    );
  }
  return result.data;
}

export const uuidParam = z.string().uuid('must be a valid UUID');
