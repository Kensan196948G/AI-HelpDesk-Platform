import { createHash } from 'node:crypto';
import { config } from '../config.js';

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

/**
 * 既知の移行点（過去にハッシュ計算と保存値が食い違った監査行）。
 *
 * 2026-10-26 の `terminal.session.expire` は detail.expiresAt に Date を渡していたため、
 * 保存時は jsonb が ISO 文字列、ハッシュ計算時は Date が `{}` になり、この行だけ
 * 再計算が一致しない。当該行の保存 hash と、保存済み detail から再計算した hash の
 * 両方を固定して「既知の移行点」として扱う。前後の行の改ざん検知は維持し、
 * 当該行の detail / hash が後から書き換えられた場合も既知扱いから外れて検証は失敗する。
 *
 * 環境ごとに行 ID が異なるため、一覧は `config.AUDIT_KNOWN_BREAKS`
 * （env `AUDIT_KNOWN_BREAKS`）から読む。形式は `id:保存hash:再計算hash` のカンマ区切り。
 */
export interface KnownAuditBreak {
  id: number;
  /** 破断時点で保存された hash（この値と一致する行だけを既知の移行点として扱う）。 */
  hash: string;
  /**
   * 保存済み detail から計算し直した hash（＝本来あるべき hash）。
   * これを固定することで、既知の移行点の detail が後から書き換えられた場合も検知できる。
   */
  recomputedHash: string;
  /** 任意。指定した場合だけ action / targetType も照合する（env 形式では省略）。 */
  action?: string;
  targetType?: string;
  reason?: string;
}

const AUDIT_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * `AUDIT_KNOWN_BREAKS` を解析する。
 * 形式: `id:保存hash:再計算hash` をカンマまたは改行で区切ったもの。空文字は「既知破断なし」。
 * 不正な形式は起動時に fail-fast させる（黙って検証を緩めない）。
 */
export function parseKnownAuditBreaks(raw: string | null | undefined): KnownAuditBreak[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const breaks: KnownAuditBreak[] = [];
  const tokens = text.split(/[,\r\n]+/).filter((token) => token.trim().length > 0);
  for (const [index, token] of tokens.entries()) {
    const parts = token.trim().split(':');
    if (parts.length !== 3) {
      throw new Error(
        `AUDIT_KNOWN_BREAKS の形式が不正です（${index + 1}件目）。` +
          '`id:保存hash:再計算hash` をカンマ区切りで指定してください。',
      );
    }
    const [idRaw = '', storedHash = '', recomputedHash = ''] = parts;
    const id = Number(idRaw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`AUDIT_KNOWN_BREAKS の id が不正です（${index + 1}件目）。`);
    }
    if (!AUDIT_HASH_RE.test(storedHash) || !AUDIT_HASH_RE.test(recomputedHash)) {
      throw new Error(
        `AUDIT_KNOWN_BREAKS の hash が不正です（${index + 1}件目）。64桁の16進数を指定してください。`,
      );
    }
    breaks.push({
      id,
      hash: storedHash.toLowerCase(),
      recomputedHash: recomputedHash.toLowerCase(),
      reason: '環境設定（AUDIT_KNOWN_BREAKS）で指定された既知の移行点',
    });
  }
  return breaks;
}

/**
 * 現在の設定（`config.AUDIT_KNOWN_BREAKS`）から既知破断を読む。
 * verify のたびに評価するため、テストで設定を差し替えた場合もそのまま反映される
 * （本番では起動時に env から確定した値を返す）。
 */
export function currentKnownAuditBreaks(): readonly KnownAuditBreak[] {
  return parseKnownAuditBreaks(config.AUDIT_KNOWN_BREAKS);
}

/** キー順に依存しない JSON 文字列化（ハッシュの再現性のため）。 */
export function stableStringify(value: unknown): string {
  // Date は JSON.stringify では ISO 文字列になる。保存時（jsonb）と同じ表現にそろえる。
  // ここを `{}` として扱うと、保存値から再計算したハッシュが一致しなくなる（G-01-F1）。
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
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

export interface KnownAuditBreakHit {
  id: number;
  reason?: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
  expected?: string;
  actual?: string;
  /** 既知の移行点として読み飛ばした行（ok:true のときだけ返す）。 */
  knownBreaks?: KnownAuditBreakHit[];
}

export interface VerifyAuditChainOptions {
  /** 既定は `config.AUDIT_KNOWN_BREAKS`（env で上書き可能）。 */
  knownBreaks?: readonly KnownAuditBreak[];
}

/**
 * rows は id 昇順（古い順）で渡す。
 * prev_hash の連結と再計算が一致するか検証する。
 *
 * 既知の移行点（`config.AUDIT_KNOWN_BREAKS`）に完全一致する行だけは、保存済み hash を
 * 信頼して次行へ連結する。id / 保存hash / 再計算hash（と指定時は action/targetType）が
 * 変われば既知扱いしないため、移行点の行が後から書き換えられた場合は検証失敗になる。
 */
export function verifyAuditChain(
  rows: Array<AuditRow & { id: number }>,
  genesisHash = GENESIS_HASH,
  options: VerifyAuditChainOptions = {},
): ChainVerification {
  const knownBreaks = options.knownBreaks ?? currentKnownAuditBreaks();
  const hits: KnownAuditBreakHit[] = [];
  let prev = genesisHash;
  for (const [index, row] of rows.entries()) {
    if (row.prevHash !== prev) {
      return {
        ok: false,
        checked: index,
        brokenAtId: row.id,
        expected: prev,
        actual: row.prevHash,
      };
    }
    const expected = computeAuditHash(prev, {
      actorId: row.actorId ?? null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: row.detail ?? {},
    });
    const known = knownBreaks.find(
      (item) =>
        item.id === row.id &&
        (item.action === undefined || item.action === row.action) &&
        (item.targetType === undefined || item.targetType === row.targetType) &&
        item.hash === row.hash &&
        // 保存済み detail が当時のままであることも固定値との一致で確認する。
        item.recomputedHash === expected,
    );
    if (known) {
      hits.push({ id: row.id, ...(known.reason ? { reason: known.reason } : {}) });
      prev = row.hash;
      continue;
    }
    if (row.hash !== expected) {
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
  return { ok: true, checked: rows.length, ...(hits.length > 0 ? { knownBreaks: hits } : {}) };
}
