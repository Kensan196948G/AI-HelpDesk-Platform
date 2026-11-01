import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerWithDeepSeek } from '../ai/deepseek.js';
import {
  type HelpdeskActor,
  isInternalIdentity,
  recipientDecision,
  requireApproverActor,
  requireHelpdeskActor,
} from '../auth/helpdesk-scope.js';
import { sameHuman } from '../auth/shared-identity.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { redactKnowledgeText } from '../domain/pii.js';
import { ApiError, badRequest } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import {
  buildCaseContext,
  buildPcContext,
  type CaseSnapshot,
  extractCaseSnapshot,
  mergeCaseSnapshot,
  normalizeState,
  redactCaseSnapshot,
} from '../lib/case-handover.js';
import {
  enqueueHandoverNotifications,
  flushHandoverNotifications,
  resolveConfiguredRecipients,
} from '../lib/handover-notify.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { getMailTransport } from '../lib/mailer.js';
import { type EmployeeRow, findEmployeeEmailByNo, listEmployees } from '../lib/mirai-info.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const CaseIdSchema = z.string().trim().min(1).max(40);
const ShareBodySchema = z.object({
  caseId: CaseIdSchema,
  // 案件の件名（クライアントが表示している値）。状態保存が追いつく前でも通知件名を確定させる。
  subject: z.string().trim().max(200).optional(),
  // 宛先（DX 推進部グループの社員番号）。省略時はグループ全員宛。
  recipientNo: z.string().trim().min(1).max(20).optional(),
  assigneeHint: z.string().trim().max(120).optional(),
});
const ApproveBodySchema = z.object({ note: z.string().max(1000).optional() });
const ClaimParamsSchema = z.object({ id: z.string().uuid() });
const PatchBodySchema = z.object({
  status: z.enum(['resolved', 'completed', 'cancelled']),
  note: z.string().max(1000).optional(),
});
const AnswerBodySchema = z.object({
  caseId: CaseIdSchema,
  text: z.string().trim().min(1).max(2000),
});

export interface HandoverRow {
  id: string;
  case_id: string;
  owner_email: string;
  assignee_hint: string | null;
  recipient_no: string | null;
  recipient_name: string | null;
  status: string;
  snapshot: unknown;
  claimed_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  self_approved: boolean;
  created_at: Date;
}

/** 社員の表示名（部署 / 氏名）。本部段は省略する。 */
function employeeLabel(employee: EmployeeRow): string {
  return [employee.division, employee.section, employee.name].filter(Boolean).join(' / ');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 引継ぎの受信・claim・閲覧・対応・承認は「ヘルプデスク相当」だけが行う（F-01）。
 * 判定の実装は `auth/helpdesk-scope.ts`。名簿で解決できない場合は fail-closed。
 * 既存の呼び出し元（terminal.ts）との互換のため関数名は残す。
 */
export async function requireHelpdesk(email: string): Promise<void> {
  await requireHelpdeskActor(email);
}

/**
 * 引継ぎ操作のサーバ側監査（F-02）。
 * - `audit_log` のハッシュチェーンに、実行者メール・対象・時刻を 1 操作 1 行で記録する。
 * - `audit_log.actor_id` は `users` への FK のため、UI 認証の利用者（users に行が無い）は
 *   NULL とし、実行者メールは detail.actorEmail に残す（偽の user id を作らない）。
 * - 呼び出し側は必ず `sql.begin(...)` の中から呼ぶ（appendAudit の前提）。
 */
async function recordHandoverAudit(
  tx: any,
  input: {
    actorEmail: string;
    action:
      | 'case_handover.create'
      | 'case_handover.claim'
      | 'case_handover.resolve'
      | 'case_handover.status'
      | 'case_handover.approve';
    handoverId: string;
    caseId: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await appendAudit(tx, {
    actorId: null,
    action: input.action,
    targetType: 'case_handover',
    targetId: input.handoverId,
    detail: {
      actorEmail: input.actorEmail,
      caseId: input.caseId,
      ...(input.detail ?? {}),
    },
  });
}

/**
 * 宛先指名の照合。指名なし（グループ）は DX 推進部メンバー全員が引き受けられる。
 * 指名ありは指名された本人だけ。本人確認ができない場合は fail-closed。
 */
function assertClaimRecipient(
  recipientNo: string | null,
  actor: HelpdeskActor,
  handoverId: string,
): void {
  const decision = recipientDecision(recipientNo, actor);
  if (decision === 'open' || decision === 'match') return;
  if (decision === 'unknown') {
    throw new ApiError(
      403,
      'RECIPIENT_UNVERIFIED',
      '宛先が指名された引継ぎを引き受けるには、社員名簿で本人の社員番号を確認できる必要があります。',
    );
  }
  throw new ApiError(
    403,
    'RECIPIENT_MISMATCH',
    'この引継ぎは別の担当者に指名されています。指名された本人だけが引き受けられます。',
    { handoverId },
  );
}

/**
 * 通知先の解決。社員番号からメールアドレスを引く（サーバー内のみ）。
 * 名簿に無い・重複する場合は送らない。
 */
async function resolveRecipientForNotify(
  employeeNo: string,
): Promise<{ email: string; name: string }[]> {
  const found = await findEmployeeEmailByNo(employeeNo);
  return found ? [found] : [];
}

async function loadStates(email: string): Promise<{
  cowork: Record<string, unknown> | null;
  helpdesk: Record<string, unknown> | null;
}> {
  const rows = await sql<{ name: string; data: unknown }[]>`
    SELECT name, data FROM prototype_states WHERE user_email = ${email}
  `;
  const byName = new Map(rows.map((row) => [row.name, normalizeState(row.data)]));
  return {
    cowork: byName.get('cowork') ?? null,
    helpdesk: byName.get('helpdesk') ?? null,
  };
}

function snapshotSummary(row: HandoverRow, email: string): Record<string, unknown> {
  const snapshot = normalizeState(row.snapshot) as CaseSnapshot | null;
  const targetCase = snapshot?.case ?? {};
  const ticket = snapshot?.ticket ?? {};
  const inc = snapshot?.inc ?? {};
  return {
    id: row.id,
    caseId: row.case_id,
    status: row.status,
    assigneeHint: row.assignee_hint,
    recipientNo: row.recipient_no,
    recipientName: row.recipient_name,
    subject: String(targetCase.subject ?? targetCase.body ?? '(件名なし)').slice(0, 200),
    requester: String(inc.requester ?? ticket.requester ?? targetCase.userId ?? '').slice(0, 120),
    claimedByMe: row.claimed_by === email,
    claimedByName: row.claimed_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    selfApproved: row.self_approved,
    // 別アカウントだが同一人物か（監査・画面の誤読防止）。
    sharedIdentity: row.approved_by ? sameHuman(row.approved_by, row.claimed_by) : false,
    createdAt: row.created_at.toISOString(),
  };
}

export async function latestHandoverForCase(caseId: string): Promise<HandoverRow | undefined> {
  const rows = await sql<HandoverRow[]>`
    SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
    FROM case_handovers
    WHERE (
        case_id = ${caseId}
        -- 画面の案件ID（cowork）だけでなく、ヘルプデスクのチケット/INC番号でも引ける。
        OR snapshot #>> '{inc,id}' = ${caseId}
        OR snapshot #>> '{ticket,id}' = ${caseId}
      )
      -- SM-04: 完了（completed）も参照できるようにする。完了案件の実行セッション・文脈を
      -- 読む経路（GET /terminal/sessions・/terminal/context）が 404 になっていたため。
      -- セッションの新規開始は呼び出し側（POST /terminal/sessions）が claimed/resolved を
      -- 要求し、completed は 409 HANDOVER_NOT_ACTIVE で拒否する。
      AND status IN ('pending', 'claimed', 'resolved', 'completed')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0];
}

function appendChat(
  snapshot: CaseSnapshot,
  message: { role: 'user' | 'ai'; text: string; who?: string; provider?: string },
): void {
  if (!snapshot.chat) return;
  const messages = Array.isArray(snapshot.chat.messages) ? snapshot.chat.messages : [];
  messages.push({
    id: `case-ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: message.role === 'user' ? 'user' : 'ai',
    ...(message.role === 'user'
      ? { text: message.text }
      : {
          html: `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>`,
          model: 'DeepSeek-V4.1-Flash',
          // 画面は provider で実 AI とフォールバックを見分ける。
          provider: message.provider,
        }),
    who: message.who,
    at: new Date().toISOString(),
  });
  snapshot.chat.messages = messages;
}

/**
 * 案件の引継ぎ（DX 推進部グループ宛）。
 * - A さんが引継ぎ時に `POST /case-handovers` でスナップショットを作る。
 * - B さんのブラウザは `GET /case-handovers/inbox` で受信箱を見て、
 *   `POST /case-handovers/:id/claim` で自分の状態へマージする。
 * - B さんは `POST /ai/answer-case` で共有案件の PC 情報を根拠に AI へ追加質問できる。
 */
export async function caseHandoverRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/case-handovers',
    { preHandler: authenticateUi, bodyLimit: 256 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      if (!checkRateLimit(`case-handover:${email}`, 20, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '引継ぎの作成が多すぎます。少し待ってください。');
      }
      const body = ShareBodySchema.parse(request.body);
      const states = await loadStates(email);
      const snapshot = extractCaseSnapshot(states.cowork, states.helpdesk, body.caseId, {
        subject: body.subject,
      });
      if (!snapshot) {
        throw new ApiError(404, 'NOT_FOUND', '対象の案件が見つかりません。');
      }

      // 宛先は DX 推進部グループからの選択式。指名なしはグループ全員宛。
      // 名簿が取れないときに自由入力で指名させない（なりすまし・誤配信を防ぐ）。
      let recipient: EmployeeRow | null = null;
      if (body.recipientNo) {
        const roster = await listEmployees('staff');
        if (roster.employees.length === 0) {
          throw new ApiError(
            409,
            'DIRECTORY_UNAVAILABLE',
            'DX 推進部の名簿を取得できないため、個人を指名できません（グループ全員宛にしてください）。',
          );
        }
        recipient = roster.employees.find((item) => item.employeeNo === body.recipientNo) ?? null;
        if (!recipient) {
          throw new ApiError(
            400,
            'INVALID_RECIPIENT',
            '宛先は DX 推進部のメンバーから選択してください。',
          );
        }
      }
      const assigneeHint = recipient ? employeeLabel(recipient) : (body.assigneeHint ?? null);

      // 進行中の同じ案件の共有は置き換える（部分一意 index と衝突させない）。
      // 作成と監査は同じトランザクションで行い、監査は成功時だけ1行残す（F-02）。
      const handoverId = await sql.begin(async (tx) => {
        await tx`
          UPDATE case_handovers
          SET status = 'cancelled', updated_at = now()
          WHERE case_id = ${body.caseId}
            AND owner_email = ${email}
            AND status IN ('pending', 'claimed')
        `;
        const rows = await tx<{ id: string }[]>`
          INSERT INTO case_handovers (
            case_id, owner_email, assignee_hint, recipient_no, recipient_name, snapshot
          )
          VALUES (
            ${body.caseId},
            ${email},
            ${assigneeHint},
            ${recipient?.employeeNo ?? null},
            ${recipient?.name ?? null},
            ${jsonbValue(snapshot)}
          )
          RETURNING id
        `;
        const id = rows[0]?.id;
        if (!id) throw new Error('引継ぎの作成に失敗しました。');
        await recordHandoverAudit(tx, {
          actorEmail: email,
          action: 'case_handover.create',
          handoverId: id,
          caseId: body.caseId,
          detail: {
            recipient_no: recipient?.employeeNo ?? null,
            recipientName: recipient?.name ?? null,
            assigneeHint,
          },
        });
        return id;
      });

      // 通知は best-effort。メールが失敗しても引継ぎは成功させる。
      let queued = 0;
      const transport = getMailTransport();
      if (handoverId && transport.name !== 'disabled') {
        try {
          const recipients = recipient
            ? await resolveRecipientForNotify(recipient.employeeNo)
            : resolveConfiguredRecipients();
          if (recipients.length > 0) {
            queued = await enqueueHandoverNotifications(
              {
                handoverId,
                caseId: body.caseId,
                subject: String(snapshot.case.subject ?? snapshot.case.body ?? ''),
                requester: String(
                  snapshot.inc?.requester ??
                    snapshot.ticket?.requester ??
                    snapshot.case.userId ??
                    '',
                ),
                recipientName: recipient?.name ?? null,
              },
              recipients,
            );
            if (queued > 0) {
              // 応答を待たせない（失敗はワーカーが再試行する）。
              void flushHandoverNotifications({ transport }).catch((error: unknown) => {
                request.log.warn({ err: error }, '引継ぎ通知の初回送信に失敗しました。');
              });
            }
          }
        } catch (error) {
          request.log.warn({ err: error }, '引継ぎ通知の登録に失敗しました。');
        }
      }

      return {
        ok: true,
        handover: {
          id: handoverId,
          caseId: body.caseId,
          status: 'pending',
          recipientNo: recipient?.employeeNo ?? null,
          recipientName: recipient?.name ?? null,
        },
        notify: { queued, transport: transport.name },
      };
    },
  );

  /**
   * 宛先の選択肢（DX 推進部グループのメンバー）。
   * 個人情報は氏名・組織・社員番号に限定する（メールは返さない）。
   */
  app.get('/case-handovers/recipients', { preHandler: authenticateUi }, async (request) => {
    // 社外の承認者には社員情報を返さない。
    if (!(await isInternalIdentity(request.uiEmail))) {
      return { ok: true, group: 'DX推進部', members: [] };
    }
    const roster = await listEmployees('staff');
    return {
      ok: true,
      group: 'DX推進部',
      members: roster.employees.map((employee) => ({
        employeeNo: employee.employeeNo,
        name: employee.name,
        organization: employee.organization ?? null,
        division: employee.division ?? null,
        section: employee.section ?? null,
        label: employeeLabel(employee),
      })),
      ...(roster.error ? { directoryError: roster.error } : {}),
    };
  });

  app.get('/case-handovers/inbox', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    // 受信箱はヘルプデスク相当だけが開ける（一般社員は 403）。
    const actor = await requireHelpdeskActor(request.uiEmail);
    // 単一 Access ID 運用では依頼者と担当者が同じ人になるため、自分の案件も受信箱に返す
    // （SM-01）。宛先指名の絞り込みだけは維持する。
    const rows = await sql<HandoverRow[]>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
      FROM case_handovers
      WHERE status IN ('pending', 'claimed')
        -- 宛先が指名された引継ぎは、指名された本人の受信箱にだけ出す（F-01 / D-01）。
        AND (recipient_no IS NULL OR recipient_no = ${actor.employeeNo ?? ''})
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return { ok: true, items: rows.map((row) => snapshotSummary(row, request.uiEmail ?? '')) };
  });

  /**
   * 完了の承認を待つ引継ぎ（docs/14 §2-19）。承認者は担当者の受信箱を開けないので別に返す。
   * 承認に必要な最小限だけ返し、相談者の情報、端末情報、会話は返さない。
   * これは案件を閉じる承認の一覧で、KB の公開承認（/knowledge/pending）とは別物である。
   */
  app.get('/case-handovers/awaiting-approval', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    await requireApproverActor(email, request.uiRoles);
    const rows = await sql<HandoverRow[]>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
      FROM case_handovers
      WHERE status IN ('claimed', 'resolved')
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return {
      ok: true,
      allowSelfApproval: config.ALLOW_SELF_APPROVAL,
      items: rows.map((row) => {
        const summary = snapshotSummary(row, email);
        return {
          id: summary.id,
          caseId: summary.caseId,
          status: summary.status,
          subject: redactKnowledgeText(String(summary.subject)).text,
          claimedByMe: summary.claimedByMe,
          claimedByName: summary.claimedByName,
          createdAt: summary.createdAt,
        };
      }),
    };
  });

  app.post('/case-handovers/:id/claim', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    const actor = await requireHelpdeskActor(email);
    const { id } = ClaimParamsSchema.parse(request.params);
    const rows = await sql<HandoverRow[]>`
        SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
        FROM case_handovers
        WHERE id = ${id}
        LIMIT 1
      `;
    const row = rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', '引継ぎが見つかりません。');
    if (!['pending', 'claimed'].includes(row.status)) {
      throw new ApiError(409, 'ALREADY_HANDLED', 'この引継ぎはすでに処理されています。');
    }
    if (row.claimed_by && row.claimed_by !== email) {
      throw new ApiError(409, 'ALREADY_CLAIMED', '別の担当者が引き受けています。');
    }
    // 宛先が指名されている場合は、指名された本人だけが引き受けられる（F-01）。
    assertClaimRecipient(row.recipient_no, actor, row.id);
    // 同じ人がすでに引き受けている場合は冪等に成功させる（再送で監査行を増やさない）。
    if (row.status === 'claimed' && row.claimed_by === email) {
      return {
        ok: true,
        handover: { id: row.id, caseId: row.case_id, status: 'claimed' },
        caseId: row.case_id,
      };
    }
    const snapshot = normalizeState(row.snapshot) as CaseSnapshot | null;
    if (!snapshot) throw new ApiError(409, 'INVALID_SNAPSHOT', '引継ぎデータが不正です。');

    const states = await loadStates(email);
    if (!states.cowork || !states.helpdesk) {
      throw new ApiError(
        409,
        'STATE_NOT_READY',
        '画面の状態がまだ保存されていません。少し待って再読み込みしてください。',
      );
    }
    const merged = mergeCaseSnapshot(states.cowork, states.helpdesk, snapshot, {
      id: row.id,
      claimedBy: email,
    });

    await sql.begin(async (tx) => {
      for (const name of ['cowork', 'helpdesk'] as const) {
        const data = name === 'cowork' ? merged.cowork : merged.helpdesk;
        await tx`
            INSERT INTO prototype_states (user_email, name, data)
            VALUES (${email}, ${name}, ${jsonbValue(data)})
            ON CONFLICT (user_email, name)
            DO UPDATE SET data = EXCLUDED.data, updated_at = now()
          `;
      }
      await tx`
          UPDATE case_handovers
          SET status = 'claimed',
              claimed_by = ${email},
              claimed_at = now(),
              updated_at = now()
          WHERE id = ${row.id}
        `;
      // F-02: サーバ監査に「誰が・何を・いつ」を 1 行だけ記録する。
      await recordHandoverAudit(tx, {
        actorEmail: email,
        action: 'case_handover.claim',
        handoverId: row.id,
        caseId: row.case_id,
        detail: { status: 'claimed', recipientNo: row.recipient_no },
      });
    });

    return {
      ok: true,
      handover: { id: row.id, caseId: row.case_id, status: 'claimed' },
      caseId: row.case_id,
    };
  });

  app.get('/case-handovers/:id', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const { id } = ClaimParamsSchema.parse(request.params);
    const rows = await sql<HandoverRow[]>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
      FROM case_handovers
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', '引継ぎが見つかりません。');
    // 依頼者本人は自分の案件の詳細だけ参照できる。それ以外はヘルプデスク相当のみ。
    if (row.owner_email !== request.uiEmail) await requireHelpdeskActor(request.uiEmail);
    return { ok: true, handover: snapshotSummary(row, request.uiEmail ?? '') };
  });

  app.patch('/case-handovers/:id', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    // 対応状況の更新（解決記録など）はヘルプデスク相当のみ（F-01）。
    await requireHelpdeskActor(email);
    const { id } = ClaimParamsSchema.parse(request.params);
    const body = PatchBodySchema.parse(request.body);
    const rows = await sql<HandoverRow[]>`
      SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
             status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
      FROM case_handovers
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', '引継ぎが見つかりません。');
    // 「完了」はナレッジ承認を通したときだけ。承認なしの完了で承認を迂回させない。
    if (body.status === 'completed' && !row.approved_by) {
      throw new ApiError(
        409,
        'APPROVAL_REQUIRED',
        '完了にする前に、DX 推進部の担当者がナレッジを承認してください。',
      );
    }
    await sql.begin(async (tx) => {
      await tx`
        UPDATE case_handovers
        SET status = ${body.status},
            updated_at = now()
        WHERE id = ${row.id}
      `;
      // F-02: 解決記録もサーバ監査に 1 行だけ記録する。
      await recordHandoverAudit(tx, {
        actorEmail: email,
        action: body.status === 'resolved' ? 'case_handover.resolve' : 'case_handover.status',
        handoverId: row.id,
        caseId: row.case_id,
        detail: {
          status: body.status,
          ...(body.note ? { note: body.note } : {}),
        },
      });
    });
    return { ok: true, handover: { id: row.id, caseId: row.case_id, status: body.status } };
  });

  /**
   * ナレッジの承認（承認者は approver ロールの保持者）。
   * - 承認できるのは approver ロールの保持者だけ（所属は問わない・fail-closed）。
   * - 却下ではなく「承認」だけをこのエンドポイントで扱う。差戻しはブラウザ側の操作。
   * - 対応した本人が承認した場合は self_approved=true で記録する（黙って通さない）。
   */
  app.post(
    '/case-handovers/:id/approve',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const actor = await requireApproverActor(email, request.uiRoles);
      const { id } = ClaimParamsSchema.parse(request.params);
      const body = ApproveBodySchema.parse(request.body ?? {});

      const rows = await sql<HandoverRow[]>`
        SELECT id, case_id, owner_email, assignee_hint, recipient_no, recipient_name,
               status, snapshot, claimed_by, approved_by, approved_at, self_approved, created_at
        FROM case_handovers
        WHERE id = ${id}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', '引継ぎが見つかりません。');
      if (row.status === 'cancelled') {
        throw new ApiError(409, 'ALREADY_HANDLED', 'この引継ぎは取り消されています。');
      }
      if (!['claimed', 'resolved'].includes(row.status)) {
        throw new ApiError(
          409,
          'NOT_CLAIMED',
          '引き受けていない案件は承認できません。先に受信箱から引き受けてください。',
        );
      }

      const approverName = actor.name ?? email;
      const selfApproved = row.claimed_by === email;
      // 別アカウントだが同一人物による承認か（selfApproved=false の誤読を防ぐ）。
      const sharedIdentity = sameHuman(email, row.claimed_by);

      // 職務分離を強制する設定（SM-02）。単一 Access ID 運用の間は既定 true。
      if (selfApproved && !config.ALLOW_SELF_APPROVAL) {
        throw new ApiError(
          403,
          'SELF_APPROVAL_FORBIDDEN',
          '自分が引き受けた案件は承認できません（職務分離）。別の本番承認者に承認を依頼してください。',
        );
      }

      await sql.begin(async (tx) => {
        await tx`
          UPDATE case_handovers
          SET status = 'completed',
              approved_by = ${email},
              approved_at = now(),
              self_approved = ${selfApproved},
              updated_at = now()
          WHERE id = ${row.id}
        `;
        // F-02: 承認もサーバ監査に 1 行だけ記録する。
        await recordHandoverAudit(tx, {
          actorEmail: email,
          action: 'case_handover.approve',
          handoverId: row.id,
          caseId: row.case_id,
          detail: {
            status: 'completed',
            selfApproved,
            sharedIdentity,
            ...(body.note ? { note: body.note } : {}),
          },
        });
      });

      return {
        ok: true,
        handover: {
          id: row.id,
          caseId: row.case_id,
          status: 'completed',
          approvedBy: email,
          approvedByName: approverName,
          approvedAt: new Date().toISOString(),
          selfApproved,
          sharedIdentity,
          ...(body.note ? { note: body.note } : {}),
        },
      };
    },
  );

  app.post(
    '/ai/answer-case',
    { preHandler: authenticateUi, bodyLimit: 32 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      await requireHelpdesk(request.uiEmail);
      if (!checkRateLimit(`answer-case:${request.uiEmail}`, 20, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'AI への質問が多すぎます。少し待ってください。');
      }
      const body = AnswerBodySchema.parse(request.body);
      const row = await latestHandoverForCase(body.caseId);
      if (!row) {
        throw new ApiError(404, 'NOT_FOUND', 'この案件の引継ぎが見つかりません。');
      }
      if (
        row.owner_email !== request.uiEmail &&
        row.claimed_by !== request.uiEmail &&
        config.AUTH_MODE !== 'local'
      ) {
        await requireHelpdesk(request.uiEmail);
      }
      const snapshot = normalizeState(row.snapshot) as CaseSnapshot | null;
      if (!snapshot) throw new ApiError(409, 'INVALID_SNAPSHOT', '引継ぎデータが不正です。');

      const answer = await answerWithDeepSeek(body.text, request.uiEmail, undefined, {
        deviceContext: buildPcContext(snapshot),
        extraContext: buildCaseContext(snapshot),
      });

      appendChat(snapshot, { role: 'user', text: body.text, who: 'DX推進部' });
      appendChat(snapshot, { role: 'ai', text: answer.answer, provider: answer.provider });
      // F-04: サーバ側で保存する直前に、スナップショット全体の PII を伏せ字にする。
      // （クライアント側の置換に依存しない。AI 追加質問の履歴も含めて保存する。）
      const redactedSnapshot = redactCaseSnapshot(snapshot);
      await sql`
        UPDATE case_handovers
        SET snapshot = ${jsonbValue(redactedSnapshot)},
            updated_at = now()
        WHERE id = ${row.id}
      `;

      return {
        ok: true,
        answer: answer.answer,
        sources: answer.sources,
        provider: answer.provider,
        model: answer.model,
        confidence: answer.confidence,
        prompt: answer.prompt,
      };
    },
  );
}
