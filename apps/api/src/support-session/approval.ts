import { createHash } from 'node:crypto';
import { stableStringify } from '../domain/audit.js';

/**
 * 承認ハッシュ（docs/63 §5）。resolve の 12 キーの payload とは別物で、
 * SID・同意・端末実体まで束縛する。保存値を信頼せず、毎回いまの値から組み立て直して比べる。
 */

export interface AssistVerifyDefinition {
  mainCheck: Record<string, unknown>;
  ops: {
    skillId: string;
    skillVersion: string;
    contentHash: string;
    scriptHash: string;
    params: Record<string, unknown>;
    check: Record<string, unknown>;
  }[];
}

export interface AssistApprovalPayload {
  supportSessionId: string;
  caseId: string;
  proposalId: string;
  stepSeq: number;
  requesterEmail: string;
  assigneeEmail: string;
  machineGuid: string;
  sid: string;
  windowsSessionId: number;
  helperId: string;
  folderConsent: {
    id: string;
    version: string;
    root: string;
    segments: readonly string[];
    operation: string;
    expiresAt: string;
  };
  operationConsent: { id: string; version: string; scope: string; expiresAt: string };
  skillId: string;
  skillVersion: string;
  contentHash: string;
  scriptHash: string;
  params: Record<string, unknown>;
  requiredPrivilege: string;
  nonce: string;
  expiresAt: string;
  verify: AssistVerifyDefinition;
}

export function computeAssistApprovalHash(payload: AssistApprovalPayload): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}
