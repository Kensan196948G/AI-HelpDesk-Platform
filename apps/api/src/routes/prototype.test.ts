import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../lib/rate-limit.js';
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
    expect(html).toContain('__AIHD_DEVICE_DEBUG__');
    // 最終報告書 / 遠隔支援コンソール（assist-bridge.js）
    expect(html).toContain('__AIHD_ASSIST_BRIDGE__');
    expect(html).toContain('最終報告書');
    expect(html).toContain('遠隔支援');
    expect(html).toContain('DeepSeek-V4.1-Flash');
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

  it('画面で承認したナレッジ（helpdesk 状態の active KB）を AI 回答の根拠に使う', async () => {
    const kbNo = `KB-T${Date.now().toString(36)}`;
    const put = await app.inject({
      method: 'PUT',
      url: '/api/state/helpdesk',
      payload: {
        data: {
          kb: [
            {
              id: kbNo,
              title: '測量ソフトのライセンス認証が切れたときの対処',
              symptom: '測量ソフトの起動時にライセンス認証エラーが出る。',
              cause: 'ライセンスサーバーとの通信が途絶えている。',
              steps: ['VPN に接続しているか確認する', 'ライセンスの再認証を実行する'],
              keywords: ['測量ソフト', 'ライセンス認証'],
              status: 'active',
            },
          ],
        },
      },
    });
    expect(put.statusCode, put.body).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/answer',
      payload: { text: '測量ソフトでライセンス認証のエラーが出ます' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.sources.map((source: { kbNo: string }) => source.kbNo)).toContain(kbNo);
    expect(body.answer).toContain(kbNo);
  });

  it('状態に $ を含んでも HTML が壊れず、$$ が縮まない（String.replace の特殊パターン対策）', async () => {
    const probe = "before $' $& $$ $` after";
    const put = await app.inject({
      method: 'PUT',
      url: '/api/state/cowork',
      payload: { data: { v: 31, probe } },
    });
    expect(put.statusCode, put.body).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    const match = response.body.match(/window\.__AIHD_BOOT__=(\{.*?\});\(function/);
    expect(match).not.toBeNull();
    const boot = JSON.parse(match?.[1] ?? '{}');
    expect(boot.cowork.probe).toBe(probe);
    // 置換パターンが展開されると HTML 全体が JS 文字列に入り、サイズが大きく増える
    expect(response.body.split('window.__AIHD_BOOT__=').length).toBe(2);
  });

  it('AI 回答は利用者単位でレート制限する（1 分 20 回）', async () => {
    resetRateLimits();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/answer',
        payload: { text: '共有フォルダが開けません' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    resetRateLimits();
  });
});
