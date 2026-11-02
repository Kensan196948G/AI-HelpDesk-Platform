import { sameHuman } from '../auth/shared-identity.js';
import { type FinalReport, FinalReportSchema } from '../domain/final-report.js';
import { redactKnowledgeKeywords, redactKnowledgeText, redactPII } from '../domain/pii.js';
import { type CaseSnapshot, normalizeState } from '../lib/case-handover.js';
import type { HandoverRow } from '../routes/case-handovers.js';
import type { OutputSource, TerminalSessionRow, TerminalStepRow } from './session.js';

/** 画面のカテゴリ（プロトタイプの CATS）→ 表示・報告書の表記。 */
export const CATEGORY_LABEL: Record<string, string> = {
  account: 'アカウント・認証',
  mail: 'メール・Teams',
  network: 'ネットワーク・VPN',
  device: 'PC・周辺機器',
  file: 'ファイル共有・業務アプリ',
  security: 'セキュリティ',
  other: 'その他',
};

function text(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clipped(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…（切り詰め）` : value;
}

interface PcSnapshot {
  at?: string;
  device?: string;
  items?: Array<{
    grp?: string;
    k?: string;
    v?: string;
    lv?: string;
    note?: string;
    rel?: boolean;
  }>;
}

function pcSnapshotOf(snapshot: CaseSnapshot | null): PcSnapshot | null {
  const pc = record(snapshot?.case?.pc);
  const snap = record(pc?.snap);
  if (!snap || !Array.isArray(snap.items)) return null;
  return snap as PcSnapshot;
}

function chatMessages(snapshot: CaseSnapshot | null): Array<Record<string, unknown>> {
  const messages = snapshot?.chat?.messages;
  return Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
}

function handoverMemo(snapshot: CaseSnapshot | null): string {
  const inc = record(snapshot?.inc);
  const handover = record(inc?.handover);
  const summary = text(handover?.summary, 8000);
  if (summary) return summary;
  const caseReason = text(snapshot?.case?.reason, 1000);
  return caseReason ? `引継ぎ理由: ${caseReason}` : '';
}

export interface TerminalReportInput {
  handover: HandoverRow;
  session: TerminalSessionRow;
  steps: TerminalStepRow[];
  operatorName: string;
  requesterName: string;
  knowledge: {
    id: string;
    kbNo: string;
    title: string;
    status: string;
    version: number;
  } | null;
}

export interface TerminalReportResult {
  report: FinalReport;
  /** 報告書に反映できなかった点（UI とログで明示する）。 */
  warnings: string[];
}

/**
 * RSP 実行セッションから最終報告書（FinalReport）を組み立てる。
 *
 * - 画面が送るのではなく、サーバが DB と引継ぎスナップショットから作る（改竄余地を減らす）。
 * - AI の提案と、担当者が実際に実行したコマンド・出力を分けて載せる。
 * - 記録できなかったステップは `terminal.unrecorded` に列挙する（黙って落とさない）。
 */
export function buildTerminalReport(input: TerminalReportInput): TerminalReportResult {
  const { handover, session, steps, operatorName, requesterName, knowledge } = input;
  const snapshot = normalizeState(handover.snapshot) as CaseSnapshot | null;
  const warnings: string[] = [];
  if (!snapshot) warnings.push('引継ぎスナップショットが読めませんでした。案件情報は最小限です。');

  const caseRecord = record(snapshot?.case) ?? {};
  const pcSnap = pcSnapshotOf(snapshot);
  const memo = handoverMemo(snapshot);
  const started = new Date(session.started_at);
  const closed = session.closed_at ? new Date(session.closed_at) : null;
  const minutes = closed
    ? Math.max(0, Math.round((closed.getTime() - started.getTime()) / 60_000))
    : 0;

  const caseId = text(handover.case_id, 40) || text(session.case_id, 40);
  const subject = text(caseRecord.subject, 500) || '（件名なし）';
  const body = text(caseRecord.body, 12_000);
  const category = text(caseRecord.cat, 40);
  const urgencyRaw = text(caseRecord.urgency, 30);
  const urgency =
    urgencyRaw === 'urgent' ? '急ぎ' : urgencyRaw === 'normal' ? '通常' : urgencyRaw || '通常';

  const recordedSteps = steps.filter((step) => step.recorded_at);
  const unrecorded = steps
    .filter((step) => !step.recorded_at)
    .map((step) => `ステップ${step.seq}「${text(step.intent, 200)}」の実行結果が未記録`);

  const pc = pcSnap
    ? {
        available: true,
        device: text(pcSnap.device, 120) || session.device,
        collectedAt: text(pcSnap.at, 40) || undefined,
        itemCount: pcSnap.items?.length ?? 0,
        shared: true,
        flags: (pcSnap.items ?? [])
          .filter((item) => item.lv && item.lv !== 'ok')
          .slice(0, 100)
          .map((item) => ({
            grp: text(item.grp, 60),
            k: text(item.k, 120),
            v: text(item.v, 500),
            lv: (item.lv === 'warn' || item.lv === 'ng' ? item.lv : 'ok') as 'ok' | 'warn' | 'ng',
            note: text(item.note, 500) || undefined,
            rel: Boolean(item.rel),
          })),
        items: (pcSnap.items ?? []).slice(0, 500).map((item) => ({
          grp: text(item.grp, 60),
          k: text(item.k, 120),
          v: text(item.v, 500),
          lv: (item.lv === 'warn' || item.lv === 'ng' ? item.lv : 'ok') as 'ok' | 'warn' | 'ng',
          note: text(item.note, 500) || undefined,
          rel: Boolean(item.rel),
        })),
      }
    : null;
  if (!pc) warnings.push('PC基本情報がスナップショットにありません。');

  const messages = chatMessages(snapshot)
    .slice(-200)
    .map((message) => ({
      at: text(message.at, 40) || undefined,
      role: (message.role === 'user' ? 'user' : 'ai') as 'user' | 'ai',
      who: text(message.who, 120) || undefined,
      kind: text(message.kind, 40) || undefined,
      text: text(message.text, 12_000),
      steps: [],
    }))
    .filter((message) => message.text.length > 0);

  const lastRecorded = recordedSteps.at(-1);
  const cause =
    text(lastRecorded?.note, 4000) ||
    text(lastRecorded?.ai_purpose, 4000) ||
    '（原因は記録されていません）';

  const timeline: Array<{ at?: string; actor?: string; action: string; detail?: string }> = [
    {
      at: new Date(session.started_at).toISOString(),
      actor: operatorName,
      action: 'RSP実行セッションを開始',
      detail: `対象端末 ${session.device}`,
    },
  ];
  for (const step of steps) {
    timeline.push({
      at: new Date(step.proposed_at).toISOString(),
      actor: 'AI',
      action: `ステップ${step.seq}の提案`,
      detail: text(step.ai_command, 2000),
    });
    if (step.recorded_at) {
      timeline.push({
        at: new Date(step.recorded_at).toISOString(),
        actor: operatorName,
        action: `ステップ${step.seq}を実行・記録（${step.exit_status ?? 'unknown'}）`,
        detail: text(step.executed_command, 2000),
      });
    }
  }
  if (session.closed_at) {
    timeline.push({
      at: new Date(session.closed_at).toISOString(),
      actor: operatorName,
      action: `セッションを終了（${session.close_reason ?? 'unknown'}）`,
      detail: text(session.close_note, 2000),
    });
  }

  const payload = {
    reportVersion: 1 as const,
    // SM-12: 中止・エスカレーションで終えたセッションを「解決」報告書にしない。
    // 解決（resolved）だけを helpdesk_resolved とし、それ以外は未解決として扱う。
    kind: (session.close_reason === 'resolved' ? 'helpdesk_resolved' : 'helpdesk_stopped') as
      | 'helpdesk_resolved'
      | 'helpdesk_stopped',
    generatedAt: new Date().toISOString(),
    generatedBy: {
      name: text(operatorName, 120) || session.operator_email,
      role: 'ヘルプデスク',
    },
    requester: {
      name: text(requesterName, 120) || text(handover.owner_email, 120),
    },
    case: {
      id: caseId,
      created: text(caseRecord.createdAt, 40) || new Date(session.started_at).toISOString(),
      kindLabel: CATEGORY_LABEL[category] ?? 'その他',
      subject,
      body,
      urgency,
      model: session.ai_model ?? undefined,
      step: 5,
    },
    pc,
    ai: {
      provider: 'deepseek',
      model: session.ai_model ?? undefined,
      messages,
      diagnoses: [],
      proposals: [],
      sources: [],
    },
    handover: {
      reason: text(caseRecord.reason, 1000) || undefined,
      ticketId: text(record(snapshot?.ticket)?.id, 40) || undefined,
      incId: text(record(snapshot?.inc)?.id, 40) || undefined,
      assignee: operatorName,
      shared: [],
      memo: memo || undefined,
      at: new Date(session.started_at).toISOString(),
      approvedBy: handover.approved_by ?? undefined,
      approvedAt: handover.approved_at ? new Date(handover.approved_at).toISOString() : undefined,
      selfApproved: handover.self_approved,
      sharedIdentity: handover.approved_by
        ? sameHuman(handover.approved_by, handover.claimed_by)
        : false,
    },
    resolution: {
      cause,
      steps: recordedSteps.map(
        (step) =>
          `ステップ${step.seq}: ${text(step.executed_command, 4000)}（${step.exit_status ?? 'unknown'}）`,
      ),
      minutes,
      note: text(session.close_note, 4000) || undefined,
      by: operatorName,
      at: session.closed_at ? new Date(session.closed_at).toISOString() : undefined,
    },
    knowledge: knowledge
      ? {
          draftId: knowledge.id,
          status: knowledge.status,
          kbId: knowledge.kbNo,
          title: knowledge.title,
          version: String(knowledge.version),
        }
      : null,
    remote: null,
    terminal: {
      sessionId: session.id,
      device: session.device,
      operator: operatorName,
      requester: requesterName,
      startedAt: new Date(session.started_at).toISOString(),
      closedAt: session.closed_at ? new Date(session.closed_at).toISOString() : undefined,
      closeReason: (session.close_reason ?? undefined) as
        | 'resolved'
        | 'stopped'
        | 'escalated'
        | 'expired'
        | undefined,
      captureSupported: recordedSteps.some((step) => step.output_source === 'auto'),
      // RSP の remote_session との相互参照（Phase 2・未相関なら undefined）。
      rspSessionId: session.rsp_session_id ?? undefined,
      steps: steps.map((step) => ({
        seq: step.seq,
        at: new Date(step.recorded_at ?? step.proposed_at).toISOString(),
        intent: text(step.intent, 500) || undefined,
        proposal: {
          command: text(step.ai_command, 8000),
          purpose: text(step.ai_purpose, 2000) || undefined,
          risk: (step.ai_risk ?? 'medium') as 'low' | 'medium' | 'high',
          verify: text(step.ai_verify, 2000) || undefined,
          rollback: text(step.ai_rollback, 2000) || undefined,
          warnings: Array.isArray(step.ai_warnings)
            ? step.ai_warnings
                .map((warning) => text(warning, 500))
                .filter(Boolean)
                .slice(0, 10)
            : [],
        },
        executed: step.recorded_at
          ? {
              command: text(step.executed_command, 8000),
              output: text(step.output, 20_000),
              outputSource: (step.output_source ?? 'manual') as OutputSource,
              exitStatus: (step.exit_status ?? 'unknown') as 'success' | 'failure' | 'unknown',
              note: text(step.note, 1000) || undefined,
              sha256: text(step.sha256, 64) || undefined,
              // RSP のコマンドキュー由来のときだけ載せる（未相関なら undefined）。
              rspCommandLogId: step.rsp_command_log_id ?? undefined,
            }
          : null,
      })),
      unrecorded,
    },
    timeline: timeline.slice(0, 300),
  };

  const parsed = FinalReportSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(' / ');
    throw new Error(`報告書データが不正です: ${issues}`);
  }
  return { report: parsed.data, warnings };
}

export interface KnowledgeDraftInput {
  handover: HandoverRow;
  session: TerminalSessionRow;
  steps: TerminalStepRow[];
  title?: string;
  cause?: string;
}

export interface KnowledgeDraftContent {
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords: string[];
}

/**
 * 実行記録からナレッジ下書きの本文を作る。
 *
 * 自動公開はしない（呼び出し側が status='draft' で保存する）。実行したコマンドと
 * 結果だけを載せ、推測した原因は書かない（担当者の補足があればそれを使う）。
 */
export function buildKnowledgeDraft(input: KnowledgeDraftInput): KnowledgeDraftContent {
  const snapshot = normalizeState(input.handover.snapshot) as CaseSnapshot | null;
  const caseRecord = record(snapshot?.case) ?? {};
  const subject = text(caseRecord.subject, 160) || text(input.handover.case_id, 160);
  const title = redactKnowledgeText(
    text(input.title, 160) || (subject.includes('手順') ? subject : `${subject}の確認手順`),
  ).text;
  const symptom = redactKnowledgeText(text(caseRecord.body, 4000)).text;

  const recorded = input.steps.filter((step) => step.recorded_at);
  const last = recorded.at(-1);
  const cause = redactKnowledgeText(
    text(input.cause, 4000) ||
      text(last?.note, 4000) ||
      '（原因は記録されていません。担当者の補足を追記してください）',
  ).text;

  const lines = recorded.map((step) => {
    const output = text(step.output, 600).replace(/\r?\n/g, ' / ');
    return [
      `${step.seq}. ${text(step.executed_command, 2000)}`,
      `   結果: ${step.exit_status ?? 'unknown'}`,
      output ? `   出力: ${output}` : '   出力: （未記録）',
      step.ai_verify ? `   確認: ${text(step.ai_verify, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  const steps = redactKnowledgeText(clipped(lines.join('\n'), 8000)).text;

  const category = text(caseRecord.cat, 40);
  const keywords = redactKnowledgeKeywords(
    Array.from(
      new Set(
        [CATEGORY_LABEL[category], subject, ...recorded.map((step) => text(step.intent, 40))]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim()),
      ),
    ),
  )
    .slice(0, 12)
    .map((value) => value.slice(0, 40).trim());

  // 承認は ui-sync の上限と本文照合を通る。伏せ字で長さが変わるので最後に切り、前後の空白を落とす。
  return {
    title: title.slice(0, 160).trim(),
    symptom: symptom.slice(0, 4000).trim(),
    cause: cause.slice(0, 4000).trim(),
    steps: steps.slice(0, 8000).trim(),
    keywords,
  };
}
