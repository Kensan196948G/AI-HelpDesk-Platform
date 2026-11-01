import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * 相談者の画面が担当者向け API を呼び続けない（403 を出し続けない）ことの回帰試験。
 * 実物のブリッジを vm で読み込み、fetch の呼び出し回数を数える。
 */
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const accessCode = read('./staff-access-bridge.js');
const remoteCode = read('./remote-support-bridge.js');
const assistCode = read('./assist-bridge.js');
const workspaceCode = read('./handover-workspace-bridge.js');

const REMOTE = '/api/remote-support/session';
const INBOX = '/api/case-handovers/inbox';

type Reply = { status: number; body?: unknown };
type Routes = Record<string, Reply | 'reject'>;

/** URL の前方一致で応答を決め、呼び出しを記録する fetch。 */
function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const reply = key ? routes[key] : { status: 404 };
    if (reply === 'reject' || !reply) throw new Error('network');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? { error: { message: `HTTP ${reply.status}` } },
    };
  });
  return { fetch, count: (prefix: string) => calls.filter((u) => u.startsWith(prefix)).length };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

/** 再描画で消える #aihdRemoteSupportPanel を再現できる最小の DOM。 */
function loadRemoteBridge(routes: Routes, caseId: { value: string }) {
  const elements = new Map<string, any>();
  const wiz = {
    parentNode: {
      insertBefore: (node: any) => {
        if (node.id) elements.set(node.id, node);
      },
    },
    nextSibling: null,
  };
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      if (selector === '#wzPane') return {};
      if (selector === '.w-wiz') return wiz;
      return null;
    },
    createElement: () => ({ id: '', className: '', style: {}, innerHTML: '' }),
    addEventListener: () => {},
  };
  let tick: () => void = () => {};
  const { fetch, count } = fakeFetch(routes);
  const window: Record<string, unknown> = { addEventListener: () => {} };
  const sandbox = {
    window,
    document,
    fetch,
    console,
    curCase: () => ({ id: caseId.value }),
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(accessCode, sandbox);
  vm.runInContext(remoteCode, sandbox);
  return {
    count,
    panel: () => elements.get('aihdRemoteSupportPanel'),
    /** 画面の再描画を挟みながら 800ms 周期の監視を回す。 */
    async run(ticks: number) {
      for (let i = 0; i < ticks; i += 1) {
        elements.delete('aihdRemoteSupportPanel');
        tick();
        await settle();
      }
    },
  };
}

const ME_REQUESTER = { status: 200, body: { remoteSupport: false, helpdeskActor: false } };
const ME_STAFF = { status: 200, body: { remoteSupport: true, helpdeskActor: true } };

describe('remote-support-bridge: 担当者以外は遠隔対応 API を呼ばない', () => {
  it('/api/me が権限なしなら、再描画や案件切替があっても 1 回も呼ばない', async () => {
    const caseId = { value: 'CASE-1' };
    const bridge = loadRemoteBridge({ '/api/me': ME_REQUESTER, [REMOTE]: { status: 403 } }, caseId);
    await bridge.run(5);
    caseId.value = 'CASE-2';
    await bridge.run(5);
    expect(bridge.count(REMOTE)).toBe(0);
    expect(bridge.count('/api/me')).toBe(1);
    expect(bridge.panel().style.display).toBe('none');
  });

  it('/api/me が取れないときは 1 回だけ試し、403 を受けたら止まる', async () => {
    const caseId = { value: 'CASE-1' };
    const bridge = loadRemoteBridge({ '/api/me': 'reject', [REMOTE]: { status: 403 } }, caseId);
    await bridge.run(5);
    caseId.value = 'CASE-2';
    await bridge.run(5);
    expect(bridge.count(REMOTE)).toBe(1);
    expect(bridge.count('/api/me')).toBe(1);
  });

  it('/api/me が許可でもサーバが 403 を返せば止まる（サーバの判定が正本）', async () => {
    const caseId = { value: 'CASE-1' };
    const bridge = loadRemoteBridge({ '/api/me': ME_STAFF, [REMOTE]: { status: 403 } }, caseId);
    await bridge.run(5);
    expect(bridge.count(REMOTE)).toBe(1);
  });

  it('担当者はパネルを表示できる', async () => {
    const caseId = { value: 'CASE-1' };
    const bridge = loadRemoteBridge(
      {
        '/api/me': ME_STAFF,
        [REMOTE]: {
          status: 200,
          body: { session: { userEmail: 'u@example.com', deviceId: 'D1' }, link: null },
        },
      },
      caseId,
    );
    await bridge.run(1);
    expect(bridge.count(REMOTE)).toBe(1);
    expect(bridge.panel().style.display).toBe('');
  });

  it('担当者の 404（引き継ぎ前）では止めない。引き継ぎ後にパネルを出すため', async () => {
    const caseId = { value: 'CASE-1' };
    const routes: Routes = { '/api/me': ME_STAFF, [REMOTE]: { status: 404 } };
    const bridge = loadRemoteBridge(routes, caseId);
    await bridge.run(2);
    expect(bridge.count(REMOTE)).toBe(2);
    routes[REMOTE] = {
      status: 200,
      body: { session: { userEmail: 'u@example.com', deviceId: 'D1' }, link: null },
    };
    await bridge.run(1);
    expect(bridge.panel().style.display).toBe('');
  });
});

function loadAssistBridge(routes: Routes) {
  const { fetch, count } = fakeFetch(routes);
  const window: Record<string, any> = { __AIHD_BOOT__: {} };
  const sandbox = {
    window,
    fetch,
    console,
    pcVisible: () => true,
    ACT: { wConsent: () => {} },
    document: { readyState: 'loading', addEventListener: () => {} },
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(accessCode, sandbox);
  vm.runInContext(assistCode, sandbox);
  return { count, bridge: window.__AIHD_ASSIST_BRIDGE__, access: window.__AIHD_STAFF_ACCESS__ };
}

describe('assist-bridge: 相談者のホーム画面は受信箱を呼ばない', () => {
  it('/api/me が権限なしなら呼ばない', async () => {
    const { bridge, count } = loadAssistBridge({
      '/api/me': ME_REQUESTER,
      [INBOX]: { status: 403 },
    });
    await bridge.fetchHandoverInbox();
    await bridge.fetchHandoverInbox();
    expect(count(INBOX)).toBe(0);
  });

  it('担当者は受信箱を取得する', async () => {
    const { bridge, count } = loadAssistBridge({
      '/api/me': ME_STAFF,
      [INBOX]: { status: 200, body: { items: [] } },
    });
    await bridge.fetchHandoverInbox();
    expect(count(INBOX)).toBe(1);
  });

  it('/api/me が取れなくても担当者の機能を隠さず、403 は共有して他のブリッジも止める', async () => {
    const { bridge, count, access } = loadAssistBridge({
      '/api/me': { status: 429 },
      [INBOX]: { status: 403 },
    });
    await bridge.fetchHandoverInbox();
    expect(count(INBOX)).toBe(1);
    await expect(access.allowed('helpdeskActor')).resolves.toBe(false);
  });
});

/** 読み込み時の DOM 操作を受け流す要素。loadInbox の検証に DOM の中身は要らない。 */
function fakeElement(): any {
  const element: any = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    appendChild() {},
    insertBefore() {},
    contains: () => false,
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    focus() {},
    remove() {},
    children: [],
  };
  return element;
}

function loadWorkspaceBridge(routes: Routes) {
  const { fetch, count } = fakeFetch(routes);
  const window: Record<string, any> = { addEventListener() {} };
  const document = {
    head: fakeElement(),
    body: fakeElement(),
    createElement: () => fakeElement(),
    getElementById: (id: string) => (id === 'uxRail' ? null : fakeElement()),
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox = {
    window,
    document,
    fetch,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(accessCode, sandbox);
  vm.runInContext(workspaceCode, sandbox);
  return {
    count,
    loadInbox: window.__AIHD_HW_BRIDGE__.loadInbox as (f?: boolean) => Promise<void>,
  };
}

describe('handover-workspace-bridge: 権限がなければ更新ボタンでも受信箱を呼ばない', () => {
  it('/api/me が権限なしなら強制更新でも呼ばない', async () => {
    const { loadInbox, count } = loadWorkspaceBridge({
      '/api/me': ME_REQUESTER,
      [INBOX]: { status: 403 },
    });
    await loadInbox();
    await loadInbox(true);
    await loadInbox(true);
    expect(count(INBOX)).toBe(0);
  });

  it('403 を受けたら以後は強制更新でも呼ばない', async () => {
    const { loadInbox, count } = loadWorkspaceBridge({
      '/api/me': ME_STAFF,
      [INBOX]: { status: 403 },
    });
    await loadInbox();
    await loadInbox(true);
    expect(count(INBOX)).toBe(1);
  });

  it('担当者は更新ボタンで取り直せる', async () => {
    const { loadInbox, count } = loadWorkspaceBridge({
      '/api/me': ME_STAFF,
      [INBOX]: { status: 200, body: { items: [] } },
    });
    await loadInbox();
    await loadInbox(true);
    expect(count(INBOX)).toBe(2);
  });
});
