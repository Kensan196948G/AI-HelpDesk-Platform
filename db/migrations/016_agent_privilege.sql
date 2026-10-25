-- 016: 端末エージェントの権限区分（privilege）
--
-- 設計: docs/25-skill-resolution-loop.md §12「昇格が必要な Skill は別の管理者
-- エージェント（別トークン・別サービス）で実行」/ §17-2。
--
-- 端末トークンに standard / admin の区分を持たせ、サーバ側で配信と結果送信を分離する。
--   - standard: 昇格不要のコマンドだけを配信する（従来どおりの既定）。
--   - admin   : 昇格必須（skills.requires->>'elevation' = 'true'）のコマンドだけを配信する。
--
-- 追加のみ・冪等。既存行は DEFAULT で standard になるため、標準エージェントの
-- 挙動は変わらない（後方互換）。SPOOLER_RESTART 等 skill_id を持たない既存経路は
-- standard 扱いとする。

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS privilege text NOT NULL DEFAULT 'standard';

-- CHECK は「無ければ追加」で冪等にする（ADD COLUMN IF NOT EXISTS は既存列の
-- 制約までは追加しないため、制約は別途明示的に作る）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'device_tokens_privilege_check'
      AND conrelid = 'device_tokens'::regclass
  ) THEN
    ALTER TABLE device_tokens
      ADD CONSTRAINT device_tokens_privilege_check
      CHECK (privilege IN ('standard', 'admin'));
  END IF;
END
$$;

-- インデックスは追加しない。トークンは token_hash（主キー）で 1 行引きするだけであり、
-- 配信クエリの skills 参照は skills の主キー (id, version)（011 で作成済み）で引ける。
