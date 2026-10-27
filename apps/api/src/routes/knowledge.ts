import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticate, requireRole } from '../auth/session.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { nextKbNo } from '../lib/numbers.js';
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

const DraftCreateSchema = z.object({
  caseId: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  symptom: z.string().trim().min(1).max(4000),
  cause: z.string().trim().min(1).max(4000),
  // 画面は配列で送ることがあるため、文字列 / 文字列配列の両方を受け付ける。
  steps: z.union([
    z.string().trim().min(1).max(8000),
    z.array(z.string().trim().min(1).max(4000)).max(100),
  ]),
  keywords: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  ),
  handoverId: z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    z.string().uuid().optional(),
  ),
});

const DraftApproveSchema = z.object({
  checklist: z.array(z.boolean()).length(4),
  note: z.string().trim().max(2000).optional(),
});

const DraftRejectSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

const DraftParamsSchema = z.object({ id: z.string().uuid() });

/** UI から作成したナレッジ下書き（knowledge の拡張列を含む）。 */
interface KnowledgeDraftRow {
  id: string;
  kb_no: string;
  external_case_id: string | null;
  handover_id: string | null;
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords: string[] | null;
  status: string;
  author_id: string;
  author_email: string | null;
  approver_email: string | null;
  version: number;
  checklist: unknown;
  self_approved: boolean;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Access 認証の担当者を users に解決する（居なければ作る）。
 * terminal.ts の ensureAuthorUser と同じ方針: パスワードではログインできない行を作り、
 * 作成者を別の人にすり替えない。
 */
async function ensureUiAuthorUser(email: string, name: string): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  if (existing[0]) return existing[0].id;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${name.slice(0, 120)}, 'helpdesk', 'access-only$no-login')
    ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return rows[0]?.id ?? '';
}

async function loadDraft(id: string): Promise<KnowledgeDraftRow | undefined> {
  const rows = await sql<KnowledgeDraftRow[]>`
    SELECT * FROM knowledge WHERE id = ${id} LIMIT 1
  `;
  return rows[0];
}

function draftDto(row: KnowledgeDraftRow) {
  return {
    id: row.id,
    kbNo: row.kb_no,
    caseId: row.external_case_id,
    handoverId: row.handover_id,
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: row.steps,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    status: row.status,
    authorEmail: row.author_email,
    approverEmail: row.approver_email,
    version: row.version,
    checklist: row.checklist ?? null,
    selfApproved: row.self_approved,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * UI（Cloudflare Access）向けのナレッジ下書き・承認 API（F-06 のサーバ側）。
 * 既存の requireRole（セッション認証）ルートは変更せず、 additive に追加する。
 */
function registerKnowledgeDraftRoutes(app: FastifyInstance): void {
  app.post('/knowledge/drafts', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const actor = await requireHelpdeskActor(request.uiEmail);
    const input = DraftCreateSchema.parse(request.body);
    const authorId = await ensureUiAuthorUser(actor.email, actor.name ?? actor.email);
    if (!authorId) {
      throw new ApiError(500, 'USER_PROVISION_FAILED', 'ナレッジの作成者を登録できませんでした。');
    }

    // 既存ルートと同じく、保存前に自由記述を伏せ字化する。
    const title = redactPII(input.title).text;
    const symptom = redactPII(input.symptom).text;
    const cause = redactPII(input.cause).text;
    const stepsText = Array.isArray(input.steps) ? input.steps.join('\n') : input.steps;
    const steps = redactPII(stepsText).text;
    const keywords = (input.keywords ?? []).map((keyword) => redactPII(keyword).text);

    const created = await sql.begin(async (tx) => {
      const kbNo = await nextKbNo(tx);
      const rows = await tx<{ id: string; kb_no: string; status: string }[]>`
        INSERT INTO knowledge (
          kb_no, case_id, external_case_id, handover_id, title, symptom, cause, steps,
          keywords, status, author_id, author_email, version
        ) VALUES (
          ${kbNo}, NULL, ${input.caseId}, ${input.handoverId ?? null},
          ${title}, ${symptom}, ${cause}, ${steps},
          ${keywords}, 'draft', ${authorId}, ${actor.email}, 1
        )
        RETURNING id, kb_no, status
      `;
      const row = rows[0];
      if (!row) {
        throw new ApiError(500, 'KB_CREATE_FAILED', 'ナレッジ下書きを作成できませんでした。');
      }
      await appendAudit(tx, {
        actorId: authorId,
        action: 'knowledge.draft.create',
        targetType: 'knowledge',
        targetId: row.id,
        detail: {
          actorEmail: actor.email,
          caseId: input.caseId,
          kbNo: row.kb_no,
          handoverId: input.handoverId ?? null,
        },
      });
      return row;
    });

    reply.code(201);
    return { id: created.id, kbNo: created.kb_no, status: created.status };
  });

  app.get('/knowledge/pending', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    await requireHelpdeskActor(request.uiEmail);
    const rows = await sql<KnowledgeDraftRow[]>`
      SELECT id, kb_no, external_case_id, title, status, author_email, handover_id, created_at,
             symptom, cause, steps, keywords, author_id, approver_email, version, checklist,
             self_approved, approved_at, updated_at
      FROM knowledge
      -- UI（F-06）で作成した下書きだけを対象にする（旧経路の下書きは external_case_id が NULL）。
      WHERE status IN ('draft', 'review')
        AND external_case_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 100
    `;
    return {
      items: rows.map((row) => ({
        id: row.id,
        kbNo: row.kb_no,
        caseId: row.external_case_id,
        title: row.title,
        status: row.status,
        authorEmail: row.author_email,
        handoverId: row.handover_id,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/knowledge/drafts/:id', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    await requireHelpdeskActor(request.uiEmail);
    const { id } = DraftParamsSchema.parse(request.params);
    const row = await loadDraft(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    return { draft: draftDto(row) };
  });

  app.post('/knowledge/drafts/:id/submit', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const actor = await requireHelpdeskActor(request.uiEmail);
    const { id } = DraftParamsSchema.parse(request.params);
    const row = await loadDraft(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (!['draft', 'rejected'].includes(row.status)) {
      throw conflict('下書きまたは差し戻しのナレッジだけ申請できます。');
    }
    const authorId = await ensureUiAuthorUser(actor.email, actor.name ?? actor.email);
    await sql.begin(async (tx) => {
      await tx`UPDATE knowledge SET status = 'review', updated_at = now() WHERE id = ${id}`;
      await appendAudit(tx, {
        actorId: authorId,
        action: 'knowledge.submit',
        targetType: 'knowledge',
        targetId: id,
        detail: {
          actorEmail: actor.email,
          caseId: row.external_case_id,
          kbNo: row.kb_no,
        },
      });
    });
    return { id: row.id, kbNo: row.kb_no, status: 'review' };
  });

  app.post('/knowledge/drafts/:id/approve', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const actor = await requireHelpdeskActor(request.uiEmail);
    const { id } = DraftParamsSchema.parse(request.params);
    const input = DraftApproveSchema.parse(request.body);
    const row = await loadDraft(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (!['review', 'pending'].includes(row.status)) {
      throw conflict('承認待ちのナレッジではありません。');
    }
    if (!input.checklist.every((checked) => checked)) {
      throw badRequest('承認には4項目のチェックリストすべての確認が必要です。');
    }

    // 自己承認の判定は「引継ぎを claim した人」と承認者の比較で行う（F-06 / SM-02）。
    let selfApproved = false;
    if (row.handover_id) {
      const handovers = await sql<{ claimed_by: string | null }[]>`
        SELECT claimed_by FROM case_handovers WHERE id = ${row.handover_id} LIMIT 1
      `;
      selfApproved = handovers[0]?.claimed_by === actor.email;
    }
    if (selfApproved && !config.ALLOW_SELF_APPROVAL) {
      throw new ApiError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        '自分が引き受けた案件のナレッジは承認できません（職務分離）。別の DX 推進部メンバーに承認を依頼してください。',
      );
    }

    const approverId = await ensureUiAuthorUser(actor.email, actor.name ?? actor.email);
    const version = row.version + 1;
    await sql.begin(async (tx) => {
      await tx`
        UPDATE knowledge SET
          status = 'approved',
          approver_id = ${approverId},
          approver_email = ${actor.email},
          approved_at = now(),
          version = version + 1,
          checklist = ${jsonbValue(input.checklist)},
          self_approved = ${selfApproved},
          updated_at = now()
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO knowledge_reviews (knowledge_id, reviewer_id, decision, comment, checklist)
        VALUES (${id}, ${approverId}, 'approved', ${input.note ?? ''},
          ${jsonbValue(input.checklist)})
      `;
      await appendAudit(tx, {
        actorId: approverId,
        action: 'knowledge.approve',
        targetType: 'knowledge',
        targetId: id,
        detail: {
          actorEmail: actor.email,
          caseId: row.external_case_id,
          kbNo: row.kb_no,
          selfApproved,
          checklist: input.checklist,
        },
      });
    });
    return {
      id: row.id,
      kbNo: row.kb_no,
      status: 'approved',
      version,
      selfApproved,
      approverEmail: actor.email,
    };
  });

  app.post('/knowledge/drafts/:id/reject', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const actor = await requireHelpdeskActor(request.uiEmail);
    const { id } = DraftParamsSchema.parse(request.params);
    const input = DraftRejectSchema.parse(request.body);
    const row = await loadDraft(id);
    if (!row) throw notFound('ナレッジが見つかりません。');
    if (!['review', 'pending'].includes(row.status)) {
      throw conflict('承認待ちのナレッジではありません。');
    }
    const approverId = await ensureUiAuthorUser(actor.email, actor.name ?? actor.email);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE knowledge SET
          status = 'rejected',
          approver_id = ${approverId},
          approver_email = ${actor.email},
          updated_at = now()
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO knowledge_reviews (knowledge_id, reviewer_id, decision, comment, checklist)
        VALUES (${id}, ${approverId}, 'rejected', ${input.reason}, '[]'::jsonb)
      `;
      await appendAudit(tx, {
        actorId: approverId,
        action: 'knowledge.reject',
        targetType: 'knowledge',
        targetId: id,
        detail: {
          actorEmail: actor.email,
          caseId: row.external_case_id,
          kbNo: row.kb_no,
          reason: input.reason,
        },
      });
    });
    return { id: row.id, kbNo: row.kb_no, status: 'rejected' };
  });
}

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // /knowledge/pending が /knowledge/:id に飲み込まれないよう、先に登録する。
  registerKnowledgeDraftRoutes(app);

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
