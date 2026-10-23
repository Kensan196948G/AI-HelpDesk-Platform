export type Category = 'pc_network' | 'account' | 'file_share' | 'procedure' | 'security' | 'other';

export type SignalColor = 'blue' | 'amber' | 'red';
export type PcStatus = 'normal' | 'attention' | 'abnormal';

export interface PcItem {
  category: string;
  key: string;
  label: string;
  value: string;
  status: PcStatus;
  sensitive?: boolean;
}

export interface PcConcern {
  key: string;
  label: string;
  value: string;
  status: PcStatus;
  star: boolean;
  reason: string;
}

export interface PcSnapshot {
  collectedAt: string;
  items: PcItem[];
  concerns: PcConcern[];
  source: 'demo';
}

export interface PcInput {
  category: Category;
  subject: string;
  body: string;
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  uptime_days: ['遅い', '重い', '動作', '固まる', '更新', '再起動'],
  domain_join: ['ログイン', 'サインイン', 'ロック', 'MFA', '認証'],
  mfa: ['ログイン', 'サインイン', 'MFA', '認証', '機種変更'],
  connection_type: ['VPN', 'つながる', '接続', 'ネット', '遅い', '現場'],
  vpn: ['VPN', 'つながる', '接続', 'リモート', '現場'],
  intranet_reachable: ['VPN', 'つながる', '接続', 'ネット', '開けない'],
  shared_folder: ['共有', 'フォルダ', 'ファイルサーバ', 'アクセス', '保存'],
  memory: ['遅い', '重い', '固まる'],
  disk_free: ['遅い', '重い', '容量', '空き', '保存'],
  temp_files: ['遅い', '重い', '容量', '空き'],
  antivirus: ['ウイルス', '不審', '感染', 'セキュリティ'],
  disk_encryption: ['紛失', '盗難'],
  windows_update: ['遅い', '更新', '再起動', '不具合'],
  default_printer: ['印刷', 'プリンタ', '複合機'],
  print_spooler: ['印刷', 'プリンタ', '複合機'],
  print_queue: ['印刷', 'プリンタ', '複合機'],
  audio_output: ['音', 'Teams', '聞こえない', 'スピーカー', 'ヘッドセット', 'マイク', '会議'],
  m365_apps: ['Outlook', 'Excel', 'Word', 'メール'],
  teams: ['Teams', '会議', '音'],
  vpn_client: ['VPN'],
  directcloud: ['DirectCloud', '同期'],
};

function hits(text: string, keys: string[] | undefined): boolean {
  if (!keys) return false;
  return keys.some((key) => text.toLowerCase().includes(key.toLowerCase()));
}

function item(
  category: string,
  key: string,
  label: string,
  value: string,
  status: PcStatus = 'normal',
  sensitive = false,
): PcItem {
  return { category, key, label, value, status, ...(sensitive ? { sensitive: true } : {}) };
}

/**
 * MVP 用のデモ PC 基本情報（8 分類 31 項目）。
 * 実際の端末にはアクセスしない。入力内容に応じて「気になる点」の判定だけを変える。
 */
export function buildDemoPcSnapshot(input: PcInput): PcSnapshot {
  const text = `${input.subject}\n${input.body}`;
  const category = input.category;
  const fileIssue = category === 'file_share' || hits(text, ['共有', '保存', 'アクセス拒否']);
  const printIssue = category === 'pc_network' && hits(text, ['印刷', 'プリンタ', '複合機']);
  const audioIssue = hits(text, ['音', 'Teams', '聞こえない', 'スピーカー', 'ヘッドセット']);
  const vpnNegative =
    /VPN[^。\n]{0,30}(つながらない|未接続|切れ|接続できない|繋がらない|使えない)/i.test(text);
  const vpnPositive =
    /VPN[^。\n]{0,30}(接続しています|接続中|つながっています|繋がっています)/i.test(text);
  const vpnIssue =
    vpnNegative || (!vpnPositive && category === 'pc_network' && hits(text, ['VPN']));
  const storageIssue = hits(text, ['容量', '空き', '保存']);
  const securityIssue = category === 'security';
  const loginIssue = category === 'account';

  const items: PcItem[] = [
    item('端末', 'asset_no', '資産番号', 'PC-0241', 'normal', true),
    item('端末', 'model', '機種', "Let's note FV4", 'normal'),
    item('端末', 'serial', 'シリアル番号', 'SN-9F2C-41A7', 'normal', true),
    item('端末', 'os', 'OS（ビルド）', 'Windows 11 23H2 (22631.4169)', 'normal'),
    item('端末', 'uptime_days', '前回の再起動から', '18日', 'attention'),
    item('端末', 'agent', 'PCエージェント', '署名あり / 読み取りのみ', 'normal'),

    item('アカウント', 'signed_in_user', 'サインイン中の人', '山田 太郎', 'normal'),
    item(
      'アカウント',
      'domain_join',
      'ドメイン・Entra ID',
      loginIssue ? 'Entra ID 未参加' : 'mirai.local / Entra ID 参加済み',
      loginIssue ? 'attention' : 'normal',
    ),
    item('アカウント', 'mfa', '多要素認証', '登録済み', 'normal'),

    item('ネットワーク', 'connection_type', '接続の種類', 'Wi-Fi（社内）', 'normal'),
    item('ネットワーク', 'ip_address', 'IPアドレス', '10.20.30.41', 'normal', true),
    item(
      'ネットワーク',
      'vpn',
      'VPN',
      vpnIssue ? '未接続' : '接続中',
      vpnIssue ? 'attention' : 'normal',
    ),
    item(
      'ネットワーク',
      'intranet_reachable',
      '社内ポータルへの到達',
      vpnIssue ? '到達できない' : '到達できる',
      vpnIssue ? 'abnormal' : 'normal',
    ),
    item(
      'ネットワーク',
      'shared_folder',
      '共有フォルダ',
      fileIssue ? 'アクセス権なし' : 'アクセスできる',
      fileIssue ? 'abnormal' : 'normal',
    ),

    item('リソース', 'cpu', 'CPU使用率（5分平均）', '18%', 'normal'),
    item('リソース', 'memory', 'メモリ使用率', '62%', 'normal'),
    item(
      'リソース',
      'disk_free',
      'ディスクの空き',
      fileIssue || storageIssue ? '12.4GB' : '86.1GB',
      fileIssue || storageIssue ? 'abnormal' : 'normal',
    ),
    item('リソース', 'temp_files', '本人の一時ファイル', '1.8GB', 'normal'),

    item(
      'セキュリティ',
      'antivirus',
      'ウイルス対策',
      securityIssue ? '要確認' : '有効',
      securityIssue ? 'attention' : 'normal',
    ),
    item('セキュリティ', 'disk_encryption', 'ディスク暗号化', '有効', 'normal'),
    item(
      'セキュリティ',
      'windows_update',
      'Windows Update',
      securityIssue ? '緊急更新 3件' : '再起動待ち 2件',
      'attention',
    ),

    item(
      '周辺機器',
      'default_printer',
      '既定のプリンター',
      printIssue ? '複合機-3F（オフライン）' : '複合機-3F',
      printIssue ? 'attention' : 'normal',
    ),
    item(
      '周辺機器',
      'print_spooler',
      '印刷スプーラ',
      printIssue ? '停止' : '稼働中',
      printIssue ? 'abnormal' : 'normal',
    ),
    item(
      '周辺機器',
      'print_queue',
      '印刷キュー',
      printIssue ? 'エラー 2件' : '0件',
      printIssue ? 'attention' : 'normal',
    ),
    item(
      '周辺機器',
      'audio_output',
      '音声の出力先',
      audioIssue ? 'モニター（HDMI）' : 'ヘッドセット',
      audioIssue ? 'attention' : 'normal',
    ),
    item('周辺機器', 'usb_devices', 'USB機器', '3台', 'normal'),

    item('ソフトウェア', 'm365_apps', 'Microsoft 365 Apps', '16.0.18324', 'normal'),
    item('ソフトウェア', 'teams', 'Teams', '24124.2402', 'normal'),
    item('ソフトウェア', 'vpn_client', 'VPNクライアント', '7.2.1', 'normal'),
    item('ソフトウェア', 'directcloud', 'DirectCloudドライブ', '3.4.0 / 同期中', 'normal'),

    item('最近のエラー', 'recent_errors', 'アプリ・システムのエラー（24時間）', '2件', 'normal'),
  ];

  const concerns: PcConcern[] = items
    .filter((it) => it.status !== 'normal')
    .map((it) => ({
      key: it.key,
      label: it.label,
      value: it.value,
      status: it.status,
      star: hits(text, CATEGORY_KEYWORDS[it.key]),
      reason: hits(text, CATEGORY_KEYWORDS[it.key])
        ? '相談内容に関係しそうです'
        : '状態を確認してください',
    }))
    .sort((a, b) => {
      if (a.star !== b.star) return a.star ? -1 : 1;
      if (a.status !== b.status) return a.status === 'abnormal' ? -1 : 1;
      return a.label.localeCompare(b.label, 'ja');
    });

  return {
    collectedAt: new Date().toISOString(),
    items,
    concerns,
    source: 'demo',
  };
}
