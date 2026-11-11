import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticateUi } from '../auth/ui.js';
import { config, repoRoot } from '../config.js';
import { sql } from '../db.js';
import { GENESIS_HASH, verifyAuditChain } from '../domain/audit.js';
import { badRequest, forbidden } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { asJsonObject } from '../lib/json.js';
import { deviceStatus, findDevices } from '../lib/mirai-info.js';

/**
 * 運用統合 UI の DevOps・SecOps（docs/100 P5）。
 *
 * - 緊急停止は **サーバの 1 行**（`ops_estop`）で持つ。解除・設定は承認者／監査担当のみ。
 * - 監査鎖の検証は既存の `verifyAuditChain` を使う（推測値を出さない）。
 * - DevOps は「サーバが実測できる値」だけを返す（unit/CI の詳細は将来。現状は commit / 稼働時間 / DB 件数）。
 */

interface EstopRow {
  active: boolean;
  reason: string | null;
  actor_email: string | null;
  updated_at: Date | string;
}

function ms(value: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** 稼働中のリリース情報（release.env があれば読む。無ければ環境変数）。 */
function releaseInfo(): { commit: string | null; release: string | null } {
  let commit = process.env.COMMIT_SHA ?? null;
  let release = process.env.RELEASE_ID ?? null;
  try {
    const raw = readFileSync(path.join(repoRoot, 'release.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = /^(COMMIT_SHA|RELEASE_ID)=(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === 'COMMIT_SHA') commit = match[2] ?? commit;
      if (match[1] === 'RELEASE_ID') release = match[2] ?? release;
    }
  } catch {
    // release.env が無い（開発・テスト）場合は環境変数のまま。
  }
  return { commit, release };
}

export async function loadEstop(): Promise<{
  active: boolean;
  reason: string | null;
  actor: string | null;
  updatedAt: number | null;
}> {
  const rows = await sql<
    EstopRow[]
  >`SELECT active, reason, actor_email, updated_at FROM ops_estop WHERE id = 1`;
  const row = rows[0];
  return {
    active: Boolean(row?.active),
    reason: row?.reason ?? null,
    actor: row?.actor_email ?? null,
    updatedAt: ms(row?.updated_at ?? null),
  };
}

/** サーバが実測できる範囲の DevOps 状態。 */
export async function loadDevopsStatus(): Promise<Record<string, unknown>> {
  const counts = await sql<
    { knowledge: number; tickets: number; handovers: number; audit: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM knowledge) AS knowledge,
      (SELECT count(*)::int FROM ops_tickets) AS tickets,
      (SELECT count(*)::int FROM case_handovers) AS handovers,
      (SELECT count(*)::int FROM audit_log) AS audit
  `;
  const info = releaseInfo();
  let dbOk = false;
  try {
    await sql`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const assets = await deviceStatus();
  return {
    commit: info.commit,
    release: info.release,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    env: config.NODE_ENV,
    db: { ok: dbOk, counts: counts[0] ?? null },
    // 端末台帳（Mirai-Info）の件数・鮮度・到達性。取れない環境では error が入る。
    assets,
  };
}

/** 有効なリモート支援セッション（resolution_sessions の正本）。 */
export async function loadRemoteSessions(): Promise<Record<string, unknown>[]> {
  const rows = await sql<
    {
      id: string;
      case_id: string;
      status: string;
      device_id: string | null;
      user_email: string;
      started_at: Date | string;
      expires_at: Date | string | null;
    }[]
  >`
    SELECT id, case_id, status, device_id, user_email, started_at, expires_at
    FROM resolution_sessions
    WHERE status = 'escalated' AND (expires_at IS NULL OR expires_at > now())
    ORDER BY started_at DESC
    LIMIT 20
  `;
  return rows.map((row) => {
    const [local, domain] = String(row.user_email || '').split('@');
    const masked = local ? `${local.slice(0, 2)}***${domain ? `@${domain}` : ''}` : '-';
    return {
      id: row.id,
      caseId: row.case_id,
      status: row.status,
      deviceId: row.device_id,
      userLabel: masked,
      startedAt: ms(row.started_at),
      expiresAt: ms(row.expires_at),
    };
  });
}

/** 監査鎖の検証（approver / auditor / helpdesk のみ）。 */
export async function verifyChain(): Promise<Record<string, unknown>> {
  const rows = await sql<
    {
      id: number;
      actor_id: string | null;
      action: string;
      target_type: string;
      target_id: string;
      detail: unknown;
      prev_hash: string;
      hash: string;
    }[]
  >`
    SELECT id, actor_id, action, target_type, target_id, detail, prev_hash, hash
    FROM audit_log ORDER BY id ASC
  `;
  const mapped = rows.map((row) => ({
    id: Number(row.id),
    actorId: row.actor_id ?? null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: asJsonObject(row.detail),
    prevHash: row.prev_hash,
    hash: row.hash,
  }));
  const result = verifyAuditChain(mapped, GENESIS_HASH);
  return { ...result, rows: mapped.length };
}

const EstopSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export async function opsStatusRoutes(app: FastifyInstance): Promise<void> {
  /** SecOps/DevOps の実測値。 */
  app.get('/ops/status', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const roles = request.uiRoles ?? [];
    const privileged = roles.some((role) => ['approver', 'auditor', 'helpdesk'].includes(role));
    const estop = await loadEstop();
    if (!privileged) return { ok: true, estop, devops: null, audit: null };
    const [devops, audit, remote] = await Promise.all([
      loadDevopsStatus(),
      verifyChain(),
      loadRemoteSessions(),
    ]);
    return { ok: true, estop, devops, audit, remote };
  });

  /** 端末台帳（Mirai-Info）の検索。担当者だけが使える。IP・シリアルは返さない。 */
  app.get('/ops/assets', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    await requireHelpdeskActor(request.uiEmail);
    const query = z
      .object({ q: z.string().trim().max(120).default('') })
      .parse(request.query ?? {});
    const result = await findDevices(query.q, 10);
    return { ok: true, items: result.devices, error: result.error ?? null };
  });

  /** 緊急停止の設定・解除（承認者／監査担当のみ）。監査に 1 行残す。 */
  app.post('/ops/estop', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    const roles = request.uiRoles ?? [];
    if (!roles.some((role) => ['approver', 'auditor'].includes(role))) {
      throw forbidden('緊急停止は承認者・監査担当のみ操作できます。');
    }
    const body = EstopSchema.parse(request.body ?? {});
    const before = await loadEstop();
    await sql.begin(async (tx) => {
      await tx`
        UPDATE ops_estop
        SET active = ${body.active},
            reason = ${body.reason ?? null},
            actor_email = ${email},
            updated_at = now()
        WHERE id = 1
      `;
      await appendAudit(tx, {
        actorId: null,
        action: body.active ? 'ops.estop.on' : 'ops.estop.off',
        targetType: 'ops_estop',
        targetId: '1',
        detail: { email, reason: body.reason ?? null, before: before.active },
      });
    });
    return { ok: true, estop: await loadEstop() };
  });
}
