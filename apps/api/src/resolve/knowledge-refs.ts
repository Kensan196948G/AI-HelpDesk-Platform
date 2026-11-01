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

export interface KnowledgeGuideItem {
  kbNo: string;
  version: number;
  title: string;
  steps: string[];
  approvalOriginLabel: string;
}

const GUIDE_ITEM_LIMIT = 3;
const GUIDE_STEP_LIMIT = 8;
const GUIDE_STEP_CHARS = 200;

/**
 * 端末エージェントが無い相談者へ見せる案内（docs/14 §2-16）。外部 AI へ送らない。
 * 判定は /api/ai/answer と同じ findApprovedKnowledge で、本文は伏せた後の値。端末は操作しない。
 */
export async function knowledgeGuideForCase(text: string): Promise<KnowledgeGuideItem[]> {
  const redacted = redactPII(text).text;
  const intent = detectIntent('', redacted);
  const rows = await findApprovedKnowledge(sql, redacted, intent.keywords);
  return rows.slice(0, GUIDE_ITEM_LIMIT).map((row) => ({
    kbNo: row.kbNo,
    version: row.version ?? 1,
    title: clip(row.title, TITLE_LIMIT),
    steps: row.steps
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, GUIDE_STEP_LIMIT)
      .map((line) => clip(line, GUIDE_STEP_CHARS)),
    approvalOriginLabel: approvalOriginLabel(row.approvalOrigin),
  }));
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
