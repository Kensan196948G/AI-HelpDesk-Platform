import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('employee directory endpoint', () => {
  it('scope=staff は配列を返す（DB が無い環境でも 200）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?scope=staff' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.employees)).toBe(true);
    expect(body.scope).toBe('staff');
    expect(body.source).toContain('mirai-info');
  });

  it('scope=all は配列を返す', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?scope=all' });
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json().employees)).toBe(true);
  });

  it('不正な scope は all にフォールバックする', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/employees?scope=unknown' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().scope).toBe('all');
  });
});
