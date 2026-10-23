import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./device-bridge.js', import.meta.url), 'utf8');

interface SnapshotItem {
  grp: string;
  k: string;
  v: string;
  lv: string;
  note: string;
  tag: string;
}

interface DebugApi {
  ensureSnapshot(force: boolean): Promise<unknown>;
  state: { snapshot: { device: string; items: SnapshotItem[] } | null };
}

function createSandbox(failFetch: boolean) {
  const store = new Map<string, string>();
  let pcStartCalls = 0;
  const remoteSnapshot = {
    at: '2026-10-23T07:00:00.000Z',
    device: 'PC-MOCK',
    items: [
      { grp: '端末', k: 'OS', v: 'Windows 11 (mock)', lv: 'ok', note: '', tag: '' },
      { grp: 'ソフトウェア', k: 'Teams', v: '未取得', lv: 'ok', note: '', tag: '' },
    ],
    ver: 1,
  };
  const response = (body: unknown) => ({ ok: true, json: async () => body });
  const sandbox: Record<string, unknown> = {
    console,
    Promise,
    setTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Intl,
    fetch: async (url: unknown) => {
      if (failFetch) throw new Error('network down');
      if (String(url).includes('/api/device/browser')) {
        return response({
          ok: true,
          snapshot: remoteSnapshot,
          inventory: { source: 'browser', softwareCount: 0 },
        });
      }
      if (String(url).includes('/api/device/inventory')) {
        return response({
          ok: true,
          snapshot: remoteSnapshot,
          inventory: { source: 'browser', softwareCount: 0 },
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    },
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key) : null),
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    navigator: {
      userAgentData: {
        platform: 'Windows',
        brands: [{ brand: 'Google Chrome', version: '141' }],
        getHighEntropyValues: async () => ({
          platformVersion: '15.0.0',
          architecture: 'x86',
          bitness: '64',
          uaFullVersion: '141.0.0',
          fullVersionList: [{ brand: 'Google Chrome', version: '141.0.0' }],
        }),
      },
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 Chrome/141',
      hardwareConcurrency: 8,
      deviceMemory: 16,
      languages: ['ja-JP'],
      maxTouchPoints: 0,
      onLine: true,
      connection: { effectiveType: '4g', downlink: 50, rtt: 30 },
      pdfViewerEnabled: true,
      cookieEnabled: true,
      storage: { estimate: async () => ({ quota: 500 * 1024 ** 3, usage: 100 * 1024 ** 3 }) },
      getBattery: async () => ({ level: 0.8, charging: true }),
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audiooutput', deviceId: 'a' },
          { kind: 'audiooutput', deviceId: 'b' },
          { kind: 'audioinput', deviceId: 'c' },
        ],
      },
    },
    document: {
      createElement: () => ({ getContext: () => null }),
      querySelector: () => null,
      documentElement: {},
    },
    crypto: { randomUUID: () => 'mock-uuid-1234' },
    MODELS: { local: 'old', external: 'old' },
    pcSnapshot: (_state: unknown, userId: string) => ({
      device: 'DEMO',
      userId,
      items: [{ k: 'demo' }],
      ver: 1,
    }),
    pcStart: () => {
      pcStartCalls += 1;
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'device-bridge.js' });
  return { sandbox, getPcStartCalls: () => pcStartCalls };
}

describe('device bridge', () => {
  it('サーバーが返した実PCスナップショットを pcSnapshot に差し込む', async () => {
    const { sandbox, getPcStartCalls } = createSandbox(false);
    const debug = sandbox.__AIHD_DEVICE_DEBUG__ as DebugApi;
    await debug.ensureSnapshot(true);

    const snapshot = (
      sandbox.pcSnapshot as (
        state: unknown,
        userId: string,
      ) => {
        device: string;
        userId: string;
        items: SnapshotItem[];
      }
    )({}, 'u2');
    expect(snapshot.device).toBe('PC-MOCK');
    expect(snapshot.userId).toBe('u2');
    expect(snapshot.items[0]?.v).toContain('Windows 11');
    expect((sandbox.MODELS as { local: string }).local).toBe('DeepSeek-V4.1-Flash');

    (sandbox.pcStart as (value: unknown) => void)({ id: 'case-1' });
    expect(getPcStartCalls()).toBe(1);
  });

  it('サーバーに届かない場合はブラウザ取得のローカルスナップショットを使う', async () => {
    const { sandbox } = createSandbox(true);
    const debug = sandbox.__AIHD_DEVICE_DEBUG__ as DebugApi;
    await debug.ensureSnapshot(true);

    const snapshot = (
      sandbox.pcSnapshot as (
        state: unknown,
        userId: string,
      ) => {
        device: string;
        userId: string;
        items: SnapshotItem[];
      }
    )({}, 'u3');
    expect(snapshot.device).toMatch(/^WEB-/);
    expect(snapshot.userId).toBe('u3');
    expect(snapshot.items.length).toBeGreaterThan(10);
    expect(snapshot.items.find((item) => item.k === 'OS')?.v).toContain('Windows 11');
  });
});
