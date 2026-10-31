import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./backup-db.sh', import.meta.url));
const PASSWORD = 'synthetic-secret-1';
const URL_LINE = `DATABASE_URL=postgresql://synth:${PASSWORD}@127.0.0.1:5435/synth_db`;

let dir;
let backupDir;
let binDir;
let argvLog;

function stub(name, body) {
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function run(conf) {
  const envFile = path.join(dir, 'api.conf');
  writeFileSync(envFile, conf);
  return spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: {
      HOME: dir,
      PATH: '/usr/bin:/bin',
      AIHD_ENV_FILE: envFile,
      AIHD_BACKUP_DIR: backupDir,
      AIHD_PG_BIN: binDir,
      AIHD_BACKUP_KEEP_DAYS: '14',
    },
  });
}

const dumps = () => readdirSync(backupDir).filter((name) => name !== 'backup.log');
const log = () => readFileSync(path.join(backupDir, 'backup.log'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aihd-backup-test-'));
  backupDir = path.join(dir, 'backups');
  binDir = path.join(dir, 'bin');
  argvLog = path.join(dir, 'argv.log');
  mkdirSync(binDir);
  // 引数と環境を記録し、--file= の先へ書き込む合成の pg_dump。
  stub(
    'pg_dump',
    `echo "$*" >> "${argvLog}"; echo "env:$PGHOST:$PGPORT:$PGUSER:$PGDATABASE:\${#PGPASSWORD}" >> "${argvLog}"
for a in "$@"; do case "$a" in --file=*) printf 'dump' > "\${a#--file=}";; esac; done`,
  );
  stub('pg_restore', 'exit 0');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backup-db.sh（合成の pg_dump / pg_restore）', () => {
  it('値に | を含む EnvironmentFile でも失敗しない（終了コード 127 の回帰）', () => {
    const result = run(`A=1\nSHARED_IDENTITY_GROUPS=a@example.com|b@example.com\n${URL_LINE}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(dumps()).toHaveLength(1);
    expect(dumps()[0]).toMatch(/^synth_db-\d{8}-\d{6}\.dump$/);
    expect(log()).toMatch(/ OK db=synth_db file=.* bytes=4 sha256=[0-9a-f]{64} keep=14d/);
  });

  it('設定ファイルをシェルとして実行しない', () => {
    const marker = path.join(dir, 'pwned');
    const result = run(`X=$(touch ${marker})\n\`touch ${marker}\`\n${URL_LINE}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(dir)).not.toContain('pwned');
  });

  it('接続情報をプロセス引数・ログ・標準出力へ出さず、libpq の環境変数で渡す', () => {
    const result = run(`${URL_LINE}\n`);
    expect(result.status, result.stderr).toBe(0);
    const argv = readFileSync(argvLog, 'utf8');
    expect(argv).not.toContain(PASSWORD);
    expect(argv).not.toContain('postgresql://');
    expect(argv).toContain(`env:127.0.0.1:5435:synth:synth_db:${PASSWORD.length}`);
    expect(log()).not.toContain(PASSWORD);
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
  });

  it('引用符付きの値と URL エンコードされたパスワードを解釈する', () => {
    const result = run('DATABASE_URL="postgresql://synth:a%40b@127.0.0.1:5435/synth_db"\n');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(argvLog, 'utf8')).toContain(':3\n');
  });

  it('同じキーは最後の行を採用する', () => {
    const result = run(`DATABASE_URL=postgresql://x:y@h/old_db\n${URL_LINE}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(dumps()[0]).toMatch(/^synth_db-/);
  });

  it('DATABASE_URL がない・不正なら dump せず失敗を記録する', () => {
    expect(run('A=1\n').status).toBe(2);
    expect(run('DATABASE_URL=mysql://x/y\n').status).toBe(2);
    expect(run('DATABASE_URL=postgresql://x:y@h/bad%2Fname\n').status).toBe(2);
    expect(dumps()).toEqual([]);
    expect(log()).toMatch(/FAIL stage=config exit=2/);
  });

  it('pg_dump の失敗では dump を残さず、古い dump も消さない', () => {
    const old = path.join(backupDir, 'synth_db-20200101-000000.dump');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(old, 'old');
    utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    stub(
      'pg_dump',
      'for a in "$@"; do case "$a" in --file=*) printf partial > "${a#--file=}";; esac; done; exit 3',
    );
    const result = run(`${URL_LINE}\n`);
    expect(result.status).toBe(3);
    expect(dumps()).toEqual(['synth_db-20200101-000000.dump']);
    expect(log()).toMatch(/FAIL stage=dump exit=3/);
  });

  it('目録を読めない dump は成功扱いにせず、古い dump も消さない', () => {
    const old = path.join(backupDir, 'synth_db-20200101-000000.dump');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(old, 'old');
    utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    stub('pg_restore', 'exit 1');
    const result = run(`${URL_LINE}\n`);
    expect(result.status).toBe(1);
    expect(dumps()).toEqual(['synth_db-20200101-000000.dump']);
    expect(log()).toMatch(/FAIL stage=verify exit=1/);
    expect(log()).not.toMatch(/ OK /);
  });

  it('保持期間を超えた同じ DB の dump だけを消す', () => {
    mkdirSync(backupDir, { recursive: true });
    for (const name of [
      'synth_db-20200101-000000.dump',
      'other_db-20200101-000000.dump',
      'note.txt',
    ]) {
      writeFileSync(path.join(backupDir, name), 'old');
      utimesSync(path.join(backupDir, name), new Date('2020-01-01'), new Date('2020-01-01'));
    }
    const recent = path.join(backupDir, 'synth_db-20990101-000000.dump');
    writeFileSync(recent, 'recent');
    const result = run(`${URL_LINE}\n`);
    expect(result.status, result.stderr).toBe(0);
    const names = dumps();
    expect(names).not.toContain('synth_db-20200101-000000.dump');
    expect(names).toContain('other_db-20200101-000000.dump');
    expect(names).toContain('note.txt');
    expect(names).toContain('synth_db-20990101-000000.dump');
  });
});
