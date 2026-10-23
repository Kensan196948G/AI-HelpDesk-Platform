import { timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError, forbidden } from './errors.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { caseRoutes } from './routes/cases.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { deskRoutes } from './routes/desk.js';
import { healthRoutes } from './routes/health.js';
import { knowledgeRoutes } from './routes/knowledge.js';

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
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);

    if (config.REQUIRE_PROXY_SECRET && !request.url.startsWith('/api/health')) {
      const provided = request.headers['x-proxy-secret'];
      if (
        typeof provided !== 'string' ||
        !config.PROXY_SECRET ||
        !secretsMatch(provided, config.PROXY_SECRET)
      ) {
        throw new ApiError(401, 'PROXY_REQUIRED', 'API への直接アクセスは許可されていません。');
      }
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
        throw forbidden('許可されていない Origin からの操作です。');
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

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(caseRoutes, { prefix: '/api' });
  await app.register(deskRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(auditRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(healthRoutes, { prefix: '/api' });

  return app;
}
