import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');

type Timer = { fn: () => void; ms: number; cleared: boolean };

/** 応答しない fetch を持つ画面を作る。タイマーは手動で進める。 */
function createSandbox(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const timers: Timer[] = [];
  const toasts: string[] = [];
  const store = new Map([['mirai-wizard-v31-cowork', JSON.stringify({ v: 31, n: 1 })]]);
  const sandbox: Record<string, unknown> = {
    console,
    Promise,
    AbortController,
    JSON,
    Object,
    Error,
    String,
    Date,
    encodeURIComponent,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: Timer | null) => {
      if (timer) timer.cleared = true;
    },
    setInterval: () => 0,
    fetch: fetchImpl,
    toast: (message: string) => toasts.push(message),
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
    document: {
      addEventListener: () => {},
      querySelector: () => null,
      documentElement: { setAttribute: () => {} },
    },
  };
  sandbox.window = { __AIHD_BOOT__: {}, addEventListener: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const debug = (sandbox.window as { __AIHD_SYNC_DEBUG__: { sync(force: boolean): void } })
    .__AIHD_SYNC_DEBUG__;
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  return { debug, timers, toasts, fire };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('bridge.js の状態の保存', () => {
  it('応答の無い保存は 15 秒で打ち切り、利用者に知らせて次の保存を止めない', async () => {
    const calls: string[] = [];
    let hang = true;
    const { debug, toasts, fire } = createSandbox((url, init) => {
      calls.push(url);
      if (!hang) return Promise.resolve({ ok: true, status: 200 });
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    debug.sync(true);
    await flush();
    expect(calls).toEqual(['/api/state/cowork']);
    expect(toasts).toEqual([]);

    fire(15_000);
    await flush();
    expect(toasts).toEqual(['状態を保存できませんでした。接続が戻るまで再試行します。']);

    // 打ち切りの後は、次の同期で送り直せる（待たされたままにならない）。
    hang = false;
    debug.sync(false);
    await flush();
    expect(calls).toEqual(['/api/state/cowork', '/api/state/cowork']);
  });

  it('応答があれば打ち切りのタイマーを解除し、失敗を表示しない', async () => {
    const { debug, toasts, timers } = createSandbox(() =>
      Promise.resolve({ ok: true, status: 200 }),
    );
    debug.sync(true);
    await flush();
    const abortTimers = timers.filter((t) => t.ms === 15_000);
    expect(abortTimers).toHaveLength(1);
    expect(abortTimers[0]?.cleared).toBe(true);
    expect(toasts).toEqual([]);
  });
});
