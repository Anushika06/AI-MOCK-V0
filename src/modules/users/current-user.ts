import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';

/**
 * The app has no sign-in: it is a single-user application. Every request acts as
 * one built-in local user, created on first use, who owns all mocks, attempts,
 * flags and seen-question history.
 */

export interface AppUser {
  id: string;
  name: string | null;
}

/** Fixed identity of the local user. */
export const LOCAL_USER_EMAIL = 'local-user@supertet.local';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireUser. */
    appUser: AppUser | null;
  }
}

let localUserPromise: Promise<AppUser> | null = null;

export function localUser(): Promise<AppUser> {
  localUserPromise ??= (async () => {
    await db.insert(users).values({ name: 'You', email: LOCAL_USER_EMAIL }).onConflictDoNothing({ target: users.email });
    const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, LOCAL_USER_EMAIL)).limit(1);
    return user;
  })().catch((error) => {
    localUserPromise = null; // retry on the next request (e.g. database was down)
    throw error;
  });
  return localUserPromise;
}

/** preHandler hook: attaches the local user to the request. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  request.appUser = await localUser();
}

/** The acting user; only call from routes guarded by requireUser. */
export function currentUser(request: FastifyRequest): AppUser {
  if (!request.appUser) throw new Error('requireUser preHandler missing on this route');
  return request.appUser;
}
