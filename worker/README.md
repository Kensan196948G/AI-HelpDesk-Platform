# Cloudflare Worker（Preview 用）

`worker/src/index.ts` は、Cloudflare 上で以下を行う想定のコードです。
1. 静的アセット（`apps/web/dist`）の配信
2. `/api/*` を Cloudflare Tunnel 経由の Node API へプロキシ
3. `X-Proxy-Secret` の付与
4. セキュリティヘッダ / CSP の付与
5. SPA のフォールバック（`/index.html`）

## 未作成のファイル（policy gate）

このセッションでは DSH の self-evolution policy gate が
`.github/workflows/` と `wrangler.*` を DEPLOY（critical）と分類して拒否しました。
そのため以下は**未作成**です。人間が [docs/08-deployment.md](../docs/08-deployment.md) の手順で追加してください。
- `wrangler.jsonc`（このディレクトリの親）
- `.github/workflows/ci.yml`

## 想定する `wrangler.jsonc`

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

## Secret

```bash
npx wrangler secret put PROXY_SECRET --name mirai-ai-helpdesk-mvp
```

同じ値を API 側の `PROXY_SECRET` に設定する。値はリポジトリ・ログへ書かない。

## ビルド / 配備

```bash
npm run build          # 現在は API のみ。Web 実装後に apps/web/dist を生成
npx wrangler deploy
```

## 動作確認

```bash
curl -fsS https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://mirai-ai-helpdesk-mvp.<subdomain>.workers.dev/
```

## ローカル型検査

```bash
npx tsc --noEmit -p worker/tsconfig.json
```
