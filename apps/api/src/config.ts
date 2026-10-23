import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

// 本番（systemd）では Environment= を優先し、ローカルの .env.local を読み込まない。
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const localEnvFile = isTest ? '.env.test.local' : '.env.local';
if (!isProduction && existsSync(path.join(repoRoot, localEnvFile))) {
  loadEnv({ path: path.join(repoRoot, localEnvFile), override: true });
} else {
  loadEnv({ path: path.join(repoRoot, '.env') });
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(18950),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PROXY_SECRET: z.string().min(16).optional(),
  REQUIRE_PROXY_SECRET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z.string().default(''),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOG_LEVEL: z.string().default('info'),
  COMMIT_SHA: z.string().optional(),
  // 認証: local（開発/テスト）または cloudflare-access（本番/Preview）
  AUTH_MODE: z.enum(['local', 'cloudflare-access']).default('local'),
  DEV_AUTH_EMAIL: z.string().email().default('dev@example.com'),
  // アクセス許可リストの正本（完全一致メール / @domain）。repo ルート相対。
  ACCESS_ALLOWLIST_FILE: z.string().trim().min(1).default('docs/MailAddress.txt'),
  // 非推奨: 単一メール指定。許可リストは ACCESS_ALLOWLIST_FILE に統一した。
  ACCESS_ALLOWED_EMAIL: z.string().email().optional(),
  // DeepSeek API（MVP / Staging のみ）
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  // ヘルプデスクの一次回答は速度と安定性を優先し、既定では thinking を無効にする。
  DEEPSEEK_THINKING: z.enum(['disabled', 'enabled']).default('disabled'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] 環境変数が不足しています:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.ACCESS_ALLOWED_EMAIL) {
  console.warn(
    '[config] ACCESS_ALLOWED_EMAIL は非推奨です。許可リストは ACCESS_ALLOWLIST_FILE（既定: docs/MailAddress.txt）が正本です。',
  );
}
if (parsed.data.AUTH_MODE === 'cloudflare-access') {
  console.info(
    `[config] アクセス許可リスト: ${parsed.data.ACCESS_ALLOWLIST_FILE}（Cloudflare Access の allow ポリシーと同じ内容にすること）`,
  );
}
if (!parsed.data.DEEPSEEK_API_KEY) {
  console.warn(
    '[config] DEEPSEEK_API_KEY が未設定です。AI 回答は承認済みナレッジのフォールバックになります。',
  );
}

export const config = {
  ...parsed.data,
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction,
};
