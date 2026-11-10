import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 実 systemd には触れない。PATH 先頭の偽 systemctl と一時 HOME だけで検証する。
const smtpScript = fileURLToPath(new URL('./set-smtp-password.sh', import.meta.url));
const PROD = 'ai-helpdesk-prod-api.service';
const LEGACY = 'ai-helpdesk-api.service';
const OLD_PASS = 'oldoldoldoldoldo';
const NEW_PASS = 'abcdefghijklmnop';

let dir;
let binDir;
let logPath;
let confPath;

function writeStub(name, body) {
  writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  chmodSync(path.join(binDir, name), 0o755);
}

/** is-active --quiet は env で指定した状態、restart 後の is-active は成功を模す。 */
function writeFakeSystemctl() {
  // bash の ${...} を JS 文字列に混ぜないため、既定値は runSmtp の env 側で与える。
  writeStub(
    'systemctl',
    [
      'printf \'%s\\n\' "$*" >> "$SMTP_TEST_LOG"',
      'last=""',
      'for arg in "$@"; do last="$arg"; done',
      'if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then',
      '  case " $* " in',
      '    *" --quiet "*)',
      '      case "$last" in',
      `        ${PROD}) exit "$SMTP_TEST_PROD_ACTIVE" ;;`,
      `        ${LEGACY}) exit "$SMTP_TEST_LEGACY_ACTIVE" ;;`,
      '      esac',
      '      exit 1 ;;',
      '  esac',
      '  exit "$SMTP_TEST_IS_ACTIVE_AFTER"',
      'fi',
      'if [ "$1" = "--user" ] && [ "$2" = "restart" ]; then',
      '  exit "$SMTP_TEST_RESTART_STATUS"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  // 実 sleep を待たない（systemd 操作ではない）。
  writeStub('sleep', 'exit 0\n');
}

function runSmtp({ args = [], env = {} } = {}) {
  return spawnSync('/bin/bash', [smtpScript, '--conf', confPath, '--skip-verify', ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      HOME: dir,
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      SMTP_PASS: NEW_PASS,
      SMTP_TEST_LOG: logPath,
      // 既定は「両 unit inactive・restart 成功・再起動後の確認も成功」。
      SMTP_TEST_PROD_ACTIVE: '1',
      SMTP_TEST_LEGACY_ACTIVE: '1',
      SMTP_TEST_IS_ACTIVE_AFTER: '0',
      SMTP_TEST_RESTART_STATUS: '0',
      ...env,
    },
  });
}

function systemctlLines() {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
}

function confText() {
  return readFileSync(confPath, 'utf8');
}

function backupFiles() {
  return readdirSync(dir).filter((name) => name.startsWith('api.conf.bak-'));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aihd-smtp-test-'));
  binDir = path.join(dir, 'bin');
  mkdirSync(binDir);
  logPath = path.join(dir, 'systemctl.log');
  confPath = path.join(dir, 'api.conf');
  writeFileSync(confPath, `SMTP_USER=user@example.test\nSMTP_PASS=${OLD_PASS}\n`, {
    mode: 0o600,
  });
  chmodSync(confPath, 0o600);
  writeFakeSystemctl();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('set-smtp-password.sh: 再起動対象の決定と失敗時の通知', () => {
  it('両 unit とも inactive なら設定を書かず exit 1（restart も呼ばない）', () => {
    const result = runSmtp({
      env: { SMTP_TEST_PROD_ACTIVE: '1', SMTP_TEST_LEGACY_ACTIVE: '1' },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('active な unit が見つかりません');
    expect(result.stderr).toContain('SMTP_PASS は未更新');
    // 書き換え前の fail-closed: 設定もバックアップも作られない。
    expect(confText()).toContain(`SMTP_PASS=${OLD_PASS}`);
    expect(backupFiles()).toEqual([]);
    expect(systemctlLines()).toEqual([
      `--user is-active --quiet -- ${PROD}`,
      `--user is-active --quiet -- ${LEGACY}`,
    ]);
  });

  it('両 unit active なら --unit を促して exit 1（設定は不変）', () => {
    const result = runSmtp({
      env: { SMTP_TEST_PROD_ACTIVE: '0', SMTP_TEST_LEGACY_ACTIVE: '0' },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('active な unit が複数あります');
    expect(result.stderr).toContain('--unit <name>');
    expect(result.stderr).toContain('SMTP_PASS は未更新');
    expect(confText()).toContain(`SMTP_PASS=${OLD_PASS}`);
    expect(systemctlLines().some((line) => line.includes('restart'))).toBe(false);
  });

  it('prod のみ active なら prod を restart し、設定を更新する', () => {
    const result = runSmtp({
      env: { SMTP_TEST_PROD_ACTIVE: '0', SMTP_TEST_LEGACY_ACTIVE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ai-helpdesk-prod-api を再起動しました');
    expect(systemctlLines()).toEqual([
      `--user is-active --quiet -- ${PROD}`,
      `--user is-active --quiet -- ${LEGACY}`,
      `--user restart -- ${PROD}`,
      `--user is-active -- ${PROD}`,
    ]);
    expect(confText()).toContain(`SMTP_PASS=${NEW_PASS}`);
    expect(result.stdout + result.stderr).not.toContain(NEW_PASS);
  });

  it('--unit 指定は active 判定を飛ばしてその unit を restart する', () => {
    const result = runSmtp({
      args: ['--unit', PROD],
      env: { SMTP_TEST_PROD_ACTIVE: '1', SMTP_TEST_LEGACY_ACTIVE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(systemctlLines()).toEqual([`--user restart -- ${PROD}`, `--user is-active -- ${PROD}`]);
    expect(confText()).toContain(`SMTP_PASS=${NEW_PASS}`);
  });

  it('restart が失敗しても exit 1 で「SMTP_PASS は更新済み」を伝える', () => {
    const result = runSmtp({
      env: {
        SMTP_TEST_PROD_ACTIVE: '0',
        SMTP_TEST_LEGACY_ACTIVE: '1',
        SMTP_TEST_RESTART_STATUS: '1',
      },
    });
    // set -e の素の restart では即 abort して stderr が空になり、この案内へ到達しない。
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`❌ ${PROD} の再起動に失敗しました`);
    expect(result.stderr).toContain('SMTP_PASS は更新済み');
    expect(confText()).toContain(`SMTP_PASS=${NEW_PASS}`);
    expect(systemctlLines()).toEqual([
      `--user is-active --quiet -- ${PROD}`,
      `--user is-active --quiet -- ${LEGACY}`,
      `--user restart -- ${PROD}`,
    ]);
  });

  it('--no-restart は active な unit が無くても設定更新だけで成功する（既存互換）', () => {
    const result = runSmtp({
      args: ['--no-restart'],
      env: { SMTP_TEST_PROD_ACTIVE: '1', SMTP_TEST_LEGACY_ACTIVE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(confText()).toContain(`SMTP_PASS=${NEW_PASS}`);
    expect(systemctlLines()).toEqual([]);
  });

  it.each([['bad/unit'], ['-h'], ['--version'], ['']])(
    '--unit に %j を渡すと exit 2 で systemctl を呼ばない',
    (badUnit) => {
      const result = runSmtp({ args: ['--unit', badUnit] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unit 名が不正です');
      expect(systemctlLines()).toEqual([]);
      expect(confText()).toContain(`SMTP_PASS=${OLD_PASS}`);
    },
  );
});
