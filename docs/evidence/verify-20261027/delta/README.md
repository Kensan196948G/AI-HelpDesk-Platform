# 差分検証（V-01〜V-24）の証跡 — 2026-10-28

- 計画: `docs/52-verification-rebaseline-20261027.md`
- 結果: `docs/53-delta-verification-20261028.md`
- 生データ: [`results.json`](results.json)（実行時刻・主体の伏せ字・各ケースの実測値）

## 実行方法（再現手順）

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
# 検証インスタンス（HEAD ビルド・検証DB）を起動しておく（:18962）
DATABASE_URL='<ai_helpdesk_verify の DSN>' \
BASE=http://127.0.0.1:18962 \
node scripts/verify/delta-20261028.mjs
```

- スクリプトは **DB 名が `ai_helpdesk_verify` 以外なら即終了**する（本番 DB への誤書き込み防止）。
- 検証用ユーザーは毎回 `users`/`user_roles` に投入（`source='manual'`, `granted_by='delta-verify'`）。
- `mirai_info`（社員名簿）は **読み取り専用**（`default_transaction_read_only=on`）で参照する。
- 出力に実メールは出さない（`k***@mirai-const.co.jp` の形に伏せる）。

## 個別の実行（スクリプト外）

```bash
# V-22: 2アカウント引継ぎ E2E（10/10 OK・終了後に状態を復元）
AIHD_E2E_ALLOW=1 AIHD_E2E_CONFIRM_DB=ai_helpdesk_verify \
AIHD_E2E_BASE=http://127.0.0.1:18962 \
DATABASE_URL='<ai_helpdesk_verify の DSN>' \
node scripts/e2e/two-account-handover.mjs

# V-24: 回帰
npm run typecheck && npm run lint && npm run build && npm run test
```

## 既知の制約

- ブラウザでのクリック確認（V-16 / V-19 の見た目、V-23 の AI解決 E2E）は未実施。
  報告書はサーバ生成 HTML を、承認情報は API 応答を実測している。
- `rspCommandLogId`（RSP の実コマンドログとの相関）は実ジョブが必要なため未実施。
