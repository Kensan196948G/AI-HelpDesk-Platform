import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./assist-bridge.js', import.meta.url), 'utf8');

interface SyncedCase {
  id?: string;
  step?: number;
  handoverStatus?: string;
  handoverApprovedAt?: string;
  handoverApprovedBy?: string;
  handoverSelfApproved?: boolean;
  handoverClaimedBy?: string;
  handoverSyncedAt?: string;
}

interface HandoverInfo {
  status?: string;
  approvedAt?: string;
  approvedBy?: string;
  selfApproved?: boolean;
  claimedByName?: string;
}

interface LinkResult {
  chat?: unknown;
  tkt?: unknown;
  inc?: Record<string, unknown> | null;
  dr?: unknown;
  kb?: unknown;
}

interface AssistBridge {
  version: number;
  rspDeepLink: (c: unknown) => string;
  applyHandoverStatus: (c: SyncedCase, handover: HandoverInfo) => boolean;
  linkWithHandover: (c: SyncedCase, L: LinkResult) => LinkResult;
  buildServerDraftBody: (input: Record<string, unknown>) => Record<string, unknown>;
  serverDraftSectionHtml: (items: Array<Record<string, unknown>>, errorCode?: string) => string;
  shouldFallbackToLocal: (status?: number) => boolean;
  serverDraftErrorLabel: (error: unknown) => string;
}

interface SandboxWindow {
  __AIHD_BOOT__?: Record<string, unknown>;
  __AIHD_ASSIST_BRIDGE__?: AssistBridge;
}

function loadBridge(boot: Record<string, unknown>, pcVisible: () => boolean): AssistBridge {
  const window: SandboxWindow = { __AIHD_BOOT__: boot };
  const sandbox: Record<string, unknown> = {
    window,
    console,
    pcVisible,
    // ブリッジは読み込み時にグローバルの ACT（画面のアクション表）へ
    // ハンドラを足し、document の状態を見て初期化する。URL 生成の検証には
    // 画面が無くても足りるので、最小限の差し替えだけを渡す。
    ACT: { wConsent: () => {} },
    document: { readyState: 'loading', addEventListener: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const bridge = window.__AIHD_ASSIST_BRIDGE__;
  if (!bridge) throw new Error('assist-bridge が初期化されませんでした');
  return bridge;
}

const RSP = 'https://rsp.example.com';

describe('assist-bridge: RSP ディープリンク (Phase 3)', () => {
  it('案件IDと共有済み端末を付けて RSP を開く', () => {
    const bridge = loadBridge({ rspBaseUrl: `${RSP}/` }, () => true);
    const url = bridge.rspDeepLink({
      id: 'CASE-UI-TERM-3',
      pc: { state: 'done', snap: { device: 'MRK-NB-1000' } },
    });
    expect(url).toBe(`${RSP}/?helpdeskCase=CASE-UI-TERM-3&hostname=MRK-NB-1000`);
  });

  it('日本語や空白を含む値は URL エンコードする', () => {
    const bridge = loadBridge({ rspBaseUrl: RSP }, () => true);
    const url = bridge.rspDeepLink({
      id: '案件 001',
      pc: { state: 'done', snap: { device: '現場 PC-A' } },
    });
    expect(url).toBe(
      `${RSP}/?helpdeskCase=${encodeURIComponent('案件 001')}&hostname=${encodeURIComponent('現場 PC-A')}`,
    );
  });

  it('PC 情報が共有されていない場合は hostname を付けない（推測・漏えい防止）', () => {
    const bridge = loadBridge({ rspBaseUrl: RSP }, () => false);
    const url = bridge.rspDeepLink({
      id: 'CASE-1',
      pc: { state: 'done', snap: { device: 'MRK-NB-1000' } },
    });
    expect(url).toBe(`${RSP}/?helpdeskCase=CASE-1`);
    expect(url).not.toContain('hostname');
  });

  it('PC 情報が未取得の場合は hostname を付けない', () => {
    const bridge = loadBridge({ rspBaseUrl: RSP }, () => true);
    const url = bridge.rspDeepLink({ id: 'CASE-1', pc: { state: 'running' } });
    expect(url).toBe(`${RSP}/?helpdeskCase=CASE-1`);
  });

  it('案件IDが無い場合は RSP のトップを開く', () => {
    const bridge = loadBridge({ rspBaseUrl: `${RSP}///` }, () => true);
    expect(bridge.rspDeepLink({})).toBe(`${RSP}/`);
  });

  it('rspBaseUrl の末尾スラッシュを重複させない', () => {
    const bridge = loadBridge({ rspBaseUrl: `${RSP}/` }, () => true);
    expect(bridge.rspDeepLink({ id: 'CASE-1' })).toBe(`${RSP}/?helpdeskCase=CASE-1`);
  });

  it('rspBaseUrl 未設定でも既定の RSP を指す', () => {
    const bridge = loadBridge({}, () => true);
    expect(bridge.rspDeepLink({ id: 'CASE-1' })).toBe(
      'https://rsp.mirai-remotetools.com/?helpdeskCase=CASE-1',
    );
  });
});

describe('assist-bridge: 依頼者側の引継ぎ状態反映 (F-13)', () => {
  const bridge = () => loadBridge({}, () => true);

  it('completed は案件を STEP7（完了）へ進め、承認情報を保存する', () => {
    const b = bridge();
    const c: SyncedCase = { id: 'CASE-1', step: 4 };
    const changed = b.applyHandoverStatus(c, {
      status: 'completed',
      approvedAt: '2026-10-27T03:00:00.000Z',
      approvedBy: 'dx@example.com',
      selfApproved: true,
      claimedByName: 'dx@example.com',
    });
    expect(changed).toBe(true);
    expect(c.step).toBe(7);
    expect(c.handoverStatus).toBe('completed');
    expect(c.handoverApprovedAt).toBe('2026-10-27T03:00:00.000Z');
    expect(c.handoverApprovedBy).toBe('dx@example.com');
    expect(c.handoverSelfApproved).toBe(true);
    expect(c.handoverClaimedBy).toBe('dx@example.com');
  });

  it('claimed / resolved は STEP5（対応中）へ進める', () => {
    const b = bridge();
    const claimed: SyncedCase = { id: 'CASE-2', step: 4 };
    expect(b.applyHandoverStatus(claimed, { status: 'claimed' })).toBe(true);
    expect(claimed.step).toBe(5);
    const resolved: SyncedCase = { id: 'CASE-3', step: 4 };
    expect(b.applyHandoverStatus(resolved, { status: 'resolved' })).toBe(true);
    expect(resolved.step).toBe(5);
  });

  it('同じ状態なら変更なし（changed=false）。未知の状態は無視する', () => {
    const b = bridge();
    const c: SyncedCase = { id: 'CASE-4', step: 4, handoverStatus: 'completed' };
    expect(b.applyHandoverStatus(c, { status: 'completed' })).toBe(false);
    const d: SyncedCase = { id: 'CASE-5', step: 4 };
    expect(b.applyHandoverStatus(d, { status: 'cancelled' })).toBe(false);
    expect(d.step).toBe(4);
  });

  it('link() の結果に completed を重ねると、既存の stage 判定が「完了」になる', () => {
    const b = bridge();
    const c: SyncedCase = { id: 'CASE-6', step: 7, handoverStatus: 'completed' };
    const L: LinkResult = { chat: null, tkt: { id: 'TKT-1' }, inc: null, dr: null, kb: null };
    const merged = b.linkWithHandover(c, L);
    expect(merged.inc?.status).toBe('resolved');
    expect(merged.inc?.draftId).toBe('');
    expect(merged.inc?.kbId).toBe('');
    const resolution = merged.inc?.resolution as { cause?: string } | undefined;
    expect(resolution?.cause).toContain('DX推進部');
    // 既存のチャット・チケット参照は壊さない。
    expect(merged.tkt).toBe(L.tkt);
    expect(merged.chat).toBeNull();
  });

  it('link() の結果に claimed を重ねると「対応中」になる', () => {
    const b = bridge();
    const c: SyncedCase = {
      id: 'CASE-7',
      handoverStatus: 'claimed',
      handoverClaimedBy: 'dx@example.com',
    };
    const L: LinkResult = { chat: null, tkt: { id: 'TKT-1' }, inc: null, dr: null, kb: null };
    const merged = b.linkWithHandover(c, L);
    expect(merged.inc?.status).toBe('in_progress');
    expect(merged.inc?.assignee).toBe('dx@example.com');
  });

  it('同期状態が無い案件は link() の結果をそのまま返す', () => {
    const b = bridge();
    const L: LinkResult = { chat: null, tkt: { id: 'TKT-1' }, inc: null, dr: null, kb: null };
    expect(b.linkWithHandover({ id: 'CASE-8' }, L)).toBe(L);
  });
});

describe('assist-bridge: F-06 サーバ下書き（作成・承認者ビュー・却下）', () => {
  const bridge = () => loadBridge({}, () => true);

  it('POST /api/knowledge/drafts の body を契約どおり組み立てる（空の任意項目は送らない）', () => {
    const b = bridge();
    const body = b.buildServerDraftBody({
      caseId: 'INC-1008',
      title: '共有フォルダが開けないときの対処',
      symptom: 'アクセスできない',
      cause: '権限なし',
      steps: ['権限を確認する', '追加する'],
      keywords: ['共有', ''],
      handoverId: '',
    });
    expect(body).toEqual({
      caseId: 'INC-1008',
      title: '共有フォルダが開けないときの対処',
      symptom: 'アクセスできない',
      cause: '権限なし',
      steps: ['権限を確認する', '追加する'],
      keywords: ['共有'],
    });
    const withHandover = b.buildServerDraftBody({
      caseId: 'INC-1',
      title: 't',
      symptom: 's',
      cause: 'c',
      steps: [],
      handoverId: 'handover-1',
    });
    expect(withHandover.handoverId).toBe('handover-1');
    expect('keywords' in withHandover).toBe(false);
  });

  it('サーバ未設定・一時障害（0/404/405/501/5xx）だけローカル動作へフォールバックする', () => {
    const b = bridge();
    for (const status of [undefined, 0, 404, 405, 501, 500, 503]) {
      expect(b.shouldFallbackToLocal(status), String(status)).toBe(true);
    }
    for (const status of [400, 403, 409, 422]) {
      expect(b.shouldFallbackToLocal(status), String(status)).toBe(false);
    }
  });

  it('サーバのエラーコードをトースト用ラベルとして優先する', () => {
    const b = bridge();
    expect(b.serverDraftErrorLabel({ code: 'SELF_APPROVAL_FORBIDDEN', status: 403 })).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    expect(b.serverDraftErrorLabel({ status: 500 })).toBe('HTTP 500');
    expect(b.serverDraftErrorLabel(new Error('network'))).toBe('network');
  });

  it('承認者ビュー: サーバ下書きと分かる表示・HTMLエスケープ・チェック4件・承認/却下', () => {
    const b = bridge();
    const html = b.serverDraftSectionHtml(
      [
        {
          id: 'draft-1',
          kbNo: 'KB-2026-0001',
          caseId: 'CASE-1',
          title: '<script>alert(1)</script>',
          status: 'review',
          authorEmail: 'author@example.com',
          handoverId: 'handover-1',
          createdAt: '2026-10-27T00:00:00.000Z',
        },
      ],
      '',
    );
    expect(html).toContain('サーバ下書き');
    expect(html).toContain('KB-2026-0001');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('data-ahd="sd-approve"');
    expect(html).toContain('data-ahd="sd-reject"');
    expect((html.match(/data-sd-check=/g) ?? []).length).toBe(4);
  });

  it('承認済みは操作を出さずKB番号を表示、空一覧/取得失敗は案内を表示する', () => {
    const b = bridge();
    const approved = b.serverDraftSectionHtml(
      [{ id: 'draft-2', kbNo: 'KB-2026-0009', title: 't', status: 'approved' }],
      '',
    );
    expect(approved).toContain('承認済み');
    expect(approved).toContain('KB-2026-0009');
    expect(approved).not.toContain('data-sd-check=');
    expect(approved).not.toContain('data-ahd="sd-approve"');

    const empty = b.serverDraftSectionHtml([], 'HTTP 404');
    expect(empty).toContain('サーバの承認待ちはありません');
    expect(empty).toContain('取得できませんでした');
  });
});
