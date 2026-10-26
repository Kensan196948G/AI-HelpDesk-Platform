import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./assist-bridge.js', import.meta.url), 'utf8');

interface AssistBridge {
  version: number;
  rspDeepLink: (c: unknown) => string;
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
