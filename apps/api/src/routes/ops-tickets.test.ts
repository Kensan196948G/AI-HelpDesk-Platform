import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../db.js';
import { buildServer } from '../server.js';
import { toUiTicket } from './ops-tickets.js';

/**
 * 運用統合 UI の受付チケット（docs/100 P2）。
 * 受付 → 一覧 → 状態更新（引継ぎ）→ 画面の初期状態、までを実 DB で確認する。
 */
let app: FastifyInstance;
const MARK = '【テスト】ops-tickets';

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await sql`DELETE FROM ops_tickets WHERE subject LIKE ${`${MARK}%`}`;
  await app.close();
});

describe('受付チケット API', () => {
  it('受付を作成し、番号と実 ID を返す', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/tickets',
      payload: {
        subject: `${MARK} VPNにつながらない`,
        body: '今朝から社外からVPNに接続できません。',
        category: 'network',
        urgency: '高',
        impact: '個人',
        channel: '電話',
        requester: 'テスト 太郎',
        priority: 'P2',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ticket: { id: string; serverId: string; status: string } };
    expect(body.ticket.id).toMatch(/^OPS-\d{4,}$/);
    expect(body.ticket.serverId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ticket.status).toBe('ai');
  });

  it('一覧に自分の受付が並ぶ', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/tickets' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { scope: string; tickets: { subject: string }[] };
    expect(body.scope).toBe('all');
    expect(body.tickets.some((t) => t.subject.startsWith(MARK))).toBe(true);
  });

  it('引継ぎ（escalated）へ更新でき、監査に残る', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/ops/tickets',
      payload: {
        subject: `${MARK} 印刷できない`,
        body: 'プリンタにジョブが送れません。',
        category: 'device',
      },
    });
    const ticket = (created.json() as { ticket: { serverId: string; id: string } }).ticket;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/ops/tickets/${ticket.serverId}`,
      payload: { status: 'escalated', note: '受入テスト' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { ticket: { status: string } }).ticket.status).toBe('escalated');

    const rows = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE target_id = ${ticket.id} AND action = 'ops.ticket.status'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
  });

  it('引継ぎ後に担当開始・解決記録を登録し、監査に残る（P3）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/ops/tickets',
      payload: {
        subject: `${MARK} Wi-Fiが切れる`,
        body: '会議室でWi-Fiが頻繁に切れます。',
        category: 'network',
      },
    });
    const ticket = (created.json() as { ticket: { serverId: string; id: string } }).ticket;
    await app.inject({
      method: 'PATCH',
      url: `/api/ops/tickets/${ticket.serverId}`,
      payload: { status: 'escalated', note: '引継ぎ' },
    });
    const claim = await app.inject({
      method: 'POST',
      url: `/api/ops/tickets/${ticket.serverId}/claim`,
      payload: { assignee: 'テスト担当' },
    });
    expect(claim.statusCode).toBe(200);
    const claimed = (claim.json() as { ticket: { status: string; assignee: string } }).ticket;
    expect(claimed.status).toBe('in_progress');
    expect(claimed.assignee).toBe('テスト担当');

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/ops/tickets/${ticket.serverId}/resolve`,
      payload: {
        cause: 'アクセスポイントのチャネル干渉',
        steps: ['チャネルを変更', '再接続を確認'],
        minutes: 15,
        note: '再発なし',
      },
    });
    expect(resolve.statusCode).toBe(200);
    const resolved = (
      resolve.json() as {
        ticket: { status: string; resolution: { cause: string; steps: string[]; minutes: number } };
      }
    ).ticket;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution.cause).toBe('アクセスポイントのチャネル干渉');
    expect(resolved.resolution.steps).toHaveLength(2);
    expect(resolved.resolution.minutes).toBe(15);

    // 二重解決は 409。
    const again = await app.inject({
      method: 'POST',
      url: `/api/ops/tickets/${ticket.serverId}/resolve`,
      payload: { cause: '再実行', steps: ['x'] },
    });
    expect(again.statusCode).toBe(409);

    const rows = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE target_id = ${ticket.id} AND action IN ('ops.ticket.claim', 'ops.ticket.resolve')
    `;
    expect(rows.map((r) => r.action).sort()).toEqual(['ops.ticket.claim', 'ops.ticket.resolve']);
  });

  it('AI 一次対応を実行し、回答をチケットへ残す（鍵が無ければフォールバック）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/ops/tickets',
      payload: {
        subject: `${MARK} VPNにつながらない`,
        body: '今朝からVPNに接続できません。再起動は試しました。',
        category: 'network',
      },
    });
    const ticket = (created.json() as { ticket: { serverId: string } }).ticket;
    const ai = await app.inject({
      method: 'POST',
      url: `/api/ops/tickets/${ticket.serverId}/ai`,
    });
    expect(ai.statusCode).toBe(200);
    const body = ai.json() as { answer: string; provider: string };
    expect(body.answer.length).toBeGreaterThan(0);
    expect(['deepseek', 'fallback']).toContain(body.provider);
  });

  it('存在しない ID は 404、AI 用の ID 形式違反は 400', async () => {
    const notFound = await app.inject({
      method: 'PATCH',
      url: '/api/ops/tickets/00000000-0000-4000-8000-000000000000',
      payload: { status: 'escalated' },
    });
    expect(notFound.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/ops/tickets/not-a-uuid',
      payload: { status: 'escalated' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('画面へ渡す形', () => {
  it('画面が使う配列と項目を補う', () => {
    const dto = toUiTicket({
      id: '11111111-1111-4111-8111-111111111111',
      tkt_no: 'OPS-1001',
      requester_email: 'a@example.com',
      requester_name: null,
      requester_label: 'テスト 太郎',
      channel: '電話',
      category: 'network',
      subject: 'VPN',
      body: 'つながらない',
      urgency: '高',
      impact: '個人',
      priority: 'P2',
      signal: 'red',
      status: 'ai',
      ai_answer: null,
      ai_sources: [],
      ai_provider: null,
      ai_model: null,
      created_at: new Date('2026-11-11T00:00:00Z'),
      updated_at: new Date('2026-11-11T00:00:00Z'),
      resolved_at: null,
    });
    expect(dto.id).toBe('OPS-1001');
    expect(dto.requester).toBe('テスト 太郎');
    expect(dto.sec).toBe('high');
    expect(dto.aiLog).toEqual([]);
    expect(dto.history).toEqual([]);
    expect(typeof dto.createdAt).toBe('number');
  });
});
