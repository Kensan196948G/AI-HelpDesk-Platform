-- SM-12: 中止・エスカレーションで終了したセッションの報告書を「解決」と誤認させない。
--
-- 背景 (2026-10-27 実測):
--   RSP 実行セッションを「中止」で閉じても、報告書作成 API は
--   kind=helpdesk_resolved で保存していた。画面も中止で閉じたセッションに
--   「📄 報告書を作成」を有効に出すため、中止したセッションの報告書が
--   「担当者の対応で解決」と表示され、実際には解消していない案件を
--   解決済みと誤認させる。
--
--   terminal/report.ts は終了理由（close_reason）が resolved のときだけ
--   helpdesk_resolved、それ以外（stopped / escalated）は helpdesk_stopped を
--   使うよう変更した。本 migration はその値を保存できるようにする。
--
-- 変更は CHECK 制約の許可値のみ。既存行の kind は変更しない（データ変換なし）。
ALTER TABLE final_reports DROP CONSTRAINT IF EXISTS final_reports_kind_check;

ALTER TABLE final_reports
  ADD CONSTRAINT final_reports_kind_check
  CHECK (kind IN ('ai_resolved', 'helpdesk_resolved', 'helpdesk_stopped'));
