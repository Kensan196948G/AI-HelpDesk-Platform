import type { Category, PcSnapshot, SignalColor } from './pc.js';
import { hasSecurityConcern } from './signal.js';

export interface KnowledgeLike {
  id: string;
  kbNo: string;
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords: string[];
}

export type IntentId =
  | 'security'
  | 'printing'
  | 'vpn'
  | 'audio'
  | 'storage'
  | 'login'
  | 'file_share'
  | 'procedure'
  | 'other';

export interface Intent {
  id: IntentId;
  label: string;
  keywords: string[];
}

export interface AiSource {
  id: string;
  kbNo: string;
  title: string;
}

export interface AiAssessment {
  intent: Intent;
  signal: SignalColor;
  answer: string;
  steps: string[];
  sources: AiSource[];
  recommendHandoff: boolean;
  security: boolean;
  pcSummary: string;
  ruleBased: true;
}

const INTENTS: Array<{ id: IntentId; label: string; keywords: string[] }> = [
  {
    id: 'security',
    label: 'セキュリティの心配',
    keywords: ['不審', 'ウイルス', '感染', '紛失', '盗難', 'フィッシング', '詐欺', '情報漏えい'],
  },
  { id: 'printing', label: '印刷', keywords: ['印刷', 'プリンタ', '複合機', 'スプーラ'] },
  {
    id: 'vpn',
    label: 'VPN・ネットワーク',
    keywords: ['VPN', 'つながらない', '接続', 'ネット', '通信', 'リモート'],
  },
  {
    id: 'audio',
    label: '音声・会議',
    keywords: ['音', 'Teams', '聞こえない', 'スピーカー', 'ヘッドセット', 'マイク'],
  },
  {
    id: 'storage',
    label: '容量・性能',
    // 利用者は「遅い」ではなく「遅く」「もっさり」と書くことが多い（2026-10-25 実測: 30 件中 2 件がこれで KB に到達しなかった）。
    keywords: ['容量', '空き', '遅い', '重い', '保存', 'もっさり', '固まる', 'ファン'],
  },
  {
    id: 'login',
    label: 'ログイン・アカウント',
    keywords: ['ログイン', 'サインイン', 'パスワード', 'MFA', '認証', 'ロック'],
  },
  {
    id: 'file_share',
    label: 'ファイル・共有フォルダ',
    keywords: ['共有フォルダ', 'フォルダ', 'ファイル', '同期', 'DirectCloud', 'アクセス拒否'],
  },
  { id: 'procedure', label: '手続き・規程', keywords: ['経費', '手順', '申請', '規程', '人事'] },
  { id: 'other', label: 'その他', keywords: [] },
];

/**
 * 日本語の活用差を吸収するための表層形（MVP・形態素解析なし）。
 *
 * 「遅い」で登録した語は、利用者が「遅く」と書くと部分一致しない。
 * 形容詞の連用形（い → く）だけを追加して、この取りこぼしを減らす。
 * 2 文字未満の語は誤爆するため生成しない。
 */
export function keywordForms(keyword: string): string[] {
  const base = keyword.trim().toLowerCase();
  if (base.length < 2) return [base];
  const forms = new Set<string>([base]);
  if (base.endsWith('い')) {
    const ku = `${base.slice(0, -1)}く`;
    if (ku.length >= 2) forms.add(ku);
  }
  return [...forms];
}

export function detectIntent(subject: string, body: string): Intent {
  const text = `${subject}\n${body}`.toLowerCase();
  let best: Intent = { id: 'other', label: 'その他', keywords: [] };
  let bestScore = 0;
  for (const candidate of INTENTS) {
    const score = candidate.keywords.reduce(
      (total, keyword) =>
        total + (keywordForms(keyword).some((form) => text.includes(form)) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function formatPcSummary(snapshot: PcSnapshot | null): string {
  if (!snapshot) return 'PC基本情報は取得していません。';
  const concerns = snapshot.concerns;
  if (concerns.length === 0) {
    return `PC基本情報を確認しました（${snapshot.items.length}項目）。気になる点はありません。`;
  }
  return `PC基本情報を確認しました（${snapshot.items.length}項目）。気になる点が ${concerns.length} 件あります。`;
}

const SECURITY_STEPS = [
  '端末をネットワークから切断してください（Wi-Fi / 有線を外す）。',
  '開いてしまった画面を閉じずに、送信元・件名・URL を控えてください。',
  'この画面から、セキュリティ担当へ緊急で引き継いでください。',
];

const GENERIC_STEPS: Record<IntentId, string[]> = {
  security: SECURITY_STEPS,
  printing: [
    'プリンターの電源と用紙を確認してください。',
    '印刷キューにエラーが残っていないか確認してください。',
    '改善しない場合は、担当者へ引き継いでください。',
  ],
  vpn: [
    'VPNクライアントを一度切断し、再接続してください。',
    '社内ポータルに到達できるか確認してください。',
    '改善しない場合は、接続環境とあわせて担当者へ引き継いでください。',
  ],
  audio: [
    'Teams の設定で、マイク・スピーカーが正しい機器になっているか確認してください。',
    'Windows の音声出力先をヘッドセットに変更してください。',
    '改善しない場合は、使用機器とあわせて担当者へ引き継いでください。',
  ],
  storage: [
    'ディスクの空き容量を確認してください。',
    '自分で削除してよい一時ファイルだけを整理してください。',
    '改善しない場合は、対象フォルダとあわせて担当者へ引き継いでください。',
  ],
  login: [
    'Caps Lock・テンキー・入力中の言語を確認してください。',
    'パスワードの再設定や MFA の再登録は、ID 管理者が本人確認のうえ行います。',
    'この画面から担当者へ引き継いでください。',
  ],
  file_share: [
    '共有フォルダのプロパティ →「セキュリティ」を確認してください。',
    'VPN 接続を一度切断し、再接続してください。',
    '権限変更が必要な場合は、担当者へ引き継いでください。',
  ],
  procedure: [
    '社内の手続きページや規程を確認してください。',
    '判断が必要な場合は、担当部署へ確認してください。',
  ],
  other: [
    '状況を具体的に整理してください（いつ・何を・どうしたか）。',
    '解決しない場合は、担当者へ引き継いでください。',
  ],
};

function stepsFromKnowledge(knowledge: KnowledgeLike): string[] {
  return knowledge.steps
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, '').trim())
    .filter(Boolean);
}

export function composeAssessment(input: {
  category: Category;
  subject: string;
  body: string;
  urgency: 'normal' | 'urgent';
  pc: PcSnapshot | null;
  knowledge: KnowledgeLike[];
}): AiAssessment {
  const intent = detectIntent(input.subject, input.body);
  const security =
    input.category === 'security' || hasSecurityConcern(`${input.subject}\n${input.body}`);
  const pcSummary = formatPcSummary(input.pc);
  const concerns = input.pc?.concerns ?? [];

  if (security) {
    return {
      intent,
      signal: 'red',
      answer:
        'セキュリティの心配として受け付けました。AI は判断・対処を行いません。以下の初動手順を確認し、すぐにセキュリティ担当へ引き継いでください。',
      steps: SECURITY_STEPS,
      sources: [],
      recommendHandoff: true,
      security: true,
      pcSummary,
      ruleBased: true,
    };
  }

  const best = input.knowledge[0];
  if (best) {
    const steps = stepsFromKnowledge(best);
    return {
      intent,
      signal: 'blue',
      answer: `承認済みナレッジ「${best.title}」を根拠に、次の手順を案内します。上から順に試してください。`,
      steps: steps.length > 0 ? steps : GENERIC_STEPS[intent.id],
      sources: [{ id: best.id, kbNo: best.kbNo, title: best.title }],
      recommendHandoff: false,
      security: false,
      pcSummary,
      ruleBased: true,
    };
  }

  const concernText =
    concerns.length > 0
      ? `気になる点（${concerns
          .slice(0, 3)
          .map((c) => c.label)
          .join(' / ')}）も確認しました。`
      : '';
  return {
    intent,
    signal: 'amber',
    answer: `承認済みナレッジに一致する手順が見つかりませんでした。推測で答えず、担当者へ引き継ぎます。${concernText}`,
    steps: GENERIC_STEPS[intent.id],
    sources: [],
    recommendHandoff: true,
    security: false,
    pcSummary,
    ruleBased: true,
  };
}
