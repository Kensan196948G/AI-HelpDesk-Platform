import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  type FinalReport,
  FinalReportSchema,
  maskFinalReport,
  PdfUnavailableError,
  pdfAvailable,
  renderFinalReportHtml,
  renderFinalReportPdf,
  reportPdfFilename,
} from './final-report.js';

function sampleReport(): FinalReport {
  return FinalReportSchema.parse({
    kind: 'helpdesk_resolved',
    generatedAt: '2026-10-23T12:00:00.000Z',
    generatedBy: {
      name: '佐藤 奨太',
      role: 'ヘルプデスク担当 taro@example.com',
      dept: 'DX推進部',
    },
    requester: { name: '山田 太郎', dept: '工事部 090-1234-5678', employeeNo: 'MK0001' },
    case: {
      id: 'CASE-0001',
      created: '2026-10-23 10:00:00',
      kindLabel: 'ファイル・共有フォルダ',
      subject: '共有フォルダが開けない',
      body: '連絡先 taro@example.com、電話 090-1234-5678、IP 10.1.2.3 です。',
      urgency: '通常',
      model: 'DeepSeek-V4.1-Flash',
    },
    pc: {
      available: true,
      device: 'MRK-NB-1024',
      collectedAt: '2026-10-23 10:01:00',
      itemCount: 2,
      shared: true,
      flags: [],
      items: [
        { grp: 'ネットワーク', k: 'IPアドレス', v: '10.1.2.3', lv: 'ok' },
        { grp: '端末', k: 'シリアル番号', v: 'SN12345678', lv: 'ok' },
      ],
    },
    ai: {
      provider: 'deepseek',
      model: 'DeepSeek-V4.1-Flash',
      messages: [
        {
          role: 'user',
          who: '山田 太郎',
          text: '連絡先は taro@example.com です。<script>alert(1)</script>',
        },
        { role: 'ai', who: 'AI', text: '確認してください。' },
      ],
      diagnoses: [
        {
          title: '端末の診断',
          rows: [{ k: '印刷スプーラ', v: '停止', lv: 'ng' }],
        },
      ],
      proposals: [
        {
          opId: 'SPOOLER_RESTART',
          name: '印刷スプーラーの再起動',
          level: 4,
          status: '実行済み',
        },
      ],
      sources: [{ id: 'KB-001', kbNo: 'KB-001', title: '印刷できないとき' }],
    },
    handover: {
      reason: 'AIで解決しないため',
      ticketId: 'TKT-2026-0001',
      incId: 'INC-1001',
      assignee: '佐藤 奨太',
      shared: ['相談内容', 'PC基本情報（事前取得）'],
      memo: '引継ぎメモ',
      at: '2026-10-23 10:10:00',
    },
    resolution: {
      cause: '共有フォルダの権限がなかった。',
      steps: ['権限を確認する', 'グループに追加する'],
      minutes: 20,
      by: '佐藤 奨太',
      at: '2026-10-23 10:30:00',
    },
    knowledge: {
      draftId: 'DR-001',
      status: 'approved',
      kbId: 'KB-001',
      title: '共有フォルダが開けないとき',
      version: '1.1',
      approvedBy: '渡辺 watanabe@example.com',
    },
    remote: {
      status: 'approved',
      requestedBy: '佐藤 奨太',
      requestedAt: '2026-10-23T10:12:00.000Z',
      approvedBy: '山田 太郎',
      approvedAt: '2026-10-23T10:13:00.000Z',
      expiresAt: '2026-10-23T10:43:00.000Z',
      scope: '読み取り情報と案内文のみ',
      prompts: [
        {
          at: '2026-10-23T10:14:00.000Z',
          by: '佐藤 奨太',
          text: '印刷キューを確認してください。',
          status: 'done',
          doneAt: '2026-10-23T10:15:00.000Z',
        },
      ],
    },
    timeline: [{ at: '2026-10-23 10:00:00', actor: '山田 太郎', action: '相談を送信' }],
  });
}

function minimalReport() {
  return {
    kind: 'ai_resolved' as const,
    generatedAt: '2026-10-23T12:00:00.000Z',
    generatedBy: { name: 'AI' },
    requester: { name: '山田 太郎' },
    case: {
      id: 'CASE-0002',
      created: '2026-10-23 10:00:00',
      kindLabel: 'PC・周辺機器',
      subject: '印刷できない',
      body: '印刷できません。',
      urgency: '通常',
    },
  };
}

describe('FinalReportSchema', () => {
  it('最小構成を受け付け、既定値を補う', () => {
    const report = FinalReportSchema.parse(minimalReport());
    expect(report.reportVersion).toBe(1);
    expect(report.ai.messages).toEqual([]);
    expect(report.timeline).toEqual([]);
    expect(report.pc).toBeUndefined();
  });

  it('不正な日時を拒否する', () => {
    expect(() =>
      FinalReportSchema.parse({ ...minimalReport(), generatedAt: 'not-a-date' }),
    ).toThrow();
  });

  it('AI解決の報告書で STEP 5 を拒否する', () => {
    const base = minimalReport();
    expect(() => FinalReportSchema.parse({ ...base, case: { ...base.case, step: 5 } })).toThrow();
  });

  it('承認済みの遠隔支援に承認日時・期限がなければ拒否する', () => {
    const base = minimalReport();
    expect(() =>
      FinalReportSchema.parse({
        ...base,
        remote: {
          status: 'approved',
          requestedAt: '2026-10-23T10:00:00.000Z',
          prompts: [],
        },
      }),
    ).toThrow();
  });

  it('実施済みの案内に doneAt がなければ拒否する', () => {
    const base = minimalReport();
    expect(() =>
      FinalReportSchema.parse({
        ...base,
        remote: {
          status: 'approved',
          requestedAt: '2026-10-23T10:00:00.000Z',
          approvedAt: '2026-10-23T10:01:00.000Z',
          expiresAt: '2026-10-23T10:31:00.000Z',
          prompts: [{ text: '確認してください。', status: 'done' }],
        },
      }),
    ).toThrow();
  });
});

describe('maskFinalReport', () => {
  it('自由記述・PC情報を伏せ字化し、元のオブジェクトは変更しない', () => {
    const raw = sampleReport();
    const masked = maskFinalReport(raw);

    expect(masked.case.body).not.toContain('taro@example.com');
    expect(masked.case.body).toContain('[メールアドレス]');
    expect(masked.case.body).toContain('[電話番号]');
    expect(masked.case.body).toContain('[IPアドレス]');
    expect(masked.ai.messages[0]?.text).toContain('[メールアドレス]');
    expect(masked.generatedBy.role).toContain('[メールアドレス]');
    expect(masked.requester.dept).toContain('[電話番号]');
    expect(masked.knowledge?.approvedBy).toContain('[メールアドレス]');
    expect(masked.pc?.device).toContain('[資産番号]');
    expect(masked.pc?.items[0]?.v).toBe('[IPアドレス]');
    expect(masked.pc?.items[1]?.v).toBe('[シリアル番号]');

    // 元データは変更しない（呼び出し側の状態を壊さない）
    expect(raw.case.body).toContain('taro@example.com');
    expect(raw.pc?.items[0]?.v).toBe('10.1.2.3');
  });
});

describe('renderFinalReportHtml', () => {
  it('Standalone HTML に必要な要素を埋め込み、外部参照を持たない', () => {
    const report = maskFinalReport(sampleReport());
    const { html, filename } = renderFinalReportHtml(report, {
      id: '11111111-1111-1111-1111-111111111111',
      sha256: 'a'.repeat(64),
    });

    expect(filename).toBe('AIHelpDesk-CASE-0001-HD-20261023.html');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('最終報告書');
    expect(html).toContain('担当者の対応で解決');
    expect(html).toContain('CASE-0001');
    expect(html).toContain('TKT-2026-0001');
    expect(html).toContain('INC-1001');
    expect(html).toContain('共有フォルダが開けない');
    expect(html).toContain('AIの一次対応');
    expect(html).toContain('担当者の対応・解決記録');
    expect(html).toContain('遠隔支援（同意した範囲）');
    expect(html).toContain('a'.repeat(64));
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('taro@example.com');
    expect(html).not.toContain('10.1.2.3');
    expect(html).not.toContain('SN12345678');
  });

  it('HTML をエスケープする（XSS を埋め込まない）', () => {
    const report = FinalReportSchema.parse({
      ...sampleReport(),
      kind: 'ai_resolved',
      handover: null,
      resolution: null,
      knowledge: null,
      remote: null,
      case: {
        id: 'CASE-0003',
        created: '2026-10-23 10:00:00',
        kindLabel: '<img src=x onerror=alert(1)>',
        subject: '<script>alert(1)</script>',
        body: '<b>強調</b>',
        urgency: '通常',
      },
    });
    const { html } = renderFinalReportHtml(report, { id: 'x', sha256: 'b'.repeat(64) });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('表紙バッジは case.step に応じた「STEP n 完了」になる（F-14）', () => {
    const cases = [
      { kind: 'helpdesk_resolved', step: 5, label: 'STEP 5 完了' },
      { kind: 'helpdesk_resolved', step: 6, label: 'STEP 6 完了' },
      { kind: 'helpdesk_resolved', step: 7, label: 'STEP 7 完了' },
      { kind: 'ai_resolved', step: 7, label: 'STEP 7 完了' },
    ] as const;
    for (const item of cases) {
      const parsed = FinalReportSchema.parse({
        ...sampleReport(),
        kind: item.kind,
        case: { ...sampleReport().case, step: item.step },
      });
      const { html } = renderFinalReportHtml(parsed, { id: 'x', sha256: 'a'.repeat(64) });
      expect(html, `${item.kind} step=${item.step}`).toContain(item.label);
      // AI解決は旧実装の「STEP 3 完了」を出さない。
      if (item.kind === 'ai_resolved') expect(html).not.toContain('STEP 3 完了');
    }

    // step を送らない旧クライアント: AI解決=7、担当者解決=5 に補う。
    const legacyAi = FinalReportSchema.parse({ ...sampleReport(), kind: 'ai_resolved' });
    const legacyHelpdesk = FinalReportSchema.parse({
      ...sampleReport(),
      kind: 'helpdesk_resolved',
    });
    expect(renderFinalReportHtml(legacyAi, { id: 'x', sha256: 'a'.repeat(64) }).html).toContain(
      'STEP 7 完了',
    );
    expect(
      renderFinalReportHtml(legacyHelpdesk, { id: 'x', sha256: 'a'.repeat(64) }).html,
    ).toContain('STEP 5 完了');
  });

  it('承認の性質（自己承認／別アカウント・同一人物）を報告書に記録する', () => {
    const base = maskFinalReport(sampleReport());
    const shared = {
      ...base,
      handover: {
        reason: '引継ぎ',
        shared: [],
        at: '2026-10-23T10:10:00.000Z',
        approvedBy: 'DX 担当A',
        approvedAt: '2026-10-23T10:20:00.000Z',
        selfApproved: false,
        sharedIdentity: true,
      },
    };
    const sharedHtml = renderFinalReportHtml(shared, { id: 'x', sha256: 'a'.repeat(64) }).html;
    expect(sharedHtml).toContain('別アカウント（同一人物）');
    expect(sharedHtml).toContain('DX 担当A');

    const selfHtml = renderFinalReportHtml(
      { ...base, handover: { ...shared.handover, selfApproved: true, sharedIdentity: false } },
      { id: 'x', sha256: 'a'.repeat(64) },
    ).html;
    expect(selfHtml).toContain('自己承認');
    expect(selfHtml).not.toContain('別アカウント（同一人物）');
  });

  it('ナレッジ下書きへの相対リンクを rel=noopener 付きで含む（F-16）', () => {
    const { html } = renderFinalReportHtml(maskFinalReport(sampleReport()), {
      id: 'x',
      sha256: 'a'.repeat(64),
    });
    expect(html).toContain('href="/?draft=DR-001"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('下書きを開く');
  });
});

describe('filenames', () => {
  it('PDF のファイル名は HTML と同じ基底名にする', () => {
    expect(reportPdfFilename('AIHelpDesk-CASE-0001-HD-20261023.html')).toBe(
      'AIHelpDesk-CASE-0001-HD-20261023.pdf',
    );
  });

  it('Content-Disposition に ASCII フォールバックと UTF-8 を両方入れる', () => {
    const value = contentDisposition('AIHelpDesk-CASE-0001-HD-20261023.html');
    expect(value).toContain('attachment;');
    expect(value).toContain("filename*=UTF-8''");
  });
});

describe('renderFinalReportPdf', () => {
  it('ヘッドレスブラウザがあれば PDF を生成する（なければスキップ）', async () => {
    if (!(await pdfAvailable())) {
      // CI など Chrome が無い環境では PDF 生成をスキップする（HTML は検証済み）。
      await expect(renderFinalReportPdf('<html></html>')).rejects.toBeInstanceOf(
        PdfUnavailableError,
      );
      return;
    }
    const report = maskFinalReport(sampleReport());
    const { html } = renderFinalReportHtml(report, { id: 'pdf', sha256: 'c'.repeat(64) });
    const pdf = await renderFinalReportPdf(html);
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1_000);
    // ヘッドレス Chrome の起動と描画は CI の共有ランナーで 10 秒を超えることがある。
  }, 60_000);
});
