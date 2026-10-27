import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';
import { hashSessionToken } from './password.js';
import { loadUserRoles, validateRoleSet } from './roles.js';
import { assertNotAuditorWrite } from './session.js';
import type { AuthUser } from './types.js';

const PREFIX = 'role-test-';
const auditorEmail = `${PREFIX}auditor@example.com`;
const approverEmail = `${PREFIX}approver@example.com`;
const multiEmail = `${PREFIX}multi@example.com`;
const requesterEmail = `${PREFIX}requester@example.com`;
const auditorToken = `role-test-auditor-${randomUUID()}`;
const approverToken = `role-test-approver-${randomUUID()}`;
const multiToken = `role-test-multi-${randomUUID()}`;
const requesterToken = `role-test-requester-${randomUUID()}`;

let app: FastifyInstance;

async function createUser(email: string, role: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${email}, ${role}, 'x')
    RETURNING id
  `;
  return rows[0]!.id;
}

async function grantRoles(userId: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    await sql`
      INSERT INTO user_roles (user_id, role, source)
      VALUES (${userId}, ${role}, 'sync')
      ON CONFLICT (user_id, role) DO NOTHING
    `;
  }
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
  // 複数ロール: 主ロールは requester だが、user_roles で helpdesk + approver を持つ。
  // 主ロールではなく user_roles が正本であることを確かめる。
  const multiId = await createUser(multiEmail, 'requester');
  await grantRoles(multiId, ['helpdesk', 'approver']);
  const requesterId = await createUser(requesterEmail, 'requester');
  await createSession(auditorId, auditorToken);
  await createSession(approverId, approverToken);
  await createSession(multiId, multiToken);
  await createSession(requesterId, requesterToken);
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

describe('複数ロール（docs/49）', () => {
  it('validateRoleSet: auditor の併存・空・不明ロールを拒否する', () => {
    expect(validateRoleSet(['helpdesk', 'approver'])).toBeNull();
    expect(validateRoleSet(['auditor'])).toBeNull();
    expect(validateRoleSet(['auditor', 'helpdesk'])).toContain('併存できません');
    expect(validateRoleSet([])).toContain('1つ以上');
    expect(validateRoleSet(['helpdesk', 'nope'])).toContain('不明なロール');
  });

  it('user_roles が主ロールより優先される（requester 主 + helpdesk/approver）', async () => {
    // 主ロール（users.role=requester）だけなら 403 になる経路を、user_roles で 200 にできる。
    const queue = await app.inject({
      method: 'GET',
      url: '/api/desk/queue',
      cookies: { aihd_session: multiToken },
    });
    expect(queue.statusCode, queue.body).toBe(200);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit',
      cookies: { aihd_session: multiToken },
    });
    expect(audit.statusCode, audit.body).toBe(200);

    const multiId = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${multiEmail} LIMIT 1
    `;
    const roles = await loadUserRoles(multiId[0]!.id, 'requester');
    expect(roles.sort()).toEqual(['approver', 'helpdesk']);
  });

  it('user_roles が空なら主ロールへフォールバックする', async () => {
    // requester は helpdesk 権限の経路（/api/desk/queue）を呼べない。
    const res = await app.inject({
      method: 'GET',
      url: '/api/desk/queue',
      cookies: { aihd_session: requesterToken },
    });
    expect(res.statusCode, res.body).toBe(403);

    const requesterId = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${requesterEmail} LIMIT 1
    `;
    const roles = await loadUserRoles(requesterId[0]!.id, 'requester');
    expect(roles).toEqual(['requester']);
  });
});
