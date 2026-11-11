import { containsDeviceInfo, redactKnowledgeText } from './pii.js';

/**
 * ナレッジ下書きの「AI検査・指摘」（参考表示）。
 *
 * 検査の規則は、保存時の伏せ字（redactKnowledgeText）と承認時の端末情報検査
 * （containsDeviceInfo）をそのまま使う。ここで新しい判定規則は作らない。
 * 点数は参考であり、承認の可否を決めるのは保存・承認時のサーバー検査である
 * （docs/94）。
 */
export interface KnowledgeInspectInput {
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords: string[];
}

export interface KnowledgeInspectItem {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface KnowledgeInspectResult {
  score: number;
  maxScore: number;
  /** 点数は参考であること（承認の可否を決めない）。 */
  reference: true;
  redactions: Array<{ type: string; count: number }>;
  /** 承認時の検査で止まるか（保存済みの本文に対する containsDeviceInfo と同じ判定）。 */
  blocking: { deviceInfo: boolean };
  items: KnowledgeInspectItem[];
  redacted: { title: string; symptom: string; cause: string; steps: string };
}

/** UiSyncSchema と揃えた上限（超えると保存できない）。 */
export const INSPECT_LIMITS = {
  title: 160,
  symptom: 4000,
  cause: 4000,
  steps: 8000,
  keywords: 12,
  keyword: 40,
} as const;

const PII_LABEL: Record<string, string> = {
  password: 'パスワード',
  email: 'メールアドレス',
  phone: '電話番号',
  ip: 'IPアドレス',
  card: 'カード番号',
  asset: '資産番号',
  device: '端末情報',
};

export function piiLabel(type: string): string {
  return PII_LABEL[type] ?? String(type);
}

function within(value: string, limit: number): boolean {
  return value.length <= limit;
}

export function inspectKnowledgeContent(input: KnowledgeInspectInput): KnowledgeInspectResult {
  const fields = [input.title, input.symptom, input.cause, input.steps];
  const counts = new Map<string, number>();
  for (const field of fields) {
    for (const finding of redactKnowledgeText(field).findings) {
      counts.set(finding.type, (counts.get(finding.type) ?? 0) + finding.count);
    }
  }
  const redactions = [...counts].map(([type, count]) => ({ type, count }));
  const redacted = {
    title: redactKnowledgeText(input.title).text,
    symptom: redactKnowledgeText(input.symptom).text,
    cause: redactKnowledgeText(input.cause).text,
    steps: redactKnowledgeText(input.steps).text,
  };
  // 保存時に伏せ字にした後の本文で、承認時の検査（containsDeviceInfo）に通るか。
  // 保存前の文字列そのものではなく、保存後に残る本文で判定する。
  const residualDeviceInfo = [
    redacted.title,
    redacted.symptom,
    redacted.cause,
    redacted.steps,
  ].some(containsDeviceInfo);
  // キーワードは伏せ字にせず、端末情報を含む語を保存時に除く（redactKnowledgeKeywords）。
  const droppedKeywords = input.keywords.filter(containsDeviceInfo);

  const titleOk = input.title.trim().length > 0 && within(input.title, INSPECT_LIMITS.title);
  const symptomOk =
    input.symptom.trim().length > 0 && within(input.symptom, INSPECT_LIMITS.symptom);
  const causeOk = within(input.cause, INSPECT_LIMITS.cause);
  const stepsOk =
    input.steps.trim().length > 0 &&
    within(input.steps, INSPECT_LIMITS.steps) &&
    input.steps.split('\n').some((line) => line.trim().length > 0);
  const keywordsOk =
    input.keywords.length <= INSPECT_LIMITS.keywords &&
    input.keywords.every((keyword) => keyword.length <= INSPECT_LIMITS.keyword) &&
    droppedKeywords.length === 0;
  const noPii = redactions.length === 0;

  const items: KnowledgeInspectItem[] = [
    {
      key: 'title',
      label: 'タイトルが入っている（' + INSPECT_LIMITS.title + '字以内）',
      ok: titleOk,
    },
    {
      key: 'symptom',
      label: '症状が入っている（' + INSPECT_LIMITS.symptom + '字以内）',
      ok: symptomOk,
    },
    { key: 'cause', label: '原因が入っている（' + INSPECT_LIMITS.cause + '字以内）', ok: causeOk },
    {
      key: 'steps',
      label: '手順が入っている（' + INSPECT_LIMITS.steps + '字以内）',
      ok: stepsOk,
    },
    {
      key: 'pii',
      label: '個人情報・端末情報が残っていない（残っていれば保存時に伏せ字）',
      ok: noPii,
      detail: noPii
        ? undefined
        : redactions.map((item) => piiLabel(item.type) + ' ' + item.count + '件').join('、'),
    },
    {
      key: 'device',
      label: '保存後の本文が承認時の端末情報検査に通る',
      ok: !residualDeviceInfo,
      detail: residualDeviceInfo ? '保存後にも端末情報が残るため、承認時に止まります。' : undefined,
    },
    {
      key: 'keywords',
      label:
        'キーワードが' +
        INSPECT_LIMITS.keywords +
        '件以内・各' +
        INSPECT_LIMITS.keyword +
        '字以内（端末情報を含む語は保存時に除かれる）',
      ok: keywordsOk,
      detail:
        droppedKeywords.length > 0
          ? '保存時に除かれるキーワード: ' + droppedKeywords.join('、')
          : undefined,
    },
  ];

  let score = 100;
  if (!titleOk) score -= 20;
  if (!symptomOk) score -= 10;
  if (!causeOk) score -= 10;
  if (!stepsOk) score -= 20;
  score -= Math.min(18, redactions.length * 6);
  if (residualDeviceInfo) score -= 25;
  if (!keywordsOk) score -= 5;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    maxScore: 100,
    reference: true,
    redactions,
    blocking: { deviceInfo: residualDeviceInfo },
    items,
    redacted,
  };
}
