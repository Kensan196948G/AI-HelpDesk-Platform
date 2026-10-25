import { timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { allowlistSize, getAllowlist } from './auth/allowlist.js';
import { requireCloudflareAccess } from './auth/ui.js';
import { config } from './config.js';
import { ApiError, forbidden } from './errors.js';
import { resolveRoutes } from './resolve/routes.js';
import { ensureSkillCatalog } from './resolve/skills.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { caseHandoverRoutes } from './routes/case-handovers.js';
import { caseRoutes } from './routes/cases.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { deskRoutes } from './routes/desk.js';
import { deviceRoutes } from './routes/device.js';
import { employeeRoutes } from './routes/employees.js';
import { healthRoutes } from './routes/health.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { meRoutes } from './routes/me.js';
import { prototypeRoutes } from './routes/prototype.js';
import { remoteAssistRoutes } from './routes/remote-assist.js';
import { reportRoutes } from './routes/reports.js';

function secretsMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer(options?: { logger?: boolean }): Promise<FastifyInstance> {
  if (config.REQUIRE_PROXY_SECRET && !config.PROXY_SECRET) {
    throw new Error('REQUIRE_PROXY_SECRET=true の場合は PROXY_SECRET が必要です。');
  }

  const app = Fastify({
    logger:
      options?.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-proxy-secret"]',
              'req.headers["x-device-token"]',
              'res.headers["set-cookie"]',
            ],
          },
    // Cloudflare Tunnel（cloudflared）はループバックから接続する。
    // それ以外の経路から来た X-Forwarded-For は信用しない（request.ip の偽装を防ぐ）。
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);

  if (config.AUTH_MODE === 'cloudflare-access') {
    const allowlist = getAllowlist();
    if (allowlistSize(allowlist) === 0) {
      app.log.error(
        { file: config.ACCESS_ALLOWLIST_FILE },
        'アクセス許可リストが空です。Cloudflare Access 済みでも全リクエストを 403 にします（fail-closed）。',
      );
    } else {
      app.log.info(
        {
          file: config.ACCESS_ALLOWLIST_FILE,
          emails: allowlist.emails.size,
          domains: allowlist.domains.size,
        },
        'アクセス許可リストを読み込みました。',
      );
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);

    const isHealth = request.url.startsWith('/api/health');
    // 端末エージェントは Cloudflare Access のサービスドメイン + アプリ側デバイストークンで守る。
    const isDeviceAgent = request.url.startsWith('/api/device/agent');
    // 実端末コマンドの取得・結果報告はデバイストークンで守る（UI の登録/確認は各ルートで認証）。
    const isDeviceCommand = request.url.startsWith('/api/device/command');

    if (config.REQUIRE_PROXY_SECRET && !isHealth && !isDeviceAgent && !isDeviceCommand) {
      const provided = request.headers['x-proxy-secret'];
      if (
        typeof provided !== 'string' ||
        !config.PROXY_SECRET ||
        !secretsMatch(provided, config.PROXY_SECRET)
      ) {
        throw new ApiError(401, 'PROXY_REQUIRED', 'API への直接アクセスは許可されていません。');
      }
    }

    // Cloudflare Access の allow ポリシーに加え、アプリ側でも許可リストを照合する。
    // 外形監視用の /api/health と、端末エージェント専用の /api/device/agent だけは除外する。
    if (
      config.AUTH_MODE === 'cloudflare-access' &&
      !isHealth &&
      !isDeviceAgent &&
      !isDeviceCommand
    ) {
      await requireCloudflareAccess(request);
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let sameOrigin = false;
        try {
          const originHost = new URL(origin).host;
          const requestHost = request.headers['x-forwarded-host'] ?? request.headers.host;
          sameOrigin = Boolean(requestHost) && originHost === requestHost;
        } catch {
          sameOrigin = false;
        }
        if (
          !sameOrigin &&
          config.allowedOrigins.length > 0 &&
          !config.allowedOrigins.includes(origin)
        ) {
          throw forbidden('許可されていない Origin からの操作です。');
        }
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力内容を確認してください。',
          details: error.flatten(),
        },
      });
      return;
    }
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      reply.code(409).send({
        error: {
          code: 'DUPLICATE',
          message: '同じ内容がすでに登録されています。',
          details: { constraint: (error as { constraint?: string }).constraint },
        },
      });
      return;
    }
    if (code === '23503') {
      reply.code(400).send({
        error: { code: 'REFERENCE_ERROR', message: '参照先のデータが存在しません。' },
      });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      reply.code(statusCode).send({
        error: { code: 'REQUEST_ERROR', message: (error as Error).message },
      });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました。' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `パス ${request.url} は存在しません。` },
    });
  });

  await app.register(prototypeRoutes);
  // 解決ループの Skill カタログを同期する。スクリプト未作成でも起動は止めない（draft 登録）。
  try {
    await ensureSkillCatalog();
  } catch (error) {
    app.log.error({ err: error }, 'Skill カタログの同期に失敗しました。');
  }
  if (config.AUTH_MODE === 'local') {
    await app.register(authRoutes, { prefix: '/api' });
  }
  await app.register(caseRoutes, { prefix: '/api' });
  await app.register(caseHandoverRoutes, { prefix: '/api' });
  await app.register(deskRoutes, { prefix: '/api' });
  await app.register(deviceRoutes, { prefix: '/api' });
  await app.register(employeeRoutes, { prefix: '/api' });
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(reportRoutes, { prefix: '/api' });
  await app.register(remoteAssistRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(auditRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(resolveRoutes, { prefix: '/api' });
  await app.register(healthRoutes, { prefix: '/api' });

  return app;
}
