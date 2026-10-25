import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { ensureRspAgent, lookupRspDevices } from './rsp.js';

const CaseQuerySchema = z.object({ caseId: z.string().trim().min(1).max(120) });
const LookupSchema = z.object({
  caseId: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(128),
});
const LinkSchema = z.object({
  caseId: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(128),
  rspDeviceId: z.string().uuid(),
});
const EnsureSchema = z.object({ caseId: z.string().trim().min(1).max(120) });

interface EscalatedSessionRow {
  id: string;
  user_email: string;
  case_id: string;
  device_id: string;
  status: string;
  created_at: Date | string;
}

interface LinkRow {
  device_id: string;
  user_email: string;
  hostname: string;
  rsp_device_id: string;
  mesh_node_id: string | null;
  verified_by: string;
  verified_at: Date | string;
}

interface InstallRow {
  status: string;
  triggered_deploy: boolean;
  agent_installed: boolean;
  agent_online: boolean;
  last_error: string | null;
  requested_by: string;
  requested_at: Date | string;
  updated_at: Date | string;
}

function requireEmail(email: string | undefined): string {
  if (!email) throw new ApiError(400, 'AUTH_REQUIRED', 'UI の認証情報がありません。');
  return email;
}

/** 担当者（helpdesk / approver）だけが遠隔対応を操作できる。 */
async function requireHelpdesk(email: string): Promise<{ email: string; role: string }> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  const role = rows[0]?.role;
  if (role !== 'helpdesk' && role !== 'approver') {
    throw new ApiError(403, 'FORBIDDEN', '遠隔対応は担当者のみ操作できます。');
  }
  return { email, role };
}

/** Phase 1 は escalated の最新セッションだけを対象にする。 */
async function findEscalatedSession(caseId: string): Promise<EscalatedSessionRow> {
  const rows = await sql<EscalatedSessionRow[]>`
    SELECT id, user_email, case_id, device_id, status, created_at
    FROM resolution_sessions
    WHERE case_id = ${caseId} AND status = 'escalated'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const session = rows[0];
  if (!session) {
    throw notFound('引き継ぎ済みの解決セッションが見つかりません。');
  }
  return session;
}

async function findLink(deviceId: string): Promise<LinkRow | null> {
  const rows = await sql<LinkRow[]>`
    SELECT device_id, user_email, hostname, rsp_device_id, mesh_node_id, verified_by, verified_at
    FROM device_mesh_links
    WHERE device_id = ${deviceId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findLatestInstall(caseId: string, rspDeviceId: string): Promise<InstallRow | null> {
  const rows = await sql<InstallRow[]>`
    SELECT status, triggered_deploy, agent_installed, agent_online, last_error,
           requested_by, requested_at, updated_at
    FROM mesh_install_requests
    WHERE case_id = ${caseId} AND rsp_device_id = ${rspDeviceId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function linkDto(link: LinkRow | null) {
  if (!link) return null;
  return {
    deviceId: link.device_id,
    hostname: link.hostname,
    rspDeviceId: link.rsp_device_id,
    meshNodeId: link.mesh_node_id,
    verifiedBy: link.verified_by,
    verifiedAt: new Date(link.verified_at).toISOString(),
  };
}

function installDto(row: InstallRow | null) {
  if (!row) return null;
  return {
    status: row.status,
    triggeredDeploy: row.triggered_deploy,
    agentInstalled: row.agent_installed,
    agentOnline: row.agent_online,
    lastError: row.last_error,
    requestedBy: row.requested_by,
    requestedAt: new Date(row.requested_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function audit(
  tx: any,
  input: {
    action: string;
    actorEmail: string;
    sessionId: string;
    detail?: Record<string, unknown>;
  },
) {
  return appendAudit(tx, {
    actorId: null,
    action: input.action,
    targetType: 'resolution_session',
    targetId: input.sessionId,
    detail: {
      actorEmail: input.actorEmail,
      ...(input.detail ?? {}),
    },
  });
}

export async function remoteSupportRoutes(app: FastifyInstance): Promise<void> {
  // ケース（escalated セッション）の遠隔対応コンテキスト。
  app.get('/remote-support/session', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request.uiEmail);
    await requireHelpdesk(email);
    const { caseId } = CaseQuerySchema.parse(request.query);
    const session = await findEscalatedSession(caseId);
    const link = await findLink(session.device_id);
    const install = link ? await findLatestInstall(caseId, link.rsp_device_id) : null;
    return {
      ok: true,
      caseId,
      session: {
        id: session.id,
        status: session.status,
        userEmail: session.user_email,
        deviceId: session.device_id,
        createdAt: new Date(session.created_at).toISOString(),
      },
      link: linkDto(link),
      install: installDto(install),
      rspPublicUrl: config.RSP_BASE_URL ?? null,
    };
  });

  // hostname から RSP 端末を検索（候補は担当者が選ぶ）。
  app.post(
    '/remote-support/lookup',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request.uiEmail);
      await requireHelpdesk(email);
      const input = LookupSchema.parse(request.body);
      await findEscalatedSession(input.caseId);
      const result = await lookupRspDevices(input.hostname);
      return { ok: true, count: result.count, matches: result.matches };
    },
  );

  // 候補を確定して保存（推測でリンクしない）。
  app.post(
    '/remote-support/link',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request.uiEmail);
      await requireHelpdesk(email);
      const input = LinkSchema.parse(request.body);
      const session = await findEscalatedSession(input.caseId);

      // RSP に実在し、指定 hostname と一致する端末だけを保存する。
      const result = await lookupRspDevices(input.hostname);
      const match = result.matches.find((candidate) => candidate.device_id === input.rspDeviceId);
      if (!match) {
        throw new ApiError(
          400,
          'RSP_DEVICE_MISMATCH',
          '指定された端末が RSP の検索結果と一致しません。再検索してください。',
        );
      }

      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO device_mesh_links (
            user_email, device_id, hostname, rsp_device_id, mapping_status, verified_by
          ) VALUES (
            ${session.user_email}, ${session.device_id}, ${match.hostname},
            ${input.rspDeviceId}, 'verified', ${email}
          )
          ON CONFLICT (device_id) DO UPDATE
            SET hostname = EXCLUDED.hostname,
                rsp_device_id = EXCLUDED.rsp_device_id,
                mapping_status = 'verified',
                verified_by = EXCLUDED.verified_by,
                verified_at = now(),
                updated_at = now()
        `;
        await audit(tx, {
          action: 'remote_support.link_saved',
          actorEmail: email,
          sessionId: session.id,
          detail: { hostname: match.hostname, rspDeviceId: input.rspDeviceId },
        });
      });

      const link = await findLink(session.device_id);
      return { ok: true, link: linkDto(link) };
    },
  );

  // MeshAgent の導入状態確認 + 未導入なら展開キュー投入。
  app.post(
    '/remote-support/ensure',
    { preHandler: authenticateUi, bodyLimit: 4 * 1024 },
    async (request) => {
      const email = requireEmail(request.uiEmail);
      await requireHelpdesk(email);
      if (!checkRateLimit(`remote-support-ensure:${email}`, 3, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '導入確認の操作が多すぎます。少し待ってください。');
      }
      const input = EnsureSchema.parse(request.body);
      const session = await findEscalatedSession(input.caseId);
      const link = await findLink(session.device_id);
      if (!link) {
        throw new ApiError(
          409,
          'DEVICE_NOT_LINKED',
          '先に端末を特定してください（hostname 検索と選択）。',
        );
      }

      const result = await ensureRspAgent(link.rsp_device_id);
      const status = result.agent_installed
        ? 'installed'
        : result.triggered_deploy
          ? 'triggered'
          : 'failed';
      const errorMessage = result.agent_installed
        ? null
        : result.triggered_deploy
          ? null
          : redactPII(
              `端末に到達できませんでした（ping=${result.ping_ok ? 'ok' : 'ng'} / winrm=${result.winrm_ok ? 'ok' : 'ng'}）。`,
            ).text;

      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO mesh_install_requests (
            case_id, resolve_session_id, user_email, device_id, rsp_device_id, hostname,
            status, triggered_deploy, agent_installed, agent_online, last_error, requested_by
          ) VALUES (
            ${input.caseId}, ${session.id}, ${session.user_email}, ${session.device_id},
            ${link.rsp_device_id}, ${result.hostname}, ${status},
            ${result.triggered_deploy}, ${result.agent_installed}, ${result.agent_online},
            ${errorMessage}, ${email}
          )
          ON CONFLICT (case_id, rsp_device_id) DO UPDATE
            SET status = EXCLUDED.status,
                triggered_deploy = EXCLUDED.triggered_deploy,
                agent_installed = EXCLUDED.agent_installed,
                agent_online = EXCLUDED.agent_online,
                last_error = EXCLUDED.last_error,
                requested_by = EXCLUDED.requested_by,
                updated_at = now()
        `;
        await audit(tx, {
          action: 'remote_support.ensure_requested',
          actorEmail: email,
          sessionId: session.id,
          detail: {
            hostname: result.hostname,
            rspDeviceId: link.rsp_device_id,
            status,
            triggeredDeploy: result.triggered_deploy,
          },
        });
      });

      const install = await findLatestInstall(input.caseId, link.rsp_device_id);
      return {
        ok: true,
        link: linkDto(link),
        install: installDto(install),
        rspPublicUrl: config.RSP_BASE_URL ?? null,
      };
    },
  );
}
