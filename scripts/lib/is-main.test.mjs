import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isMainModule } from './is-main.mjs';

describe('isMainModule', () => {
  it('実パスが一致すれば true', () => {
    const url = pathToFileURL('/tmp/a/script.mjs').href;
    expect(isMainModule(url, '/tmp/a/script.mjs', (p) => p)).toBe(true);
  });

  it('argv1 が undefined なら false', () => {
    expect(isMainModule('file:///tmp/a/script.mjs', undefined, (p) => p)).toBe(false);
  });

  it('argv1 が空文字なら false', () => {
    expect(isMainModule('file:///tmp/a/script.mjs', '', (p) => p)).toBe(false);
  });

  it('importMetaUrl が file: 以外なら false', () => {
    expect(isMainModule('node:internal', '/tmp/a/script.mjs', (p) => p)).toBe(false);
  });

  it('別ファイルなら false', () => {
    const url = pathToFileURL('/tmp/a/script.mjs').href;
    expect(isMainModule(url, '/tmp/a/other.mjs', (p) => p)).toBe(false);
  });

  it('symlink 経由の argv1 でも実パスへ解決して true（回帰）', () => {
    const self = '/home/x/app/releases/20261106T000000-abcdef/scripts/proxy.mjs';
    const viaLink = '/home/x/app/current/scripts/proxy.mjs';
    const realpath = (p) => (p === viaLink ? self : p);
    expect(isMainModule(pathToFileURL(self).href, viaLink, realpath)).toBe(true);
  });

  it('realpath が失敗した場合は raw 比較にフォールバックする', () => {
    const url = pathToFileURL('/tmp/b/script.mjs').href;
    const throwing = () => {
      throw new Error('ENOENT');
    };
    // 文字列が一致すれば true（実パス解決に失敗しても raw 比較で救う）
    expect(isMainModule(url, '/tmp/b/script.mjs', throwing)).toBe(true);
    expect(isMainModule(url, '/tmp/b/other.mjs', throwing)).toBe(false);
  });

  it('相対 argv1 は実パス解決結果で一致する', () => {
    const self = '/tmp/c/scripts/x.mjs';
    const realpath = (p) => (p === 'scripts/x.mjs' ? self : p);
    expect(isMainModule(pathToFileURL(self).href, 'scripts/x.mjs', realpath)).toBe(true);
  });

  describe('実ファイルシステム上の symlink 解決', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aihd-ismain-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('実 symlink 経由の argv1 を解決して true', () => {
      const realDir = path.join(root, 'releases', 'r1');
      const linkDir = path.join(root, 'current');
      mkdirSync(realDir, { recursive: true });
      mkdirSync(linkDir, { recursive: true });
      const real = path.join(realDir, 'tool.mjs');
      writeFileSync(real, '// noop\n');
      const link = path.join(linkDir, 'tool.mjs');
      symlinkSync(real, link);

      expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
      // 対照: 別ファイルは false
      expect(isMainModule(pathToFileURL(real).href, path.join(root, 'other.mjs'))).toBe(false);
    });
  });
});
