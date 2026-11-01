export interface PiiFinding {
  type: 'password' | 'email' | 'phone' | 'ip' | 'card' | 'asset' | 'device';
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

/**
 * ナレッジは承認後に別の相談者の相談と外部 AI へ渡るので、相談者固有の端末情報を入れない。
 * 引継ぎ本文の節（端末・PC 基本情報・実診断の結果など）と、端末 ID、ホスト名、シリアル、
 * 社員番号形式の端末名を除く。任意のホスト名は形から判別できないので、ラベル付きの値と既知の形に限る。
 * scripts/report-state-kb-provenance.mjs に同じ規則がある（試験で一致を確かめる）。
 */
const KNOWLEDGE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /【(?:端末|PC基本情報[^】]*|実診断の結果|AIの診断結果|対応案[^】]*|添付[^】]*)】[^【]*/g,
    replacement: '',
  },
  {
    pattern:
      /(?:コンピュータ名|コンピューター名|ホスト名|hostname|シリアル番号|シリアル|serial(?: ?number)?|MACアドレス|取得日時)\s*[:：=]\s*[^\s、。／/]+/gi,
    replacement: '[端末情報]',
  },
  { pattern: /WEB-[0-9A-F]{8}(?![0-9A-F])/gi, replacement: '[端末ID]' },
  {
    pattern:
      /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi,
    replacement: '[ID]',
  },
  { pattern: /MRK-[A-Z0-9-]+/gi, replacement: '[端末名]' },
  { pattern: /(?<![A-Z0-9])MK\d{4,6}(?!\d)/gi, replacement: '[社員番号]' },
  {
    pattern: /(?<![A-Z0-9-])(?:DESKTOP|LAPTOP|WIN|WORKSTATION)-[A-Z0-9]{3,}(?![A-Z0-9-])/gi,
    replacement: '[ホスト名]',
  },
  {
    pattern:
      /(?<![\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|corp|internal|intranet)(?![\w.-])/gi,
    replacement: '[ホスト名]',
  },
  {
    pattern: /(?<![0-9A-F:-])[0-9A-F]{2}(?:[:-][0-9A-F]{2}){5}(?![0-9A-F:-])/gi,
    replacement: '[端末情報]',
  },
];

/** ナレッジの本文用の伏せ字。redactPII に端末情報の除去を足す。何度かけても結果は変わらない。 */
export function redactKnowledgeText(input: string): RedactionResult {
  const base = redactPII(input);
  let text = base.text;
  let count = 0;
  for (const rule of KNOWLEDGE_RULES) {
    text = text.replace(rule.pattern, () => {
      count += 1;
      return rule.replacement;
    });
  }
  if (count === 0) return base;
  return {
    text: text.trim(),
    findings: [...base.findings, { type: 'device', count }],
  };
}

/** 端末情報や個人情報が残っているか（承認の拒否に使う）。 */
export function containsDeviceInfo(input: string): boolean {
  return redactKnowledgeText(input).findings.length > 0;
}

/**
 * 相談者へ見せない、入力の指示についての言及を AI の回答から除く。
 * 実 AI が、入力に指示が無くてもこの定型文を出した（docs/65 §7）。
 */
export function scrubAiAnswer(answer: string): string {
  const scrubbed = answer.replace(
    /[^\n。]*入力[^\n。]*指示[^\n。]*含まれ[^\n。]*(?:従いません|従わ)[^\n。]*。?/g,
    '',
  );
  if (scrubbed === answer) return answer;
  return scrubbed.replace(/\n{3,}/g, '\n\n').trim();
}

export function maskSensitivePcValue(key: string, value: string): string {
  if (key === 'ip_address') return '[IPアドレス]';
  if (key === 'serial') return '[シリアル番号]';
  if (key === 'asset_no') return '[資産番号]';
  return value;
}
