import type { Category } from './pc.js';

export interface CategoryMeta {
  label: string;
  shortLabel: string;
  description: string;
  pcDefault: boolean;
  handoffGroup: string;
  examples: string[];
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  pc_network: {
    label: 'PC・周辺機器・ネットワーク',
    shortLabel: 'PC・ネットワーク',
    description: '印刷できない / VPN / 音が出ない / 遅い',
    pcDefault: true,
    handoffGroup: 'IT端末',
    examples: ['印刷ができません', 'VPNにつながらない', 'Teamsの音が出ない', 'PCが遅い・容量不足'],
  },
  account: {
    label: 'アカウント・ログイン',
    shortLabel: 'アカウント',
    description: 'ログインできない / MFA / 機種変更',
    pcDefault: true,
    handoffGroup: 'ID・アクセス権',
    examples: ['ログインできません', '機種変更でMFAを再登録したい'],
  },
  file_share: {
    label: 'ファイル・共有フォルダ',
    shortLabel: 'ファイル',
    description: '共有フォルダ / 同期 / 写真整理 / 集計',
    pcDefault: true,
    handoffGroup: 'ID・アクセス権',
    examples: ['共有フォルダが開けません', 'DirectCloudの同期が止まる', '工事写真の名前を揃えたい'],
  },
  procedure: {
    label: '社内の手続き・規程',
    shortLabel: '手続き',
    description: '経費精算 / 人事異動 / ヒヤリハット',
    pcDefault: false,
    handoffGroup: '業務・規程',
    examples: ['経費精算の手順を確認したい', '人事異動の手続を知りたい'],
  },
  security: {
    label: 'セキュリティの心配',
    shortLabel: 'セキュリティ',
    description: '不審メール / ウイルス / 紛失・盗難',
    pcDefault: true,
    handoffGroup: 'セキュリティ事故',
    examples: ['不審なメールを開いてしまった', 'PCを紛失した'],
  },
  other: {
    label: 'その他・相談',
    shortLabel: 'その他',
    description: '生成AIの使い方 / 現場の通信 / その他',
    pcDefault: false,
    handoffGroup: 'AI窓口',
    examples: ['生成AIの使い方を知りたい', '現場で通信できない'],
  },
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_META) as Category[];

export const ROLE_LABELS = {
  requester: '相談者',
  helpdesk: 'ヘルプデスク',
  approver: '承認者',
} as const;

export const SIGNAL_LABELS = {
  blue: '青 / AIで進行',
  amber: '黄 / 担当者対応',
  red: '赤 / AI対象外',
} as const;

export const CASE_STATUS_LABELS = {
  draft: '下書き',
  awaiting_decision: 'AI一次対応',
  ai_resolved: 'AIで解決',
  handoff_pending: '引継ぎ待ち',
  in_progress: '担当者対応中',
  knowledge_pending: 'ナレッジ化・承認待ち',
  completed: '完了',
  cancelled: '取消',
} as const;

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORY_KEYS as string[]).includes(value);
}
