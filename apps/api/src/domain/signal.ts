import type { Category, SignalColor } from './pc.js';

const SECURITY_KEYWORDS = [
  '不審',
  'ウイルス',
  '感染',
  '紛失',
  '盗難',
  'フィッシング',
  '詐欺',
  '情報漏えい',
  'マルウェア',
  'ランサム',
];

export function hasSecurityConcern(text: string): boolean {
  return SECURITY_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function initialSignal(input: {
  category: Category;
  urgency: 'normal' | 'urgent';
  subject: string;
  body: string;
}): SignalColor {
  if (input.category === 'security') return 'red';
  if (input.urgency === 'urgent') return 'red';
  if (hasSecurityConcern(`${input.subject}\n${input.body}`)) return 'red';
  return 'blue';
}

export function signalAfterAssessment(
  current: SignalColor,
  options: { recommendHandoff: boolean },
): SignalColor {
  if (current === 'red') return 'red';
  return options.recommendHandoff ? 'amber' : 'blue';
}

export function signalAfterHandoff(current: SignalColor): SignalColor {
  return current === 'red' ? 'red' : 'amber';
}

export function signalAfterResolution(current: SignalColor): SignalColor {
  return current === 'red' ? 'red' : 'blue';
}

export const SIGNAL_RULES_TEXT = [
  '青: AIで進められる（案内・読み取り診断・元に戻せる軽い修復）',
  '黄: 担当者の対応が必要（解決しない・引継ぎ・根拠なし）',
  '赤: AIに任せない（セキュリティ・急ぎ）。初動案内のみ',
] as const;
