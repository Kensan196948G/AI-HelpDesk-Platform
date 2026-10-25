import { runInNewContext } from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import { patchStateLoad, STATE_DEFAULTS_PATCH } from './prototype.js';

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
    // RSP / MeshCentral の導線（B さんの GUI / PowerShell 操作基盤）
    expect(html).toContain('meshcentralUrl');
    expect(html).toContain('mesh.mirai-remotetools.com');
    expect(html).toContain('DeepSeek-V4.1-Flash');
    // 元の UI の主要な画面要素が残っている
    expect(html).toContain('新しい相談をはじめる');
    expect(html).toContain('信号の色の割合');
    // 古い・欠けた状態で白画面にならないための補完パッチが入っている
    expect(html).toContain(STATE_DEFAULTS_PATCH);
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

describe('保存済み状態の欠落キー補完', () => {
  it('load() の保存値採用行に補完を差し込み、二重適用しない', () => {
    const html = '<script>function load(){if(o&&o.v===31){S=o}}</script>';
    const once = patchStateLoad(html);
    expect(once).not.toBe(html);
    expect(once).toContain(STATE_DEFAULTS_PATCH);
    expect(once).not.toContain('{S=o}');
    expect(patchStateLoad(once)).toBe(once);
    // 対象行が無い HTML は変更しない（将来の画面更新で壊さない）
    const other = '<script>const x = 1;</script>';
    expect(patchStateLoad(other)).toBe(other);
  });

  it('一部キーだけの状態に既定値を補い、既存の値は上書きしない', () => {
    const seedDevices = () => ({ 'MRK-NB-1': { id: 'MRK-NB-1', os: 'Windows 11' } });
    const state: Record<string, unknown> = {
      v: 31,
      ui: { user: 'emp:MK0623', screen: 'home' },
      cases: [{ id: 'CASE-1' }],
      chats: [],
      proposals: {},
      tickets: [{ id: 'TKT-1' }],
      audit: [],
      counters: { case: 5 },
    };
    runInNewContext(STATE_DEFAULTS_PATCH, { S: state, seedDevices });

    expect(state.stats).toEqual({ intents: {}, aiResolved: 0, queries: 0 });
    expect(state.faqCandidates).toEqual([]);
    expect(state.faqs).toEqual([]);
    expect(state.estop).toBe(false);
    expect(state.failNext).toBe(false);
    expect(state.devices).toEqual({ 'MRK-NB-1': { id: 'MRK-NB-1', os: 'Windows 11' } });
    // 既存のデータは失わない
    expect(state.cases).toEqual([{ id: 'CASE-1' }]);
    expect((state.tickets as unknown[]).length).toBe(1);
    // 欠けている入れ子のキーだけを補う
    const ui = state.ui as Record<string, unknown>;
    expect(ui.user).toBe('emp:MK0623');
    expect(ui.theme).toBe('auto');
    const counters = state.counters as Record<string, unknown>;
    expect(counters.case).toBe(5);
    expect(counters.ticket).toBe(0);
  });

  it('S が無い・seedDevices が無い場合でも例外にしない', () => {
    expect(() => runInNewContext(STATE_DEFAULTS_PATCH, {})).not.toThrow();
    const state: Record<string, unknown> = { v: 31, chats: [] };
    expect(() => runInNewContext(STATE_DEFAULTS_PATCH, { S: state })).not.toThrow();
    expect(state.devices).toEqual({});
  });
});
