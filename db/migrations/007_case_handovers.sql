-- DX 推進部グループへの案件引継ぎ（A さんのブラウザ → B さんのブラウザ）。
-- 引継ぎ時点の案件・チャット・TKT/INC・ナレッジ下書きのスナップショットを保存し、
-- B さんが claim したときに B さんの prototype_states へマージする。
CREATE TABLE IF NOT EXISTS case_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id text NOT NULL,
  owner_email text NOT NULL,
  assignee_hint text,
  status text NOT NULL DEFAULT 'pending',
  snapshot jsonb NOT NULL,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_handovers_status_check CHECK (status IN ('pending', 'claimed', 'resolved', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS case_handovers_status_created_idx
  ON case_handovers (status, created_at);

-- 同じ案件を同じ人が二重に共有しない（進行中のものだけ）。
CREATE UNIQUE INDEX IF NOT EXISTS case_handovers_active_case_idx
  ON case_handovers (case_id, owner_email)
  WHERE status IN ('pending', 'claimed');
