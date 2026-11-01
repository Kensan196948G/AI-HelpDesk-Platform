/**
 * 案件の内容を固定の語彙へ写像する（docs/63 §4 の AI 入力）。純関数。
 * 入力の自由文は判定にだけ使い、出力には固定の enum とコードしか含めない。
 * 辞書に無い語は捨てる。対象案件のスナップショットだけを受け取る。
 */

export const CASE_CATEGORIES = [
  'storage',
  'printing',
  'network',
  'account',
  'software',
  'performance',
  'other',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const SYMPTOM_TAGS = [
  'folder_missing',
  'file_missing',
  'storage_full',
  'save_failed',
  'print_failed',
  'network_down',
  'vpn_failed',
  'login_failed',
  'password_reset',
  'app_crash',
  'slow',
] as const;
export type SymptomTag = (typeof SYMPTOM_TAGS)[number];

export const CASE_PURPOSES = ['repair', 'diagnose', 'information', 'unknown'] as const;
export type CasePurpose = (typeof CASE_PURPOSES)[number];

export const CONFIRMED_FACTS = [
  'FOLDER_ACCESSIBLE',
  'FOLDER_HAS_ENTRIES',
  'DISK_SPACE_READ',
  'MARKER_CONFIRMED',
] as const;
export type ConfirmedFact = (typeof CONFIRMED_FACTS)[number];

const CANNOT = 'でき(ない|ません|なく)';

/**
 * 症状の辞書。話題の語だけでは数えず、問題を示す形（否定形など）に限る。
 * 「見つかりました」「容量は十分あります」のような肯定文を症状にしない。
 * keyword はナレッジのキーワード（文ではなく語）との対応に使う。
 */
const SYMPTOM_RULES: {
  tag: SymptomTag;
  category: CaseCategory;
  pattern: RegExp;
  keyword: RegExp;
}[] = [
  {
    tag: 'folder_missing',
    category: 'storage',
    pattern:
      /フォルダ.{0,8}(見つから(ない|ず)|見つかりません|見当たら(ない|ず)|見当たりません|消え(た|ました|て)|開け(ない|ません))|フォルダ(が|は)?(ない|ありません)/,
    keyword: /フォルダ/,
  },
  {
    tag: 'file_missing',
    category: 'storage',
    pattern:
      /ファイル.{0,8}(見つから(ない|ず)|見つかりません|見当たら(ない|ず)|見当たりません|消え(た|ました|て)|開け(ない|ません))|ファイル(が|は)?(ない|ありません)/,
    keyword: /ファイル/,
  },
  {
    tag: 'storage_full',
    category: 'storage',
    pattern:
      /(容量|空き).{0,8}(足り(ない|ません)|不足|少な|いっぱい|(が|は)(ない|ありません))|ディスク.{0,8}(いっぱい|不足)|disk full/i,
    keyword: /容量|空き|ディスク|disk|storage/i,
  },
  {
    tag: 'save_failed',
    category: 'storage',
    pattern: new RegExp(`保存(${CANNOT}|に失敗)`),
    keyword: /保存/,
  },
  {
    tag: 'print_failed',
    category: 'printing',
    pattern: new RegExp(
      `(印刷|プリント).{0,8}(${CANNOT}|失敗|エラー|されない|されません)|プリンタ.{0,12}(${CANNOT}|つながら|応答し(ない|ません)|動か|エラー|認識し)|スプーラ.{0,8}(エラー|停止)|print.{0,10}(fail|error)`,
      'i',
    ),
    keyword: /印刷|プリンタ|プリント|スプーラ|print/i,
  },
  {
    tag: 'vpn_failed',
    category: 'network',
    pattern: new RegExp(`VPN.{0,12}(つながら|つながりません|接続${CANNOT}|切れ|エラー|失敗)`, 'i'),
    keyword: /VPN/i,
  },
  {
    tag: 'network_down',
    category: 'network',
    pattern: new RegExp(
      `つながら(ない|ず)|つながりません|(ネットワーク|インターネット|Wi-?Fi|ネット).{0,12}(切れ|エラー|${CANNOT})|オフライン`,
      'i',
    ),
    keyword: /ネットワーク|インターネット|Wi-?Fi/i,
  },
  {
    tag: 'password_reset',
    category: 'account',
    pattern: new RegExp(
      `パスワード.{0,12}(忘れ|わから|分から|わかりません|期限|ロック|変更${CANNOT})|password.{0,12}(forgot|reset|expired)`,
      'i',
    ),
    keyword: /パスワード|password/i,
  },
  {
    tag: 'login_failed',
    category: 'account',
    pattern: new RegExp(
      `(ログイン|サインイン).{0,8}(${CANNOT}|失敗|エラー)|(login|sign.?in).{0,8}(fail|error)`,
      'i',
    ),
    keyword: /ログイン|サインイン|login|sign.?in/i,
  },
  {
    tag: 'app_crash',
    category: 'software',
    pattern: /(アプリ|ソフト).{0,12}(落ち|起動し(ない|ません)|固ま)|クラッシュ/,
    keyword: /クラッシュ|起動/,
  },
  {
    tag: 'slow',
    category: 'performance',
    pattern: /重い|遅い|動作が遅|slow/i,
    keyword: /重い|遅い|slow/i,
  },
];

export interface CaseFacts {
  caseCategory: CaseCategory;
  symptomTags: SymptomTag[];
  purpose: CasePurpose;
}

function strings(...values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string');
}

/** スナップショットの中で「この案件の相談」にあたる文だけを集める。 */
function consultationText(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const { case: target, chat } = snapshot as { case?: unknown; chat?: unknown };
  const record = (target ?? {}) as Record<string, unknown>;
  const parts = strings(record.subject, record.summary, record.body, record.symptom);
  const messages = (chat as { messages?: unknown } | null | undefined)?.messages;
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      // 本人の発言だけ（画面のメッセージは kind で区別する）。AI・案内・担当者の発言を数えない。
      const message = raw as { kind?: unknown; text?: unknown } | null;
      if (message?.kind === 'user') parts.push(...strings(message.text));
    }
  }
  return parts.join('\n').slice(0, 8000);
}

export function tagsFromText(text: string): SymptomTag[] {
  return SYMPTOM_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.tag);
}

export function buildCaseFacts(snapshot: unknown): CaseFacts {
  const text = consultationText(snapshot);
  const tags = tagsFromText(text);
  const first = SYMPTOM_RULES.find((rule) => rule.tag === tags[0]);
  let purpose: CasePurpose = 'unknown';
  if (/教えて|知りたい|方法は|確認したい/.test(text)) purpose = 'information';
  else if (/直したい|直して|解消|できない|ない|失敗/.test(text)) purpose = 'repair';
  else if (tags.length > 0) purpose = 'diagnose';
  return { caseCategory: first?.category ?? 'other', symptomTags: tags, purpose };
}

export interface VerifiedStepFact {
  skillId: string;
  verified: boolean | null;
  output: Record<string, unknown> | null;
}

/** 固定条件を満たした実行だけから、確認済み事項のコードを作る。 */
export function confirmedFacts(steps: readonly VerifiedStepFact[]): ConfirmedFact[] {
  const facts = new Set<ConfirmedFact>();
  for (const step of steps) {
    if (step.verified !== true) continue;
    if (step.skillId === 'folder.summary') {
      facts.add('FOLDER_ACCESSIBLE');
      const hasEntries = ['fileCount', 'directoryCount', 'linkCount'].some((field) => {
        const count = step.output?.[field];
        return typeof count === 'number' && count > 0;
      });
      if (hasEntries) facts.add('FOLDER_HAS_ENTRIES');
    }
    if (step.skillId === 'disk.space') facts.add('DISK_SPACE_READ');
    if (step.skillId === 'user.marker.set' || step.skillId === 'user.marker.clear') {
      facts.add('MARKER_CONFIRMED');
    }
  }
  return [...facts];
}

export interface KnowledgeRef {
  id: string;
  tags: SymptomTag[];
}

/** 承認済みナレッジの ID と固定タグ。本文・タイトルの自由文は使わない（キーワードだけを写像する）。 */
export function knowledgeRefs(
  rows: readonly { id: string; keywords: readonly string[] | null }[],
  caseTags: readonly SymptomTag[],
  limit = 5,
): KnowledgeRef[] {
  const refs: KnowledgeRef[] = [];
  for (const row of rows) {
    const words = (row.keywords ?? []).join('\n');
    const tags = SYMPTOM_RULES.filter(
      (rule) => caseTags.includes(rule.tag) && rule.keyword.test(words),
    ).map((rule) => rule.tag);
    if (tags.length > 0) refs.push({ id: row.id, tags });
    if (refs.length >= limit) break;
  }
  return refs;
}

/** 提案の理由の固定コード。表示は固定の文言にする（AI の文を使わない）。 */
export const REASON_CODES = [
  'SYMPTOM_MATCH',
  'KNOWLEDGE_REF',
  'FOLLOWS_VERIFIED_STEP',
  'VERIFICATION_SKILL',
  'AI_SELECTED',
  'RULE_BASED',
  'AI_EXPLANATION_REJECTED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const RESOLVED_CLAIM = /解決|直りました|復旧しました|修復しました|成功しました|resolved|fixed/i;

/**
 * AI の説明を採用するか。固定条件で確かめていないのに解決を示す説明は使わない。
 * 説明は常に推測として扱い、判定には使わない。
 */
export function acceptAiExplanation(
  rationale: string,
  assessment: unknown,
  lastVerified: boolean,
): { text: string | null; rejected: boolean } {
  const claimsResolved = assessment === 'resolved' || RESOLVED_CLAIM.test(rationale);
  if (claimsResolved && !lastVerified) return { text: null, rejected: true };
  return { text: rationale || null, rejected: false };
}
