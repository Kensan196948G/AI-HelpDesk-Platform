import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';
import { hashSessionToken } from './password.js';
import { assertNotAuditorWrite } from './session.js';
import type { AuthUser } from './types.js';

const PREFIX = 'role-test-';
const auditorEmail = `${PREFIX}auditor@example.com`;
const approverEmail = `${PREFIX}approver@example.com`;
const auditorToken = `role-test-auditor-${randomUUID()}`;
const approverToken = `role-test-approver-${randomUUID()}`;

let app: FastifyInstance;

async function createUser(email: string, role: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${email}, ${role}, 'x')
    RETURNING id
  `;
  return rows[0]!.id;
}

async function createSession(userId: string, token: string): Promise<void> {
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashSessionToken(token, config.SESSION_SECRET)}, now() + interval '1 hour')
  `;
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
  await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  const auditorId = await createUser(auditorEmail, 'auditor');
  const approverId = await createUser(approverEmail, 'approver');
  await createSession(auditorId, auditorToken);
  await createSession(approverId, approverToken);
});

afterAll(async () => {
  await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  await app.close();
});

describe('監査ロールの読み取り専用（docs/43 Phase B）', () => {
  it('assertNotAuditorWrite: 監査の書込みは 403、GET と監査検証・ログアウトは許可', () => {
    const auditor = { role: 'auditor' } as AuthUser;
    const req = (method: string, url: string) => ({ method, url }) as never;
    expect(() => assertNotAuditorWrite(auditor, req('GET', '/api/audit'))).not.toThrow();
    expect(() => assertNotAuditorWrite(auditor, req('HEAD', '/api/audit'))).not.toThrow();
    expect(() => assertNotAuditorWrite(auditor, req('POST', '/api/audit/verify'))).not.toThrow();
    expect(() => assertNotAuditorWrite(auditor, req('POST', '/api/auth/logout'))).not.toThrow();
    expect(() => assertNotAuditorWrite(auditor, req('POST', '/api/knowledge/x/review'))).toThrow(
      /監査ロールは閲覧のみ/,
    );
    expect(() => assertNotAuditorWrite(auditor, req('DELETE', '/api/state'))).toThrow();
    // 監査以外のロールは影響を受けない。
    const helpdesk = { role: 'helpdesk' } as AuthUser;
    expect(() =>
      assertNotAuditorWrite(helpdesk, req('POST', '/api/knowledge/x/review')),
    ).not.toThrow();
  });

  it('auditor セッションは監査を閲覧できる（GET /api/audit）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      cookies: { aihd_session: auditorToken },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('auditor セッションは書込み API を呼べない（POST）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/11111111-1111-4111-8111-111111111111/review',
      cookies: { aihd_session: auditorToken },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('監査ロールは閲覧のみ');
  });

  it('approver セッションは従来どおり監査を閲覧できる', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      cookies: { aihd_session: approverToken },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
