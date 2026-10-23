import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/session.js';
import { sql } from '../db.js';
import { caseSummary } from '../lib/serializers.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', { preHandler: authenticate }, async (request) => {
    const user = request.authUser!;
    const isRequester = user.role === 'requester';

    const countRows = await sql<any[]>`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('awaiting_decision', 'handoff_pending'))::int
          AS awaiting_decision,
        count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE status = 'knowledge_pending')::int AS knowledge_pending,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'ai_resolved')::int AS ai_resolved,
        count(*) FILTER (WHERE ai_resolved = true)::int AS ai_resolved_total,
        count(*) FILTER (WHERE signal = 'blue')::int AS blue,
        count(*) FILTER (WHERE signal = 'amber')::int AS amber,
        count(*) FILTER (WHERE signal = 'red')::int AS red
      FROM cases
      WHERE (${isRequester} = false OR requester_id = ${user.id})
    `;
    const counts = countRows[0] ?? {};
    const total = Number(counts.total ?? 0);
    const aiResolvedTotal = Number(counts.ai_resolved_total ?? 0);

    const recentRows = await sql<any[]>`
      SELECT
        c.*, ru.name AS requester_name,
        t.tkt_no, t.inc_no, t.assignee_id, t.status AS ticket_status,
        au.name AS assignee_name
      FROM cases c
      JOIN users ru ON ru.id = c.requester_id
      LEFT JOIN tickets t ON t.case_id = c.id
      LEFT JOIN users au ON au.id = t.assignee_id
      WHERE (${isRequester} = false OR c.requester_id = ${user.id})
      ORDER BY c.updated_at DESC
      LIMIT 5
    `;

    let myQueueCount = 0;
    let pendingKnowledge = 0;
    if (user.role === 'helpdesk') {
      const queueRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM tickets t
        JOIN cases c ON c.id = t.case_id
        WHERE t.status IN ('queued', 'assigned', 'in_progress')
          AND (t.assignee_id = ${user.id} OR t.assignee_id IS NULL)
      `;
      myQueueCount = Number(queueRows[0]?.count ?? 0);
    }
    if (user.role === 'approver' || user.role === 'helpdesk') {
      const kbRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM knowledge WHERE status = 'pending'
      `;
      pendingKnowledge = Number(kbRows[0]?.count ?? 0);
    }

    return {
      role: user.role,
      counts: {
        total,
        awaitingDecision: Number(counts.awaiting_decision ?? 0),
        inProgress: Number(counts.in_progress ?? 0),
        knowledgePending: Number(counts.knowledge_pending ?? 0),
        completed: Number(counts.completed ?? 0),
        aiResolved: Number(counts.ai_resolved ?? 0),
        aiResolvedRate: total > 0 ? Math.round((aiResolvedTotal / total) * 100) : 0,
      },
      signalCounts: {
        blue: Number(counts.blue ?? 0),
        amber: Number(counts.amber ?? 0),
        red: Number(counts.red ?? 0),
      },
      myQueueCount,
      pendingKnowledge,
      recentCases: recentRows.map(caseSummary),
    };
  });
}
