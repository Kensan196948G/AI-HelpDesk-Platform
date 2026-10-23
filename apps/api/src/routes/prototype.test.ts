import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('prototype UI integration', () => {
  it('元の HTML を CSP / boot / bridge 付きで配信する', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    const html = response.body;
    expect(html).toContain('<title>みらいAI窓口 × ヘルプデスク ステップ受付 V3.1');
    expect(html).toContain('window.__AIHD_BOOT__');
    expect(html).toContain('DeepSeek API');
    expect(html).toContain('__AIHD_SYNC_DEBUG__');
    // 元の UI の主要な画面要素が残っている
    expect(html).toContain('新しい相談をはじめる');
    expect(html).toContain('信号の色の割合');
  });

  it('UI 状態を PostgreSQL に保存・取得できる', async () => {
    const probe = `probe-${Date.now()}`;
    const put = await app.inject({
      method: 'PUT',
      url: '/api/state/cowork',
      payload: { data: { v: 31, probe } },
    });
    expect(put.statusCode, put.body).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/state' });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.cowork.v).toBe(31);
    expect(body.cowork.probe).toBe(probe);
  });

  it('DeepSeek 未設定時は承認済みナレッジのフォールバックを返す', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/answer',
      payload: { text: '共有フォルダが開けません' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.provider).toBe('fallback');
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources[0].kbNo).toMatch(/^KB-/);
  });
});
