import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/session.js';
import type { AuthUser } from '../auth/types.js';
import { sql } from '../db.js';
import { composeAssessment, detectIntent } from '../domain/ai.js';
import { CATEGORY_KEYS, CATEGORY_META } from '../domain/constants.js';
import { buildDemoPcSnapshot } from '../domain/pc.js';
import { redactPII } from '../domain/pii.js';
import { initialSignal, signalAfterAssessment, signalAfterHandoff } from '../domain/signal.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { loadCaseDetail } from '../lib/case-loader.js';
import { asJsonArray } from '../lib/json.js';
import { findApprovedKnowledge } from '../lib/knowledge-search.js';
import { nextCaseNo, nextIncNo } from '../lib/numbers.js';
import { caseSummary } from '../lib/serializers.js';

const CategorySchema = z.enum(CATEGORY_KEYS as [string, ...string[]]);

const CreateCaseSchema = z.object({
  category: CategorySchema,
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  urgency: z.enum(['normal', 'urgent']).default('normal'),
  pcEnabled: z.boolean().optional(),
});

const HandoffSchema = z.object({
  sharedFields: z
    .array(z.enum(['consultation', 'ai', 'device', 'pc']))
    .min(1)
    .default(['consultation', 'ai']),
});

const ListQuerySchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  signal: z.enum(['blue', 'amber', 'red']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function requireUser(user: AuthUser | undefined): AuthUser {
  if (!user) throw new Error('authenticate preHandler missing');
  return user;
}

function asCategory(value: string) {
  return value as keyof typeof CATEGORY_META;
}

export async function caseRoutes(app: FastifyInstance): Promise<void> {
  app.post('/cases', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request.authUser);
    const input = CreateCaseSchema.parse(request.body);
    const category = asCategory(input.category);
    const meta = CATEGORY_META[category];
    const pcEnabled = input.pcEnabled ?? meta.pcDefault;

    const subject = redactPII(input.subject);
    const body = redactPII(input.body);
    const signal = initialSignal({
      category,
      urgency: input.urgency,
      subject: subject.text,
      body: body.text,
    });
    const pc = pcEnabled
      ? buildDemoPcSnapshot({ category, subject: subject.text, body: body.text })
      : null;

    const result = await sql.begin(async (tx) => {
      const caseNo = await nextCaseNo(tx);
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO cases (
          case_no, requester_id, category, subject, body, urgency, signal,
          current_step, status, shared_pc_info
        ) VALUES (
          ${caseNo}, ${user.id}, ${category}, ${subject.text}, ${body.text}, ${input.urgency},
          ${signal}, 3, 'awaiting_decision', false
        )
        RETURNING id
      `;
      const caseId = inserted[0]?.id;
      if (!caseId) throw new Error('case insert failed');

      await tx`
        INSERT INTO case_messages (case_id, author_id, role, kind, content, metadata)
        VALUES (
          ${caseId}, ${user.id}, 'user', 'consultation', ${body.text},
          ${JSON.stringify({
            subject: subject.text,
            piiFindings: [...subject.findings, ...body.findings],
            pcEnabled,
          })}::jsonb
        )
      `;

      if (pc) {
        await tx`
          INSERT INTO pc_snapshots (case_id, collected_at, items, concerns, shared, source)
          VALUES (
            ${caseId}, ${pc.collectedAt}, ${JSON.stringify(pc.items)}::jsonb,
            ${JSON.stringify(pc.concerns)}::jsonb, false, 'demo'
          )
        `;
      }

      const intent = detectIntent(subject.text, body.text);
      const knowledge = await findApprovedKnowledge(
        tx,
        `${subject.text}\n${body.text}`,
        intent.keywords,
      );
      const assessment = composeAssessment({
        category,
        subject: subject.text,
        body: body.text,
        urgency: input.urgency,
        pc,
        knowledge,
      });
      const finalSignal = signalAfterAssessment(signal, {
        recommendHandoff: assessment.recommendHandoff,
      });

      await tx`
        UPDATE cases SET
          signal = ${finalSignal},
          ai_summary = ${assessment.answer},
          current_step = 3,
          status = 'awaiting_decision'
        WHERE id = ${caseId}
      `;
      await tx`
        INSERT INTO case_messages (case_id, author_id, role, kind, content, metadata)
        VALUES (
          ${caseId}, null, 'assistant', 'ai_assessment', ${assessment.answer},
          ${JSON.stringify({
            intent: assessment.intent.id,
            steps: assessment.steps,
            sources: assessment.sources,
            recommendHandoff: assessment.recommendHandoff,
            security: assessment.security,
            pcSummary: assessment.pcSummary,
            ruleBased: true,
          })}::jsonb
        )
      `;

      await appendAudit(tx, {
        actorId: user.id,
        action: 'case.create',
        targetType: 'case',
        targetId: caseId,
        detail: { caseNo, category, signal, pcEnabled },
      });
      await appendAudit(tx, {
        actorId: null,
        action: 'case.ai_assess',
        targetType: 'case',
        targetId: caseId,
        detail: {
          intent: assessment.intent.id,
          signal: finalSignal,
          sourceCount: assessment.sources.length,
          recommendHandoff: assessment.recommendHandoff,
        },
      });

      const detail = await loadCaseDetail(tx, caseId, user);
      return { case: detail, assessment };
    });

    return result;
  });

  app.get('/cases', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request.authUser);
    const query = ListQuerySchema.parse(request.query);
    const status = query.status ?? null;
    const signal = query.signal ?? null;
    const rows = await sql<any[]>`
      SELECT
        c.*,
        ru.name AS requester_name,
        t.tkt_no, t.inc_no, t.assignee_id, t.status AS ticket_status,
        au.name AS assignee_name
      FROM cases c
      JOIN users ru ON ru.id = c.requester_id
      LEFT JOIN tickets t ON t.case_id = c.id
      LEFT JOIN users au ON au.id = t.assignee_id
      WHERE (${user.role === 'requester'} = false OR c.requester_id = ${user.id})
        AND (${status}::text IS NULL OR c.status = ${status})
        AND (${signal}::text IS NULL OR c.signal = ${signal})
      ORDER BY c.updated_at DESC
      LIMIT ${query.limit}
    `;
    return { cases: rows.map(caseSummary) };
  });

  app.get('/cases/:id', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request.authUser);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const detail = await loadCaseDetail(sql, id, user);
    if (!detail) throw notFound('案件が見つかりません。');
    return { case: detail };
  });

  app.post('/cases/:id/resolve', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request.authUser);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`SELECT * FROM cases WHERE id = ${id} LIMIT 1`;
    const found = rows[0];
    if (!found) throw notFound('案件が見つかりません。');
    if (user.role === 'requester' && found.requester_id !== user.id) {
      throw notFound('案件が見つかりません。');
    }
    if (found.status !== 'awaiting_decision') {
      throw conflict('この案件はすでに次の段階へ進んでいます。');
    }
    if (found.category === 'security' || found.signal === 'red') {
      throw conflict('セキュリティ・急ぎの案件はAIで解決できません。担当者へ引き継いでください。');
    }

    await sql.begin(async (tx) => {
      await tx`
        UPDATE cases SET
          status = 'ai_resolved', current_step = 7, ai_resolved = true,
          signal = 'blue', resolved_at = now(), completed_at = now()
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO case_messages (case_id, author_id, role, kind, content)
        VALUES (${id}, ${user.id}, 'user', 'decision', '「解決した」が選択されました。')
      `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'case.resolve_ai',
        targetType: 'case',
        targetId: id,
        detail: { caseNo: found.case_no },
      });
    });

    const detail = await loadCaseDetail(sql, id, user);
    return { case: detail };
  });

  app.post('/cases/:id/handoff', { preHandler: authenticate }, async (request) => {
    const user = requireUser(request.authUser);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = HandoffSchema.parse(request.body ?? {});
    const sharedFields = Array.from(new Set(['consultation', ...input.sharedFields]));
    if (!sharedFields.includes('consultation')) {
      throw badRequest('相談内容は必ず共有してください。');
    }

    const rows = await sql<any[]>`SELECT * FROM cases WHERE id = ${id} LIMIT 1`;
    const found = rows[0];
    if (!found) throw notFound('案件が見つかりません。');
    if (user.role === 'requester' && found.requester_id !== user.id) {
      throw notFound('案件が見つかりません。');
    }
    if (found.status !== 'awaiting_decision') {
      throw conflict('この案件はすでに引き継ぎ済みか、次の段階へ進んでいます。');
    }
    const existingTicket = await sql<{ id: string }[]>`
      SELECT id FROM tickets WHERE case_id = ${id} LIMIT 1
    `;
    if (existingTicket.length > 0) throw conflict('この案件はすでに引き継ぎ済みです。');

    const pcRows = await sql<any[]>`SELECT * FROM pc_snapshots WHERE case_id = ${id} LIMIT 1`;
    const pcRow = pcRows[0];
    const meta = CATEGORY_META[asCategory(found.category)];
    const pcItems = asJsonArray<{ key: string; value: string }>(pcRow?.items);
    const assetNo = pcItems.find((item) => item.key === 'asset_no')?.value;
    const concerns = asJsonArray<{ label: string; star: boolean }>(pcRow?.concerns);
    const concernText =
      concerns.length > 0
        ? concerns
            .slice(0, 4)
            .map((concern) => `${concern.star ? '★' : '・'}${concern.label}`)
            .join(' / ')
        : 'なし';
    const handoffMemo = [
      `推定分野: ${meta.handoffGroup}`,
      `対象の機器: ${assetNo ?? '未取得'}`,
      `AIの経過: ${found.ai_summary ?? 'なし'}`,
      `気になる点: ${concernText}`,
      `推奨アクション: ${meta.handoffGroup}の担当者が、同意された情報をもとに対応してください。`,
      `共有情報: ${sharedFields.join(', ')}`,
    ].join('\n');
    const sharedPc = Boolean(pcRow) && sharedFields.includes('pc');

    const result = await sql.begin(async (tx) => {
      const incNo = await nextIncNo(tx);
      const ticketRows = await tx<any[]>`
        INSERT INTO tickets (
          case_id, tkt_no, inc_no, status, handoff_memo, shared_fields
        ) VALUES (
          ${id}, ${found.case_no}, ${incNo}, 'queued', ${handoffMemo},
          ${JSON.stringify(sharedFields)}::jsonb
        )
        RETURNING *
      `;
      const ticket = ticketRows[0];

      await tx`
        UPDATE cases SET
          status = 'in_progress',
          current_step = 5,
          signal = ${signalAfterHandoff(found.signal)},
          shared_pc_info = ${sharedPc}
        WHERE id = ${id}
      `;
      if (pcRow) {
        await tx`UPDATE pc_snapshots SET shared = ${sharedPc} WHERE case_id = ${id}`;
      }
      await tx`
        INSERT INTO case_messages (case_id, author_id, role, kind, content, metadata)
        VALUES (
          ${id}, ${user.id}, 'system', 'handoff',
          ${`担当者へ引き継ぎました（${found.case_no} / ${incNo}）。`},
          ${JSON.stringify({ tktNo: found.case_no, incNo, sharedFields })}::jsonb
        )
      `;
      await appendAudit(tx, {
        actorId: user.id,
        action: 'case.handoff',
        targetType: 'case',
        targetId: id,
        detail: { tktNo: found.case_no, incNo, sharedFields },
      });

      const detail = await loadCaseDetail(tx, id, user);
      return {
        case: detail,
        ticket: ticket ? { id: ticket.id, tktNo: ticket.tkt_no, incNo: ticket.inc_no } : null,
      };
    });

    return result;
  });
}
