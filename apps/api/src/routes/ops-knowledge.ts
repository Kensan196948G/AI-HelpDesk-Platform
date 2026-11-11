import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { nextKbNo } from '../lib/numbers.js';

/**
 * 運用統合 UI の ⑤ ナレッジ下書き・⑥ 承認・⑦ ナレッジDB・監査ログ（docs/100 P3b）。
 *
 * - 既存の `knowledge` テーブルをそのまま使う（AI の根拠検索も同じ表を読む）。
 * - Access の本人はメールで識別する（旧 UI の author_id はそのまま維持し、両方を許容）。
 * - 承認は **approver ロール** かつ **申請者本人以外**（職務分掌）。サーバが正本。
 */

type KbStatus = 'draft' | 'pending' | 'approved' | 'rejected';

interface KnowledgeRow {
  id: string;
  kb_no: string;
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords: string[] | null;
  status: KbStatus;
  version: number;
  author_email: string | null;
  approver_email: string | null;
  category: string | null;
  source_case_ref: string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const DraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  symptom: z.string().trim().max(4000).default(''),
  cause: z.string().trim().max(4000).default(''),
  steps: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  category: z.string().trim().max(40).default('other'),
  ticketRef: z.string().trim().max(60).optional(),
});

function ms(value: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function stepLines(steps: string): string[] {
  return String(steps || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 画面（⑦ ナレッジDB）が使う形。 */
export function toUiKb(row: KnowledgeRow): Record<string, unknown> {
  const approvedAt = ms(row.approved_at) ?? ms(row.updated_at) ?? Date.now();
  return {
    id: row.kb_no,
    serverId: row.id,
    cat: row.category ?? 'other',
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: stepLines(row.steps),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    version: `${row.version}.0`,
    status: 'active',
    author: row.author_email ?? '-',
    approvedBy: row.approver_email ?? '-',
    approvedAt,
    updatedAt: ms(row.updated_at) ?? approvedAt,
    use: 0,
    helpful: 0,
    notHelpful: 0,
    sources: [],
    history: [],
  };
}

const DRAFT_STATUS: Record<string, string> = {
  draft: 'draft',
  pending: 'review',
  rejected: 'returned',
  approved: 'approved',
};

/** 画面（⑤ 下書き・⑥ 承認）が使う形。 */
export function toUiDraft(row: KnowledgeRow): Record<string, unknown> {
  return {
    id: row.kb_no,
    serverId: row.id,
    title: row.title,
    cat: row.category ?? 'other',
    symptom: row.symptom,
    cause: row.cause,
    steps: stepLines(row.steps),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    status: DRAFT_STATUS[row.status] ?? 'draft',
    applicant: row.author_email ?? '-',
    submittedAt: ms(row.updated_at) ?? Date.now(),
    ticketId: row.source_case_ref ?? '',
    target: null,
    masked: [],
    reviews: [],
    aiReview: null,
    history: [],
  };
}

async function isApprover(roles: readonly string[] | undefined): Promise<boolean> {
  return Array.isArray(roles) && roles.includes('approver');
}

/** `/ops` の初期表示用（⑤⑥⑦）。承認者かどうかで下書きの範囲が変わる。 */
export async function loadKnowledgeForUi(
  email: string,
  approver: boolean,
): Promise<{ drafts: Record<string, unknown>[]; approved: Record<string, unknown>[] }> {
  const drafts = approver
    ? await sql<KnowledgeRow[]>`
        SELECT * FROM knowledge WHERE status IN ('draft', 'pending', 'rejected')
        ORDER BY updated_at DESC LIMIT 100
      `
    : await sql<KnowledgeRow[]>`
        SELECT * FROM knowledge
        WHERE status IN ('draft', 'pending', 'rejected') AND author_email = ${email}
        ORDER BY updated_at DESC LIMIT 100
      `;
  const approved = await sql<KnowledgeRow[]>`
    SELECT * FROM knowledge WHERE status = 'approved'
    ORDER BY approved_at DESC NULLS LAST, updated_at DESC LIMIT 100
  `;
  return { drafts: drafts.map(toUiDraft), approved: approved.map(toUiKb) };
}

/** `/ops` の監査タブ用（直近 50 件）。権限が無ければ空で返す。 */
export async function loadAuditForUi(roles: readonly string[]): Promise<Record<string, unknown>[]> {
  if (!roles.some((role) => ['approver', 'auditor', 'helpdesk'].includes(role))) return [];
  const rows = await sql<
    {
      action: string;
      target_type: string;
      target_id: string;
      detail: Record<string, unknown> | null;
      actor_name: string | null;
      created_at: Date | string;
    }[]
  >`
    SELECT a.action, a.target_type, a.target_id, a.detail, u.name AS actor_name, a.created_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 50
  `;
  return rows.map((row) => {
    const detail = row.detail ?? {};
    const email = typeof detail.email === 'string' ? detail.email : null;
    return {
      t: ms(row.created_at) ?? Date.now(),
      actor: row.actor_name ?? email ?? 'システム',
      action: row.action,
      target: row.target_id,
      detail: typeof detail.note === 'string' ? detail.note : '',
      targetType: row.target_type,
    };
  });
}

export async function opsKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  /** ⑤下書き・⑥承認待ち・⑦承認済みをまとめて返す。 */
  app.get('/ops/knowledge', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const approver = await isApprover(request.uiRoles);
    const data = await loadKnowledgeForUi(request.uiEmail, approver);
    return { ok: true, approver, drafts: data.drafts, approved: data.approved };
  });

  /** ⑤ 下書きの作成（解決記録から作る）。承認待ちとして保存する。 */
  app.post(
    '/ops/knowledge',
    { preHandler: authenticateUi, bodyLimit: 64 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      const input = DraftSchema.parse(request.body ?? {});
      const id = await sql.begin(async (tx) => {
        const kbNo = await nextKbNo(tx);
        const rows = (await tx`
          INSERT INTO knowledge (
            kb_no, title, symptom, cause, steps, keywords, status, version,
            author_id, author_email, category, source_case_ref
          ) VALUES (
            ${kbNo}, ${input.title}, ${input.symptom}, ${input.cause},
            ${input.steps.join('\n')}, ${input.keywords}, 'pending', 1,
            NULL, ${email}, ${input.category}, ${input.ticketRef ?? null}
          )
          RETURNING id
        `) as unknown as { id: string }[];
        const created = rows[0];
        if (!created) throw new Error('knowledge insert failed');
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.knowledge.draft',
          targetType: 'knowledge',
          targetId: kbNo,
          detail: { email, category: input.category, ticket: input.ticketRef ?? null },
        });
        return created.id;
      });
      const rows = await sql<KnowledgeRow[]>`SELECT * FROM knowledge WHERE id = ${id} LIMIT 1`;
      const row = rows[0];
      if (!row) throw notFound('下書きが見つかりません。');
      return { ok: true, draft: toUiDraft(row) };
    },
  );

  /** ⑥ 承認（approver のみ・申請者本人は不可）。 */
  app.post(
    '/ops/knowledge/:id/approve',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const email = request.uiEmail;
      if (!(await isApprover(request.uiRoles))) {
        throw forbidden('この操作は承認者のみ実行できます。');
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const rows = await sql<KnowledgeRow[]>`SELECT * FROM knowledge WHERE id = ${id} LIMIT 1`;
      const row = rows[0];
      if (!row) throw notFound('ナレッジが見つかりません。');
      if (row.status !== 'pending' && row.status !== 'draft') {
        throw conflict('承認待ちのナレッジではありません。');
      }
      if (row.author_email && row.author_email === email) {
        throw forbidden('自分が作成した下書きは承認できません（職務分掌）。');
      }
      await sql.begin(async (tx) => {
        await tx`
          UPDATE knowledge
          SET status = 'approved',
              approver_email = ${email},
              approved_at = now(),
              updated_at = now()
          WHERE id = ${row.id}
        `;
        await appendAudit(tx, {
          actorId: null,
          action: 'ops.knowledge.approve',
          targetType: 'knowledge',
          targetId: row.kb_no,
          detail: { email, author: row.author_email ?? null },
        });
      });
      const after = await sql<KnowledgeRow[]>`SELECT * FROM knowledge WHERE id = ${row.id} LIMIT 1`;
      const updated = after[0];
      if (!updated) throw notFound('ナレッジが見つかりません。');
      return { ok: true, kb: toUiKb(updated) };
    },
  );

  /** 監査ログ（直近 50 件）。担当者・承認者・監査担当のみ。 */
  app.get('/ops/audit', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const roles = request.uiRoles ?? [];
    if (!roles.some((role) => ['approver', 'auditor', 'helpdesk'].includes(role))) {
      throw forbidden('この操作は担当者・承認者・監査担当のみ実行できます。');
    }
    const rows = await sql<
      {
        action: string;
        target_type: string;
        target_id: string;
        detail: Record<string, unknown> | null;
        actor_name: string | null;
        created_at: Date | string;
      }[]
    >`
      SELECT a.action, a.target_type, a.target_id, a.detail, u.name AS actor_name, a.created_at
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 50
    `;
    return {
      ok: true,
      items: rows.map((row) => {
        const detail = row.detail ?? {};
        const email = typeof detail.email === 'string' ? detail.email : null;
        return {
          t: ms(row.created_at) ?? Date.now(),
          actor: row.actor_name ?? email ?? 'システム',
          action: row.action,
          target: row.target_id,
          detail: typeof detail.note === 'string' ? detail.note : '',
          targetType: row.target_type,
        };
      }),
    };
  });
}
