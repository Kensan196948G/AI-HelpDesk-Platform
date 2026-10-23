# Deployment（Preview / 検証環境）

## 0. 実配備（2026-10-23 / Tunnel + Access）

> ユーザー指示（2026-10-23）により、WebUI は既存プロトタイプ HTML をそのまま配信し、
> Cloudflare Tunnel + Access で公開する経路に変更した。Worker / Pages は使用しない。

| リソース | 値 |
|---|---|
| 公開 URL | https://ai-helpdesk.mirai-dx-platform.com （Access ログインへ 302） |
| Access アプリ | `Mirai AI HelpDesk MVP` / `44de6fdd-d2c3-4c2b-8e8b-3be092dc1eae` / 12h / OTP |
| Access ポリシー | **allow 1 件（2026-10-23）**: `kensan1969@gmail.com`（完全一致）/ `@mirai-const.co.jp`（メールドメイン） / ID `1a05a10a-64ed-40c4-ae28-ac5f4707c9dc` |
| Access アプリ（エージェント） | `AI HelpDesk Endpoint Agent (device token)` / ID `250fa30a-d49c-4a83-b773-8fbdec3c0b6a` / `/api/device/agent` のみ bypass |
| Access ポリシー（エージェント） | `Device token only (no browser session)` / bypass / ID `490f1c8f-4700-46e6-b928-b990c6a98cf6` |
| Tunnel | `ai-helpdesk` / `96d0214e-8236-4bce-8dd0-75233d1e716f` |
| Tunnel config | `~/.cloudflared/ai-helpdesk-config.yml` |
| API service | `ai-helpdesk-api.service`（Node 22 / 127.0.0.1:18950） |
| Tunnel service | `ai-helpdesk-cloudflared.service` |
| DB | Local PostgreSQL `ai_helpdesk_preview`（migration 003/004 適用済み） |
| DNS | CNAME `ai-helpdesk` → `96d0214e-...cfargotunnel.com`（proxied） |

- `AUTH_MODE=cloudflare-access`。アプリ内ログインは無効（`/api/auth/login` は 404）。
- API は `Cf-Access-Authenticated-User-Email` を検証。ヘッダーなし 401、許可外 403。
  許可リストの正本は `docs/MailAddress.txt`（`ACCESS_ALLOWLIST_FILE`）。ファイルなし・空は全拒否（fail-closed）。
- 12h の自動ログオフは Access のセッション期限で実現。
- DeepSeek API キーは `~/.config/ai-helpdesk/api.conf`（0600）に置く。未設定時はフォールバック。
- `DEEPSEEK_MODEL=deepseek-flash` / `DEEPSEEK_THINKING=disabled`（DeepSeek-V4.1-Flash）。
- 実測（2026-10-23 15:25 JST）: 公開 URL は 302 → `winter-lake-f4c9.cloudflareaccess.com` の OTP 画面。
  ローカル origin は ヘッダーなし 401 / 許可（`kensan1969@gmail.com`・`@mirai-const.co.jp`）200 /
  許可外・例示 typo・サブドメイン 403 / 許可リスト欠落・空 403（自動テスト）/ `/api/health` 200。
  起動ログに `アクセス許可リストを読み込みました（emails=1, domains=1）` を確認。
- OTP 実ログイン（2026-10-23 15:32 JST）: Cloudflare Access ログで `Mirai AI HelpDesk MVP` / `onetimepin` / `allowed=true` を確認。
- 注意: `cloudflared tunnel route dns <name>` はデフォルト config の tunnel を選ぶことがあった。
  DNS は UUID 指定 + `--overwrite-dns` で修正した。既存の `ai-design` 等には変更なし。
- 注意: ローカル DNS 192.168.245.11 は新ホストを NXDOMAIN キャッシュ中。1.1.1.1 では解決済み。
- 実測（2026-10-23 16:10 JST）: `deepseek-flash` で `/api/ai/answer` が `provider: deepseek` / `model: deepseek-flash` を返し、PC 情報（16GB / 8 コア / Windows 11 / GPU）を回答に反映。
- 実測（2026-10-23 16:12 JST）: 端末エージェントを公開 URL へ送信し 200。`device_inventories` に 300 ソフトを保存。
- エージェント用の Cloudflare サービスドメイン（service token）は、現在の API 資格情報に `access-service-token.write` が無いため作成できず、**パス限定 bypass + デバイストークン**で実装した。将来はサービスドメインへ移行する（[10-backlog.md](10-backlog.md) B-23）。

### 0-1. 端末エージェント（実PC情報・読み取り専用）

- 配布物: `scripts/endpoint-agent.mjs`（Node.js 20+、追加依存なし）。
- 設定: `~/.config/ai-helpdesk/device-agent.json`（0600）。
  ```json
  {
    "url": "https://ai-helpdesk.mirai-dx-platform.com/api/device/agent",
    "deviceToken": "aihd_...",
    "browserDeviceId": "WEB-XXXXXXXX",
    "intervalMinutes": 60
  }
  ```
- トークン発行（管理者・1回。事前にサービス環境を読み込む）:
  ```bash
  set -a; . ~/.config/ai-helpdesk/api.conf; set +a
  NODE_ENV=production npx tsx scripts/issue-device-token.ts \
    --email user@mirai-const.co.jp --out ~/.config/ai-helpdesk/device-agent.json
  ```
- 実行（対象PC上）:
  ```bash
  node scripts/endpoint-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json \
    --browser-device-id WEB-XXXXXXXX --once
  # 定期実行はタスクスケジューラ / systemd timer / cron から --once を呼ぶ
  ```
- 収集: OS / CPU / メモリ / ディスク / GPU / ネットワーク / バッテリー / プリンター / 音声 / USB / 導入ソフト / セキュリティ状態。
- 非収集: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文。
- 失敗時: `401` はトークン不正、`302` は Access 設定、`ETIMEDOUT` はネットワーク。トークンは設定ファイル以外へ保存しない。
- Windows で PowerShell の取得に失敗する場合は `-Verbose -DryRun -PrintJson` を付けると、失敗したコマンドと取得内容を表示する（秘密値は出ない）。
- Windows の設定例: `%USERPROFILE%\.config\ai-helpdesk\device-agent-windows.json`（0600 相当の保護フォルダ）。`browserDeviceId` はPCチェック画面の `WEB-XXXXXXXX`。
- 本環境では `kensan1969@gmail.com` 用の設定を `~/.config/ai-helpdesk/device-agent.json`（0600）に作成済み。
  Windows クライアント用は `~/.config/ai-helpdesk/device-agent-windows.json`（0600、`browserDeviceId: WEB-206AD268`）に作成済み。対象PCへ安全にコピーして実行する。
- 現在のブラウザ端末は Windows 11（`WEB-206AD268` / 6 論理コア / 32GB / Intel UHD 630）。Ubuntu 上のエージェントは未リンクのため表示されない。
- **重要**: エージェントは実行した端末の情報を送る。サーバー上で実行した agent をブラウザ端末へリンクしないこと。

#### Windows: Node不要のバックグラウンド収集（PowerShell + タスクスケジューラ）

> **実行場所: Windows クライアントの PowerShell。** Linux サーバーの bash では `powershell` / `Start-ScheduledTask` が存在しないため実行できない。Linux は Node 版を使う。

常駐エージェントではなく、ログオン時 + 60分ごとに CLI を1回実行する方式。

```powershell
# 対象PC（管理者が必要な場合あり）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-collector-task.ps1 `
  -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
```

- `install-collector-task.ps1` は `collect-pc-info.ps1` と設定を `%LOCALAPPDATA%\AIHelpDesk\` にコピーし、タスク `AIHelpDesk-Collector` を登録する。
- タスク: ログオン時 + 60分間隔、隠しウィンドウ、常駐なし。ログは `%LOCALAPPDATA%\AIHelpDesk\collector.log`。
- 手動: `Start-ScheduledTask -TaskName AIHelpDesk-Collector`。
- 停止: `Unregister-ScheduledTask -TaskName AIHelpDesk-Collector -Confirm:$false`。
- 多数PCへは GPO / Intune のログオンスクリプトで配布する（PCごとの手作業なし）。
- 検証: PowerShell 構文・`-DryRun`・API送信（35項目）を Linux の pwsh で確認済み。Windows実機では CIM / Defender の取得を確認済み。BitLocker は実行ユーザーの権限で未検出になるため、管理者PowerShellで `-Elevated` を付けて再登録する。
- **方式の限界**: ブラウザだけではインストールソフト・Windows 11 Pro のエディションは取得できない。PC側で CLI を動かす必要がある（常駐でなくてよい）。サーバーから WinRM で取りに行く方式は、NAT / Cloudflare 配下のクライアントには届かないため、本環境では採用しない。

## 1. 目標構成

```
Browser
  │
  ▼
Cloudflare Worker（静的配信 + /api プロキシ + セキュリティヘッダ）
  │  X-Proxy-Secret
  ▼
Cloudflare Tunnel（ai-helpdesk-api.mirai-dx-platform.com）
  │
  ▼
Node API（127.0.0.1:18950 / systemd user service）
  │
  ▼
Local PostgreSQL（127.0.0.1:5435 / ai_helpdesk_preview）
```

- Local PostgreSQL はインターネットへ直接公開しない。
- Cloudflare から DB へ直接接続しない。Node API が唯一の DB 接続点。
- Worker は同一オリジンで UI と API を提供するため、Cookie の SameSite 問題を避けられる。
- Production 正式環境は対象外。Preview / 検証環境のみ。

## 2. リソース（新規のみ・既存は変更しない）

| リソース | 名前 | 備考 |
|---|---|---|
| Cloudflare Worker | `mirai-ai-helpdesk-mvp` | Static Assets + API proxy |
| カスタムドメイン（任意） | `ai-helpdesk.mirai-dx-platform.com` | workers.dev でも可 |
| Cloudflare Tunnel | `ai-helpdesk-mvp` | 既存 Tunnel は触らない |
| API ホスト名 | `ai-helpdesk-api.mirai-dx-platform.com` | Tunnel ingress |
| systemd user unit | `ai-helpdesk-api.service` | Node API |
| systemd user unit | `ai-helpdesk-cloudflared.service` | Tunnel |
| DB | `ai_helpdesk_preview` | Preview 用。dev/test と分離 |
| Worker Secret | `PROXY_SECRET` | API と一致 |

## 3. CI（GitHub Actions）

- 2026-10-23: `.github/workflows/ci.yml`（job `verify`）を追加。現在の環境では policy gate による拒否は発生しない。
  内容は [06-test.md](06-test.md) §7。
- 以前のセッションでは DSH の self-evolution policy gate が `.github/workflows/`・`wrangler.*`・`wrangler deploy` を
  DEPLOY（critical）として拒否した。Preview は Cloudflare Tunnel + Access（§0）で公開しており、Worker / Pages は使わない。
- マージ条件: PR の `verify` が success、かつ検証済み head SHA と一致すること（`gh pr merge --squash --match-head-commit <sha>`）。

## 4. 事前準備

```bash
# 1) 依存とビルド
npm ci
npm run typecheck && npm run lint && npm test && npm run build

# 2) Preview 用 DB（新規）
createdb -h 127.0.0.1 -p 5435 ai_helpdesk_preview
export NODE_ENV=production
export DATABASE_URL='postgresql://.../ai_helpdesk_preview'
export SEED_PASSWORD='<preview-demo-password>'
npx tsx scripts/migrate.ts
npx tsx scripts/seed.ts

# 3) 環境ファイル（0600 / Git 管理外）
install -m 600 /dev/null ~/.config/ai-helpdesk/api.env
# DATABASE_URL / SESSION_SECRET / PROXY_SECRET / SEED_PASSWORD /
# REQUIRE_PROXY_SECRET=true / COOKIE_SECURE=true /
# ALLOWED_ORIGINS=https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev,https://ai-helpdesk.mirai-dx-platform.com
```

> DB パスワードは Local PG の接続情報から設定する。**この文書・リポジトリに実値を書かない**。

## 5. 人間が追加するファイル（policy gate により未作成）

### 5-1. `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: ai_helpdesk_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres -d ai_helpdesk_test"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/ai_helpdesk_test
      COOKIE_SECURE: 'false'
      REQUIRE_PROXY_SECRET: 'false'
      LOG_LEVEL: silent
      ALLOWED_ORIGINS: ''
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: |
          echo "SESSION_SECRET=$(openssl rand -hex 32)" >> "$GITHUB_ENV"
          echo "SEED_PASSWORD=ci-$(openssl rand -hex 12)" >> "$GITHUB_ENV"
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
      - run: bash scripts/scan-secrets.sh
      - run: npm audit --omit=dev --audit-level=high
```

### 5-2. `wrangler.jsonc`

```jsonc
{
  "name": "mirai-ai-helpdesk-mvp",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-10-23",
  "assets": {
    "directory": "./apps/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "vars": {
    "API_ORIGIN": "https://ai-helpdesk-api.mirai-dx-platform.com"
  }
}
```

## 6. 配備手順

```bash
# Worker の secret を設定（値は環境ファイルから）
npx wrangler secret put PROXY_SECRET --name mirai-ai-helpdesk-mvp
# 直前の値を入力（stdin）。値は会話ログ・リポジトリへ残さない。

# ビルド（Web は Y/N 承認後に実装）
npm run build

# 配備
npx wrangler deploy
```

### 6-1. Tunnel

```bash
cloudflared tunnel create ai-helpdesk-mvp
cloudflared tunnel route dns ai-helpdesk-mvp ai-helpdesk-api.mirai-dx-platform.com

cat > ~/.cloudflared/ai-helpdesk-config.yml <<'YAML'
tunnel: <tunnel-uuid>
credentials-file: /home/kensan/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: ai-helpdesk-api.mirai-dx-platform.com
    service: http://127.0.0.1:18950
  - service: http_status:404
YAML
chmod 600 ~/.cloudflared/ai-helpdesk-config.yml
```

### 6-2. systemd user unit

`~/.config/systemd/user/ai-helpdesk-api.service`

```ini
[Unit]
Description=Mirai AI HelpDesk API (Preview)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
Environment=NODE_ENV=production
Environment=PORT=18950
Environment=HOST=127.0.0.1
Environment=REQUIRE_PROXY_SECRET=true
Environment=COOKIE_SECURE=true
Environment=ALLOWED_ORIGINS=https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev,https://ai-helpdesk.mirai-dx-platform.com
EnvironmentFile=%h/.config/ai-helpdesk/api.env
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/ai-helpdesk-cloudflared.service` は既存 OpenDesign の unit を参考に、`cloudflared --config %h/.cloudflared/ai-helpdesk-config.yml tunnel run` を実行する。

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-api.service ai-helpdesk-cloudflared.service
```

> `Environment=` に秘密値を直書きせず、`EnvironmentFile=`（0600）を使う。

## 7. 配備後スモーク

```bash
# API 直接（Tunnel 経由）
curl -fsS https://ai-helpdesk-api.mirai-dx-platform.com/api/health

# Worker 経由
curl -fsS https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev/api/health

# Worker 経由の UI
curl -fsS -o /dev/null -w '%{http_code}\n' https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev/
```

確認項目:

| # | 確認 | 方法 |
|---|---|---|
| 1 | Health | `/api/health` が `ok:true, db:ok` |
| 2 | ログイン | 3 ロールでログイン |
| 3 | Flow A | 相談作成 → AI → 引継ぎ |
| 4 | Flow B | 担当割当 → 解決記録 |
| 5 | Flow C | 下書き → 申請 → 承認 → 公開 |
| 6 | DB Read/Write | 案件・TKT/INC・ナレッジ・監査が増える |
| 7 | 権限 | 相談者が `/desk` に入れない |
| 8 | PC 共有 | 共有前は担当者に見えない |
| 9 | Runtime | API ログに 5xx・PII がない |
| 10 | 監査 | `/audit/verify` が `ok:true` |

## 8. ロールバック

| 対象 | 手順 |
|---|---|
| Worker | `npx wrangler deployments list` → 直前の deployment へ rollback（または `wrangler rollback`） |
| API | `systemctl --user stop ai-helpdesk-api`、直前の `dist` へ戻して restart |
| Tunnel | `cloudflared tunnel route dns` で追加した DNS を削除、tunnel を停止 |
| DB | 追加のみ。必要時は `pg_dump` から **新しい DB** へ復元（既存 DB を上書きしない） |
| アプリ | `git revert <commit>` |

## 9. CI / Preview 完了条件（未達）

- CI が main / PR で成功すること。
- Worker Preview URL が発行され、主要 3 Flow を実操作できること。
- Preview の API / DB Read/Write / Runtime ログを確認すること。

これらは §3 の Blocker 解消後に実施する。
