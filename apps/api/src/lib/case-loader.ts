import type { AuthUser } from '../auth/types.js';
import {
  caseSummary,
  knowledgeDto,
  messageDto,
  pcSnapshotDto,
  resolutionDto,
  ticketDto,
} from './serializers.js';

export async function loadCaseDetail(db: any, id: string, user: AuthUser) {
  const rows = await db<any[]>`
    SELECT
      c.*,
      ru.name AS requester_name,
      t.id AS ticket_id, t.tkt_no, t.inc_no, t.assignee_id, t.status AS ticket_status,
      t.handoff_memo, t.shared_fields, t.created_at AS ticket_created_at,
      t.updated_at AS ticket_updated_at,
      au.name AS assignee_name
    FROM cases c
    JOIN users ru ON ru.id = c.requester_id
    LEFT JOIN tickets t ON t.case_id = c.id
    LEFT JOIN users au ON au.id = t.assignee_id
    WHERE c.id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (user.role === 'requester' && row.requester_id !== user.id) return null;

  const messages = await db<any[]>`
    SELECT m.*, u.name AS author_name
    FROM case_messages m
    LEFT JOIN users u ON u.id = m.author_id
    WHERE m.case_id = ${id}
    ORDER BY m.created_at ASC, m.id ASC
  `;

  const pcRows = await db<any[]>`
    SELECT * FROM pc_snapshots WHERE case_id = ${id} LIMIT 1
  `;
  const pcRow = pcRows[0];
  const isOwner = user.id === row.requester_id;
  const pcVisible =
    Boolean(pcRow) &&
    (isOwner || ((user.role === 'helpdesk' || user.role === 'approver') && pcRow.shared === true));

  const resolutionRows = await db<any[]>`
    SELECT r.*, u.name AS author_name
    FROM resolutions r
    LEFT JOIN users u ON u.id = r.author_id
    WHERE r.case_id = ${id}
    ORDER BY r.created_at DESC
    LIMIT 1
  `;

  const knowledgeRows = await db<any[]>`
    SELECT k.*, au.name AS author_name, pu.name AS approver_name
    FROM knowledge k
    LEFT JOIN users au ON au.id = k.author_id
    LEFT JOIN users pu ON pu.id = k.approver_id
    WHERE k.case_id = ${id}
    ORDER BY k.created_at DESC
    LIMIT 1
  `;

  const knowledge = knowledgeRows[0] ? knowledgeDto(knowledgeRows[0]) : null;
  const resolution = resolutionRows[0] ? resolutionDto(resolutionRows[0]) : null;
  const ticket = row.ticket_id
    ? ticketDto({
        ...row,
        id: row.ticket_id,
        case_id: row.id,
        status: row.ticket_status,
        created_at: row.ticket_created_at,
        updated_at: row.ticket_updated_at,
      })
    : null;

  return {
    ...caseSummary(row),
    body: row.body,
    aiSummary: row.ai_summary,
    resolvedAt: row.resolved_at,
    completedAt: row.completed_at,
    requester: { id: row.requester_id, name: row.requester_name },
    ticket,
    resolution,
    knowledge,
    messages: messages.map(messageDto),
    pc: pcRow ? pcSnapshotDto(pcRow, pcVisible) : null,
    permissions: {
      canResolve:
        isOwner &&
        row.status === 'awaiting_decision' &&
        row.signal !== 'red' &&
        row.category !== 'security',
      canHandoff: isOwner && row.status === 'awaiting_decision',
      canAssign: user.role === 'helpdesk',
      canRegisterResolution: user.role === 'helpdesk' && !resolution,
      canDraftKnowledge: user.role === 'helpdesk' && Boolean(resolution) && !knowledge,
      canReviewKnowledge:
        user.role === 'approver' &&
        knowledge?.status === 'pending' &&
        knowledge.authorId !== user.id,
      canViewAudit: user.role === 'approver',
    },
  };
}
