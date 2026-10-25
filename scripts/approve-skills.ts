import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../apps/api/src/db.js';
import {
  APPROVAL_MANIFEST_PATH,
  computeScriptHash,
  computeSkillDefinitionHash,
  SKILL_CATALOG,
} from '../apps/api/src/resolve/skills.js';

/**
 * Skill の人間レビュー承認を記録する（リポジトリ管理）。
 *
 *   npx tsx scripts/approve-skills.ts --by reviewer@example.com --note "2026-10-25 レビュー"
 *
 * - スクリプトと定義（引数・リスク・スキーマ・verify/rollback・出力ポリシー）の
 *   SHA-256 を `scripts/skills/approved.json` に保存する。
 * - サーバは起動時にこの manifest と一致する Skill だけを approved にする。
 * - 定義を変更したら、このスクリプトを再実行して承認を更新する（変更は自動承認されない）。
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index >= 0 && value && !value.startsWith('--') ? value : undefined;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvedBy = arg('--by') ?? 'skill-review@mirai-const.co.jp';
const note = arg('--note') ?? '人間レビュー済み';
const now = new Date().toISOString();

const skills = SKILL_CATALOG.map((skill) => {
  const script = readFileSync(path.join(repoRoot, skill.scriptPath));
  const scriptHash = computeScriptHash(script);
  return {
    id: skill.id,
    version: skill.version,
    scriptHash,
    contentHash: computeSkillDefinitionHash(skill, scriptHash),
    approvedBy,
    approvedAt: now,
    note,
  };
});

writeFileSync(
  path.join(repoRoot, APPROVAL_MANIFEST_PATH),
  `${JSON.stringify({ version: 1, skills }, null, 2)}\n`,
);
console.log(`approved ${skills.length} skills (${approvedBy})`);
for (const skill of skills) {
  console.log(`${skill.id}@${skill.version} ${skill.contentHash.slice(0, 24)}…`);
}

await sql.end({ timeout: 5 });
