import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, repoRoot } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import {
  ENSURE_CASE_USERS,
  patchCaseUserResolution,
  patchStateLoad,
  STATE_DEFAULTS_PATCH,
} from './prototype.js';

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
    // ヘッダ CSP は同一オリジン API と Cloudflare beacon の両方を許可する。
    // meta CSP と積集合で評価されるため、片方だけでは A-12 の CSP 違反は消えない。
    const headerCsp = String(response.headers['content-security-policy']);
    expect(headerCsp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(headerCsp).toContain("script-src 'unsafe-inline' https://static.cloudflareinsights.com");
    const html = response.body;
    const metaCsp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    expect(metaCsp).toBeTruthy();
    expect(metaCsp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(metaCsp).toContain("script-src 'unsafe-inline' https://static.cloudflareinsights.com");
    expect(html).toContain('<title>みらいAI窓口 × ヘルプデスク ステップ受付 V3.1');
    expect(html).toContain('window.__AIHD_BOOT__');
    expect(html).toContain('DeepSeek API');
    expect(html).toContain('__AIHD_SYNC_DEBUG__');
    expect(html).toContain('__AIHD_DEVICE_DEBUG__');
    // 最終報告書 / 遠隔支援コンソール（assist-bridge.js）
    expect(html).toContain('__AIHD_ASSIST_BRIDGE__');
    // 解決ループ（読み取り診断）のブリッジ
    expect(html).toContain('__AIHD_RESOLVE_BRIDGE__');
    // 引継ぎワークスペース（3ペイン）のブリッジ
    expect(html).toContain('__AIHD_HW_BRIDGE__');
    expect(html).toContain('引継ぎワークスペース');
    expect(html).toContain('解決ループ（読み取り診断）');
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
    // 依頼者以外の「操作する人」でも案件を開ける（名簿解決＋表示フォールバック）
    expect(html).toContain('ensureCaseUsers');
    expect(html).not.toContain('DEPTS[USERS[c.userId].dept].name');
    expect(html).not.toContain('USERS[c.userId].device');
    // 実在社員（TIPS 未定義）でも AI相談の挨拶が落ちない
    expect(html).toContain('(TIPS[u.id]||[]).map(');
    // 引継ぎメモ: 旧カテゴリ名の解決・社員番号→氏名・印刷の記入例優先
    expect(html).toContain(
      "const cat=k=>CATS.find(c=>c.k===k)||CATS.find(c=>c.k===({IT端末:'device'",
    );
    expect(html).toContain('if(!n)return {name:');
    expect(html).toContain('window.__AIHD_EMPLOYEES__.all');
    expect(html).toContain('おすすめの担当：${staff(t.suggest).name}');
    expect(html).toContain("t.cat==='device'&&/印刷|プリンタ|複合機|プリント/.test(s)");
    expect(html).toContain('if(/印刷|プリンタ|複合機|プリント/.test(s))');
    expect(html).toContain('function personLabel(v)');
    expect(html).toContain('esc(personLabel(t.requester))');
    expect(html).toContain('${personLabel(t.requester)}（受付：');
  });

  it('原本 HTML の CSP は厳格なまま（配信時の置換マーカーを壊さない）', () => {
    // 2026-10-28 のインシデント: 原本の `connect-src 'none'` を書き換えたため、
    // 配信時の replace が一致せず同一オリジンの API が全ブロックされた。
    // 許可は「配信時」だけ行い、原本はオフライン用の厳格な CSP を保つ。
    const original = readFileSync(
      path.join(repoRoot, 'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html'),
      'utf8',
    );
    expect(original).toContain("connect-src 'none'");
    expect(original).toContain("script-src 'unsafe-inline'");
    expect(original).not.toContain('cloudflareinsights');
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
    // 画面の「プロンプトを見る」用に、実際に AI へ渡した内容を返す
    expect(body.prompt.system).toContain('一次対応AI');
    expect(body.prompt.user).toContain('共有フォルダ');
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

  it('状態は JSONB オブジェクトとして保存する（二重エンコードしない）', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/state/cowork',
      payload: { data: { v: 31, jsonbProbe: 'object' } },
    });
    expect(put.statusCode, put.body).toBe(200);

    const rows = await sql<{ type: string | null; probe: string | null }[]>`
      SELECT jsonb_typeof(data) AS type, data->>'jsonbProbe' AS probe
      FROM prototype_states
      WHERE user_email = ${config.DEV_AUTH_EMAIL.toLowerCase()} AND name = 'cowork'
    `;
    expect(rows[0]?.type).toBe('object');
    expect(rows[0]?.probe).toBe('object');
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

  it('フォルダ一覧のブリッジは機能フラグが有効なときだけ配信する（docs/62）', async () => {
    const original = config.FOLDER_ACCESS_ENABLED;
    try {
      config.FOLDER_ACCESS_ENABLED = false;
      const off = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(off).not.toContain('__AIHD_FOLDER_ACCESS_BRIDGE__');
      expect(off).not.toContain('folder-access');
      // 既存のブリッジは影響を受けない。
      expect(off).toContain('__AIHD_REMOTE_SUPPORT_BRIDGE__');

      config.FOLDER_ACCESS_ENABLED = true;
      const on = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(on).toContain('__AIHD_FOLDER_ACCESS_BRIDGE__');
      expect(on).toContain('__AIHD_REMOTE_SUPPORT_BRIDGE__');

      config.FOLDER_ACCESS_ENABLED = false;
      const offAgain = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(offAgain).not.toContain('__AIHD_FOLDER_ACCESS_BRIDGE__');
    } finally {
      config.FOLDER_ACCESS_ENABLED = original;
    }
  });

  it('共通支援セッションのブリッジは両方のフラグが有効なときだけ配信する（docs/63）', async () => {
    const folder = config.FOLDER_ACCESS_ENABLED;
    const assist = config.ASSIST_SESSION_ENABLED;
    try {
      config.FOLDER_ACCESS_ENABLED = true;
      config.ASSIST_SESSION_ENABLED = false;
      const off = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(off).not.toContain('__AIHD_SUPPORT_SESSION_BRIDGE__');
      expect(off).toContain('__AIHD_FOLDER_ACCESS_BRIDGE__');

      config.ASSIST_SESSION_ENABLED = true;
      const on = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(on).toContain('__AIHD_SUPPORT_SESSION_BRIDGE__');

      config.FOLDER_ACCESS_ENABLED = false;
      const noFolder = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(noFolder).not.toContain('__AIHD_SUPPORT_SESSION_BRIDGE__');
    } finally {
      config.FOLDER_ACCESS_ENABLED = folder;
      config.ASSIST_SESSION_ENABLED = assist;
    }
  });

  it('依頼者以外の操作でも落ちないよう、依頼者の解決と表示フォールバックを差し込む', () => {
    const html =
      '<script>function renderView(){syncHd();var a=DEPTS[USERS[c.userId].dept].name;var b=USERS[c.userId].device;</script>';
    const once = patchCaseUserResolution(html);
    expect(once).toContain('function ensureCaseUsers(');
    expect(once).toContain('function renderView(){ensureCaseUsers();syncHd();');
    expect(once).not.toContain('DEPTS[USERS[c.userId].dept].name');
    expect(once).not.toContain('USERS[c.userId].device');
    expect(once).toContain("'所属不明'");
    expect(patchCaseUserResolution(once)).toBe(once);
    // 対象コードが無い HTML は変更しない
    expect(patchCaseUserResolution('<div>no marker</div>')).toBe('<div>no marker</div>');
  });

  it('案件の依頼者は emp:MK0200 / emp:staff:MK1073 のどちらでも名簿から解決する', () => {
    const calls: Array<[string, string]> = [];
    const USERS: Record<string, unknown> = {};
    const context = {
      S: {
        cases: [
          { id: 'C1', userId: 'emp:MK0200' },
          { id: 'C2', userId: 'emp:staff:MK1073' },
          { id: 'C3', userId: 'u1' },
        ],
      },
      USERS,
      ensureRealUser: (empNo: string, role: string) => {
        calls.push([empNo, role]);
        const id = `emp:${empNo}`;
        USERS[id] = { employeeNo: empNo };
        return id;
      },
    };
    runInNewContext(`${ENSURE_CASE_USERS};ensureCaseUsers();`, context);
    expect(calls).toEqual([
      ['MK0200', 'employee'],
      ['MK1073', 'staff'],
    ]);
    // 画面が使う ID（emp:staff:MK1073）にも同じ社員を紐づける
    expect(USERS['emp:MK0200']).toBeDefined();
    expect(USERS['emp:staff:MK1073']).toBeDefined();
  });

  it('配信 HTML の cat / staff が旧カテゴリ名と社員番号を解決する', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    const html = response.body;
    const catLine = html.match(/const cat=k=>[^\n]+/)?.[0];
    const staffLine = html.match(/const staff=n=>\{[\s\S]*?\};\n/)?.[0];
    expect(catLine).toBeTruthy();
    expect(staffLine).toBeTruthy();
    const sandbox: Record<string, unknown> = {
      CATS: [
        { k: 'account', label: 'アカウント・認証', team: '高橋' },
        { k: 'mail', label: 'メール・Teams', team: '高橋' },
        { k: 'network', label: 'ネットワーク・VPN', team: '鈴木' },
        { k: 'device', label: 'PC・周辺機器', team: '田中' },
        { k: 'file', label: 'ファイル共有・業務アプリ', team: '田中' },
        { k: 'security', label: 'セキュリティ', team: '伊藤' },
        { k: 'other', label: 'その他', team: '佐藤' },
      ],
      STAFF: [{ name: '田中', role: '端末・業務アプリ' }],
      window: {
        __AIHD_EMPLOYEES__: { all: [{ employeeNo: 'MK1073', name: '佐藤 奨太' }] },
      },
    };
    runInNewContext(
      `${catLine};${staffLine};globalThis.__r={it:cat('IT端末').label,unknown:cat('謎').label,undefinedName:staff(undefined).name,mk:staff('MK1073').name,named:staff('田中').name};`,
      sandbox,
    );
    const r = sandbox.__r as Record<string, string>;
    expect(r.it).toBe('PC・周辺機器');
    expect(r.unknown).toBe('その他');
    expect(r.undefinedName).toBe('（未定）');
    expect(r.mk).toBe('佐藤 奨太');
    expect(r.named).toBe('田中');
  });
});
