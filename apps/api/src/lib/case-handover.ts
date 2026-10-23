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

/**
 * A さんの状態から、1 案件分の引継ぎスナップショットを作る。
 * 見つからない場合は null（推測で作らない）。
 */
export function extractCaseSnapshot(
  coworkInput: unknown,
  helpdeskInput: unknown,
  caseId: string,
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

  return {
    caseId,
    case: targetCase,
    chat,
    ticket,
    inc,
    draft,
    kb,
    proposals,
    extractedAt: new Date().toISOString(),
  };
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
