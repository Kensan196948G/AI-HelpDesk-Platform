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
- Cookie / Authorization / X-Proxy-Secret は redact。本文・PII は出力しない。
- 5xx が続く場合は `/api/health` と DB 接続を確認する。

## 3. ヘルスチェック

```bash
curl -fsS http://127.0.0.1:18950/api/health
curl -fsS https://ai-helpdesk-api.mirai-dx-platform.com/api/health
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

## 6. 定期メンテナンス

- 依存更新: `npm outdated` → `npm audit` → PR（CI が有効化された後）。
- セッション: 期限切れはログイン時に削除。不要なら `DELETE FROM sessions WHERE expires_at <= now()`（テスト DB のみ）。
- 監査ログ: 追記のみ。削除しない。
- ナレッジ: 誤りがあれば差戻し → 修正 → 再承認。公開済みを直接 UPDATE しない。

## 7. 既知の運用制約

- Preview は policy gate のため未配備（[docs/08-deployment.md](08-deployment.md) §3）。
- CI 未設定。ローカル検証のみ。
- SSO・Access・WAF なし。Preview はアプリ認証＋共有秘密で保護する前提。
- デモパスワードは Preview 専用。本番では SSO に置き換える。
