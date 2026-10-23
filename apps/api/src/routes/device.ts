import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import {
  agentInputToInventory,
  browserInputToInventory,
  buildPrototypeDeviceSnapshot,
} from '../domain/device.js';
import { ApiError, badRequest, unauthorized } from '../errors.js';
import {
  inventorySummary,
  loadClientInventory,
  resolveBrowserDeviceId,
  storeDeviceInventory,
} from '../lib/device-inventory.js';
import { checkRateLimit, clientAddress } from '../lib/rate-limit.js';

const Int = (min: number, max: number) => z.number().int().min(min).max(max);
const Num = (min: number, max: number) => z.number().min(min).max(max);

const ScreenSchema = z.object({
  width: Int(1, 20000).optional(),
  height: Int(1, 20000).optional(),
  pixelRatio: Num(0.1, 20).optional(),
  colorDepth: Int(1, 64).optional(),
});

const GpuSchema = z.object({
  name: z.string().max(300).optional(),
  vendor: z.string().max(200).optional(),
  driver: z.string().max(200).optional(),
});

const AdapterSchema = z.object({
  name: z.string().max(200),
  type: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  vpn: z.boolean().optional(),
});

const NetworkSchema = z.object({
  adapters: z.array(AdapterSchema).max(80).optional(),
  ipv4: z.array(z.string().max(60)).max(30).optional(),
  online: z.boolean().optional(),
  effectiveType: z.string().max(30).optional(),
  downlinkMbps: Num(0, 100000).optional(),
  rttMs: Num(0, 60000).optional(),
});

const MediaDevicesSchema = z.object({
  audioOutput: Int(0, 100).optional(),
  audioInput: Int(0, 100).optional(),
  videoInput: Int(0, 100).optional(),
});

const PrinterSchema = z.object({
  name: z.string().max(200),
  status: z.string().max(100).optional(),
  jobs: Int(0, 10000).optional(),
});

const BrowserInfoSchema = z.object({
  name: z.string().max(100).optional(),
  version: z.string().max(100).optional(),
  userAgent: z.string().max(1000).optional(),
  languages: z.array(z.string().max(30)).max(20).optional(),
  timezone: z.string().max(100).optional(),
  pdfViewer: z.boolean().optional(),
  cookiesEnabled: z.boolean().optional(),
  maxTouchPoints: Int(0, 100).optional(),
});

const HardwareSchema = z.object({
  assetNo: z.string().max(100).optional(),
  serial: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  domainJoined: z.string().max(200).optional(),
  cpu: z
    .object({
      model: z.string().max(300).optional(),
      cores: Int(1, 4096).optional(),
      logicalCores: Int(1, 4096).optional(),
      speedMHz: Num(0, 100000).optional(),
      usagePercent: Num(0, 100).optional(),
    })
    .optional(),
  memory: z
    .object({
      totalBytes: Num(0, 10 ** 15).optional(),
      freeBytes: Num(0, 10 ** 15).optional(),
      usagePercent: Num(0, 100).optional(),
    })
    .optional(),
  disks: z
    .array(
      z.object({
        name: z.string().max(100).optional(),
        mount: z.string().max(100).optional(),
        totalBytes: Num(0, 10 ** 15).optional(),
        freeBytes: Num(0, 10 ** 15).optional(),
        encrypted: z.boolean().optional(),
      }),
    )
    .max(50)
    .optional(),
  gpu: z.array(GpuSchema).max(20).optional(),
  network: NetworkSchema.optional(),
  battery: z
    .object({ levelPercent: Num(0, 100).optional(), charging: z.boolean().optional() })
    .optional(),
  screen: ScreenSchema.optional(),
  storage: z
    .object({
      quotaBytes: Num(0, 10 ** 15).optional(),
      usageBytes: Num(0, 10 ** 15).optional(),
    })
    .optional(),
  mediaDevices: MediaDevicesSchema.optional(),
  printers: z.array(PrinterSchema).max(100).optional(),
  printSpooler: z.string().max(100).optional(),
  audioOutput: z.string().max(200).optional(),
  usbDevices: Int(0, 1000).optional(),
  uptimeSeconds: Num(0, 10 ** 10).optional(),
  tempBytes: Num(0, 10 ** 15).optional(),
  sharedFolder: z
    .object({
      path: z.string().max(500).optional(),
      accessible: z.boolean().optional(),
    })
    .optional(),
});

const SoftwareAppSchema = z.object({
  name: z.string().trim().min(1).max(300),
  version: z.string().max(100).optional(),
  publisher: z.string().max(200).optional(),
});

const SecuritySchema = z.object({
  antivirus: z
    .object({
      enabled: z.boolean().optional(),
      name: z.string().max(200).optional(),
      signature: z.string().max(200).optional(),
    })
    .optional(),
  diskEncryption: z
    .object({ enabled: z.boolean().optional(), detail: z.string().max(300).optional() })
    .optional(),
  windowsUpdate: z
    .object({
      pending: Int(0, 10000).optional(),
      lastInstalled: z.string().max(100).optional(),
      detail: z.string().max(300).optional(),
    })
    .optional(),
  firewall: z
    .object({ enabled: z.boolean().optional(), detail: z.string().max(300).optional() })
    .optional(),
  recentErrors: Int(0, 1000000).optional(),
});

const BrowserInputSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  platform: z.string().max(100).optional(),
  os: z.string().max(200).optional(),
  arch: z.string().max(60).optional(),
  browser: BrowserInfoSchema.optional(),
  hardware: z
    .object({
      cpuCores: Int(1, 4096).optional(),
      deviceMemoryGB: Num(0, 4096).optional(),
      screen: ScreenSchema.optional(),
      gpu: GpuSchema.optional(),
      storage: z
        .object({
          quotaBytes: Num(0, 10 ** 15).optional(),
          usageBytes: Num(0, 10 ** 15).optional(),
        })
        .optional(),
      battery: z
        .object({ level: Num(0, 1).optional(), charging: z.boolean().optional() })
        .optional(),
      network: NetworkSchema.optional(),
      mediaDevices: MediaDevicesSchema.optional(),
    })
    .optional(),
  software: z
    .object({ pdfViewer: z.boolean().optional(), cookiesEnabled: z.boolean().optional() })
    .optional(),
  collectedAt: z.string().datetime().optional(),
});

const AgentInputSchema = z.object({
  deviceId: z.string().trim().min(1).max(200),
  hostname: z.string().max(200).optional(),
  os: z.string().max(300).optional(),
  platform: z.string().max(100).optional(),
  arch: z.string().max(60).optional(),
  hardware: HardwareSchema.optional(),
  software: z.array(SoftwareAppSchema).max(300).optional(),
  security: SecuritySchema.optional(),
  // UI に表示された WEB-XXXXXXXX（ブラウザ端末）とエージェントをリンクする。
  browserDeviceId: z.string().trim().max(120).optional(),
  collectedAt: z.string().datetime().optional(),
});

const DeviceQuerySchema = z.object({
  deviceId: z.string().trim().max(120).optional(),
});

function deviceTokenFrom(request: FastifyRequest): string | null {
  const raw = request.headers['x-device-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (trimmed.length < 20 || trimmed.length > 200) return null;
  return trimmed;
}

async function authenticateDeviceToken(request: FastifyRequest): Promise<string> {
  const token = deviceTokenFrom(request);
  if (!token) throw unauthorized('端末エージェントのデバイストークンが必要です。');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const rows = await sql<{ user_email: string }[]>`
    SELECT user_email
    FROM device_tokens
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw unauthorized('デバイストークンが無効です。');
  await sql`UPDATE device_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}`;
  return row.user_email;
}

async function snapshotResponse(email: string, browserDeviceId?: string) {
  const merged = await loadClientInventory(email, browserDeviceId);
  if (!merged) return { inventory: null, snapshot: null };
  return {
    inventory: inventorySummary(merged),
    snapshot: buildPrototypeDeviceSnapshot(merged),
  };
}

function asJsonValue<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // ブラウザから取得できる実端末情報（読み取りのみ）。
  app.post(
    '/device/browser',
    { preHandler: authenticateUi, bodyLimit: 256 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const input = BrowserInputSchema.parse(request.body);
      const inventory = browserInputToInventory(input);
      await storeDeviceInventory(request.uiEmail, inventory);
      return { ok: true, ...(await snapshotResponse(request.uiEmail, inventory.deviceId)) };
    },
  );

  // ログイン中ユーザーの最新 PC 情報（ブラウザ + エージェントをマージ）。
  app.get('/device/inventory', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const query = DeviceQuerySchema.parse(request.query);
    return { ok: true, ...(await snapshotResponse(request.uiEmail, query.deviceId)) };
  });

  // 端末エージェントからの取り込み。Access のパス限定アプリ（/api/device/agent）は
  // ブラウザセッションを持たないため、アプリ側のデバイストークンでユーザーに紐づける。
  // ── 実端末コマンド（許可リストのみ） ─────────────────────────────
  // UI が提案の Y 承認後に登録し、端末エージェントが取りに来て実行する。
  // 端末エージェントの経路は Access のサービスドメイン + デバイストークンで守る。
  const CommandBodySchema = z.object({
    opId: z.enum(['SPOOLER_RESTART']),
    params: z.record(z.unknown()).optional(),
  });
  const CommandResultSchema = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(2000).optional(),
  });
  const CommandIdSchema = z.object({ id: z.string().uuid() });

  app.post(
    '/device/command',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      if (!checkRateLimit(`device-command:${request.uiEmail}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'コマンドの要求が多すぎます。少し待ってください。');
      }
      const input = CommandBodySchema.parse(request.body);
      const inventory = await loadClientInventory(request.uiEmail).catch(() => null);
      const rows = await sql<{ id: string }[]>`
      INSERT INTO device_commands (user_email, device_id, op_id, params)
      VALUES (
        ${request.uiEmail},
        ${inventory?.deviceId ?? null},
        ${input.opId},
        ${JSON.stringify(input.params ?? {})}::jsonb
      )
      RETURNING id, op_id, status, device_id, created_at
    `;
      return { ok: true, command: rows[0] };
    },
  );

  // 端末エージェントが次のコマンドを取得する（1件だけ・配信済みに更新）。
  app.get('/device/command', async (request, reply) => {
    const email = await authenticateDeviceToken(request);
    const rows = await sql<{ id: string }[]>`
      UPDATE device_commands
      SET status = 'delivered', delivered_at = now()
      WHERE id = (
        SELECT id FROM device_commands
        WHERE user_email = ${email} AND status = 'queued'
        ORDER BY created_at
        LIMIT 1
      )
      AND status = 'queued'
      RETURNING id, op_id, params, created_at
    `;
    if (!rows[0]) return reply.code(204).send();
    const command = rows[0] as { params?: unknown };
    return { ok: true, command: { ...command, params: asJsonValue(command.params) ?? {} } };
  });

  // 端末エージェントの実行結果。
  app.post('/device/command/:id/result', async (request) => {
    const email = await authenticateDeviceToken(request);
    const { id } = CommandIdSchema.parse(request.params);
    const input = CommandResultSchema.parse(request.body);
    const rows = await sql<{ id: string }[]>`
      UPDATE device_commands
      SET status = ${input.ok ? 'done' : 'failed'},
          result = ${JSON.stringify(input.result ?? null)}::jsonb,
          error = ${input.error ?? null},
          completed_at = now()
      WHERE id = ${id} AND user_email = ${email} AND status = 'delivered'
      RETURNING id, status, result, error, completed_at
    `;
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', '対象のコマンドが見つかりません。');
    const command = rows[0] as { result?: unknown };
    return { ok: true, command: { ...command, result: asJsonValue(command.result) } };
  });

  // UI からの状態確認。
  app.get('/device/command/:id', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const { id } = CommandIdSchema.parse(request.params);
    const rows = await sql<{ id: string }[]>`
      SELECT id, op_id, status, device_id, result, error, created_at, delivered_at, completed_at
      FROM device_commands
      WHERE id = ${id} AND user_email = ${request.uiEmail}
    `;
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', '対象のコマンドが見つかりません。');
    const command = rows[0] as { result?: unknown };
    return { ok: true, command: { ...command, result: asJsonValue(command.result) } };
  });

  app.post('/device/agent', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    if (!checkRateLimit(`device-agent:${clientAddress(request)}`, 30, 60_000)) {
      throw new ApiError(429, 'RATE_LIMITED', '端末エージェントのリクエストが多すぎます。');
    }
    const email = await authenticateDeviceToken(request);
    const input = AgentInputSchema.parse(request.body);
    const inventory = agentInputToInventory(input);
    const linkedDeviceId = input.browserDeviceId
      ? await resolveBrowserDeviceId(email, input.browserDeviceId)
      : null;
    if (linkedDeviceId) inventory.deviceId = linkedDeviceId;
    await storeDeviceInventory(email, inventory);
    request.uiEmail = email;
    if (!linkedDeviceId) {
      return {
        ok: true,
        linked: false,
        inventory: inventorySummary(inventory),
        snapshot: buildPrototypeDeviceSnapshot(inventory),
      };
    }
    return { ok: true, linked: true, ...(await snapshotResponse(email, linkedDeviceId)) };
  });
}
