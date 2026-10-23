# 実装計画（MVP）

## 1. Current State → Target

| 領域 | 現在 | 目標 |
|---|---|---|
| Git / GitHub | ローカルのみ（初回コミット前） | Private リポジトリ、`main` 保護、CI |
| UI | 設計なし | OpenDesign 設計＋Y/N 承認＋React 実装 |
| API | なし | Fastify + zod、3 ロール認可 |
| DB | なし | Local PostgreSQL、Migration / Seed / 9 テーブル |
| テスト | なし | Unit / Integration / E2E / Build |
| 配備 | なし | Cloudflare Worker Preview + Tunnel API |
| ドキュメント | 要件原文のみ | Setup / API / DB / Test / Deploy / Limitations / Backlog |

## 2. フェーズ

### P0: 基盤・設計（UI 承認まで）
- リポジトリ初期化、`AGENTS.md` / README / Assessment / MVP Scope / Plan。
- OpenDesign プロジェクトに画面設計 artifact を作成（design board + DESIGN.md）。
- 日本語の数字選択式質問（`docs/03-questions.md`）と Y/N 承認依頼。
- 並行して、UI 非依存の DB 設計・API 契約・CI 雛形を準備。

### P1: Database
- `db/migrations/001_init.sql`（9 テーブル、制約、索引）。
- `db/seed/001_demo.sql`（3 ユーザー、承認済みナレッジ 3〜5 件、デモ案件は任意）。
- `scripts/migrate.mjs` / `scripts/seed.mjs`（冪等、TRUNCATE/DROP なし）。
- 空 DB から Migration → Seed → API 起動 → Read/Write を確認。

### P2: API
- 認証（login/logout/me、セッション、レート制限）。
- 案件（作成、AI 一次対応、解決、引継ぎ、一覧、詳細）。
- チケット（担当割当、状態、解決記録）。
- ナレッジ（下書き生成、申請、承認/差戻し、公開、検索）。
- PC 情報（生成、取得、共有制御）。
- 監査ログ（記録、一覧、ハッシュ検証）。
- ヘルスチェック、エラーハンドラ、リクエスト ID、構造化ログ（PII なし）。

### P3: Web（Y/N 承認後）
- デザイントークン、レイアウト（サイドバー / トップバー / 右レール）。
- S1〜S8、状態（通常 / 空 / 読込 / 入力エラー / 通信エラー / 成功）。
- ロール別ナビゲーション、キーボード操作、フォーカス、色＋文字の信号表示。
- PC 幅中心、820px 以下は下部ナビ。

### P4: テスト・CI
- Unit: 意図判定、信号判定、伏せ字、ハッシュチェーン、権限。
- Integration: API × PostgreSQL（テスト DB）。
- E2E: 3 Flow、権限拒否、状態、入力エラー。
- `typecheck` / `lint` / `test` / `build` を GitHub Actions で実行。
- Secrets scan（gitleaks または GitHub secret scanning）と `pnpm audit`。

### P5: 配備・実検証
- Cloudflare Tunnel 新規作成（`ai-helpdesk-api.mirai-dx-platform.com` → `127.0.0.1:18950`）。
- API を systemd user service で常駐。`EnvironmentFile` 0600。
- Worker Preview 配備（`mirai-ai-helpdesk-mvp`）。`API_ORIGIN` / `PROXY_SECRET`。
- Health / 3 Flow / API / DB Read/Write / Runtime log を Preview 上で実操作。
- ロールバック手順を記録。

### P6: 仕上げ
- README / Setup / Requirements / Design / DB / API / Test / Deploy / Limitations / Backlog。
- 32 項目の完了条件を Evidence 付きで照合。
- 最終報告。

## 3. Affected Files（予定）

```
apps/api/src/**             API・認証・ドメインロジック
apps/web/src/**             UI・状態・API クライアント
db/migrations/**            スキーマ
db/seed/**                  デモデータ
worker/src/index.ts         Edge プロキシ・セキュリティヘッダ
scripts/**                  migrate / seed / deploy / smoke
.github/workflows/ci.yml    CI
docs/**                     設計・API・DB・テスト・運用
design/opendesign/**        OpenDesign 成果物
```

## 4. Database Impact

- 新規 DB `ai_helpdesk_mvp` のみ。既存 DB は触らない。
- 追加のみ（CREATE TABLE / INDEX / TYPE）。破壊的変更なし。
- ロール `aihd_app` を新規作成（LOGIN、DB owner）。既存ロールは変更しない。
- バックアップ: `pg_dump` を配備前に取得（スキーマのみ）。リストア手順を docs に記載。

## 5. API Impact

- 新規 `/api/*` のみ。外部 API なし。
- 認証 Cookie は `HttpOnly; SameSite=Lax; Secure`（Preview）。ローカル HTTP では Secure を外す。
- エラーは `{ error: { code, message, details? } }` に統一。
- 入力は zod、出力は明示的な DTO（PII を返さない）。

## 6. UI Impact

- 新規 SPA。既存 UI なし。
- OpenDesign の design board と DESIGN.md に一致させる。
- ロール別にナビ・操作を出し分け。ただし API 側でも検証。

## 7. Test Plan

| 層 | 対象 | ツール |
|---|---|---|
| Unit | 意図判定・信号・伏せ字・ハッシュ・権限ヘルパー | vitest |
| Integration | 認証、案件、引継ぎ、解決、ナレッジ、PC 共有制御 | vitest + テスト DB |
| E2E | Flow A/B/C、権限拒否、空/エラー/入力エラー | Playwright |
| Build | web / api / worker | tsc / vite / wrangler dry-run |
| Security | secret scan、依存脆弱性、ヘッダ、Cookie | gitleaks / pnpm audit / curl |
| Runtime | Preview の health / 3 Flow / DB / ログ | Playwright / curl / psql |

## 8. Security Impact

- 新規の公開エンドポイント（Worker / Tunnel API）。認証必須（health を除く）。
- 共有秘密 `PROXY_SECRET` で Worker 以外からの直接 API 呼び出しを拒否。
- セッション Cookie、ロール認可、レート制限、PII 伏せ字、監査ログ。
- Secret はリポジトリ外。`.env.example` はプレースホルダのみ。
- Cloudflare Access / WAF / Turnstile は MVP 対象外（Backlog）。公開範囲は検証用ホスト名に限定。

## 9. Deployment Impact

- 新規 Tunnel・新規 systemd unit・新規 Worker。既存リソースは変更しない。
- 本番ドメインではなく `mirai-dx-platform.com` の検証用サブドメインを使用。
- 費用: Cloudflare 無料枠 / 既存契約の範囲。新規有料サービスなし。
- ロールバック: Worker の直前バージョンへ、API は systemd stop、Tunnel は DNS 削除。DB は追加のみのため保持。

## 10. Risk

| Risk | 影響 | 対策 |
|---|---|---|
| Cloudflare から Local PG に届かない | 配備失敗 | Tunnel 経由の Node API。Worker からは HTTPS のみ |
| Preview の公開範囲 | 情報露出 | アプリ認証 + 共有秘密 + デモデータのみ |
| ルールベース AI の品質 | 価値が伝わらない | 承認済みナレッジを Seed し、根拠・手順を具体的に表示 |
| PC 情報の誤解 | 実端末監視と誤認 | 全画面に「デモデータ / 読み取りのみ / 取得しない情報」を明記 |
| 実装範囲の膨張 | 未完 | 3 Flow / 8 画面 / 9 テーブルに固定。他は Backlog |
| Cloudflare 認証情報の権限不足 | 配備不可 | wrangler OAuth の権限を事前確認済み。失敗時は Blocker 報告 |
| 既存リソースへの影響 | 他プロジェクト停止 | 新規名のみ。既存 Tunnel/Pages/DNS は触らない |

## 11. Rollback

1. Worker: `wrangler deployments list` → 直前の deployment へ rollback（または `wrangler rollback`）。
2. API: `systemctl --user stop ai-helpdesk-api` / 直前のビルドへ戻して restart。
3. Tunnel: `cloudflared tunnel route dns` で追加した DNS を削除、tunnel を停止。
4. DB: 追加のみ。必要時は `pg_dump` から新規 DB へ復元（既存 DB は触らない）。
5. アプリ: `git revert` で該当 PR を戻す。

## 12. マイルストーン

| # | 内容 | 完了条件 |
|---|---|---|
| M1 | 設計・承認 | OpenDesign artifact + Y/N 回答 |
| M2 | DB | 空 DB から migrate/seed 成功 |
| M3 | API | 主要エンドポイントの integration test 成功 |
| M4 | Web | 3 Flow をローカルで E2E 成功 |
| M5 | CI | main で全チェック成功 |
| M6 | Preview | 実操作 + Evidence 取得 |
| M7 | 完了 | 32 項目の照合と最終報告 |
