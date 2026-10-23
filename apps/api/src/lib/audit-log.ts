import { computeAuditHash, GENESIS_HASH } from '../domain/audit.js';

export interface AuditInput {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
}

/**
 * 監査ログを追記する。呼び出し側は必ず sql.begin(...) の中から呼ぶこと。
 * advisory lock で同時実行時のチェーン分岐を防ぐ。
 */
export async function appendAudit(tx: any, input: AuditInput): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(918273645)`;
  const rows = await tx<{ hash: string }[]>`
    SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1
  `;
  const prevHash = rows[0]?.hash ?? GENESIS_HASH;
  const detail = input.detail ?? {};
  const hash = computeAuditHash(prevHash, {
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detail,
  });
  await tx`
    INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, prev_hash, hash)
    VALUES (${input.actorId}, ${input.action}, ${input.targetType}, ${input.targetId},
      ${JSON.stringify(detail)}::jsonb, ${prevHash}, ${hash})
  `;
}
