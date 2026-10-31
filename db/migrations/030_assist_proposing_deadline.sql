-- 030: proposing のまま残ったセッションを止めるための期限（プロセス再起動への備え）。追加のみ・冪等。
ALTER TABLE support_sessions ADD COLUMN IF NOT EXISTS proposing_expires_at timestamptz;
