import {
  type ApprovalManifest,
  computeSkillDefinitionHash,
  type SkillRecord,
} from '../resolve/skills.js';
import { ASSIST_SKILLS, type AssistSkill, findAssistSkill } from './assist-catalog.js';
import { ASSIST_SKILL_OUTPUTS, type OutputFieldType } from './contract.js';
import { loadApprovalManifest, readSkillScriptHash } from './skill-source.js';
import type { OperationScope } from './state.js';

export * from './assist-catalog.js';

export interface ApprovedAssistSkill {
  skill: AssistSkill;
  version: string;
  scriptHash: string;
  contentHash: string;
}

/**
 * 人の承認と完全に一致する Skill だけを返す（§11）。
 * スクリプトが無い・manifest に無い・定義やスクリプトが変わった場合は null。
 * 昇格が必要な Skill と高リスク（管理者承認が必要）は本経路で扱わない。
 */
export function resolveApprovedSkill(
  id: string,
  manifest: ApprovalManifest = loadApprovalManifest(),
): ApprovedAssistSkill | null {
  const skill = findAssistSkill(id);
  if (!skill) return null;
  const { definition } = skill;
  const requires = definition.requires as { elevation?: unknown; adminApproval?: unknown };
  if (requires.elevation === true || requires.adminApproval === true) return null;
  if (definition.riskLevel >= 4) return null;
  const scriptHash = readSkillScriptHash(definition.scriptPath);
  if (!scriptHash) return null;
  const contentHash = computeSkillDefinitionHash(definition, scriptHash);
  const entry = manifest.skills.find(
    (item) => item.id === definition.id && item.version === definition.version,
  );
  if (!entry || entry.scriptHash !== scriptHash || entry.contentHash !== contentHash) return null;
  return { skill, version: definition.version, scriptHash, contentHash };
}

/** 操作範囲に収まる Skill か（§2。範囲の外は提案しない）。 */
export function isWithinScope(skill: AssistSkill, scope: OperationScope): boolean {
  return skill.effect === 'read' || scope === 'user_reversible';
}

/** 提案の候補（承認済み・範囲内・確認専用を除く）。 */
export function proposableSkills(
  scope: OperationScope,
  manifest: ApprovalManifest = loadApprovalManifest(),
): ApprovedAssistSkill[] {
  const result: ApprovedAssistSkill[] = [];
  for (const skill of ASSIST_SKILLS) {
    if (skill.verifyOnly || !isWithinScope(skill, scope)) continue;
    const approved = resolveApprovedSkill(skill.definition.id, manifest);
    if (approved) result.push(approved);
  }
  return result;
}

export interface SkillAvailability {
  readOnly: number;
  userReversible: number;
}

/** 操作範囲ごとの提案できる Skill の数。manifest は 1 度だけ読む。 */
export function skillAvailability(): SkillAvailability {
  const manifest = loadApprovalManifest();
  return {
    readOnly: proposableSkills('read_only', manifest).length,
    userReversible: proposableSkills('user_reversible', manifest).length,
  };
}

/** resolve の proposer が受け取る形へ変換する（提案の検証を流用するため）。 */
export function toSkillRecord(approved: ApprovedAssistSkill): SkillRecord {
  const { definition } = approved.skill;
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    summary: definition.summary,
    symptoms: definition.symptoms,
    os: definition.os,
    riskLevel: definition.riskLevel,
    requires: definition.requires,
    paramsSchema: definition.paramsSchema,
    scriptPath: definition.scriptPath,
    args: definition.args,
    verify: null,
    rollback: definition.rollback,
    timeoutSec: definition.timeoutSec,
    resultSchema: definition.resultSchema,
    outputPolicy: definition.outputPolicy,
    status: 'approved',
    contentHash: approved.contentHash,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

const MARKER_PATTERN = /^[A-Z0-9_-]{1,32}$/;

function isFieldValue(type: OutputFieldType, value: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'count':
    case 'bytes':
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case 'gigabytes':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'marker':
      return value === null || (typeof value === 'string' && MARKER_PATTERN.test(value));
  }
}

/**
 * 端末の出力を許可フィールドへ正規化する。自由文・名前・想定外の型は保存しない。
 * 捨てたフィールドは欠落として扱うので、成功判定には使えない（fail-closed）。
 */
export function normalizeSkillOutput(
  skillId: string,
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!raw) return null;
  if (skillId === 'disk.space') {
    // 既存のスクリプトの出力（volumes の配列）から件数と最小の空き容量だけを取り出す。
    const volumes = Array.isArray(raw.volumes) ? raw.volumes : null;
    if (!volumes) return {};
    const free = volumes
      .map((volume) => (volume as { freeGB?: unknown } | null)?.freeGB)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    // 容量を取得できたドライブだけを数える（freeGB が null の要素で成功にしない）。
    return {
      volumeCount: free.length,
      ...(free.length > 0 ? { minFreeGB: Math.min(...free) } : {}),
    };
  }
  const fields = ASSIST_SKILL_OUTPUTS[skillId];
  if (!fields) return {};
  const output: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(fields)) {
    if (Object.hasOwn(raw, field) && isFieldValue(type, raw[field])) output[field] = raw[field];
  }
  return output;
}
