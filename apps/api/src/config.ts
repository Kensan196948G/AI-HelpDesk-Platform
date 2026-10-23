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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] 環境変数が不足しています:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction,
};
