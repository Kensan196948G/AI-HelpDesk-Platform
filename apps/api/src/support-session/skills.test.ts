import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import { readApprovalManifest } from '../resolve/skills.js';
import { ASSIST_SKILLS, normalizeSkillOutput, resolveApprovedSkill } from './skills.js';
import { folderReasonForSessionEnd, isNoProgress, terminalStatusForSession } from './state.js';

/** 実際の scripts/skills/approved.json を読む（Mock なし）。書き込まない。 */
describe('本経路の Skill の承認', () => {
  const approved = readApprovalManifest(repoRoot).skills;

  it.each(ASSIST_SKILLS.map((skill) => skill.definition.id))(
    '%s は manifest に無ければ承認済みにならない',
    (id) => {
      const inManifest = approved.some((entry) => entry.id === id);
      if (!inManifest) expect(resolveApprovedSkill(id)).toBeNull();
    },
  );

  it('既存の disk.space は既存の承認をそのまま使い、定義を変えていない', () => {
    const resolved = resolveApprovedSkill('disk.space');
    const entry = approved.find((item) => item.id === 'disk.space');
    expect(resolved?.contentHash).toBe(entry?.contentHash);
    expect(resolved?.scriptHash).toBe(entry?.scriptHash);
  });

  it('未登録の Skill は承認済みにならない', () => {
    expect(resolveApprovedSkill('system.shutdown')).toBeNull();
    expect(resolveApprovedSkill('os.info')).toBeNull();
  });

  it('管理者権限や高リスクの Skill を定義していない', () => {
    for (const skill of ASSIST_SKILLS) {
      const requires = skill.definition.requires as { elevation?: unknown };
      expect(requires.elevation).toBe(false);
      expect(skill.definition.riskLevel).toBeLessThan(4);
    }
  });

  it('変更系は元に戻す Skill と確認操作を持ち、確認操作は読み取りだけ', () => {
    for (const skill of ASSIST_SKILLS.filter((item) => item.effect === 'modify')) {
      expect(skill.definition.rollback).not.toBeNull();
      const ops = skill.verifyOps({ value: 'VERIFY_A' });
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        const target = ASSIST_SKILLS.find((item) => item.definition.id === op.skillId);
        expect(target?.effect).toBe('read');
        expect(target?.verifyOnly).toBe(true);
      }
    }
  });
});

describe('出力の正規化', () => {
  it('許可フィールドの正しい型だけを残す', () => {
    expect(
      normalizeSkillOutput('folder.summary', {
        accessible: true,
        fileCount: 2,
        directoryCount: -1,
        totalBytes: '100',
        name: 'secret.txt',
      }),
    ).toEqual({ accessible: true, fileCount: 2 });
  });

  it('マーカーは固定の形式だけ', () => {
    expect(normalizeSkillOutput('user.marker.status', { value: 'VERIFY_A' })).toEqual({
      value: 'VERIFY_A',
    });
    expect(normalizeSkillOutput('user.marker.status', { value: 'C:\\Users\\x' })).toEqual({});
  });

  it('disk.space は件数と最小の空き容量だけ（ドライブ名を残さない）', () => {
    expect(
      normalizeSkillOutput('disk.space', {
        volumes: [
          { deviceId: 'C:', freeGB: 10, totalGB: 100 },
          { deviceId: 'D:', freeGB: 5, totalGB: 50 },
        ],
      }),
    ).toEqual({ volumeCount: 2, minFreeGB: 5 });
    expect(normalizeSkillOutput('disk.space', { volumes: 'x' })).toEqual({});
  });

  it('disk.space は数値の freeGB を持つ要素だけを数える', () => {
    expect(
      normalizeSkillOutput('disk.space', {
        volumes: [{ deviceId: 'C:', freeGB: null }, { deviceId: 'D:', freeGB: 5 }, null, 'x'],
      }),
    ).toEqual({ volumeCount: 1, minFreeGB: 5 });
    expect(normalizeSkillOutput('disk.space', { volumes: [{ freeGB: null }] })).toEqual({
      volumeCount: 0,
    });
  });

  it('未知の Skill と欠落は空', () => {
    expect(normalizeSkillOutput('unknown', { a: 1 })).toEqual({});
    expect(normalizeSkillOutput('folder.summary', null)).toBeNull();
  });
});

describe('状態の写像', () => {
  it('取消と N は同意を本人の取消として終える', () => {
    expect(folderReasonForSessionEnd('requester_revoked')).toBe('requester_revoked');
    expect(folderReasonForSessionEnd('requester_declined')).toBe('requester_revoked');
    expect(folderReasonForSessionEnd('expired')).toBe('expired');
    expect(folderReasonForSessionEnd('verify_failed')).toBe('operator_end');
  });

  it('N は stopped、取消は revoked、解決は本人の確認だけ', () => {
    expect(terminalStatusForSession('requester_declined')).toBe('stopped');
    expect(terminalStatusForSession('requester_revoked')).toBe('revoked');
    expect(terminalStatusForSession('resolved')).toBe('resolved');
    expect(terminalStatusForSession('ai_stop')).toBe('stopped');
  });

  it('進捗なしは同じコードが 2 回のときだけ', () => {
    expect(isNoProgress('A', 'A')).toBe(true);
    expect(isNoProgress('A', 'B')).toBe(false);
    expect(isNoProgress(null, 'A')).toBe(false);
  });
});
