import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import { sql } from '../db.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import {
  computeScriptHash,
  computeSkillDefinitionHash,
  readApprovalManifest,
  SKILL_CATALOG,
  type SkillRecord,
  type SkillRow,
  toSkillRecord,
} from './skill-catalog.js';

export * from './skill-catalog.js';

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
