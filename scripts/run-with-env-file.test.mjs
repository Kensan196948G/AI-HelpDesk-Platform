import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEnvironmentFile } from './run-with-env-file.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('run-with-env-file', () => {
  it('シェルとして解釈しない', () => {
    const marker = path.join(dir, 'should-not-exist');
    const env = parseEnvironmentFile(
      `# コメント\n\nA=x|touch ${marker}\nB="引用 符"\nC=$(id)\nD='y'\n`,
    );
    expect(env).toEqual({ A: `x|touch ${marker}`, B: '引用 符', C: '$(id)', D: 'y' });
  });

  it('形式が正しくない行は、値を出さずに止める', () => {
    expect(() => parseEnvironmentFile('not-a-secret-value')).toThrow(/値は表示しません/);
    try {
      parseEnvironmentFile('secret-value-123');
    } catch (error) {
      expect(String(error)).not.toContain('secret-value-123');
    }
  });

  it('コマンドへ環境を渡し、終了コードを返す。既存の環境を優先する', () => {
    const file = path.join(dir, 'api.conf');
    const marker = path.join(dir, 'marker');
    writeFileSync(file, `GROUPS_X=a|touch ${marker}\nKEEP=from-file\n`);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/run-with-env-file.mjs',
        file,
        '--',
        process.execPath,
        '-e',
        'process.stdout.write(process.env.GROUPS_X.split("|")[0]+process.env.KEEP);process.exit(7)',
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, KEEP: 'existing' } },
    );
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('aexisting');
    expect(spawnSync('test', ['-e', marker]).status).toBe(1);
  });
});
