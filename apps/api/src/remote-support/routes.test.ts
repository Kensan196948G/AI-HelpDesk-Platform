import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

const REQUESTER = 'rs-requester@example.com';
const HELPDESK = 'sato@example.com';
const CASE_ID = 'CASE-REMOTE-TEST';
const DEVICE = 'WEB-RSTEST01';
const RSP_DEVICE = '11111111-1111-4111-8111-111111111111';

let app: FastifyInstance;
let originalDevEmail: string;
let originalRspKey: string | undefined;
let sessionId: string;
let fetchMock: ReturnType<typeof vi.fn>;

function rspResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  };
}

async function get(url: string) {
  return app.inject({ method: 'GET', url });
}

async function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, payload });
}

beforeAll(async () => {
  originalDevEmail = config.DEV_AUTH_EMAIL;
  originalRspKey = config.RSP_SERVICE_KEY;
  config.RSP_SERVICE_KEY = 'test-service-key-0123456789abcdef0123456789abcdef';
  app = await buildServer({ logger: false });
  await app.ready();

  await sql`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${REQUESTER}, 'Remote Requester', 'requester', 'x')
    ON CONFLICT (lower(email)) DO NOTHING
  `;
  await sql`DELETE FROM mesh_install_requests WHERE case_id = ${CASE_ID}`;
  await sql`DELETE FROM device_mesh_links WHERE device_id = ${DEVICE}`;
  await sql`DELETE FROM resolution_sessions WHERE case_id = ${CASE_ID}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO resolution_sessions (user_email, case_id, device_id, status, step_count, expires_at)
    VALUES (${REQUESTER}, ${CASE_ID}, ${DEVICE}, 'escalated', 1, now() + interval '30 minutes')
    RETURNING id
  `;
  sessionId = rows[0]!.id;
});

beforeEach(async () => {
  resetRateLimits();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // 前のテストが残したリンク・導入要求を消して独立させる。
  await sql`DELETE FROM mesh_install_requests WHERE case_id = ${CASE_ID}`;
  await sql`DELETE FROM device_mesh_links WHERE device_id = ${DEVICE}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await sql`DELETE FROM mesh_install_requests WHERE case_id = ${CASE_ID}`;
  await sql`DELETE FROM device_mesh_links WHERE device_id = ${DEVICE}`;
  await sql`DELETE FROM resolution_sessions WHERE case_id = ${CASE_ID}`;
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.RSP_SERVICE_KEY = originalRspKey;
  await app.close();
});

describe('POST /api/remote-support', () => {
  it('担当者以外は 403', async () => {
    config.DEV_AUTH_EMAIL = REQUESTER;
    const response = await get(`/api/remote-support/session?caseId=${CASE_ID}`);
    expect(response.statusCode).toBe(403);
  });

  it('担当者は escalated セッションのコンテキストを取得できる', async () => {
    config.DEV_AUTH_EMAIL = HELPDESK;
    const response = await get(`/api/remote-support/session?caseId=${CASE_ID}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.session.id).toBe(sessionId);
    expect(body.link).toBeNull();
  });

  it('hostname 検索 → リンク保存 → 導入依頼 まで通る', async () => {
    config.DEV_AUTH_EMAIL = HELPDESK;
    fetchMock
      .mockResolvedValueOnce(
        rspResponse({
          count: 1,
          matches: [
            {
              device_id: RSP_DEVICE,
              hostname: '202010001M',
              agent_installed: false,
              agent_online: false,
              mesh_deploy_status: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        rspResponse({
          count: 1,
          matches: [
            {
              device_id: RSP_DEVICE,
              hostname: '202010001M',
              agent_installed: false,
              agent_online: false,
              mesh_deploy_status: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        rspResponse({
          device_id: RSP_DEVICE,
          hostname: '202010001M',
          agent_installed: false,
          agent_online: false,
          mesh_deploy_status: 'deploying',
          triggered_deploy: true,
          retrigger_suppressed: false,
          mesh_node_id: null,
          ping_ok: true,
          winrm_ok: true,
        }),
      );

    const lookup = await post('/api/remote-support/lookup', {
      caseId: CASE_ID,
      hostname: '202010001M',
    });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().matches).toHaveLength(1);

    const link = await post('/api/remote-support/link', {
      caseId: CASE_ID,
      hostname: '202010001M',
      rspDeviceId: RSP_DEVICE,
    });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json().link.hostname).toBe('202010001M');

    const ensure = await post('/api/remote-support/ensure', { caseId: CASE_ID });
    expect(ensure.statusCode, ensure.body).toBe(200);
    expect(ensure.json().install.status).toBe('triggered');

    const rows = await sql<{ status: string }[]>`
      SELECT status FROM mesh_install_requests
      WHERE case_id = ${CASE_ID} AND rsp_device_id = ${RSP_DEVICE}
    `;
    expect(rows[0]?.status).toBe('triggered');
  });

  it('リンク前に導入依頼すると 409', async () => {
    config.DEV_AUTH_EMAIL = HELPDESK;
    const response = await post('/api/remote-support/ensure', { caseId: CASE_ID });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DEVICE_NOT_LINKED');
  });
});
