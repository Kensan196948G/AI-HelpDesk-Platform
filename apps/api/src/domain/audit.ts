import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditPayload {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

export interface AuditRow {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** キー順に依存しない JSON 文字列化（ハッシュの再現性のため）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function computeAuditHash(prevHash: string, payload: AuditPayload): string {
  return createHash('sha256')
    .update(prevHash + stableStringify(payload))
    .digest('hex');
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
  expected?: string;
  actual?: string;
}

/**
 * rows は id 昇順（古い順）で渡す。
 * prev_hash の連結と再計算が一致するか検証する。
 */
export function verifyAuditChain(
  rows: Array<AuditRow & { id: number }>,
  genesisHash = GENESIS_HASH,
): ChainVerification {
  let prev = genesisHash;
  for (const [index, row] of rows.entries()) {
    const expected = computeAuditHash(prev, {
      actorId: row.actorId ?? null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: row.detail ?? {},
    });
    if (row.prevHash !== prev || row.hash !== expected) {
      return {
        ok: false,
        checked: index,
        brokenAtId: row.id,
        expected,
        actual: row.hash,
      };
    }
    prev = row.hash;
  }
  return { ok: true, checked: rows.length };
}
