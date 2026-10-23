import type { AuthUser } from '../auth/types.js';
import { CASE_STATUS_LABELS, CATEGORY_META, SIGNAL_LABELS } from '../domain/constants.js';
import type { Category, SignalColor } from '../domain/pc.js';
import { asJsonArray, asJsonObject } from './json.js';

export function userDto(user: AuthUser) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function caseSummary(row: any) {
  const category = row.category as Category;
  return {
    id: row.id,
    caseNo: row.case_no,
    requesterId: row.requester_id,
    requesterName: row.requester_name ?? null,
    category,
    categoryLabel: CATEGORY_META[category]?.label ?? category,
    subject: row.subject,
    urgency: row.urgency,
    signal: row.signal as SignalColor,
    signalLabel: SIGNAL_LABELS[row.signal as SignalColor] ?? row.signal,
    currentStep: row.current_step,
    status: row.status,
    statusLabel: CASE_STATUS_LABELS[row.status as keyof typeof CASE_STATUS_LABELS] ?? row.status,
    aiResolved: row.ai_resolved,
    tktNo: row.tkt_no ?? null,
    incNo: row.inc_no ?? null,
    assigneeId: row.assignee_id ?? null,
    assigneeName: row.assignee_name ?? null,
    sharedPcInfo: row.shared_pc_info,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ticketDto(row: any) {
  return {
    id: row.id,
    caseId: row.case_id,
    tktNo: row.tkt_no,
    incNo: row.inc_no,
    assigneeId: row.assignee_id ?? null,
    assigneeName: row.assignee_name ?? null,
    status: row.status,
    handoffMemo: row.handoff_memo,
    sharedFields: asJsonArray(row.shared_fields),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function messageDto(row: any) {
  return {
    id: row.id,
    caseId: row.case_id,
    authorId: row.author_id ?? null,
    authorName: row.author_name ?? null,
    role: row.role,
    kind: row.kind,
    content: row.content,
    metadata: asJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

export function resolutionDto(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    caseId: row.case_id,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    cause: row.cause,
    steps: row.steps,
    durationMin: row.duration_min,
    createdAt: row.created_at,
  };
}

export function knowledgeDto(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    kbNo: row.kb_no,
    caseId: row.case_id ?? null,
    resolutionId: row.resolution_id ?? null,
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: row.steps,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    status: row.status,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    approverId: row.approver_id ?? null,
    approverName: row.approver_name ?? null,
    version: row.version,
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function pcSnapshotDto(row: any, visible: boolean) {
  if (!row) return null;
  return {
    collectedAt: row.collected_at,
    shared: row.shared,
    visible,
    source: row.source,
    items: visible ? asJsonArray(row.items) : [],
    concerns: visible ? asJsonArray(row.concerns) : [],
    itemCount: asJsonArray(row.items).length,
    concernCount: asJsonArray(row.concerns).length,
  };
}

export function auditDto(row: any) {
  return {
    id: row.id,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: asJsonObject(row.detail),
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
  };
}
