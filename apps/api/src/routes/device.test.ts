import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../db.js';
import { browserInputToInventory } from '../domain/device.js';
import { storeDeviceInventory } from '../lib/device-inventory.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { buildServer } from '../server.js';

const EMAIL = 'dev@example.com';
const agentToken = `aihd_test_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const AGENT_DEVICE = 'route-browser-1';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
  await sql`DELETE FROM device_inventories WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM device_tokens WHERE user_email = ${EMAIL}`;
  const hash = createHash('sha256').update(agentToken).digest('hex');
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label)
    VALUES (${hash}, ${EMAIL}, 'test')
  `;
});

afterAll(async () => {
  await app.close();
});

const browserPayload = {
  deviceId: 'route-browser-1',
  platform: 'Windows',
  os: 'Windows 11 (15.0.0)',
  arch: 'x86 64-bit',
  browser: {
    name: 'Google Chrome',
    version: '141.0.0',
    userAgent: 'Mozilla/5.0 test',
    languages: ['ja-JP'],
    timezone: 'Asia/Tokyo',
  },
  hardware: {
    cpuCores: 8,
    deviceMemoryGB: 16,
    screen: { width: 1920, height: 1080, pixelRatio: 1, colorDepth: 24 },
    gpu: { vendor: 'Intel', name: 'Iris Xe' },
    network: { online: true, effectiveType: '4g' },
    mediaDevices: { audioOutput: 2 },
  },
  software: { pdfViewer: true, cookiesEnabled: true },
  collectedAt: new Date().toISOString(),
};

const agentPayload = {
  deviceId: 'route-agent-1',
  hostname: 'PC-ROUTE-01',
  os: 'Windows 11 Pro 23H2',
  platform: 'Windows',
  arch: 'x86 64-bit',
  hardware: {
    serial: 'SN-ROUTE',
    assetNo: 'PC-ROUTE-9999',
    model: 'Test Model',
    cpu: { model: 'Intel Core i7', logicalCores: 12, usagePercent: 20 },
    memory: { totalBytes: 32 * 1024 ** 3, usagePercent: 50 },
    disks: [{ mount: 'C:', totalBytes: 512 * 1024 ** 3, freeBytes: 200 * 1024 ** 3 }],
    network: { adapters: [{ name: 'VPN', status: 'up', vpn: true }], online: true },
    uptimeSeconds: 3600,
  },
  software: [
    { name: 'Microsoft Teams', version: '25.1.0', publisher: 'Microsoft' },
    { name: 'Microsoft 365 Apps', version: '16.0.18324', publisher: 'Microsoft' },
  ],
  security: {
    antivirus: { enabled: true, name: 'Microsoft Defender' },
    diskEncryption: { enabled: true, detail: 'BitLocker' },
    windowsUpdate: { pending: 0 },
  },
  browserDeviceId: 'route-browser-1',
  collectedAt: new Date().toISOString(),
};

describe('device routes', () => {
  it('ブラウザ取得を保存し、実スナップショットを返す', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/browser',
      payload: browserPayload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.inventory.source).toBe('browser');
    expect(body.snapshot.items.length).toBeGreaterThanOrEqual(31);
    const os = body.snapshot.items.find((item: { k: string }) => item.k === 'OS');
    expect(os.v).toContain('Windows 11');

    const get = await app.inject({
      method: 'GET',
      url: '/api/device/inventory?deviceId=route-browser-1',
    });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().snapshot.items.length).toBeGreaterThanOrEqual(31);
  });

  it('デバイストークン付きのエージェント情報を取り込み、ブラウザ情報とマージする', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: agentPayload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.linked).toBe(true);
    expect(body.inventory.source).toBe('agent');
    expect(body.snapshot.device).toBe('PC-ROUTE-01');
    const teams = body.snapshot.items.find((item: { k: string }) => item.k === 'Teams');
    expect(teams.v).toContain('Microsoft Teams');

    const get = await app.inject({
      method: 'GET',
      url: '/api/device/inventory?deviceId=route-browser-1',
    });
    const merged = get.json();
    expect(merged.inventory.source).toBe('agent');
    expect(merged.inventory.softwareCount).toBe(2);
    expect(merged.snapshot.items.length).toBeGreaterThanOrEqual(31);
  });

  it('U+0000 を含む端末情報でも 500 にならず、保存時に除去する', async () => {
    // 2026-10-27: Windows エージェントの文字列に NUL が混ざり、jsonb への INSERT が
    // `unsupported Unicode escape sequence` で 500 になっていた。取り込み境界で落とす。
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: {
        ...agentPayload,
        deviceId: 'route-agent-nul',
        hostname: 'PC-NUL\u0000-01',
        software: [{ name: 'Broken\u0000 App', version: '1.0' }],
        browserDeviceId: undefined,
        collectedAt: new Date().toISOString(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);

    const rows = await sql<{ hostname: string; data: unknown }[]>`
      SELECT hostname, data FROM device_inventories
      WHERE user_email = ${EMAIL} AND device_id = 'route-agent-nul'
      LIMIT 1
    `;
    expect(rows[0]?.hostname).toBe('PC-NUL-01');
    expect(JSON.stringify(rows[0]?.data)).not.toContain('\\u0000');
  });

  it('別端末の未リンクエージェントはブラウザのスナップショットを上書きしない', async () => {
    // 直前のテストでリンク済み agent が残っているため、未リンクの検証前に取り除く。
    await sql`
      DELETE FROM device_inventories
      WHERE user_email = ${EMAIL} AND source = 'agent' AND device_id = 'route-browser-1'
    `;
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: {
        ...agentPayload,
        deviceId: 'route-server-ubuntu',
        hostname: 'SERVER-UBUNTU',
        os: 'Ubuntu 24.04.4 LTS',
        platform: 'Linux',
        software: [{ name: 'Ubuntu Package', version: '1.0' }],
        browserDeviceId: undefined,
        collectedAt: new Date().toISOString(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().linked).toBe(false);

    const get = await app.inject({
      method: 'GET',
      url: '/api/device/inventory?deviceId=route-browser-1',
    });
    expect(get.statusCode, get.body).toBe(200);
    const body = get.json();
    expect(body.inventory.source).toBe('browser');
    const os = body.snapshot.items.find((item: { k: string }) => item.k === 'OS');
    expect(os.v).toContain('Windows 11');
    const teams = body.snapshot.items.find((item: { k: string }) => item.k === 'Teams');
    expect(teams.v).toBe('端末エージェント未導入');
  });

  it('不正なデバイストークンは 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent',
      headers: { 'x-device-token': 'invalid-token-invalid-token' },
      payload: agentPayload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('必須項目のないブラウザ情報は 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/browser',
      payload: { platform: 'Windows' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('実PC情報があるユーザーの案件は demo ではなく実スナップショットを使う', async () => {
    const email = 'kimura@example.com';
    const inventory = browserInputToInventory({
      deviceId: 'case-browser-1',
      platform: 'Windows',
      os: 'Windows 11 (15.0.0)',
      browser: { name: 'Google Chrome', version: '141.0.0' },
      hardware: {
        cpuCores: 8,
        deviceMemoryGB: 16,
        screen: { width: 1920, height: 1080, pixelRatio: 1, colorDepth: 24 },
      },
      collectedAt: new Date().toISOString(),
    });
    await storeDeviceInventory(email, inventory);
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: process.env.SEED_PASSWORD ?? '' },
      });
      expect(login.statusCode, login.body).toBe(200);
      const raw = login.headers['set-cookie'];
      const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0];
      expect(cookie).toBeTruthy();

      const created = await app.inject({
        method: 'POST',
        url: '/api/cases',
        headers: { cookie: cookie as string },
        payload: {
          category: 'pc_network',
          subject: 'PC が重い',
          body: 'ブラウザで作業していると重くなります',
          urgency: 'normal',
          pcEnabled: true,
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const body = created.json();
      expect(body.case.pc.source).toBe('browser');
      expect(body.case.pc.itemCount).toBeGreaterThanOrEqual(31);
    } finally {
      await sql`DELETE FROM device_inventories WHERE user_email = ${email}`;
    }
  });
});

/** 閉じる前に作られて残っている行（Skill の情報なし）を再現する。 */
async function queuedLegacyCommand(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO device_commands (user_email, op_id, params)
    VALUES (${EMAIL}, 'SPOOLER_RESTART', '{}'::jsonb)
    RETURNING id
  `;
  return rows[0]?.id ?? '';
}

describe('device command channel', () => {
  let commandId = '';

  beforeAll(async () => {
    await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL}`;
    await sql`DELETE FROM device_inventories WHERE user_email = ${EMAIL}`;
  });

  it('画面からコマンドを作る経路は閉じている（行を作らない）', async () => {
    const before = await sql`SELECT id FROM device_commands WHERE user_email = ${EMAIL}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/command',
      payload: { opId: 'SPOOLER_RESTART' },
    });
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().error.code).toBe('DEVICE_COMMAND_CLOSED');
    const after = await sql`SELECT id FROM device_commands WHERE user_email = ${EMAIL}`;
    expect(after.length).toBe(before.length);
    commandId = await queuedLegacyCommand();
  });

  it('端末エージェントが取得すると delivered になり、二重配信しない', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
    });
    expect(res.statusCode, res.body).toBe(200);
    const command = res.json().command;
    expect(command.id).toBe(commandId);
    // 既存の SPOOLER_RESTART は解決ループの skill 情報を持たない（null で返る）。
    expect(command.skill_id).toBeNull();
    expect(command.skill_version).toBeNull();
    expect(command.session_id).toBeNull();
    expect(command.step_id).toBeNull();
    const again = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
    });
    expect(again.statusCode).toBe(204);
  });

  it('結果を報告すると done になり、UI から確認できる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${commandId}/result`,
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: { ok: true, result: { platform: 'win32' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().command.status).toBe('done');
    const status = await app.inject({ method: 'GET', url: `/api/device/command/${commandId}` });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().command.status).toBe('done');
    expect(status.json().command.result.platform).toBe('win32');
  });

  it('不正なデバイストークンは 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': 'invalid-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('配信前の結果報告は 404', async () => {
    const id = await queuedLegacyCommand();
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Skill コマンドは skill_id / skill_version / session_id / step_id を返す', async () => {
    // 先行テストが残した queued 行の影響を受けないように消してから検証する。
    await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL} AND status = 'queued'`;
    const sessionId = randomUUID();
    const stepId = randomUUID();
    await sql`
      INSERT INTO resolution_sessions (id, user_email, case_id, device_id, status, expires_at)
      VALUES (${sessionId}, ${EMAIL}, 'CASE-DEVICE-TEST', ${AGENT_DEVICE}, 'waiting_execute', now() + interval '30 minutes')
      ON CONFLICT (id) DO NOTHING
    `;
    // 解決ループのコマンドは step の期限を満たすときだけ配信される（Phase C）。
    await sql`
      INSERT INTO resolution_steps
        (id, session_id, seq, skill_id, skill_version, skill_content_hash, params,
         rationale, risk_level, status, nonce, approval_expires_at, deadline_at)
      VALUES
        (${stepId}, ${sessionId}, 1, 'os.info', '1.0.0', 'sha256:unknown', '{}'::jsonb,
         'test', 1, 'approved', 'test-nonce', now() + interval '5 minutes',
         now() + interval '60 seconds')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO device_commands
        (user_email, device_id, op_id, params, skill_id, skill_version, session_id, step_id)
      VALUES
        (${EMAIL}, 'route-browser-1', 'os.info', '{}'::jsonb, 'os.info', '1.0.0',
         ${sessionId}, ${stepId})
    `;
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
    });
    expect(res.statusCode, res.body).toBe(200);
    const command = res.json().command;
    expect(command.op_id).toBe('os.info');
    expect(command.skill_id).toBe('os.info');
    expect(command.skill_version).toBe('1.0.0');
    expect(command.session_id).toBe(sessionId);
    expect(command.step_id).toBe(stepId);
    expect(command.params).toEqual({});
  });

  it('端末IDが一致しないコマンドは取得できない', async () => {
    await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL} AND status = 'queued'`;
    await sql`
      INSERT INTO device_commands (user_email, device_id, op_id, params)
      VALUES (${EMAIL}, 'other-device', 'SPOOLER_RESTART', '{}'::jsonb)
    `;
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
    });
    expect(res.statusCode).toBe(204);
  });

  it('トークンに紐づく端末IDと異なる名乗りは 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken, 'x-device-id': 'forged-device' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DEVICE_MISMATCH');
  });

  it('別端末宛コマンドの結果報告は 403', async () => {
    const id = await queuedLegacyCommand();
    await sql`
      UPDATE device_commands SET status = 'delivered', device_id = 'other-device' WHERE id = ${id}
    `;
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE },
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DEVICE_MISMATCH');
  });
});

// ── 権限分離（Migration 016 / docs/25 §12・§17-2） ─────────────────────
// 昇格必須（skills.requires->>'elevation' = 'true'）のコマンドを standard トークンへ
// 配信しないこと、結果送信も権限一致を要求することをサーバ側で証明する。
const adminToken = `aihd_admin_test_${Math.random().toString(36).slice(2)}_${Date.now()}`;

describe('device command privilege 分離', () => {
  const asStandard = { 'x-device-token': agentToken, 'x-device-id': AGENT_DEVICE };
  const asAdmin = { 'x-device-token': adminToken, 'x-device-id': AGENT_DEVICE };

  /** queued を消してテスト間の干渉を防ぐ。 */
  async function resetCommands(): Promise<void> {
    await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL}`;
  }

  async function insertCommand(options: {
    opId: string;
    skillId?: string | null;
    skillVersion?: string | null;
    sessionId?: string | null;
    stepId?: string | null;
  }): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO device_commands
        (user_email, device_id, op_id, params, skill_id, skill_version, session_id, step_id)
      VALUES
        (${EMAIL}, ${AGENT_DEVICE}, ${options.opId}, '{}'::jsonb,
         ${options.skillId ?? null}, ${options.skillVersion ?? null},
         ${options.sessionId ?? null}, ${options.stepId ?? null})
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('device_command insert failed');
    return id;
  }

  /** queued を順に取り出して skill_id の集合を返す（204 まで）。 */
  async function drain(headers: Record<string, string>): Promise<string[]> {
    const delivered: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/device/command', headers });
      if (res.statusCode === 204) break;
      expect(res.statusCode, res.body).toBe(200);
      delivered.push(String(res.json().command.skill_id ?? '(none)'));
    }
    return delivered;
  }

  beforeAll(async () => {
    await resetCommands();
    // 標準トークンは上の beforeAll で privilege 未指定（= 既定 standard）のまま。
    await sql`DELETE FROM device_tokens WHERE user_email = ${EMAIL} AND privilege = 'admin'`;
    const hash = createHash('sha256').update(adminToken).digest('hex');
    await sql`
      INSERT INTO device_tokens (token_hash, user_email, label, privilege)
      VALUES (${hash}, ${EMAIL}, 'test-admin', 'admin')
    `;
  });

  afterAll(async () => {
    await resetCommands();
    await sql`DELETE FROM device_tokens WHERE user_email = ${EMAIL} AND privilege = 'admin'`;
    await sql`DELETE FROM skills WHERE id LIKE 'test.elev.%'`;
  });

  it('device_tokens.privilege は standard 既定で、CHECK で 2 値に限定される', async () => {
    const rows = await sql<{ privilege: string }[]>`
      SELECT privilege FROM device_tokens WHERE token_hash = ${createHash('sha256').update(agentToken).digest('hex')}
    `;
    expect(rows[0]?.privilege).toBe('standard');

    const badHash = createHash('sha256').update(`${adminToken}-bad`).digest('hex');
    await expect(
      sql`
        INSERT INTO device_tokens (token_hash, user_email, label, privilege)
        VALUES (${badHash}, ${EMAIL}, 'bad', 'root')
      `,
    ).rejects.toThrow(/device_tokens_privilege_check/);
    await sql`DELETE FROM device_tokens WHERE token_hash = ${badHash}`;
  });

  it('standard には昇格必須コマンドが配信されず、admin だけが受信する', async () => {
    await resetCommands();
    const standardId = await insertCommand({ opId: 'SPOOLER_RESTART' });
    const elevatedId = await insertCommand({
      opId: 'spooler.restart',
      skillId: 'spooler.restart',
      skillVersion: '1.0.0',
    });

    // admin は昇格必須だけを受け取る（skill_id なしの既存経路は標準専用）。
    const adminFirst = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: asAdmin,
    });
    expect(adminFirst.statusCode, adminFirst.body).toBe(200);
    expect(adminFirst.json().command.id).toBe(elevatedId);
    expect(adminFirst.json().command.skill_id).toBe('spooler.restart');

    // standard は昇格必須を受け取らず、昇格不要の 1 件だけを受け取る。
    const standard = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: asStandard,
    });
    expect(standard.statusCode, standard.body).toBe(200);
    expect(standard.json().command.id).toBe(standardId);
    expect(standard.json().command.skill_id).toBeNull();

    // 昇格必須コマンドは standard に 1 件も配信されていない（空になる）。
    const again = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: asStandard,
    });
    expect(again.statusCode).toBe(204);
  });

  it('解決ループ由来の昇格必須コマンド（session/step 付き）は standard に配信されない', async () => {
    await resetCommands();
    const sessionId = randomUUID();
    const stepId = randomUUID();
    await sql`
      INSERT INTO resolution_sessions (id, user_email, case_id, device_id, status, expires_at)
      VALUES (${sessionId}, ${EMAIL}, 'CASE-PRIV-TEST', ${AGENT_DEVICE}, 'waiting_execute',
              now() + interval '30 minutes')
    `;
    await sql`
      INSERT INTO resolution_steps
        (id, session_id, seq, skill_id, skill_version, skill_content_hash, params,
         rationale, risk_level, status, nonce, approval_expires_at, deadline_at)
      VALUES
        (${stepId}, ${sessionId}, 1, 'spooler.queue.purge', '1.0.0', 'sha256:unknown',
         '{}'::jsonb, 'test', 3, 'approved', 'test-nonce-priv',
         now() + interval '5 minutes', now() + interval '60 seconds')
    `;
    try {
      const id = await insertCommand({
        opId: 'spooler.queue.purge',
        skillId: 'spooler.queue.purge',
        skillVersion: '1.0.0',
        sessionId,
        stepId,
      });

      const standard = await app.inject({
        method: 'GET',
        url: '/api/device/command',
        headers: asStandard,
      });
      expect(standard.statusCode, standard.body).toBe(204);

      const admin = await app.inject({
        method: 'GET',
        url: '/api/device/command',
        headers: asAdmin,
      });
      expect(admin.statusCode, admin.body).toBe(200);
      expect(admin.json().command.id).toBe(id);
      expect(admin.json().command.session_id).toBe(sessionId);
      expect(admin.json().command.step_id).toBe(stepId);
    } finally {
      await sql`DELETE FROM device_commands WHERE session_id = ${sessionId}`;
      await sql`DELETE FROM resolution_sessions WHERE id = ${sessionId}`;
    }
  });

  it('requires.elevation の型ゆれ（boolean / 文字列）を同じ昇格必須として扱う', async () => {
    await resetCommands();
    // jsonb へは jsonbValue（= sql.json）でオブジェクトを渡す。文字列を ::jsonb で
    // キャストすると JSON 文字列として二重エンコードされ、elevation が「無い」扱いに
    // なる（その場合は standard へ倒れる = fail-closed。下の double ケースで固定する）。
    const cases: { id: string; requires: Record<string, unknown> }[] = [
      { id: 'test.elev.bool', requires: { elevation: true } },
      { id: 'test.elev.string', requires: { elevation: 'true' } },
      { id: 'test.elev.false', requires: { elevation: false } },
      { id: 'test.elev.missing', requires: { userConfirm: true } },
      { id: 'test.elev.double', requires: { elevation: true } },
    ];
    try {
      for (const item of cases) {
        // double だけは二重エンコードを再現する（文字列として渡す）。
        const requires =
          item.id === 'test.elev.double' ? JSON.stringify(item.requires) : item.requires;
        await sql`
          INSERT INTO skills (id, version, title, script_path, requires, status)
          VALUES (${item.id}, '1.0.0', 'test', 'scripts/skills/windows/os-info.ps1',
                  ${jsonbValue(requires)}, 'draft')
          ON CONFLICT (id, version) DO UPDATE SET requires = EXCLUDED.requires
        `;
        await insertCommand({ opId: item.id, skillId: item.id, skillVersion: '1.0.0' });
      }

      const standardSkills = await drain(asStandard);
      expect(standardSkills.sort()).toEqual([
        'test.elev.double',
        'test.elev.false',
        'test.elev.missing',
      ]);
      const adminSkills = await drain(asAdmin);
      expect(adminSkills.sort()).toEqual(['test.elev.bool', 'test.elev.string']);
    } finally {
      await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL}`;
      await sql`DELETE FROM skills WHERE id LIKE 'test.elev.%'`;
    }
  });

  it('standard が昇格必須コマンドの結果を送ると 403（状態は変わらない）', async () => {
    await resetCommands();
    const id = await insertCommand({
      opId: 'spooler.restart',
      skillId: 'spooler.restart',
      skillVersion: '1.0.0',
    });
    await sql`UPDATE device_commands SET status = 'delivered' WHERE id = ${id}`;

    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: asStandard,
      payload: { ok: true, result: { restarted: true } },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('PRIVILEGE_MISMATCH');

    const rows = await sql<{ status: string }[]>`
      SELECT status FROM device_commands WHERE id = ${id}
    `;
    expect(rows[0]?.status).toBe('delivered');

    // 正しい権限（admin）なら同じコマンドの結果を報告できる。
    const ok = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: asAdmin,
      payload: { ok: true, result: { restarted: true } },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().command.status).toBe('done');
  });

  it('admin が昇格不要コマンドの結果を送っても 403', async () => {
    await resetCommands();
    const id = await insertCommand({ opId: 'SPOOLER_RESTART' });
    await sql`UPDATE device_commands SET status = 'delivered' WHERE id = ${id}`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: asAdmin,
      payload: { ok: true },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('PRIVILEGE_MISMATCH');
  });

  it('他ユーザーのコマンドは従来どおり 404（権限エラーで存在を漏らさない）', async () => {
    await resetCommands();
    const id = await insertCommand({
      opId: 'spooler.restart',
      skillId: 'spooler.restart',
      skillVersion: '1.0.0',
    });
    await sql`UPDATE device_commands SET status = 'delivered' WHERE id = ${id}`;
    await sql`UPDATE device_commands SET user_email = 'other-priv@example.com' WHERE id = ${id}`;
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/device/command/${id}/result`,
        headers: asStandard,
        payload: { ok: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    } finally {
      await sql`DELETE FROM device_commands WHERE id = ${id}`;
    }
  });
});
