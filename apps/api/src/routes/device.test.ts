import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../db.js';
import { browserInputToInventory } from '../domain/device.js';
import { storeDeviceInventory } from '../lib/device-inventory.js';
import { buildServer } from '../server.js';

const EMAIL = 'dev@example.com';
const agentToken = `aihd_test_${Math.random().toString(36).slice(2)}_${Date.now()}`;

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
      headers: { 'x-device-token': agentToken },
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

  it('別端末の未リンクエージェントはブラウザのスナップショットを上書きしない', async () => {
    // 直前のテストでリンク済み agent が残っているため、未リンクの検証前に取り除く。
    await sql`
      DELETE FROM device_inventories
      WHERE user_email = ${EMAIL} AND source = 'agent' AND device_id = 'route-browser-1'
    `;
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent',
      headers: { 'x-device-token': agentToken },
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

describe('device command channel', () => {
  let commandId = '';

  beforeAll(async () => {
    await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL}`;
  });

  it('UI がコマンドを登録できる（許可リスト）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/command',
      payload: { opId: 'SPOOLER_RESTART' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.command.op_id).toBe('SPOOLER_RESTART');
    expect(body.command.status).toBe('queued');
    commandId = body.command.id;
  });

  it('端末エージェントが取得すると delivered になり、二重配信しない', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken },
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
      headers: { 'x-device-token': agentToken },
    });
    expect(again.statusCode).toBe(204);
  });

  it('結果を報告すると done になり、UI から確認できる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${commandId}/result`,
      headers: { 'x-device-token': agentToken },
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

  it('許可リスト外の操作は 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/command',
      payload: { opId: 'REBOOT' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('配信前の結果報告は 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/device/command',
      payload: { opId: 'SPOOLER_RESTART' },
    });
    const id = created.json().command.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/device/command/${id}/result`,
      headers: { 'x-device-token': agentToken },
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
      INSERT INTO device_commands
        (user_email, device_id, op_id, params, skill_id, skill_version, session_id, step_id)
      VALUES
        (${EMAIL}, 'route-browser-1', 'os.info', '{}'::jsonb, 'os.info', '1.0.0',
         ${sessionId}, ${stepId})
    `;
    const res = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: { 'x-device-token': agentToken },
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
});
