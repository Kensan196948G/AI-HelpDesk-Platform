import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth/session.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { caseSummary, knowledgeDto } from '../lib/serializers.js';

const ListQuerySchema = z.object({
  status: z.enum(['draft', 'pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const UpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    symptom: z.string().trim().min(1).max(4000).optional(),
    cause: z.string().trim().min(1).max(4000).optional(),
    steps: z.string().trim().min(1).max(8000).optional(),
    keywords: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: '更新する項目がありません。',
  });

const ReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().trim().max(2000).optional(),
  checklist: z.object({
    reproducible: z.boolean(),
    noSecrets: z.boolean(),
    noBlame: z.boolean(),
    scopeClear: z.boolean(),
  }),
});

async function loadKnowledge(id: string) {
  const rows = await sql<any[]>`
    SELECT k.*, au.name AS author_name, pu.name AS approver_name
    FROM knowledge k
    LEFT JOIN users au ON au.id = k.author_id
    LEFT JOIN users pu ON pu.id = k.approver_id
    WHERE k.id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/knowledge', { preHandler: authenticate }, async (request) => {
    const user = request.authUser!;
    const query = ListQuerySchema.parse(request.query);
    const status = user.role === 'requester' ? 'approved' : (query.status ?? null);
    const rows = await sql<any[]>`
      SELECT k.*, au.name AS author_name, pu.name AS approver_name
      FROM knowledge k
      LEFT JOIN users au ON au.id = k.author_id
      LEFT JOIN users pu ON pu.id = k.approver_id
      WHERE (${status}::text IS NULL OR k.status = ${status})
      ORDER BY
        CASE k.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
        k.updated_at DESC
      LIMIT ${query.limit}
    `;
    return { knowledge: rows.map(knowledgeDto) };
  });

  app.get('/knowledge/:id', { preHandler: authenticate }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadKnowledge(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (user.role === 'requester' && row.status !== 'approved') {
      throw notFound('ナレッジが見つかりません。');
    }
    const reviews = await sql<any[]>`
      SELECT r.*, u.name AS reviewer_name
      FROM knowledge_reviews r
      LEFT JOIN users u ON u.id = r.reviewer_id
      WHERE r.knowledge_id = ${id}
      ORDER BY r.created_at DESC
    `;
    return {
      knowledge: knowledgeDto(row),
      reviews: reviews.map((review) => ({
        id: review.id,
        decision: review.decision,
        comment: review.comment,
        checklist:
          typeof review.checklist === 'string' ? JSON.parse(review.checklist) : review.checklist,
        reviewerName: review.reviewer_name,
        createdAt: review.created_at,
      })),
    };
  });

  app.patch('/knowledge/:id', { preHandler: requireRole('helpdesk') }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = UpdateSchema.parse(request.body);
    const row = await loadKnowledge(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (row.author_id !== user.id) throw badRequest('下書きを編集できるのは申請者だけです。');
    if (row.status !== 'draft' && row.status !== 'rejected') {
      throw conflict('承認待ち・公開済みのナレッジは編集できません。');
    }

    const title = input.title !== undefined ? redactPII(input.title) : null;
    const symptom = input.symptom !== undefined ? redactPII(input.symptom) : null;
    const cause = input.cause !== undefined ? redactPII(input.cause) : null;
    const steps = input.steps !== undefined ? redactPII(input.steps) : null;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE knowledge SET
          title = COALESCE(${title?.text ?? null}, title),
          symptom = COALESCE(${symptom?.text ?? null}, symptom),
          cause = COALESCE(${cause?.text ?? null}, cause),
          steps = COALESCE(${steps?.text ?? null}, steps),
          keywords = COALESCE(${input.keywords ?? null}::text[], keywords)
        WHERE id = ${id}
      `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'knowledge.update',
        targetType: 'knowledge',
        targetId: id,
        detail: { kbNo: row.kb_no },
      });
    });

    const updated = await loadKnowledge(id);
    return { knowledge: knowledgeDto(updated) };
  });

  app.post('/knowledge/:id/submit', { preHandler: requireRole('helpdesk') }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadKnowledge(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (row.author_id !== user.id) throw badRequest('申請できるのは下書きの作成者だけです。');
    if (row.status !== 'draft' && row.status !== 'rejected') {
      throw conflict('下書きまたは差戻しのナレッジだけ申請できます。');
    }

    await sql.begin(async (tx) => {
      await tx`UPDATE knowledge SET status = 'pending' WHERE id = ${id}`;
      if (row.case_id) {
        await tx`
            INSERT INTO case_messages (case_id, author_id, role, kind, content)
            VALUES (${row.case_id}, ${user.id}, 'system', 'knowledge', ${`ナレッジ「${row.title}」を承認申請しました。`})
          `;
      }
      await appendAudit(tx, {
        actorId: user.id,
        action: 'knowledge.submit',
        targetType: 'knowledge',
        targetId: id,
        detail: { kbNo: row.kb_no },
      });
    });

    const updated = await loadKnowledge(id);
    return { knowledge: knowledgeDto(updated) };
  });

  app.post('/knowledge/:id/review', { preHandler: requireRole('approver') }, async (request) => {
    const user = request.authUser!;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = ReviewSchema.parse(request.body);
    const row = await loadKnowledge(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (row.status !== 'pending') throw conflict('承認待ちのナレッジではありません。');
    if (row.author_id === user.id) {
      throw badRequest('自分の申請を承認することはできません。別の承認者に依頼してください。');
    }

    if (input.decision === 'approved') {
      const checklist = input.checklist;
      if (
        !checklist.reproducible ||
        !checklist.noSecrets ||
        !checklist.noBlame ||
        !checklist.scopeClear
      ) {
        throw badRequest('承認には4項目のチェックリストすべての確認が必要です。');
      }
    } else if (!input.comment) {
      throw badRequest('差戻しには理由を入力してください。');
    }

    await sql.begin(async (tx) => {
      await tx`
          INSERT INTO knowledge_reviews (knowledge_id, reviewer_id, decision, comment, checklist)
          VALUES (${id}, ${user.id}, ${input.decision}, ${input.comment ?? ''},
            ${jsonbValue(input.checklist)})
        `;
      if (input.decision === 'approved') {
        await tx`
            UPDATE knowledge SET
              status = 'approved',
              approver_id = ${user.id},
              approved_at = now(),
              version = version + 1
            WHERE id = ${id}
          `;
        if (row.case_id) {
          const caseRows = await tx<any[]>`
              SELECT case_no, signal FROM cases WHERE id = ${row.case_id} LIMIT 1
            `;
          const caseRow = caseRows[0];
          await tx`
              UPDATE cases SET
                status = 'completed',
                current_step = 7,
                signal = ${caseRow?.signal === 'red' ? 'red' : 'blue'},
                completed_at = now()
              WHERE id = ${row.case_id}
            `;
          await tx`
              UPDATE tickets SET status = 'closed' WHERE case_id = ${row.case_id}
            `;
          await tx`
              INSERT INTO case_messages (case_id, author_id, role, kind, content)
              VALUES (${row.case_id}, ${user.id}, 'system', 'knowledge',
                ${`ナレッジ「${row.title}」が公開されました。`})
            `;
        }
      } else {
        await tx`UPDATE knowledge SET status = 'rejected' WHERE id = ${id}`;
        if (row.case_id) {
          await tx`
              INSERT INTO case_messages (case_id, author_id, role, kind, content)
              VALUES (${row.case_id}, ${user.id}, 'system', 'knowledge',
                ${`ナレッジ「${row.title}」が差し戻されました。理由: ${input.comment ?? ''}`})
            `;
        }
      }
      await appendAudit(tx, {
        actorId: user.id,
        action: input.decision === 'approved' ? 'knowledge.approve' : 'knowledge.reject',
        targetType: 'knowledge',
        targetId: id,
        detail: {
          kbNo: row.kb_no,
          caseId: row.case_id,
          comment: input.comment ?? '',
        },
      });
    });

    const updated = await loadKnowledge(id);
    const caseDetail = row.case_id
      ? await sql<any[]>`
            SELECT c.*, ru.name AS requester_name, t.tkt_no, t.inc_no, t.assignee_id,
              t.status AS ticket_status, au.name AS assignee_name
            FROM cases c
            JOIN users ru ON ru.id = c.requester_id
            LEFT JOIN tickets t ON t.case_id = c.id
            LEFT JOIN users au ON au.id = t.assignee_id
            WHERE c.id = ${row.case_id}
            LIMIT 1
          `
      : [];
    return {
      knowledge: knowledgeDto(updated),
      case: caseDetail[0] ? caseSummary(caseDetail[0]) : null,
    };
  });
}
