import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticate, requireRole } from '../auth/session.js';
import { sameHuman } from '../auth/shared-identity.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { nextKbNo } from '../lib/numbers.js';
import { caseSummary, knowledgeDto } from '../lib/serializers.js';
import { ensureAuthorUser } from '../lib/users.js';

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

/**
 * F-06: 画面（プロトタイプ UI）から送る同期ペイロード。
 *
 * 画面の下書きはタイトル・症状・原因・手順を 1 つの文字列で持つため、
 * サーバの text 列にそのまま合わせる。
 */
const UiSyncSchema = z.object({
  clientRef: z.string().trim().min(1).max(120),
  status: z.enum(['draft', 'pending', 'approved', 'rejected']),
  title: z.string().trim().min(1).max(160),
  symptom: z.string().trim().max(4000).default(''),
  cause: z.string().trim().max(4000).default(''),
  steps: z.string().trim().max(8000).default(''),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  comment: z.string().trim().max(2000).optional(),
  checklist: z
    .object({
      reproducible: z.boolean(),
      noSecrets: z.boolean(),
      noBlame: z.boolean(),
      scopeClear: z.boolean(),
    })
    .optional(),
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

  /**
   * F-06 不足分: 承認者（別 Access ID）向けの承認待ち一覧。
   * 承認者は自分のクライアント状態に他人の下書きを持たないため、
   * client_ref（画面の下書き ID）で同期された行をサーバから一覧できるようにする。
   * 承認操作自体は既存の POST /knowledge/ui-sync をクライアントが再送する。
   *
   * 注意: `/knowledge/:id` より先に登録する（pending が id として解釈されないように）。
   */
  app.get('/knowledge/pending', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    await requireHelpdeskActor(request.uiEmail);
    const rows = await sql<
      {
        id: string;
        client_ref: string;
        kb_no: string;
        status: string;
        title: string;
        symptom: string;
        cause: string;
        steps: string;
        keywords: string[] | null;
        author_email: string | null;
        created_at: Date;
      }[]
    >`
      SELECT k.id, k.client_ref, k.kb_no, k.status, k.title, k.symptom, k.cause, k.steps,
             k.keywords, u.email AS author_email, k.created_at
      FROM knowledge k
      LEFT JOIN users u ON u.id = k.author_id
      WHERE k.client_ref IS NOT NULL
        AND k.status IN ('draft', 'pending')
      ORDER BY k.created_at DESC
      LIMIT 50
    `;
    return {
      items: rows.map((row) => ({
        id: row.id,
        clientRef: row.client_ref,
        kbNo: row.kb_no,
        status: row.status,
        title: row.title,
        symptom: row.symptom,
        cause: row.cause,
        steps: row.steps,
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
        authorEmail: row.author_email ?? null,
        createdAt: row.created_at,
      })),
    };
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

  /**
   * F-06: 画面（プロトタイプ UI）のナレッジ下書き・承認・差戻しをサーバへ永続化する。
   *
   * 従来 STEP6 の下書き・承認はブラウザの state だけを更新しており、knowledge
   * テーブルは空のままだった（docs/39 F-06）。画面の下書き ID（clientRef）を
   * キーに冪等に同期し、再送や二重クリックでも行を増やさない。
   *
   * 承認は画面の運用（単一 Access ID）を壊さないよう SM-02 と同じ
   * ALLOW_SELF_APPROVAL に従う（既定 true ＝ 自己承認を許可）。自己承認かどうかは
   * 応答と監査に残し、黙って通さない。
   */
  app.post(
    '/knowledge/ui-sync',
    { preHandler: authenticateUi, bodyLimit: 16 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const actor = await requireHelpdeskActor(email);
      const input = UiSyncSchema.parse(request.body ?? {});

      const title = redactPII(input.title);
      const symptom = redactPII(input.symptom);
      const cause = redactPII(input.cause);
      const steps = redactPII(input.steps);

      const authorId = await ensureAuthorUser(email, actor.name ?? email);

      const existingRows = await sql<any[]>`
        SELECT * FROM knowledge WHERE client_ref = ${input.clientRef} LIMIT 1
      `;
      const existing = existingRows[0];
      const recordAuthorId = existing ? String(existing.author_id) : authorId;
      const selfApproved = recordAuthorId === authorId;
      // 別アカウントだが同一人物による承認か（selfApproved=false の誤読を防ぐ）。
      const authorEmailRow = existing
        ? await sql<{ email: string }[]>`
            SELECT lower(email) AS email FROM users WHERE id = ${existing.author_id} LIMIT 1
          `
        : [];
      const sharedIdentity = !selfApproved && sameHuman(email, authorEmailRow[0]?.email ?? null);

      if (existing && existing.status === 'approved' && input.status !== 'approved') {
        throw conflict('公開済みのナレッジは更新できません。');
      }

      if (input.status === 'approved') {
        if (existing && !['draft', 'pending', 'rejected'].includes(existing.status)) {
          throw conflict('承認待ちのナレッジではありません。');
        }
        const checklist = input.checklist;
        if (
          !checklist ||
          !checklist.reproducible ||
          !checklist.noSecrets ||
          !checklist.noBlame ||
          !checklist.scopeClear
        ) {
          throw badRequest('承認には4項目のチェックリストすべての確認が必要です。');
        }
        if (selfApproved && !config.ALLOW_SELF_APPROVAL) {
          throw new ApiError(
            403,
            'SELF_APPROVAL_FORBIDDEN',
            '自分が作成したナレッジは承認できません（職務分離）。別の DX 推進部メンバーに承認を依頼してください。',
          );
        }
      }
      if (input.status === 'rejected' && !input.comment) {
        throw badRequest('差戻しには理由を入力してください。');
      }

      const savedId = await sql.begin(async (tx) => {
        let id = existing?.id as string | undefined;
        if (!id) {
          const kbNo = await nextKbNo(tx);
          const inserted = await tx<any[]>`
            INSERT INTO knowledge (
              kb_no, title, symptom, cause, steps, keywords, status, author_id,
              client_ref, version
            ) VALUES (
              ${kbNo}, ${title.text}, ${symptom.text}, ${cause.text}, ${steps.text},
              ${input.keywords}, 'draft', ${authorId}, ${input.clientRef}, 1
            )
            RETURNING id
          `;
          id = inserted[0]?.id as string;
          await appendAudit(tx, {
            actorId: authorId,
            action: 'knowledge.create',
            targetType: 'knowledge',
            targetId: id,
            detail: { kbNo, clientRef: input.clientRef, via: 'ui', actorEmail: email },
          });
        }

        await tx`
          UPDATE knowledge SET
            title = ${title.text},
            symptom = ${symptom.text},
            cause = ${cause.text},
            steps = ${steps.text},
            keywords = ${input.keywords}
          WHERE id = ${id}
        `;

        if (input.status === 'draft' || input.status === 'pending') {
          await tx`UPDATE knowledge SET status = ${input.status} WHERE id = ${id}`;
          if (input.status === 'pending') {
            await appendAudit(tx, {
              actorId: authorId,
              action: 'knowledge.submit',
              targetType: 'knowledge',
              targetId: id,
              detail: { clientRef: input.clientRef, via: 'ui', actorEmail: email },
            });
          }
        } else if (input.status === 'approved') {
          await tx`
            INSERT INTO knowledge_reviews (knowledge_id, reviewer_id, decision, comment, checklist)
            VALUES (${id}, ${authorId}, 'approved', ${input.comment ?? ''},
              ${jsonbValue(input.checklist)})
          `;
          await tx`
            UPDATE knowledge SET
              status = 'approved',
              approver_id = ${authorId},
              approved_at = now(),
              version = version + 1
            WHERE id = ${id}
          `;
          await appendAudit(tx, {
            actorId: authorId,
            action: 'knowledge.approve',
            targetType: 'knowledge',
            targetId: id,
            detail: {
              clientRef: input.clientRef,
              selfApproved,
              sharedIdentity,
              via: 'ui',
              actorEmail: email,
              comment: input.comment ?? '',
            },
          });
        } else {
          await tx`
            INSERT INTO knowledge_reviews (knowledge_id, reviewer_id, decision, comment, checklist)
            VALUES (${id}, ${authorId}, 'rejected', ${input.comment ?? ''},
              ${jsonbValue(input.checklist ?? {})})
          `;
          await tx`UPDATE knowledge SET status = 'rejected' WHERE id = ${id}`;
          await appendAudit(tx, {
            actorId: authorId,
            action: 'knowledge.reject',
            targetType: 'knowledge',
            targetId: id,
            detail: {
              clientRef: input.clientRef,
              via: 'ui',
              actorEmail: email,
              comment: input.comment ?? '',
            },
          });
        }

        return id as string;
      });

      const updated = await loadKnowledge(savedId);
      return { knowledge: knowledgeDto(updated), selfApproved, sharedIdentity };
    },
  );
}
