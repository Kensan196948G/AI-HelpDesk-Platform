export interface PiiFinding {
  type: 'password' | 'email' | 'phone' | 'ip' | 'card' | 'asset';
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: PiiFinding[];
}

const RULES: Array<{ type: PiiFinding['type']; pattern: RegExp; replacement: string }> = [
  {
    type: 'password',
    pattern: /(?:password|passwd|パスワード|暗証番号)\s*(?:は|:|：|=)\s*[^\s、。]{3,}/gi,
    replacement: '[パスワード]',
  },
  {
    type: 'email',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: '[メールアドレス]',
  },
  {
    type: 'phone',
    pattern: /(?<!\d)0\d{1,4}-?\d{1,4}-?\d{3,4}(?!\d)/g,
    replacement: '[電話番号]',
  },
  {
    type: 'ip',
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    replacement: '[IPアドレス]',
  },
  {
    type: 'card',
    pattern: /(?<!\d)(?:\d[ -]?){13,16}(?!\d)/g,
    replacement: '[カード番号]',
  },
  {
    type: 'asset',
    pattern: /(?<![A-Z0-9])(?:PC|NB|SV)[-_]?\d{3,6}(?![A-Z0-9])/gi,
    replacement: '[資産番号]',
  },
];

/**
 * 相談本文・解決記録・ナレッジ下書きの保存前に PII を伏せ字にする。
 * 完全な PII 検出ではなく、MVP で扱う代表的なパターンに限定する。
 */
export function redactPII(input: string): RedactionResult {
  let text = input;
  const findings: PiiFinding[] = [];

  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, () => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) findings.push({ type: rule.type, count });
  }

  return { text, findings };
}

export function maskSensitivePcValue(key: string, value: string): string {
  if (key === 'ip_address') return '[IPアドレス]';
  if (key === 'serial') return '[シリアル番号]';
  if (key === 'asset_no') return '[資産番号]';
  return value;
}
