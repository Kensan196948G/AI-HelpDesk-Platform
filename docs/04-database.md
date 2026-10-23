# Database（Local PostgreSQL）

## 1. 接続先

| 用途 | 接続先 | 備考 |
|---|---|---|
| 開発 | `127.0.0.1:5435` / DB `ai_helpdesk_mvp` | Local PostgreSQL 16.14。専用 DB。既存 DB は触らない |
| テスト | `127.0.0.1:5435` / DB `ai_helpdesk_test` | vitest の globalSetup が migrate/seed |
| 本番相当 | 未配備 | Preview 用に別 DB を用意する（同じ 5435 で可） |

- 接続情報は `.env.local`（0600 / Git 管理外）に置く。リポジトリには `.env.example` のみ。
- 5432 の既存 PostgreSQL は使用しない（認証情報なし・既存データ保護）。
- DB はインターネットへ公開しない。API（Node）からのみ接続する。

## 2. テーブル

```
users 1 ──< sessions
users 1 ──< cases (requester)
cases 1 ──< case_messages
cases 1 ── 1 pc_snapshots
cases 1 ── 1 tickets ── 1 resolutions
tickets 1 ── 1 resolutions
resolutions 1 ── 0..1 knowledge
cases 1 ── 0..1 knowledge
knowledge 1 ──< knowledge_reviews
users 1 ──< audit_log (actor)
```

| テーブル | 主な列 | 制約・索引 |
|---|---|---|
| `users` | email, name, role, password_hash, is_active | role は requester/helpdesk/approver。email の lower 一意 |
| `sessions` | user_id, token_hash, expires_at | token_hash 一意。user_id / expires_at 索引 |
| `cases` | case_no, requester_id, category, subject, body, urgency, signal, current_step, status, ai_resolved, ai_summary, shared_pc_info | case_no 一意。status/signal/requester/created 索引。step 1..7 |
| `case_messages` | case_id, author_id, role, kind, content, metadata | case_id + created_at 索引 |
| `pc_snapshots` | case_id, collected_at, items(jsonb), concerns(jsonb), shared, source | case_id 一意 |
| `tickets` | case_id, tkt_no, inc_no, assignee_id, status, handoff_memo, shared_fields(jsonb) | case_id / tkt_no / inc_no 一意 |
| `resolutions` | ticket_id, case_id, author_id, cause, steps, duration_min | ticket_id 一意 |
| `knowledge` | kb_no, case_id, resolution_id, title, symptom, cause, steps, keywords(text[]), status, author_id, approver_id, version | kb_no / resolution_id 一意。status / keywords GIN 索引 |
| `knowledge_reviews` | knowledge_id, reviewer_id, decision, comment, checklist(jsonb) | knowledge_id + created_at 索引 |
| `audit_log` | actor_id, action, target_type, target_id, detail(jsonb), prev_hash, hash | created_at / target 索引。追記のみ |
| `prototype_states` | user_email, name(cowork/helpdesk), data(jsonb), updated_at | 主キー(user_email,name)。既存プロトタイプ UI の状態保存（migration 002） |

### 2-1. 状態値

| 列 | 値 |
|---|---|
| `cases.status` | `draft` / `awaiting_decision` / `ai_resolved` / `handoff_pending` / `in_progress` / `knowledge_pending` / `completed` / `cancelled` |
| `cases.signal` | `blue` / `amber` / `red` |
| `tickets.status` | `queued` / `assigned` / `in_progress` / `resolved` / `closed` |
| `knowledge.status` | `draft` / `pending` / `approved` / `rejected` |
| `case_messages.role` | `user` / `assistant` / `system` |
| `case_messages.kind` | `consultation` / `ai_assessment` / `decision` / `handoff` / `resolution` / `knowledge` / `note` |

## 3. Migration

- ファイル: `db/migrations/001_init.sql`
- 実行: `npm run db:migrate`
- `schema_migrations` で適用済みを管理。**空 DB から再実行可能**。
- SQL は `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` のみ。DROP / TRUNCATE を含まない。
- 番号採番は sequence（`case_no_seq` / `inc_no_seq` / `kb_no_seq`）。`TKT-YYYY-NNNN` 形式。4桁を超える場合は桁数を維持する（`lpad` の切り詰め対策済み）。
- 適用実績: `001_init.sql` を dev / test の両 DB に適用済み（2026-10-23）。

## 4. Seed

- 実行: `npm run db:seed`
- 再実行可能（`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`）。**TRUNCATE / DROP を使わない**。
- 内容:
  - ユーザー 6 名（相談者 3 / ヘルプデスク 2 / 承認者 1）。パスワードは `SEED_PASSWORD` を scrypt でハッシュ化。
  - 承認済みナレッジ 4 件（共有フォルダ / Teams 音声 / 印刷 / VPN）。
  - デモ案件 3 件（完了・ナレッジ公開済 1、VPN 対応中 1、セキュリティ赤 1）。
  - TKT/INC、解決記録、PC 基本情報（デモ 31 項目）、メッセージ、監査ログ 1 件。
- シーケンスは既存の最大値より後ろへ進める（再 Seed で衝突しない）。
- `SEED_PASSWORD` は `.env.local` のみ。リポジトリ・PR・ログへ書かない。

## 5. バックアップ / 復元

```bash
# スキーマ＋データ（検証用）
pg_dump "$DATABASE_URL" --format=custom --file=/tmp/aihd-$(date +%Y%m%d%H%M).dump

# 復元は「新しい DB」に対して行う（既存 DB を上書きしない）
createdb -h 127.0.0.1 -p 5435 aihd_restore
pg_restore --dbname=postgresql://.../aihd_restore /tmp/aihd-*.dump
```

- 破壊的操作（DROP DATABASE / DROP TABLE / TRUNCATE / 大量 DELETE）は、ユーザー承認なしに実行しない。
- テストデータの削除は、対象を明示した小さな DELETE に限定する。

### 5-1. 復元実測（2026-10-23）

- PG16 サーバーに対して `pg_dump` 17 の custom / plain 形式は
  `transaction_timeout` 非対応で失敗した。**`/usr/lib/postgresql/16/bin/pg_dump` を使用する**。
- plain 形式で dump → 新規 DB `aihd_restore_verify_*` へ `psql -f` で復元 → 件数一致を確認。
  - users 6 / cases 7 / knowledge 5 / tickets 5 / audit 32
- 既存 DB への上書き復元は行っていない。

## 6. 検証済み

| 項目 | 結果 |
|---|---|
| 空 DB → migrate | 成功（dev / test） |
| migrate 再実行 | `skip` で成功（冪等） |
| seed 再実行 | 成功（重複なし） |
| 主要 Read/Write | 案件作成、引継ぎ、解決、ナレッジ承認、監査検証を API integration test で確認 |
| 監査チェーン | 27 件時点で `ok: true`（手動 API 検証。その後 32 件へ増加） |
