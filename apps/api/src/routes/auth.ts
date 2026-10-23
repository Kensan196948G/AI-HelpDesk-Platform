import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  hashPassword,
  hashSessionToken,
  newSessionToken,
  verifyPassword,
} from '../auth/password.js';
import {
  authenticate,
  clearSessionCookie,
  SESSION_TTL_SECONDS,
  setSessionCookie,
} from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { ApiError, unauthorized } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { userDto } from '../lib/serializers.js';

const LoginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'requester' | 'helpdesk' | 'approver';
  password_hash: string;
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing-only');

const attempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key: string): void {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (current.count >= RATE_LIMIT) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'ログイン試行が多すぎます。しばらく待ってから再試行してください。',
    );
  }
  current.count += 1;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    checkRateLimit(`${request.ip}:${body.email.toLowerCase()}`);

    const rows = await sql<UserRow[]>`
      SELECT id, email, name, role, password_hash
      FROM users
      WHERE lower(email) = lower(${body.email}) AND is_active = true
      LIMIT 1
    `;
    const user = rows[0];
    const passwordOk = verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk) {
      throw unauthorized('メールアドレスまたはパスワードが正しくありません。');
    }

    const token = newSessionToken();
    const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${user.id}, ${tokenHash}, now() + (${SESSION_TTL_SECONDS} * interval '1 second'))
      `;
      await tx`
        DELETE FROM sessions WHERE expires_at <= now()
      `;
      await tx`
        DELETE FROM sessions
        WHERE user_id = ${user.id}
          AND id NOT IN (
            SELECT id FROM sessions WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 10
          )
      `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        detail: { role: user.role },
      });
    });

    setSessionCookie(reply, token);
    return {
      user: userDto(user),
      expiresInSeconds: SESSION_TTL_SECONDS,
    };
  });

  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const user = request.authUser;
    const tokenHash = request.sessionTokenHash;
    if (user && tokenHash) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
        await appendAudit(tx, {
          actorId: user.id,
          action: 'auth.logout',
          targetType: 'user',
          targetId: user.id,
          detail: {},
        });
      });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    if (!request.authUser) throw unauthorized();
    return { user: userDto(request.authUser) };
  });
}
