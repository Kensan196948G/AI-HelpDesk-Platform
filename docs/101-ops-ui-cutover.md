# 101. 運用統合 UI（/ops）の配備・切替・ロールバック手順（2026-11-11）

## 0. この文書の位置づけ

[docs/100](100-ops-console-migration.md) で段階移植した運用統合 UI を **Staging → 本番**へ配備し、必要なら `/` を新 UI に切り替えるための手順書。

**現時点では未配備・未切替**（この文書は実施手順であり、実施記録ではない）。実施した日は末尾に実測値を追記する。

## 1. 配備対象（実測）

| 項目 | 値 |
|---|---|
| commit | `90b733d`（main / origin/main） |
| 本番の稼働中 release | `releases/20261111T144004-4ce1c7d79611`（commit `4ce1c7d`） |
| 変更規模 | `4ce1c7d..90b733d` = 31 files / +6,103 −15 |
| 新規 migration | **038〜045 の 8 本** |
| 設定変更 | **不要**（`OPS_UI_PRIMARY` は既定 `false` のまま。切替時だけ変更） |

### 新規 migration（本番 DB へ適用される）

| # | 内容 | 種別 |
|---|---|---|
| 038 | `ops_tickets`（受付チケット） | 新規テーブル |
| 039 | `ops_tickets` に担当・原因・手順・所要を追加 | 列追加 |
| 040 | `knowledge` に `author_email` / `approver_email` / `category` を追加、`author_id` を NULL 可 | **既存テーブル**の変更（後述） |
| 041 | `ops_skills` / `ops_reflect`（Skills 反映） | 新規テーブル＋初期 7 行 |
| 042 | `ops_estop`（緊急停止のサーバ保存） | 新規テーブル＋1 行 |
| 043 | `ops_settings`（システム設定） | 新規テーブル |
| 044 | `ops_ticket_messages`（会話ログ） | 新規テーブル |
| 045 | `ops_tickets.pc_info` | 列追加 |

## 2. 配備前の実測（2026-11-11 19:58 JST・読み取りのみ）

| 確認 | 結果 |
|---|---|
| 本番 health | `commit=4ce1c7d` / `db=ok` / `ok=true`（127.0.0.1:18950、proxy secret 経由） |
| 本番 release | `releases/20261111T144004-4ce1c7d79611` |
| 本番 migrations | **37 件適用済み、最新 `037_knowledge_review_binding.sql`** |
| 038 以降 | **0 件（未適用）** |
| ops 系テーブル | **0 件（未作成）** |
| Staging | commit `4ce1c7d`（本番と同一 release 系列）で稼働 |

## 3. 配備手順（Staging → 本番）

### 3-1. Staging

```bash
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
REF=$(git -C "$MAIN" rev-parse HEAD)

# 事前（read-only）
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health
readlink -f /home/kensan/ai-helpdesk-stg/current

# 配備（DB 変更があるため --migrate を付ける）
bash "$MAIN/scripts/deploy-release.sh" \
  --repo "$MAIN" --ref "$REF" \
  --root /home/kensan/ai-helpdesk-stg \
  --env-file /home/kensan/ai-helpdesk-stg/current/release.env \
  --unit ai-helpdesk-stg-api --health-port 18952 \
  --migrate
```

### 3-2. 本番

```bash
# 事前（read-only）: backup・health・current を確認
ls -lt /home/kensan/backups/ai-helpdesk | head -3
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
readlink -f /home/kensan/ai-helpdesk-prod/current

# 配備（unit テンプレート＋--migrate。restart 失敗時は自動 rollback）
bash "$MAIN/scripts/deploy-release.sh" \
  --repo "$MAIN" --ref "$REF" \
  --root /home/kensan/ai-helpdesk-prod \
  --env-file /home/kensan/.config/ai-helpdesk/api.conf \
  --unit ai-helpdesk-prod-api --health-port 18950 \
  --unit-template "$MAIN/ops/systemd/ai-helpdesk-prod-api.service" \
  --migrate
```

- `--seed` は**渡さない**（本番データを入れない）。
- `--unit-template` 使用時は `--env-file` に `DATABASE_URL` / `SESSION_SECRET` が必須（PR #169 のガード）。
- 秘密値は argv・ログ・証跡に出さない（runbook §0-1）。

## 4. 配備後の確認（各環境）

| # | 確認 | 期待 |
|---|---|---|
| D-1 | `/api/health` の `commit` | `90b733d` と一致 |
| D-2 | 本番 migrations | 45 件（038〜045 を含む） |
| D-3 | ops 系 6 テーブル | 作成済み（`ops_tickets` / `ops_skills` / `ops_reflect` / `ops_estop` / `ops_settings` / `ops_ticket_messages`） |
| D-4 | `/` の表示 | **旧 UI のまま**（`OPS_UI_PRIMARY=false`） |
| D-5 | `/legacy` | 旧 UI が 200 |
| D-6 | `/ops`（Access ログイン後） | 新 UI が表示・12 メニュー・移行バナー |
| D-7 | `/ops` の実データ | ⑦KB 件数・Skills 7 カテゴリ・設定値・監査件数が DB と一致 |
| D-8 | 受付→AI（1 件） | `OPS-####` が作成され、`/api/ops/tickets` に出る。会話 `sys/user/ai` が残る |
| D-9 | ③担当開始→④解決 | `resolved` と原因・手順が DB に残る（テスト案件は削除またはクローズ） |
| D-10 | 監査鎖 | `/ops/status` の `audit.ok` が true（既知の乖離のみ許容） |
| D-11 | 旧 UI の主要操作 | 相談受付・引継ぎ・承認が従来どおり（退行がない） |

## 5. `/` の切替（任意・オーナー判断）

```bash
# 本番 api.conf に追記（秘密ではない）
OPS_UI_PRIMARY=true

# 再起動のみ（release の切替は不要）
systemctl --user restart ai-helpdesk-prod-api
```

切替後の確認:

- `/` が新 UI（12 メニュー）、`/legacy` が旧 UI。
- 旧 UI のブックマークは `/legacy` で引き続き動く。

### ロールバック

```bash
# 1) 設定を戻す（1 行）
sed -i 's/^OPS_UI_PRIMARY=true/OPS_UI_PRIMARY=false/' /home/kensan/.config/ai-helpdesk/api.conf
systemctl --user restart ai-helpdesk-prod-api

# 2) 配備自体を戻す場合（DB は 038〜045 適用済みのままで問題ない）
sudo -u kensan bash -c 'ln -sfn releases/20261111T144004-4ce1c7d79611 /home/kensan/ai-helpdesk-prod/current'
systemctl --user restart ai-helpdesk-prod-api
```

- **DB のロールバックは行わない**。038〜045 は新規テーブルと列追加のみで、旧 UI はこれらを読まない。040 の `author_id` NULL 可も旧 UI の書き込み経路は常に値を入れるため退行しない。
- 逆に 040 を取り消すと新 UI の下書きが壊れるため、**列は残す**のが正しい。

## 6. リスクと対策

| リスク | 対策 |
|---|---|
| 040 による `knowledge.author_id` の NULL 許容 | 旧 UI は常に author_id を設定する。新 UI の下書きは `author_email` で識別。**削除しない** |
| 既存 UI の退行 | 配備後 D-4〜D-6・D-11 を確認。`/` は既定で旧 UI のまま |
| 新 UI の未知の不具合 | `/` は旧 UI のままなので業務影響なし。`/ops` は Access 保護下の検証用 |
| 緊急停止の二重管理 | 新 UI はサーバ 1 行（`ops_estop`）、旧 UI は従来どおり画面ローカル。**切替時に新 UI へ寄せる**（§7） |
| 秘密・PII | 台帳 API は IP/シリアルを返さない。リモートセッションはマスクしたメールのみ。設定に秘密を置かない |

## 7. 切替時に残る差（受容か移植かの判断が必要）

| 項目 | 現状 |
|---|---|
| リモート対応の**端末特定・RSP 接続・強制切断** | 旧 UI（`/legacy`）でのみ可能 |
| **端末診断・修復の自動化** | 未実装（新 UI はブラウザ実測の事実表示のみ） |
| フォルダアクセス・サポートセッション | **旧 UI だけの機能**（添付の 14 画面に含まれない） |
| 緊急停止 | 新 UI はサーバ保存、旧 UI はローカル。切替後は新 UI を正とする |

## 8. 実施記録（実施時に追記）

| 日時 | 環境 | release / commit | 結果 | 備考 |
|---|---|---|---|---|
| — | — | — | 未実施 | この文書の手順は未実行 |

## 9. 参照

- 移行計画・各段の実装: [docs/100](100-ops-console-migration.md)
- 配備スクリプト: `scripts/deploy-release.sh`、unit テンプレート `ops/systemd/ai-helpdesk-prod-api.service`
- 正本の手順: [docs/82](82-promotion-runbook-20261106.md)、[docs/85](85-production-cutover-20261106.md)
- 前回の配備記録: [docs/98](98-deploy-webui-20261111.md)
