import { emailVariants } from '../auth/email-alias.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { findEmployeeByEmail } from '../lib/mirai-info.js';
import {
  enqueueDeviceIdentityProbe,
  fetchDeviceIdentityProbe,
  lookupRspDevices,
} from '../remote-support/rsp.js';
import { fetchLease, type LeaseResult } from './lease.js';
import { auditRef, hashSid } from './sign.js';
import {
  bindingViolation,
  type EndReason,
  endAuditAction,
  evaluateProbe,
  isProbeRunning,
  isTerminal,
  LIMITS,
  parseProbeOutput,
  probeCompletedBefore,
  terminalStatusFor,
} from './state.js';

/**
 * 同意の状態を DB 上で進める処理（docs/62）。
 * 外部通信（Mirai-Info / RSP）はトランザクションの外で行い、結果の適用は行ロック下で再確認する。
 * タイマーや常駐の待ち受けで RSP を呼ばない（結果の取得は pair / 状態確認 / poll の延長で行う）。
 */

export type Tx = Parameters<Parameters<typeof sql.begin>[1]>[0];

export interface RequestContext {
  id: string;
  handover_id: string;
  case_id: string;
  requester_email: string;
  assignee_email: string;
  status: string;
  end_reason: EndReason | null;
  reason_code: string | null;
  lease_status: string;
  lease_source: string | null;
  lease_asset_tag: string | null;
  lease_fetched_at: Date | null;
  lease_generated_at: Date | null;
  rsp_device_id: string | null;
  mesh_node_id: string | null;
  rsp_hostname: string | null;
  rsp_probe_log_id: string | null;
  rsp_probe_status: string;
  rsp_probe_attempts: number;
  helper_id: string | null;
  machine_guid: string | null;
  sid: string | null;
  session_id: number | null;
  windows_user: string | null;
  helper_hostname: string | null;
  pair_attempts: number;
  consent_id: string | null;
  consent_root: string | null;
  consent_segments: string[];
  consent_operation: string | null;
  consented_at: Date | null;
  consent_expires_at: Date | null;
  request_expires_at: Date;
  ended_at: Date | null;
  created_at: Date;
  // 比較は DB の now() で行う（アプリとの時計ずれを持ち込まない）。
  consent_expired: boolean;
  request_expired: boolean;
  handover_status: string;
  claimed_by: string | null;
  owner_email: string;
  helper_revoked: boolean | null;
  helper_stale: boolean | null;
  helper_request_id: string | null;
  helper_session_state: string | null;
  helper_created_at: Date | null;
}

/** 依頼を行ロック付きで読む。呼び出し側は sql.begin の中から呼ぶ。 */
export async function loadContext(tx: Tx, id: string): Promise<RequestContext | null> {
  const rows = await tx<RequestContext[]>`
    SELECT r.*,
      (r.consent_expires_at IS NOT NULL AND r.consent_expires_at <= now()) AS consent_expired,
      (r.request_expires_at <= now()) AS request_expired,
      h.status AS handover_status,
      h.claimed_by,
      h.owner_email,
      (hp.revoked_at IS NOT NULL) AS helper_revoked,
      (hp.last_seen_at <= now() - (${LIMITS.helperStaleSeconds}::int * interval '1 second'))
        AS helper_stale,
      hp.request_id AS helper_request_id,
      hp.session_state AS helper_session_state,
      hp.created_at AS helper_created_at
    FROM folder_access_requests r
    JOIN case_handovers h ON h.id = r.handover_id
    LEFT JOIN folder_access_helpers hp ON hp.id = r.helper_id
    WHERE r.id = ${id}
    FOR UPDATE OF r
  `;
  return rows[0] ?? null;
}

/**
 * 監査の detail。パス・ファイル名・トークンを入れない。端末の識別子は HMAC の参照だけを書く
 * （docs/62 §7、§7-1。監査は保持期限の後も残るので、列を消しても識別子が残らないようにする）。
 */
export function auditDetail(
  ctx: RequestContext,
  actorEmail: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actorEmail,
    handoverId: ctx.handover_id,
    caseId: ctx.case_id,
    assigneeEmail: ctx.assignee_email,
    rspDeviceRef: ctx.rsp_device_id ? auditRef('rsp_device', ctx.rsp_device_id) : null,
    meshNodeRef: ctx.mesh_node_id ? auditRef('mesh_node', ctx.mesh_node_id) : null,
    hostnameRef: ctx.rsp_hostname ? auditRef('hostname', ctx.rsp_hostname) : null,
    leaseStatus: ctx.lease_status,
    sidHash: ctx.sid ? hashSid(ctx.sid) : null,
    sessionId: ctx.session_id,
    consentId: ctx.consent_id,
    operation: ctx.consent_operation,
    ...extra,
  };
}

export function appendFolderAudit(
  tx: Tx,
  action: string,
  ctx: RequestContext,
  actorEmail: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  return appendAudit(tx, {
    actorId: null,
    action,
    targetType: 'folder_access_request',
    targetId: ctx.id,
    detail: auditDetail(ctx, actorEmail, extra),
  });
}

/**
 * 同意を終了する。キュー中の操作を取り消し、結果とサブフォルダ名を消し、ヘルパーを失効させる。
 * 終端済みなら何もしない（false）。
 */
export async function endRequestTx(
  tx: Tx,
  ctx: RequestContext,
  reason: EndReason,
  actorEmail: string,
): Promise<boolean> {
  const status = terminalStatusFor(reason);
  const updated = await tx`
    UPDATE folder_access_requests
    SET status = ${status}, end_reason = ${reason}, ended_at = now(), updated_at = now(),
        consent_segments = '[]'::jsonb, windows_user = NULL, helper_hostname = NULL,
        enroll_code_hash = NULL, enroll_code_expires_at = NULL
    WHERE id = ${ctx.id}
      AND status IN ('device_pending', 'helper_pending', 'consent_pending', 'active')
    RETURNING *
  `;
  const row = updated[0];
  if (!row) return false;
  await tx`
    UPDATE folder_access_ops
    SET status = 'cancelled', completed_at = now()
    WHERE request_id = ${ctx.id} AND status IN ('queued', 'delivered')
  `;
  await tx`UPDATE folder_access_ops SET segments = '[]'::jsonb WHERE request_id = ${ctx.id}`;
  await tx`DELETE FROM folder_access_results WHERE request_id = ${ctx.id}`;
  if (ctx.helper_id) {
    await tx`
      UPDATE folder_access_helpers
      SET revoked_at = COALESCE(revoked_at, now()), user_name = NULL
      WHERE id = ${ctx.helper_id}
    `;
  }
  await appendFolderAudit(tx, endAuditAction(status), ctx, actorEmail, {
    status,
    endReason: reason,
    startedAt: ctx.consented_at?.toISOString() ?? null,
    endedAt: new Date().toISOString(),
  });
  // 応答に消したはずの値を出さないように、DB の値で置き換える。
  Object.assign(ctx, row);
  return true;
}

/** active の同意に対する毎操作の検証（docs/62 §6）。 */
export function activeViolation(ctx: RequestContext): EndReason | null {
  return bindingViolation({
    consentExpired: ctx.consent_expired,
    handoverStatus: ctx.handover_status,
    claimedBy: ctx.claimed_by,
    assigneeEmail: ctx.assignee_email,
    ownerEmail: ctx.owner_email,
    requesterEmail: ctx.requester_email,
    helperPresent: Boolean(ctx.helper_id),
    helperRevoked: ctx.helper_revoked === true,
    helperStale: ctx.helper_stale === true,
    helperBoundToRequest: ctx.helper_request_id === ctx.id,
  });
}

/** 期限と束縛を確認し、違反があれば同じトランザクションで終了させる。 */
export async function applyExpiryAndBinding(
  tx: Tx,
  ctx: RequestContext,
  actorEmail: string,
): Promise<void> {
  if (isTerminal(ctx.status)) return;
  if (ctx.status === 'active') {
    const violation = activeViolation(ctx);
    if (violation) await endRequestTx(tx, ctx, violation, actorEmail);
    return;
  }
  if (ctx.request_expired) {
    await endRequestTx(tx, ctx, 'expired', actorEmail);
    return;
  }
  if (
    ctx.claimed_by !== ctx.assignee_email ||
    !['claimed', 'resolved'].includes(ctx.handover_status)
  ) {
    await endRequestTx(tx, ctx, 'assignee_changed', actorEmail);
  }
}

// ── 端末の確定（device_pending → helper_pending） ────────────────

/** 別名でも同じ社員に解決する（helpdesk-scope と同じ方針）。 */
async function findRequesterEmployee(email: string) {
  for (const candidate of emailVariants(email)) {
    const employee = await findEmployeeByEmail(candidate);
    if (employee) return employee;
  }
  return null;
}

export interface DeviceInput {
  rspDeviceId?: string;
  hostname?: string;
}

type DeviceOutcome =
  | { kind: 'pending'; code: string }
  | { kind: 'mismatch' }
  | {
      kind: 'ready';
      lease: Extract<LeaseResult, { kind: 'verified' }> | null;
      hostname: string;
      rspDeviceId: string;
      meshNodeId: string | null;
      logId: string;
    };

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof ApiError && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code;
  return fallback;
}

/** 検証専用モードの担当者指定端末（device_mesh_links か、入力の hostname を RSP で確かめる）。 */
async function unverifiedHostname(input: DeviceInput): Promise<string | null> {
  if (input.hostname) return input.hostname;
  const rows = await sql<{ hostname: string }[]>`
    SELECT hostname FROM device_mesh_links WHERE rsp_device_id = ${input.rspDeviceId ?? ''}::uuid
    LIMIT 2
  `;
  return rows.length === 1 ? (rows[0]?.hostname ?? null) : null;
}

async function determineDevice(
  ctx: RequestContext,
  input: DeviceInput,
  deps: { allowUnverified: boolean },
): Promise<DeviceOutcome> {
  let hostname: string;
  let lease: Extract<LeaseResult, { kind: 'verified' }> | null = null;
  if (deps.allowUnverified && (input.rspDeviceId || input.hostname)) {
    const target = await unverifiedHostname(input);
    if (!target) return { kind: 'pending', code: 'DEVICE_NOT_LINKED' };
    hostname = target;
  } else {
    const employee = await findRequesterEmployee(ctx.requester_email);
    if (!employee?.employeeNo) return { kind: 'pending', code: 'EMPLOYEE_UNRESOLVED' };
    const result = await fetchLease(employee.employeeNo);
    if (result.kind !== 'verified') return { kind: 'pending', code: result.code };
    lease = result;
    hostname = result.hostname;
  }

  try {
    const lookup = await lookupRspDevices(hostname);
    if (lookup.matches.length === 0) return { kind: 'pending', code: 'RSP_DEVICE_NONE' };
    if (lookup.matches.length > 1) return { kind: 'pending', code: 'RSP_DEVICE_MULTIPLE' };
    const match = lookup.matches[0];
    if (!match) return { kind: 'pending', code: 'RSP_DEVICE_NONE' };
    // 担当者の指定が貸与情報の端末と食い違うときは推測で進めない。
    if (input.rspDeviceId && input.rspDeviceId !== match.device_id) {
      return { kind: 'pending', code: 'LEASE_CONFLICT' };
    }
    // 貸与情報と RSP の nodeId が両方あって食い違うときは確定しない。
    if (lease?.meshNodeId && match.mesh_node_id && lease.meshNodeId !== match.mesh_node_id) {
      return { kind: 'pending', code: 'LEASE_CONFLICT' };
    }
    if (!match.agent_installed) return { kind: 'pending', code: 'RSP_AGENT_NOT_INSTALLED' };
    // オフラインの端末へ固定テンプレートを積まない（復帰時に承認なしで実行されるのを防ぐ）。
    if (match.agent_online !== true) return { kind: 'pending', code: 'RSP_AGENT_OFFLINE' };
    const enqueued = await enqueueDeviceIdentityProbe(match.hostname, ctx.id);
    // hostname だけを根拠にしない。キューへ積まれた端末が検索結果と同じことを確かめる。
    if (enqueued.deviceId !== match.device_id) return { kind: 'mismatch' };
    return {
      kind: 'ready',
      lease,
      hostname: match.hostname,
      rspDeviceId: match.device_id,
      meshNodeId: match.mesh_node_id ?? null,
      logId: enqueued.logId,
    };
  } catch (error) {
    return { kind: 'pending', code: errorCode(error, 'RSP_UNAVAILABLE') };
  }
}

/** 貸与情報と RSP を照合して次へ進める。確定できない理由は reason_code に残す。 */
export async function resolveDevice(
  id: string,
  input: DeviceInput,
  actorEmail: string,
): Promise<void> {
  const snapshot = await sql.begin((tx) => loadContext(tx, id));
  if (!snapshot || isTerminal(snapshot.status)) return;
  const allowUnverified = config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE && !config.isProduction;
  const outcome = await determineDevice(snapshot, input, { allowUnverified });

  await sql.begin(async (tx) => {
    const ctx = await loadContext(tx, id);
    if (!ctx || !['device_pending', 'helper_pending'].includes(ctx.status)) return;
    if (outcome.kind === 'mismatch') {
      await endRequestTx(tx, ctx, 'device_mismatch', actorEmail);
      return;
    }
    if (outcome.kind === 'pending') {
      await tx`
        UPDATE folder_access_requests
        SET reason_code = ${outcome.code}, updated_at = now()
        WHERE id = ${id}
      `;
      await appendFolderAudit(tx, 'folder_access.request', ctx, actorEmail, {
        status: ctx.status,
        reasonCode: outcome.code,
      });
      return;
    }
    const leaseStatus = outcome.lease ? 'verified' : 'unverified';
    await tx`
      UPDATE folder_access_requests
      SET status = 'helper_pending',
          reason_code = NULL,
          lease_status = ${leaseStatus},
          lease_source = ${outcome.lease?.source ?? null},
          lease_asset_tag = ${outcome.lease?.assetTag ?? null},
          lease_fetched_at = ${outcome.lease?.fetchedAt ?? null},
          lease_generated_at = ${outcome.lease?.generatedAt ?? null},
          rsp_device_id = ${outcome.rspDeviceId},
          mesh_node_id = ${outcome.meshNodeId},
          rsp_hostname = ${outcome.hostname},
          rsp_probe_log_id = ${outcome.logId},
          rsp_probe_status = 'pending',
          rsp_probe_attempts = 1,
          rsp_probe_reads = 0,
          rsp_probe_checked_at = NULL,
          updated_at = now()
      WHERE id = ${id}
    `;
    ctx.rsp_device_id = outcome.rspDeviceId;
    ctx.mesh_node_id = outcome.meshNodeId;
    ctx.rsp_hostname = outcome.hostname;
    ctx.lease_status = leaseStatus;
    await appendFolderAudit(tx, 'folder_access.request', ctx, actorEmail, {
      status: 'helper_pending',
    });
  });
}

/**
 * 貸与情報を同意の直前に取り直す。確定時と同じ端末でなければ lease_conflict で終了する。
 * 取得できないときは同意を進めない（呼び出し側へコードを返す）。
 */
export async function revalidateLease(ctx: RequestContext): Promise<string | 'conflict' | null> {
  if (ctx.lease_status !== 'verified') return null;
  const employee = await findRequesterEmployee(ctx.requester_email);
  if (!employee?.employeeNo) return 'EMPLOYEE_UNRESOLVED';
  const lease = await fetchLease(employee.employeeNo);
  if (lease.kind !== 'verified') {
    return ['LEASE_NONE', 'LEASE_MULTIPLE'].includes(lease.code) ? 'conflict' : lease.code;
  }
  return lease.hostname.toLowerCase() === (ctx.rsp_hostname ?? '').toLowerCase()
    ? null
    : 'conflict';
}

// ── RSP の固定テンプレート結果の照合（helper_pending → consent_pending） ──

function isProbeOutstanding(ctx: RequestContext): boolean {
  return (
    ctx.status === 'helper_pending' &&
    Boolean(ctx.helper_id && ctx.machine_guid && ctx.rsp_probe_log_id) &&
    ctx.session_id !== null &&
    ctx.rsp_probe_status === 'pending'
  );
}

/**
 * ペアリング後に RSP の結果を取りに行く。完了していなければ次の機会に再確認する。
 * 出力はここで解釈して捨てる（ユーザー名を含むため保存・ログ出力しない）。
 */
export async function reconcileProbe(
  id: string,
  actorEmail: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const snapshot = await sql.begin((tx) => loadContext(tx, id));
  if (!snapshot || !isProbeOutstanding(snapshot) || !snapshot.rsp_hostname) return;
  if (!snapshot.rsp_probe_log_id) return;
  const logId = snapshot.rsp_probe_log_id;
  const hostname = snapshot.rsp_hostname;

  // 問い合わせの枠を原子的に予約する（同時の確認で間隔と回数を超えない）。
  const force = options.force === true;
  const reserved = await sql<{ id: string }[]>`
    UPDATE folder_access_requests
    SET rsp_probe_checked_at = now(), rsp_probe_reads = rsp_probe_reads + 1
    WHERE id = ${id}
      AND status = 'helper_pending'
      AND rsp_probe_status = 'pending'
      AND rsp_probe_log_id = ${logId}
      AND rsp_probe_reads < ${LIMITS.maxProbeReads}
      AND (${force} OR rsp_probe_checked_at IS NULL OR rsp_probe_checked_at
        <= now() - (${LIMITS.probeCheckSeconds}::int * interval '1 second'))
    RETURNING id
  `;
  if (!reserved[0]) {
    // 上限まで問い合わせても終わらないものは待ち続けない。担当者の再確認で数え直す。
    await sql`
      UPDATE folder_access_requests
      SET rsp_probe_status = 'failed', reason_code = 'RSP_PROBE_TIMEOUT', updated_at = now()
      WHERE id = ${id}
        AND status = 'helper_pending'
        AND rsp_probe_status = 'pending'
        AND rsp_probe_log_id = ${logId}
        AND rsp_probe_reads >= ${LIMITS.maxProbeReads}
    `;
    return;
  }

  let probe: Awaited<ReturnType<typeof fetchDeviceIdentityProbe>> | null = null;
  try {
    probe = await fetchDeviceIdentityProbe(logId);
  } catch {
    probe = null;
  }
  // AGENT_BUSY は未実行が確定しているので再投入してよい（他の失敗は自動再試行しない）。
  const busy = probe?.status === 'failed' && probe.errorCode === 'AGENT_BUSY';
  // ヘルパーの登録より前の quser ではセッションを判断できないので取り直す。
  const stale =
    probe?.status === 'completed' &&
    snapshot.helper_created_at !== null &&
    probeCompletedBefore(probe.completedAt, snapshot.helper_created_at);
  let staleExhausted = false;
  if (busy || stale) {
    // 再投入の権利を原子的に取る。確認の時刻を未来にして、投入が終わるまで他の確認を止める。
    // 結果の参照は残すので、途中で落ちても期限が過ぎれば確認を再開できる。
    const claimed = await sql<{ id: string }[]>`
      UPDATE folder_access_requests
      SET rsp_probe_attempts = rsp_probe_attempts + 1,
          rsp_probe_checked_at = now() + (${LIMITS.probeRequeueSeconds}::int * interval '1 second'),
          updated_at = now()
      WHERE id = ${id}
        AND status = 'helper_pending'
        AND rsp_probe_status = 'pending'
        AND rsp_probe_log_id = ${logId}
        AND rsp_probe_attempts = ${snapshot.rsp_probe_attempts}
        AND rsp_probe_attempts < ${LIMITS.maxProbeAttempts}
      RETURNING id
    `;
    if (claimed[0]) {
      await requeueProbe(id, hostname, logId, actorEmail);
      return;
    }
    // 上限に達しても古い結果では進めない（fail-closed）。担当者の再確認でやり直せる。
    if (stale) staleExhausted = true;
  }

  await sql.begin(async (tx) => {
    const ctx = await loadContext(tx, id);
    if (!ctx || !isProbeOutstanding(ctx) || ctx.rsp_probe_log_id !== logId) return;
    if (!ctx.machine_guid || ctx.session_id === null) return;
    if (!probe) {
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_checked_at = now(), reason_code = 'RSP_PROBE_UNAVAILABLE', updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    if (staleExhausted) {
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_status = 'failed', reason_code = 'RSP_PROBE_STALE',
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    if (probe.status === 'failed') {
      const code = `RSP_${probe.errorCode ?? 'EXECUTION_FAILED'}`.replace(/[^A-Z0-9_]/g, '_');
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_status = 'failed', reason_code = ${code},
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    if (isProbeRunning(probe.status)) {
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_checked_at = now(), reason_code = NULL, updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    if (probe.status !== 'completed') {
      // 実行中と分からない状態を待ち続けない。理由を出して担当者の再確認に任せる。
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_status = 'failed', reason_code = 'RSP_PROBE_UNKNOWN_STATUS',
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }

    const parsed = parseProbeOutput(probe.output);
    if (!parsed) {
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_status = 'failed', reason_code = 'RSP_PROBE_INVALID',
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    const decision = evaluateProbe(parsed, {
      machineGuid: ctx.machine_guid,
      sessionId: ctx.session_id,
      userName: ctx.windows_user,
    });
    if (decision.kind === 'device_mismatch') {
      await endRequestTx(tx, ctx, 'device_mismatch', actorEmail);
      return;
    }
    if (decision.kind === 'pending') {
      await tx`
        UPDATE folder_access_requests
        SET rsp_probe_status = 'completed', reason_code = ${decision.code},
            rsp_machine_guid = ${parsed.machineGuid},
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    await tx`
      UPDATE folder_access_requests
      SET status = 'consent_pending', reason_code = NULL,
          rsp_probe_status = 'completed',
          rsp_machine_guid = ${parsed.machineGuid},
          rsp_probe_checked_at = now(), updated_at = now()
      WHERE id = ${id}
    `;
  });
}

/** 予約済みの再投入。投入先の端末が確定した端末と違えば終了する（hostname だけを根拠にしない）。 */
async function requeueProbe(
  id: string,
  hostname: string,
  previousLogId: string,
  actorEmail: string,
): Promise<void> {
  let enqueued: Awaited<ReturnType<typeof enqueueDeviceIdentityProbe>> | null = null;
  try {
    enqueued = await enqueueDeviceIdentityProbe(hostname, id);
  } catch {
    enqueued = null;
  }
  await sql.begin(async (tx) => {
    const ctx = await loadContext(tx, id);
    if (!ctx || ctx.status !== 'helper_pending' || ctx.rsp_probe_log_id !== previousLogId) return;
    if (!enqueued) {
      await tx`
        UPDATE folder_access_requests
        SET reason_code = 'RSP_PROBE_UNAVAILABLE',
            rsp_probe_checked_at = now(), updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    await tx`
      UPDATE folder_access_requests
      SET rsp_probe_log_id = ${enqueued.logId}, reason_code = NULL,
          rsp_probe_checked_at = now(), updated_at = now()
      WHERE id = ${id}
    `;
    if (enqueued.deviceId !== ctx.rsp_device_id) {
      await endRequestTx(tx, ctx, 'device_mismatch', actorEmail);
    }
  });
}

// ── 定期掃除（常駐側。RSP には触れない） ─────────────────────────

/**
 * 期限切れの同意を終了し、結果を消す。誰も画面を開かなくてもファイル名を残さないための掃除。
 * DB だけを触る。機能フラグが無効でも実行する（無効化後に結果を残さない）。
 */
export async function sweepFolderAccess(): Promise<number> {
  const due = await sql<{ id: string }[]>`
    SELECT r.id
    FROM folder_access_requests r
    LEFT JOIN folder_access_helpers hp ON hp.id = r.helper_id
    WHERE (r.status = 'active' AND (
             r.consent_expires_at <= now()
             OR hp.id IS NULL
             OR hp.revoked_at IS NOT NULL
             OR hp.last_seen_at <= now() - (${LIMITS.helperStaleSeconds}::int * interval '1 second')
           ))
       OR (r.status IN ('device_pending', 'helper_pending', 'consent_pending')
           AND r.request_expires_at <= now())
  `;
  let ended = 0;
  for (const { id } of due) {
    await sql.begin(async (tx) => {
      const ctx = await loadContext(tx, id);
      if (!ctx) return;
      const before = ctx.status;
      await applyExpiryAndBinding(tx, ctx, 'system:sweep');
      if (ctx.status !== before) ended += 1;
    });
  }
  await sql`
    UPDATE folder_access_ops
    SET status = 'expired', completed_at = now()
    WHERE status IN ('queued', 'delivered') AND expires_at <= now()
  `;
  // ペアリングされないまま期限が切れたヘルパーは失効させ、登録情報を消す。
  // 行は残す（次の poll で revoked:true を返すと、ヘルパーが自動で再登録せずに止まる）。
  await sql`
    UPDATE folder_access_helpers
    SET revoked_at = COALESCE(revoked_at, now()), user_name = NULL, hostname = NULL,
        pairing_code_hash = NULL
    WHERE request_id IS NULL AND pairing_expires_at <= now()
      AND (revoked_at IS NULL OR user_name IS NOT NULL)
  `;
  // 登録は未認証で行えるので、残骸を際限なく増やさない。
  await sql`
    DELETE FROM folder_access_helpers
    WHERE request_id IS NULL
      AND pairing_expires_at <= now() - (${LIMITS.unpairedRetentionMinutes}::int * interval '1 minute')
  `;
  await scrubExpiredIdentifiers();
  return ended;
}

/**
 * 終了から保持期間を過ぎた行の識別子を消す（docs/62 §7-1）。
 * 状態・終了理由・時刻は残す。監査ログには触れない（SID はハッシュしか入っていない）。
 */
async function scrubExpiredIdentifiers(): Promise<void> {
  const days = config.FOLDER_ACCESS_RETENTION_DAYS;
  await sql`
    UPDATE folder_access_ops o
    SET sid = NULL, root = NULL
    FROM folder_access_requests r
    WHERE o.request_id = r.id
      AND r.ended_at <= now() - (${days}::int * interval '1 day')
      AND (o.sid IS NOT NULL OR o.root IS NOT NULL)
  `;
  await sql`
    UPDATE folder_access_helpers hp
    SET sid = NULL, machine_guid = NULL, hostname = NULL, user_name = NULL,
        pairing_code_hash = NULL, revoked_at = COALESCE(hp.revoked_at, now())
    FROM folder_access_requests r
    WHERE hp.request_id = r.id
      AND r.ended_at <= now() - (${days}::int * interval '1 day')
      AND (hp.sid IS NOT NULL OR hp.machine_guid IS NOT NULL OR hp.hostname IS NOT NULL)
  `;
  await sql`
    UPDATE folder_access_requests
    SET sid = NULL, session_id = NULL, machine_guid = NULL, consent_root = NULL,
        rsp_hostname = NULL, rsp_device_id = NULL, mesh_node_id = NULL, rsp_machine_guid = NULL,
        rsp_probe_log_id = NULL, lease_asset_tag = NULL, windows_user = NULL,
        helper_hostname = NULL
    WHERE ended_at <= now() - (${days}::int * interval '1 day')
      AND (sid IS NOT NULL OR session_id IS NOT NULL OR machine_guid IS NOT NULL
           OR consent_root IS NOT NULL OR rsp_hostname IS NOT NULL OR rsp_device_id IS NOT NULL
           OR mesh_node_id IS NOT NULL OR rsp_machine_guid IS NOT NULL
           OR rsp_probe_log_id IS NOT NULL OR lease_asset_tag IS NOT NULL
           OR windows_user IS NOT NULL OR helper_hostname IS NOT NULL)
  `;
}

export function startFolderAccessSweeper(log: {
  error: (obj: unknown, msg: string) => void;
}): () => void {
  const timer = setInterval(() => {
    sweepFolderAccess().catch((error: unknown) => {
      log.error({ err: error }, 'フォルダ一覧の期限処理に失敗しました。');
    });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
