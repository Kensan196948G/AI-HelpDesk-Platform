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

const CANNOT = 'でき(ない|ません|なく|なかった)';

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
      /フォルダ.{0,8}(見つから(ない|ず)|見つかりません|見当たら(ない|ず)|見当たりません|消え(た|ました|て)|開け(ない|ません|なかった))|フォルダ(が|は)?(ない|ありません)/,
    keyword: /フォルダ/,
  },
  {
    tag: 'file_missing',
    category: 'storage',
    pattern:
      /ファイル.{0,8}(見つから(ない|ず)|見つかりません|見当たら(ない|ず)|見当たりません|消え(た|ました|て)|開け(ない|ません|なかった))|ファイル(が|は)?(ない|ありません)/,
    keyword: /ファイル/,
  },
  {
    tag: 'storage_full',
    category: 'storage',
    pattern:
      /(容量|空き).{0,8}(足り(ない|ません)|不足|少な|いっぱい)|(容量|空き)(容量)?(が|は)(ない|ありません)|ディスク.{0,8}(いっぱい|不足)|disk full/i,
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
      `(印刷|プリント).{0,8}(${CANNOT}|失敗|エラー|されない|されません)|プリンタ.{0,12}(${CANNOT}|つながら(ない|ず|なかった)|つながりません|応答し(ない|ません)|動か(ない|ず|なかった)|動きません|エラー|認識し(ない|ません|なかった))|スプーラ.{0,8}(エラー|停止)|print.{0,10}(fail|error)`,
      'i',
    ),
    keyword: /印刷|プリンタ|プリント|スプーラ|print/i,
  },
  {
    tag: 'vpn_failed',
    category: 'network',
    pattern: new RegExp(
      `VPN.{0,12}(つながら(ない|ず|なかった)|つながりません|接続${CANNOT}|切れ|エラー|失敗)`,
      'i',
    ),
    keyword: /VPN/i,
  },
  {
    tag: 'network_down',
    category: 'network',
    pattern: new RegExp(
      `つながら(ない|ず|なかった)|つながりません|(ネットワーク|インターネット|Wi-?Fi|ネット).{0,12}(切れ|エラー|${CANNOT})|オフライン`,
      'i',
    ),
    keyword: /ネットワーク|インターネット|Wi-?Fi/i,
  },
  {
    tag: 'password_reset',
    category: 'account',
    pattern: new RegExp(
      `パスワード.{0,12}(忘れ|わから(ない|なく|ず)|分から(ない|なく|ず)|わかりません|分かりません|期限|ロック|変更${CANNOT})|password.{0,12}(forgot|reset|expired)`,
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
    pattern: /(アプリ|ソフト).{0,12}(落ち|起動し(ない|ません)|固ま(る|り|った|って))|クラッシュ/,
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

function sentencesOf(text: string): string[] {
  return text.split(/[。．！？!?\n]+/).filter((sentence) => sentence.trim().length > 0);
}

/**
 * 節へ分ける。辞書の `.{0,12}` が別の節の語へ届かないようにするため。
 * 助詞の「が」（容量が足りません）では切らず、活用語尾に続く逆接の「が」だけで切る。
 */
function clausesOf(sentence: string): string[] {
  return sentence
    .replace(/([がはもをにでと])[、，,]\s*/g, '$1')
    .split(/[、，,]|(?<=[ただすんるい])が|けれども|けれど|けど|のに|ものの/)
    .filter((clause) => clause.trim().length > 0);
}

/** 一致の直後が打ち消しなら症状にしない（「エラーはありません」「消えていません」）。 */
const NEGATED_AFTER =
  /^\s*(?:[はがも]?(?:ない|なし|無し|ありません|出てい(?:ない|ません)|起きてい(?:ない|ません)|し(?:てい)?(?:ない|ません))|て?い(?:ない|ません)|て(?:ない|ません)|し(?:てい)?(?:ない|ません)|く(?:ない|ありません)|で(?:は|も)(?:ない|ありません)|じゃ(?:ない|ありません)|わけ(?:では|じゃ)(?:ない|ありません)|こと(?:は|も)(?:ない|ありません))/;

/** 時点を示す語と過去の形が揃った節は、今の症状として数えない。「昨日から」は続いているので含めない。 */
const PAST_POINT =
  /(?:昨日|一昨日|おととい|先週|先月|去年|昨年|以前|前回|先日|今朝|午前中)(?:は|には|まで|の時は|のときは)|(?:さっき|先ほど|この前|前|今まで)(?:は|まで)/;
const PAST_FORM = /なかった|ませんでした|でした|だった|ていた|ていました/;
const STILL = /今も|いまも|現在も|まだ|依然|ずっと|相変わらず/;

/** それだけで解消を述べる表現。語が無ければ、同じ文か、対象が 1 つに決まるときだけ効く。 */
const RESOLVED =
  /(?:直り|治り|解決し|解消し|復旧し|回復し|修復し)(?:ました|た)|直った|治った|解決済|解消済|もう大丈夫|問題なくなり|(?:でき|つながる|動く)ようになり|(?:今|いま|現在)は?.{0,12}(?:でき(?:る|ます|て)|開け(?:る|ます)|つなが(?:る|ります|って)|動(?:く|きます|いて)|使え(?:る|ます)|見つか|問題(?:は)?(?:ない|ありません)|大丈夫|正常)/;
/** 今は動くという表現。語か同じ文の症状が無ければ、何が動いたのか分からないので効かせない。 */
const WORKING =
  /でき(?:ました|た)|(?:つながり|見つかり|開け|開き|起動し|動き)ました|つながった|見つかった|正常|問題(?:は)?(?:ない|ありません|なし)/;

function isNegated(clause: string, pattern: RegExp): boolean {
  // 節の中のすべての一致が打ち消しのときだけ、症状なしとする。
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...clause.matchAll(new RegExp(pattern.source, flags))];
  return (
    matches.length > 0 &&
    matches.every((match) => NEGATED_AFTER.test(clause.slice(match.index + match[0].length)))
  );
}

function clauseSymptoms(clause: string): SymptomTag[] {
  return SYMPTOM_RULES.filter(
    (rule) => rule.pattern.test(clause) && !isNegated(clause, rule.pattern),
  ).map((rule) => rule.tag);
}

/** 語で対象を決める。「再起動で直りました」の「起動」はアプリの話ではない。 */
function mentionedRules(clause: string) {
  const text = clause.replace(/再起動/g, '');
  return SYMPTOM_RULES.filter((rule) => rule.keyword.test(text));
}

interface ActiveSymptoms {
  /** 症状 → それを述べた節の番号。 */
  tags: Map<SymptomTag, number>;
  /** 残った症状を述べた節。目的の判定に使う。 */
  clauses: Map<number, string>;
}

/** 文の順に読み、症状の追加と解消を反映する。辞書で決められない解消は推測で消さない。 */
function readSymptoms(text: string): ActiveSymptoms {
  const active: ActiveSymptoms = { tags: new Map(), clauses: new Map() };
  let clauseNo = 0;
  const drop = (tags: Iterable<SymptomTag>) => {
    for (const tag of tags) active.tags.delete(tag);
  };
  for (const sentence of sentencesOf(text)) {
    const sameSentence = new Set<SymptomTag>();
    for (const clause of clausesOf(sentence)) {
      clauseNo += 1;
      const question = /か\s*$/.test(clause);
      const resolved = !question && RESOLVED.test(clause);
      const working = !question && !resolved && WORKING.test(clause);
      if (!resolved && !working) {
        const past = PAST_POINT.test(clause) && PAST_FORM.test(clause) && !STILL.test(clause);
        if (past) continue;
        const tags = clauseSymptoms(clause);
        for (const tag of tags) {
          active.tags.set(tag, clauseNo);
          sameSentence.add(tag);
        }
        if (tags.length > 0) active.clauses.set(clauseNo, clause);
        continue;
      }
      const mentioned = mentionedRules(clause);
      if (mentioned.length > 0) {
        // 語で特定できる。同じ節で述べた症状（VPN の「つながらない」と network_down）も一緒に消す。
        const origins = new Set<number>();
        for (const rule of mentioned) {
          const origin = active.tags.get(rule.tag);
          if (origin !== undefined) origins.add(origin);
        }
        for (const [tag, origin] of [...active.tags]) {
          if (origins.has(origin)) active.tags.delete(tag);
        }
        continue;
      }
      if (sameSentence.size > 0) {
        drop(sameSentence);
        sameSentence.clear();
        continue;
      }
      // 別の文の「直りました」。症状が 1 つの節にしかないときだけ対象が決まる。
      if (resolved && new Set(active.tags.values()).size === 1) drop([...active.tags.keys()]);
    }
  }
  return active;
}

export function tagsFromText(text: string): SymptomTag[] {
  const { tags } = readSymptoms(text);
  return SYMPTOM_RULES.filter((rule) => tags.has(rule.tag)).map((rule) => rule.tag);
}

/**
 * ナレッジの本文を固定のタグへ写す。ナレッジは解決した事例の記録なので、
 * 解消の表現で消さない（打ち消しだけを除く）。戻り値は固定の語彙だけ。
 */
export function knowledgeTagsFromText(...texts: readonly string[]): SymptomTag[] {
  const found = new Set<SymptomTag>();
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      for (const clause of clausesOf(sentence)) {
        for (const tag of clauseSymptoms(clause)) found.add(tag);
      }
    }
  }
  return SYMPTOM_RULES.filter((rule) => found.has(rule.tag)).map((rule) => rule.tag);
}

export function buildCaseFacts(snapshot: unknown): CaseFacts {
  const text = consultationText(snapshot);
  const active = readSymptoms(text);
  const tags = SYMPTOM_RULES.filter((rule) => active.tags.has(rule.tag)).map((rule) => rule.tag);
  const first = SYMPTOM_RULES.find((rule) => rule.tag === tags[0]);
  const remaining = [...new Set(active.tags.values())]
    .map((no) => active.clauses.get(no) ?? '')
    .join('\n');
  let purpose: CasePurpose = 'unknown';
  if (/教えて|知りたい|方法は|確認したい/.test(text)) purpose = 'information';
  else if (/直したい|直して|解消したい/.test(text)) purpose = 'repair';
  else if (/でき(?:ない|ません|なく|ず)|ない|ません|失敗/.test(remaining)) purpose = 'repair';
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
