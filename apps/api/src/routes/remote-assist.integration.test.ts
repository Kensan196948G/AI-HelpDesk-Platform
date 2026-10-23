import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;

beforeAll(async () => {
  resetRateLimits();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('遠隔支援の案内文 API', () => {
  it('担当者の意図から案内文と候補アクションを返す（実行はしない）', async () => {
    resetRateLimits();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/remote-prompt',
      payload: {
        intent: '印刷キューの状態を確認して、止まっているジョブを消してもらう',
        context: {
          caseId: 'CASE-0001',
          subject: '印刷ができません',
          body: '今朝から印刷待ちのままです。',
          pcSummary: '印刷スプーラ：停止',
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.draft.message.length).toBeGreaterThan(20);
    expect(['fallback', 'deepseek']).toContain(body.draft.provider);
    expect(
      body.draft.actions.some((action: { opId: string }) => action.opId === 'SPOOLER_RESTART'),
    ).toBe(true);
    // 実行 API ではない（コマンド ID などを返さない）
    expect(body.command).toBeUndefined();
  });

  it('空の意図は 400 で拒否する', async () => {
    resetRateLimits();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/remote-prompt',
      payload: { intent: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});
