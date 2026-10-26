import { maskPcValue } from '../domain/final-report.js';
import { redactPII } from '../domain/pii.js';
import { type CaseSnapshot, normalizeState } from '../lib/case-handover.js';
import type { HandoverRow } from '../routes/case-handovers.js';
import { CATEGORY_LABEL } from './report.js';

/** 対象PC情報（[docs/36-rsp-integration.md] §3-1）。 */
export interface TerminalPcItem {
  grp: string;
  k: string;
  v: string;
  lv: 'ok' | 'warn' | 'ng';
  note?: string;
  rel?: boolean;
}

export interface TerminalCaseContext {
  case: {
    id: string;
    subject: string;
    body: string;
    category: string;
    categoryLabel: string;
    urgency: string;
    createdAt: string;
  };
  requester: { email: string; name: string | null };
  handover: {
    id: string;
    status: string;
    claimedBy: string | null;
    ownerEmail: string;
    device: string;
  };
  pc: {
    available: boolean;
    device?: string;
    collectedAt?: string;
    itemCount: number;
    flags: TerminalPcItem[];
    items: TerminalPcItem[];
  } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function pcItems(snapshot: CaseSnapshot | null): TerminalPcItem[] {
  const pc = record(snapshot?.case?.pc);
  const snap = record(pc?.snap);
  const items = Array.isArray(snap?.items) ? snap.items : [];
  return items.slice(0, 500).map((raw) => {
    const item = record(raw) ?? {};
    const key = text(item.k, 120);
    const lv = item.lv === 'warn' || item.lv === 'ng' ? item.lv : 'ok';
    return {
      grp: text(item.grp, 60),
      k: key,
      // IP・シリアル・資産番号は項目名で判定して必ず伏せる（報告書と同じ方針）。
      v: maskPcValue(key, text(item.v, 500)),
      lv,
      ...(text(item.note, 500) ? { note: text(item.note, 500) } : {}),
      ...(item.rel ? { rel: true } : {}),
    } as TerminalPcItem;
  });
}

/**
 * 引継ぎスナップショットから、RSP の AI支援パネルに表示する案件文脈を作る。
 * 案件本文は PII を伏せ字化する（別システムへ出さない）。
 */
export function buildTerminalCaseContext(
  handover: HandoverRow,
  requesterName: string | null,
): TerminalCaseContext {
  const snapshot = normalizeState(handover.snapshot) as CaseSnapshot | null;
  const caseRecord = record(snapshot?.case) ?? {};
  const items = pcItems(snapshot);
  const pc = record(snapshot?.case?.pc);
  const snap = record(pc?.snap);
  const category = text(caseRecord.cat, 40);
  const device = text(snap?.device, 120) || 'unknown';

  return {
    case: {
      id: handover.case_id,
      subject: text(redactPII(text(caseRecord.subject, 500)).text, 500),
      body: text(redactPII(text(caseRecord.body, 12_000)).text, 12_000),
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? 'その他',
      urgency: text(caseRecord.urgency, 30),
      createdAt: text(caseRecord.createdAt, 40) || new Date(handover.created_at).toISOString(),
    },
    requester: {
      email: handover.owner_email,
      name: requesterName ? text(requesterName, 120) : null,
    },
    handover: {
      id: handover.id,
      status: handover.status,
      claimedBy: handover.claimed_by,
      ownerEmail: handover.owner_email,
      device,
    },
    pc:
      items.length > 0
        ? {
            available: true,
            device,
            collectedAt: text(snap?.at, 40) || undefined,
            itemCount: items.length,
            flags: items.filter((item) => item.lv !== 'ok'),
            items,
          }
        : null,
  };
}
