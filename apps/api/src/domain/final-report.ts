import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from '../config.js';
import { redactPII } from './pii.js';

/**
 * 最終報告書（Standalone HTML / PDF）。
 *
 * - 画面（プロトタイプ）が組み立てた構造化データだけを受け取り、サーバー側で HTML を生成する。
 * - 自由記述は保存・出力の前に伏せ字化する（メール・電話・IP・カード・資産番号など）。
 * - PC 基本情報の IP / シリアル / 資産番号は、項目名で判定して必ず伏せる。
 * - HTML は外部 CSS / JS / 画像を参照しない（単体で開ける）。
 * - PDF はヘッドレス Chrome の印刷機能で生成する（日本語フォントは OS のもの）。
 */

const Text = (max: number) => z.string().max(max);
const Iso = z.string().trim().min(4).max(40);

export const FINAL_REPORT_KINDS = ['ai_resolved', 'helpdesk_resolved'] as const;
export type FinalReportKind = (typeof FINAL_REPORT_KINDS)[number];

const PersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).optional(),
  dept: z.string().trim().max(160).optional(),
  employeeNo: z.string().trim().max(40).optional(),
});

const PcItemSchema = z.object({
  grp: z.string().max(60),
  k: z.string().max(120),
  v: z.string().max(500),
  lv: z.enum(['ok', 'warn', 'ng']).default('ok'),
  note: z.string().max(500).optional(),
  rel: z.boolean().optional(),
});

const MessageSchema = z.object({
  at: Iso.optional(),
  role: z.enum(['user', 'ai', 'system']).default('ai'),
  who: z.string().max(120).optional(),
  kind: z.string().max(40).optional(),
  text: Text(12000).default(''),
  steps: z.array(Text(1000)).max(50).default([]),
  title: z.string().max(300).optional(),
  kbId: z.string().max(60).optional(),
  score: z.number().min(0).max(1).optional(),
});

const DiagnosisSchema = z.object({
  title: z.string().max(300),
  rows: z
    .array(
      z.object({
        k: z.string().max(120),
        v: z.string().max(500),
        lv: z.enum(['ok', 'warn', 'ng']).default('ok'),
      }),
    )
    .max(50)
    .default([]),
});

const ProposalSchema = z.object({
  opId: z.string().max(60),
  name: z.string().max(200),
  level: z.number().int().min(1).max(5).optional(),
  impact: z.string().max(1000).optional(),
  rollback: z.string().max(1000).optional(),
  status: z.string().max(40).optional(),
  executedAt: Iso.optional(),
  result: z.string().max(2000).optional(),
});

const SourceSchema = z.object({
  id: z.string().max(60),
  kbNo: z.string().max(60),
  title: z.string().max(300),
});

const HandoverSchema = z.object({
  reason: z.string().max(1000).optional(),
  ticketId: z.string().max(40).optional(),
  incId: z.string().max(40).optional(),
  assignee: z.string().max(120).optional(),
  shared: z.array(z.string().max(120)).max(50).default([]),
  memo: z.string().max(20000).optional(),
  at: Iso.optional(),
});

const ResolutionSchema = z.object({
  cause: z.string().max(4000).optional(),
  steps: z.array(z.string().max(4000)).max(100).default([]),
  minutes: z.number().int().min(0).max(100000).optional(),
  note: z.string().max(4000).optional(),
  by: z.string().max(120).optional(),
  at: Iso.optional(),
});

const KnowledgeSchema = z.object({
  draftId: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  kbId: z.string().max(40).optional(),
  title: z.string().max(300).optional(),
  version: z.string().max(40).optional(),
  approvedBy: z.string().max(120).optional(),
});

const RemotePromptSchema = z.object({
  at: Iso.optional(),
  by: z.string().max(120).optional(),
  text: z.string().max(4000),
  status: z.enum(['sent', 'done', 'failed', 'cancelled']).default('sent'),
  doneAt: Iso.optional(),
});

const RemoteSchema = z.object({
  status: z.enum(['requested', 'approved', 'denied', 'ended', 'expired']),
  requestedBy: z.string().max(120).optional(),
  requestedAt: Iso.optional(),
  approvedBy: z.string().max(120).optional(),
  approvedAt: Iso.optional(),
  endedAt: Iso.optional(),
  expiresAt: Iso.optional(),
  scope: z.string().max(200).optional(),
  prompts: z.array(RemotePromptSchema).max(100).default([]),
});

const TerminalProposalSchema = z.object({
  command: z.string().max(8000),
  purpose: z.string().max(2000).optional(),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  verify: z.string().max(2000).optional(),
  rollback: z.string().max(2000).optional(),
  warnings: z.array(z.string().max(500)).max(10).default([]),
});

const TerminalExecutedSchema = z.object({
  command: z.string().max(8000),
  output: z.string().max(20000).default(''),
  outputSource: z.enum(['auto', 'manual']),
  exitStatus: z.enum(['success', 'failure', 'unknown']),
  note: z.string().max(1000).optional(),
  sha256: z.string().max(64).optional(),
});

const TerminalStepSchema = z.object({
  seq: z.number().int().min(1).max(20),
  at: Iso.optional(),
  intent: z.string().max(500).optional(),
  proposal: TerminalProposalSchema,
  executed: TerminalExecutedSchema.nullable().optional(),
});

const TerminalSchema = z.object({
  sessionId: z.string().max(40),
  device: z.string().max(120),
  operator: z.string().max(120).optional(),
  requester: z.string().max(120).optional(),
  startedAt: Iso,
  closedAt: Iso.optional(),
  closeReason: z.enum(['resolved', 'stopped', 'escalated', 'expired']).optional(),
  captureSupported: z.boolean().default(false),
  steps: z.array(TerminalStepSchema).max(20).default([]),
  unrecorded: z.array(z.string().max(300)).max(20).default([]),
});

const TimelineSchema = z.object({
  at: Iso.optional(),
  actor: z.string().max(120).optional(),
  action: z.string().max(300),
  detail: z.string().max(2000).optional(),
});

function isValidDateTime(value: string | undefined): boolean {
  if (!value) return true;
  return !Number.isNaN(Date.parse(value.replace(' ', 'T')));
}

function addDateIssue(
  ctx: z.RefinementCtx,
  value: string | undefined,
  path: (string | number)[],
): void {
  if (value && !isValidDateTime(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: '日時が不正です。' });
  }
}

export const FinalReportSchema = z
  .object({
    reportVersion: z.literal(1).default(1),
    kind: z.enum(FINAL_REPORT_KINDS),
    generatedAt: Iso,
    generatedBy: PersonSchema,
    requester: PersonSchema,
    case: z.object({
      id: z.string().trim().min(1).max(40),
      created: Iso,
      kindLabel: z.string().trim().max(120),
      subject: z.string().trim().max(500),
      body: z.string().max(12000),
      urgency: z.string().trim().max(30),
      model: z.string().trim().max(120).optional(),
      step: z.number().int().min(1).max(7).optional(),
    }),
    pc: z
      .object({
        available: z.boolean(),
        device: z.string().max(120).optional(),
        collectedAt: Iso.optional(),
        itemCount: z.number().int().min(0).max(500).optional(),
        shared: z.boolean().optional(),
        flags: z.array(PcItemSchema).max(100).default([]),
        items: z.array(PcItemSchema).max(500).default([]),
      })
      .nullable()
      .optional(),
    ai: z
      .object({
        provider: z.string().max(40).optional(),
        model: z.string().max(120).optional(),
        messages: z.array(MessageSchema).max(200).default([]),
        diagnoses: z.array(DiagnosisSchema).max(50).default([]),
        proposals: z.array(ProposalSchema).max(50).default([]),
        sources: z.array(SourceSchema).max(50).default([]),
      })
      .default({ messages: [], diagnoses: [], proposals: [], sources: [] }),
    handover: HandoverSchema.nullable().optional(),
    resolution: ResolutionSchema.nullable().optional(),
    knowledge: KnowledgeSchema.nullable().optional(),
    remote: RemoteSchema.nullable().optional(),
    terminal: TerminalSchema.nullable().optional(),
    timeline: z.array(TimelineSchema).max(300).default([]),
  })
  .superRefine((report, ctx) => {
    addDateIssue(ctx, report.generatedAt, ['generatedAt']);
    addDateIssue(ctx, report.case.created, ['case', 'created']);
    addDateIssue(ctx, report.pc?.collectedAt, ['pc', 'collectedAt']);
    addDateIssue(ctx, report.handover?.at, ['handover', 'at']);
    addDateIssue(ctx, report.resolution?.at, ['resolution', 'at']);
    report.timeline.forEach((item, index) => {
      addDateIssue(ctx, item.at, ['timeline', index, 'at']);
    });

    // 完了経路と STEP の整合（AI解決は STEP 7、担当者解決は STEP 5〜7）。
    if (report.kind === 'ai_resolved' && report.case.step !== undefined && report.case.step !== 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['case', 'step'],
        message: 'AI解決の報告書は STEP 7 で作成してください。',
      });
    }
    if (
      report.kind === 'helpdesk_resolved' &&
      report.case.step !== undefined &&
      ![5, 6, 7].includes(report.case.step)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['case', 'step'],
        message: '担当者解決の報告書は STEP 5〜7 で作成してください。',
      });
    }

    if (report.remote) {
      const remote = report.remote;
      if ((remote.status === 'requested' || remote.status === 'approved') && !remote.requestedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remote', 'requestedAt'],
          message: '遠隔支援の依頼日時が必要です。',
        });
      }
      if (remote.status === 'approved' && !remote.approvedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remote', 'approvedAt'],
          message: '遠隔支援の承認日時が必要です。',
        });
      }
      if (remote.status === 'approved' && !remote.expiresAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remote', 'expiresAt'],
          message: '遠隔支援の期限が必要です。',
        });
      }
      if (['denied', 'ended', 'expired'].includes(remote.status) && !remote.endedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remote', 'endedAt'],
          message: '遠隔支援の終了日時が必要です。',
        });
      }
      remote.prompts.forEach((prompt, index) => {
        if ((prompt.status === 'done' || prompt.status === 'failed') && !prompt.doneAt) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remote', 'prompts', index, 'doneAt'],
            message: '案内の実施日時が必要です。',
          });
        }
      });
    }
  });

export type FinalReport = z.infer<typeof FinalReportSchema>;

export interface RenderedReport {
  html: string;
  filename: string;
}

const KIND_LABEL: Record<FinalReportKind, string> = {
  ai_resolved: 'AIの一次対応で解決',
  helpdesk_resolved: '担当者の対応で解決',
};

const PF = {
  ok: ['正常', '#1d7a4d'],
  warn: ['注意', '#a36400'],
  ng: ['異常', '#b42318'],
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 自由記述の伏せ字化。長すぎる値は切り詰めて HTML を肥大化させない。 */
function safeText(value: string | undefined, max = 12000): string {
  if (!value) return '';
  return escapeHtml(redactPII(value.slice(0, max)).text);
}

function safeInline(value: string | undefined, max = 300): string {
  return safeText(value, max).replace(/\r?\n/g, ' ');
}

/** PC 基本情報の値。項目名で機微な値を判定し、必ず伏せる（伏せ字化のみ）。 */
export function maskPcValue(key: string, value: string): string {
  if (/ipアドレス|ip address/i.test(key)) return '[IPアドレス]';
  if (/シリアル|serial/i.test(key)) return '[シリアル番号]';
  if (/資産番号|asset/i.test(key)) return '[資産番号]';
  return redactPII(value.slice(0, 500)).text;
}

/** PC 基本情報の値（HTML 用）。 */
function safePcValue(key: string, value: string): string {
  return escapeHtml(maskPcValue(key, value));
}

/**
 * 保存・出力の前に、自由記述と PC 情報を伏せ字化したレポートを返す。
 * - 保存する payload・SHA-256・HTML を同じ内容に揃える（後から再生成しても一致する）。
 * - 氏名・部署・社員番号は、報告書の名宛てとして残す。
 */
/** すべての文字列に伏せ字を適用する（氏名は残し、連絡先・識別子は消す）。 */
function maskAllStrings<T>(value: T): T {
  if (typeof value === 'string') return redactPII(value).text as T;
  if (Array.isArray(value)) return value.map((item) => maskAllStrings(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskAllStrings(item);
    return out as T;
  }
  return value;
}

/**
 * 保存・出力の前に、すべての文字列と PC 情報を伏せ字化したレポートを返す。
 * - 自由記述だけでなく、role / dept / device / approvedBy などの構造化フィールドも対象にする。
 * - PC の IP / シリアル / 資産番号は項目名でも強制マスクする。
 * - 保存する payload・SHA-256・HTML を同じ内容に揃える（後から再生成しても一致する）。
 */
export function maskFinalReport(report: FinalReport): FinalReport {
  const masked = maskAllStrings(report);
  if (!masked.pc) return masked;
  const maskItem = (item: z.infer<typeof PcItemSchema>): z.infer<typeof PcItemSchema> => ({
    ...item,
    v: maskPcValue(item.k, item.v),
  });
  return {
    ...masked,
    pc: {
      ...masked.pc,
      flags: masked.pc.flags.map(maskItem),
      items: masked.pc.items.map(maskItem),
    },
  };
}

function badge(label: string, color: string): string {
  return `<span class="badge" style="border-color:${color};color:${color}">${escapeHtml(label)}</span>`;
}

function statusColor(report: FinalReport): string {
  return report.kind === 'ai_resolved' ? '#1d7a4d' : '#245b9c';
}

function personLine(person: {
  name: string;
  role?: string;
  dept?: string;
  employeeNo?: string;
}): string {
  const parts = [person.dept, person.name].filter(Boolean) as string[];
  const label = parts.join(' / ');
  const meta = [person.role, person.employeeNo ? `社員番号 ${person.employeeNo}` : '']
    .filter(Boolean)
    .join('・');
  return `${escapeHtml(label)}${meta ? ` <span class="muted">（${escapeHtml(meta)}）</span>` : ''}`;
}

function section(title: string, body: string, id?: string): string {
  if (!body.trim()) return '';
  return `<section class="sec"${id ? ` id="${id}"` : ''}><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function messageBody(message: z.infer<typeof MessageSchema>): string {
  const text = safeText(message.text);
  const steps = message.steps.length
    ? `<ol class="steps">${message.steps.map((step) => `<li>${safeText(step, 1000)}</li>`).join('')}</ol>`
    : '';
  const title = message.title
    ? `<div class="msg-title">${safeInline(message.title, 300)}</div>`
    : '';
  const kb = message.kbId
    ? ` <span class="muted">（${escapeHtml(message.kbId)}${typeof message.score === 'number' ? `・近さ ${Math.round(message.score * 100)}%` : ''}）</span>`
    : '';
  return `${title}${text ? `<div class="msg-text">${text}</div>` : ''}${steps}${kb}`;
}

function renderPc(report: FinalReport): string {
  const pc = report.pc;
  if (!pc) {
    return '<p class="muted">PC基本情報は取得していません（本人の選択）。</p>';
  }
  if (!pc.available) {
    return '<p class="muted">PC基本情報はこの案件で共有されていません。</p>';
  }

  const flagRows = pc.flags.map((item) => [
    `<span class="dot ${item.lv}"></span>${PF[item.lv][0]}`,
    `${item.rel ? '<b>★</b> ' : ''}${escapeHtml(item.k)}`,
    safePcValue(item.k, item.v),
    safeText(item.note, 500),
  ]);
  const allRows = pc.items.map((item) => [
    escapeHtml(item.grp),
    escapeHtml(item.k),
    safePcValue(item.k, item.v),
    `<span class="dot ${item.lv}"></span>${PF[item.lv][0]}`,
  ]);

  const meta = [
    pc.device ? `端末 ${escapeHtml(pc.device)}` : '',
    pc.collectedAt ? `取得 ${escapeHtml(pc.collectedAt)}` : '',
    typeof pc.itemCount === 'number' ? `${pc.itemCount}項目` : '',
    '読み取りのみ',
  ]
    .filter(Boolean)
    .join(' ／ ');

  return [
    `<p class="muted">${meta}</p>`,
    `<p class="note">IPアドレス・シリアル番号・資産番号は、この報告書では伏せています。</p>`,
    flagRows.length
      ? `<h3>気になる点（${flagRows.length}件）</h3>${table(['判定', '項目', '値', '補足'], flagRows)}`
      : '<p class="ok">気になる点は見つかりませんでした。</p>',
    allRows.length
      ? `<details open><summary>PC基本情報の全項目（${allRows.length}件）</summary>${table(['分類', '項目', '値', '判定'], allRows)}</details>`
      : '',
  ].join('');
}

function renderAi(report: FinalReport): string {
  const ai = report.ai;
  const messages = ai.messages
    .filter((message) => message.text.trim() || message.steps.length > 0 || message.title)
    .map((message) => {
      const who =
        message.role === 'user'
          ? report.requester.name
          : message.who || (message.role === 'system' ? 'システム' : 'AI');
      const at = message.at ? `<span class="muted">${escapeHtml(message.at)}</span>` : '';
      return `<div class="msg ${message.role}"><div class="msg-head">${escapeHtml(who)} ${at}</div>${messageBody(message)}</div>`;
    })
    .join('');

  const diagnoses = ai.diagnoses
    .map(
      (diagnosis) =>
        `<h3>${safeInline(diagnosis.title, 300)}</h3>${table(
          ['確認項目', '結果', '判定'],
          diagnosis.rows.map((row) => [
            escapeHtml(row.k),
            safeText(row.v, 500),
            `<span class="dot ${row.lv}"></span>${PF[row.lv][0]}`,
          ]),
        )}`,
    )
    .join('');

  const proposals = ai.proposals
    .map(
      (proposal) =>
        `<div class="proposal"><b>${escapeHtml(proposal.name)}</b> <span class="muted">${escapeHtml(
          proposal.opId,
        )}${proposal.level ? `・L${proposal.level}` : ''}${proposal.status ? `・${escapeHtml(proposal.status)}` : ''}</span>${
          proposal.impact ? `<div>影響：${safeText(proposal.impact, 1000)}</div>` : ''
        }${proposal.rollback ? `<div>戻し方：${safeText(proposal.rollback, 1000)}</div>` : ''}${
          proposal.result ? `<div>結果：${safeText(proposal.result, 2000)}</div>` : ''
        }</div>`,
    )
    .join('');

  const sources = ai.sources.length
    ? `<h3>根拠にした承認済みナレッジ</h3>${table(
        ['ID', 'タイトル'],
        ai.sources.map((source) => [
          escapeHtml(source.kbNo || source.id),
          escapeHtml(source.title),
        ]),
      )}`
    : '';

  const meta = [
    ai.provider ? `生成元 ${escapeHtml(ai.provider)}` : '',
    ai.model ? `モデル ${escapeHtml(ai.model)}` : '',
  ]
    .filter(Boolean)
    .join(' ／ ');

  return [
    meta ? `<p class="muted">${meta}</p>` : '',
    messages ? `<h3>やり取り</h3><div class="chat">${messages}</div>` : '',
    diagnoses,
    proposals ? `<h3>修復の提案・実行</h3>${proposals}` : '',
    sources,
  ].join('');
}

function renderHandover(report: FinalReport): string {
  const handover = report.handover;
  if (!handover) return '';
  const rows = [
    ['引継ぎ理由', safeText(handover.reason, 1000)],
    ['受付番号', escapeHtml(handover.ticketId ?? '')],
    ['ヘルプデスク番号', escapeHtml(handover.incId ?? '')],
    ['担当', escapeHtml(handover.assignee ?? '')],
    ['共有した情報', handover.shared.map(escapeHtml).join('、')],
    ['引継ぎ日時', escapeHtml(handover.at ?? '')],
  ].filter((row) => row[1]);
  const memo = handover.memo
    ? `<h3>AIがまとめた引継ぎメモ</h3><pre class="memo">${safeText(handover.memo, 20000)}</pre>`
    : '';
  return `${table(['項目', '内容'], rows)}${memo}`;
}

function renderResolution(report: FinalReport): string {
  const resolution = report.resolution;
  if (!resolution) return '';
  const rows = [
    ['原因', safeText(resolution.cause, 4000)],
    ['担当', escapeHtml(resolution.by ?? '')],
    ['所要時間', typeof resolution.minutes === 'number' ? `${resolution.minutes}分` : ''],
    ['解決日時', escapeHtml(resolution.at ?? '')],
    ['備考', safeText(resolution.note, 4000)],
  ].filter((row) => row[1]);
  const steps = resolution.steps.length
    ? `<h3>対応手順</h3><ol class="steps">${resolution.steps
        .map((step) => `<li>${safeText(step, 4000)}</li>`)
        .join('')}</ol>`
    : '';
  return `${table(['項目', '内容'], rows)}${steps}`;
}

function renderKnowledge(report: FinalReport): string {
  const knowledge = report.knowledge;
  if (!knowledge) return '';
  const rows = [
    ['下書き', escapeHtml(knowledge.draftId ?? '')],
    ['状態', escapeHtml(knowledge.status ?? '')],
    ['ナレッジ', escapeHtml(knowledge.kbId ?? '')],
    ['タイトル', safeText(knowledge.title, 300)],
    ['版', escapeHtml(knowledge.version ?? '')],
    ['承認者', escapeHtml(knowledge.approvedBy ?? '')],
  ].filter((row) => row[1]);
  return rows.length ? table(['項目', '内容'], rows) : '';
}

function renderRemote(report: FinalReport): string {
  const remote = report.remote;
  if (!remote) return '';
  const rows = [
    ['状態', escapeHtml(remote.status)],
    ['依頼', escapeHtml(remote.requestedBy ?? '')],
    ['依頼日時', escapeHtml(remote.requestedAt ?? '')],
    ['承認', escapeHtml(remote.approvedBy ?? '')],
    ['承認日時', escapeHtml(remote.approvedAt ?? '')],
    ['終了日時', escapeHtml(remote.endedAt ?? '')],
    ['期限', escapeHtml(remote.expiresAt ?? '')],
    ['範囲', safeText(remote.scope, 200)],
  ].filter((row) => row[1]);
  const prompts = remote.prompts.length
    ? `<h3>本人へ送った案内</h3>${table(
        ['日時', '送信者', '内容', '状態'],
        remote.prompts.map((prompt) => [
          escapeHtml(prompt.at ?? ''),
          escapeHtml(prompt.by ?? ''),
          safeText(prompt.text, 4000),
          escapeHtml(prompt.status),
        ]),
      )}`
    : '';
  return `<p class="note">画面の遠隔操作は行わず、本人の同意を得たうえで、読み取り情報と案内文だけを共有します。</p>${table(
    ['項目', '内容'],
    rows,
  )}${prompts}`;
}

function renderTerminal(report: FinalReport): string {
  const terminal = report.terminal;
  if (!terminal) return '';
  const closeLabel: Record<string, string> = {
    resolved: '解決として終了',
    stopped: '中止',
    escalated: 'エスカレーション',
    expired: '期限切れで自動終了',
  };
  const rows = [
    ['セッション', `<span class="case">${escapeHtml(terminal.sessionId)}</span>`],
    ['対象端末', escapeHtml(terminal.device)],
    ['実行した担当者', escapeHtml(terminal.operator ?? '')],
    ['依頼者', escapeHtml(terminal.requester ?? '')],
    ['開始', escapeHtml(terminal.startedAt)],
    ['終了', escapeHtml(terminal.closedAt ?? '')],
    [
      '終了理由',
      escapeHtml(
        terminal.closeReason ? (closeLabel[terminal.closeReason] ?? terminal.closeReason) : '',
      ),
    ],
    [
      '出力の取込',
      terminal.captureSupported
        ? '自動取込（RSPのターミナルログ）'
        : '手動貼り付け（自動取込は未対応）',
    ],
  ].filter((row) => row[1]);
  const steps = terminal.steps
    .map((step) => {
      const executed = step.executed
        ? [
            '<h3>実行したコマンド</h3>',
            `<pre class="memo">${safeText(step.executed.command, 8000)}</pre>`,
            step.executed.output.trim()
              ? `<h3>出力（${step.executed.outputSource === 'auto' ? '自動取込' : '手動貼り付け'}）</h3><pre class="memo">${safeText(step.executed.output, 20000)}</pre>`
              : '<p class="muted">出力は記録されていません。</p>',
            `<p class="muted">判定：${escapeHtml(step.executed.exitStatus)}${step.executed.sha256 ? ` ／ 記録ハッシュ：<span class="hash">${escapeHtml(step.executed.sha256)}</span>` : ''}${step.executed.note ? ` ／ 補足：${safeText(step.executed.note, 1000)}` : ''}</p>`,
          ].join('')
        : '<p class="note">このステップは実行結果が記録されていません。</p>';
      const proposal = [
        `<p class="muted">AIの提案（risk ${escapeHtml(step.proposal.risk)}）${step.proposal.purpose ? `：${safeText(step.proposal.purpose, 2000)}` : ''}</p>`,
        `<pre class="memo">${safeText(step.proposal.command, 8000)}</pre>`,
        step.proposal.verify
          ? `<p class="muted">確認方法：${safeText(step.proposal.verify, 2000)}</p>`
          : '',
        step.proposal.rollback
          ? `<p class="muted">戻し方：${safeText(step.proposal.rollback, 2000)}</p>`
          : '',
        step.proposal.warnings.length
          ? `<p class="note">警告：${step.proposal.warnings.map((warning) => safeText(warning, 500)).join(' ／ ')}</p>`
          : '',
      ].join('');
      return `<div class="proposal"><h3>ステップ ${step.seq}${step.at ? `（${escapeHtml(step.at)}）` : ''}</h3>${step.intent ? `<p class="muted">目的：${safeText(step.intent, 500)}</p>` : ''}${proposal}${executed}</div>`;
    })
    .join('');
  const unrecorded = terminal.unrecorded.length
    ? `<p class="note">未記録：${terminal.unrecorded.map((item) => safeText(item, 300)).join(' ／ ')}</p>`
    : '';
  return [
    '<p class="note">このセクションは、担当者がRSPのターミナルで実行した内容の記録です。サーバーはコマンドを実行していません。AIの提案と実行結果は別物として扱います。</p>',
    table(['項目', '内容'], rows),
    steps,
    unrecorded,
  ].join('');
}

function renderTimeline(report: FinalReport): string {
  if (report.timeline.length === 0) return '';
  return table(
    ['日時', '実施者', '出来事', '補足'],
    report.timeline.map((item) => [
      escapeHtml(item.at ?? ''),
      escapeHtml(item.actor ?? ''),
      safeInline(item.action, 300),
      safeText(item.detail, 2000),
    ]),
  );
}

const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #1f2933; }
body { font-family: "IPAGothic", "IPAPGothic", "Noto Sans JP", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif; font-size: 10.5pt; line-height: 1.65; }
.page { max-width: 186mm; margin: 0 auto; padding: 12mm 10mm 16mm; }
.cover { border-bottom: 3px solid #1f2933; padding-bottom: 8mm; margin-bottom: 7mm; }
.cover .eyebrow { font-size: 9pt; letter-spacing: .14em; color: #52606d; }
.cover h1 { font-size: 22pt; margin: 2mm 0 3mm; letter-spacing: .04em; }
.cover .sub { display: flex; flex-wrap: wrap; gap: 3mm 8mm; align-items: center; }
.cover .case { font-family: ui-monospace, "IPAGothic", monospace; font-size: 12pt; }
.badge { display: inline-block; border: 1px solid #52606d; border-radius: 999px; padding: 0 3mm; font-size: 9pt; line-height: 1.8; }
.muted { color: #616e7c; font-size: 9pt; }
.note { background: #f5f7fa; border-left: 3px solid #9aa5b1; padding: 2mm 3mm; font-size: 9pt; color: #3e4c59; }
.ok { color: #1d7a4d; }
.sec { margin: 7mm 0 0; page-break-inside: avoid; }
.sec h2 { font-size: 13pt; margin: 0 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid #cbd2d9; }
h3 { font-size: 10.5pt; margin: 4mm 0 2mm; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: 9.5pt; }
th, td { border: 1px solid #d9e2ec; padding: 1.6mm 2mm; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #f0f4f8; font-weight: 700; white-space: nowrap; }
.dot { display: inline-block; width: 2.2mm; height: 2.2mm; border-radius: 50%; margin-right: 1.4mm; vertical-align: middle; }
.dot.ok { background: #1d7a4d; }
.dot.warn { background: #d97706; }
.dot.ng { background: #b42318; }
.chat { display: grid; gap: 2.5mm; }
.msg { border: 1px solid #d9e2ec; border-radius: 2mm; padding: 2.5mm 3mm; page-break-inside: avoid; }
.msg.user { background: #f7f9fb; }
.msg.ai { background: #fff; }
.msg.system { background: #fffbea; border-color: #f0d38a; }
.msg-head { font-size: 9pt; color: #52606d; margin-bottom: 1mm; }
.msg-text { white-space: pre-wrap; }
.msg-title { font-weight: 700; margin-bottom: 1mm; }
.steps { margin: 1mm 0 1mm 5mm; padding: 0; }
.steps li { margin: .5mm 0; }
.memo { white-space: pre-wrap; background: #f7f9fb; border: 1px solid #d9e2ec; border-radius: 2mm; padding: 3mm; font-size: 9.5pt; }
.proposal { border: 1px solid #d9e2ec; border-radius: 2mm; padding: 2.5mm 3mm; margin: 2mm 0; page-break-inside: avoid; }
details { margin-top: 2mm; }
summary { cursor: pointer; color: #245b9c; font-size: 9.5pt; }
.footer { margin-top: 9mm; padding-top: 3mm; border-top: 1px solid #cbd2d9; color: #616e7c; font-size: 8.5pt; }
.hash { font-family: ui-monospace, "IPAGothic", monospace; word-break: break-all; }
@page { size: A4; margin: 12mm 10mm; }
@media print { .page { max-width: none; padding: 0; } a { color: inherit; text-decoration: none; } }
`;

export interface ReportRenderMeta {
  id: string;
  sha256: string;
}

/**
 * Standalone HTML を生成する。外部リソースは参照しない。
 * 返す HTML はそのままファイル保存してブラウザで開ける。
 */
export function renderFinalReportHtml(report: FinalReport, meta: ReportRenderMeta): RenderedReport {
  const kindLabel = KIND_LABEL[report.kind];
  const color = statusColor(report);
  const safeCaseId = report.case.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'case';
  const date = report.generatedAt.slice(0, 10).replace(/[^0-9]/g, '') || 'report';
  const filename = `AIHelpDesk-${safeCaseId}-${report.kind === 'ai_resolved' ? 'AI' : 'HD'}-${date}.html`;

  const summaryRows = [
    ['案件番号', `<span class="case">${escapeHtml(report.case.id)}</span>`],
    ['相談者', personLine(report.requester)],
    ['相談日時', escapeHtml(report.case.created)],
    ['相談の種類', escapeHtml(report.case.kindLabel)],
    ['急ぎ具合', escapeHtml(report.case.urgency)],
    ['対応結果', `${badge(kindLabel, color)}`],
    ['AIモデル', escapeHtml(report.case.model ?? report.ai.model ?? '')],
    ['出力日時', escapeHtml(report.generatedAt)],
    ['出力者', personLine(report.generatedBy)],
    [
      '受付番号 / ヘルプデスク',
      [report.handover?.ticketId, report.handover?.incId]
        .filter((value): value is string => Boolean(value))
        .map(escapeHtml)
        .join(' / '),
    ],
    ['担当者', escapeHtml(report.handover?.assignee ?? report.resolution?.by ?? '')],
    ['ナレッジ', escapeHtml(report.knowledge?.kbId ?? '')],
  ].filter((row) => row[1]);

  const timeline = renderTimeline(report);
  const pc = renderPc(report);
  const ai = renderAi(report);
  const handover = renderHandover(report);
  const resolution = renderResolution(report);
  const knowledge = renderKnowledge(report);
  const remote = renderRemote(report);
  const terminal = renderTerminal(report);

  const body = `
<div class="page">
  <div class="cover">
    <div class="eyebrow">みらいAI窓口 × ヘルプデスク ／ 最終報告書</div>
    <h1>${escapeHtml(kindLabel)}</h1>
    <div class="sub">
      <span class="case">${escapeHtml(report.case.id)}</span>
      ${badge(report.kind === 'ai_resolved' ? 'STEP 3 完了' : 'STEP 5 完了', color)}
      <span class="muted">${escapeHtml(report.case.subject)}</span>
    </div>
  </div>

  ${section('概要', table(['項目', '内容'], summaryRows), 'summary')}
  ${section('相談内容', `<p class="msg-text">${safeText(report.case.body, 12000)}</p>`)}
  ${section('対応の経過', timeline)}
  ${section('PC基本情報（読み取りのみ）', pc)}
  ${section('AIの一次対応', ai)}
  ${section('担当者への引継ぎ', handover)}
  ${section('担当者の対応・解決記録', resolution)}
  ${section('RSP実行セッション（AI提案と実行記録）', terminal)}
  ${section('ナレッジ化', knowledge)}
  ${section('遠隔支援（同意した範囲）', remote)}

  <div class="footer">
    <div>この報告書は AI HelpDesk Platform が自動生成したものです。個人情報は伏せ字化しています。</div>
    <div>本報告書は画面の状態をもとに生成しています。サーバー側の案件台帳との突合は MVP では行いません。</div>
    <div>報告書ID：<span class="hash">${escapeHtml(meta.id)}</span></div>
    <div>SHA-256（内容の同一性確認）：<span class="hash">${escapeHtml(meta.sha256)}</span></div>
    <div>出力：${escapeHtml(report.generatedAt)} ／ 形式：Standalone HTML（外部ファイル参照なし）</div>
  </div>
</div>`;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(`最終報告書 ${report.case.id} - ${kindLabel}`)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>${body}</body>
</html>`;

  return { html, filename };
}

export function reportPdfFilename(htmlFilename: string): string {
  return htmlFilename.replace(/\.html?$/i, '.pdf');
}

/** Content-Disposition 用（ASCII フォールバック + RFC 5987）。 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * ブラウザ内で表示するための Content-Disposition。
 * ダウンロード（attachment）と同じファイル名を保ちつつ inline で返す。
 */
export function inlineContentDisposition(filename: string): string {
  return contentDisposition(filename).replace(/^attachment;/, 'inline;');
}

const execFileAsync = promisify(execFile);

let cachedBinary: string | null | undefined;

async function findPdfBinary(): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;
  const configured = config.REPORT_PDF_BIN?.trim();
  const candidates = [
    configured,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5_000 });
      cachedBinary = candidate;
      return candidate;
    } catch {
      // 次の候補を試す
    }
  }
  cachedBinary = null;
  return null;
}

export async function pdfAvailable(): Promise<boolean> {
  return (await findPdfBinary()) !== null;
}

export class PdfUnavailableError extends Error {
  constructor() {
    super('PDF 生成に使えるヘッドレスブラウザが見つかりません。');
    this.name = 'PdfUnavailableError';
  }
}

/**
 * ヘッドレス Chrome で HTML を PDF に変換する。
 * - 外部通信はしない（HTML に外部参照がない）。
 * - 一時ディレクトリは finally で必ず削除する。
 * - タイムアウト・出力サイズ・PDF マジックを検証する。
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAX_WAITERS = 10;
let pdfInFlight = 0;
const pdfWaiters: Array<() => void> = [];

export class PdfBusyError extends Error {
  constructor() {
    super('PDF 生成が混み合っています。');
    this.name = 'PdfBusyError';
  }
}

/** Chrome の同時起動を 1 本に絞り、CPU / メモリの急増を防ぐ。 */
async function withPdfSlot<T>(task: () => Promise<T>): Promise<T> {
  if (pdfInFlight >= 1) {
    if (pdfWaiters.length >= PDF_MAX_WAITERS) throw new PdfBusyError();
    await new Promise<void>((resolve) => pdfWaiters.push(resolve));
  }
  pdfInFlight += 1;
  try {
    return await task();
  } finally {
    pdfInFlight -= 1;
    const next = pdfWaiters.shift();
    if (next) next();
  }
}

export async function renderFinalReportPdf(html: string): Promise<Buffer> {
  const binary = await findPdfBinary();
  if (!binary) throw new PdfUnavailableError();

  return withPdfSlot(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aihd-report-'));
    const htmlPath = path.join(dir, 'report.html');
    const pdfPath = path.join(dir, 'report.pdf');
    const profilePath = path.join(dir, 'profile');
    try {
      await writeFile(htmlPath, html, { encoding: 'utf8', mode: 0o600 });
      const args = [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--no-default-browser-check',
        // 生成 HTML は外部リソースを参照しない。DNS も引かせない。
        '--host-resolver-rules=MAP * ~NOTFOUND',
        `--user-data-dir=${profilePath}`,
        '--no-pdf-header-footer',
        '--print-to-pdf-no-header',
        '--virtual-time-budget=3000',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ];
      await execFileAsync(binary, args, {
        timeout: config.REPORT_PDF_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const info = await stat(pdfPath);
      if (info.size > MAX_PDF_BYTES) throw new Error('PDF が大きすぎます。');
      const pdf = await readFile(pdfPath);
      if (pdf.length < 1_000 || pdf.subarray(0, 4).toString('ascii') !== '%PDF') {
        throw new Error('PDF の生成結果が不正です。');
      }
      return pdf;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/** テスト用: バイナリ探索のキャッシュをリセットする。 */
export function resetPdfBinaryCache(): void {
  cachedBinary = undefined;
}
