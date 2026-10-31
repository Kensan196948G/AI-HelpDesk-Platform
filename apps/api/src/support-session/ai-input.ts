import { config } from '../config.js';
import {
  buildSkillCatalogForAi,
  isDuplicateProposal,
  type ProposalHistoryEntry,
  proposalFromAiBody,
} from '../resolve/proposer.js';
import type { SkillRecord } from '../resolve/skills.js';
import { type ApprovedAssistSkill, toSkillRecord } from './skills.js';
import { ASSIST_LIMITS, type OperationScope } from './state.js';

/**
 * AI へ渡す情報（docs/63 §4）。ここで組み立てた構造化要約だけを送る。
 * resolve の proposeNext は相談文と lastVerify.actual を送るので使わない。
 * 流用するのは、応答の検証（proposalFromAiBody）と重複判定（isDuplicateProposal）だけ。
 */

const RESULT_CODE = /^[A-Z0-9_]{1,64}$/;

export interface AiStepFact {
  skillId: string;
  effect: 'read' | 'modify';
  resultCode: string | null;
  verified: boolean | null;
  /** 正規化済みの出力。ここからさらに aiFields の数値と真偽値だけを残す。 */
  output: Record<string, unknown> | null;
  aiFields: readonly string[];
}

export interface AiInputFacts {
  scope: OperationScope;
  rootKind: string | null;
  usedProposals: number;
  steps: AiStepFact[];
}

export interface AiStructuredInput {
  schema: 'assist-ai-input/1';
  scope: OperationScope;
  targets: { ref: 'T1'; rootKind: string }[];
  remainingProposals: number;
  steps: {
    skillId: string;
    effect: 'read' | 'modify';
    resultCode: string | null;
    verified: boolean | null;
    summary: Record<string, number | boolean>;
  }[];
}

/** 許可フィールドの数値と真偽値だけを残す。文字列は固定コードでも渡さない。 */
export function buildAiInput(facts: AiInputFacts): AiStructuredInput {
  return {
    schema: 'assist-ai-input/1',
    scope: facts.scope,
    targets: facts.rootKind ? [{ ref: 'T1', rootKind: facts.rootKind }] : [],
    remainingProposals: Math.max(0, ASSIST_LIMITS.maxProposals - facts.usedProposals),
    steps: facts.steps.map((step) => {
      const summary: Record<string, number | boolean> = {};
      for (const field of step.aiFields) {
        const value = step.output?.[field];
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
          summary[field] = value;
        }
      }
      return {
        skillId: step.skillId,
        effect: step.effect,
        resultCode: step.resultCode && RESULT_CODE.test(step.resultCode) ? step.resultCode : null,
        verified: step.verified,
        summary,
      };
    }),
  };
}

export type AiCandidate =
  | { kind: 'proposal'; skillId: string; params: Record<string, unknown>; rationale: string }
  | { kind: 'decision'; decision: 'stop' | 'escalate'; rationale: string }
  | { kind: 'duplicate' }
  | { kind: 'none' };

const SYSTEM_PROMPT = [
  'あなたは社内ITヘルプデスクの操作提案AIです。',
  '次の入力は端末の状態を固定形式で要約したものです。承認済み Skill カタログから次の 1 つだけを選ぶか、終了を宣言し、厳格な JSON だけを返してください。',
  '出力形式: {"skillId":"...","params":{},"rationale":"...","decision":null}',
  '制約:',
  '- skillId はカタログにある id だけ。params はスキーマに合う値だけ。対象は参照 ID（T1）で指定する。',
  '- コマンド文字列・PowerShell・スクリプト・パスは生成しない。',
  '- rationale は 100 文字以内。個人情報を含めない。',
  '- 既に実行済みの Skill + params は選ばない。',
  '- これ以上進められない場合は {"skillId":"","decision":"escalate"} を返す。',
  '- 直近の確認（verified が true）で足りると判断する場合だけ {"skillId":"","decision":"stop"} を返す。',
].join('\n');

export function aiConfigured(): boolean {
  return Boolean(config.DEEPSEEK_API_KEY);
}

/**
 * AI に候補を 1 つ選ばせる。応答は Skill と型付き params の候補としてのみ使う。
 * 失敗はすべて none（呼び出し側がルールベースへ戻す）。
 */
export async function askAiForCandidate(
  input: AiStructuredInput,
  skills: ApprovedAssistSkill[],
  history: ProposalHistoryEntry[],
): Promise<AiCandidate> {
  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey) return { kind: 'none' };
  const records: SkillRecord[] = skills.map(toSkillRecord);
  try {
    const response = await fetch(
      `${config.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.DEEPSEEK_MODEL,
          temperature: 0.1,
          max_tokens: 400,
          ...(config.DEEPSEEK_THINKING === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({
                facts: input,
                executed: history,
                skillCatalog: buildSkillCatalogForAi(records),
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(config.DEEPSEEK_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { kind: 'none' };
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { kind: 'none' };
    // 重複は「停止」に使うので、ここでは履歴を渡さずに検証してから判定する。
    const proposal = proposalFromAiBody(JSON.parse(content) as unknown, {
      skills: records,
      history: [],
    });
    if (!proposal) return { kind: 'none' };
    if (proposal.decision) {
      return { kind: 'decision', decision: proposal.decision, rationale: proposal.rationale };
    }
    if (isDuplicateProposal({ skillId: proposal.skillId, params: proposal.params }, history)) {
      return { kind: 'duplicate' };
    }
    return {
      kind: 'proposal',
      skillId: proposal.skillId,
      params: proposal.params,
      rationale: proposal.rationale,
    };
  } catch {
    return { kind: 'none' };
  }
}

/** ルールベースの提案（同意がない場合と AI が使えない場合）。固定の順で未実行のものを選ぶ。 */
export function rulePropose(
  skills: ApprovedAssistSkill[],
  history: ProposalHistoryEntry[],
): { skillId: string; params: Record<string, unknown>; rationale: string } | null {
  const candidates: { skillId: string; params: Record<string, unknown>; rationale: string }[] = [
    {
      skillId: 'folder.summary',
      params: { target: 'T1' },
      rationale: '同意したフォルダの状態を確認します（ルールベース）。',
    },
    { skillId: 'disk.space', params: {}, rationale: '空き容量を確認します（ルールベース）。' },
    {
      skillId: 'user.marker.set',
      params: { value: 'VERIFY_A' },
      rationale: '検証用の目印を設定します（ルールベース）。',
    },
    {
      skillId: 'user.marker.clear',
      params: {},
      rationale: '検証用の目印を消します（ルールベース）。',
    },
  ];
  const available = new Set(skills.map((approved) => approved.skill.definition.id));
  for (const candidate of candidates) {
    if (!available.has(candidate.skillId)) continue;
    if (isDuplicateProposal(candidate, history)) continue;
    return candidate;
  }
  return null;
}
