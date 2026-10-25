import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/session.js';
import { sql } from '../db.js';
import { detectIntent } from '../domain/ai.js';
import { CATEGORY_META } from '../domain/constants.js';
import { redactPII } from '../domain/pii.js';
import { signalAfterResolution } from '../domain/signal.js';
import { conflict, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { loadCaseDetail } from '../lib/case-loader.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { nextKbNo } from '../lib/numbers.js';
import { caseSummary, knowledgeDto, resolutionDto, ticketDto } from '../lib/serializers.js';

const TicketUpdateSchema = z
  .object({
    assigneeId: z.string().uuid().nullable().optional(),
    status: z.enum(['assigned', 'in_progress']).optional(),
  })
  .refine((value) => value.assigneeId !== undefined || value.status !== undefined, {
    message: 'assigneeId または status が必要です。',
  });

const ResolutionSchema = z.object({
  cause: z.string().trim().min(1).max(4000),
  steps: z.string().trim().min(1).max(8000),
  durationMin: z.coerce.number().int().min(0).max(1440).default(0),
});

async function loadTicketWithCase(ticketId: string) {
  const rows = await sql<any[]>`
    SELECT
      t.*, c.case_no, c.requester_id, c.category, c.subject, c.body, c.signal,
      c.current_step, c.status AS case_status, c.ai_summary,
      ru.name AS requester_name, au.name AS assignee_name
    FROM tickets t
    JOIN cases c ON c.id = t.case_id
    JOIN users ru ON ru.id = c.requester_id
    LEFT JOIN users au ON au.id = t.assignee_id
    WHERE t.id = ${ticketId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/desk/queue', { preHandler: requireRole('helpdesk', 'approver') }, async () => {
    const rows = await sql<any[]>`
        SELECT
          c.*, ru.name AS requester_name,
          t.id AS ticket_id, t.tkt_no, t.inc_no, t.assignee_id,
          t.status AS ticket_status, t.handoff_memo, t.shared_fields,
          t.created_at AS ticket_created_at, t.updated_at AS ticket_updated_at,
          au.name AS assignee_name
        FROM tickets t
        JOIN cases c ON c.id = t.case_id
        JOIN users ru ON ru.id = c.requester_id
        LEFT JOIN users au ON au.id = t.assignee_id
        WHERE t.status IN ('queued', 'assigned', 'in_progress')
          AND c.status <> 'completed'
        ORDER BY
          CASE c.signal WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END,
          t.created_at ASC
        LIMIT 100
      `;
    return {
      tickets: rows.map((row) => ({
        ...caseSummary({
          ...row,
          tkt_no: row.tkt_no,
          inc_no: row.inc_no,
          assignee_id: row.assignee_id,
          assignee_name: row.assignee_name,
        }),
        ticketId: row.ticket_id,
        ticketStatus: row.ticket_status,
        handoffMemo: row.handoff_memo,
        sharedFields: row.shared_fields ?? [],
        ticketCreatedAt: row.ticket_created_at,
      })),
    };
  });

  app.patch('/tickets/:id', { preHandler: requireRole('helpdesk') }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = TicketUpdateSchema.parse(request.body);
    const ticket = await loadTicketWithCase(id);
    if (!ticket) throw notFound('チケットが見つかりません。');

    let assigneeId = ticket.assignee_id as string | null;
    if (input.assigneeId !== undefined) {
      if (input.assigneeId !== null) {
        const assignee = await sql<{ id: string; name: string }[]>`
            SELECT id, name FROM users
            WHERE id = ${input.assigneeId} AND role = 'helpdesk' AND is_active = true
            LIMIT 1
          `;
        if (!assignee[0])
          throw conflict('担当者に指定できるのは有効なヘルプデスク担当者だけです。');
      }
      assigneeId = input.assigneeId;
    }

    const status = input.status ?? (assigneeId ? 'assigned' : ticket.status);
    await sql.begin(async (tx) => {
      await tx`
          UPDATE tickets SET
            assignee_id = ${assigneeId},
            status = ${status}
          WHERE id = ${id}
        `;
      await tx`
          UPDATE cases SET status = 'in_progress', current_step = 5
          WHERE id = ${ticket.case_id}
        `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'ticket.update',
        targetType: 'ticket',
        targetId: id,
        detail: { assigneeId, status, caseNo: ticket.case_no },
      });
    });

    const updated = await loadTicketWithCase(id);
    return {
      ticket: updated
        ? ticketDto({ ...updated, case_id: updated.case_id, assignee_name: updated.assignee_name })
        : null,
    };
  });

  app.post('/tickets/:id/resolution', { preHandler: requireRole('helpdesk') }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = ResolutionSchema.parse(request.body);
    const ticket = await loadTicketWithCase(id);
    if (!ticket) throw notFound('チケットが見つかりません。');
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM resolutions WHERE ticket_id = ${id} LIMIT 1
      `;
    if (existing.length > 0) throw conflict('このチケットにはすでに解決記録があります。');

    const cause = redactPII(input.cause);
    const steps = redactPII(input.steps);

    const result = await sql.begin(async (tx) => {
      const resolutionRows = await tx<any[]>`
          INSERT INTO resolutions (ticket_id, case_id, author_id, cause, steps, duration_min)
          VALUES (${id}, ${ticket.case_id}, ${user.id}, ${cause.text}, ${steps.text}, ${input.durationMin})
          RETURNING *
        `;
      const resolution = resolutionRows[0];
      await tx`
          UPDATE tickets SET
            assignee_id = COALESCE(assignee_id, ${user.id}),
            status = 'resolved'
          WHERE id = ${id}
        `;
      await tx`
          UPDATE cases SET
            status = 'knowledge_pending',
            current_step = 6,
            signal = ${signalAfterResolution(ticket.signal)},
            resolved_at = now()
          WHERE id = ${ticket.case_id}
        `;
      await tx`
          INSERT INTO case_messages (case_id, author_id, role, kind, content, metadata)
          VALUES (
            ${ticket.case_id}, ${user.id}, 'user', 'resolution',
            ${`解決記録を登録しました（所要時間 ${input.durationMin}分）。`},
            ${jsonbValue({
              resolutionId: resolution.id,
              piiFindings: [...cause.findings, ...steps.findings],
            })}
          )
        `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'ticket.resolve',
        targetType: 'ticket',
        targetId: id,
        detail: { caseNo: ticket.case_no, durationMin: input.durationMin },
      });

      const detail = await loadCaseDetail(tx, ticket.case_id, user);
      return { resolution: resolutionDto({ ...resolution, author_name: user.name }), case: detail };
    });

    return result;
  });

  app.post(
    '/cases/:id/knowledge-draft',
    { preHandler: requireRole('helpdesk') },
    async (request) => {
      const user = request.authUser!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const caseRows = await sql<any[]>`SELECT * FROM cases WHERE id = ${id} LIMIT 1`;
      const found = caseRows[0];
      if (!found) throw notFound('案件が見つかりません。');
      const resolutionRows = await sql<any[]>`
        SELECT * FROM resolutions WHERE case_id = ${id} ORDER BY created_at DESC LIMIT 1
      `;
      const resolution = resolutionRows[0];
      if (!resolution) throw conflict('解決記録がありません。先に解決記録を登録してください。');

      const existing = await sql<any[]>`
        SELECT k.*, au.name AS author_name, pu.name AS approver_name
        FROM knowledge k
        LEFT JOIN users au ON au.id = k.author_id
        LEFT JOIN users pu ON pu.id = k.approver_id
        WHERE k.case_id = ${id}
        ORDER BY k.created_at DESC
        LIMIT 1
      `;
      if (existing[0]) {
        return { knowledge: knowledgeDto(existing[0]) };
      }

      const meta = CATEGORY_META[found.category as keyof typeof CATEGORY_META];
      const intent = detectIntent(found.subject, found.body);
      const title = redactPII(
        found.subject.includes('手順') ? found.subject : `${found.subject}の確認手順`,
      );
      const symptom = redactPII(found.body);
      const cause = redactPII(resolution.cause);
      const steps = redactPII(resolution.steps);
      const keywords = Array.from(
        new Set([...intent.keywords, meta.shortLabel, found.subject].filter(Boolean)),
      ).slice(0, 12);

      const result = await sql.begin(async (tx) => {
        const kbNo = await nextKbNo(tx);
        const inserted = await tx<any[]>`
          INSERT INTO knowledge (
            kb_no, case_id, resolution_id, title, symptom, cause, steps, keywords,
            status, author_id, version
          ) VALUES (
            ${kbNo}, ${id}, ${resolution.id}, ${title.text}, ${symptom.text}, ${cause.text},
            ${steps.text}, ${keywords}, 'draft', ${user.id}, 1
          )
          RETURNING *
        `;
        await tx`
          UPDATE cases SET status = 'knowledge_pending', current_step = 6
          WHERE id = ${id}
        `;
        await tx`
          INSERT INTO case_messages (case_id, author_id, role, kind, content, metadata)
          VALUES (
            ${id}, ${user.id}, 'system', 'knowledge',
            ${`ナレッジ下書き「${title.text}」を作成しました。`},
            ${jsonbValue({
              kbNo,
              knowledgeId: inserted[0].id,
              piiFindings: [
                ...title.findings,
                ...symptom.findings,
                ...cause.findings,
                ...steps.findings,
              ],
            })}
          )
        `;
        await appendAudit(tx, {
          actorId: user.id,
          action: 'knowledge.draft',
          targetType: 'knowledge',
          targetId: inserted[0].id,
          detail: { caseNo: found.case_no, kbNo },
        });
        return knowledgeDto({ ...inserted[0], author_name: user.name });
      });

      return { knowledge: result };
    },
  );
}
