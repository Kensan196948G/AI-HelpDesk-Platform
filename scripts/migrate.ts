import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const envFile = process.env.NODE_ENV === 'test' ? '.env.test.local' : '.env.local';
if (existsSync(path.join(root, envFile))) {
  config({ path: path.join(root, envFile), override: true });
} else {
  config({ path: path.join(root, '.env') });
}

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
  console.error('[migrate] failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
