import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import {
  assertCurrentTestDatabase,
  assertTestDatabase,
  isEnvFileTestSwitch,
} from './lib/test-database-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// dotenv 前の値を正本にし、モード判定はこの初期値だけを使う。
const initialNodeEnv = process.env.NODE_ENV;
const isTest = initialNodeEnv === 'test';
if (!isTest) {
  const envFile = initialNodeEnv === 'production' ? null : '.env.local';
  if (envFile && existsSync(path.join(root, envFile))) {
    config({ path: path.join(root, envFile), override: true });
  } else {
    config({ path: path.join(root, '.env') });
  }
}
// 環境ファイルで test を名乗らせない（test 専用ガードのすり抜けを防ぐ）。
if (isEnvFileTestSwitch(initialNodeEnv, process.env.NODE_ENV)) {
  console.error('[migrate] env ファイルで NODE_ENV=test に切り替えることはできません。');
  process.exit(1);
}
// test はファイル補完をせず、driver 作成前に明示 URL を検証する。
const testDatabase = assertTestDatabase(process.env);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // test は .env を読まないため、非 test と案内を分ける。
  console.error(
    isTest
      ? '[migrate] NODE_ENV=test では DATABASE_URL をプロセス環境で明示してください（env ファイルは読みません）。'
      : '[migrate] DATABASE_URL が設定されていません。.env.local を用意してください。',
  );
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  onnotice: () => {},
});

const migrationsDir = path.join(root, 'db', 'migrations');

try {
  if (testDatabase) {
    const rows = await sql<{ database_name: string }[]>`SELECT current_database() AS database_name`;
    assertCurrentTestDatabase(rows[0]?.database_name, testDatabase);
  }
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const appliedRows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip ${file}`);
      continue;
    }
    const content = await readFile(path.join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(content, [], { prepare: false });
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    console.log(`[migrate] applied ${file}`);
  }

  console.log('[migrate] done');
} catch (error) {
  // DB driver の例外に資格情報が含まれ得るため、test の失敗は固定文言だけにする。
  console.error(
    '[migrate] failed:',
    isTest || testDatabase !== undefined ? 'test database operation rejected' : error,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
