import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerWithDeepSeek } from '../ai/deepseek.js';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';

/**
 * 運用統合 UI（/ops）の受付チケット（docs/100 P2）。
 *
 * - 受付と AI 一次対応の記録を **実 DB（ops_tickets）** に残す。
 * - 権限は「本人は自分のチケットだけ」「ヘルプデスク相当は全件」。
 * - 引継ぎ（case_handovers）との接続は P3。
 */
const OPS_STATUS = ['ai', 'escalated', 'in_progress', 'resolved', 'closed'] as const;

const CreateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  category: z.string().trim().min(1).max(40).default('other'),
  urgency: z.string().trim().max(20).default('中'),
  impact: z.string().trim().max(20).optional(),
  channel: z.string().trim().max(40).optional(),
  requester: z.string().trim().max(120).optional(),
  priority: z.string().trim().max(8).optional(),
  // 受付時にブラウザから取得した PC 基本情報（同意済みの範囲だけ）。
  pc: z.record(z.string(), z.unknown()).optional(),
});

const AskSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

const PatchSchema = z.object({
  status: z.enum(OPS_STATUS),
  note: z.string().trim().max(500).optional(),
});

const ClaimSchema = z.object({
  assignee: z.string().trim().max(120).optional(),
});

const ResolveSchema = z.object({
  cause: z.string().trim().min(1).max(4000),
  steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  minutes: z.number().int().min(0).max(100000).optional(),
  note: z.string().trim().max(2000).optional(),
});

interface OpsTicketRow {
  id: string;
  tkt_no: string;
  requester_email: string;
  requester_name: string | null;
  requester_label: string | null;
  channel: string | null;
  category: string;
  subject: string;
  body: string;
  urgency: string;
  impact: string | null;
  priority: string | null;
  signal: string | null;
  status: string;
  ai_answer: string | null;
  ai_sources: unknown;
  ai_provider: string | null;
  ai_model: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  cause: string | null;
  steps: unknown;
  resolution_minutes: number | null;
  resolution_note: string | null;
  escalated_at: Date | string | null;
  started_at: Date | string | null;
  pc_info: unknown;
}

interface OpsMessageRow {
  ticket_id: string;
  role: string;
  text: string;
  provider: string | null;
  created_at: Date | string;
}

/** 会話ログを 1 行足す（受付・AI回答・引継ぎ・解決）。 */
async function appendMessage(
  tx: any,
  ticketId: string,
  role: 'sys' | 'user' | 'ai',
  text: string,
  extra: { provider?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await tx`
    INSERT INTO ops_ticket_messages (ticket_id, role, text, provider, meta)
    VALUES (
      ${ticketId}, ${role}, ${text}, ${extra.provider ?? null},
      ${jsonbValue(extra.meta ?? {})}
    )
  `;
}

/** チケット群の会話ログをまとめて取り、チケット ID で束ねる。 */
async function loadMessages(ticketIds: string[]): Promise<Map<string, OpsMessageRow[]>> {
  const map = new Map<string, OpsMessageRow[]>();
  if (!ticketIds.length) return map;
  const rows = await sql<OpsMessageRow[]>`
    SELECT ticket_id, role, text, provider, created_at
    FROM ops_ticket_messages
    WHERE ticket_id IN ${sql(ticketIds)}
    ORDER BY created_at ASC
  `;
  for (const row of rows) {
    const list = map.get(row.ticket_id) ?? [];
    list.push(row);
    map.set(row.ticket_id, list);
  }
  return map;
}

function ms(value: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** 画面（既存のチケット描画）が期待する形へ写す。足りない配列は空で埋める。 */
export function toUiTicket(
  row: OpsTicketRow,
  messages: OpsMessageRow[] = [],
): Record<string, unknown> {
  const aiLog = messages.length
    ? messages.map((message) => ({
        role: message.role,
        text: message.text,
        t: ms(message.created_at) ?? Date.now(),
        ...(message.provider ? { provider: message.provider } : {}),
      }))
    : row.ai_answer
      ? [
          {
            role: 'ai',
            text: row.ai_answer,
            t: ms(row.updated_at) ?? Date.now(),
            provider: row.ai_provider ?? undefined,
          },
        ]
      : [];
  return {
    id: row.tkt_no,
    serverId: row.id,
    createdAt: ms(row.created_at) ?? Date.now(),
    channel: row.channel ?? 'AI窓口',
    requester: row.requester_label || row.requester_name || row.requester_email,
    cat: row.category,
    urgency: row.urgency,
    impact: row.impact ?? '個人',
    priority: row.priority ?? 'P4',
    subject: row.subject,
    body: row.body,
    status: row.status,
    sec: row.signal === 'red' ? 'high' : null,
    aiLog,
    shown: [],
    candidates: [],
    extra: [],
    failedKb: [],
    history: [],
    aiProvider: row.ai_provider ?? null,
    aiModel: row.ai_model ?? null,
    pc: row.pc_info ?? null,
    assignee: row.assignee_name ?? null,
    escalatedAt: ms(row.escalated_at) ?? null,
    startedAt: ms(row.started_at) ?? null,
    resolution: row.cause
      ? {
          cause: row.cause,
          steps: Array.isArray(row.steps) ? row.steps : [],
          minutes: row.resolution_minutes ?? 0,
          note: row.resolution_note ?? '',
        }
      : null,
  };
}

async function listRows(email: string, all: boolean): Promise<OpsTicketRow[]> {
  return all
    ? sql<OpsTicketRow[]>`
        SELECT * FROM ops_tickets ORDER BY created_at DESC LIMIT 100
      `
    : sql<OpsTicketRow[]>`
        SELECT * FROM ops_tickets WHERE requester_email = ${email}
        ORDER BY created_at DESC LIMIT 100
      `;
}

async function loadRow(id: string): Promise<OpsTicketRow> {
  const rows = await sql<OpsTicketRow[]>`SELECT * FROM ops_tickets WHERE id = ${id} LIMIT 1`;
  const row = rows[0];
  if (!row) throw notFound('チケットが見つかりません。');
  return row;
}

/** `/ops` の初期表示用（本人 or 担当者の範囲で返す）。 */
export async function loadTicketsForUi(email: string): Promise<Record<string, unknown>[]> {
  let all = false;
  try {
    await requireHelpdeskActor(email);
    all = true;
  } catch {
    all = false;
  }
  const rows = await listRows(email, all);
  const messages = await loadMessages(rows.map((row) => row.id));
  return rows.map((row) => toUiTicket(row, messages.get(row.id) ?? []));
}

export async function opsTicketRoutes(app: FastifyInstance): Promise<void> {
  /** 画面の初期表示（受付済みチケット）。 */
  app.get('/ops/tickets', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    let all = false;
    try {
      await requireHelpdeskActor(email);
      all = true;
    } catch {
      all = false;
    }
    const rows = await listRows(email, all);
    const messages = await loadMessages(rows.map((row) => row.id));
    return {
      ok: true,
      scope: all ? 'all' : 'mine',
      tickets: rows.map((row) => toUiTicket(row, messages.get(row.id) ?? [])),
    };
  });

  /** 受付（1 件作成）。監査に 1 行残す。 */
  app.post(
    '/ops/tickets',
    { preHandler: authenticateUi, bodyLimit: 64 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const input = CreateSchema.parse(request.body ?? {});
      const email = request.uiEmail;
      const category = input.category ?? 'other';
      const id = await sql.begin(async (tx) => {
        const rows = (await tx`
          INSERT INTO ops_tickets (
            tkt_no, requester_email, requester_label, channel, category,
            subject, body, urgency, impact, priority, pc_info
          ) VALUES (
            'OPS-' || lpad(nextval('ops_ticket_seq')::text, 4, '0'),
            ${email}, ${input.requester ?? null}, ${input.channel ?? null},
            ${category}, ${input.subject}, ${input.body}, ${input.urgency ?? '中'},
            ${input.impact ?? null}, ${input.priority ?? null},
            ${input.pc ? jsonbValue(input.pc) : null}
          )
          RETURNING id, tkt_no
        `) as unknown as { id: string; tkt_no: string }[];
        const created = rows[0];
        if (!created) throw new ApiError(500, 'INSERT_FAILED', '受付を保存できませんでした。');
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.ticket.create',
          targetType: 'ops_ticket',
          targetId: created.tkt_no,
          detail: {
            email,
            category,
            subject: input.subject.slice(0, 120),
          },
        });
        await appendMessage(tx, created.id, 'sys', `チケット ${created.tkt_no} を受け付けました`);
        await appendMessage(tx, created.id, 'user', `${input.subject}\n${input.body}`);
        return created.id;
      });
      const row = await loadRow(id);
      const messages = await loadMessages([row.id]);
      return { ok: true, ticket: toUiTicket(row, messages.get(row.id) ?? []) };
    },
  );

  /** AI 一次対応。サーバの承認済みナレッジだけを根拠にし、結果をチケットへ残す。 */
  app.post(
    '/ops/tickets/:id/ai',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await loadRow(id);
      const owner = row.requester_email === email;
      let helpdesk = false;
      try {
        await requireHelpdeskActor(email);
        helpdesk = true;
      } catch {
        helpdesk = false;
      }
      if (!owner && !helpdesk) throw forbidden('このチケットを操作する権限がありません。');
      if (!checkRateLimit(`ops-ai:${email}`, 20, 60_000)) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'AI への問い合わせが多すぎます。少し待ってください。',
        );
      }
      const answer = await answerWithDeepSeek(`${row.subject}\n${row.body}`, email);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ops_tickets
          SET ai_answer = ${answer.answer},
              ai_sources = ${jsonbValue(answer.sources)},
              ai_provider = ${answer.provider},
              ai_model = ${answer.model},
              updated_at = now()
          WHERE id = ${row.id}
        `;
        await appendMessage(tx, row.id, 'ai', answer.answer, {
          provider: answer.provider,
          meta: { sources: answer.sources, confidence: answer.confidence },
        });
      });
      return {
        ok: true,
        answer: answer.answer,
        sources: answer.sources,
        confidence: answer.confidence,
        provider: answer.provider,
        model: answer.model,
      };
    },
  );

  /** ② AI一次対応の追加質問。会話に 1 往復を追加し、回答を保存する。 */
  app.post(
    '/ops/tickets/:id/ask',
    { preHandler: authenticateUi, bodyLimit: 16 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = AskSchema.parse(request.body ?? {});
      const row = await loadRow(id);
      const owner = row.requester_email === email;
      let helpdesk = false;
      try {
        await requireHelpdeskActor(email);
        helpdesk = true;
      } catch {
        helpdesk = false;
      }
      if (!owner && !helpdesk) throw forbidden('このチケットを操作する権限がありません。');
      if (!checkRateLimit(`ops-ask:${email}`, 30, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '追加の質問が多すぎます。少し待ってください。');
      }
      // チケットの文脈（件名・本文）と追加質問をまとめて 1 回だけ問い合わせる。
      const answer = await answerWithDeepSeek(
        `${row.subject}\n${row.body}\n\n追加の質問: ${body.text}`,
        email,
      );
      await sql.begin(async (tx) => {
        await appendMessage(tx, row.id, 'user', body.text);
        await appendMessage(tx, row.id, 'ai', answer.answer, {
          provider: answer.provider,
          meta: { sources: answer.sources, confidence: answer.confidence, kind: 'followup' },
        });
      });
      return {
        ok: true,
        answer: answer.answer,
        sources: answer.sources,
        confidence: answer.confidence,
        provider: answer.provider,
      };
    },
  );

  /** ③ 引継ぎ: 担当者が引き受けて対応を開始する（ヘルプデスク相当のみ）。 */
  app.post(
    '/ops/tickets/:id/claim',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const actor = await requireHelpdeskActor(email);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ClaimSchema.parse(request.body ?? {});
      const row = await loadRow(id);
      if (row.status === 'resolved' || row.status === 'closed') {
        throw conflict('解決済み・完了のチケットは引き受けられません。');
      }
      const assignee = (body.assignee || actor.name || email).slice(0, 120);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ops_tickets
          SET status = 'in_progress',
              assignee_email = ${email},
              assignee_name = ${assignee},
              started_at = COALESCE(started_at, now()),
              updated_at = now()
          WHERE id = ${row.id}
        `;
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.ticket.claim',
          targetType: 'ops_ticket',
          targetId: row.tkt_no,
          detail: { email, assignee },
        });
        await appendMessage(tx, row.id, 'sys', `${assignee} が対応を開始しました`);
      });
      return { ok: true, ticket: toUiTicket(await loadRow(row.id)) };
    },
  );

  /** ④ 解決記録（原因・手順・所要）。ヘルプデスク相当のみ。 */
  app.post(
    '/ops/tickets/:id/resolve',
    { preHandler: authenticateUi, bodyLimit: 32 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const actor = await requireHelpdeskActor(email);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ResolveSchema.parse(request.body ?? {});
      const row = await loadRow(id);
      if (row.status === 'resolved' || row.status === 'closed') {
        throw conflict('このチケットはすでに解決済みです。');
      }
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ops_tickets
          SET status = 'resolved',
              cause = ${body.cause},
              steps = ${jsonbValue(body.steps)},
              resolution_minutes = ${body.minutes ?? null},
              resolution_note = ${body.note ?? null},
              assignee_email = COALESCE(assignee_email, ${email}),
              assignee_name = COALESCE(assignee_name, ${actor.name ?? email}),
              resolved_at = now(),
              updated_at = now()
          WHERE id = ${row.id}
        `;
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.ticket.resolve',
          targetType: 'ops_ticket',
          targetId: row.tkt_no,
          detail: {
            email,
            minutes: body.minutes ?? null,
            steps: body.steps.length,
            cause: body.cause.slice(0, 200),
          },
        });
        await appendMessage(tx, row.id, 'sys', `解決記録を登録（所要 ${body.minutes ?? 0} 分）`);
      });
      return { ok: true, ticket: toUiTicket(await loadRow(row.id)) };
    },
  );

  /** 状態の更新（引継ぎ・対応中・解決）。本人は「引継ぎ」まで、担当者はそれ以降も。 */
  app.patch(
    '/ops/tickets/:id',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = PatchSchema.parse(request.body ?? {});
      const row = await loadRow(id);
      const owner = row.requester_email === email;
      let helpdesk = false;
      try {
        await requireHelpdeskActor(email);
        helpdesk = true;
      } catch {
        helpdesk = false;
      }
      if (!owner && !helpdesk) throw forbidden('このチケットを操作する権限がありません。');
      if (!helpdesk && body.status !== 'escalated') {
        throw forbidden('利用者が変更できるのは「引継ぎ」までです。');
      }
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ops_tickets
          SET status = ${body.status},
              resolved_at = CASE WHEN ${body.status} = 'resolved' THEN now() ELSE resolved_at END,
              escalated_at = CASE WHEN ${body.status} = 'escalated' THEN COALESCE(escalated_at, now()) ELSE escalated_at END,
              updated_at = now()
          WHERE id = ${row.id}
        `;
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.ticket.status',
          targetType: 'ops_ticket',
          targetId: row.tkt_no,
          detail: { email, from: row.status, to: body.status, note: body.note ?? null },
        });
        if (body.status === 'escalated') {
          await appendMessage(
            tx,
            row.id,
            'sys',
            `人間の担当者へ引継ぎ${body.note ? `（${body.note}）` : ''}`,
          );
        }
      });
      return { ok: true, ticket: toUiTicket(await loadRow(row.id)) };
    },
  );
}
