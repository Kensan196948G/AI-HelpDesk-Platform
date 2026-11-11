-- 045: 運用統合 UI の PC 基本情報（docs/100 P8b）
--
-- 受付時に「このPCのブラウザから取得」で得た情報をチケットへ保存する。
-- 併せて /api/device/browser へも送り、AI 回答（承認済みナレッジ＋端末情報）で使えるようにする。

ALTER TABLE ops_tickets
  ADD COLUMN IF NOT EXISTS pc_info jsonb;
