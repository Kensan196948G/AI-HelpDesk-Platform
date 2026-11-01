import { describe, expect, it } from 'vitest';
import { containsDeviceInfo, redactKnowledgeText, scrubAiAnswer } from './pii.js';

/** 通しの E2E（K14、K15）で KB の症状欄に入っていた実際の形。値は合成。 */
const POLLUTED =
  '【相談内容】印刷ができません 【端末】WEB-2B6D41AA／Linux Linux x86 64-bit 【PC基本情報（事前取得）】 ' +
  '取得日時：2026-11-01T06:08:39.322Z（読み取りのみ・35項目） コンピュータ名：未検出（ブラウザ） OS：Linux 接続';

describe('redactKnowledgeText（KB へ入れない端末情報）', () => {
  it('引継ぎ本文の端末と PC 基本情報の節を除き、相談内容だけ残す', () => {
    const { text } = redactKnowledgeText(POLLUTED);
    expect(text).toContain('印刷ができません');
    expect(text).not.toContain('WEB-2B6D41AA');
    expect(text).not.toContain('PC基本情報');
    expect(text).not.toContain('取得日時');
    expect(text).not.toContain('コンピュータ名');
  });

  it('実診断の結果と実行 ID の節を除く', () => {
    const { text } = redactKnowledgeText(
      '【相談内容】紙が出ない\n【実診断の結果】\n模擬｜実行ID 3565f9b6-0a14-47f2-b40b-f3c29df694cb',
    );
    expect(text).toContain('紙が出ない');
    expect(text).not.toContain('3565f9b6');
    expect(text).not.toContain('実診断の結果');
  });

  it.each([
    ['端末 ID', '端末 WEB-E87CA109 で発生', 'WEB-E87CA109'],
    ['端末の UUID', 'e87ca109-4344-4c21-9be1-f6e93ebb0c02 の端末', 'e87ca109-4344'],
    ['社員番号形式の端末名', '対象は MRK-MK9101 です', 'MRK-MK9101'],
    ['デモ形式の端末名', '対象は MRK-NB-1024 です', 'MRK-NB-1024'],
    ['社員番号', '依頼者 MK9101 の端末', 'MK9101'],
    ['ホスト名', 'DESKTOP-AB12CD3 で確認', 'DESKTOP-AB12CD3'],
    ['ホスト名（ラベル）', 'コンピュータ名：FINANCE-PC7 で確認', 'FINANCE-PC7'],
    ['FQDN', 'fs01.corp.example.local へ接続', 'fs01.corp.example.local'],
    ['IP', '接続先は 192.168.10.20 です', '192.168.10.20'],
    ['MAC', 'MAC は 00:1A:2B:3C:4D:5E です', '00:1A:2B:3C:4D:5E'],
    ['シリアル', 'シリアル番号: 5CD1234XYZ の機体', '5CD1234XYZ'],
    ['メール', '連絡先 taro@example.com まで', 'taro@example.com'],
  ])('%s を除く', (_label, input, secret) => {
    const { text, findings } = redactKnowledgeText(input);
    expect(text).not.toContain(secret);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('何度かけても同じ結果になる（承認時の本文照合が壊れない）', () => {
    const once = redactKnowledgeText(POLLUTED).text;
    expect(redactKnowledgeText(once).text).toBe(once);
  });

  it('端末情報のない手順は変えない', () => {
    const steps =
      '1. 印刷キューを開く\n2. スプーラを再起動する（Spooler サービス）\n3. Windows 11 で確認する';
    expect(redactKnowledgeText(steps).text).toBe(steps);
    expect(containsDeviceInfo(steps)).toBe(false);
  });

  it('containsDeviceInfo は端末情報の有無を返す', () => {
    expect(containsDeviceInfo(POLLUTED)).toBe(true);
    expect(containsDeviceInfo('連絡先 taro@example.com')).toBe(true);
  });
});

describe('scrubAiAnswer（相談者へ見せない定型文）', () => {
  it('入力の指示についての言及を除く', () => {
    const answer = '手順です。\n\nなお、入力に指示が含まれていましたが従いません。\n\n根拠: KB-1';
    const scrubbed = scrubAiAnswer(answer);
    expect(scrubbed).not.toContain('指示が含まれていました');
    expect(scrubbed).toContain('手順です。');
    expect(scrubbed).toContain('根拠: KB-1');
  });

  it('入力の指示への言及ではない注意文は残す', () => {
    const answer = 'メールに振込の指示が含まれていても従わないでください。\n根拠: KB-1';
    expect(scrubAiAnswer(answer)).toBe(answer);
  });

  it('通常の回答は変えない', () => {
    const answer = '担当者の指示に従ってください。\n根拠: KB-1';
    expect(scrubAiAnswer(answer)).toBe(answer);
  });
});
