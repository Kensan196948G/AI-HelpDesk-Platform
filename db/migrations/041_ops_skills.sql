-- 041: 運用統合 UI の AI・Skills 反映（docs/100 P4）
--
-- 承認されたナレッジを「AI の検索対象（knowledge の approved）」と
-- 「Skill（カテゴリ単位の手順書）」へ反映した事実を記録する。
-- 外部 AI 呼び出しは無い（反映は DB 書き込みだけ）ため、承認と同じトランザクションで行う。

CREATE TABLE IF NOT EXISTS ops_skills (
  category text PRIMARY KEY,
  name text NOT NULL,
  minor integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops_skills (category, name, minor)
VALUES
  ('account', 'helpdesk-account', 0),
  ('mail', 'helpdesk-mail-collab', 0),
  ('network', 'helpdesk-network', 0),
  ('device', 'helpdesk-device', 0),
  ('file', 'helpdesk-file-apps', 0),
  ('security', 'helpdesk-security-triage', 0),
  ('other', 'helpdesk-general', 0)
ON CONFLICT (category) DO NOTHING;

CREATE TABLE IF NOT EXISTS ops_reflect (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_no text NOT NULL,
  kb_version integer NOT NULL,
  skill_name text NOT NULL,
  skill_version text NOT NULL,
  index_size integer NOT NULL,
  action text NOT NULL,
  actor_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_reflect_created_idx ON ops_reflect (created_at DESC);
