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
  pendingApprovePayload: (
    item: Record<string, unknown>,
    checklist: Record<string, boolean>,
    comment: string,
  ) => Record<string, unknown>;
  pendingRejectPayload: (item: Record<string, unknown>, reason: string) => Record<string, unknown>;
  pendingSectionHtml: (items: Array<Record<string, unknown>>, errorCode?: string) => string;
  approvalNoteHtml: (c: SyncedCase) => string;
  handoverApprovalNotice: (
    approved: Record<string, unknown>,
    kb: { published: boolean; aiUsable?: boolean; reason?: string },
  ) => { text: string; tone: string };
  publishKnowledgeAfterHandover: (
    full: Record<string, unknown> | null,
    checklist: Record<string, boolean>,
    comment: string,
  ) => Promise<{ published: boolean; aiUsable?: boolean; reason?: string }>;
}

interface SandboxWindow {
  __AIHD_BOOT__?: Record<string, unknown>;
  __AIHD_ASSIST_BRIDGE__?: AssistBridge;
}

function loadBridge(
  boot: Record<string, unknown>,
  pcVisible: () => boolean,
  extras: Record<string, unknown> = {},
): AssistBridge {
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
    ...extras,
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

describe('assist-bridge: F-06 承認者向けサーバ下書き（別ID承認）', () => {
  const bridge = () => loadBridge({}, () => true);
  const checklist = {
    reproducible: true,
    noSecrets: true,
    noBlame: true,
    scopeClear: true,
  };
  const item = {
    id: 'srv-1',
    clientRef: 'ui-DR-004',
    kbNo: 'KB-2026-0101',
    status: 'pending',
    title: '<b>共有フォルダ</b>の対処',
    symptom: '開けない',
    cause: '権限なし',
    steps: '確認する\n追加する',
    keywords: ['共有', '権限'],
    authorEmail: 'author@example.com',
    createdAt: '2026-10-27T00:00:00.000Z',
  };

  it('承認時は ui-sync の UiSyncSchema に一致する body を作る', () => {
    const b = bridge();
    const body = b.pendingApprovePayload(item, checklist, '');
    expect(body).toEqual({
      clientRef: 'ui-DR-004',
      status: 'approved',
      title: '<b>共有フォルダ</b>の対処',
      symptom: '開けない',
      cause: '権限なし',
      steps: '確認する\n追加する',
      keywords: ['共有', '権限'],
      checklist: {
        reproducible: true,
        noSecrets: true,
        noBlame: true,
        scopeClear: true,
      },
      comment: '',
    });
    // clientRef が欠けている場合は id から補う（server の min(1) 対策）。
    const fallback = b.pendingApprovePayload({ id: 'srv-2', title: 't' }, checklist, '');
    expect(fallback.clientRef).toBe('ui-srv-2');
  });

  it('却下時は status=rejected・理由を comment に載せ、checklist は送らない', () => {
    const b = bridge();
    const body = b.pendingRejectPayload(item, '根拠が不足しています');
    expect(body.status).toBe('rejected');
    expect(body.comment).toBe('根拠が不足しています');
    expect(body.clientRef).toBe('ui-DR-004');
    expect('checklist' in body).toBe(false);
  });

  it('一覧 HTML はエスケープし、4項目チェックと承認/却下ボタン・KB番号・作成者を表示する', () => {
    const b = bridge();
    const html = b.pendingSectionHtml([item], '');
    expect(html).toContain('サーバ下書き');
    expect(html).toContain('KB-2026-0101');
    expect(html).toContain('author@example.com');
    expect(html).toContain('&lt;b&gt;共有フォルダ&lt;/b&gt;の対処');
    expect(html).not.toContain('<b>共有フォルダ</b>');
    expect(html).toContain('data-ahd="pd-approve"');
    expect(html).toContain('data-ahd="pd-reject"');
    expect(html).toContain('data-pd-key="reproducible"');
    expect(html).toContain('data-pd-key="scopeClear"');
    expect((html.match(/data-pd-check=/g) ?? []).length).toBe(4);
    // 4項目ONまで承認ボタンは無効。
    expect(html).toContain('disabled>承認</button>');
  });

  it('取得失敗時は「取得できませんでした」を表示し、空一覧は案内を出す', () => {
    const b = bridge();
    const failed = b.pendingSectionHtml([], 'HTTP 404');
    expect(failed).toContain('取得できませんでした');
    expect(failed).toContain('HTTP 404');
    expect(failed).toContain('サーバの承認待ちはありません');

    const approved = b.pendingSectionHtml([{ ...item, status: 'approved', kbNo: 'KB-1' }], '');
    expect(approved).toContain('承認済み');
    expect(approved).toContain('KB-1');
    expect(approved).not.toContain('data-pd-check=');
    expect(approved).not.toContain('data-ahd="pd-approve"');
  });
});

describe('assist-bridge: 承認情報の常設表示（F-13 追記）', () => {
  const bridge = () => loadBridge({}, () => true);

  it('completed は承認者・承認日時・別ID承認を表示する', () => {
    const html = bridge().approvalNoteHtml({
      id: 'CASE-1',
      step: 7,
      handoverStatus: 'completed',
      handoverApprovedBy: 'dx@example.com',
      handoverApprovedAt: '2026-10-27T03:00:00.000Z',
      handoverSelfApproved: false,
    });
    expect(html).toContain('DX推進部の対応が完了しました');
    expect(html).toContain('承認者: dx@example.com');
    expect(html).toContain('承認日時:');
    expect(html).toContain('別ID承認');
    expect(html).not.toContain('自己承認');
  });

  it('自己承認は「自己承認」と表示する', () => {
    const html = bridge().approvalNoteHtml({
      id: 'CASE-2',
      handoverStatus: 'completed',
      handoverApprovedAt: '2026-10-27T03:00:00.000Z',
      handoverSelfApproved: true,
    });
    expect(html).toContain('自己承認');
    expect(html).not.toContain('別ID承認');
  });

  it('未完了・承認情報なしは何も表示しない', () => {
    const b = bridge();
    expect(b.approvalNoteHtml({ id: 'CASE-3', handoverStatus: 'claimed' })).toBe('');
    expect(b.approvalNoteHtml({ id: 'CASE-4', handoverStatus: 'completed' })).toBe('');
    expect(b.approvalNoteHtml({ id: 'CASE-5' })).toBe('');
  });
});

describe('assist-bridge: 引継ぎの承認と KB 公開を分ける', () => {
  const checklist = { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true };
  const full = { id: 'DR-1', title: '題名', symptom: '症状', cause: '原因', steps: '手順' };

  function withFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const bridge = loadBridge({}, () => false, {
      fetch: async (url: string, options: { body: string }) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify(body), { status });
      },
    });
    return { bridge, calls };
  }

  it('引継ぎの承認後に ui-sync で公開し、サーバーの aiUsable をそのまま返す', async () => {
    const { bridge, calls } = withFetch(200, { aiUsable: true });
    const result = await bridge.publishKnowledgeAfterHandover(full, checklist, 'ok');
    expect(result).toEqual({ published: true, aiUsable: true });
    expect(calls[0]?.url).toBe('/api/knowledge/ui-sync');
    expect(calls[0]?.body).toMatchObject({ clientRef: 'ui-DR-1', status: 'approved', checklist });
  });

  it('公開に失敗しても例外にせず、未公開として返す', async () => {
    const { bridge } = withFetch(409, { error: { code: 'CONFLICT', message: 'x' } });
    await expect(bridge.publishKnowledgeAfterHandover(full, checklist, '')).resolves.toEqual({
      published: false,
      reason: 'CONFLICT',
    });
    await expect(bridge.publishKnowledgeAfterHandover(null, checklist, '')).resolves.toMatchObject({
      published: false,
    });
  });

  it('文言は引継ぎの承認と KB の公開を別々に伝える', () => {
    const { bridge } = withFetch(200, {});
    const approved = { approvedByName: '承認者' };
    expect(bridge.handoverApprovalNotice(approved, { published: true, aiUsable: true })).toEqual({
      text: '引継ぎの完了を承認しました（承認者: 承認者）。ナレッジも公開し、次の相談から AI の根拠に使います。',
      tone: '',
    });
    const selfApproved = bridge.handoverApprovalNotice(approved, {
      published: true,
      aiUsable: false,
    });
    expect(selfApproved.text).toContain('AI の根拠には使いません');
    expect(selfApproved.tone).toBe('bad');
    const failed = bridge.handoverApprovalNotice(approved, {
      published: false,
      reason: 'CONFLICT',
    });
    expect(failed.text).toContain('引継ぎの完了を承認しました');
    expect(failed.text).toContain('ナレッジは公開されていません');
    expect(failed.text).not.toContain('次の相談から');
  });
});
