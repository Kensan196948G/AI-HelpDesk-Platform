import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { hashSessionToken } from './password.js';
import type { AuthUser, Role } from './types.js';

export const SESSION_COOKIE = 'aihd_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionRow {
  session_id: string;
  expires_at: Date;
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw unauthorized();

  const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
  const rows = await sql<SessionRow[]>`
    SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > now()
      AND u.is_active = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw unauthorized('セッションの有効期限が切れました。もう一度ログインしてください。');

  const user: AuthUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
  };
  request.authUser = user;
  request.sessionTokenHash = tokenHash;
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest): Promise<void> => {
    await authenticate(request);
    const user = request.authUser;
    if (!user || !roles.includes(user.role)) throw forbidden();
  };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
