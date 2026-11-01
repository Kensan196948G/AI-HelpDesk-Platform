import {
  type ApprovalManifest,
  computeSkillDefinitionHash,
  SKILL_CATALOG,
  type SkillDefinition,
  type SkillRecord,
} from '../resolve/skills.js';
import { ASSIST_SKILL_OUTPUTS, type OutputFieldType } from './contract.js';
import { loadApprovalManifest, readSkillScriptHash } from './skill-source.js';
import { ASSIST_LIMITS, type OperationScope } from './state.js';

/**
 * 本経路専用の Skill カタログ（docs/63 §11）。
 *
 * resolve の SKILL_CATALOG / skills テーブルへ入れない。入れると、承認された時点で
 * resolve が device_commands（SYSTEM の command-agent）へ配送できてしまい §6 に反する。
 * disk.space だけは既存の定義と承認をそのまま流用する（既存の定義を変更しない）。
 */

export type SkillEffect = 'read' | 'modify';

/** 成功条件。resolve/verify.ts の evaluateVerify が解釈する形。 */
export interface OutputCheck {
  resultField: string;
  equals?: string | number | boolean | null;
  minimum?: number;
  description: string;
}

export interface VerifyOpSpec {
  skillId: string;
  params: Record<string, unknown>;
  check: OutputCheck;
}

export interface AssistSkill {
  definition: SkillDefinition;
  effect: SkillEffect;
  targetKind: 'folder' | 'none';
  /** 画面へ出す提案の項目（§5）。AI の自然文は使わない。 */
  purpose: string;
  impact: string;
  successCriteria: string;
  failureAction: string;
  rollbackScope: string;
  /** 本体の出力に対する確認。 */
  mainCheck: (params: Record<string, unknown>) => OutputCheck;
  /** 承認時に提示する確認操作。提案の枠を消費しない（§8）。 */
  verifyOps: (params: Record<string, unknown>) => VerifyOpSpec[];
  /** AI へ渡してよい出力（数値と真偽値のみ。§4）。 */
  aiFields: string[];
  /** 確認操作専用（AI / ルールの提案に出さない）。 */
  verifyOnly?: boolean;
}

const NO_ELEVATION = { userConfirm: true, adminApproval: false, elevation: false } as const;
const MARKER_VALUES = ['VERIFY_A', 'VERIFY_B'] as const;

function resultSchemaOf(skillId: string): Record<string, unknown> {
  return { ...(ASSIST_SKILL_OUTPUTS[skillId] ?? {}) };
}

const folderSummary: SkillDefinition = {
  id: 'folder.summary',
  version: '1.0.0',
  title: '許可したフォルダの件数を確認する',
  summary: '許可されたフォルダ直下の件数と合計サイズを読み取ります。名前は取得しません。',
  symptoms: ['フォルダの中身の件数を確認したい', '保存先の容量を確認したい'],
  os: ['windows'],
  riskLevel: 1,
  requires: NO_ELEVATION,
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: { target: { type: 'string', enum: ['T1'] } },
  },
  scriptPath: 'scripts/skills/windows/folder-summary.ps1',
  args: [],
  verify: null,
  rollback: null,
  timeoutSec: 60,
  resultSchema: resultSchemaOf('folder.summary'),
  outputPolicy: {
    maxBytes: ASSIST_LIMITS.maxOutputBytes,
    fieldsToAi: [
      'accessible',
      'fileCount',
      'directoryCount',
      'linkCount',
      'totalBytes',
      'truncated',
    ],
    maskPii: true,
  },
};

const markerSet: SkillDefinition = {
  id: 'user.marker.set',
  version: '1.0.0',
  title: '検証用の目印を設定する',
  summary: 'HKCU\\Software\\AIHelpDesk\\Verify に合成の値を設定します。検証用です。',
  symptoms: ['操作の検証'],
  os: ['windows'],
  riskLevel: 2,
  requires: NO_ELEVATION,
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'string', enum: [...MARKER_VALUES] } },
  },
  scriptPath: 'scripts/skills/windows/user-marker-set.ps1',
  args: [],
  verify: null,
  rollback: { skillId: 'user.marker.clear' },
  timeoutSec: 60,
  resultSchema: resultSchemaOf('user.marker.set'),
  outputPolicy: {
    maxBytes: ASSIST_LIMITS.maxOutputBytes,
    fieldsToAi: ['applied', 'previousPresent'],
    maskPii: true,
  },
};

const markerClear: SkillDefinition = {
  id: 'user.marker.clear',
  version: '1.0.0',
  title: '検証用の目印を消す',
  summary: 'HKCU\\Software\\AIHelpDesk\\Verify の合成の値を消します。検証用です。',
  symptoms: ['操作の検証'],
  os: ['windows'],
  riskLevel: 2,
  requires: NO_ELEVATION,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  scriptPath: 'scripts/skills/windows/user-marker-clear.ps1',
  args: [],
  verify: null,
  rollback: { skillId: 'user.marker.set' },
  timeoutSec: 60,
  resultSchema: resultSchemaOf('user.marker.clear'),
  outputPolicy: {
    maxBytes: ASSIST_LIMITS.maxOutputBytes,
    fieldsToAi: ['cleared', 'previousPresent'],
    maskPii: true,
  },
};

const markerStatus: SkillDefinition = {
  id: 'user.marker.status',
  version: '1.0.0',
  title: '検証用の目印を確認する',
  summary: 'HKCU\\Software\\AIHelpDesk\\Verify の合成の値を読み取ります。',
  symptoms: ['操作の検証'],
  os: ['windows'],
  riskLevel: 1,
  requires: NO_ELEVATION,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  scriptPath: 'scripts/skills/windows/user-marker-status.ps1',
  args: [],
  verify: null,
  rollback: null,
  timeoutSec: 60,
  resultSchema: resultSchemaOf('user.marker.status'),
  outputPolicy: {
    maxBytes: ASSIST_LIMITS.maxOutputBytes,
    fieldsToAi: ['present'],
    maskPii: true,
  },
};

function existingDefinition(id: string): SkillDefinition {
  const found = SKILL_CATALOG.find((skill) => skill.id === id);
  if (!found) throw new Error(`Skill ${id} がカタログにありません。`);
  return found;
}

export const ASSIST_SKILLS: AssistSkill[] = [
  {
    definition: folderSummary,
    effect: 'read',
    targetKind: 'folder',
    purpose: '同意したフォルダの状態を件数で確認します。',
    impact: '読み取りのみです。変更しません。名前は取得しません。',
    successCriteria: 'フォルダへアクセスでき、件数を取得できること。',
    failureAction: '停止して担当者へ戻します。',
    rollbackScope: '変更がないため不要です。',
    mainCheck: () => ({
      resultField: 'accessible',
      equals: true,
      description: 'フォルダへアクセスできた',
    }),
    verifyOps: () => [],
    aiFields: ['accessible', 'fileCount', 'directoryCount', 'linkCount', 'totalBytes', 'truncated'],
  },
  {
    definition: existingDefinition('disk.space'),
    effect: 'read',
    targetKind: 'none',
    purpose: 'ディスクの空き容量を確認します。',
    impact: '読み取りのみです。変更しません。',
    successCriteria: '1 つ以上のドライブの容量を取得できること。',
    failureAction: '停止して担当者へ戻します。',
    rollbackScope: '変更がないため不要です。',
    mainCheck: () => ({
      resultField: 'volumeCount',
      minimum: 1,
      description: 'ドライブの容量を取得できた',
    }),
    verifyOps: () => [],
    aiFields: ['volumeCount', 'minFreeGB'],
  },
  {
    definition: markerSet,
    effect: 'modify',
    targetKind: 'none',
    purpose: '操作の流れを検証するため、合成の目印を設定します。',
    impact: 'ご本人のレジストリ（HKCU）に検証用の値を 1 つ書きます。ほかは変更しません。',
    successCriteria: '確認操作で、設定した値を読み取れること。',
    failureAction: '停止して担当者へ戻します。目印が残った場合は消す操作を別に提案します。',
    rollbackScope: '目印を消す操作で元に戻せます。',
    mainCheck: () => ({ resultField: 'applied', equals: true, description: '目印を設定できた' }),
    verifyOps: (params) => [
      {
        skillId: 'user.marker.status',
        params: {},
        check: {
          resultField: 'value',
          equals: String(params.value),
          description: '設定した値を読み取れた',
        },
      },
    ],
    aiFields: ['applied', 'previousPresent'],
  },
  {
    definition: markerClear,
    effect: 'modify',
    targetKind: 'none',
    purpose: '検証用の目印を消します。',
    impact: 'ご本人のレジストリ（HKCU）の検証用の値を消します。ほかは変更しません。',
    successCriteria: '確認操作で、目印が無いことを確認できること。',
    failureAction: '停止して担当者へ戻します。',
    rollbackScope: '目印を設定する操作で元に戻せます。',
    mainCheck: () => ({ resultField: 'cleared', equals: true, description: '目印を消せた' }),
    verifyOps: () => [
      {
        skillId: 'user.marker.status',
        params: {},
        check: { resultField: 'present', equals: false, description: '目印が無いことを確認できた' },
      },
    ],
    aiFields: ['cleared', 'previousPresent'],
  },
  {
    definition: markerStatus,
    effect: 'read',
    targetKind: 'none',
    purpose: '検証用の目印を確認します。',
    impact: '読み取りのみです。変更しません。',
    successCriteria: '状態を取得できること。',
    failureAction: '停止して担当者へ戻します。',
    rollbackScope: '変更がないため不要です。',
    mainCheck: () => ({ resultField: 'present', equals: true, description: '目印がある' }),
    verifyOps: () => [],
    aiFields: ['present'],
    verifyOnly: true,
  },
];

const BY_ID = new Map(ASSIST_SKILLS.map((skill) => [skill.definition.id, skill]));

export function findAssistSkill(id: string): AssistSkill | null {
  return BY_ID.get(id) ?? null;
}

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
export function proposableSkills(scope: OperationScope): ApprovedAssistSkill[] {
  const result: ApprovedAssistSkill[] = [];
  const manifest = loadApprovalManifest();
  for (const skill of ASSIST_SKILLS) {
    if (skill.verifyOnly || !isWithinScope(skill, scope)) continue;
    const approved = resolveApprovedSkill(skill.definition.id, manifest);
    if (approved) result.push(approved);
  }
  return result;
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
