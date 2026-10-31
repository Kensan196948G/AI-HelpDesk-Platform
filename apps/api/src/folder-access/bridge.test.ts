import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';

/**
 * ブリッジの単体テスト（Mock: 最小の DOM と fetch を vm に渡す。実ブラウザではない）。
 * 実ブラウザでの確認は検証環境で行う。
 */

const source = readFileSync(
  path.join(repoRoot, 'apps/api/src/prototype/folder-access-bridge.js'),
  'utf8',
);

class FakeElement {
  children: (FakeElement | { text: string })[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  style = { cssText: '', display: '' };
  id = '';
  className = '';
  value = '';
  parentNode: FakeElement | null = null;
  disabled = false;
  selected = false;
  constructor(public tag: string) {}
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
    if (key === 'id') this.id = value;
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
  findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = predicate(this) ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) found.push(...child.findAll(predicate));
    }
    return found;
  }
}

function harness(routes: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const body = new FakeElement('body');
  const wizParent = new FakeElement('div');
  const wiz = new FakeElement('div');
  wiz.className = 'w-wiz';
  wizParent.append(wiz);
  const wzPane = new FakeElement('div');
  const created: FakeElement[] = [];
  const document = {
    hidden: false,
    body,
    createElement(tag: string) {
      const element = new FakeElement(tag);
      created.push(element);
      return element;
    },
    createTextNode: (text: string) => ({ text }),
    getElementById(id: string) {
      return [...created].find((element) => element.id === id && element.parentNode) ?? null;
    },
    querySelector(selector: string) {
      if (selector === '#wzPane') return wzPane;
      if (selector === '.w-wiz') return wiz;
      return null;
    },
  };
  const timers: (() => void)[] = [];
  const load: (() => void)[] = [];
  const calls: string[] = [];
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('storage / state must not be touched');
      },
      set() {
        throw new Error('storage / state must not be written');
      },
    },
  );
  const window: Record<string, unknown> = {
    addEventListener: (_type: string, listener: () => void) => load.push(listener),
    localStorage: forbidden,
    sessionStorage: forbidden,
  };
  const context = {
    window,
    document,
    localStorage: forbidden,
    sessionStorage: forbidden,
    S: forbidden,
    setInterval: (callback: () => void) => timers.push(callback),
    curCase: () => ({ id: 'CASE-1', handoverId: '11111111-1111-4111-8111-111111111111' }),
    encodeURIComponent,
    console,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const { status, body: json } = routes(url, init);
      return { ok: status < 400, status, json: async () => json };
    },
  };
  runInNewContext(source, context);
  const settle = async () => {
    for (let index = 0; index < 30; index += 1) await new Promise((r) => setImmediate(r));
  };
  return { body, wizParent, created, timers, load, calls, settle, window };
}

const notFound = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } };

function requestDto(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    status,
    endReason: null,
    reasonCode: null,
    leaseStatus: 'verified',
    paired: status !== 'helper_pending',
    pairingLocked: false,
    probeStatus: 'completed',
    device: { hostname: 'SYNTH-PC', helperHostname: 'SYNTH-PC' },
    windowsUser: 'synth-user',
    scope: null,
    ...extra,
  };
}

function panel(harnessed: ReturnType<typeof harness>, id: string): FakeElement | undefined {
  return harnessed.created.find((element) => element.id === id);
}

describe('フォルダ一覧ブリッジ（Mock DOM）', () => {
  it('ソースに HTML 文字列の描画・保存領域・画面状態への書き込みが無い', () => {
    expect(source).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/);
    expect(source).not.toMatch(/\blocalStorage\b|\bsessionStorage\b|indexedDB/);
    expect(source).not.toMatch(/\bS\.[a-zA-Z]/);
    expect(source).not.toContain('prototype_states');
    expect(source).not.toContain('</script');
    expect(source).toContain('MVP');
  });

  it('機能が無効（404）なら何も描画せず、以後は問い合わせない', async () => {
    const h = harness(() => notFound);
    h.load[0]?.();
    await h.settle();
    expect(panel(h, 'aihdFolderAccessMinePanel')).toBeUndefined();
    const staff = panel(h, 'aihdFolderAccessPanel');
    expect(staff?.style.display).toBe('none');
    const before = h.calls.filter((call) => call.includes('/mine')).length;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(h.calls.filter((call) => call.includes('/mine')).length).toBe(before);
  });

  it('担当者でなければ（403）担当者パネルを出さない', async () => {
    const h = harness((url) =>
      url.includes('/mine')
        ? { status: 200, body: { request: null } }
        : { status: 403, body: { error: { code: 'FORBIDDEN', message: 'x' } } },
    );
    h.load[0]?.();
    await h.settle();
    expect(panel(h, 'aihdFolderAccessPanel')?.style.display).toBe('none');
    expect(panel(h, 'aihdFolderAccessPanel')?.children).toEqual([]);
  });

  it('担当者パネル: 結果を textContent で描画し、ファイル名を HTML として解釈しない', async () => {
    const xss = '<img src=x onerror=alert(1)>.txt';
    const h = harness((url) => {
      if (url.includes('/mine')) return { status: 200, body: { request: null } };
      if (url.includes('/result')) {
        return {
          status: 200,
          body: {
            result: {
              opId: 'op',
              status: 'ok',
              count: 1,
              truncated: false,
              receivedAt: '2026-10-31T00:00:00Z',
              entries: [{ name: xss, type: 'file', size: 2048 }],
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          request: requestDto('active', {
            scope: {
              root: 'Documents',
              segments: ['業務'],
              operation: 'list_metadata',
              expiresAt: '2026-10-31T01:00:00Z',
            },
          }),
        },
      };
    });
    h.load[0]?.();
    await h.settle();
    const staff = panel(h, 'aihdFolderAccessPanel');
    expect(staff?.style.display).toBe('');
    expect(staff?.text).toContain('MVP');
    expect(staff?.text).toContain('読取接続中');
    expect(staff?.text).toContain('本番承認者の権限では操作できません');
    expect(staff?.text).toContain('synth-user');
    expect(staff?.text).toContain('ドキュメント › 業務');
    expect(staff?.text).toContain(xss);
    expect(h.created.some((element) => element.tag === 'img')).toBe(false);
    // 結果を window へ公開しない。
    expect(JSON.stringify(h.window.__AIHD_FOLDER_ACCESS_BRIDGE__)).not.toContain('onerror');
  });

  it('相談者パネル: コード入力 → 同意の順に表示し、対象と取消を出す', async () => {
    let dto = requestDto('helper_pending', { paired: false });
    const h = harness((url) => {
      if (url.includes('/mine')) return { status: 200, body: { request: dto } };
      return notFound;
    });
    h.load[0]?.();
    await h.settle();
    const mine = panel(h, 'aihdFolderAccessMinePanel');
    expect(mine?.text).toContain('8 桁のコード');
    expect(mine?.findAll((element) => element.id === 'aihdFolderAccessCode')).toHaveLength(1);

    dto = requestDto('consent_pending');
    for (const timer of h.timers) timer();
    await h.settle();
    expect(mine?.text).toContain('端末名: SYNTH-PC');
    expect(mine?.text).toContain('Windows ユーザー: synth-user');
    expect(mine?.text).toContain('同意する');
    expect(mine?.text).toContain('拒否する');
    const options = mine?.findAll((element) => element.tag === 'option') ?? [];
    expect(options.map((option) => option.value)).toEqual([
      'Desktop',
      'Documents',
      'Downloads',
      'Pictures',
      'Music',
      'Videos',
      '15',
      '30',
      '60',
    ]);

    dto = requestDto('active', {
      scope: { root: 'Desktop', segments: [], expiresAt: '2026-10-31T01:00:00Z' },
    });
    for (const timer of h.timers) timer();
    await h.settle();
    expect(mine?.text).toContain('今すぐ取り消す');
    expect(mine?.text).toContain('許可範囲');

    dto = requestDto('revoked', { endReason: 'requester_revoked' });
    for (const timer of h.timers) timer();
    await h.settle();
    expect(mine?.text).toContain('取り消しました');
    expect(mine?.text).not.toContain('今すぐ取り消す');
  });

  it('相談者パネル: 同意ボタンは enum と相対セグメントだけを送る', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const h = harness((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { status: 200, body: { ok: true } };
      }
      if (url.includes('/mine')) {
        return { status: 200, body: { request: requestDto('consent_pending') } };
      }
      return notFound;
    });
    h.load[0]?.();
    await h.settle();
    const mine = panel(h, 'aihdFolderAccessMinePanel');
    const input = mine?.findAll(
      (element) => element.attrs.placeholder === 'サブフォルダ（任意）',
    )[0];
    input?.listeners.input?.[0]?.({ target: { value: 'a\\b/ c ' } });
    const button = mine?.findAll((element) => element.text === '同意する')[0];
    button?.listeners.click?.[0]?.({});
    await h.settle();
    expect(posts).toEqual([
      {
        url: '/api/folder-access/requests/22222222-2222-4222-8222-222222222222/consent',
        body: { root: 'Documents', segments: ['a', 'b', 'c'], ttlMinutes: 30 },
      },
    ]);
  });

  it('担当者パネル: 終了すると結果をメモリからも破棄する', async () => {
    let status = 'active';
    const h = harness((url, init) => {
      if (url.includes('/mine')) return { status: 200, body: { request: null } };
      if (url.includes('/result')) {
        return {
          status: 200,
          body: {
            result: {
              opId: 'op',
              status: 'ok',
              count: 1,
              receivedAt: 't',
              entries: [{ name: 'SECRET-NAME', type: 'file' }],
            },
          },
        };
      }
      if (init?.method === 'POST') {
        status = 'ended';
        return { status: 200, body: { request: requestDto('ended') } };
      }
      return { status: 200, body: { request: requestDto(status, { endReason: null }) } };
    });
    h.load[0]?.();
    await h.settle();
    const staff = panel(h, 'aihdFolderAccessPanel');
    expect(staff?.text).toContain('SECRET-NAME');
    staff?.findAll((element) => element.text === '終了')[0]?.listeners.click?.[0]?.({});
    await h.settle();
    expect(staff?.text).not.toContain('SECRET-NAME');
  });
});
