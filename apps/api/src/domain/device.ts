import type { PcConcern, PcItem, PcSnapshot, PcStatus } from './pc.js';
import { redactPII } from './pii.js';

/**
 * 実端末のハードウェア・ソフトウェア情報。
 *
 * - browser: ブラウザから取得できる範囲（OS / 画面 / CPU コア / GPU / 回線 / 音声など）
 * - agent:   端末上の読み取り専用エージェントが取得する範囲（導入ソフト / セキュリティ等）
 *
 * 取得しないもの: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文。
 * 個人情報（メール・IP・シリアル・資産番号）は AI へ渡す前に伏せる。
 */

export type DeviceSource = 'browser' | 'agent';
export type DeviceLevel = 'ok' | 'warn' | 'ng';

export interface DeviceCpu {
  model?: string;
  cores?: number;
  logicalCores?: number;
  speedMHz?: number;
  usagePercent?: number;
}

export interface DeviceMemory {
  totalBytes?: number;
  freeBytes?: number;
  usagePercent?: number;
}

export interface DeviceDisk {
  name?: string;
  mount?: string;
  totalBytes?: number;
  freeBytes?: number;
  encrypted?: boolean;
}

export interface DeviceGpu {
  name?: string;
  vendor?: string;
  driver?: string;
}

export interface DeviceNetworkAdapter {
  name: string;
  type?: string;
  status?: string;
  vpn?: boolean;
}

export interface DeviceNetwork {
  adapters?: DeviceNetworkAdapter[];
  ipv4?: string[];
  online?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
}

export interface DeviceBattery {
  levelPercent?: number;
  charging?: boolean;
}

export interface DeviceScreen {
  width?: number;
  height?: number;
  pixelRatio?: number;
  colorDepth?: number;
}

export interface DeviceStorageEstimate {
  quotaBytes?: number;
  usageBytes?: number;
}

export interface DeviceMediaDevices {
  audioOutput?: number;
  audioInput?: number;
  videoInput?: number;
}

export interface DevicePrinter {
  name: string;
  status?: string;
  jobs?: number;
}

export interface DeviceHardware {
  assetNo?: string;
  serial?: string;
  model?: string;
  manufacturer?: string;
  domainJoined?: string;
  cpu?: DeviceCpu;
  memory?: DeviceMemory;
  disks?: DeviceDisk[];
  gpu?: DeviceGpu[];
  network?: DeviceNetwork;
  battery?: DeviceBattery;
  screen?: DeviceScreen;
  storage?: DeviceStorageEstimate;
  mediaDevices?: DeviceMediaDevices;
  printers?: DevicePrinter[];
  printSpooler?: string;
  audioOutput?: string;
  usbDevices?: number;
  uptimeSeconds?: number;
  tempBytes?: number;
  sharedFolder?: { path?: string; accessible?: boolean };
}

export interface DeviceBrowserInfo {
  name?: string;
  version?: string;
  userAgent?: string;
  languages?: string[];
  timezone?: string;
  pdfViewer?: boolean;
  cookiesEnabled?: boolean;
  maxTouchPoints?: number;
}

export interface DeviceSoftwareApp {
  name: string;
  version?: string;
  publisher?: string;
}

export interface DeviceSecurity {
  antivirus?: { enabled?: boolean; name?: string; signature?: string };
  diskEncryption?: { enabled?: boolean; detail?: string };
  windowsUpdate?: { pending?: number; lastInstalled?: string; detail?: string };
  firewall?: { enabled?: boolean; detail?: string };
  recentErrors?: number;
}

export interface DeviceInventoryData {
  deviceId: string;
  hostname?: string;
  os?: string;
  platform?: string;
  arch?: string;
  browser?: DeviceBrowserInfo;
  hardware: DeviceHardware;
  software: DeviceSoftwareApp[];
  security: DeviceSecurity;
  source: DeviceSource;
  collectedAt: string;
}

export interface StoredDeviceInventory {
  userEmail: string;
  source: DeviceSource;
  data: DeviceInventoryData;
  collectedAt: string;
  updatedAt?: string;
}

export interface DeviceSnapshotItem {
  grp: string;
  k: string;
  v: string;
  lv: DeviceLevel;
  note: string;
  tag: string;
  key: string;
  sensitive?: boolean;
}

/** 既存プロトタイプの pcSnapshot と互換の形。 */
export interface PrototypeDeviceSnapshot {
  at: string;
  device: string;
  userId?: string;
  items: Array<Pick<DeviceSnapshotItem, 'grp' | 'k' | 'v' | 'lv' | 'note' | 'tag'>>;
  ver: 1;
}

const GB = 1024 ** 3;

function formatGB(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '未取得';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

function formatPercent(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `${Math.round(value)}%`;
}

function formatUptime(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未取得';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days}日${hours}時間` : `${hours}時間`;
}

function join(values: Array<string | undefined>, fallback: string): string {
  const value = values
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(' ');
  return value || fallback;
}

function findApp(software: DeviceSoftwareApp[], patterns: string[]): DeviceSoftwareApp | undefined {
  return software.find((app) => {
    const name = `${app.name} ${app.publisher ?? ''}`.toLowerCase();
    return patterns.some((pattern) => name.includes(pattern));
  });
}

function appLabel(app: DeviceSoftwareApp | undefined): string {
  if (!app) return '未取得';
  return join([app.name, app.version], '取得済み');
}

function sourceLabel(hasBrowser: boolean, hasAgent: boolean): string {
  if (hasAgent && hasBrowser) return 'エージェント接続済み（ブラウザ情報も取得）';
  if (hasAgent) return 'エージェント接続済み（読み取りのみ）';
  return 'ブラウザ取得（読み取りのみ）';
}

function networkLabel(network?: DeviceNetwork): string {
  if (!network) return '未取得';
  if (network.online === false) return 'オフライン';
  const type = network.effectiveType ? `${network.effectiveType.toUpperCase()}` : 'オンライン';
  const speed =
    typeof network.downlinkMbps === 'number' ? ` / 約 ${network.downlinkMbps} Mbps` : '';
  return `ブラウザ回線: ${type}${speed}`;
}

function vpnLabel(hardware: DeviceHardware): { value: string; level: DeviceLevel } {
  const adapters = hardware.network?.adapters ?? [];
  const vpn = adapters.filter((adapter) => adapter.vpn);
  if (vpn.length === 0) {
    const anyAdapter = adapters.length > 0;
    return {
      value: anyAdapter ? 'VPN用アダプタは検出されませんでした' : '未取得（エージェント未導入）',
      level: anyAdapter ? 'ok' : 'warn',
    };
  }
  const connected = vpn.some((adapter) => (adapter.status ?? '').toLowerCase() === 'up');
  return {
    value: `${vpn.map((adapter) => adapter.name).join(' / ')}（${connected ? '接続中' : '未接続'}）`,
    level: connected ? 'ok' : 'warn',
  };
}

function diskLabel(hardware: DeviceHardware): { value: string; level: DeviceLevel; note: string } {
  const disks = hardware.disks ?? [];
  const primary = disks.find((disk) => disk.mount === '/' || disk.mount === 'C:') ?? disks[0];
  if (primary?.totalBytes) {
    const free = primary.freeBytes ?? 0;
    const ratio = primary.totalBytes > 0 ? free / primary.totalBytes : 0;
    return {
      value: `${formatGB(free)} / ${formatGB(primary.totalBytes)}（${primary.mount ?? primary.name ?? 'disk'}）`,
      level: ratio < 0.1 ? 'ng' : ratio < 0.2 ? 'warn' : 'ok',
      note:
        ratio < 0.1
          ? '空き容量がとても少なくなっています'
          : ratio < 0.2
            ? '空き容量が少なめです'
            : '',
    };
  }
  const storage = hardware.storage;
  if (storage?.quotaBytes) {
    const free = Math.max(0, storage.quotaBytes - (storage.usageBytes ?? 0));
    return {
      value: `ブラウザ領域 空き ${formatGB(free)} / ${formatGB(storage.quotaBytes)}`,
      level: 'ok',
      note: '端末全体のディスクはエージェント導入後に取得できます',
    };
  }
  return {
    value: '未取得',
    level: 'warn',
    note: 'エージェントを導入すると端末全体の空き容量を取得できます',
  };
}

function securityItems(
  security: DeviceSecurity,
  hasAgent: boolean,
  platform?: string,
): Array<{ key: string; k: string; v: string; lv: DeviceLevel; note: string; tag: string }> {
  const unavailable = hasAgent ? '未検出（エージェント）' : '未取得（エージェント未導入）';
  const unavailableNote = hasAgent
    ? '端末上で検出できませんでした'
    : 'エージェントを導入すると確認できます';
  const platformText = (platform ?? '').toLowerCase();
  const updateLabel =
    platformText.includes('linux') ||
    platformText.includes('ubuntu') ||
    platformText.includes('debian')
      ? 'OS 更新（apt）'
      : platformText.includes('mac')
        ? 'macOS 更新'
        : 'Windows Update';
  const antivirus = security.antivirus;
  const antivirusValue = antivirus
    ? antivirus.enabled === false
      ? `無効${antivirus.name ? `（${antivirus.name}）` : ''}`
      : `有効${antivirus.name ? `（${antivirus.name}）` : ''}`
    : unavailable;
  const encryption = security.diskEncryption;
  const update = security.windowsUpdate;

  return [
    {
      key: 'antivirus',
      k: 'ウイルス対策',
      v: antivirusValue,
      lv: antivirus ? (antivirus.enabled === false ? 'ng' : 'ok') : 'warn',
      note: antivirus ? '' : unavailableNote,
      tag: 'ウイルス|不審|感染|セキュリティ',
    },
    {
      key: 'disk_encryption',
      k: 'ディスク暗号化',
      v: encryption
        ? encryption.enabled === false
          ? '無効'
          : join([encryption.detail, '有効'], '有効')
        : unavailable,
      lv: encryption ? (encryption.enabled === false ? 'warn' : 'ok') : 'warn',
      note: encryption ? '' : unavailableNote,
      tag: '紛失|盗難',
    },
    {
      key: 'windows_update',
      k: updateLabel,
      v: update
        ? typeof update.pending === 'number' && update.pending > 0
          ? `更新 ${update.pending}件が再起動待ち`
          : join([update.detail, '最新'], '最新')
        : '未取得（エージェント未導入）',
      lv: update
        ? typeof update.pending === 'number' && update.pending > 0
          ? 'warn'
          : 'ok'
        : 'warn',
      note: update ? '' : unavailableNote,
      tag: '遅い|更新|再起動|不具合',
    },
  ];
}

export function buildDeviceSnapshotItems(inventory: DeviceInventoryData): DeviceSnapshotItem[] {
  const hw = inventory.hardware;
  const software = inventory.software;
  const browser = inventory.browser;
  const hasAgent = inventory.source === 'agent';
  const hasBrowser = Boolean(browser);
  const cpuCores = hw.cpu?.logicalCores ?? hw.cpu?.cores;
  const memoryTotal = hw.memory?.totalBytes;
  const memoryUsage = formatPercent(hw.memory?.usagePercent);
  const cpuUsage = formatPercent(hw.cpu?.usagePercent);
  const disks = diskLabel(hw);
  const vpn = vpnLabel(hw);
  const gpu = hw.gpu?.[0];
  const security = securityItems(inventory.security, hasAgent, inventory.platform ?? inventory.os);
  const printers = hw.printers ?? [];
  const audioDevices = hw.mediaDevices?.audioOutput ?? 0;
  const installedCount = software.length;

  const items: DeviceSnapshotItem[] = [
    {
      grp: '端末',
      key: 'asset_no',
      k: '資産番号',
      v: hw.assetNo?.trim() || '未登録',
      lv: 'ok',
      note: hw.assetNo ? '' : '端末エージェントで資産番号を取得できます',
      tag: '',
      sensitive: true,
    },
    {
      grp: '端末',
      key: 'model',
      k: '機種',
      v: join([hw.manufacturer, hw.model], '未取得'),
      lv: 'ok',
      note: hw.model ? '' : 'ブラウザからは機種名を取得できません',
      tag: '',
    },
    {
      grp: '端末',
      key: 'serial',
      k: 'シリアル番号',
      v: hw.serial?.trim() || '未取得',
      lv: 'ok',
      note: hw.serial ? '外部AIへは伏せて渡します' : '',
      tag: '',
      sensitive: true,
    },
    {
      grp: '端末',
      key: 'os',
      k: 'OS',
      v: join([inventory.os, inventory.platform, inventory.arch], '未取得'),
      lv: inventory.os ? 'ok' : 'warn',
      note: inventory.os ? '' : 'ブラウザの User-Agent から推定しています',
      tag: '',
    },
    {
      grp: '端末',
      key: 'uptime_days',
      k: '前回の再起動から',
      v: formatUptime(hw.uptimeSeconds),
      lv: typeof hw.uptimeSeconds === 'number' && hw.uptimeSeconds >= 14 * 86400 ? 'warn' : 'ok',
      note:
        typeof hw.uptimeSeconds === 'number' && hw.uptimeSeconds >= 14 * 86400
          ? '長い間再起動していません（再起動で直ることがあります）'
          : hw.uptimeSeconds === undefined
            ? 'エージェントを導入すると取得できます'
            : '',
      tag: '遅い|重い|動作|固ま|更新|再起動',
    },
    {
      grp: '端末',
      key: 'agent',
      k: 'PCエージェント',
      v: sourceLabel(hasBrowser, hasAgent),
      lv: 'ok',
      note: hasAgent ? '' : '端末エージェントを導入すると、ソフトウェア情報も取得できます',
      tag: '',
    },
    {
      grp: 'アカウント',
      key: 'signed_in_user',
      k: 'サインイン中の人',
      v: 'ログイン中のユーザー（Access 認証済み）',
      lv: 'ok',
      note: '氏名・メールアドレスはAIへ渡しません',
      tag: '',
    },
    {
      grp: 'アカウント',
      key: 'domain_join',
      k: 'ドメイン・Entra ID',
      v: hw.domainJoined?.trim() || '未取得（エージェント未導入）',
      lv: hw.domainJoined ? 'ok' : 'warn',
      note: hw.domainJoined ? '' : 'エージェントを導入すると確認できます',
      tag: 'ログイン|サインイン|ロック|MFA|認証',
    },
    {
      grp: 'アカウント',
      key: 'mfa',
      k: '多要素認証',
      v: 'Cloudflare Access（OTP）で認証済み',
      lv: 'ok',
      note: '',
      tag: 'ログイン|サインイン|MFA|認証|機種変更',
    },
    {
      grp: 'ネットワーク',
      key: 'connection_type',
      k: '接続の種類',
      v: networkLabel(hw.network),
      lv: hw.network?.online === false ? 'warn' : 'ok',
      note: '',
      tag: 'VPN|つなが|接続|ネット|遅い',
    },
    {
      grp: 'ネットワーク',
      key: 'ip_address',
      k: 'IPアドレス',
      v: hw.network?.ipv4?.[0]?.trim() || '未取得（ブラウザ）',
      lv: 'ok',
      note: hw.network?.ipv4?.length ? '外部AIへは伏せて渡します' : '',
      tag: '',
      sensitive: true,
    },
    {
      grp: 'ネットワーク',
      key: 'vpn',
      k: 'VPN',
      v: vpn.value,
      lv: vpn.level,
      note: '',
      tag: 'VPN|つなが|接続|リモート|現場',
    },
    {
      grp: 'ネットワーク',
      key: 'intranet_reachable',
      k: '社内ポータルへの到達',
      v: 'このアプリに到達（HTTPS）',
      lv: 'ok',
      note: 'ブラウザから確認できるのはこのアプリへの到達までです',
      tag: 'VPN|つなが|接続|ネット|開けない',
    },
    {
      grp: 'ネットワーク',
      key: 'shared_folder',
      k: '共有フォルダ',
      v: hw.sharedFolder
        ? `${hw.sharedFolder.path ?? '共有フォルダ'}（${hw.sharedFolder.accessible ? 'アクセスできる' : 'アクセスできない'}）`
        : '未取得（エージェント未導入）',
      lv: hw.sharedFolder ? (hw.sharedFolder.accessible ? 'ok' : 'ng') : 'warn',
      note: hw.sharedFolder ? '' : 'エージェントを導入すると確認できます',
      tag: '共有|フォルダ|ファイルサーバ|アクセス',
    },
    {
      grp: 'リソース',
      key: 'cpu',
      k: 'CPU使用率（5分平均）',
      v: cpuUsage
        ? `${cpuUsage}${cpuCores ? `（${cpuCores} 論理コア）` : ''}`
        : cpuCores
          ? `使用率は取得不可（${cpuCores} 論理コア）`
          : '未取得（ブラウザ）',
      lv: 'ok',
      note: cpuUsage ? '' : '使用率はエージェント導入後に取得できます',
      tag: '遅い|重い|固ま',
    },
    {
      grp: 'リソース',
      key: 'memory',
      k: 'メモリ使用率',
      v: memoryUsage
        ? `${memoryUsage}${memoryTotal ? `（${formatGB(memoryTotal)}）` : ''}`
        : memoryTotal
          ? `約 ${formatGB(memoryTotal)}（ブラウザ推定）`
          : '未取得（ブラウザ）',
      lv: 'ok',
      note: memoryUsage ? '' : 'ブラウザが推定した搭載メモリです',
      tag: '遅い|重い|固ま',
    },
    {
      grp: 'リソース',
      key: 'disk_free',
      k: 'ディスクの空き',
      v: disks.value,
      lv: disks.level,
      note: disks.note,
      tag: '遅い|重い|容量|空き|保存',
    },
    {
      grp: 'リソース',
      key: 'temp_files',
      k: '本人の一時ファイル',
      v: hw.tempBytes !== undefined ? formatGB(hw.tempBytes) : '未取得',
      lv: 'ok',
      note: hw.tempBytes === undefined ? 'エージェントを導入すると取得できます' : '',
      tag: '遅い|重い|容量|空き',
    },
    ...security.map((item) => ({
      grp: 'セキュリティ',
      key: item.key,
      k: item.k,
      v: item.v,
      lv: item.lv,
      note: item.note,
      tag: item.tag,
    })),
    {
      grp: '周辺機器',
      key: 'default_printer',
      k: '既定のプリンター',
      v: printers[0]?.name ?? '未取得（エージェント未導入）',
      lv: 'ok',
      note: printers[0] ? '' : 'エージェントを導入すると取得できます',
      tag: '印刷|プリンタ|複合機',
    },
    {
      grp: '周辺機器',
      key: 'print_spooler',
      k: '印刷スプーラ',
      v: hw.printSpooler ?? '未取得（エージェント未導入）',
      lv: hw.printSpooler && /停止|stop/i.test(hw.printSpooler) ? 'ng' : 'ok',
      note: hw.printSpooler ? '' : 'エージェントを導入すると取得できます',
      tag: '印刷|プリンタ|複合機',
    },
    {
      grp: '周辺機器',
      key: 'print_queue',
      k: '印刷キュー',
      v: printers.length
        ? `${printers.reduce((total, printer) => total + (printer.jobs ?? 0), 0)}件`
        : '未取得（エージェント未導入）',
      lv: 'ok',
      note: printers.length ? '' : 'エージェントを導入すると取得できます',
      tag: '印刷|プリンタ|複合機',
    },
    {
      grp: '周辺機器',
      key: 'audio_output',
      k: '音声の出力先',
      v:
        hw.audioOutput?.trim() || (audioDevices > 0 ? `ブラウザ検出 ${audioDevices} 台` : '未取得'),
      lv: 'ok',
      note: audioDevices > 0 ? 'ブラウザから検出した音声出力デバイス数です' : '',
      tag: '音|Teams|聞こえ|スピーカー|ヘッドセット|マイク|会議',
    },
    {
      grp: '周辺機器',
      key: 'usb_devices',
      k: 'USB機器',
      v: hw.usbDevices !== undefined ? `${hw.usbDevices}台` : '未取得',
      lv: 'ok',
      note: hw.usbDevices === undefined ? 'エージェントを導入すると取得できます' : '',
      tag: '',
    },
    {
      grp: 'ソフトウェア',
      key: 'm365_apps',
      k: 'Microsoft 365 Apps',
      v: appLabel(findApp(software, ['microsoft 365', 'microsoft office', 'office16', 'office'])),
      lv: 'ok',
      note: installedCount === 0 ? 'エージェントを導入すると導入ソフトを取得できます' : '',
      tag: 'Outlook|Excel|Word|メール',
    },
    {
      grp: 'ソフトウェア',
      key: 'teams',
      k: 'Teams',
      v: appLabel(findApp(software, ['teams'])),
      lv: 'ok',
      note: installedCount === 0 ? 'エージェントを導入すると導入ソフトを取得できます' : '',
      tag: 'Teams|会議|音',
    },
    {
      grp: 'ソフトウェア',
      key: 'vpn_client',
      k: 'VPNクライアント',
      v: appLabel(
        findApp(software, ['vpn', 'forticlient', 'anyconnect', 'globalprotect', 'openvpn']),
      ),
      lv: 'ok',
      note: installedCount === 0 ? 'エージェントを導入すると導入ソフトを取得できます' : '',
      tag: 'VPN',
    },
    {
      grp: 'ソフトウェア',
      key: 'directcloud',
      k: 'DirectCloudドライブ',
      v: appLabel(findApp(software, ['directcloud'])),
      lv: 'ok',
      note: installedCount === 0 ? 'エージェントを導入すると導入ソフトを取得できます' : '',
      tag: 'DirectCloud|同期',
    },
    {
      grp: '最近のエラー',
      key: 'recent_errors',
      k: 'アプリ・システムのエラー（24時間）',
      v:
        inventory.security.recentErrors !== undefined
          ? `${inventory.security.recentErrors}件`
          : '未取得（エージェント未導入）',
      lv:
        typeof inventory.security.recentErrors === 'number' && inventory.security.recentErrors >= 8
          ? 'warn'
          : 'ok',
      note:
        inventory.security.recentErrors === undefined
          ? 'エージェントを導入すると取得できます'
          : inventory.security.recentErrors >= 8
            ? 'エラーの記録がいつもより多めです'
            : '',
      tag: '',
    },
    {
      grp: 'ソフトウェア',
      key: 'browser',
      k: 'ブラウザ',
      v: join([browser?.name, browser?.version], '未取得'),
      lv: 'ok',
      note: browser?.userAgent ? `User-Agent: ${browser.userAgent.slice(0, 120)}` : '',
      tag: '',
    },
    {
      grp: 'ソフトウェア',
      key: 'screen',
      k: '画面',
      v:
        hw.screen?.width && hw.screen.height
          ? `${hw.screen.width} × ${hw.screen.height}（${hw.screen.pixelRatio ?? 1}x / ${hw.screen.colorDepth ?? 24}bit）`
          : '未取得',
      lv: 'ok',
      note: '',
      tag: '',
    },
    {
      grp: 'ソフトウェア',
      key: 'gpu',
      k: 'GPU',
      v: gpu ? join([gpu.vendor, gpu.name], '取得済み') : '未取得（ブラウザ）',
      lv: 'ok',
      note: gpu?.driver ? `ドライバ: ${gpu.driver}` : '',
      tag: '遅い|重い|画面',
    },
    {
      grp: 'ソフトウェア',
      key: 'installed_software',
      k: 'インストール済みソフト',
      v: installedCount > 0 ? `${installedCount}件` : '未取得（エージェント未導入）',
      lv: 'ok',
      note:
        installedCount > 0
          ? software
              .slice(0, 6)
              .map((app) => `${app.name}${app.version ? ` ${app.version}` : ''}`)
              .join(' / ')
          : 'エージェントを導入すると導入ソフトの一覧を取得できます',
      tag: '',
    },
  ];

  return items;
}

export function buildPrototypeDeviceSnapshot(
  inventory: DeviceInventoryData,
  userId?: string,
): PrototypeDeviceSnapshot {
  const items = buildDeviceSnapshotItems(inventory);
  const device =
    inventory.hostname?.trim() ||
    (inventory.deviceId ? `WEB-${inventory.deviceId.slice(0, 8).toUpperCase()}` : 'UNKNOWN');
  return {
    at: inventory.collectedAt,
    device,
    ...(userId ? { userId } : {}),
    items: items.map((item) => ({
      grp: item.grp,
      k: item.k,
      v: item.v,
      lv: item.lv,
      note: item.note,
      tag: item.tag,
    })),
    ver: 1,
  };
}

const STATUS_MAP: Record<DeviceLevel, PcStatus> = {
  ok: 'normal',
  warn: 'attention',
  ng: 'abnormal',
};

export function buildCasePcSnapshot(
  inventory: DeviceInventoryData,
  input: { subject: string; body: string },
): PcSnapshot {
  const text = `${input.subject}\n${input.body}`;
  const snapshotItems = buildDeviceSnapshotItems(inventory);
  const items: PcItem[] = snapshotItems.map((item) => ({
    category: item.grp,
    key: item.key,
    label: item.k,
    value: item.v,
    status: STATUS_MAP[item.lv],
    ...(item.sensitive ? { sensitive: true } : {}),
  }));
  const concerns: PcConcern[] = snapshotItems
    .filter((item) => item.lv !== 'ok')
    .map((item) => {
      const star = Boolean(item.tag) && new RegExp(item.tag, 'i').test(text);
      return {
        key: item.key,
        label: item.k,
        value: item.v,
        status: STATUS_MAP[item.lv],
        star,
        reason: star ? '相談内容に関係しそうです' : '状態を確認してください',
      };
    })
    .sort((a, b) => {
      if (a.star !== b.star) return a.star ? -1 : 1;
      if (a.status !== b.status) return a.status === 'abnormal' ? -1 : 1;
      return a.label.localeCompare(b.label, 'ja');
    });

  return {
    collectedAt: inventory.collectedAt,
    items,
    concerns,
    source: inventory.source,
  };
}

function mergeHardware(
  browser: DeviceHardware | undefined,
  agent: DeviceHardware | undefined,
): DeviceHardware {
  return {
    ...(browser ?? {}),
    ...(agent ?? {}),
    cpu: { ...(browser?.cpu ?? {}), ...(agent?.cpu ?? {}) },
    memory: { ...(browser?.memory ?? {}), ...(agent?.memory ?? {}) },
    network: { ...(browser?.network ?? {}), ...(agent?.network ?? {}) },
    screen: { ...(browser?.screen ?? {}), ...(agent?.screen ?? {}) },
    battery: { ...(browser?.battery ?? {}), ...(agent?.battery ?? {}) },
    storage: { ...(browser?.storage ?? {}), ...(agent?.storage ?? {}) },
    mediaDevices: { ...(browser?.mediaDevices ?? {}), ...(agent?.mediaDevices ?? {}) },
    disks: agent?.disks?.length ? agent.disks : browser?.disks,
    gpu: agent?.gpu?.length ? agent.gpu : browser?.gpu,
    printers: agent?.printers?.length ? agent.printers : browser?.printers,
  };
}

export function mergeDeviceInventories(
  browser: DeviceInventoryData | null,
  agent: DeviceInventoryData | null,
): DeviceInventoryData | null {
  if (!browser && !agent) return null;
  if (!browser) return agent;
  if (!agent) return browser;
  const collectedAt =
    Date.parse(agent.collectedAt) >= Date.parse(browser.collectedAt)
      ? agent.collectedAt
      : browser.collectedAt;
  return {
    deviceId: agent.deviceId || browser.deviceId,
    hostname: agent.hostname ?? browser.hostname,
    os: agent.os ?? browser.os,
    platform: agent.platform ?? browser.platform,
    arch: agent.arch ?? browser.arch,
    browser: browser.browser,
    hardware: mergeHardware(browser.hardware, agent.hardware),
    software: agent.software.length > 0 ? agent.software : browser.software,
    security: { ...(browser.security ?? {}), ...(agent.security ?? {}) },
    source: 'agent',
    collectedAt,
  };
}

export interface BrowserInventoryInput {
  deviceId: string;
  platform?: string;
  os?: string;
  arch?: string;
  browser?: DeviceBrowserInfo;
  hardware?: {
    cpuCores?: number;
    deviceMemoryGB?: number;
    screen?: DeviceScreen;
    gpu?: DeviceGpu;
    storage?: DeviceStorageEstimate;
    battery?: { level?: number; charging?: boolean };
    network?: DeviceNetwork;
    mediaDevices?: DeviceMediaDevices;
  };
  software?: { pdfViewer?: boolean; cookiesEnabled?: boolean };
  collectedAt?: string;
}

export function browserInputToInventory(input: BrowserInventoryInput): DeviceInventoryData {
  const hardwareInput = input.hardware ?? {};
  return {
    deviceId: input.deviceId,
    platform: input.platform,
    os: input.os,
    arch: input.arch,
    browser: {
      ...(input.browser ?? {}),
      ...(input.software?.pdfViewer !== undefined ? { pdfViewer: input.software.pdfViewer } : {}),
      ...(input.software?.cookiesEnabled !== undefined
        ? { cookiesEnabled: input.software.cookiesEnabled }
        : {}),
    },
    hardware: {
      cpu: {
        logicalCores: hardwareInput.cpuCores,
      },
      memory: {
        totalBytes:
          typeof hardwareInput.deviceMemoryGB === 'number'
            ? hardwareInput.deviceMemoryGB * GB
            : undefined,
      },
      screen: hardwareInput.screen,
      gpu: hardwareInput.gpu ? [hardwareInput.gpu] : undefined,
      storage: hardwareInput.storage,
      battery: {
        levelPercent:
          typeof hardwareInput.battery?.level === 'number'
            ? hardwareInput.battery.level * 100
            : undefined,
        charging: hardwareInput.battery?.charging,
      },
      network: hardwareInput.network,
      mediaDevices: hardwareInput.mediaDevices,
    },
    software: [],
    security: {},
    source: 'browser',
    collectedAt: input.collectedAt ?? new Date().toISOString(),
  };
}

export interface AgentInventoryInput {
  deviceId: string;
  hostname?: string;
  os?: string;
  platform?: string;
  arch?: string;
  hardware?: DeviceHardware;
  software?: DeviceSoftwareApp[];
  security?: DeviceSecurity;
  collectedAt?: string;
}

export function agentInputToInventory(input: AgentInventoryInput): DeviceInventoryData {
  return {
    deviceId: input.deviceId,
    hostname: input.hostname,
    os: input.os,
    platform: input.platform,
    arch: input.arch,
    hardware: input.hardware ?? {},
    software: (input.software ?? []).slice(0, 300),
    security: input.security ?? {},
    source: 'agent',
    collectedAt: input.collectedAt ?? new Date().toISOString(),
  };
}

/**
 * DeepSeek に渡す PC 基本情報。IP・シリアル・資産番号・ユーザー名は含めない。
 * 導入ソフトは相談内容に関係するものを優先し、最大 20 件に絞る。
 */
export function buildDeviceAiContext(inventory: DeviceInventoryData, question: string): string {
  const hw = inventory.hardware;
  const items = buildDeviceSnapshotItems(inventory);
  const concerns = items.filter((item) => item.lv !== 'ok');
  const normalizedQuestion = question.toLowerCase();
  const softwareKeywords = [
    'teams',
    'outlook',
    'excel',
    'word',
    'office',
    'vpn',
    'forticlient',
    'anyconnect',
    'globalprotect',
    'directcloud',
    'onedrive',
    'chrome',
    'edge',
    'ブラウザ',
  ];
  const relevantSoftware = inventory.software
    .filter((app) => {
      const name = `${app.name} ${app.publisher ?? ''}`.toLowerCase();
      return (
        softwareKeywords.some(
          (keyword) => normalizedQuestion.includes(keyword) || name.includes(keyword),
        ) || app.name.toLowerCase().includes('microsoft')
      );
    })
    .slice(0, 20);
  const software = relevantSoftware.length > 0 ? relevantSoftware : inventory.software.slice(0, 10);
  const softwareLines = software.map(
    (app) => `- ${app.name}${app.version ? ` ${app.version}` : ''}`,
  );

  const lines = [
    'PC基本情報（読み取りのみ。ファイル内容・閲覧履歴・画面・キー入力は含まない）',
    `- 取得元: ${inventory.source === 'agent' ? '端末エージェント + ブラウザ' : 'ブラウザ'}`,
    `- 取得日時: ${inventory.collectedAt}`,
    `- 端末: ${inventory.hostname ?? '未取得'}`,
    `- OS: ${inventory.os ?? inventory.platform ?? '未取得'} ${inventory.arch ?? ''}`.trim(),
    `- ブラウザ: ${inventory.browser?.name ?? '未取得'}${inventory.browser?.version ? ` ${inventory.browser.version}` : ''}`,
    `- CPU: ${hw.cpu?.model ?? '未取得'}${hw.cpu?.logicalCores ? ` / ${hw.cpu.logicalCores} 論理コア` : ''}${hw.cpu?.usagePercent !== undefined ? ` / 使用率 ${formatPercent(hw.cpu.usagePercent)}` : ''}`,
    `- メモリ: ${hw.memory?.totalBytes ? formatGB(hw.memory.totalBytes) : '未取得'}${hw.memory?.usagePercent !== undefined ? ` / 使用率 ${formatPercent(hw.memory.usagePercent)}` : ''}`,
    `- ディスク: ${diskLabel(hw).value}`,
    `- GPU: ${hw.gpu?.[0] ? join([hw.gpu[0].vendor, hw.gpu[0].name], '取得済み') : '未取得'}`,
    `- ネットワーク: ${networkLabel(hw.network)} / VPN: ${vpnLabel(hw).value}`,
    `- セキュリティ: ウイルス対策=${inventory.security.antivirus ? (inventory.security.antivirus.enabled === false ? '無効' : '有効') : '未取得'} / ディスク暗号化=${inventory.security.diskEncryption ? (inventory.security.diskEncryption.enabled === false ? '無効' : '有効') : '未取得'} / 更新待ち=${inventory.security.windowsUpdate?.pending ?? '未取得'}`,
    `- 導入ソフト: ${inventory.source === 'agent' ? `${inventory.software.length}件` : '未取得'}（関連 ${software.length}件）`,
    ...softwareLines,
    concerns.length > 0
      ? `- 気になる点: ${concerns.map((item) => `${item.k}=${item.v}`).join(' / ')}`
      : '- 気になる点: なし',
  ];
  const context = lines.filter(Boolean).join('\n');
  return redactPII(context).text.slice(0, 6000);
}
