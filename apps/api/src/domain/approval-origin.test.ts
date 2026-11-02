import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import {
  APPROVAL_ORIGIN_LABEL,
  approvalOriginLabel,
  approvalOriginOf,
  SEED_USER_IDS,
} from './approval-origin.js';

const STAFF = 'aaaaaaaa-0000-4000-8000-000000000001';
const APPROVER = 'aaaaaaaa-0000-4000-8000-000000000002';
const GROUPS = 'one@example.test|two@example.test';

describe('承認の出所（固定語彙）', () => {
  it('作成者と承認者がどちらもシードの利用者なら seed', () => {
    expect(
      approvalOriginOf(
        {
          authorId: SEED_USER_IDS.sato,
          approverId: SEED_USER_IDS.watanabe,
          authorEmail: 'sato@example.com',
          approverEmail: 'watanabe@example.com',
        },
        '',
      ),
    ).toBe('seed');
  });

  it('メールのドメインでは判定しない（@example.com の別人の承認は other_person）', () => {
    expect(
      approvalOriginOf(
        {
          authorId: STAFF,
          approverId: APPROVER,
          authorEmail: 'real-a@example.com',
          approverEmail: 'real-b@example.com',
        },
        '',
      ),
    ).toBe('other_person');
  });

  it('片方だけシードの利用者なら seed にしない', () => {
    expect(
      approvalOriginOf(
        {
          authorId: STAFF,
          approverId: SEED_USER_IDS.watanabe,
          authorEmail: 'real-a@example.test',
          approverEmail: 'watanabe@example.com',
        },
        '',
      ),
    ).toBe('other_person');
  });

  it('同一人物の別アカウントなら shared_identity', () => {
    expect(
      approvalOriginOf(
        {
          authorId: STAFF,
          approverId: APPROVER,
          authorEmail: 'one@example.test',
          approverEmail: 'two@example.test',
        },
        GROUPS,
      ),
    ).toBe('shared_identity');
  });

  it('表示は事実だけを書き、シードと同一人物を「別の担当者」と言わない', () => {
    expect(APPROVAL_ORIGIN_LABEL.other_person).toBe('別の担当者が承認');
    expect(APPROVAL_ORIGIN_LABEL.shared_identity).toBe('同一人物の別アカウントが承認');
    expect(APPROVAL_ORIGIN_LABEL.seed).toBe('初期登録の資料（人の承認記録なし）');
    expect(approvalOriginLabel(undefined)).toBe('出所を確認できません');
    expect(approvalOriginLabel('unknown')).toBe('出所を確認できません');
  });

  it('シードの利用者の ID は scripts/seed.ts が使う値と同じ', () => {
    const seed = readFileSync(path.join(repoRoot, 'scripts/seed.ts'), 'utf8');
    expect(seed).toContain('SEED_USER_IDS');
    expect(Object.keys(SEED_USER_IDS).length).toBe(6);
  });
});
