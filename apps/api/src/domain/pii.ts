export interface PiiFinding {
  type: 'password' | 'email' | 'phone' | 'ip' | 'card' | 'asset';
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: PiiFinding[];
}

// 全角の数字・記号でも検出できるよう、文字クラスに全角を含める（本文は変換しない）。
const D = '[0-9０-９]';
const SEP = '[-‐－ 　]?';

const RULES: Array<{ type: PiiFinding['type']; pattern: RegExp; replacement: string }> = [
  {
    type: 'password',
    pattern: new RegExp(
      [
        // 「パスワード: xxx」「pass=xxx」「PW：xxx」など区切り記号つき
        '(?:password|passwd|pass|pwd|pw|パスワード|暗証番号)\\s*(?:は|:|：|=|＝)\\s*[^\\s、。]{3,}',
        // 「パスワード abc123」のように空白だけで続く場合は、数字を含む英数字記号の語に限定する
        // （「パスワード 変更方法を教えて」のような通常の相談文は伏せない）。
        '(?:password|パスワード|暗証番号)[ 　]+(?=[!-~]*[0-9])[!-~]{4,}',
      ].join('|'),
      'gi',
    ),
    replacement: '[パスワード]',
  },
  {
    type: 'email',
    pattern: /[A-Z0-9._%+-]+[@＠][A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: '[メールアドレス]',
  },
  {
    type: 'phone',
    pattern: new RegExp(
      [
        // 国際表記 +81
        `[+＋]81${SEP}${D}{1,4}${SEP}${D}{1,4}${SEP}${D}{3,4}(?!${D})`,
        // 国内表記（ハイフン・空白・全角）
        `(?<!${D})[0０]${D}{1,4}${SEP}${D}{1,4}${SEP}${D}{3,4}(?!${D})`,
      ].join('|'),
      'g',
    ),
    replacement: '[電話番号]',
  },
  {
    type: 'ip',
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    replacement: '[IPアドレス]',
  },
  {
    type: 'ip',
    // IPv6（完全表記、または :: 省略表記）。時刻（10:30:00）は :: を含まないため対象外。
    pattern:
      /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?)(?![0-9a-f:])/gi,
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
    if (count > 0) {
      const existing = findings.find((finding) => finding.type === rule.type);
      if (existing) existing.count += count;
      else findings.push({ type: rule.type, count });
    }
  }

  return { text, findings };
}

export function maskSensitivePcValue(key: string, value: string): string {
  if (key === 'ip_address') return '[IPアドレス]';
  if (key === 'serial') return '[シリアル番号]';
  if (key === 'asset_no') return '[資産番号]';
  return value;
}
