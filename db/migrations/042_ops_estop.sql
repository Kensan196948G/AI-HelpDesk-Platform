-- 042: 運用統合 UI の SecOps（緊急停止のサーバ保存）（docs/100 P5）
--
-- これまで画面（localStorage）だけで持っていた緊急停止を、サーバの 1 行で持つ。
-- 解除・設定は承認者／監査担当のみ。操作は監査に残す。

CREATE TABLE IF NOT EXISTS ops_estop (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active boolean NOT NULL DEFAULT false,
  reason text,
  actor_email text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops_estop (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
