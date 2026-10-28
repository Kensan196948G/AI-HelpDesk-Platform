import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findEmployeeByEmail, resetEmployeeCache } from '../lib/mirai-info.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;

beforeAll(async () => {
  resetEmployeeCache();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/me', () => {
  it('認証済みなら 200 で employee（または null）を返す', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toContain('mirai-info');
    expect(body).toHaveProperty('employee');
    // V-01: 複数ロールを UI が取得できる（users に居なければ空配列）。
    expect(Array.isArray(body.roles)).toBe(true);
    expect(typeof body.resolveAdmin).toBe('boolean');
    if (body.employee) {
      expect(typeof body.employee.employeeNo).toBe('string');
      expect(typeof body.employee.name).toBe('string');
      // メールは返さない（PII を増やさない）
      expect(body.employee).not.toHaveProperty('email');
    }
  });

  it('名簿に無いメールは null（DB 未接続でも同じ）', async () => {
    await expect(findEmployeeByEmail('nobody@example.invalid')).resolves.toBeNull();
  });

  it('空メールは null', async () => {
    await expect(findEmployeeByEmail('')).resolves.toBeNull();
  });
});
