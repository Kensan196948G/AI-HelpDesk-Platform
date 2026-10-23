import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from '../apps/api/src/db.js';

/**
 * 端末エージェント用のデバイストークンを発行する（管理者が1回だけ実行）。
 *
 *   NODE_ENV=production npx tsx scripts/issue-device-token.ts \
 *     --email user@example.com --out ~/.config/ai-helpdesk/device-agent.json
 *
 * --out を指定した場合は既存の JSON 設定に deviceToken を追記し、値を画面へ出さない。
 * 指定しない場合はトークンを標準出力へ1回だけ出す（再表示はできない）。
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const email = arg('--email')?.trim().toLowerCase();
const label = arg('--label')?.trim() || 'endpoint-agent';
const out = arg('--out') ? path.resolve(arg('--out') as string) : undefined;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('使い方: tsx scripts/issue-device-token.ts --email <email> [--out <json>]');
  process.exit(1);
}

const token = `aihd_${randomBytes(32).toString('base64url')}`;
const tokenHash = createHash('sha256').update(token).digest('hex');

await sql`
  INSERT INTO device_tokens (token_hash, user_email, label)
  VALUES (${tokenHash}, ${email}, ${label})
  ON CONFLICT (token_hash) DO NOTHING
`;

if (out) {
  mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  if (existsSync(out)) {
    try {
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      console.error(`[device-token] ${out} を JSON として読めませんでした。上書きします。`);
    }
  }
  current.deviceToken = token;
  writeFileSync(out, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`[device-token] ${email} のデバイストークンを ${out} に保存しました。`);
} else {
  console.log(token);
}

await sql.end({ timeout: 5 });
