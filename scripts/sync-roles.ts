/**
 * ロール集合の同期（docs/49）。Access グループのエクスポートなどから作った
 * 「メール → ロール配列」の JSON を `user_roles` に適用する。
 *
 * 使い方:
 *   # 確認のみ（既定・DB は変更しない）
 *   npx tsx scripts/sync-roles.ts --file roles.json
 *   # 反映
 *   npx tsx scripts/sync-roles.ts --file roles.json --apply --by "kensan1969@gmail.com"
 *
 * roles.json の形式（どちらでもよい）:
 *   { "users": { "a@example.com": ["helpdesk", "approver"] } }
 *   { "a@example.com": ["helpdesk", "approver"] }
 *
 * 方針（docs/49）:
 *   - ロールは複数可。`user_roles` を正本とし、users.role は主ロール（後方互換）として残す。
 *   - auditor は他ロールと併存させない（読み取り専用の境界を保つ）。
 *   - 不明なメールは既定でエラー（誤字で権限を付与しない）。`--allow-unknown` で警告に落とす。
 *   - 適用時は 1 トランザクションで user_roles を置き換え、監査 `auth.role.sync` を追記する。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { isRole, validateRoleSet } from '../apps/api/src/auth/role-values.js';
import { computeAuditHash, GENESIS_HASH } from '../apps/api/src/domain/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const envFile =
  process.env.NODE_ENV === 'test'
    ? '.env.test.local'
    : process.env.NODE_ENV === 'production'
      ? null
      : '.env.local';
if (envFile && existsSync(path.join(root, envFile))) {
  config({ path: path.join(root, envFile), override: true });
} else {
  config({ path: path.join(root, '.env') });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[sync-roles] DATABASE_URL が設定されていません。');
  process.exit(1);
}

interface Args {
  file?: string;
  apply: boolean;
  by: string | null;
  allowUnknown: boolean;
  source: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, by: null, allowUnknown: false, source: 'access-group' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--by') args.by = argv[++i] ?? null;
    else if (arg === '--allow-unknown') args.allowUnknown = true;
    else if (arg === '--source') args.source = argv[++i] ?? 'access-group';
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: sync-roles.ts --file roles.json [--apply] [--by <email>] [--allow-unknown]',
      );
      process.exit(0);
    } else {
      console.error(`[sync-roles] 不明な引数です: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.file) {
    console.error('[sync-roles] --file が必要です。');
    process.exit(2);
  }
  return args;
}

function normalizeMapping(raw: unknown): Map<string, string[]> {
  const table =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'users' in raw
      ? (raw as { users: unknown }).users
      : raw;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error('マッピングは { "email": ["role", ...] } のオブジェクトにしてください。');
  }
  const map = new Map<string, string[]>();
  for (const [email, roles] of Object.entries(table as Record<string, unknown>)) {
    const key = email.trim().toLowerCase();
    if (!key.includes('@')) throw new Error(`メール形式ではありません: ${email}`);
    if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
      throw new Error(`${email} のロールは文字列の配列にしてください。`);
    }
    map.set(key, roles as string[]);
  }
  return map;
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

interface UserRow {
  id: string;
  email: string;
  role: string;
}

interface Change {
  userId: string;
  email: string;
  from: string[];
  to: string[];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(args.file, 'utf8')) as unknown;
  const mapping = normalizeMapping(raw);

  // 1) ロール集合の検証（全体）
  for (const [email, roles] of mapping) {
    const problem = validateRoleSet(roles);
    if (problem) {
      console.error(`[sync-roles] ${email}: ${problem}`);
      return 2;
    }
    if (args.source.length === 0) {
      console.error('[sync-roles] --source が空です。');
      return 2;
    }
  }

  // 2) ユーザー解決
  const emails = [...mapping.keys()];
  const users = await sql<UserRow[]>`
    SELECT id, lower(email) AS email, role
    FROM users
    WHERE is_active = true AND lower(email) IN ${sql(emails)}
  `;
  const byEmail = new Map(users.map((user) => [user.email, user]));
  const unknown = emails.filter((email) => !byEmail.has(email));
  if (unknown.length > 0 && !args.allowUnknown) {
    console.error(`[sync-roles] 名簿に無いユーザーです（付与しません）: ${unknown.join(', ')}`);
    console.error('[sync-roles] 意図したものなら --allow-unknown を付けてください。');
    return 2;
  }
  for (const email of unknown) {
    console.warn(`[sync-roles] 未登録のためスキップ: ${email}`);
  }

  // 3) 変更計画
  const currentRows = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM user_roles
    WHERE user_id IN ${sql(users.map((user) => user.id))}
  `;
  const currentByUser = new Map<string, string[]>();
  for (const row of currentRows) {
    currentByUser.set(row.user_id, [...(currentByUser.get(row.user_id) ?? []), row.role]);
  }

  const changes: Change[] = [];
  for (const [email, roles] of mapping) {
    const user = byEmail.get(email);
    if (!user) continue;
    const from = (currentByUser.get(user.id) ?? [user.role]).slice().sort();
    const to = [...roles].sort();
    if (from.length !== to.length || from.some((role, index) => role !== to[index])) {
      changes.push({ userId: user.id, email, from, to });
    }
  }

  console.log(
    `[sync-roles] ${args.apply ? 'APPLY' : 'DRY-RUN'} source=${args.source} users=${mapping.size} changes=${changes.length}`,
  );
  for (const change of changes) {
    console.log(`  ${change.email}: [${change.from.join(', ')}] -> [${change.to.join(', ')}]`);
  }

  if (!args.apply) {
    console.log('[sync-roles] 変更は行っていません（反映するには --apply）。');
    return 0;
  }

  // 4) 適用（1 トランザクション）
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(918273645)`;
    for (const change of changes) {
      await tx`DELETE FROM user_roles WHERE user_id = ${change.userId}`;
      for (const role of change.to) {
        if (!isRole(role)) throw new Error(`不明なロール: ${role}`);
        await tx`
          INSERT INTO user_roles (user_id, role, source, granted_by)
          VALUES (${change.userId}, ${role}, 'sync', ${args.by})
        `;
      }
      // 監査（appendAudit と同じチェーン計算。CLI から使えるようここで行う）
      const last = await tx<
        { hash: string }[]
      >`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`;
      const prevHash = last[0]?.hash ?? GENESIS_HASH;
      const payload = {
        actorId: null,
        action: 'auth.role.sync',
        targetType: 'user',
        targetId: change.userId,
        detail: {
          email: change.email,
          from: change.from,
          to: change.to,
          source: args.source,
          by: args.by,
        },
      };
      const hash = computeAuditHash(prevHash, payload);
      await tx`
        INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, prev_hash, hash)
        VALUES (null, ${payload.action}, ${payload.targetType}, ${payload.targetId},
          ${sql.json(payload.detail)}, ${prevHash}, ${hash})
      `;
    }
  });

  console.log(`[sync-roles] 適用しました（${changes.length} 件変更・監査 auth.role.sync）。`);
  return 0;
}

main()
  .then((code) => sql.end().then(() => process.exit(code)))
  .catch(async (error) => {
    console.error('[sync-roles] 失敗:', error instanceof Error ? error.message : error);
    await sql.end().catch(() => {});
    process.exit(1);
  });
