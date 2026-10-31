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

type RouteReply = { status: number; body: unknown };

function harness(
  routes: (url: string, init?: RequestInit) => RouteReply | Promise<RouteReply>,
  caseRef: { current: Record<string, unknown> } = {
    current: { id: 'CASE-1', handoverId: '11111111-1111-4111-8111-111111111111' },
  },
  clock: { offsetMs: number } = { offsetMs: 0 },
) {
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
    curCase: () => caseRef.current,
    Date: class extends Date {
      static now() {
        return Date.now() + clock.offsetMs;
      }
    },
    encodeURIComponent,
    console,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const { status, body: json } = await routes(url, init);
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

  it('404 なら何も描画せず、しばらく問い合わせないが、時間を置いて再開する', async () => {
    const clock = { offsetMs: 0 };
    let enabled = false;
    const h = harness(
      (url) => {
        if (!enabled) return notFound;
        if (url.includes('/mine')) {
          return { status: 200, body: { requests: [{ ...requestDto('active'), caseId: 'C' }] } };
        }
        return notFound;
      },
      undefined,
      clock,
    );
    h.load[0]?.();
    await h.settle();
    expect(panel(h, 'aihdFolderAccessMinePanel')).toBeUndefined();
    const staff = panel(h, 'aihdFolderAccessPanel');
    expect(staff?.style.display).toBe('none');
    const before = h.calls.filter((call) => call.includes('/mine')).length;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(h.calls.filter((call) => call.includes('/mine')).length).toBe(before);

    // 一度の 404 で止まらない。
    enabled = true;
    clock.offsetMs = 120_000;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(h.calls.filter((call) => call.includes('/mine')).length).toBeGreaterThan(before);
    expect(panel(h, 'aihdFolderAccessMinePanel')).toBeDefined();
  });

  it('相談者パネル: 一時的な失敗の後に成功すればエラーを消す', async () => {
    let failing = true;
    const h = harness((url) => {
      if (url.includes('/mine')) {
        return failing
          ? { status: 500, body: { error: { message: 'TEMPORARY-FAILURE' } } }
          : { status: 200, body: { requests: [{ ...requestDto('active'), caseId: 'C' }] } };
      }
      return notFound;
    });
    h.load[0]?.();
    await h.settle();
    failing = false;
    for (const timer of h.timers) timer();
    await h.settle();
    const mine = panel(h, 'aihdFolderAccessMinePanel');
    expect(mine?.text).toBeDefined();
    expect(mine?.text).not.toContain('TEMPORARY-FAILURE');
  });

  it('担当者パネル: 一時的な失敗ではエラーを見せ、終了ボタンを残す', async () => {
    let failing = false;
    const h = harness((url) => {
      if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
      if (failing) return { status: 503, body: { error: { message: 'TEMPORARY-FAILURE' } } };
      return { status: 200, body: { request: requestDto('consent_pending') } };
    });
    h.load[0]?.();
    await h.settle();
    const staff = panel(h, 'aihdFolderAccessPanel') as FakeElement;
    expect(staff.style.display).toBe('');
    failing = true;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(staff.style.display).toBe('');
    expect(staff.text).toContain('TEMPORARY-FAILURE');
    const buttons = staff.findAll((element) => element.tag === 'button');
    expect(buttons.some((button) => button.text.includes('終了'))).toBe(true);

    // 回復すればエラーを消す。
    failing = false;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(staff.text).not.toContain('TEMPORARY-FAILURE');
  });

  it('担当者パネル: 引継ぎは受信箱ではなく専用の検索で引く（resolved や 51 件目以降でも消えない）', async () => {
    const handoverId = '11111111-1111-4111-8111-111111111111';
    const h = harness(
      (url) => {
        if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
        if (url.includes('/folder-access/handovers/lookup')) {
          return { status: 200, body: { ok: true, handoverId } };
        }
        if (url.includes('/case-handovers/inbox')) throw new Error('受信箱へ問い合わせない');
        return { status: 200, body: { request: requestDto('active') } };
      },
      { current: { id: 'INC-0001' } },
    );
    h.load[0]?.();
    await h.settle();
    expect(h.calls.some((call) => call.includes('lookup?ref=INC-0001'))).toBe(true);
    expect(panel(h, 'aihdFolderAccessPanel')?.style.display).toBe('');
  });

  it('担当者パネル: 案件を切り替えると、前の案件の端末 ID とホスト名を送らない', async () => {
    const handoverA = '11111111-1111-4111-8111-11111111111a';
    const handoverB = '11111111-1111-4111-8111-11111111111b';
    const caseRef = {
      current: { id: 'CASE-A', handoverId: handoverA } as Record<string, unknown>,
    };
    const posted: Record<string, unknown>[] = [];
    const h = harness((url, init) => {
      if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return { status: 200, body: { request: requestDto('device_pending') } };
      }
      return { status: 200, body: { request: requestDto('device_pending') } };
    }, caseRef);
    h.load[0]?.();
    await h.settle();
    const staff = panel(h, 'aihdFolderAccessPanel') as FakeElement;
    const inputs = staff.findAll((element) => element.tag === 'input');
    inputs[0]?.listeners.input?.[0]?.({
      target: { value: '33333333-3333-4333-8333-333333333333' },
    });
    inputs[1]?.listeners.input?.[0]?.({ target: { value: 'HOST-OF-CASE-A' } });

    caseRef.current = { id: 'CASE-B', handoverId: handoverB };
    for (const timer of h.timers) timer();
    await h.settle();
    const retry = staff
      .findAll((element) => element.tag === 'button')
      .find((button) => button.text.includes('再確認')) as FakeElement;
    retry.listeners.click?.[0]?.({});
    await h.settle();
    expect(posted.at(-1)).toEqual({ handoverId: handoverB });
  });

  it('担当者でなければ（403）担当者パネルを出さない', async () => {
    const h = harness((url) =>
      url.includes('/mine')
        ? { status: 200, body: { requests: [] } }
        : { status: 403, body: { error: { code: 'FORBIDDEN', message: 'x' } } },
    );
    h.load[0]?.();
    await h.settle();
    expect(panel(h, 'aihdFolderAccessPanel')?.style.display).toBe('none');
    expect(panel(h, 'aihdFolderAccessPanel')?.children).toEqual([]);
    // 担当者でない画面から定期的に 403 を出さない。
    const before = h.calls.filter((call) => call.includes('/folder-access/requests')).length;
    for (const timer of h.timers) timer();
    await h.settle();
    expect(h.calls.filter((call) => call.includes('/folder-access/requests')).length).toBe(before);
  });

  it('担当者パネル: 結果を textContent で描画し、ファイル名を HTML として解釈しない', async () => {
    const xss = '<img src=x onerror=alert(1)>.txt';
    const h = harness((url) => {
      if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
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
      if (url.includes('/mine')) return { status: 200, body: { requests: [dto] } };
      return notFound;
    });
    h.load[0]?.();
    await h.settle();
    const mine = panel(h, 'aihdFolderAccessMinePanel');
    expect(mine?.text).toContain('8 桁のコード');
    expect(mine?.findAll((element) => element.attrs.placeholder === '8 桁のコード')).toHaveLength(
      1,
    );

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
        return { status: 200, body: { requests: [requestDto('consent_pending')] } };
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

  it('相談者パネル: 進行中の依頼を全件表示し、それぞれを取り消せる', async () => {
    const older = {
      ...requestDto('active', {
        scope: { root: 'Desktop', segments: [], expiresAt: '2026-10-31T01:00:00Z' },
      }),
      id: '33333333-3333-4333-8333-333333333333',
      caseId: 'CASE-OLD',
    };
    const newer = { ...requestDto('consent_pending'), caseId: 'CASE-NEW' };
    const posts: string[] = [];
    const h = harness((url, init) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return { status: 200, body: { ok: true } };
      }
      if (url.includes('/mine')) return { status: 200, body: { requests: [newer, older] } };
      return notFound;
    });
    h.load[0]?.();
    await h.settle();
    const mine = panel(h, 'aihdFolderAccessMinePanel');
    expect(mine?.text).toContain('2 件');
    expect(mine?.text).toContain('CASE-OLD');
    expect(mine?.text).toContain('CASE-NEW');
    mine
      ?.findAll((element) => element.tag === 'button' && element.text === '今すぐ取り消す')[0]
      ?.listeners.click?.[0]?.({});
    await h.settle();
    expect(posts).toEqual([`/api/folder-access/requests/${older.id}/revoke`]);
    mine
      ?.findAll((element) => element.tag === 'button' && element.text === '拒否する')[0]
      ?.listeners.click?.[0]?.({});
    await h.settle();
    expect(posts[1]).toBe(`/api/folder-access/requests/${newer.id}/revoke`);
  });

  describe('案件の切り替え中に届いた古い応答', () => {
    const handoverA = 'aaaaaaaa-0000-4000-8000-000000000000';
    const handoverB = 'bbbbbbbb-0000-4000-8000-000000000000';
    const dtoFor = (user: string) =>
      requestDto('consent_pending', {
        id: user === 'user-a' ? 'req-a' : 'req-b',
        windowsUser: user,
      });

    function switching(extra?: (url: string, init?: RequestInit) => RouteReply | null) {
      const caseRef = {
        current: { id: 'CASE-A', handoverId: handoverA } as Record<string, unknown>,
      };
      let release: (reply: RouteReply) => void = () => {};
      let hold = false;
      const h = harness((url, init) => {
        if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.includes(handoverB)) return { status: 200, body: { request: dtoFor('user-b') } };
        if (hold && url.includes(handoverA)) {
          return new Promise<RouteReply>((resolve) => {
            release = resolve;
          });
        }
        return { status: 200, body: { request: dtoFor('user-a') } };
      }, caseRef);
      return {
        h,
        caseRef,
        holdNext: () => {
          hold = true;
        },
        releaseWith: (reply: RouteReply) => release(reply),
      };
    }

    it('案件 A の取得中に B へ切り替えると、A の結果で B を上書きしない', async () => {
      const t = switching();
      t.holdNext();
      t.h.load[0]?.();
      await t.h.settle();
      const staff = panel(t.h, 'aihdFolderAccessPanel');

      t.caseRef.current = { id: 'CASE-B', handoverId: handoverB };
      t.h.timers[0]?.();
      await t.h.settle();
      expect(staff?.text).toContain('user-b');

      t.releaseWith({ status: 200, body: { request: dtoFor('user-a') } });
      await t.h.settle();
      expect(staff?.text).toContain('user-b');
      expect(staff?.text).not.toContain('user-a');
    });

    it('切り替え直後（再読込の前）に届いた A の応答も捨てる', async () => {
      const t = switching();
      t.holdNext();
      t.h.load[0]?.();
      await t.h.settle();
      const staff = panel(t.h, 'aihdFolderAccessPanel');
      t.caseRef.current = { id: 'CASE-B', handoverId: handoverB };
      t.releaseWith({ status: 200, body: { request: dtoFor('user-a') } });
      await t.h.settle();
      expect(staff?.text ?? '').not.toContain('user-a');
    });

    it('A の失敗（500）を B のエラーとして表示しない', async () => {
      const t = switching();
      t.holdNext();
      t.h.load[0]?.();
      await t.h.settle();
      const staff = panel(t.h, 'aihdFolderAccessPanel');
      t.caseRef.current = { id: 'CASE-B', handoverId: handoverB };
      t.h.timers[0]?.();
      await t.h.settle();
      t.releaseWith({ status: 500, body: { error: { message: 'A-FAILED' } } });
      await t.h.settle();
      expect(staff?.text).toContain('user-b');
      expect(staff?.text).not.toContain('A-FAILED');
    });

    it('A の終了操作の応答で B の依頼を上書きしない', async () => {
      let releaseEnd: (reply: RouteReply) => void = () => {};
      const t = switching((_url, init) =>
        init?.method === 'POST'
          ? (new Promise<RouteReply>((resolve) => {
              releaseEnd = resolve;
            }) as unknown as RouteReply)
          : null,
      );
      t.h.load[0]?.();
      await t.h.settle();
      const staff = panel(t.h, 'aihdFolderAccessPanel');
      staff
        ?.findAll((element) => element.tag === 'button' && element.text === '終了')[0]
        ?.listeners.click?.[0]?.({});
      await t.h.settle();

      t.caseRef.current = { id: 'CASE-B', handoverId: handoverB };
      t.h.timers[0]?.();
      await t.h.settle();
      releaseEnd({
        status: 200,
        body: {
          request: requestDto('ended', { windowsUser: 'user-a', endReason: 'operator_end' }),
        },
      });
      await t.h.settle();
      expect(staff?.text).toContain('user-b');
      expect(staff?.text).not.toContain('user-a');
    });
  });

  it('担当者パネル: 終了すると結果をメモリからも破棄する', async () => {
    let status = 'active';
    const h = harness((url, init) => {
      if (url.includes('/mine')) return { status: 200, body: { requests: [] } };
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
