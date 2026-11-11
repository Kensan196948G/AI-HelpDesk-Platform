import type { Category, SignalColor } from './pc.js';
import { redactPII } from './pii.js';
import { hasSecurityConcern, initialSignal } from './signal.js';

/**
 * 代行受付の入力チェック（ルールベース・参考）。
 *
 * セキュリティの判定は `domain/signal.ts`、個人情報は `domain/pii.ts` の
 * 既存規則をそのまま使う。ここで新しい検出規則を作らない。
 * AI は呼ばない（入力のたびに実 AI を呼ぶと費用がかかるため。docs/92 §3-1 #7）。
 */
export interface IntakePreviewInput {
  subject: string;
  body: string;
  /** 画面の分野。セキュリティだけ signal の初期色に効く。 */
  category?: Category;
  urgency?: 'normal' | 'urgent';
}

export interface IntakePreviewNote {
  level: 'red' | 'warn' | 'info';
  text: string;
}

export interface IntakePreviewResult {
  signal: SignalColor;
  security: boolean;
  pii: Array<{ type: string; count: number }>;
  missing: { subject: boolean; body: boolean; bodyShort: boolean };
  notes: IntakePreviewNote[];
}

const BODY_SHORT = 10;

export function previewIntake(input: IntakePreviewInput): IntakePreviewResult {
  const subject = String(input.subject || '');
  const body = String(input.body || '');
  const category = input.category ?? 'other';
  const urgency = input.urgency ?? 'normal';
  const security = hasSecurityConcern(subject + '\n' + body);
  const findings = redactPII(subject + '\n' + body).findings;
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.type, (counts.get(finding.type) ?? 0) + finding.count);
  }
  const pii = [...counts].map(([type, count]) => ({ type, count }));
  const missing = {
    subject: subject.trim().length === 0,
    body: body.trim().length === 0,
    bodyShort: body.trim().length > 0 && body.trim().length < BODY_SHORT,
  };
  const signal = initialSignal({ category, urgency, subject, body });

  const notes: IntakePreviewNote[] = [];
  if (security || signal === 'red') {
    notes.push({
      level: 'red',
      text: 'セキュリティ事象・急ぎの可能性があります。AIを通さず、担当者へ回してください。',
    });
  }
  if (pii.length) {
    notes.push({
      level: 'warn',
      text:
        '個人情報らしき文字があります（' +
        pii.map((item) => labelOf(item.type) + ' ' + item.count + '件').join('、') +
        '）。伏せ字にしてからAIに渡します。',
    });
  }
  if (missing.subject) notes.push({ level: 'info', text: '件名が空です。' });
  if (missing.body) notes.push({ level: 'info', text: '内容が空です。' });
  else if (missing.bodyShort) {
    notes.push({
      level: 'info',
      text: '内容が短いです（いつから・何をしたら・どうなるかを書くと伝わります）。',
    });
  }
  if (!notes.length) {
    notes.push({ level: 'info', text: '大きな問題は見つかりませんでした。' });
  }

  return { signal, security, pii, missing, notes };
}

function labelOf(type: string): string {
  return (
    {
      password: 'パスワード',
      email: 'メールアドレス',
      phone: '電話番号',
      ip: 'IPアドレス',
      card: 'カード番号',
      asset: '資産番号',
      device: '端末情報',
    }[type] || type
  );
}
