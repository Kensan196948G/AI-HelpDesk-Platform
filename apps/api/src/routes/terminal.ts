import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { proposePowerShell } from '../ai/deepseek.js';
import { authenticateTerminal } from '../auth/rsp-integration.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import {
  maskFinalReport,
  renderFinalReportHtml,
  reportPdfFilename,
} from '../domain/final-report.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import {
  buildCaseContext,
  buildPcContext,
  type CaseSnapshot,
  normalizeState,
} from '../lib/case-handover.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { findEmployeeByEmail } from '../lib/mirai-info.js';
import { nextKbNo } from '../lib/numbers.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { ensureAuthorUser, userIdForEmail } from '../lib/users.js';
import { fetchRspCommandCorrelation, isRspConfigured } from '../remote-support/rsp.js';
import { assertCaptureAllowed, captureCapability } from '../terminal/capture.js';
import { buildTerminalCaseContext } from '../terminal/context.js';
import { buildKnowledgeDraft, buildTerminalReport } from '../terminal/report.js';
import {
  CloseSchema,
  CreateSessionSchema,
  computeStepHash,
  KnowledgeDraftSchema,
  MAX_OUTPUT_CHARS,
  MAX_STEPS,
  maskText,
  ProposeSchema,
  RecordSchema,
  sessionDto,
  stepDto,
  type TerminalSessionRow,
  type TerminalStepRow,
} from '../terminal/session.js';
import { type HandoverRow, latestHandoverForCase, requireHelpdesk } from './case-handovers.js';

const CaseQuerySchema = z.object({ caseId: z.string().trim().min(1).max(40) });
const CreateBodySchema = CreateSessionSchema.extend({
  caseId: z.string().trim().min(1).max(40),
});
const SessionParamsSchema = z.object({ id: z.string().uuid() });
const StepParamsSchema = z.object({ id: z.string().uuid() });
const CasesQuerySchema = z.object({
  hostname: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 監査の経路（Access の画面操作か、RSP からの連携か）。 */
function auditVia(request: FastifyRequest): 'rsp' | 'ui' {
  return request.integration === 'rsp' ? 'rsp' : 'ui';
}
const REPORT_DAILY_LIMIT = 50;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: string }).code === '23505',
  );
}

function deviceOf(handover: HandoverRow): string {
  const snapshot = normalizeState(handover.snapshot) as CaseSnapshot | null;
  const caseRecord = (snapshot?.case ?? {}) as Record<string, unknown>;
  const pc = caseRecord.pc as Record<string, unknown> | undefined;
  const snap = pc?.snap as Record<string, unknown> | undefined;
  return String(snap?.device ?? caseRecord.device ?? 'unknown').slice(0, 120);
}

async function loadSession(id: string): Promise<TerminalSessionRow | undefined> {
  const rows = await sql<TerminalSessionRow[]>`
    SELECT * FROM terminal_sessions WHERE id = ${id} LIMIT 1
  `;
  return rows[0];
}

async function loadSteps(sessionId: string): Promise<TerminalStepRow[]> {
  return sql<TerminalStepRow[]>`
    SELECT * FROM terminal_steps WHERE session_id = ${sessionId} ORDER BY seq
  `;
}

/**
 * セッション終了時の警告（SM-07）。
 * 実行記録が無いと報告書が 409 NO_RECORDED_STEPS で作れないため、
 * 終了は許可したまま「このままでは報告書を作れない」ことを返す。
 */
function closeWarnings(steps: TerminalStepRow[]): string[] {
  if (steps.some((step) => step.recorded_at)) return [];
  return [
    '実行記録がありません。このままでは報告書を作成できません（少なくとも1ステップのコマンドと結果を記録してください）。',
  ];
}

async function loadHandoverForSession(
  session: TerminalSessionRow,
): Promise<HandoverRow | undefined> {
  if (session.handover_id) {
    const rows = await sql<HandoverRow[]>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
      FROM case_handovers WHERE id = ${session.handover_id} LIMIT 1
    `;
    if (rows[0]) return rows[0];
  }
  return latestHandoverForCase(session.case_id);
}

/**
 * 期限切れの active セッションを閉じる（遅延評価）。
 * 常駐ジョブを増やさず、参照・操作のたびに 1 回だけ判定する。
 */
async function expireIfNeeded(
  session: TerminalSessionRow,
  actorEmail: string,
): Promise<TerminalSessionRow> {
  if (session.status !== 'active') return session;
  if (new Date(session.expires_at).getTime() > Date.now()) return session;
  const next = await sql.begin(async (tx) => {
    const rows = await tx<TerminalSessionRow[]>`
      UPDATE terminal_sessions
      SET status = 'closed', close_reason = 'expired', closed_at = now(), updated_at = now()
      WHERE id = ${session.id} AND status = 'active'
      RETURNING *
    `;
    if (!rows[0]) return undefined;
    await appendAudit(tx, {
      actorId: await userIdForEmail(actorEmail),
      action: 'terminal.session.expire',
      targetType: 'terminal_session',
      targetId: session.id,
      // 監査 detail は jsonb に保存されるため、Date のまま渡さず ISO 文字列にする（G-01-F1）。
      // Date を渡すと保存値（ISO 文字列）とハッシュ計算時（{}）が食い違い、鎖が破断する。
      detail: {
        actorEmail,
        caseId: session.case_id,
        expiresAt: session.expires_at.toISOString(),
      },
    });
    return rows[0];
  });
  return next ?? session;
}

/** operator（claim した担当者）だけが状態を変えられる。 */
function assertOperator(session: TerminalSessionRow, email: string): void {
  if (session.operator_email !== email) {
    throw forbidden('このRSP実行セッションを操作できるのは、引き受けた担当者だけです。');
  }
}

/** 参照は operator・依頼者・DX 推進部（本番のみ名簿で判定）に限る。 */
async function assertCanView(
  session: TerminalSessionRow,
  handover: HandoverRow | undefined,
  email: string,
): Promise<void> {
  if (session.operator_email === email) return;
  if (handover?.owner_email === email) return;
  await requireHelpdesk(email);
}

interface KnowledgeSummary {
  id: string;
  kbNo: string;
  status: string;
  title: string;
}

/** 作成済みのナレッジ下書き（再読み込み時にも kbNo を表示するため）。 */
async function knowledgeSummaryOf(session: TerminalSessionRow): Promise<KnowledgeSummary | null> {
  if (!session.knowledge_id) return null;
  const rows = await sql<{ id: string; kb_no: string; title: string; status: string }[]>`
    SELECT id, kb_no, title, status FROM knowledge WHERE id = ${session.knowledge_id} LIMIT 1
  `;
  const row = rows[0];
  return row ? { id: row.id, kbNo: row.kb_no, status: row.status, title: row.title } : null;
}

function sessionWithSteps(
  session: TerminalSessionRow,
  stepCount: number,
  knowledge: KnowledgeSummary | null = null,
): ReturnType<typeof sessionDto> {
  return sessionDto(session, {
    stepCount,
    capture: captureCapability(),
    knowledge,
  });
}

async function operatorName(email: string): Promise<string> {
  try {
    const employee = await findEmployeeByEmail(email);
    return employee?.name ?? email;
  } catch {
    return email;
  }
}

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  /** その案件の最新セッション（復元用）。 */
  app.get('/terminal/sessions', { preHandler: authenticateTerminal }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const { caseId } = CaseQuerySchema.parse(request.query ?? {});
    const handover = await latestHandoverForCase(caseId);
    if (!handover) throw notFound('この案件の引継ぎが見つかりません。');
    const rows = await sql<TerminalSessionRow[]>`
      SELECT * FROM terminal_sessions
      WHERE handover_id = ${handover.id}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    let session = rows[0];
    if (!session) {
      if (handover.claimed_by !== request.uiEmail && handover.owner_email !== request.uiEmail) {
        await requireHelpdesk(request.uiEmail);
      }
      return { ok: true, session: null, steps: [] };
    }
    await assertCanView(session, handover, request.uiEmail);
    session = await expireIfNeeded(session, request.uiEmail);
    const steps = await loadSteps(session.id);
    return {
      ok: true,
      session: sessionWithSteps(session, steps.length, await knowledgeSummaryOf(session)),
      steps: steps.map(stepDto),
    };
  });

  /** セッションを作る（claim 済みの担当者のみ・同意必須）。 */
  app.post(
    '/terminal/sessions',
    { preHandler: authenticateTerminal, bodyLimit: 16 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const body = CreateBodySchema.parse(request.body ?? {});
      const handover = await latestHandoverForCase(body.caseId);
      if (!handover) throw notFound('この案件の引継ぎが見つかりません。');
      if (!handover.claimed_by) {
        throw new ApiError(
          403,
          'NOT_CLAIMED_OPERATOR',
          'この案件はまだ引き受けられていません。先に受信箱から引き受けてください。',
        );
      }
      if (handover.claimed_by !== email) {
        throw new ApiError(
          403,
          'NOT_CLAIMED_OPERATOR',
          'この案件を引き受けた担当者だけが開始できます。',
        );
      }
      if (!['claimed', 'resolved'].includes(handover.status)) {
        throw new ApiError(409, 'HANDOVER_NOT_ACTIVE', 'この引継ぎは処理済みです。');
      }
      if (!body.consent.remoteControl) {
        throw new ApiError(
          400,
          'CONSENT_REQUIRED',
          'ターミナル操作には「操作支援」への同意が必要です。',
        );
      }
      const activeRows = await sql<TerminalSessionRow[]>`
      SELECT * FROM terminal_sessions
      WHERE handover_id = ${handover.id} AND status = 'active'
      LIMIT 1
    `;
      if (activeRows[0]) {
        const active = await expireIfNeeded(activeRows[0], email);
        if (active.status === 'active') {
          throw new ApiError(
            409,
            'SESSION_ACTIVE',
            'この案件には進行中のRSP実行セッションがあります。',
            {
              sessionId: active.id,
            },
          );
        }
      }

      const expiresAt = new Date(Date.now() + body.ttlMinutes * 60_000);
      const inserted = await sql
        .begin(async (tx) => {
          const rows = await tx<TerminalSessionRow[]>`
        INSERT INTO terminal_sessions (
          case_id, handover_id, device, operator_email, requester_email,
          consent_screen_share, consent_remote_control, ai_model, expires_at
        ) VALUES (
          ${handover.case_id}, ${handover.id}, ${deviceOf(handover)}, ${email},
          ${handover.owner_email}, ${body.consent.screenShare}, true,
          ${config.DEEPSEEK_MODEL}, ${expiresAt.toISOString()}
        )
        RETURNING *
      `;
          const session = rows[0];
          if (!session)
            throw new ApiError(500, 'SESSION_CREATE_FAILED', 'セッションを作成できませんでした。');
          await appendAudit(tx, {
            actorId: await userIdForEmail(email),
            action: 'terminal.session.start',
            targetType: 'terminal_session',
            targetId: session.id,
            detail: {
              via: auditVia(request),
              actorEmail: email,
              caseId: handover.case_id,
              handoverId: handover.id,
              device: session.device,
              consent: { screenShare: body.consent.screenShare, remoteControl: true },
              ttlMinutes: body.ttlMinutes,
            },
          });
          return session;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new ApiError(
              409,
              'SESSION_ACTIVE',
              'この案件には進行中のRSP実行セッションがあります。',
            );
          }
          throw error;
        });

      return { ok: true, session: sessionWithSteps(inserted, 0), steps: [] };
    },
  );

  app.get('/terminal/sessions/:id', { preHandler: authenticateTerminal }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const { id } = SessionParamsSchema.parse(request.params);
    const found = await loadSession(id);
    if (!found) throw notFound('RSP実行セッションが見つかりません。');
    const handover = await loadHandoverForSession(found);
    await assertCanView(found, handover, request.uiEmail);
    const session = await expireIfNeeded(found, request.uiEmail);
    const steps = await loadSteps(session.id);
    return {
      ok: true,
      session: sessionWithSteps(session, steps.length, await knowledgeSummaryOf(session)),
      steps: steps.map(stepDto),
    };
  });

  /**
   * 案件の文脈（案件・依頼者・引継ぎ・PC情報・最新セッション）。
   * RSP の AI支援パネルが最初に読む（[docs/36-rsp-integration.md] §3-1）。
   */
  app.get('/terminal/context', { preHandler: authenticateTerminal }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const { caseId } = CaseQuerySchema.parse(request.query ?? {});
    const handover = await latestHandoverForCase(caseId);
    if (!handover) throw notFound('この案件の引継ぎが見つかりません。');
    if (request.uiEmail !== handover.claimed_by && request.uiEmail !== handover.owner_email) {
      await requireHelpdesk(request.uiEmail);
    }
    const sessionRows = await sql<TerminalSessionRow[]>`
      SELECT * FROM terminal_sessions
      WHERE handover_id = ${handover.id}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    let session = sessionRows[0];
    if (session) session = await expireIfNeeded(session, request.uiEmail);
    const steps = session ? await loadSteps(session.id) : [];
    const requesterName = await operatorName(handover.owner_email);
    const context = buildTerminalCaseContext(
      handover,
      requesterName && requesterName !== handover.owner_email ? requesterName : null,
    );
    return {
      ok: true,
      ...context,
      session: session
        ? sessionWithSteps(session, steps.length, await knowledgeSummaryOf(session))
        : null,
    };
  });

  /**
   * 担当者が claim した案件の一覧（RSP の端末から案件を探す用）。
   * hostname はスナップショットの対象端末名（大文字小文字無視）。
   */
  app.get('/terminal/cases', { preHandler: authenticateTerminal }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    const query = CasesQuerySchema.parse(request.query ?? {});
    const hostname = query.hostname?.trim() || null;
    const rows = await sql<Array<HandoverRow & { updated_at: Date }>>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved,
             created_at, updated_at
      FROM case_handovers
      WHERE claimed_by = ${email}
        AND status IN ('claimed', 'resolved')
        AND (
          ${hostname}::text IS NULL
          OR upper(snapshot #>> '{case,pc,snap,device}') = upper(${hostname})
        )
      ORDER BY updated_at DESC
      LIMIT ${query.limit}
    `;
    const ids = rows.map((row) => row.id);
    const sessions = ids.length
      ? await sql<{ handover_id: string; id: string; status: string }[]>`
          SELECT DISTINCT ON (handover_id) handover_id, id, status
          FROM terminal_sessions
          WHERE handover_id IN ${sql(ids)}
          ORDER BY handover_id, started_at DESC
        `
      : [];
    const byHandover = new Map(sessions.map((session) => [session.handover_id, session]));
    return {
      ok: true,
      items: rows.map((row) => {
        const context = buildTerminalCaseContext(row, null);
        const session = byHandover.get(row.id);
        return {
          caseId: row.case_id,
          subject: context.case.subject,
          requesterEmail: row.owner_email,
          device: context.handover.device,
          handoverId: row.id,
          handoverStatus: row.status,
          claimedBy: row.claimed_by,
          updatedAt: new Date(row.updated_at).toISOString(),
          session: session ? { id: session.id, status: session.status } : null,
        };
      }),
    };
  });

  /** AI に次の一手を提案させる（実行はしない）。 */
  app.post(
    '/terminal/sessions/:id/steps',
    { preHandler: authenticateTerminal, bodyLimit: 32 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = SessionParamsSchema.parse(request.params);
      const body = ProposeSchema.parse(request.body ?? {});
      const found = await loadSession(id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      assertOperator(found, email);
      if (!checkRateLimit(`terminal-propose:${email}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'AIへの提案依頼が多すぎます。少し待ってください。');
      }
      const session = await expireIfNeeded(found, email);
      if (session.status !== 'active') {
        throw new ApiError(409, 'SESSION_CLOSED', 'このRSP実行セッションは終了しています。');
      }
      const steps = await loadSteps(session.id);
      if (steps.length >= MAX_STEPS) {
        throw new ApiError(
          409,
          'STEP_LIMIT',
          `1セッションのステップ上限（${MAX_STEPS}）に達しました。セッションを終了して報告書を作成してください。`,
        );
      }
      const handover = await loadHandoverForSession(session);
      const snapshot = normalizeState(handover?.snapshot) as CaseSnapshot | null;

      const history = steps
        .slice(-5)
        .map((step) =>
          [
            `#${step.seq} 目的: ${step.intent ?? ''}`,
            `提案: ${step.ai_command ?? ''}`,
            `実行: ${step.executed_command ?? '（未記録）'}`,
            `結果: ${step.exit_status ?? '不明'}`,
            step.output ? `出力: ${step.output.slice(0, 800)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n---\n');
      const context = [
        snapshot ? buildCaseContext(snapshot) : '',
        snapshot ? `PC情報:\n${buildPcContext(snapshot)}` : '',
        history ? `これまでの実行:\n${history}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 12_000);
      const lastRecorded = [...steps].reverse().find((step) => step.recorded_at);
      const lastOutput =
        body.lastOutput ?? (lastRecorded?.output ? lastRecorded.output.slice(0, 4_000) : undefined);

      let outcome: Awaited<ReturnType<typeof proposePowerShell>>;
      try {
        outcome = await proposePowerShell({ context, intent: body.intent, lastOutput });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.log.warn({ err: error }, 'terminal proposal failed');
        throw new ApiError(
          502,
          'AI_UNAVAILABLE',
          `AIの提案を取得できませんでした（${message}）。手順を確認して手動で実行してください。`,
        );
      }

      // SM-06: AI の「情報不足で安全なコマンドを特定できない」という辞退は
      // 障害（502）ではなく、提案なし＋理由として 200 で返す。
      if (outcome.declined) {
        return {
          ok: true,
          declined: true,
          step: null,
          proposal: null,
          reason: outcome.reason,
          model: outcome.model,
          session: sessionWithSteps(session, steps.length),
        };
      }
      const proposal = outcome.proposal;

      const command = maskText(proposal.command, 8_000).text;
      const inserted = await sql
        .begin(async (tx) => {
          const seqRows = await tx<{ next: number }[]>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next
          FROM terminal_steps WHERE session_id = ${session.id}
        `;
          const seq = Number(seqRows[0]?.next ?? 1);
          const rows = await tx<TerminalStepRow[]>`
          INSERT INTO terminal_steps (
            session_id, seq, operator_email, intent,
            ai_command, ai_purpose, ai_risk, ai_verify, ai_rollback, ai_warnings, ai_model
          ) VALUES (
            ${session.id}, ${seq}, ${email}, ${maskText(body.intent, 500).text},
            ${command}, ${proposal.purpose.slice(0, 2000)}, ${proposal.risk},
            ${proposal.verify.slice(0, 2000)}, ${proposal.rollback.slice(0, 2000)},
            ${jsonbValue(proposal.warnings)}, ${proposal.model}
          )
          RETURNING *
        `;
          await appendAudit(tx, {
            actorId: await userIdForEmail(email),
            action: 'terminal.step.propose',
            targetType: 'terminal_session',
            targetId: session.id,
            detail: {
              actorEmail: email,
              caseId: session.case_id,
              seq,
              risk: proposal.risk,
              model: proposal.model,
              commandHash: createHash('sha256').update(command).digest('hex').slice(0, 16),
            },
          });
          const row = rows[0];
          if (!row)
            throw new ApiError(500, 'STEP_CREATE_FAILED', 'ステップを作成できませんでした。');
          return row;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new ApiError(
              409,
              'STEP_CONFLICT',
              '同時に提案が保存されました。最新の状態を読み込んで再試行してください。',
            );
          }
          throw error;
        });

      return {
        ok: true,
        step: stepDto(inserted),
        session: sessionWithSteps(session, steps.length + 1),
      };
    },
  );

  /** 担当者が実際に実行したコマンドと出力を記録する。 */
  app.post(
    '/terminal/steps/:id/record',
    { preHandler: authenticateTerminal, bodyLimit: 128 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = StepParamsSchema.parse(request.params);
      const body = RecordSchema.parse(request.body ?? {});
      assertCaptureAllowed(body.outputSource);
      if (!checkRateLimit(`terminal-record:${email}`, 30, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '実行記録の更新が多すぎます。少し待ってください。');
      }
      const stepRows = await sql<TerminalStepRow[]>`
        SELECT * FROM terminal_steps WHERE id = ${id} LIMIT 1
      `;
      const step = stepRows[0];
      if (!step) throw notFound('ステップが見つかりません。');
      const found = await loadSession(step.session_id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      assertOperator(found, email);
      const session = await expireIfNeeded(found, email);
      if (session.status !== 'active') {
        throw new ApiError(409, 'SESSION_CLOSED', '終了したセッションには記録できません。');
      }
      if (step.recorded_at) {
        throw new ApiError(409, 'STEP_RECORDED', 'このステップはすでに記録されています。');
      }

      // SM-09: RSP のコマンド実行ログが「この案件の端末」の実行かを相関APIで確認する。
      // - 一致: 記録し、監査に rspDevice / rspOperator / rspStatus を残す
      // - 不一致: 409 RSP_DEVICE_MISMATCH（記録しない）
      // - RSP未設定: 従来どおり記録（rspVerified:false）
      // - RSP呼び出し失敗: 記録は許可し、warnings を返す（rspVerified:false）
      const warnings: string[] = [];
      const rspVerification: {
        verified: boolean;
        device?: string;
        operator?: string | null;
        status?: string;
      } = { verified: false };
      if (body.outputSource === 'rsp_command' && body.rspCommandLogId) {
        if (isRspConfigured()) {
          const correlation = await fetchRspCommandCorrelation(body.rspCommandLogId);
          if (correlation.kind === 'ok') {
            const sessionDevice = String(session.device ?? '').trim();
            const rspHostname = correlation.correlation.hostname;
            if (!sessionDevice) {
              warnings.push(
                'セッションの端末名が無いため、RSPの実行ログとの端末一致を確認できませんでした。',
              );
            } else if (sessionDevice.toLowerCase() !== rspHostname.toLowerCase()) {
              throw new ApiError(
                409,
                'RSP_DEVICE_MISMATCH',
                `RSPの実行ログは別の端末（${rspHostname}）のものです。このセッションの端末（${sessionDevice}）と一致しないため記録しません。`,
              );
            } else {
              rspVerification.verified = true;
              rspVerification.device = rspHostname;
              rspVerification.operator = correlation.correlation.operatorEmail;
              rspVerification.status = correlation.correlation.status;
            }
          } else if (correlation.kind === 'not_found') {
            throw new ApiError(
              409,
              'RSP_COMMAND_NOT_FOUND',
              `RSPに実行ログ（${body.rspCommandLogId}）が見つかりません。端末の相関を確認できないため記録しません。`,
            );
          } else {
            request.log.warn(
              { reason: correlation.reason, stepId: step.id },
              'RSP のコマンド相関確認に失敗しました（記録は継続します）',
            );
            warnings.push('RSPの相関確認ができなかったため、端末の一致確認は行っていません。');
          }
        }
      }

      const command = maskText(body.command, 8_000);
      const output = maskText(body.output ?? '', MAX_OUTPUT_CHARS);
      const sha256 = computeStepHash({
        sessionId: session.id,
        stepId: step.id,
        seq: step.seq,
        command: command.text,
        output: output.text,
        outputSource: body.outputSource,
        exitStatus: body.exitStatus,
      });
      const note = body.note ? maskText(body.note, 1_000).text : null;

      const saved = await sql.begin(async (tx) => {
        const rows = await tx<TerminalStepRow[]>`
          UPDATE terminal_steps
          SET executed_command = ${command.text},
              output = ${output.text},
              output_source = ${body.outputSource},
              exit_status = ${body.exitStatus},
              note = ${note},
              sha256 = ${sha256},
              rsp_command_log_id = ${body.rspCommandLogId ?? null},
              recorded_at = now()
          WHERE id = ${step.id} AND recorded_at IS NULL
          RETURNING *
        `;
        const updatedStep = rows[0];
        if (!updatedStep) {
          throw new ApiError(409, 'STEP_RECORDED', 'このステップはすでに記録されています。');
        }
        // RSP の remote_session との相関をセッション側にも保存する（Phase 2）。
        // 既に相関済みなら上書きしない（先に紐づいた ID を尊重する）。
        let updatedSession = session;
        if (body.rspSessionId) {
          const sessionRows = await tx<TerminalSessionRow[]>`
            UPDATE terminal_sessions
            SET rsp_session_id = COALESCE(rsp_session_id, ${body.rspSessionId}),
                updated_at = now()
            WHERE id = ${session.id}
            RETURNING *
          `;
          if (sessionRows[0]) updatedSession = sessionRows[0];
        }
        await appendAudit(tx, {
          actorId: await userIdForEmail(email),
          action: 'terminal.step.record',
          targetType: 'terminal_session',
          targetId: session.id,
          detail: {
            via: auditVia(request),
            actorEmail: email,
            caseId: session.case_id,
            stepId: step.id,
            seq: step.seq,
            exitStatus: body.exitStatus,
            outputSource: body.outputSource,
            // 相関IDのみ。コマンド・出力本文は監査に入れない（現行方針）。
            rspCommandLogId: body.rspCommandLogId ?? null,
            rspSessionId: body.rspSessionId ?? null,
            // SM-09: RSP の相関確認結果（一致した場合のみ端末名・担当者・状態を残す）。
            rspVerified: rspVerification.verified,
            ...(rspVerification.verified
              ? {
                  rspDevice: rspVerification.device ?? null,
                  rspOperator: rspVerification.operator ?? null,
                  rspStatus: rspVerification.status ?? null,
                }
              : {}),
            outputTruncated: output.truncated,
            commandFindings: command.findings,
            outputFindings: output.findings,
            sha256,
          },
        });
        return { step: updatedStep, session: updatedSession };
      });
      const steps = await loadSteps(session.id);
      return {
        ok: true,
        step: stepDto(saved.step),
        session: sessionWithSteps(saved.session, steps.length),
        warnings,
      };
    },
  );

  app.get(
    '/terminal/sessions/:id/capture',
    { preHandler: authenticateTerminal },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const { id } = SessionParamsSchema.parse(request.params);
      const found = await loadSession(id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      const handover = await loadHandoverForSession(found);
      await assertCanView(found, handover, request.uiEmail);
      const capability = captureCapability();
      return { ok: true, ...capability };
    },
  );

  app.post(
    '/terminal/sessions/:id/close',
    { preHandler: authenticateTerminal, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = SessionParamsSchema.parse(request.params);
      const body = CloseSchema.parse(request.body ?? {});
      const found = await loadSession(id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      const handover = await loadHandoverForSession(found);
      if (found.operator_email !== email) {
        if (handover?.owner_email !== email) assertOperator(found, email);
      }
      const session = await expireIfNeeded(found, email);
      if (session.status === 'closed') {
        const existingSteps = await loadSteps(session.id);
        return {
          ok: true,
          session: sessionWithSteps(session, existingSteps.length),
          warnings: closeWarnings(existingSteps),
        };
      }
      const closed = await sql.begin(async (tx) => {
        const rows = await tx<TerminalSessionRow[]>`
          UPDATE terminal_sessions
          SET status = 'closed', close_reason = ${body.reason},
              close_note = ${body.note ? maskText(body.note, 1_000).text : null},
              closed_at = now(), updated_at = now()
          WHERE id = ${session.id} AND status = 'active'
          RETURNING *
        `;
        if (!rows[0]) return undefined;
        await appendAudit(tx, {
          actorId: await userIdForEmail(email),
          action: 'terminal.session.close',
          targetType: 'terminal_session',
          targetId: session.id,
          detail: {
            via: auditVia(request),
            actorEmail: email,
            caseId: session.case_id,
            reason: body.reason,
          },
        });
        return rows[0];
      });
      const next = closed ?? session;
      const steps = await loadSteps(next.id);
      return {
        ok: true,
        session: sessionWithSteps(next, steps.length, await knowledgeSummaryOf(next)),
        warnings: closeWarnings(steps),
      };
    },
  );

  /**
   * 報告書を作成して保存する。
   * 画面が報告書 JSON を組み立てるのではなく、サーバが DB から作成する。
   */
  app.post(
    '/terminal/sessions/:id/report',
    { preHandler: authenticateTerminal, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = SessionParamsSchema.parse(request.params);
      const found = await loadSession(id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      assertOperator(found, email);
      const session = await expireIfNeeded(found, email);
      if (session.status !== 'closed') {
        throw new ApiError(
          409,
          'SESSION_ACTIVE',
          '報告書を作る前にセッションを終了してください（解決・中止のいずれか）。',
        );
      }
      const steps = await loadSteps(session.id);
      if (!steps.some((step) => step.recorded_at)) {
        throw new ApiError(
          409,
          'NO_RECORDED_STEPS',
          '実行記録がありません。少なくとも1ステップのコマンドと結果を記録してください。',
        );
      }
      const handover = await loadHandoverForSession(session);
      if (!handover) throw notFound('引継ぎが見つかりません。');

      const knowledgeRows = session.knowledge_id
        ? await sql<
            { id: string; kb_no: string; title: string; status: string; version: number }[]
          >`
            SELECT id, kb_no, title, status, version FROM knowledge WHERE id = ${session.knowledge_id}
          `
        : [];
      const knowledgeRow = knowledgeRows[0];
      const knowledge = knowledgeRow
        ? {
            id: knowledgeRow.id,
            kbNo: knowledgeRow.kb_no,
            title: knowledgeRow.title,
            status: knowledgeRow.status,
            version: knowledgeRow.version,
          }
        : null;

      const operator = await operatorName(email);
      const requester = await operatorName(handover.owner_email);
      let built: ReturnType<typeof buildTerminalReport>;
      try {
        built = buildTerminalReport({
          handover,
          session,
          steps,
          operatorName: operator,
          requesterName: requester,
          knowledge,
        });
      } catch (error) {
        request.log.error({ err: error }, 'terminal report build failed');
        throw new ApiError(
          500,
          'REPORT_BUILD_FAILED',
          '報告書データを組み立てられませんでした。記録内容を確認してください。',
        );
      }

      const recent = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM final_reports
        WHERE user_email = ${email} AND created_at > now() - interval '24 hours'
      `;
      if (Number(recent[0]?.count ?? '0') >= REPORT_DAILY_LIMIT) {
        throw new ApiError(
          429,
          'REPORT_QUOTA',
          '最終報告書の作成が24時間で上限（50件）に達しました。',
        );
      }
      if (!checkRateLimit(`terminal-report:${email}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '報告書の作成が多すぎます。少し待ってください。');
      }

      const masked = maskFinalReport(built.report);
      const reportId = randomUUID();
      const sha256 = createHash('sha256').update(JSON.stringify(masked)).digest('hex');
      const rendered = renderFinalReportHtml(masked, { id: reportId, sha256 });

      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO final_reports (id, user_email, case_id, kind, payload, html, html_filename, sha256)
          VALUES (
            ${reportId}, ${email}, ${masked.case.id}, ${masked.kind},
            ${jsonbValue(masked)}, ${rendered.html}, ${rendered.filename}, ${sha256}
          )
        `;
        await tx`
          UPDATE terminal_sessions
          SET report_id = ${reportId}, report_sha256 = ${sha256}, updated_at = now()
          WHERE id = ${session.id}
        `;
        await appendAudit(tx, {
          actorId: await userIdForEmail(email),
          action: 'terminal.report.build',
          targetType: 'terminal_session',
          targetId: session.id,
          detail: {
            via: auditVia(request),
            actorEmail: email,
            caseId: session.case_id,
            reportId,
            sha256,
            steps: steps.length,
            unrecorded: built.warnings.length,
          },
        });
      });

      const base = `/api/reports/final/${reportId}`;
      return {
        ok: true,
        warnings: built.warnings,
        report: {
          id: reportId,
          sha256,
          kind: masked.kind,
          caseId: masked.case.id,
          createdAt: new Date().toISOString(),
          files: {
            // inline=1 はブラウザ内表示（タブで開く）。url はダウンロード用。
            html: {
              url: `${base}/html`,
              previewUrl: `${base}/html?inline=1`,
              filename: rendered.filename,
            },
            pdf: { url: `${base}/pdf`, filename: reportPdfFilename(rendered.filename) },
          },
        },
      };
    },
  );

  /** ナレッジ下書き（status='draft'）を作る。公開は既存の承認フローで行う。 */
  app.post(
    '/terminal/sessions/:id/knowledge-draft',
    { preHandler: authenticateTerminal, bodyLimit: 16 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = SessionParamsSchema.parse(request.params);
      const body = KnowledgeDraftSchema.parse(request.body ?? {});
      const found = await loadSession(id);
      if (!found) throw notFound('RSP実行セッションが見つかりません。');
      assertOperator(found, email);
      const session = await expireIfNeeded(found, email);
      if (session.status !== 'closed') {
        throw new ApiError(
          409,
          'SESSION_ACTIVE',
          'ナレッジ下書きを作る前にセッションを終了してください。',
        );
      }
      if (session.knowledge_id) {
        const rows = await sql<
          { id: string; kb_no: string; title: string; status: string; version: number }[]
        >`SELECT id, kb_no, title, status, version FROM knowledge WHERE id = ${session.knowledge_id}`;
        if (rows[0]) {
          return {
            ok: true,
            knowledge: {
              id: rows[0].id,
              kbNo: rows[0].kb_no,
              title: rows[0].title,
              status: rows[0].status,
              version: rows[0].version,
            },
          };
        }
      }
      const steps = await loadSteps(session.id);
      if (!steps.some((step) => step.recorded_at)) {
        throw new ApiError(
          409,
          'NO_RECORDED_STEPS',
          '実行記録がありません。少なくとも1ステップのコマンドと結果を記録してください。',
        );
      }
      const handover = await loadHandoverForSession(session);
      if (!handover) throw notFound('引継ぎが見つかりません。');
      const authorId = await ensureAuthorUser(email, await operatorName(email));
      if (!authorId) {
        throw new ApiError(
          500,
          'USER_PROVISION_FAILED',
          'ナレッジの作成者を登録できませんでした。',
        );
      }
      const content = buildKnowledgeDraft({
        handover,
        session,
        steps,
        title: body.title,
        cause: body.cause,
      });

      const inserted = await sql.begin(async (tx) => {
        const kbNo = await nextKbNo(tx);
        // プロトタイプの案件 ID は uuid ではないため、cases への外部キーは張らない。
        // 画面に下書きを編集する導線はなく、作成の時点で「承認待ち」と表示している。承認者の一覧
        // （/knowledge/pending は client_ref のある行だけ）に出るよう、申請済みとして保存する。
        const rows = await tx<
          { id: string; kb_no: string; title: string; status: string; version: number }[]
        >`
          INSERT INTO knowledge (
            kb_no, case_id, client_ref, title, symptom, cause, steps, keywords, status, author_id,
            version
          ) VALUES (
            ${kbNo}, NULL, ${`terminal-${session.id}`}, ${content.title}, ${content.symptom},
            ${content.cause}, ${content.steps}, ${content.keywords}, 'pending', ${authorId}, 1
          )
          RETURNING id, kb_no, title, status, version
        `;
        const row = rows[0];
        if (!row)
          throw new ApiError(500, 'KB_CREATE_FAILED', 'ナレッジ下書きを作成できませんでした。');
        await tx`
          UPDATE terminal_sessions
          SET knowledge_id = ${row.id}, updated_at = now()
          WHERE id = ${session.id}
        `;
        await appendAudit(tx, {
          actorId: authorId,
          action: 'terminal.knowledge.draft',
          targetType: 'terminal_session',
          targetId: session.id,
          detail: {
            via: auditVia(request),
            actorEmail: email,
            caseId: session.case_id,
            knowledgeId: row.id,
            kbNo: row.kb_no,
            status: row.status,
          },
        });
        return row;
      });

      return {
        ok: true,
        knowledge: {
          id: inserted.id,
          kbNo: inserted.kb_no,
          title: inserted.title,
          status: inserted.status,
          version: inserted.version,
        },
      };
    },
  );
}
