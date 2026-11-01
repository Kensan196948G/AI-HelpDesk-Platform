import { z } from 'zod';

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

const SYMPTOM_RULES: { tag: SymptomTag; category: CaseCategory; pattern: RegExp }[] = [
  {
    tag: 'folder_missing',
    category: 'storage',
    pattern: /フォルダ.{0,12}(見つか[らり]|ない|消え)/,
  },
  { tag: 'file_missing', category: 'storage', pattern: /ファイル.{0,12}(見つか[らり]|ない|消え)/ },
  {
    tag: 'storage_full',
    category: 'storage',
    pattern: /容量|空き|ディスク.{0,8}(いっぱい|不足)|disk full|storage/i,
  },
  { tag: 'save_failed', category: 'storage', pattern: /保存(でき|に失敗)/ },
  { tag: 'print_failed', category: 'printing', pattern: /印刷|プリンタ|プリント|スプーラ|print/i },
  { tag: 'vpn_failed', category: 'network', pattern: /VPN/i },
  {
    tag: 'network_down',
    category: 'network',
    pattern: /ネットワーク|つながら|Wi-?Fi|インターネット|オフライン/i,
  },
  { tag: 'password_reset', category: 'account', pattern: /パスワード|password/i },
  { tag: 'login_failed', category: 'account', pattern: /ログイン|サインイン|login|sign.?in/i },
  {
    tag: 'app_crash',
    category: 'software',
    pattern: /(アプリ|ソフト).{0,12}(落ち|起動しない|固まる)|クラッシュ/,
  },
  { tag: 'slow', category: 'performance', pattern: /重い|遅い|動作が遅|slow/i },
];

export interface CaseFacts {
  caseCategory: CaseCategory;
  symptomTags: SymptomTag[];
  purpose: CasePurpose;
}

const REQUESTER_ROLES = new Set(['', 'user', 'employee']);

const MessageSchema = z
  .object({
    text: z.unknown().optional(),
    content: z.unknown().optional(),
    role: z.unknown().optional(),
    from: z.unknown().optional(),
  })
  .passthrough();

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
      const parsed = MessageSchema.safeParse(raw);
      if (!parsed.success) continue;
      const role = String(parsed.data.role ?? parsed.data.from ?? '').toLowerCase();
      // AI や担当者の発言を症状として数えない。
      if (!REQUESTER_ROLES.has(role)) continue;
      parts.push(...strings(parsed.data.text, parsed.data.content));
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
      const count = step.output?.fileCount;
      if (typeof count === 'number' && count > 0) facts.add('FOLDER_HAS_ENTRIES');
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
    const tags = tagsFromText((row.keywords ?? []).join('\n')).filter((tag) =>
      caseTags.includes(tag),
    );
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
