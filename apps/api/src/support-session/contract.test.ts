import { describe, expect, it } from 'vitest';
import { canonicalOpJson, signOp } from '../folder-access/sign.js';
import {
  canonicalParamsJson,
  canonicalSkillRunJson,
  type SignableSkillRun,
  SkillResultBodySchema,
  signSkillRun,
} from './contract.js';

/**
 * Windows 担当と共有する固定ベクトル（Node で生成）。
 * 値を変えるときは PowerShell 側のテストも同時に変える。実在の値を入れない。
 */

const KEY = 'test-helper-token-not-a-secret';

const BASE: SignableSkillRun = {
  canon: 'skill_run/1',
  opId: 'op-0001',
  requestId: 'req-0001',
  supportSessionId: 'ss-0001',
  proposalId: 'prop-0001',
  stepSeq: 1,
  role: 'main',
  sid: 'S-1-5-21-1000-2000-3000-1001',
  sessionId: 2,
  machineGuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  operation: 'skill_run',
  skillId: 'folder.summary',
  skillVersion: '1.0.0',
  contentHash: `sha256:${'a'.repeat(64)}`,
  scriptHash: `sha256:${'b'.repeat(64)}`,
  paramsJson: '{"target":"T1"}',
  targetRoot: 'Documents',
  targetSegments: [],
  startNonce: 'nonce-0001-not-a-secret',
  expiresAt: '2026-11-01T00:00:00.000Z',
  maxSeconds: 60,
  maxOutputBytes: 8192,
};

const VECTORS: { name: string; op: SignableSkillRun; sig: string }[] = [
  {
    name: 'フォルダ対象・セグメントなし',
    op: BASE,
    sig: 'f00c3a5a6e12c1dd71e9f072dc81576018de2d2df6af6da48d556f2ccd297ee5',
  },
  {
    name: '非 ASCII のセグメント',
    op: { ...BASE, opId: 'op-0002', targetSegments: ['資料', '2026年度 計画', 'テスト😀'] },
    sig: 'a489c7af6f413e16a2aa330a2c658f3415df26c8c7ea7a27c8d415109a2d824d',
  },
  {
    name: '対象なし・確認操作',
    op: {
      ...BASE,
      opId: 'op-0003',
      role: 'verify',
      skillId: 'user.marker.status',
      paramsJson: '{}',
      targetRoot: null,
    },
    sig: 'd482093fffe5496ead5c5f5de4bfa84f14ad4ba1375d4edee89827ffb389f03f',
  },
  {
    name: 'エスケープの境界（params は文字列として二重にエスケープされる）',
    op: {
      ...BASE,
      opId: 'op-0004',
      paramsJson: canonicalParamsJson({ z: 'q"b\\s/<&>\'', a: 1, m: true }),
      targetSegments: ['q"b\\s/<&>\'', '\n\t\b\f\r\x01\x7f', '\u2028\u2029é'],
    },
    sig: 'b211f49c9bf231fe93abfc2e0b3cd0eed4c4650adaedd8c492b9e0cba3bbda44',
  },
];

describe('skill_run の正準形と署名（固定ベクトル）', () => {
  it.each(VECTORS)('$name', ({ op, sig }) => {
    expect(signSkillRun(KEY, op)).toBe(sig);
  });

  it('正準形はこのキー順で空白がない', () => {
    expect(canonicalSkillRunJson(BASE)).toBe(
      '{"canon":"skill_run/1","opId":"op-0001","requestId":"req-0001","supportSessionId":"ss-0001",' +
        '"proposalId":"prop-0001","stepSeq":1,"role":"main","sid":"S-1-5-21-1000-2000-3000-1001",' +
        '"sessionId":2,"machineGuid":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","operation":"skill_run",' +
        `"skillId":"folder.summary","skillVersion":"1.0.0","contentHash":"sha256:${'a'.repeat(64)}",` +
        `"scriptHash":"sha256:${'b'.repeat(64)}","paramsJson":"{\\"target\\":\\"T1\\"}",` +
        '"targetRoot":"Documents","targetSegments":[],"startNonce":"nonce-0001-not-a-secret",' +
        '"expiresAt":"2026-11-01T00:00:00.000Z","maxSeconds":60,"maxOutputBytes":8192}',
    );
  });

  it('list_metadata の署名を skill_run に流用できない（既存の正準形も変わらない）', () => {
    const legacy = {
      opId: 'op-0001',
      requestId: 'req-0001',
      sid: BASE.sid,
      sessionId: 2,
      root: 'Documents',
      segments: [] as string[],
      operation: 'list_metadata',
      expiresAt: BASE.expiresAt,
    };
    expect(canonicalOpJson(legacy).startsWith('{"opId":')).toBe(true);
    expect(signOp(KEY, legacy)).not.toBe(signSkillRun(KEY, BASE));
  });

  it('params は順序によらず同じ正準形になり、入れ子を拒否する', () => {
    expect(canonicalParamsJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
    expect(() => canonicalParamsJson({ a: { nested: true } })).toThrow();
    expect(() => canonicalParamsJson({ a: 1.5 })).toThrow();
  });
});

describe('結果の本文', () => {
  const body = {
    executionMode: 'real',
    actorSid: BASE.sid,
    sessionId: 2,
    skillId: 'folder.summary',
    skillVersion: '1.0.0',
    scriptHash: BASE.scriptHash,
    status: 'ok',
    resultCode: 'OK',
    exitCode: 0,
    startedAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:00:01.000Z',
    elapsedMs: 1000,
    output: { accessible: true },
  };

  it('正しい本文を受ける', () => {
    expect(SkillResultBodySchema.safeParse(body).success).toBe(true);
  });

  it('resultCode は固定コードだけ（パスや自由文を入れられない）', () => {
    expect(SkillResultBodySchema.safeParse({ ...body, resultCode: 'C:\\Users\\x' }).success).toBe(
      false,
    );
  });

  it('executionMode は必須', () => {
    const { executionMode: _omitted, ...rest } = body;
    expect(SkillResultBodySchema.safeParse(rest).success).toBe(false);
  });
});
