import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { actorRoleLabel, MIGRATION_BANNER } from './ops.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('運用統合 UI（/ops）の配信', () => {
  it('画面を CSP とブート付きで配信する', async () => {
    const response = await app.inject({ method: 'GET', url: '/ops' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(String(response.headers['content-security-policy'])).toContain(
      "connect-src 'self' https://cloudflareinsights.com",
    );
    expect(response.headers['cache-control']).toBe('no-store');

    const html = response.body;
    // 配信する画面そのもの（旧 UI とは別のファイル）。
    expect(html).toContain('<title>AIヘルプデスク 運用統合</title>');
    expect(html).toContain('window.__OPS_BOOT__');
    // 移行中であることを画面に明示する（AGENTS.md §5）。
    expect(html).toContain(MIGRATION_BANNER);
    expect(html).toContain('移行中');
    // 旧画面のブートは混ざらない。
    expect(html).not.toContain('window.__AIHD_BOOT__');
  });

  it('操作者は Access の本人（モックのログイン画面を使わない）', async () => {
    const response = await app.inject({ method: 'GET', url: '/ops' });
    const boot = /window\.__OPS_BOOT__=(\{.*?\});<\/script>/s.exec(response.body)?.[1];
    expect(boot).toBeTruthy();
    const parsed = JSON.parse(boot as string) as {
      actor: { name: string; role: string; approver: boolean; email: string };
      authMode: string;
      banner: string;
    };
    expect(parsed.actor.name.length).toBeGreaterThan(0);
    expect(parsed.actor.email).toContain('@');
    expect(typeof parsed.actor.approver).toBe('boolean');
    expect(parsed.actor.role.length).toBeGreaterThan(0);
    // 認証方式はサーバが渡す（画面から推測しない）。
    expect(parsed.authMode).toMatch(/^(local|cloudflare-access)$/);
  });

  it('受付済みチケットを実 DB から初期状態として渡す（P2）', async () => {
    const response = await app.inject({ method: 'GET', url: '/ops' });
    const boot = /window\.__OPS_BOOT__=(\{.*?\});<\/script>/s.exec(response.body)?.[1];
    const parsed = JSON.parse(boot as string) as {
      state: { tickets: unknown[] };
      server: boolean;
    };
    expect(parsed.server).toBe(true);
    expect(Array.isArray(parsed.state.tickets)).toBe(true);
    expect(Array.isArray((parsed.state as { remote?: unknown[] }).remote)).toBe(true);
  });
});

describe('旧 UI の残置（P7）', () => {
  it('/legacy は旧 UI を配信する', async () => {
    const response = await app.inject({ method: 'GET', url: '/legacy' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('window.__AIHD_BOOT__');
    expect(response.body).toContain('<title>みらいAI窓口 × ヘルプデスク ステップ受付 V3.1');
  });

  it('既定では / は旧 UI のまま（切替は OPS_UI_PRIMARY）', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('window.__AIHD_BOOT__');
  });
});

describe('操作者の肩書き（表示用）', () => {
  it('ロール集合から 1 つの肩書きを決める', () => {
    expect(actorRoleLabel(['approver', 'helpdesk'])).toBe('ナレッジ承認者');
    expect(actorRoleLabel(['helpdesk'])).toBe('ヘルプデスク担当');
    expect(actorRoleLabel(['auditor'])).toBe('監査担当者');
    expect(actorRoleLabel([])).toBe('一般社員');
  });
});
