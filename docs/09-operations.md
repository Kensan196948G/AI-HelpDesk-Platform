# 運用・復旧（MVP）

## 1. 起動・停止

```bash
# API（開発）
npm run dev:api

# API（ビルド済み）
npm run build
npm run start:api

# Preview（systemd）
systemctl --user start ai-helpdesk-api.service
systemctl --user stop ai-helpdesk-api.service
systemctl --user restart ai-helpdesk-api.service
systemctl --user status ai-helpdesk-api.service

# ローカル・プロキシ（Tunnel → 18949 → API 18950 / X-Proxy-Secret）
systemctl --user status ai-helpdesk-proxy.service
systemctl --user restart ai-helpdesk-proxy.service
scripts/install-proxy-service.sh        # 初回登録（冪等）
curl -fsS http://127.0.0.1:18949/api/health
```

## 2. ログ

```bash
# systemd
journalctl --user -u ai-helpdesk-api.service -n 200 --no-pager
journalctl --user -u ai-helpdesk-cloudflared.service -n 100 --no-pager

# 開発
# 標準出力（Fastify の構造化ログ）
```

- ログにはリクエスト ID・メソッド・パス・ステータス・応答時間のみ。
- Cookie / Authorization / X-Proxy-Secret / X-Device-Token は redact。本文・PII は出力しない。
- 5xx が続く場合は `/api/health` と DB 接続を確認する。

## 3. ヘルスチェック

```bash
curl -fsS http://127.0.0.1:18950/api/health
# 公開URLの /api/health は Cloudflare Access の保護対象（未ログインは 302）。
# 外形監視する場合は Access のサービスドメインまたはローカル監視を使う。
```

`{ok:true, db:"ok"}` を確認。`db:"error"` の場合は PostgreSQL の起動・接続情報を確認する。

## 4. バックアップ / 復元

```bash
# 取得（毎日 or 配備前）
# PG16 サーバーでは PG16 の pg_dump を使う（17 の dump は transaction_timeout で失敗）
/usr/lib/postgresql/16/bin/pg_dump "$DATABASE_URL" --format=plain \
  --no-owner --no-privileges --file="$HOME/aihd-backup-$(date +%Y%m%d).sql"

# 復元（新しい DB に対してのみ）
createdb -h 127.0.0.1 -p 5435 aihd_restore
psql "postgresql://.../aihd_restore" -v ON_ERROR_STOP=1 -f "$HOME/aihd-backup-YYYYMMDD.sql"
```

- 既存 DB への上書き復元はしない。
- DB は追加のみの Migration。ロールバックはアプリ側の `git revert` を優先する。
- 破壊的操作（DROP / TRUNCATE / 大量 DELETE）はユーザー承認後に限定実行する。

### 4-1. 日次バックアップ（自動・2026-10-25 追加）

```bash
# 手動実行（同じ処理を timer が毎日 02:30 JST に実行する）
scripts/backup-db.sh

# timer の登録（初回のみ・冪等）
scripts/install-backup-timer.sh
systemctl --user list-timers ai-helpdesk-backup.timer
```

| 項目 | 内容 |
|---|---|
| 保存先 | `~/backups/ai-helpdesk/ai_helpdesk_preview-YYYYmmdd-HHMMSS.dump`（ディレクトリ 0700 / ファイル 0600） |
| 形式 | `pg_dump --format=custom`（PG16 のバイナリを使用） |
| 検証 | 一時ファイルへ取得し、`pg_restore --list` で読めたものだけを正式名へ移す。失敗時は一時ファイルを消し、古い dump も消さない |
| 保持 | 14 日（`AIHD_BACKUP_KEEP_DAYS`）。対象 DB 名の dump だけを削除 |
| ログ | `~/backups/ai-helpdesk/backup.log`。成功は `OK`（DB 名・ファイル名・サイズ・SHA-256）、失敗は `FAIL stage=... exit=...`。接続文字列は出さない |
| 認証 | `~/.config/ai-helpdesk/api.conf`（0600）から `DATABASE_URL` だけを読む。**シェルとして読み込まない**（systemd の EnvironmentFile 形式で、値の `|` などをシェルが解釈するため）。接続情報は libpq の環境変数で渡し、プロセス引数へ出さない |
| 失敗時 | systemd の `ai-helpdesk-backup.service` が failed になり、メールで通知する（下記）。`journalctl --user -u ai-helpdesk-backup.service` を確認 |
| 通知 | 毎回の実行後に `ExecStopPost` で `scripts/backup-alert.mjs` が動き、バックアップの失敗か `/` の使用率 90% 超があるときだけメールを送る。両方なら 1 通にまとめる。何も無ければ送らない |
| 通知の宛先 | `api.conf` の `OPS_ALERT_EMAIL`（カンマ区切り）。空なら `HANDOVER_NOTIFY_EMAIL`。送信は `SMTP_*` / `MAIL_FROM` を使う（SMTP のみ。`MAIL_TRANSPORT=disabled` / `sendmail` では送らず、`not-sent` を記録する） |
| 通知の記録 | `backup.log` に `NOTIFY ... sent recipients=N` / `NOTIFY ... not-sent reason=...`、journal にも同じ結果。本文とログに秘密・接続文字列・メールアドレスを入れない |

- 復元は従来どおり**新規 DB**に対して行う（`pg_restore -d aihd_restore <dump>`）。既存 DB へは上書きしない。
- disk 使用量は 1 回あたり約 85KB（2026-10-25 実測）。保持 14 日でも数 MB。

### 4-2. 復元確認の手順（隔離 DB）

目録読取の成功は復元成功ではない。定期的に、新規の使い捨て DB へ実際に復元して照合する。

1. `aihd_restore_verify_YYYYmmddHHMMSS` の名前で新規 DB を作る（既存 DB には復元しない）。
2. `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d <新規DB> <dump>`。
3. テーブル一覧、列数、制約、インデックス、関数、トリガ、全テーブルの件数、`schema_migrations`、未検証の外部キー、監査チェーン（`verifyAuditChain`）を元 DB と照合する。
4. 自分が作った DB だけを名前で確認して削除する。

**失敗の検知**: バックアップが失敗するとメールで通知する（§4-1）。手動では `systemctl --user status ai-helpdesk-backup.service` が failed、`backup.log` に `FAIL`、または最新の `OK` が 26 時間以上前を確認する。

**通知が届かない場合**: 通知はバックアップの実行に続けて動くので、次の場合は届かない。最新の `OK` の時刻で確認する。

- timer が止まっている、サーバーが動いていない（実行自体が起きない）。
- `WorkingDirectory` のチェックアウトまたは unit の node が無い（通知スクリプトも起動できない）。
- SMTP の認証失敗など送信の失敗（`backup.log` に `not-sent` が残る）。

### 4-3. 障害記録（2026-10-29〜31）

`api.conf` への `SHARED_IDENTITY_GROUPS=a|b` の追加（2026-10-28）以降、`backup-db.sh` が設定をシェルとして読み込んだ際に `|` をパイプと解釈し、終了コード 127 で失敗し続けた。最後の成功は 2026-10-28 02:30。失敗の間、誰にも通知されなかった。再発防止として通知を追加した（§4-4）。

`set-smtp-password.sh` にも同じ読み込みがあり修正済み。`set -a; . ~/.config/ai-helpdesk/api.conf` と書いた手順（本書 §6-1、`docs/08-deployment.md`、`docs/22-remote-assist-handover.md`、`README.md`）は、同じ理由で今の `api.conf` では失敗する（未修正）。

### 4-4. 通知の反映手順

リポジトリの変更だけでは動かない。unit は `~/.config/systemd/user/` の複製を使い、`WorkingDirectory` はメイン作業ツリーなので、マージ後に次の順で反映する。サービスの再起動は要らない（oneshot は次回の timer から新しい定義で動く）。

```bash
# 1) メイン作業ツリーをマージ済みの main へ進める（nodemailer を使うので有無も確かめる）
cd ~/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
git status --short
git pull --ff-only origin main
test -f node_modules/nodemailer/package.json

# 2) 本文を確認する（送らない）
SERVICE_RESULT=exit-code EXIT_CODE=exited EXIT_STATUS=1 node scripts/backup-alert.mjs --dry-run

# 3) unit を置いて読み直す
install -m 0644 ops/systemd/ai-helpdesk-backup.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user cat ai-helpdesk-backup.service | grep ExecStopPost
systemctl --user list-timers ai-helpdesk-backup.timer --no-pager

# 4) 配送を確認する（宛先へ実際に 1 通送る。件名に「配送確認の試験」と入る）
node scripts/backup-alert.mjs --test
tail -n 1 ~/backups/ai-helpdesk/backup.log
```

- 1) を 3) より先に行う。逆順でも `ExecStopPost` の `-` によりバックアップは失敗しないが、通知は出ない。
- `scripts/install-backup-timer.sh` でも 3) の配置と読み直しを行う（`enable --now` も実行する）。
- 宛先を分ける場合は 4) の前に `api.conf` へ `OPS_ALERT_EMAIL` を追加する。API は読まないので再起動は要らない。
- node の版を上げたら、`ai-helpdesk-backup.service` の `ExecStopPost` の絶対パスも更新する（`ai-helpdesk-proxy.service` と同じ）。
- 戻すとき: `git show <反映前の commit>:ops/systemd/ai-helpdesk-backup.service` の内容を `~/.config/systemd/user/` へ置いて `systemctl --user daemon-reload`。


## 5. インシデント対応（個人利用 MVP）

| 症状 | 確認 | 対応 |
|---|---|---|
| 画面が真っ白 | Worker の配信、CSP、ブラウザコンソール | 直前の Worker deployment へ rollback |
| API が 502 | Tunnel / API systemd / health | Tunnel と API を再起動、health 確認 |
| ログインできない | Cookie の Secure / SameSite、Origin、DB | 環境変数と `users` を確認 |
| データが増えない | DB 接続、Migration、API ログ | `db:migrate` / seed 状態と 5xx を確認 |
| 監査検証が失敗 | 直近の操作、DB の手動変更 | 変更を止め、バックアップと差分を確認 |
| PII が表示された | 保存前の伏せ字、ログ | 直ちに該当レコードを確認し、再発防止 |
| PC情報が更新されない | `device_inventories.updated_at`、エージェントの HTTP ステータス | トークン・URL・Access bypass を確認。`--once` で再送 |
| エージェントが 401 | トークンの失効・削除 | 再発行し、設定ファイルを 0600 で更新 |
| 導入ソフトが多すぎる | `software` は 300 件上限 | 必要なら allowlist / 除外を設計（B-25） |

## 6. 定期メンテナンス

- 依存更新: `npm outdated` → `npm audit` → PR（CI が有効化された後）。
- セッション: 期限切れはログイン時に削除。不要なら `DELETE FROM sessions WHERE expires_at <= now()`（テスト DB のみ）。
- 監査ログ: 追記のみ。削除しない。
- ナレッジ: 誤りがあれば差戻し → 修正 → 再承認。公開済みを直接 UPDATE しない。

## 6-1. 端末エージェント運用

```bash
# サービス環境を読み込む（秘密値は表示しない）
set -a; . ~/.config/ai-helpdesk/api.conf; set +a

# 発行（既存設定に deviceToken を追記。値は画面へ出さない）
NODE_ENV=production npx tsx scripts/issue-device-token.ts \
  --email user@mirai-const.co.jp --out ~/.config/ai-helpdesk/device-agent.json

# 対象PCで1回送信（画面の WEB-XXXXXXXX を指定してブラウザ端末へリンク）
node scripts/endpoint-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json \
  --browser-device-id WEB-XXXXXXXX --once

# Windows で取得失敗を確認
node scripts/endpoint-agent.mjs --config %USERPROFILE%\.config\ai-helpdesk\device-agent-windows.json \
  --browser-device-id WEB-XXXXXXXX --debug --dry-run

# 状態確認（DB）
# device_inventories.updated_at / source / software 件数
# device_tokens.last_used_at / revoked_at
```

- 失効: `UPDATE device_tokens SET revoked_at = now() WHERE user_email = '...'`。
- 再発行: 新しいトークンを発行し、設定ファイルを差し替える（古いトークンは失効）。
- 設定ファイルの権限は **0600**。リポジトリ・ログ・チャットへ貼らない。
- 定期実行は OS のスケジューラから `--once` を呼ぶ（60 分間隔を推奨）。
- エージェントは読み取り専用。修復・設定変更・遠隔操作は行わない。
- 端末は `device_id` 単位で分離される。未リンクの agent（例: サーバー上の Ubuntu）は、ブラウザ端末のPC情報には混ざらない。
- リンクコードはPCチェック画面の端末名（`WEB-XXXXXXXX`）で確認できる。別端末のコードを指定すると、その端末の情報として保存される。

### Windows: ログオン時 + 定期実行（Node不要）

> **実行場所: Windows クライアントの PowerShell。** Linux サーバーの bash では動かない。Linux は Node 版 `endpoint-agent.mjs` を使う。

```powershell
# 登録（初回のみ）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-collector-task.ps1 `
  -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"

# 手動実行 / 状態確認
Start-ScheduledTask -TaskName AIHelpDesk-Collector
Get-ScheduledTaskInfo -TaskName AIHelpDesk-Collector
Get-Content "$env:LOCALAPPDATA\AIHelpDesk\collector.log" -Tail 20

# 削除
Unregister-ScheduledTask -TaskName AIHelpDesk-Collector -Confirm:$false
```

- 常駐プロセスは持たない。ログオン時と60分ごとに `collect-pc-info.ps1` が1回実行される。
- 失敗時は `collector.log` と `-DryRun -PrintJson` で確認する。秘密値（トークン）はログへ出さない。
- BitLocker の状態は管理者権限が必要な場合がある。タスク実行ユーザーでは「未検出」になることがある。管理者PowerShellで `install-collector-task.ps1 -Elevated` を実行すると、タスクが最高権限で登録されオン/オフを取得できる。
- 多数PCへは GPO / Intune のログオンスクリプトで同じインストーラを実行する。

## 7. 既知の運用制約

- Preview は Cloudflare Tunnel + Access で公開済み（[docs/08-deployment.md](08-deployment.md) §0）。
- CI 未設定。GitHub Actions は policy gate で追加できない。
- 人間の UI / API は Cloudflare Access、端末エージェントはパス限定 bypass + デバイストークン。
- デモパスワードは Preview 専用。本番では SSO に置き換える。
- 端末エージェントは 1 ユーザー 1 端末。複数端末は B-24。
- 導入ソフトは 300 件上限。AI へは関連ソフト最大 20 件のみ送信。
