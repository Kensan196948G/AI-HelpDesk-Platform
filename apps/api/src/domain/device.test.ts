import { describe, expect, it } from 'vitest';
import {
  agentInputToInventory,
  browserInputToInventory,
  buildCasePcSnapshot,
  buildDeviceAiContext,
  buildPrototypeDeviceSnapshot,
  mergeDeviceInventories,
} from './device.js';

const BROWSER = browserInputToInventory({
  deviceId: 'browser-test-1',
  platform: 'Windows',
  os: 'Windows 11 (15.0.0)',
  arch: 'x86 64-bit',
  browser: {
    name: 'Google Chrome',
    version: '141.0.0',
    userAgent: 'Mozilla/5.0',
    languages: ['ja-JP'],
    timezone: 'Asia/Tokyo',
  },
  hardware: {
    cpuCores: 8,
    deviceMemoryGB: 16,
    screen: { width: 1920, height: 1080, pixelRatio: 1.25, colorDepth: 24 },
    gpu: { vendor: 'Intel', name: 'Iris Xe Graphics' },
    storage: { quotaBytes: 500 * 1024 ** 3, usageBytes: 100 * 1024 ** 3 },
    battery: { level: 0.8, charging: true },
    network: { online: true, effectiveType: '4g', downlinkMbps: 50, rttMs: 30 },
    mediaDevices: { audioOutput: 2, audioInput: 1, videoInput: 1 },
  },
  software: { pdfViewer: true, cookiesEnabled: true },
  collectedAt: '2026-10-23T06:00:00.000Z',
});

const AGENT = agentInputToInventory({
  deviceId: 'agent-test-1',
  hostname: 'PC-TEST-01',
  os: 'Windows 11 Pro 23H2',
  platform: 'Windows',
  arch: 'x86 64-bit',
  hardware: {
    serial: 'SN-123456',
    assetNo: 'PC-9999',
    model: 'Let’s note FV4',
    manufacturer: 'Panasonic',
    domainJoined: 'ドメイン参加済み（mirai.local）',
    cpu: { model: 'Intel Core i7-1365U', logicalCores: 12, usagePercent: 24 },
    memory: { totalBytes: 32 * 1024 ** 3, usagePercent: 55 },
    disks: [{ mount: 'C:', totalBytes: 512 * 1024 ** 3, freeBytes: 120 * 1024 ** 3 }],
    gpu: [{ name: 'Intel Iris Xe', vendor: 'Intel', driver: '31.0.101' }],
    network: {
      adapters: [{ name: 'FortiClient VPN', status: 'up', vpn: true }],
      ipv4: ['10.20.30.41'],
      online: true,
    },
    battery: { levelPercent: 80, charging: true },
    mediaDevices: { audioOutput: 2 },
    printers: [{ name: '複合機-3F', status: 'Normal', jobs: 0 }],
    printSpooler: '実行中',
    usbDevices: 3,
    uptimeSeconds: 3 * 86400,
    tempBytes: 2 * 1024 ** 3,
  },
  software: [
    { name: 'Microsoft Teams', version: '25.1.0', publisher: 'Microsoft' },
    { name: 'FortiClient VPN', version: '7.2.1', publisher: 'Fortinet' },
    { name: 'Microsoft 365 Apps', version: '16.0.18324', publisher: 'Microsoft' },
  ],
  security: {
    antivirus: { enabled: true, name: 'Microsoft Defender' },
    diskEncryption: { enabled: true, detail: 'BitLocker' },
    windowsUpdate: { pending: 0 },
    recentErrors: 1,
  },
  collectedAt: '2026-10-23T06:05:00.000Z',
});

describe('device domain', () => {
  it('ブラウザ取得の実PC情報を既存の31項目構造へ変換する', () => {
    const snapshot = buildPrototypeDeviceSnapshot(BROWSER);
    expect(snapshot.at).toBe('2026-10-23T06:00:00.000Z');
    expect(snapshot.device).toMatch(/^WEB-/);
    expect(snapshot.items.length).toBeGreaterThanOrEqual(31);
    const byLabel = new Map(snapshot.items.map((item) => [item.k, item.v]));
    expect(byLabel.get('OS')).toContain('Windows 11');
    expect(byLabel.get('CPU使用率（5分平均）')).toContain('8');
    expect(byLabel.get('メモリ使用率')).toContain('16.0 GB');
    expect(byLabel.get('ブラウザ')).toContain('Google Chrome');
    expect(byLabel.get('GPU')).toContain('Intel');
    expect(byLabel.get('Teams')).toBe('端末エージェント未導入');
    expect(byLabel.get('PCエージェント')).toContain('ブラウザ取得');
  });

  it('エージェント情報をマージし、導入ソフトと実ハード情報を反映する', () => {
    const merged = mergeDeviceInventories(BROWSER, AGENT);
    if (!merged) throw new Error('merge failed');
    expect(merged.source).toBe('agent');
    expect(merged.software.length).toBe(3);
    const snapshot = buildPrototypeDeviceSnapshot(merged);
    const byLabel = new Map(snapshot.items.map((item) => [item.k, item.v]));
    expect(snapshot.device).toBe('PC-TEST-01');
    expect(byLabel.get('PCエージェント')).toContain('エージェント接続済み');
    expect(byLabel.get('Teams')).toContain('Microsoft Teams');
    expect(byLabel.get('VPNクライアント')).toContain('FortiClient');
    expect(byLabel.get('Microsoft 365 Apps')).toContain('Microsoft 365');
    expect(byLabel.get('ディスクの空き')).toContain('120.0 GB');
    expect(byLabel.get('ウイルス対策')).toContain('有効');
    expect(byLabel.get('インストール済みソフト')).toBe('3件');
    expect(byLabel.get('コンピュータ名')).toBe('PC-TEST-01');
  });

  it('表示に空欄・「未取得」を残さず、コンピュータ名を表示する', () => {
    const snapshot = buildPrototypeDeviceSnapshot(BROWSER);
    const empty = snapshot.items.filter((item) => !item.v.trim() || item.v.includes('未取得'));
    expect(empty).toEqual([]);
    expect(snapshot.items.find((item) => item.k === 'コンピュータ名')?.v).toBe(
      '未検出（ブラウザ）',
    );
    expect(snapshot.items.some((item) => item.k === '資産番号')).toBe(false);
  });

  it('未導入・未検出（不明）の項目を「気になる点」に数えない', () => {
    const snapshot = buildPrototypeDeviceSnapshot(BROWSER);
    const concerns = snapshot.items.filter((item) => item.lv !== 'ok');
    expect(
      concerns.filter((item) => item.v.includes('未導入') || item.v.includes('未検出')),
    ).toEqual([]);
    // セキュリティ系の語（ウイルス対策など）が気になる点として引継ぎ文に入らない
    expect(concerns.some((item) => item.k === 'ウイルス対策')).toBe(false);
  });

  it('案件用の PcSnapshot に変換し、気になる点を判定する', () => {
    const pc = buildCasePcSnapshot(AGENT, {
      subject: 'Teams が重い',
      body: 'Teams の会議中に動作が重くなります',
    });
    expect(pc.source).toBe('agent');
    expect(pc.items.length).toBeGreaterThanOrEqual(31);
    const device = pc.items.find((item) => item.key === 'hostname');
    expect(device?.label).toBe('コンピュータ名');
    expect(device?.value).toBe('PC-TEST-01');
    expect(device?.sensitive).toBeUndefined();
    expect(pc.items.some((item) => item.key === 'asset_no')).toBe(false);
    expect(Array.isArray(pc.concerns)).toBe(true);
  });

  it('AIコンテキストにはIP・シリアル・資産番号を含めない', () => {
    const merged = mergeDeviceInventories(BROWSER, AGENT);
    if (!merged) throw new Error('merge failed');
    const context = buildDeviceAiContext(merged, 'Teams の会議中に重い');
    expect(context).toContain('Teams');
    expect(context).toContain('Windows 11 Pro');
    expect(context).not.toContain('10.20.30.41');
    expect(context).not.toContain('SN-123456');
    expect(context).not.toContain('PC-9999');
    expect(context).not.toContain('kensan1969@gmail.com');
  });

  it('ブラウザ情報のみでも AI コンテキストを生成できる', () => {
    const context = buildDeviceAiContext(BROWSER, 'PC が遅い');
    expect(context).toContain('Google Chrome');
    expect(context).toContain('8 論理コア');
    expect(context).toContain('Windows 11');
  });
});
