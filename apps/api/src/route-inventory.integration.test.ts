import { randomUUID } from 'node:crypto';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from './config.js';
import { buildServer } from './server.js';

/**
 * 閉じ忘れの検出（docs/67、docs/68 §8）。
 *
 * 試験全体は経路②を試すため RESOLVE_PATH_MODE=on で動く。そのままでは、既定の off で閉じるべき
 * 新しい経路を足しても気づけない。ここでは端末操作に関わる接頭辞の「変更する経路」をすべて列挙し、
 * 次のどちらかに分類されていることを求める。分類の無い経路が増えたら失敗する。
 *
 * - closed: 既定（②は off、③は無効）で新しい実行を作らない。実際に呼んで、閉じた応答を確かめる。
 * - allowed: 既定でも開いてよい（結果の受付、停止、読み取り専用の情報など）。理由を書く。
 */
const SCOPED_PREFIXES = [
  '/api/resolve',
  '/api/device',
  '/api/folder-access',
  '/api/support-sessions',
  '/api/remote-support',
];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Closed = {
  kind: 'closed';
  payload: Record<string, unknown>;
  /** 既定（off）での応答。 */
  off: { status: number; code?: string };
  /** 経路②の drain での応答（②の経路だけ）。 */
  drain?: { status: number; code: string };
};
type Allowed = { kind: 'allowed'; reason: string };

const OFF_404 = { status: 404 } as const;
const RESOLVE_OFF = { status: 404, code: 'RESOLVE_PATH_DISABLED' } as const;
const RESOLVE_DRAIN = { status: 409, code: 'RESOLVE_PATH_DRAINING' } as const;
const Y = { decision: 'Y' };

const ROUTES: Record<string, Closed | Allowed> = {
  // 経路②（resolve と端末コマンド）
  'POST /api/resolve/sessions': {
    kind: 'closed',
    payload: {},
    off: RESOLVE_OFF,
    drain: RESOLVE_DRAIN,
  },
  'POST /api/resolve/steps/:id/approve': {
    kind: 'closed',
    payload: Y,
    off: RESOLVE_OFF,
    drain: RESOLVE_DRAIN,
  },
  'POST /api/resolve/steps/:id/continue': {
    kind: 'closed',
    payload: Y,
    off: RESOLVE_OFF,
    drain: RESOLVE_DRAIN,
  },
  'POST /api/resolve/steps/:id/admin-approve': {
    kind: 'closed',
    payload: Y,
    off: RESOLVE_OFF,
    drain: RESOLVE_DRAIN,
  },
  'POST /api/device/command': { kind: 'closed', payload: {}, off: { status: 410 } },
  'POST /api/resolve/sessions/:id/stop': {
    kind: 'allowed',
    reason: '停止は止めない（新しい実行を作らない）',
  },
  'POST /api/resolve/sessions/:id/escalate': {
    kind: 'allowed',
    reason: '担当者への引継ぎの記録。新しい実行を作らない',
  },
  'POST /api/resolve/sessions/:id/resolve': {
    kind: 'allowed',
    reason: '解決したかの記録。新しい実行を作らない',
  },
  'POST /api/resolve/knowledge-guide': {
    kind: 'allowed',
    reason: '承認済みナレッジの案内。端末を操作しない',
  },
  'POST /api/device/command/:id/result': {
    kind: 'allowed',
    reason: '配送済みのコマンドの結果の受付は止めない（結果不明を作らない）',
  },
  'POST /api/device/agent': {
    kind: 'allowed',
    reason: '端末エージェントの PC 情報の送信（読み取り専用の情報）',
  },
  'POST /api/device/browser': { kind: 'allowed', reason: 'ブラウザで取得した端末情報の保存' },
  // 経路③（フォルダ一覧と共通支援セッション）。無効時は全経路が 404。
  'POST /api/folder-access/requests': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/folder-access/requests/:id/consent': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/folder-access/requests/:id/end': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/folder-access/requests/:id/enroll-code': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/folder-access/requests/:id/list': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/folder-access/requests/:id/pair': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/folder-access/requests/:id/revoke': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/device/agent/folder-helper/register': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/device/agent/folder-helper/revoke': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/device/agent/folder-helper/poll': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/device/agent/folder-helper/ops/:id/start': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/device/agent/folder-helper/ops/:id/result': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/device/agent/folder-helper/ops/:id/skill-result': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/support-sessions': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/support-sessions/:id/consents/ai-input': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/support-sessions/:id/consents/ai-input/revoke': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/support-sessions/:id/consents/operation': {
    kind: 'closed',
    payload: {},
    off: OFF_404,
  },
  'POST /api/support-sessions/:id/proposals': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/support-sessions/:id/proposals/:proposalId/decision': {
    kind: 'closed',
    payload: Y,
    off: OFF_404,
  },
  'POST /api/support-sessions/:id/resolution': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/support-sessions/:id/revoke': { kind: 'closed', payload: {}, off: OFF_404 },
  'POST /api/support-sessions/:id/stop': { kind: 'closed', payload: {}, off: OFF_404 },
  // 対象外（担当者による RSP の遠隔支援。docs/22）。経路②③の実行を作らない。
  'POST /api/remote-support/lookup': { kind: 'allowed', reason: 'RSP の端末の検索（担当者のみ）' },
  'POST /api/remote-support/link': {
    kind: 'allowed',
    reason: 'RSP の端末の紐付けの保存（担当者のみ）',
  },
  'POST /api/remote-support/ensure': {
    kind: 'allowed',
    reason: 'RSP の導入確認（担当者のみ）。経路②③の実行ではない',
  },
};

const EMAIL = 'route-inventory@example.com';
let app: FastifyInstance;
const registered: string[] = [];
const saved = {
  devEmail: config.DEV_AUTH_EMAIL,
  adminAllowlist: config.RESOLVE_ADMIN_ALLOWLIST,
  resolveMode: config.RESOLVE_PATH_MODE,
  folder: config.FOLDER_ACCESS_ENABLED,
  assistMode: config.ASSIST_SESSION_MODE,
};

beforeAll(async () => {
  config.DEV_AUTH_EMAIL = EMAIL;
  // 管理者の承認は権限の確認が先に走るので、管理者として呼ぶ（閉じているかだけを確かめる）。
  config.RESOLVE_ADMIN_ALLOWLIST = EMAIL;
  app = await buildServer({
    logger: false,
    onRoute: (route: RouteOptions) => {
      for (const method of [route.method].flat()) registered.push(`${method} ${route.url}`);
    },
  });
  await app.ready();
});

afterAll(async () => {
  config.DEV_AUTH_EMAIL = saved.devEmail;
  config.RESOLVE_ADMIN_ALLOWLIST = saved.adminAllowlist;
  config.RESOLVE_PATH_MODE = saved.resolveMode;
  config.FOLDER_ACCESS_ENABLED = saved.folder;
  config.ASSIST_SESSION_MODE = saved.assistMode;
  await app.close();
});

function setDefaults(resolveMode: 'off' | 'drain'): void {
  config.RESOLVE_PATH_MODE = resolveMode;
  config.FOLDER_ACCESS_ENABLED = false;
  config.ASSIST_SESSION_MODE = 'off';
}

function concreteUrl(path: string): string {
  return path.replace(/:[A-Za-z]+/g, () => randomUUID());
}

async function call(key: string, payload: Record<string, unknown>) {
  const [method, path] = key.split(' ') as [string, string];
  const response = await app.inject({
    method: method as 'POST',
    url: concreteUrl(path),
    payload,
  });
  let code: string | undefined;
  try {
    code = response.json()?.error?.code;
  } catch {
    code = undefined;
  }
  return { status: response.statusCode, code };
}

describe('経路の閉じ忘れの検出', () => {
  it('端末操作に関わる変更の経路は、すべて閉じるか開いてよいかに分類されている', () => {
    const scoped = registered.filter((entry) => {
      const [method, path] = entry.split(' ') as [string, string];
      return MUTATING.has(method) && SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix));
    });
    expect(scoped.length).toBeGreaterThan(0);
    const unclassified = scoped.filter((entry) => !(entry in ROUTES));
    expect(unclassified, '分類の無い経路（ROUTES に closed か allowed で追加する）').toEqual([]);
    // 分類だけ残って経路が消えたもの（名前の変更で試験が空振りしないように）。
    const stale = Object.keys(ROUTES).filter((key) => !scoped.includes(key));
    expect(stale, '登録されていない経路の分類').toEqual([]);
  });

  const closed = Object.entries(ROUTES).filter(
    (entry): entry is [string, Closed] => entry[1].kind === 'closed',
  );

  it.each(closed)('既定（②は off、③は無効）では %s が閉じている', async (key, spec) => {
    setDefaults('off');
    const result = await call(key, spec.payload);
    expect(result.status, key).toBe(spec.off.status);
    if (spec.off.code) expect(result.code, key).toBe(spec.off.code);
  });

  const drained = closed.filter(([, spec]) => spec.drain);
  it.each(drained)('経路②の drain では %s が新規を受け付けない', async (key, spec) => {
    setDefaults('drain');
    const result = await call(key, spec.payload);
    expect(result.status, key).toBe(spec.drain?.status);
    expect(result.code, key).toBe(spec.drain?.code);
  });
});
