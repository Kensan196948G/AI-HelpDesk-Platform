-- 033: 提案の理由の固定コード（docs/63）。AI の説明文とは別に、サーバが決めた根拠を持つ。追加のみ・冪等。
ALTER TABLE assist_proposals ADD COLUMN IF NOT EXISTS reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
