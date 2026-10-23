# みらいAI窓口 × ヘルプデスク MVP

社員の IT 相談を「1つの入口」で受け、**PC 基本情報の事前取得（読み取りのみ・デモ）→ AI 一次対応（ルールベース）→ ヘルプデスクへの引継ぎ → 対応・解決記録 → ナレッジ化・承認**までを一気通貫で体験できる、個人利用向けの MVP です。

- 位置づけ: **MVP / Prototype**（本番正式版ではありません）
- 利用者: 検証者 1 名（相談者・ヘルプデスク担当・承認者の 3 ロールをデモアカウントで切替）
- 公開先: Cloudflare の検証環境（Preview）を予定
- データ: Local PostgreSQL 16（`127.0.0.1:5435` / `ai_helpdesk_mvp`）＋ デモ用 Seed
- AI: ルールベース＋承認済みナレッジ検索。外部 AI には接続しない

> 本リポジトリは `Docs/` の要件定義書 V3.1 と、既存試作 HTML（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`）を出典としています。既存ファイルは削除・上書きしません。

## 状態（2026-10-23）

| 項目 | 状態 |
|---|---|
| 初動 Assessment | 完了（[docs/00-assessment.md](docs/00-assessment.md)） |
| MVP スコープ | 定義済み（[docs/01-mvp-scope.md](docs/01-mvp-scope.md)） |
| OpenDesign 画面設計 | **作成済み**（artifact v3 / [design/opendesign/](design/opendesign/) / 承認待ち） |
| Local PostgreSQL | **実装・検証済み**（migrate / seed / 再実行 / Read・Write） |
| API | **実装・検証済み**（36 tests / 主要 3 Flow） |
| WebUI 実装 | 未着手（**Y/N 承認待ち**） |
| CI | **Blocker**（policy gate が `.github/workflows/` を拒否） |
| Cloudflare Preview | **Blocker**（policy gate が `wrangler.*` / `wrangler deploy` を拒否） |

## 主要 3 Flow

1. **相談受付〜引継ぎ**: 相談種類 → 内容入力＋PC 基本情報の事前取得 → AI 一次対応 → 解決 or 引継ぎ（TKT/INC 発行）
2. **ヘルプデスク対応**: ボード／一覧 → 案件詳細 → 担当割当 → 解決記録（原因・手順・所要時間）
3. **ナレッジ化〜完了**: 解決記録から伏せ字済み下書き → 申請 → 別の承認者がチェックリスト承認 → 公開 → 相談者へ反映

## 技術スタック

| 層 | 技術 |
|---|---|
| Web | React + TypeScript + Vite（WebUI は承認後に実装） |
| API | Node.js 22 + Fastify 5 + zod + postgres.js |
| DB | PostgreSQL 16（Local / Migration + Seed） |
| Edge | Cloudflare Worker（静的配信 + `/api` プロキシ、`worker/`） |
| 公開 | Cloudflare Tunnel（Local API）＋ Worker Preview |
| Test | vitest（unit / integration）、Playwright（E2E、UI 承認後） |
| Lint | Biome |

## ローカル起動

```bash
# 1) 依存
npm install

# 2) 環境変数（コミットしない）
cp .env.example .env.local
# DATABASE_URL / SESSION_SECRET / PROXY_SECRET / SEED_PASSWORD を設定
chmod 600 .env.local

# 3) DB（既存 DB は触らない。専用 DB を用意）
npm run db:migrate
npm run db:seed

# 4) API
npm run dev:api
# http://127.0.0.1:18950/api/health
```

デモアカウント（パスワードは `SEED_PASSWORD`）:

| ロール | メール |
|---|---|
| 相談者 | `yamada@example.com` / `kimura@example.com` / `ogawa@example.com` |
| ヘルプデスク | `sato@example.com` / `takahashi@example.com` |
| 承認者 | `watanabe@example.com` |

## 検証

```bash
npm run typecheck   # API + worker
npm run lint        # Biome
npm test            # unit 24 + integration 3（PostgreSQL テスト DB）
npm run build       # API
bash scripts/scan-secrets.sh
npm audit --omit=dev --audit-level=high
```

実測（2026-10-23）: TypeCheck ✅ / Lint ✅ / 36 tests ✅ / Build ✅ / Secret scan ✅ / Audit 0 vulnerabilities。

## ドキュメント

- [初動 Assessment](docs/00-assessment.md)
- [MVP スコープ・受入条件](docs/01-mvp-scope.md)
- [実装計画](docs/02-plan.md)
- [WebUI 仕様の確認（Y/N 承認）](docs/03-questions.md)
- [Database](docs/04-database.md)
- [API](docs/05-api.md)
- [Test / 検証結果](docs/06-test.md)
- [Security / Privacy](docs/07-security.md)
- [Deployment / Blocker](docs/08-deployment.md)
- [運用・復旧](docs/09-operations.md)
- [Backlog](docs/10-backlog.md)
- [完了条件の照合（32 項目）](docs/11-acceptance.md)
- [UI 設計（OpenDesign）](design/opendesign/DESIGN.md) / [設計ボード](design/opendesign/design-board.html)
- 要件の原文: `Docs/Mirai-AI-Helpdesk-V3.1_*.html`

## 既知の制約・Blocker（MVP）

- **WebUI は未実装**。OpenDesign 設計に対する Y/N 承認後に実装する。
- **CI を追加できない**。DSH の self-evolution policy gate が `.github/workflows/` を DEPLOY（critical）として拒否。
- **Cloudflare Preview に配備できない**。同 gate が `wrangler.*` の作成と `wrangler deploy` を拒否。
  → 人間による配備、または policy 例外の承認が必要（[docs/08-deployment.md](docs/08-deployment.md) §3）。
- AI 一次対応は**ルールベース**（外部 AI API 未接続）。画面に「MVP: ルールベース」を明記する。
- PC 基本情報は**デモデータ**。実端末の読み取りは行わない。
- 添付ファイル・端末修復実行・外部ヘルプデスク基盤連携・SSO は対象外。
- 本番正式環境へのデプロイは行わない。

## ライセンス

未設定（個人利用 MVP。必要に応じて追加）。
