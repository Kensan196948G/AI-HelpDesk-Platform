import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import { REASON_CODES } from './case-facts.js';
import { SESSION_END_REASONS } from './state.js';

/**
 * 本人パネルの単体テスト（Mock: 最小の DOM と fetch を vm に渡す。実ブラウザではない）。
 */

const source = readFileSync(
  path.join(repoRoot, 'apps/api/src/prototype/support-session-bridge.js'),
  'utf8',
);

class FakeElement {
  children: (FakeElement | { text: string })[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  style = { cssText: '', display: '' };
  id = '';
  value = '';
  disabled = false;
  selected = false;
  checked = false;
  parentNode: FakeElement | null = null;
  constructor(public tag: string) {}
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
  }
  append(...nodes: (FakeElement | { text: string })[]) {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(node: FakeElement) {
    this.append(node);
  }
  get nextSibling() {
    return null;
  }
  className = '';
  replaceChildren(...nodes: (FakeElement | { text: string })[]) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    }
  }
  set innerHTML(_value: string) {
    throw new Error('innerHTML must not be used');
  }
  get text(): string {
    return this.children
      .map((child) => (child instanceof FakeElement ? child.text : child.text))
      .join(' ');
  }
  checkboxes(): FakeElement[] {
    const found: FakeElement[] = this.attrs.type === 'checkbox' ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) found.push(...child.checkboxes());
    }
    return found;
  }
  buttons(): FakeElement[] {
    const found: FakeElement[] = this.tag === 'button' ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) found.push(...child.buttons());
    }
    return found;
  }
}

type Reply = { status: number; body: unknown };

function harness(
  route: (url: string, init?: RequestInit) => Reply,
  clock: { offsetMs: number } = { offsetMs: 0 },
  caseRef: { current: Record<string, unknown> | null } = { current: null },
  folder: { requests: unknown[] } = { requests: [] },
) {
  const wizParent = new FakeElement('div');
  const wiz = new FakeElement('div');
  wizParent.append(wiz);
  const wzPane = new FakeElement('div');
  const timers: (() => void)[] = [];
  const body = new FakeElement('body');
  const created: FakeElement[] = [];
  const storage = new Proxy(
    {},
    {
      get() {
        throw new Error('ブラウザの保存領域を使わない');
      },
    },
  );
  const calls: { url: string; body: unknown }[] = [];
  const load: (() => void)[] = [];
  const context: Record<string, unknown> = {
    document: {
      hidden: false,
      body,
      createElement(tag: string) {
        const element = new FakeElement(tag);
        Object.defineProperty(element, 'id', { writable: true, value: '' });
        created.push(element);
        return element;
      },
      createTextNode: (text: string) => ({ text }),
      getElementById: (id: string) =>
        created.find((element) => element.id === id && element.parentNode) ?? null,
      querySelector: (selector: string) =>
        selector === '#wzPane' ? wzPane : selector === '.w-wiz' ? wiz : null,
    },
    localStorage: storage,
    sessionStorage: storage,
    curCase: () => caseRef.current,
    setInterval: (callback: () => void) => timers.push(callback),
    encodeURIComponent,
    JSON,
    Date: class extends Date {
      static now() {
        return Date.now() + clock.offsetMs;
      }
    },
    Map,
    Set,
    Object,
    String,
    Number,
    Boolean,
    Error,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = route(url, init);
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    },
  };
  context.window = {
    addEventListener: (_type: string, listener: () => void) => load.push(listener),
    // フォルダブリッジが持つ依頼（support-session 側からは問い合わせない）。
    __AIHD_FOLDER_ACCESS_BRIDGE__: { requests: () => folder.requests },
  };
  runInNewContext(source, context);
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    calls,
    flush,
    tick: async () => {
      for (const timer of timers) timer();
      await flush();
    },
    tickSync: () => {
      for (const timer of timers) timer();
    },
    start: async () => {
      for (const listener of load) listener();
      await flush();
    },
    panel: () =>
      created.find((element) => element.id === 'aihdSupportSessionMinePanel' && element.parentNode),
    staff: () => created.find((element) => element.id === 'aihdSupportSessionStaffPanel'),
  };
}

const CANARY = '<img src=x onerror=alert(1)>';
const BASE = {
  id: '11111111-1111-4111-8111-111111111111',
  caseId: 'CASE-1',
  status: 'awaiting_approval',
  endReason: null,
  leaseStatus: 'verified',
  proposalCount: 1,
  maxProposals: 6,
  device: { hostname: 'SYNTH-PC', windowsUser: 'synth-user' },
  operationConsent: { scope: 'user_reversible', version: 'v', expiresAt: null },
  aiInputConsent: null,
  consentVersions: { operation: 'operation-consent/1', aiInput: 'ai-input-consent/2' },
  proposals: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      status: 'proposed',
      title: '検証用の目印を設定する',
      effect: 'modify',
      proposalSource: 'deepseek',
      purpose: '目的',
      impact: '影響',
      successCriteria: '成功',
      failureAction: '失敗',
      rollbackScope: '戻せる範囲',
      aiGuess: CANARY,
      verifyOps: [{ skillId: 'user.marker.status', title: '確認', description: '値を読む' }],
      approvalHash: 'a'.repeat(64),
      approvalExpiresAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  executions: [],
};

describe('本人パネル（Mock: DOM / fetch）', () => {
  it('セッションがなければ何も描画しない', async () => {
    const page = harness(() => ({ status: 200, body: { sessions: [] } }));
    await page.start();
    expect(page.panel()).toBeUndefined();
  });

  it('機能が無効（404）なら以後問い合わせず、何も描画しない', async () => {
    const page = harness(() => ({ status: 404, body: {} }));
    await page.start();
    expect(page.panel()).toBeUndefined();
    expect(page.calls.length).toBe(1);
  });

  it('提案を表示し、AI の文字列は HTML として解釈しない。Y は提示されたハッシュを送る', async () => {
    const page = harness((url) =>
      url.endsWith('/mine')
        ? { status: 200, body: { sessions: [BASE] } }
        : { status: 200, body: { session: BASE } },
    );
    await page.start();
    const panel = page.panel() as FakeElement;
    expect(panel.text).toContain('検証用の目印を設定する');
    expect(panel.text).toContain('AI の提案');
    expect(panel.text).toContain(CANARY);
    expect(panel.text).toContain('MVP');
    const yes = panel.buttons().find((button) => button.text.includes('はい')) as FakeElement;
    yes.listeners.click?.[0]?.({});
    await page.flush();
    const decision = page.calls.find((item) => item.url.endsWith('/decision'));
    expect(decision?.body).toEqual({ decision: 'Y', approvalHash: 'a'.repeat(64) });
  });

  it('404 の後はしばらく問い合わせないが、時間を置いて再開する', async () => {
    const clock = { offsetMs: 0 };
    let enabled = false;
    const page = harness(
      () => (enabled ? { status: 200, body: { sessions: [BASE] } } : { status: 404, body: {} }),
      clock,
    );
    await page.start();
    const before = page.calls.length;
    await page.tick();
    expect(page.calls.length).toBe(before);
    enabled = true;
    clock.offsetMs = 120_000;
    await page.tick();
    expect(page.calls.length).toBeGreaterThan(before);
    expect(page.panel()).toBeDefined();
  });

  it('一時的な失敗の後に成功すればエラーを消す', async () => {
    let failing = false;
    const page = harness(() =>
      failing
        ? { status: 500, body: { error: { message: 'TEMPORARY-FAILURE' } } }
        : { status: 200, body: { sessions: [BASE] } },
    );
    await page.start();
    failing = true;
    await page.tick();
    expect((page.panel() as FakeElement).text).toContain('TEMPORARY-FAILURE');
    failing = false;
    await page.tick();
    expect((page.panel() as FakeElement).text).not.toContain('TEMPORARY-FAILURE');
  });

  it('操作の失敗は直後の状態確認で消さない', async () => {
    const page = harness((url) =>
      url.endsWith('/mine')
        ? { status: 200, body: { sessions: [BASE] } }
        : { status: 409, body: { error: { message: 'ACTION-FAILED' } } },
    );
    await page.start();
    const no = (page.panel() as FakeElement)
      .buttons()
      .find((button) => button.text.includes('いいえ')) as FakeElement;
    no.listeners.click?.[0]?.({});
    await page.flush();
    expect((page.panel() as FakeElement).text).toContain('ACTION-FAILED');
  });

  it('未実行の結果に変更の可能性を出さず、停止の表示と矛盾しない', async () => {
    const execution = {
      role: 'main',
      skillId: 'user.marker.set',
      executionMode: 'real',
      resultCode: 'START_NO_RESPONSE',
      verifyOk: null,
      output: null,
      lateResult: false,
    };
    const session = (fields: Record<string, unknown>) => ({
      ...BASE,
      status: 'stopped',
      proposals: [],
      executions: [{ ...execution, ...fields }],
    });
    const page = harness(() => ({
      status: 200,
      body: {
        sessions: [
          session({
            stopRequestedAt: null,
            stopOutcome: 'not_running',
            partialEffect: null,
          }),
        ],
      },
    }));
    await page.start();
    const text = (page.panel() as FakeElement).text;
    expect(text).toContain('実行していません');
    expect(text).not.toContain('変更が生じた可能性');
    expect(text).not.toContain('停止を要求');

    const killed = harness(() => ({
      status: 200,
      body: { sessions: [session({ stopRequestedAt: null, stopOutcome: 'stopped' })] },
    }));
    await killed.start();
    expect((killed.panel() as FakeElement).text).toContain('停止しました');
    expect((killed.panel() as FakeElement).text).not.toContain('停止を要求');
  });

  it('N と取消の導線がある', async () => {
    const page = harness((url) =>
      url.endsWith('/mine')
        ? { status: 200, body: { sessions: [BASE] } }
        : { status: 200, body: {} },
    );
    await page.start();
    const panel = page.panel() as FakeElement;
    const no = panel.buttons().find((button) => button.text.includes('いいえ')) as FakeElement;
    no.listeners.click?.[0]?.({});
    await page.flush();
    expect(page.calls.find((item) => item.url.endsWith('/decision'))?.body).toEqual({
      decision: 'N',
    });
    const panelAgain = page.panel() as FakeElement;
    const revoke = panelAgain
      .buttons()
      .find((button) => button.text.includes('取り消す')) as FakeElement;
    revoke.listeners.click?.[0]?.({});
    await page.flush();
    expect(page.calls.some((item) => item.url.endsWith('/revoke'))).toBe(true);
  });

  it('同意は操作範囲と AI 入力を別に送る。AI を選ばなければ送らない', async () => {
    const session = { ...BASE, status: 'consent_pending', operationConsent: null, proposals: [] };
    const page = harness((url) =>
      url.endsWith('/mine')
        ? { status: 200, body: { sessions: [session] } }
        : { status: 200, body: {} },
    );
    await page.start();
    const panel = page.panel() as FakeElement;
    const agree = panel.buttons().find((button) => button.text.includes('同意')) as FakeElement;
    agree.listeners.click?.[0]?.({});
    await page.flush();
    expect(page.calls.find((item) => item.url.endsWith('/consents/operation'))?.body).toEqual({
      scope: 'read_only',
      version: 'operation-consent/1',
      ttlMinutes: 30,
    });
    expect(page.calls.some((item) => item.url.endsWith('/consents/ai-input'))).toBe(false);
  });

  it('結果の出所・遅延・部分的な変更を隠さず表示し、解決確認を出す', async () => {
    const session = {
      ...BASE,
      status: 'resolve_confirm',
      proposals: [],
      executions: [
        {
          role: 'main',
          skillId: 'user.marker.set',
          executionMode: 'mock',
          phase: 'completed',
          resultCode: 'MARKER_SET',
          verifyOk: null,
          output: { applied: true },
          lateResult: true,
          stopRequestedAt: '2026-11-01T00:00:00.000Z',
          stopOutcome: 'stop_failed',
          partialEffect: ['POSSIBLE_CHANGE'],
        },
      ],
    };
    const page = harness((url) =>
      url.endsWith('/mine')
        ? { status: 200, body: { sessions: [session] } }
        : { status: 200, body: {} },
    );
    await page.start();
    const panel = page.panel() as FakeElement;
    expect(panel.text).toContain('デモ（証拠にしません）');
    expect(panel.text).toContain('遅れて届いた結果');
    expect(panel.text).toContain('停止できませんでした');
    expect(panel.text).toContain('POSSIBLE_CHANGE');
    const resolved = panel.buttons().find((button) => button.text === '解決した') as FakeElement;
    resolved.listeners.click?.[0]?.({});
    await page.flush();
    expect(page.calls.find((item) => item.url.endsWith('/resolution'))?.body).toEqual({
      resolved: true,
    });
  });

  it('終了の理由を表示し、操作ボタンを出さない', async () => {
    const session = {
      ...BASE,
      status: 'stopped',
      endReason: 'unverifiable',
      proposals: [],
      operationConsent: null,
    };
    const page = harness(() => ({ status: 200, body: { sessions: [session] } }));
    await page.start();
    const panel = page.panel() as FakeElement;
    expect(panel.text).toContain('成功とは扱いません');
    expect(panel.buttons()).toEqual([]);
  });

  describe('AI 入力の同意のチェックは見た目と送信内容が必ず一致する', () => {
    const session = { ...BASE, status: 'consent_pending', operationConsent: null, proposals: [] };
    const box = (page: ReturnType<typeof harness>) =>
      (page.panel() as FakeElement).checkboxes()[0] as FakeElement;
    const agree = async (page: ReturnType<typeof harness>) => {
      const button = (page.panel() as FakeElement)
        .buttons()
        .find((item) => item.text.includes('同意')) as FakeElement;
      button.listeners.click?.[0]?.({});
      await page.flush();
    };
    const toggle = (page: ReturnType<typeof harness>, checked: boolean) => {
      box(page).listeners.change?.[0]?.({ target: { checked } });
    };

    it('送信に失敗して再描画しても、チェックを保ち、送信内容と一致する', async () => {
      let failing = true;
      const page = harness((url) => {
        if (url.endsWith('/mine')) return { status: 200, body: { sessions: [session] } };
        if (url.endsWith('/consents/operation') && failing) {
          return { status: 500, body: { error: { message: '失敗' } } };
        }
        return { status: 200, body: {} };
      });
      await page.start();
      expect(box(page).checked).toBe(false);
      toggle(page, true);
      await agree(page);
      expect((page.panel() as FakeElement).text).toContain('失敗');
      expect(box(page).checked).toBe(true);
      failing = false;
      await agree(page);
      expect(page.calls.some((item) => item.url.endsWith('/consents/ai-input'))).toBe(true);
    });

    it('チェックを外して再描画すれば、外れた表示のまま AI の同意を送らない', async () => {
      let failing = true;
      const page = harness((url) => {
        if (url.endsWith('/mine')) return { status: 200, body: { sessions: [session] } };
        if (url.endsWith('/consents/operation') && failing) {
          return { status: 500, body: { error: { message: '失敗' } } };
        }
        return { status: 200, body: {} };
      });
      await page.start();
      toggle(page, true);
      await agree(page);
      toggle(page, false);
      failing = false;
      await agree(page);
      expect(box(page).checked).toBe(false);
      expect(page.calls.some((item) => item.url.endsWith('/consents/ai-input'))).toBe(false);
    });

    it('状態が変わって再構築しても、表示と保持している値が一致する', async () => {
      let current = session;
      const page = harness((url) =>
        url.endsWith('/mine')
          ? { status: 200, body: { sessions: [current] } }
          : { status: 500, body: { error: { message: '失敗' } } },
      );
      await page.start();
      toggle(page, true);
      // 別の項目の変化で全体を描き直す。
      current = { ...session, proposalCount: 2 };
      await agree(page);
      expect(box(page).checked).toBe(true);
    });
  });

  describe('状態の文言（実行前拒否・開始・完了・検証・停止未確認）', () => {
    const run = (fields: Record<string, unknown>) => ({
      role: 'main',
      stepSeq: 1,
      skillId: 'folder.summary',
      executionMode: 'real',
      resultCode: null,
      verifyOk: null,
      output: null,
      lateResult: false,
      stopRequestedAt: null,
      stopOutcome: null,
      partialEffect: null,
      ...fields,
    });
    const panelText = async (session: Record<string, unknown>) => {
      const page = harness((url) =>
        url.endsWith('/support-sessions/mine')
          ? { status: 200, body: { sessions: [session] } }
          : { status: 200, body: { requests: [] } },
      );
      await page.start();
      return (page.panel() as FakeElement).text;
    };
    const stoppedWith = (executions: unknown[], fields: Record<string, unknown> = {}) => ({
      ...BASE,
      status: 'stopped',
      proposals: [],
      executions,
      ...fields,
    });

    it('execution_mode が real でも、実行前の拒否を実行したと表示しない', async () => {
      const text = await panelText(
        stoppedWith([
          run({
            phase: 'rejected_before_start',
            verification: 'not_applicable',
            resultCode: 'SIGNATURE_INVALID',
            stopOutcome: 'not_running',
          }),
        ]),
      );
      expect(text).toContain('開始前に拒否');
      expect(text).toContain('実行していません');
      expect(text).not.toContain('端末で実行');
      expect(text).not.toContain('ヘルパーの報告');
      expect(text).not.toContain('未確認');
    });

    it('開始と完了を分け、完了と検証を分ける', async () => {
      const started = await panelText(
        stoppedWith([run({ phase: 'started', verification: 'unverified' })], {
          status: 'executing',
        }),
      );
      expect(started).toContain('端末で開始（結果待ち）');
      expect(started).not.toContain('完了');

      const completed = await panelText(
        stoppedWith([
          run({
            phase: 'completed',
            verification: 'failed',
            verifyOk: false,
            resultCode: 'FOLDER_SUMMARY_OK',
          }),
        ]),
      );
      expect(completed).toContain('完了の報告あり');
      expect(completed).toContain('ヘルパーの報告');
      expect(completed).toContain('条件を満たしませんでした');

      const passed = await panelText(
        stoppedWith([run({ phase: 'completed', verification: 'passed', verifyOk: true })]),
      );
      expect(passed).toContain('条件を満たしました');
      expect(passed).not.toMatch(/解決しました|解決済|修復/);
    });

    it('報告の期限切れを停止未確認として表示し、成功や停止済みにしない', async () => {
      const text = await panelText(
        stoppedWith([
          run({
            phase: 'stop_unconfirmed',
            verification: 'unverified',
            stopRequestedAt: '2026-11-01T00:00:00.000Z',
            stopOutcome: 'stop_unconfirmed',
            reportExpiredAt: '2026-11-02T00:00:00.000Z',
          }),
        ]),
      );
      expect(text).toContain('停止未確認');
      expect(text).toContain('結果の報告期限を過ぎました');
      expect(text).not.toContain('完了');
      expect(text).not.toContain('停止しました');
    });

    it('N の後に、過去の実行まで「何も実行していない」と説明しない', async () => {
      const text = await panelText(
        stoppedWith([run({ phase: 'completed', verification: 'passed', verifyOk: true })], {
          endReason: 'requester_declined',
          executionSummary: {
            started: 1,
            reported: 1,
            stopConfirmed: 0,
            stopUnconfirmed: 0,
            notRun: 0,
          },
        }),
      );
      expect(text).not.toContain('何も実行していません');
      expect(text).toContain('この提案は実行していません');
      expect(text).toContain('これまでに端末で開始した操作: 1 件');
    });

    it('実行が 1 件もなければ、そのことを示す', async () => {
      const text = await panelText(
        stoppedWith([], {
          endReason: 'requester_declined',
          executionSummary: {
            started: 0,
            reported: 0,
            stopConfirmed: 0,
            stopUnconfirmed: 0,
            notRun: 0,
          },
        }),
      );
      expect(text).toContain('この提案は実行していません');
      expect(text).toContain('端末で開始した操作はありません');
    });

    it('確認の期限切れも、この提案についてだけ述べる', () => {
      const block = /const END_LABEL = \{([\s\S]*?)\n {2}\};/.exec(source)?.[1] ?? '';
      expect(block).toContain(
        "approval_expired: '確認の期限（5 分）が切れました。この提案は実行していません。'",
      );
      expect(block).not.toContain('何も実行していません');
    });

    it('解決の確認の前に、実行の成功を解決と表現しない', async () => {
      const text = await panelText(
        stoppedWith([run({ phase: 'completed', verification: 'passed', verifyOk: true })], {
          status: 'resolve_confirm',
        }),
      );
      expect(text).toContain('操作の成功は、困りごとの解決を意味しません');
      expect(text).toContain('困りごとは解決しましたか');
    });
  });

  it('終了理由のすべてに表示文言がある', () => {
    const block = /const END_LABEL = \{([\s\S]*?)\n {2}\};/.exec(source)?.[1] ?? '';
    expect(block).not.toBe('');
    for (const reason of SESSION_END_REASONS) {
      expect(block, reason).toMatch(new RegExp(`\\b${reason}:`));
    }
  });

  describe('提案の表示と Y', () => {
    const yesButton = (page: ReturnType<typeof harness>) =>
      (page.panel() as FakeElement)
        .buttons()
        .find((button) => button.text.includes('はい')) as FakeElement;
    const decisions = (page: ReturnType<typeof harness>) =>
      page.calls.filter((item) => item.url.endsWith('/decision'));
    const withSession = (session: unknown) => (url: string) =>
      url.endsWith('/support-sessions/mine')
        ? { status: 200, body: { sessions: [session] } }
        : url.includes('/folder-access/mine')
          ? { status: 200, body: { requests: [] } }
          : { status: 200, body: { session } };

    const stopped = (fields: Record<string, unknown>) => ({
      ...BASE,
      status: 'stopped',
      proposals: [],
      executions: [
        {
          role: 'main',
          stepSeq: 2,
          skillId: 'user.marker.set',
          executionMode: 'real',
          resultCode: 'MARKER_SET',
          verifyOk: null,
          output: null,
          lateResult: true,
          stopRequestedAt: '2026-11-01T00:00:00.000Z',
          ...fields,
        },
      ],
    });

    it('停止の前に完了した実行を「実行していません」と出さず、変更の可能性を隠さない', async () => {
      const page = harness(
        withSession(
          stopped({ stopOutcome: 'completed_before_stop', partialEffect: ['POSSIBLE_CHANGE'] }),
        ),
      );
      await page.start();
      const text = (page.panel() as FakeElement).text;
      expect(text).not.toContain('実行していません');
      expect(text).toContain('停止の前に完了しました');
      expect(text).toContain('変更が生じた可能性があります');
    });

    it('not_running でも partialEffect があれば隠さない', async () => {
      const page = harness(
        withSession(stopped({ stopOutcome: 'not_running', partialEffect: ['MARKER_WRITTEN'] })),
      );
      await page.start();
      expect((page.panel() as FakeElement).text).toContain('変更が生じた可能性があります');
    });

    it('目的・対象・影響・成功条件・確認・失敗時・推測と事実の区別を表示する', async () => {
      const session = {
        ...BASE,
        verifiedFacts: [
          { stepSeq: 1, role: 'main', skillId: 'x', condition: 'FACT-CONDITION', ok: true },
        ],
        proposals: [
          {
            ...BASE.proposals[0],
            target: 'T1',
            aiGuess: 'AI-GUESS-TEXT',
            rationale: null,
            reasonCodes: ['SYMPTOM_MATCH', 'AI_SELECTED'],
          },
        ],
      };
      const page = harness(withSession(session));
      await page.start();
      const text = (page.panel() as FakeElement).text;
      for (const label of [
        '目的',
        '対象',
        '影響',
        '成功の条件',
        '失敗したとき',
        '元に戻せる範囲',
      ]) {
        expect(text, label).toContain(label);
      }
      expect(text).toContain('この提案に含まれる確認');
      expect(text).toContain('新しい提案には数えません');
      expect(text).toContain('AI の推測（確認された事実ではありません）: AI-GUESS-TEXT');
      expect(text).toContain('確認された事実');
      expect(text).toContain('FACT-CONDITION');
      expect(text).toContain('相談の症状に対応する操作です。');
    });

    it('二重クリックでも Y は 1 回だけ送る', async () => {
      const page = harness(withSession(BASE));
      await page.start();
      const yes = yesButton(page);
      yes.listeners.click?.[0]?.({});
      yes.listeners.click?.[0]?.({});
      await page.flush();
      yes.listeners.click?.[0]?.({});
      await page.flush();
      expect(decisions(page)).toHaveLength(1);
      expect(decisions(page)[0]?.body).toEqual({ decision: 'Y', approvalHash: 'a'.repeat(64) });
    });

    it('古い画面のボタンからは Y を送らない（提案が変わった後）', async () => {
      let current: Record<string, unknown> = BASE;
      const page = harness((url) => withSession(current)(url));
      await page.start();
      const stale = yesButton(page);
      current = {
        ...BASE,
        proposals: [{ ...BASE.proposals[0], id: 'other', approvalHash: 'b'.repeat(64) }],
      };
      await page.tick();
      stale.listeners.click?.[0]?.({});
      await page.flush();
      expect(decisions(page)).toHaveLength(0);
      expect((page.panel() as FakeElement).text).toContain('画面が古くなりました');
    });

    it('通信に失敗した Y は押し直せる（送るのは表示中のハッシュ）', async () => {
      let failing = true;
      const page = harness((url) => {
        if (url.endsWith('/decision') && failing) {
          return { status: 500, body: { error: { message: 'NETWORK' } } };
        }
        return withSession(BASE)(url);
      });
      await page.start();
      yesButton(page).listeners.click?.[0]?.({});
      await page.flush();
      expect((page.panel() as FakeElement).text).toContain('NETWORK');
      failing = false;
      yesButton(page).listeners.click?.[0]?.({});
      await page.flush();
      expect(decisions(page)).toHaveLength(2);
    });

    it('承認済みの Skill が 0 件なら理由を表示し、提案のボタンを出さない', async () => {
      const session = {
        ...BASE,
        status: 'ready',
        proposals: [],
        operationConsent: { scope: 'read_only', version: 'v', expiresAt: null },
        skillAvailability: { readOnly: 0, userReversible: 0 },
      };
      const page = harness(withSession(session));
      await page.start();
      const panel = page.panel() as FakeElement;
      expect(panel.text).toContain('承認済みの操作がないため');
      expect(panel.buttons().some((button) => button.text.includes('提案してもらう'))).toBe(false);
    });

    it('変更系が承認されていなければ変更の範囲を選べず、AI が無ければ AI の同意を出さない', async () => {
      const session = {
        ...BASE,
        status: 'consent_pending',
        operationConsent: null,
        proposals: [],
        aiAvailable: false,
        skillAvailability: { readOnly: 2, userReversible: 2 },
      };
      const page = harness(withSession(session));
      await page.start();
      const panel = page.panel() as FakeElement;
      expect(panel.text).not.toContain('自分の設定の変更');
      expect(panel.text).toContain('AI は利用できません');
      expect(
        ((panel.checkboxes()[0] as FakeElement).parentNode as FakeElement).style.cssText,
      ).toContain('display:none');
    });

    it('導入から提案までの案内を一続きに出す（セッションの前から）', async () => {
      const request = {
        id: 'r',
        handoverId: 'h',
        caseId: 'CASE-9',
        status: 'helper_pending',
        paired: false,
      };
      const page = harness(() => ({ status: 200, body: { sessions: [] } }), undefined, undefined, {
        requests: [request],
      });
      await page.start();
      await page.tick();
      // フォルダブリッジのデータを使い、追加で問い合わせない。
      expect(page.calls.some((item) => item.url.includes('/folder-access/mine'))).toBe(false);
      const text = (page.panel() as FakeElement).text;
      expect(text).toContain('▶ 1. 導入コード');
      expect(text).toContain('PC に表示されたコード');
      expect(text).toContain('操作の範囲に同意');
      expect(text).toContain('いつでも取り消せます');
    });

    it('本人の表示に対象 PC・ユーザー・許可範囲・期限を出す', async () => {
      const session = {
        ...BASE,
        folderScope: {
          root: 'Documents',
          segments: ['資料'],
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      };
      const page = harness(withSession(session));
      await page.start();
      const text = (page.panel() as FakeElement).text;
      for (const value of ['SYNTH-PC', 'synth-user', 'ドキュメント › 資料', '期限']) {
        expect(text).toContain(value);
      }
    });
  });

  describe('担当者パネル', () => {
    const caseRef = () => ({
      current: { id: 'CASE-1', handoverId: '11111111-1111-4111-8111-111111111111' } as Record<
        string,
        unknown
      > | null,
    });
    const route =
      (session: unknown, status = 200) =>
      (url: string, init?: RequestInit) => {
        if (url.endsWith('/mine')) return { status: 200, body: { sessions: [], requests: [] } };
        if (status !== 200) return { status, body: { error: { message: 'x' } } };
        if (init?.method === 'POST') return { status: 200, body: { session } };
        return { status: 200, body: { session } };
      };
    const buttons = (page: ReturnType<typeof harness>) => (page.staff() as FakeElement).buttons();

    it('引き受けた本人には開始のボタンを出し、押すと開始する', async () => {
      const page = harness(route(null), undefined, caseRef());
      await page.start();
      const start = buttons(page).find((button) => button.text.includes('開始')) as FakeElement;
      start.listeners.click?.[0]?.({});
      await page.flush();
      expect(page.calls.find((item) => item.url === '/api/support-sessions')?.body).toEqual({
        handoverId: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('進行中は中止のボタンを出し、Y や解決の操作を出さない', async () => {
      const session = { ...BASE };
      const page = harness(route(session), undefined, caseRef());
      await page.start();
      const staff = page.staff() as FakeElement;
      expect(staff.text).toContain('相談者本人が決めます');
      expect(buttons(page).map((button) => button.text)).toEqual(['中止']);
      buttons(page)[0]?.listeners.click?.[0]?.({});
      await page.flush();
      expect(page.calls.some((item) => item.url.endsWith('/stop'))).toBe(true);
    });

    it.each([403, 404])('%i（承認者のみ、他の担当者、機能無効）なら表示しない', async (status) => {
      const page = harness(route(null, status), undefined, caseRef());
      await page.start();
      const staff = page.staff() as FakeElement;
      expect(staff.style.display).toBe('none');
      expect(staff.buttons()).toEqual([]);
    });

    it('一時的な失敗ではエラーを見せ、中止を残す', async () => {
      let failing = false;
      const session = { ...BASE };
      const page = harness(
        (url, init) =>
          failing && !url.endsWith('/mine')
            ? { status: 503, body: { error: { message: 'TEMPORARY' } } }
            : route(session)(url, init),
        undefined,
        caseRef(),
      );
      await page.start();
      failing = true;
      await page.tick();
      const staff = page.staff() as FakeElement;
      expect(staff.text).toContain('TEMPORARY');
      expect(buttons(page).some((button) => button.text === '中止')).toBe(true);
    });

    it('案件を切り替えたら、応答を待たずに前の案件の状態を消す', async () => {
      const ref = caseRef();
      const page = harness(route({ ...BASE, status: 'executing' }), undefined, ref);
      await page.start();
      expect((page.staff() as FakeElement).text).toContain('端末で開始');
      ref.current = { id: 'CASE-2', handoverId: '22222222-2222-4222-8222-222222222222' };
      const staff = page.staff() as FakeElement;
      // 応答を待たない（タイマーの直後、まだ await の前）。
      page.tickSync();
      expect(staff.text).not.toContain('端末で開始');
    });
  });

  it('提案の理由コードのすべてに表示文言がある', () => {
    const block = /const REASON_LABEL = \{([\s\S]*?)\n {2}\};/.exec(source)?.[1] ?? '';
    for (const code of REASON_CODES) {
      expect(block, code).toMatch(new RegExp(`\\b${code}:`));
    }
  });

  it('描画に innerHTML を使わない（ソースの確認）', () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
