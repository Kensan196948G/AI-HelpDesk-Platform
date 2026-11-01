import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_MANIFEST_PATH,
  type ApprovalManifest,
  computeScriptHash,
} from '../apps/api/src/resolve/skills.js';
import {
  approvalCatalog,
  planApproval,
  selectApprovalTargets,
} from '../apps/api/src/support-session/skill-approval.js';

/**
 * Skill の人間レビュー承認を記録する（リポジトリ管理）。
 *
 *   npx tsx scripts/approve-skills.ts --dry-run
 *   npx tsx scripts/approve-skills.ts --by reviewer@example.com --note "2026-11-01 レビュー"
 *   npx tsx scripts/approve-skills.ts --by reviewer@example.com --only folder.summary
 *   npx tsx scripts/approve-skills.ts --by reviewer@example.com --include-verification \
 *     --manifest /path/to/verification-manifest.json
 *
 * - スクリプトと定義（引数・リスク・スキーマ・verify/rollback・出力ポリシー）の
 *   SHA-256 を manifest に保存する。サーバはこれと一致する Skill だけを承認済みとして扱う。
 * - 対象外の行と変更のない行は、以前の承認者と時刻のまま残す（全書換えで失わない）。
 * - 定義を変更したら、このスクリプトを再実行して承認を更新する（変更は自動承認されない）。
 * - 検証用（user.marker.*）は --include-verification のときだけ対象にする。
 *   diag.sleep はカタログに無いので、指定しても承認できない。
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index >= 0 && value && !value.startsWith('--') ? value : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(`[approve-skills] ${message}`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = flag('--dry-run');
const approvedBy = arg('--by');
if (!dryRun && !approvedBy) fail('--by（承認者）は必須です。確認だけなら --dry-run を使います。');
const note = arg('--note') ?? '人間レビュー済み';
const manifestPath = arg('--manifest') ?? path.join(repoRoot, APPROVAL_MANIFEST_PATH);
const only = arg('--only')
  ?.split(',')
  .map((id) => id.trim())
  .filter(Boolean);

let current: ApprovalManifest;
try {
  current = JSON.parse(readFileSync(manifestPath, 'utf8')) as ApprovalManifest;
  if (!Array.isArray(current.skills)) throw new Error('skills が配列ではありません。');
} catch (error) {
  // 読めない manifest を空として上書きすると、以前の承認をすべて失う。
  if ((error as { code?: string }).code !== 'ENOENT') {
    fail(`manifest を読めません: ${(error as Error).message}`);
  }
  current = { version: 1, skills: [] };
}

let targets: ReturnType<typeof selectApprovalTargets>;
try {
  targets = selectApprovalTargets(
    approvalCatalog({ includeVerification: flag('--include-verification') }),
    only ?? null,
  );
} catch (error) {
  fail((error as Error).message);
}

const plan = planApproval({
  current,
  targets,
  hashOf: (scriptPath) => {
    try {
      return computeScriptHash(readFileSync(path.join(repoRoot, scriptPath)));
    } catch {
      return null;
    }
  },
  approvedBy: approvedBy ?? '(dry-run)',
  note,
  now: new Date().toISOString(),
});

for (const change of plan.changes) {
  if (change.kind === 'unchanged' || change.kind === 'retained') continue;
  const hash = change.contentHash ? ` ${change.contentHash.slice(0, 24)}…` : '';
  console.log(`${change.kind.padEnd(14)} ${change.id}@${change.version}${hash}`);
}
const count = (kind: string) => plan.changes.filter((change) => change.kind === kind).length;
console.log(
  `added=${count('added')} updated=${count('updated')} unchanged=${count('unchanged')} ` +
    `retained=${count('retained')} missing_script=${count('missing_script')}`,
);

const missing = plan.changes.filter((change) => change.kind === 'missing_script');
if (only && missing.length > 0) {
  fail(`スクリプトがありません: ${missing.map((change) => change.id).join(', ')}`);
}
if (dryRun) {
  console.log('dry-run: manifest は変更していません。');
} else {
  writeFileSync(manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);
  console.log(`updated ${manifestPath}`);
}
