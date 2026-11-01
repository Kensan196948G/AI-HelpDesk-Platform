/**
 * 案件の引継ぎ（A さんのブラウザ → DX 推進部 B さんのブラウザ）。
 *
 * 既存プロトタイプの状態（cowork / helpdesk）はログイン単位で保存されている。
 * そのままでは B さんのブラウザに A さんの案件は出ないため、引継ぎ時点の
 * 案件・チャット・TKT/INC・ナレッジ下書きをスナップショットし、B さんが
 * 引き受けたときに B さんの状態へマージする。
 *
 * ここでは UI の構造を推測せず、ID（CASE / TKT / INC / DR / KB）で
 * 配列・オブジェクトを突き合わせる。存在しない項目は追加しない。
 */

import { redactPII } from '../domain/pii.js';

export type JsonRecord = Record<string, unknown>;

export interface CaseSnapshot {
  caseId: string;
  case: JsonRecord;
  chat: JsonRecord | null;
  ticket: JsonRecord | null;
  inc: JsonRecord | null;
  draft: JsonRecord | null;
  kb: JsonRecord | null;
  proposals: JsonRecord[];
  extractedAt: string;
}

export function normalizeState(value: unknown): JsonRecord | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  return null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function idOf(value: JsonRecord | null | undefined): string {
  return value && typeof value.id === 'string' ? value.id : '';
}

function upsertById(target: JsonRecord[], item: JsonRecord | null): void {
  if (!item) return;
  const id = idOf(item);
  if (!id) {
    target.push(item);
    return;
  }
  const index = target.findIndex((current) => idOf(current) === id);
  if (index >= 0) target[index] = { ...target[index], ...item };
  else target.push(item);
}

function bumpCounter(target: JsonRecord, key: string, id: string | null | undefined): void {
  const match = String(id ?? '').match(/(\d+)$/);
  const number = match ? Number(match[1]) : 0;
  const current = Number(target[key] ?? 0);
  target[key] = Math.max(Number.isFinite(current) ? current : 0, number + 1);
}

function nowLocal(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 1 行にそろえて長さを制限する（メールの件名・ヘッダーに使う）。 */
function oneLine(value: unknown, maxLength = 120): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** 案件に件名が無いとき、他の実データから補うためのチャット件名の除外値。 */
const CHAT_TITLE_PLACEHOLDERS = new Set(['新しい相談', '(件名なし)']);

/**
 * 引継ぎスナップショットへ載せる案件件名を決める（F-05）。
 *
 * 通知メールの件名は snapshot.case.subject から作られるが、STEP4 直後の共有では
 * サーバ側の状態保存が追いつかず subject が空のまま保存されることがある。
 * そのため subject が空のときは、同じ状態に残っている
 * チケット概要 → INC 件名 → チャット件名 の順で実データから補う。
 * どれも無い場合だけ空文字を返す（通知側で「(件名なし)」になる）。
 */
export function resolveSnapshotSubject(
  caseRecord: JsonRecord,
  related: { chat?: JsonRecord | null; ticket?: JsonRecord | null; inc?: JsonRecord | null } = {},
): string {
  const direct = oneLine(caseRecord.subject);
  if (direct) return direct;
  const ticketSummary = oneLine(related.ticket?.summary);
  if (ticketSummary) return ticketSummary;
  const incSubject = oneLine(related.inc?.subject);
  if (incSubject) return incSubject;
  const chatTitle = oneLine(related.chat?.title);
  if (chatTitle && !CHAT_TITLE_PLACEHOLDERS.has(chatTitle)) return chatTitle;
  return '';
}

/** PC 基本情報の項目名（k）ごとに、値（v）を伏せる対象。 */
const PC_SENSITIVE_LABELS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /ipアドレス|ip address/i, replacement: '[IPアドレス]' },
  { pattern: /シリアル|serial/i, replacement: '[シリアル番号]' },
  { pattern: /資産番号|asset/i, replacement: '[資産番号]' },
];

/** フィールド名がシリアル番号を表す場合（例: `{ serial: 'SN-0001' }`）も伏せる。 */
const SERIAL_FIELD = /serial|シリアル/i;

/** PC 基本情報の項目名（k）が端末識別子を表す場合。表示用でも値は保持する。 */
const IDENTIFIER_PC_LABEL = /コンピュータ名|端末名|ホスト名|hostname|端末id|デバイスid|device/i;

/**
 * 端末照合・相関に使う識別子のフィールド名。
 * 値を伏せ字にすると `pc.snap.device` が RSP のホスト名照合
 * （`snapshot #>> '{case,pc,snap,device}'`）や提案ハッシュの `deviceId` と
 * 一致しなくなるため、これらはそのまま保存する（F-04 回帰修正）。
 * 比較時は小文字化し、`_` `-` 空白を除く（deviceId / device_id を同一視）。
 */
const IDENTIFIER_FIELDS = new Set(
  ['device', 'deviceId', 'agentId', 'hostname', 'machineId', 'terminalId'].map((value) =>
    value.toLowerCase(),
  ),
);

function isIdentifierField(key: string | undefined): boolean {
  if (!key) return false;
  return IDENTIFIER_FIELDS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

function sensitivePcLabel(value: unknown): string | null {
  const label = oneLine(value, 40);
  if (!label) return null;
  const hit = PC_SENSITIVE_LABELS.find((rule) => rule.pattern.test(label));
  return hit ? hit.replacement : null;
}

/**
 * 保存前にスナップショット全体（ネストしたオブジェクト・配列を含む）の
 * 文字列を redactPII で伏せ字にする（F-04）。
 *
 * - クライアント側の置換には依存しない。
 * - キー名はマージ時の ID 引き当てに使うため変更しない（値だけを伏せる）。
 * - 端末の識別子（device / deviceId / agentId / hostname 等）は照合・相関に
 *   使うため伏せない（`MRK-NB-1000` が資産番号と誤判定される回帰の修正）。
 * - PC 基本情報の `{ k: 'シリアル', v: 'SN-0001' }` のように、項目名でしか
 *   判別できない表示用の値は、項目名（k）に合わせて伏せる。
 */
export function redactSnapshotValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (value === '') return value;
    // 端末識別子はそのまま残す（シリアル・資産番号の誤判定より優先する）。
    if (isIdentifierField(key)) return value;
    if (key && SERIAL_FIELD.test(key)) return '[シリアル番号]';
    return redactPII(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => redactSnapshotValue(item, key));
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    const labelReplacement = sensitivePcLabel(record.k);
    const identifierLabel = IDENTIFIER_PC_LABEL.test(oneLine(record.k, 40));
    const result: JsonRecord = {};
    for (const [childKey, child] of Object.entries(record)) {
      if ((childKey === 'v' || childKey === 'value') && typeof child === 'string' && child !== '') {
        // 表示用のシリアル・IP・資産番号は項目名で伏せる。
        if (labelReplacement) {
          result[childKey] = labelReplacement;
          continue;
        }
        // 端末名などの識別子項目は照合に使えるようそのまま残す。
        if (identifierLabel) {
          result[childKey] = child;
          continue;
        }
      }
      result[childKey] = redactSnapshotValue(child, childKey);
    }
    return result;
  }
  return value;
}

/** スナップショットを丸ごと伏せ字にした複製を返す（元の状態は変更しない）。 */
export function redactCaseSnapshot(snapshot: CaseSnapshot): CaseSnapshot {
  return redactSnapshotValue(snapshot) as CaseSnapshot;
}

export interface ExtractCaseSnapshotOptions {
  /**
   * クライアントが送った案件件名。状態の保存が追いつく前でも件名を確定させる。
   * 現行の routes/case-handovers.ts は渡していない（報告参照）。
   */
  subject?: string;
}

/**
 * A さんの状態から、1 案件分の引継ぎスナップショットを作る。
 * 見つからない場合は null（推測で作らない）。
 * 返すスナップショットは保存可能な形に伏せ字化済み（F-04）。
 */
export function extractCaseSnapshot(
  coworkInput: unknown,
  helpdeskInput: unknown,
  caseId: string,
  options?: ExtractCaseSnapshotOptions,
): CaseSnapshot | null {
  const cowork = normalizeState(coworkInput);
  const helpdesk = normalizeState(helpdeskInput);
  if (!cowork) return null;

  const targetCase = asArray(cowork.cases).find((item) => idOf(item) === caseId);
  if (!targetCase) return null;

  const chat =
    asArray(cowork.chats).find((item) => idOf(item) === String(targetCase.chatId ?? '')) ?? null;
  const ticket =
    asArray(cowork.tickets).find((item) => chat && String(item.chatId ?? '') === idOf(chat)) ??
    null;

  const helpdeskTickets = asArray(helpdesk?.tickets);
  const inc =
    helpdeskTickets.find(
      (item) =>
        (ticket && idOf(item) === String(ticket.incId ?? '')) ||
        (ticket && String(item.coworkTicket ?? '') === idOf(ticket)),
    ) ?? null;

  const draft =
    asArray(helpdesk?.drafts).find((item) => inc && idOf(item) === String(inc.draftId ?? '')) ??
    null;
  const kb =
    asArray(helpdesk?.kb).find((item) => inc && idOf(item) === String(inc.kbId ?? '')) ?? null;

  const proposals = Object.values(asRecord(cowork.proposals)).filter(
    (item): item is JsonRecord =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      chat !== null &&
      String((item as JsonRecord).chatId ?? '') === idOf(chat),
  );

  // 件名は「クライアントが送った値 → 案件の subject → 他の実データ」の順で決める。
  const subject =
    oneLine(options?.subject) || resolveSnapshotSubject(targetCase, { chat, ticket, inc });
  const caseRecord: JsonRecord = subject ? { ...targetCase, subject } : targetCase;

  return redactCaseSnapshot({
    caseId,
    case: caseRecord,
    chat,
    ticket,
    inc,
    draft,
    kb,
    proposals,
    extractedAt: new Date().toISOString(),
  });
}

/**
 * B さんの状態へスナップショットをマージする。
 * - 既存の案件・チケット・INC は ID で dedupe する（B さんの既存データを壊さない）。
 * - B さんの ui.user / helpdesk.actor は変更しない。
 * - 引継ぎ後は STEP 3（AI 一次対応）を開き、B さんが履歴と AI 追加質問を使えるようにする。
 */
export function mergeCaseSnapshot(
  coworkInput: unknown,
  helpdeskInput: unknown,
  snapshot: CaseSnapshot,
  claim: { id: string; claimedBy: string },
  options?: { mode?: 'claim' | 'sync' },
): { cowork: JsonRecord; helpdesk: JsonRecord } {
  const mode = options?.mode ?? 'claim';
  const cowork = structuredClone(normalizeState(coworkInput) ?? {}) as JsonRecord;
  const helpdesk = structuredClone(normalizeState(helpdeskInput) ?? {}) as JsonRecord;
  const ui = asRecord(cowork.ui);
  const counters = asRecord(cowork.counters);
  const seq = asRecord(helpdesk.seq);

  cowork.ui = ui;
  cowork.counters = counters;
  cowork.cases = asArray(cowork.cases);
  cowork.chats = asArray(cowork.chats);
  cowork.tickets = asArray(cowork.tickets);
  cowork.proposals = asRecord(cowork.proposals);
  helpdesk.tickets = asArray(helpdesk.tickets);
  helpdesk.drafts = asArray(helpdesk.drafts);
  helpdesk.kb = asArray(helpdesk.kb);
  helpdesk.audit = asArray(helpdesk.audit);
  helpdesk.seq = seq;

  const mergedCase: JsonRecord = {
    ...snapshot.case,
    shared: true,
    handoverId: claim.id,
    handoverFrom: snapshot.caseId,
    step: mode === 'sync' ? (Number(snapshot.case.step) > 0 ? Number(snapshot.case.step) : 3) : 3,
  };

  upsertById(cowork.cases as JsonRecord[], mergedCase);
  upsertById(cowork.chats as JsonRecord[], snapshot.chat);
  upsertById(cowork.tickets as JsonRecord[], snapshot.ticket);
  if (snapshot.inc) upsertById(helpdesk.tickets as JsonRecord[], snapshot.inc);
  if (snapshot.draft) upsertById(helpdesk.drafts as JsonRecord[], snapshot.draft);
  if (snapshot.kb) upsertById(helpdesk.kb as JsonRecord[], snapshot.kb);

  for (const proposal of snapshot.proposals) {
    const id = idOf(proposal);
    if (id) (cowork.proposals as JsonRecord)[id] = proposal;
  }

  // B さんの画面で「DX 推進部が引き受けた」ことが分かるシステムメッセージ。
  if (snapshot.chat) {
    const chat = (cowork.chats as JsonRecord[]).find((item) => idOf(item) === idOf(snapshot.chat));
    if (chat) {
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      messages.push({
        id: `sys-handover-${Date.now()}`,
        kind: 'ai',
        model: 'システム',
        who: 'システム',
        html:
          mode === 'claim'
            ? '<p>DX 推進部の担当者がこの案件を引き受けました。ここまでの AI 一次対応の履歴を確認できます。</p>'
            : '<p>DX 推進部の担当者が対応しました。最新の状況を確認してください。</p>',
        at: nowLocal(),
      });
      chat.messages = messages;
    }
  }

  bumpCounter(counters, 'case', snapshot.caseId);
  bumpCounter(counters, 'ticket', idOf(snapshot.ticket));
  bumpCounter(
    counters,
    'prop',
    snapshot.proposals.at(-1) ? idOf(snapshot.proposals.at(-1) ?? null) : null,
  );
  if (snapshot.inc) {
    bumpCounter(seq, 'inc', idOf(snapshot.inc));
    bumpCounter(seq, 'draft', idOf(snapshot.draft));
    bumpCounter(seq, 'kb', idOf(snapshot.kb));
    (helpdesk.audit as JsonRecord[]).push({
      t: Date.now(),
      actor: 'system',
      action: mode === 'claim' ? '引継ぎを引き受け' : '担当者の対応を反映',
      target: idOf(snapshot.inc),
      detail: `${snapshot.caseId}（${claim.claimedBy}）`,
    });
  }

  ui.case = snapshot.caseId;
  if (mode === 'claim') ui.screen = 'wizard';
  // ui.user はそのブラウザの利用者を保持する（A/B を入れ替えない）。
  if (!ui.user && mode === 'claim') ui.user = claim.claimedBy;

  return { cowork, helpdesk };
}

export function buildPcContext(snapshot: CaseSnapshot): string {
  const pc = snapshot.case.pc as { snap?: { items?: unknown[] } } | undefined;
  const items = Array.isArray(pc?.snap?.items) ? pc?.snap?.items : [];
  if (items.length === 0) return '';
  // 画面の固定データから作った記録（PCエージェント欄が「模擬」）は実 AI の根拠にしない。
  const isDemo = items.some((raw) => {
    const item = raw as { k?: string; v?: string };
    return item.k === 'PCエージェント' && String(item.v ?? '').includes('模擬');
  });
  if (isDemo) return '';
  return items
    .map((raw) => {
      const item = raw as { grp?: string; k?: string; v?: string };
      const key = String(item.k ?? '');
      let value = String(item.v ?? '');
      if (/ipアドレス|ip address/i.test(key)) value = '[IPアドレス]';
      else if (/シリアル|serial/i.test(key)) value = '[シリアル番号]';
      else if (/資産番号|asset/i.test(key)) value = '[資産番号]';
      else value = redactPII(value).text;
      return `${String(item.grp ?? '')}／${redactPII(key).text}：${value}`;
    })
    .join('\n')
    .slice(0, 4000);
}

export function buildCaseContext(snapshot: CaseSnapshot): string {
  const subject = redactPII(String(snapshot.case.subject ?? '')).text;
  const body = redactPII(String(snapshot.case.body ?? '')).text;
  const chatMessages = snapshot.chat?.messages;
  const messages = Array.isArray(chatMessages)
    ? (chatMessages as Array<Record<string, unknown>>)
        .slice(-6)
        .map((message) => {
          const text = String(message.text ?? '');
          return text ? `${String(message.kind ?? 'ai')}: ${redactPII(text).text}` : '';
        })
        .filter(Boolean)
    : [];
  return [`件名: ${subject}`, `本文: ${body}`, ...messages].join('\n').slice(0, 6000);
}
