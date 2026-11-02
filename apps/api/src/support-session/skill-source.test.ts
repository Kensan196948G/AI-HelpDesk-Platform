import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../config.js';
import { loadApprovalManifest, readSkillScriptHash } from './skill-source.js';

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

  describe('承認の manifest', () => {
    const manifestFile = path.join(dir, 'approved.json');
    const manifestReads = () =>
      vi.mocked(readFileSync).mock.calls.filter((call) => call[0] === manifestFile).length;
    const write = (id: string) =>
      writeFileSync(manifestFile, JSON.stringify({ version: 1, skills: [{ id }] }));

    it('変更がなければ読み直さず、変更を検知する', () => {
      write('a');
      expect(loadApprovalManifest(manifestFile).skills[0]?.id).toBe('a');
      const count = manifestReads();
      loadApprovalManifest(manifestFile);
      loadApprovalManifest(manifestFile);
      expect(manifestReads()).toBe(count);
      write('b');
      expect(loadApprovalManifest(manifestFile).skills[0]?.id).toBe('b');
    });

    it('無い・壊れたファイルは空（未承認）', () => {
      writeFileSync(manifestFile, '{broken');
      expect(loadApprovalManifest(manifestFile).skills).toEqual([]);
      rmSync(manifestFile, { force: true });
      expect(loadApprovalManifest(manifestFile).skills).toEqual([]);
    });
  });

  it('検証用 manifest は明示したときだけ追加し、本番では読まない', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aihd-verify-manifest-'));
    const extra = path.join(dir, 'extra.json');
    writeFileSync(extra, JSON.stringify({ version: 1, skills: [{ id: 'synth.only' }] }));
    const original = {
      manifest: process.env.ASSIST_VERIFICATION_MANIFEST,
      env: process.env.NODE_ENV,
    };
    const has = () => loadApprovalManifest().skills.some((skill) => skill.id === 'synth.only');
    try {
      delete process.env.ASSIST_VERIFICATION_MANIFEST;
      expect(has()).toBe(false);
      process.env.ASSIST_VERIFICATION_MANIFEST = extra;
      expect(has()).toBe(true);
      process.env.NODE_ENV = 'production';
      expect(has()).toBe(false);
    } finally {
      if (original.manifest === undefined) delete process.env.ASSIST_VERIFICATION_MANIFEST;
      else process.env.ASSIST_VERIFICATION_MANIFEST = original.manifest;
      process.env.NODE_ENV = original.env;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
