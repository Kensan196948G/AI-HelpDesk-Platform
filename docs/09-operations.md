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
- 多数PCへは GPO / Intune のログオンスクリプトで同じインストーラを実行する。

## 7. 既知の運用制約

- Preview は Cloudflare Tunnel + Access で公開済み（[docs/08-deployment.md](08-deployment.md) §0）。
- CI 未設定。GitHub Actions は policy gate で追加できない。
- 人間の UI / API は Cloudflare Access、端末エージェントはパス限定 bypass + デバイストークン。
- デモパスワードは Preview 専用。本番では SSO に置き換える。
- 端末エージェントは 1 ユーザー 1 端末。複数端末は B-24。
- 導入ソフトは 300 件上限。AI へは関連ソフト最大 20 件のみ送信。
