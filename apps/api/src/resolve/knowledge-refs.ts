import { sql } from '../db.js';
import { detectIntent } from '../domain/ai.js';
import { type ApprovalOrigin, approvalOriginLabel } from '../domain/approval-origin.js';
import { redactPII } from '../domain/pii.js';
import { findApprovedKnowledge } from '../lib/knowledge-search.js';

/** 解決ループの提案へ渡す、承認済み KB の参照。本文全体は渡さない。 */
export interface KnowledgeRef {
  kbNo: string;
  version: number;
  title: string;
  stepsSummary: string;
  /** 承認の出所（docs/64 §9）。 */
  approvalOrigin?: ApprovalOrigin;
  approvalOriginLabel: string;
}

/** ステップに保存する参照。used は AI が使ったと答えたものだけ（照合しただけなら空）。 */
export interface StepKnowledgeRefs {
  matched: KnowledgeRef[];
  used: string[];
}

const TITLE_LIMIT = 160;
const STEPS_SUMMARY_LIMIT = 300;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 相談文に一致する承認済み KB の参照。判定は /api/ai/answer と同じ findApprovedKnowledge
 * （DB、別人の承認、承認後の更新なし）で、state の KB は読まない。件数と一致点の下限も同じ。
 * 検索に失敗しても提案は止めない。
 */
export async function knowledgeRefsForCase(text: string): Promise<KnowledgeRef[]> {
  const redacted = redactPII(text).text;
  const intent = detectIntent('', redacted);
  try {
    const rows = await findApprovedKnowledge(sql, redacted, intent.keywords);
    return rows.map((row) => ({
      kbNo: row.kbNo,
      version: row.version ?? 1,
      title: clip(row.title, TITLE_LIMIT),
      stepsSummary: clip(row.steps.replace(/\s*\n\s*/g, ' / '), STEPS_SUMMARY_LIMIT),
      approvalOrigin: row.approvalOrigin,
      approvalOriginLabel: approvalOriginLabel(row.approvalOrigin),
    }));
  } catch {
    return [];
  }
}
