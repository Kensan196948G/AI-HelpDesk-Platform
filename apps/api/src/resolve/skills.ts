import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import { sql } from '../db.js';
import { stableStringify } from '../domain/audit.js';
import { jsonbValue } from '../lib/jsonb-value.js';

/** Phase B の Skill カタログ定義（スクリプト実体は scripts/skills/windows/ 配下）。 */
export interface SkillDefinition {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: string[];
  os: string[];
  riskLevel: number;
  requires: Record<string, unknown>;
  paramsSchema: Record<string, unknown>;
  scriptPath: string;
  args: string[];
  verify: unknown;
  rollback: unknown;
  timeoutSec: number;
  resultSchema: Record<string, unknown>;
  outputPolicy: Record<string, unknown>;
}

/** DB から読み出した Skill（API / proposer 用の camelCase 表現）。 */
export interface SkillRecord {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: string[];
  os: string[];
  riskLevel: number;
  requires: Record<string, unknown>;
  paramsSchema: Record<string, unknown>;
  scriptPath: string;
  args: unknown[];
  verify: unknown;
  rollback: unknown;
  timeoutSec: number;
  resultSchema: unknown;
  outputPolicy: unknown;
  status: string;
  contentHash: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface SkillRow {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: unknown;
  os: unknown;
  risk_level: number;
  requires: unknown;
  params_schema: unknown;
  script_path: string;
  args: unknown;
  verify: unknown;
  rollback: unknown;
  timeout_sec: number;
  result_schema: unknown;
  output_policy: unknown;
  status: string;
  content_hash: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
}

const READ_ONLY_REQUIRES = {
  userConfirm: true,
  adminApproval: false,
  elevation: false,
} as const;

/**
 * Phase B の 5 Skill（すべて読み取り専用 / risk_level 1 / Windows）。
 * スクリプト文字列は保持せず、許可済みの引数配列だけを持つ。
 */
export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: 'os.info',
    version: '1.0.0',
    title: 'OS の基本情報を確認する',
    summary: 'Windows のエディション・バージョン・起動時間などを読み取りで確認します。',
    symptoms: [
      'OS のバージョンを知りたい',
      'Windows の更新状態を確認したい',
      '端末の基本情報を確認したい',
    ],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/os-info.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    resultSchema: { os: 'string', version: 'string', build: 'string', uptimeSeconds: 'number' },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['os', 'version', 'build', 'uptimeSeconds'],
      maskPii: true,
    },
  },
  {
    id: 'disk.space',
    version: '1.0.0',
    title: 'ディスクの空き容量を確認する',
    summary: '各ドライブの合計容量・空き容量・使用率を読み取りで確認します。',
    symptoms: ['空き容量が少ない', '保存できない', 'ディスクがいっぱい'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/disk-space.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    resultSchema: {
      disks: [
        { mount: 'string', totalBytes: 'number', freeBytes: 'number', usedPercent: 'number' },
      ],
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['disks'],
      maskPii: true,
    },
  },
  {
    id: 'spooler.status',
    version: '1.0.0',
    title: '印刷スプーラの状態を確認する',
    summary: '印刷スプーラサービスと印刷キューの状態を読み取りで確認します。',
    symptoms: ['印刷できない', '印刷キューに残る', 'プリンタが応答しない'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/spooler-status.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    resultSchema: {
      service: 'string',
      status: 'string',
      startType: 'string',
      printerCount: 'number',
      jobCount: 'number',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['service', 'status', 'startType', 'printerCount', 'jobCount'],
      maskPii: true,
    },
  },
  {
    id: 'service.status',
    version: '1.0.0',
    title: '指定サービスの状態を確認する',
    summary: '許可された Windows サービスの状態とスタートアップの種類を読み取りで確認します。',
    symptoms: [
      'サービスが起動しない',
      'サービスの状態を知りたい',
      '自動起動になっているか確認したい',
    ],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['service'],
      properties: {
        service: { type: 'string', enum: ['Spooler', 'W32Time', 'Winmgmt'] },
      },
    },
    scriptPath: 'scripts/skills/windows/service-status.ps1',
    args: ['-Service', '{{service}}'],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    resultSchema: { service: 'string', status: 'string', startType: 'string' },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['service', 'status', 'startType'],
      maskPii: true,
    },
  },
  {
    id: 'network.adapters',
    version: '1.0.0',
    title: 'ネットワークアダプタの状態を確認する',
    summary: 'ネットワークアダプタの接続状態・種類・IP の有無を読み取りで確認します。',
    symptoms: ['ネットワークにつながらない', 'VPN の状態を知りたい', '通信が不安定'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/network-adapters.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    resultSchema: {
      adapters: [{ name: 'string', status: 'string', type: 'string', hasIpv4: 'boolean' }],
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['adapters'],
      maskPii: true,
    },
  },
];

/** スクリプト内容の SHA-256（`sha256:<hex>` 形式）。 */
export function computeScriptHash(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** 人間がレビューして承認した Skill の記録（リポジトリで管理する）。 */
export interface ApprovedSkillEntry {
  id: string;
  version: string;
  scriptHash: string;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
  note?: string;
}

export interface ApprovalManifest {
  version: number;
  skills: ApprovedSkillEntry[];
}

export const APPROVAL_MANIFEST_PATH = 'scripts/skills/approved.json';

/**
 * Skill 定義全体の SHA-256。スクリプトだけでなく、引数・リスク・パラメータスキーマ・
 * verify/rollback・出力ポリシーまで含める。1 つでも変われば承認は無効になる。
 */
export function computeSkillDefinitionHash(skill: SkillDefinition, scriptHash: string): string {
  const definition = {
    id: skill.id,
    version: skill.version,
    title: skill.title,
    summary: skill.summary,
    symptoms: skill.symptoms,
    os: skill.os,
    riskLevel: skill.riskLevel,
    requires: skill.requires,
    paramsSchema: skill.paramsSchema,
    scriptPath: skill.scriptPath,
    args: skill.args,
    verify: skill.verify,
    rollback: skill.rollback,
    timeoutSec: skill.timeoutSec,
    resultSchema: skill.resultSchema,
    outputPolicy: skill.outputPolicy,
    scriptHash,
  };
  return `sha256:${createHash('sha256').update(stableStringify(definition)).digest('hex')}`;
}

export function readApprovalManifest(repoRootPath: string): ApprovalManifest {
  const file = path.join(repoRootPath, APPROVAL_MANIFEST_PATH);
  if (!existsSync(file)) return { version: 1, skills: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApprovalManifest;
    return Array.isArray(parsed.skills) ? parsed : { version: 1, skills: [] };
  } catch {
    return { version: 1, skills: [] };
  }
}

/** jsonb 列が文字列で保存されていても（旧データ）オブジェクトとして読む。 */
export function normalizeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  const normalized = normalizeJsonValue(value);
  if (Array.isArray(normalized)) return normalized.map((item) => String(item));
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  const normalized = normalizeJsonValue(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return {};
}

function asArgs(value: unknown): unknown[] {
  const normalized = normalizeJsonValue(value);
  return Array.isArray(normalized) ? normalized : [];
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toSkillRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    summary: row.summary,
    symptoms: asStringArray(row.symptoms),
    os: Array.isArray(row.os) ? row.os.map((item) => String(item)) : asStringArray(row.os),
    riskLevel: Number(row.risk_level),
    requires: asObject(row.requires),
    paramsSchema: asObject(row.params_schema),
    scriptPath: row.script_path,
    args: asArgs(row.args),
    verify: normalizeJsonValue(row.verify),
    rollback: normalizeJsonValue(row.rollback),
    timeoutSec: Number(row.timeout_sec),
    resultSchema: normalizeJsonValue(row.result_schema),
    outputPolicy: normalizeJsonValue(row.output_policy),
    status: row.status,
    contentHash: row.content_hash,
    approvedBy: row.approved_by,
    approvedAt: toIso(row.approved_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * JSON Schema のうち、Phase B のカタログで使う範囲（object / string enum / required /
 * additionalProperties:false）を検証する。テンプレート引数に使う値だけを許可する。
 */
export function validateParams(
  schema: unknown,
  params: unknown,
): { ok: true } | { ok: false; message: string } {
  const root = asObject(schema);
  const value = normalizeJsonValue(params);
  if (value === null || value === undefined) {
    return { ok: false, message: 'パラメータが必要です。' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'パラメータはオブジェクトで指定してください。' };
  }
  const record = value as Record<string, unknown>;
  const properties = asObject(root.properties);
  const required = asStringArray(root.required);
  for (const key of required) {
    if (!(key in record)) return { ok: false, message: `パラメータ ${key} が必要です。` };
  }
  for (const [key, raw] of Object.entries(record)) {
    const propertySchema = asObject(properties[key]);
    if (Object.keys(propertySchema).length === 0) {
      if (root.additionalProperties === false) {
        return { ok: false, message: `パラメータ ${key} は許可されていません。` };
      }
      continue;
    }
    const type = typeof propertySchema.type === 'string' ? propertySchema.type : undefined;
    if (type === 'string' && typeof raw !== 'string') {
      return { ok: false, message: `パラメータ ${key} は文字列で指定してください。` };
    }
    if (type === 'number' && typeof raw !== 'number') {
      return { ok: false, message: `パラメータ ${key} は数値で指定してください。` };
    }
    if (type === 'integer' && !Number.isInteger(raw)) {
      return { ok: false, message: `パラメータ ${key} は整数で指定してください。` };
    }
    if (type === 'boolean' && typeof raw !== 'boolean') {
      return { ok: false, message: `パラメータ ${key} は真偽値で指定してください。` };
    }
    const allowed = asStringArray(propertySchema.enum);
    if (allowed.length > 0 && !allowed.includes(String(raw))) {
      return { ok: false, message: `パラメータ ${key} の値が許可されていません。` };
    }
  }
  return { ok: true };
}

/**
 * カタログ定義を DB へ upsert する（サーバ起動時）。
 * - スクリプトが存在すれば SHA-256 を保存し status=approved。
 * - 未作成なら status=draft（起動は止めない）。
 * - 内容が変わった場合だけ status / approved_by / approved_at をリセットする
 *   （再承認が必要。無変更の再起動で承認を失わない）。
 */
export async function ensureSkillCatalog(): Promise<void> {
  const manifest = readApprovalManifest(repoRoot);
  const approved = new Map(manifest.skills.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  for (const skill of SKILL_CATALOG) {
    const absolutePath = path.join(repoRoot, skill.scriptPath);
    let scriptHash: string | null = null;
    let definitionHash: string | null = null;
    try {
      scriptHash = computeScriptHash(readFileSync(absolutePath));
      definitionHash = computeSkillDefinitionHash(skill, scriptHash);
    } catch {
      scriptHash = null;
      definitionHash = null;
    }
    // 人間が承認した manifest と完全一致したときだけ approved にする。
    // スクリプト・引数・リスク・スキーマ等が変われば自動的に draft へ戻る。
    const entry = approved.get(`${skill.id}@${skill.version}`);
    const isApproved = Boolean(
      entry &&
        scriptHash &&
        definitionHash &&
        entry.scriptHash === scriptHash &&
        entry.contentHash === definitionHash,
    );
    const status = isApproved ? 'approved' : 'draft';
    const approvedBy = isApproved ? entry!.approvedBy : null;
    const approvedAt = isApproved ? new Date(entry!.approvedAt) : null;

    await sql`
      INSERT INTO skills (
        id, version, title, summary, symptoms, os, risk_level, requires, params_schema,
        script_path, args, verify, rollback, timeout_sec, result_schema, output_policy,
        status, content_hash, approved_by, approved_at
      ) VALUES (
        ${skill.id}, ${skill.version}, ${skill.title}, ${skill.summary},
        ${jsonbValue(skill.symptoms)}, ${skill.os}::text[], ${skill.riskLevel},
        ${jsonbValue(skill.requires)}, ${jsonbValue(skill.paramsSchema)},
        ${skill.scriptPath}, ${jsonbValue(skill.args)},
        ${skill.verify === null ? null : jsonbValue(skill.verify)},
        ${skill.rollback === null ? null : jsonbValue(skill.rollback)},
        ${skill.timeoutSec},
        ${skill.resultSchema === null ? null : jsonbValue(skill.resultSchema)},
        ${skill.outputPolicy === null ? null : jsonbValue(skill.outputPolicy)},
        ${status}, ${definitionHash}, ${approvedBy}, ${approvedAt}
      )
      ON CONFLICT (id, version) DO UPDATE SET
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        symptoms = EXCLUDED.symptoms,
        os = EXCLUDED.os,
        risk_level = EXCLUDED.risk_level,
        requires = EXCLUDED.requires,
        params_schema = EXCLUDED.params_schema,
        script_path = EXCLUDED.script_path,
        args = EXCLUDED.args,
        verify = EXCLUDED.verify,
        rollback = EXCLUDED.rollback,
        timeout_sec = EXCLUDED.timeout_sec,
        result_schema = EXCLUDED.result_schema,
        output_policy = EXCLUDED.output_policy,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at
    `;
  }
}

/** 承認済み Skill の一覧（画面のカタログ表示・提案候補）。 */
export async function listApprovedSkills(): Promise<SkillRecord[]> {
  const rows = await sql<SkillRow[]>`
    SELECT * FROM skills
    WHERE status = 'approved'
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map(toSkillRecord);
}

/** id + version で承認済み Skill を取得する（承認直前の再検証）。 */
export async function getApprovedSkill(id: string, version: string): Promise<SkillRecord | null> {
  const rows = await sql<SkillRow[]>`
    SELECT * FROM skills
    WHERE id = ${id} AND version = ${version} AND status = 'approved'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? toSkillRecord(row) : null;
}
