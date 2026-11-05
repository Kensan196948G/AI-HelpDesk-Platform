import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const scannerPath = fileURLToPath(new URL('./scan-secrets.sh', import.meta.url));
const projectRoot = dirname(dirname(scannerPath));
const privateOutput = 'SYNTHETIC_SCAN_OUTPUT_MUST_NOT_BE_DISCLOSED';
const scanPattern =
  '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----|CLOUDFLARE_API_TOKEN=[A-Za-z0-9_-]{20,})';
const expectedArguments = [
  '-RInE',
  scanPattern,
  '--exclude-dir=.git',
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=coverage',
  '--exclude=scan-secrets.sh',
  '--exclude=*.map',
  '.',
];

function removeFixture(fixtureRoot, temporaryRoot) {
  // このテスト自身が作った一時ディレクトリ以外は削除しない。
  if (
    realpathSync(fixtureRoot) !== fixtureRoot ||
    dirname(fixtureRoot) !== temporaryRoot ||
    !basename(fixtureRoot).startsWith('aihd-secret-scan-')
  ) {
    throw new Error('一時テストディレクトリの確認に失敗しました。');
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function withStubGrep(status, verify) {
  const temporaryRoot = realpathSync('/tmp');
  const fixtureRoot = mkdtempSync(join(temporaryRoot, 'aihd-secret-scan-'));
  const binPath = join(fixtureRoot, 'bin');
  const invocationPath = join(fixtureRoot, 'grep-invocation.txt');

  try {
    mkdirSync(binPath);
    // PATH に実コマンドを含めず、スクリプトの dirname も固定のスタブにする。
    writeFileSync(join(binPath, 'dirname'), `#!/bin/bash\nprintf '%s\\n' "\${1%/*}"\n`, {
      mode: 0o700,
    });
    if (status !== null) {
      writeFileSync(
        join(binPath, 'grep'),
        [
          '#!/bin/bash',
          'printf \'%s\\n\' "$PWD" "$@" > "$SCAN_STUB_LOG"',
          `printf '%s\\n' 'fixture.env:1:${privateOutput}'`,
          `printf '%s\\n' '${privateOutput}: synthetic diagnostic' >&2`,
          'exit "$SCAN_STUB_STATUS"',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
    }

    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', scannerPath], {
      cwd: fixtureRoot,
      // process.env を継承せず、スタブ専用の非機密値だけを渡す。
      env: {
        PATH: binPath,
        LC_ALL: 'C',
        SCAN_STUB_LOG: invocationPath,
        SCAN_STUB_STATUS: String(status),
      },
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (status !== null) {
      // スタブが実際に実行され、既存の検出式・除外対象が維持されていることも確認する。
      expect(readFileSync(invocationPath, 'utf8').trimEnd().split('\n')).toEqual([
        projectRoot,
        ...expectedArguments,
      ]);
    }
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateOutput);
    verify(result);
  } finally {
    removeFixture(fixtureRoot, temporaryRoot);
  }
}

describe('secret scan の終了値と非開示', () => {
  test.each([
    {
      grepStatus: 0,
      status: 1,
      stdout: '',
      stderr: 'ERROR: potential secret patterns found.\n',
    },
    {
      grepStatus: 1,
      status: 0,
      stdout: 'No obvious secret patterns found.\n',
      stderr: '',
    },
    ...[2, 3, 126, 127, 130, 255].map((grepStatus) => ({
      grepStatus,
      status: 2,
      stdout: '',
      stderr: 'ERROR: secret scan could not be completed.\n',
    })),
  ])('grep 終了値 $grepStatus を scan 終了値 $status にする', (expected) => {
    withStubGrep(expected.grepStatus, (result) => {
      expect(result.status).toBe(expected.status);
      expect(result.stdout).toBe(expected.stdout);
      expect(result.stderr).toBe(expected.stderr);
    });
  });

  test('PATH に grep が存在しなくても検査成功としない', () => {
    withStubGrep(null, (result) => {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('ERROR: secret scan could not be completed.\n');
    });
  });
});
