-- 043: 運用統合 UI のシステム設定（docs/100 P6）
--
-- AIの一致度しきい値・SLA・社内指定版・PC情報/リモートの有効化などを
-- サーバの 1 行で持つ（これまでは各ブラウザの localStorage）。
-- 秘密値は置かない（通知先などは別管理）。

CREATE TABLE IF NOT EXISTS ops_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
