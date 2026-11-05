import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { assertCurrentTestDatabase, assertTestDatabase } from './lib/test-database-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const isTest = process.env.NODE_ENV === 'test';
if (!isTest) {
  const envFile = process.env.NODE_ENV === 'production' ? null : '.env.local';
  if (envFile && existsSync(path.join(root, envFile))) {
    config({ path: path.join(root, envFile), override: true });
  } else {
    config({ path: path.join(root, '.env') });
  }
}
// test はファイル補完をせず、driver 作成前に明示 URL を検証する。
const testDatabase = assertTestDatabase(process.env);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[migrate] DATABASE_URL が設定されていません。.env.local を用意してください。');
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
  console.error('[migrate] failed:', isTest ? 'test database operation rejected' : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
