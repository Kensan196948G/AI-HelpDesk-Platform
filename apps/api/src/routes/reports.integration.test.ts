import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { pdfAvailable } from '../domain/final-report.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;

function reportPayload(caseId: string, kind: 'ai_resolved' | 'helpdesk_resolved') {
  return {
    kind,
    generatedAt: '2026-10-23T12:00:00.000Z',
    generatedBy: { name: '佐藤 奨太', role: 'ヘルプデスク担当', dept: 'DX推進部' },
    requester: { name: '山田 太郎', dept: '工事部', employeeNo: 'MK0001' },
    case: {
      id: caseId,
      created: '2026-10-23 10:00:00',
      kindLabel: 'PC・周辺機器',
      subject: '印刷ができません',
      body: '連絡先は test@example.com、電話 090-1234-5678、IP 10.1.2.3 です。',
      urgency: '通常',
      model: 'DeepSeek-V4.1-Flash',
    },
    pc: {
      available: true,
      device: 'MRK-NB-1024',
      collectedAt: '2026-10-23 10:01:00',
      itemCount: 1,
      shared: true,
      flags: [],
      items: [{ grp: 'ネットワーク', k: 'IPアドレス', v: '10.1.2.3', lv: 'ok' }],
    },
    ai: {
      provider: 'fallback',
      model: 'fallback',
      messages: [{ role: 'ai', who: 'AI', text: '印刷キューを確認してください。' }],
      diagnoses: [],
      proposals: [],
      sources: [],
    },
    handover: null,
    resolution: null,
    knowledge: null,
    remote: null,
    timeline: [{ at: '2026-10-23 10:00:00', actor: '山田 太郎', action: '相談を送信' }],
  };
}

beforeAll(async () => {
  resetRateLimits();
  // 24 時間クォータ（50 件）は final_reports の実データで判定され、テスト DB は
  // 実行間で残る。前回までの実行分を消さないと 429 になり、結果が「何回目か」に
  // 依存する（2026-10-25 実測: 全 311 件中 2 件が REPORT_QUOTA で失敗）。
  await sql`DELETE FROM final_reports`;
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('最終報告書 API', () => {
  it('AI解決の報告書を作成し、Standalone HTML を取得できる', async () => {
    resetRateLimits();
    const caseId = `CASE-R${Date.now().toString(36)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/reports/final',
      payload: { report: reportPayload(caseId, 'ai_resolved') },
    });
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json();
    expect(body.ok).toBe(true);
    expect(body.report.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.report.files.html.url).toContain(`/api/reports/final/${body.report.id}/html`);
    expect(body.report.files.pdf.url).toContain(`/api/reports/final/${body.report.id}/pdf`);

    const html = await app.inject({ method: 'GET', url: body.report.files.html.url });
    expect(html.statusCode, html.body).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-disposition']).toContain('attachment');
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    expect(html.body).toContain(caseId);
    expect(html.body).toContain('AIの一次対応で解決');
    expect(html.body).toContain('[メールアドレス]');
    expect(html.body).toContain('[電話番号]');
    expect(html.body).toContain('[IPアドレス]');
    expect(html.body).not.toContain('test@example.com');
    expect(html.body).not.toContain('090-1234-5678');
    expect(html.body).not.toContain('10.1.2.3');
    expect(html.body).not.toContain('<script');
  });

  it('PDF を生成できる（ヘッドレスブラウザが無い環境では 503）', async () => {
    resetRateLimits();
    const caseId = `CASE-P${Date.now().toString(36)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/reports/final',
      payload: { report: reportPayload(caseId, 'helpdesk_resolved') },
    });
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json();
    const pdf = await app.inject({ method: 'GET', url: body.report.files.pdf.url });
    if (await pdfAvailable()) {
      expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('.pdf');
      expect(pdf.rawPayload.subarray(0, 4).toString('ascii')).toBe('%PDF');
    } else {
      expect(pdf.statusCode).toBe(503);
      expect(pdf.json().error.code).toBe('PDF_UNAVAILABLE');
    }
  });

  it('作成者以外は取得できない（作成者単位のアクセス制御）', async () => {
    resetRateLimits();
    const id = randomUUID();
    await sql`
      INSERT INTO final_reports (id, user_email, case_id, kind, payload, html, html_filename, sha256)
      VALUES (
        ${id},
        'someone-else@example.com',
        'CASE-OTHER',
        'ai_resolved',
        '{}'::jsonb,
        '<html>other</html>',
        'other.html',
        ${'d'.repeat(64)}
      )
    `;
    try {
      const html = await app.inject({ method: 'GET', url: `/api/reports/final/${id}/html` });
      expect(html.statusCode).toBe(404);
      const pdf = await app.inject({ method: 'GET', url: `/api/reports/final/${id}/pdf` });
      expect(pdf.statusCode).toBe(404);
    } finally {
      await sql`DELETE FROM final_reports WHERE id = ${id}`;
    }
  });

  it('不正な入力は 400 で拒否する', async () => {
    resetRateLimits();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports/final',
      payload: { report: { kind: 'unknown' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('報告書作成の監査を1行だけ記録する（F-15）', async () => {
    resetRateLimits();
    const caseId = `CASE-AUD${Date.now().toString(36)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/reports/final',
      payload: { report: reportPayload(caseId, 'helpdesk_resolved') },
    });
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json();
    const reportId = body.report.id as string;

    const audits = await sql<
      { action: string; detail: Record<string, unknown>; created_at: Date }[]
    >`
      SELECT action, detail, created_at FROM audit_log
      WHERE target_type = 'final_report'
        AND target_id = ${reportId}
        AND action = 'report.final.build'
      ORDER BY id ASC
    `;
    expect(audits, '作成1回につき監査1行').toHaveLength(1);
    expect(audits[0]?.detail.actorEmail).toBe(config.DEV_AUTH_EMAIL);
    expect(audits[0]?.detail.caseId).toBe(caseId);
    expect(audits[0]?.detail.kind).toBe('helpdesk_resolved');
    expect(audits[0]?.detail.sha256).toBe(body.report.sha256);
    expect(audits[0]?.created_at).toBeInstanceOf(Date);

    // 失敗（400）では監査を増やさない。
    const countBefore = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'report.final.build'
    `;
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/reports/final',
      payload: { report: { kind: 'unknown' } },
    });
    expect(invalid.statusCode).toBe(400);
    const countAfter = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'report.final.build'
    `;
    expect(countAfter[0]?.n).toBe(countBefore[0]?.n);
  });

  it('同一内容の報告書は二重作成せず既存行を返す（F-10）', async () => {
    resetRateLimits();
    const caseId = `CASE-DUP${Date.now().toString(36)}`;
    const payload = { report: reportPayload(caseId, 'helpdesk_resolved') };

    const first = await app.inject({ method: 'POST', url: '/api/reports/final', payload });
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.reused).toBe(false);

    const second = await app.inject({ method: 'POST', url: '/api/reports/final', payload });
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.reused).toBe(true);
    expect(secondBody.report.id).toBe(firstBody.report.id);
    expect(secondBody.report.sha256).toBe(firstBody.report.sha256);

    // DB 上も1行だけ（migration 021 の部分一意 index と既存行返却の両方を確認）。
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM final_reports
      WHERE user_email = ${config.DEV_AUTH_EMAIL} AND sha256 = ${firstBody.report.sha256}
    `;
    expect(rows[0]?.n).toBe(1);

    // 再利用では監査行を増やさない（作成時の1行だけ）。
    const audits = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE target_type = 'final_report'
        AND target_id = ${firstBody.report.id}
        AND action = 'report.final.build'
    `;
    expect(audits[0]?.n).toBe(1);
  });
});
