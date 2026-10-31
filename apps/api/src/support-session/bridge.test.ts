import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';

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
  style = { cssText: '' };
  id = '';
  value = '';
  disabled = false;
  selected = false;
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
  buttons(): FakeElement[] {
    const found: FakeElement[] = this.tag === 'button' ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) found.push(...child.buttons());
    }
    return found;
  }
}

type Reply = { status: number; body: unknown };

function harness(route: (url: string, init?: RequestInit) => Reply) {
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
    },
    localStorage: storage,
    sessionStorage: storage,
    setInterval: () => 0,
    encodeURIComponent,
    JSON,
    Date,
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
  };
  runInNewContext(source, context);
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    calls,
    flush,
    start: async () => {
      for (const listener of load) listener();
      await flush();
    },
    panel: () =>
      created.find((element) => element.id === 'aihdSupportSessionMinePanel' && element.parentNode),
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
  consentVersions: { operation: 'operation-consent/1', aiInput: 'ai-input-consent/1' },
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
      rationale: CANARY,
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

  it('描画に innerHTML を使わない（ソースの確認）', () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
