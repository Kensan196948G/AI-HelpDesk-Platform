import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../config.js';
import { readSkillScriptHash } from './skill-source.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe('スクリプトのハッシュ（実ファイル）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aihd-skill-source-'));
  const file = path.join(dir, 'skill.ps1');
  const relative = path.relative(repoRoot, file);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const reads = () => vi.mocked(readFileSync).mock.calls.filter((call) => call[0] === file).length;

  it('変更がなければ読み直さない', () => {
    writeFileSync(file, 'first');
    const hash = readSkillScriptHash(relative);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const count = reads();
    expect(readSkillScriptHash(relative)).toBe(hash);
    expect(reads()).toBe(count);
  });

  it('変更を検知する（同じサイズでも、時刻を戻しても）', () => {
    writeFileSync(file, 'aaaa');
    const before = readSkillScriptHash(relative);
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(file, stamp, stamp);
    const stamped = readSkillScriptHash(relative);
    expect(stamped).toBe(before);
    writeFileSync(file, 'bbbb');
    utimesSync(file, stamp, stamp);
    expect(readSkillScriptHash(relative)).not.toBe(before);
  });

  it('ファイルが無ければ null（未承認として扱う）', () => {
    rmSync(file, { force: true });
    expect(readSkillScriptHash(relative)).toBeNull();
  });
});
