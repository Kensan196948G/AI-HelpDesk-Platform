import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateTerminal } from '../auth/rsp-integration.js';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import {
  contentDisposition,
  FinalReportSchema,
  inlineContentDisposition,
  maskFinalReport,
  PdfBusyError,
  PdfUnavailableError,
  renderFinalReportHtml,
  renderFinalReportPdf,
  reportPdfFilename,
} from '../domain/final-report.js';
import { ApiError, badRequest } from '../errors.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const BodySchema = z.object({ report: FinalReportSchema });
const IdSchema = z.object({ id: z.string().uuid() });
const HtmlQuerySchema = z.object({ inline: z.enum(['1', '0']).optional() });
// 1 利用者あたり 24 時間で 50 件まで（最大 512KiB × 50 = 25MiB）。
const REPORT_DAILY_LIMIT = 50;

interface StoredReportRow {
  html: string;
  html_filename: string;
  case_id: string;
  kind: string;
  sha256: string;
  created_at: Date;
}

async function loadOwnedReport(id: string, email: string): Promise<StoredReportRow | undefined> {
  const rows = await sql<StoredReportRow[]>`
    SELECT html, html_filename, case_id, kind, sha256, created_at
    FROM final_reports
    WHERE id = ${id} AND user_email = ${email}
    LIMIT 1
  `;
  return rows[0];
}

/**
 * 最終報告書（Standalone HTML / PDF）。
 *
 * - POST で画面の構造化データを検証し、伏せ字化した HTML と SHA-256 を保存する。
 * - GET は作成した利用者（Access メール）だけが取得できる。
 * - PDF は保存済み HTML をヘッドレス Chrome で印刷する（保存済み HTML を再変換するため、
 *   元データの再送は不要）。
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/reports/final',
    { preHandler: authenticateUi, bodyLimit: 512 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      if (!checkRateLimit(`final-report:${request.uiEmail}`, 10, 60_000)) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          '最終報告書の作成が多すぎます。少し待ってから再試行してください。',
        );
      }

      const { report } = BodySchema.parse(request.body);
      // 保存・出力・ハッシュを同じ内容に揃えるため、先に伏せ字化する。
      const masked = maskFinalReport(report);
      const recent = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM final_reports
        WHERE user_email = ${request.uiEmail}
          AND created_at > now() - interval '24 hours'
      `;
      if (Number(recent[0]?.count ?? '0') >= REPORT_DAILY_LIMIT) {
        throw new ApiError(
          429,
          'REPORT_QUOTA',
          '最終報告書の作成が 24 時間で上限（50 件）に達しました。',
        );
      }
      const id = randomUUID();
      const sha256 = createHash('sha256').update(JSON.stringify(masked)).digest('hex');
      const rendered = renderFinalReportHtml(masked, { id, sha256 });

      await sql`
        INSERT INTO final_reports (id, user_email, case_id, kind, payload, html, html_filename, sha256)
        VALUES (
          ${id},
          ${request.uiEmail},
          ${masked.case.id},
          ${masked.kind},
          ${jsonbValue(masked)},
          ${rendered.html},
          ${rendered.filename},
          ${sha256}
        )
      `;

      const base = `/api/reports/final/${id}`;
      return {
        ok: true,
        report: {
          id,
          sha256,
          kind: masked.kind,
          caseId: masked.case.id,
          createdAt: new Date().toISOString(),
          files: {
            html: { url: `${base}/html`, filename: rendered.filename },
            pdf: { url: `${base}/pdf`, filename: reportPdfFilename(rendered.filename) },
          },
        },
      };
    },
  );

  app.get(
    '/reports/final/:id/html',
    { preHandler: authenticateTerminal },
    async (request, reply) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const { id } = IdSchema.parse(request.params);
      const row = await loadOwnedReport(id, request.uiEmail);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '対象の最終報告書が見つかりません。');

      const { inline } = HtmlQuerySchema.parse(request.query ?? {});
      reply
        .type('text/html; charset=utf-8')
        .header(
          'Content-Disposition',
          inline === '1'
            ? inlineContentDisposition(row.html_filename)
            : contentDisposition(row.html_filename),
        )
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(row.html);
    },
  );

  app.get(
    '/reports/final/:id/pdf',
    { preHandler: authenticateTerminal },
    async (request, reply) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      if (!checkRateLimit(`final-report-pdf:${request.uiEmail}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'PDF の生成が多すぎます。少し待ってください。');
      }
      const { id } = IdSchema.parse(request.params);
      const row = await loadOwnedReport(id, request.uiEmail);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '対象の最終報告書が見つかりません。');

      try {
        const pdf = await renderFinalReportPdf(row.html);
        reply
          .type('application/pdf')
          .header('Content-Disposition', contentDisposition(reportPdfFilename(row.html_filename)))
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(pdf);
      } catch (error) {
        if (error instanceof PdfBusyError) {
          throw new ApiError(
            503,
            'PDF_BUSY',
            'PDF の生成が混み合っています。少し待ってから再試行してください。',
          );
        }
        if (error instanceof PdfUnavailableError) {
          throw new ApiError(
            503,
            'PDF_UNAVAILABLE',
            'PDF を生成するヘッドレスブラウザがありません。HTML を出力してください。',
          );
        }
        request.log.warn({ err: error }, 'final report PDF generation failed');
        throw new ApiError(
          502,
          'PDF_FAILED',
          'PDF の生成に失敗しました。HTML を出力してください。',
        );
      }
    },
  );
}
