# 完了条件の照合（32 項目）

最終更新: 2026-10-23 / 状態: **未完了（UI 全 STEP E2E・CI が未）**

凡例: ✅ 完了 / ⏸ 一部完了・承認待ち / ⛔ Blocker

| # | 完了条件 | 状態 | Evidence / 備考 |
|---|---|---|---|
| 1 | README に MVP 目的・利用者 | ✅ | README「みらいAI窓口 × ヘルプデスク MVP」 |
| 2 | 主要 1〜3 Flow を E2E 実行可能 | ⏸ | API は integration test で 3 Flow 成功。UI は既存プロトタイプを配信し、状態/AI を Playwright で確認。全 STEP の E2E は未実施 |
| 3 | OpenDesign / 採用 UI 方針と主要画面が整合 | ✅ | ユーザー指示により実画面は既存プロトタイプ HTML を 100% 配信（[docs/14](14-prototype-ui-integration.md)）。OpenDesign は参考記録 |
| 4 | Seed / Dummy Data で操作可能 | ✅ | users 6 / knowledge 9 / cases 3 / PC 31 項目 |
| 5 | Normal State 確認 | ⏸ | UI 配信・ホーム・H.kb を確認。主要 STEP の通し操作は未実施 |
| 6 | Empty State 確認 | ⏸ | プロトタイプの空表示は実装済み。体系的な確認は未実施 |
| 7 | Loading State 確認 | ⏸ | プロトタイプの表示はあるが、体系的な確認は未実施 |
| 8 | Input Error 確認 | ⏸ | API は 400。UI の入力エラー確認は未実施 |
| 9 | Communication Error 確認 | ⏸ | UI の通信エラー確認は未実施 |
| 10 | Migration 再実行可能 | ✅ | `db:migrate` 冪等。dev/test で実測 |
| 11 | Seed 再実行可能 | ✅ | `db:seed` 冪等。重複なし |
| 12 | DB 主要 Read / Write 確認 | ✅ | 案件・引継ぎ・解決・ナレッジ・監査 |
| 13 | Type Check 成功 | ✅ | `npm run typecheck` |
| 14 | Lint 成功 | ✅ | `npm run lint`（error 0） |
| 15 | 主要 Test 成功 | ✅ | 175 tests（unit/auth/worker + integration/UI + 許可リスト + 実PC情報/エージェント + 最終報告書/遠隔支援） |
| 16 | Build 成功 | ✅ | API build 成功。UI は既存 HTML を配信 |
| 17 | Critical / High の既知問題なし | ⏸ | 既知の Critical なし。Access・OTP・実PC情報・エージェント・DeepSeek V4.1 は実測済み。全 STEP E2E が未 |
| 18 | Cloudflare Preview Deployment 成功 | ✅ | Tunnel + Access で公開。公開 URL は 302 → Access OTP 画面（[08](08-deployment.md) §0） |
| 19 | Preview 主要画面確認 | ✅ | OTP 実ログイン成功（2026-10-23 15:32 JST、Access ログ `onetimepin` / `allowed=true`）。ユーザーがログインを確認済み |
| 20 | Preview API 確認 | ⏸ | ローカル origin で `/api/state` / `/api/ai/answer` 200。公開経路のログインは確認済みだが、API の直接確認は未実施 |
| 21 | Preview DB 接続確認 | ⏸ | ローカル origin から `prototype_states` の Read/Write を確認。公開経路での DB 直接確認は未実施 |
| 22 | README 更新 | ✅ | 状態・構成・起動手順を更新 |
| 23 | Setup Documentation 更新 | ✅ | README / 04-database / 08-deployment |
| 24 | Requirements 更新 | ✅ | docs/01-mvp-scope.md（MVP 範囲・対象外・受入） |
| 25 | Design 更新 | ✅ | design/opendesign/（DESIGN.md / artifact v3 / linter） |
| 26 | Database Documentation 更新 | ✅ | docs/04-database.md |
| 27 | API Documentation 更新 | ✅ | docs/05-api.md |
| 28 | Test Documentation 更新 | ✅ | docs/06-test.md |
| 29 | Deployment Documentation 更新 | ✅ | docs/08-deployment.md |
| 30 | Limitations 記録 | ✅ | 07-security §7 / 09-operations §7 / README |
| 31 | Recovery / Rollback 手順記録 | ✅ | 08-deployment §8 / 09-operations §4 |
| 32 | Future Feature / Backlog 整理 | ✅ | docs/10-backlog.md |

## 未完了の理由

詳細な Blocker 報告: [13-blocked-report.md](13-blocked-report.md) / 現行 UI: [14-prototype-ui-integration.md](14-prototype-ui-integration.md)

1. **WebUI の Y/N 承認待ち**（ユーザー回答が必要）。承認後に S1〜S8・状態・E2E を実装する。
2. **Cloudflare Preview / CI の Blocker**。DSH の self-evolution policy gate が
   `.github/workflows/`・`wrangler.*`・`wrangler deploy` を DEPLOY（critical）として拒否。
   ユーザーによる policy 例外／人間による配備が必要。
3. 現状: UI と Preview は配信済みで、Access・許可リスト・OTP 実ログイン・実PC情報（ブラウザ/エージェント）・DeepSeek V4.1 も実測済み。残るのは **UI の全 STEP E2E**、**Preview API/DB の公開経路確認**、**CI**、**端末エージェントの対象PC配布**。

## 完了判定

「個人利用者が MVP の主要価値を Cloudflare Preview 上で実際に操作して確認できること」を満たしていないため、
**MVP 完了とは判定しない**。

## 2026-10-25 再検証の追記（上表の状態更新）

- #2 / #5 / #6〜#9（UI の全 STEP・各種状態）: 実ブラウザで 34 画面を巡回し、主要 2 フローを完走。
  白画面・例外は修正後に 0（詳細: [24-verification-20261025.md](24-verification-20261025.md)）。
- #20 / #21（Preview API / DB）: 公開 URL は Access 302、オリジン API は `/api/health` / `/api/state` を実測。
  DB は migration 010 適用・状態修復後に再確認済み。
- #17（既知問題）: Critical 2 / High 4 を修正（引継ぎメモの分野・担当者名、記入例、依頼者 ID 表示を含む）。
  Access JWT は enforce へ移行、Tunnel と API の間に X-Proxy-Secret 付与プロキシを追加、
  DB は日次バックアップを追加、disk は 87% → 81% に整理。
- #15: テストは **201 件**に増加。
- 総合: 個人利用 MVP の主要価値は公開 URL 上で操作可能。未対応の High 2 件は次ラウンドで修正する。

## 2026-11-10 追記（現況整合・証拠マップ）

**前提の更新**: 2026-11-06 に本番切替を実施し、公開面は Cloudflare Access 配下の本番（`ai-helpdesk-prod-api` / release 方式）になった（[85](85-production-cutover-20261106.md)）。下表は「Preview」を「公開面（本番）」と読み替え、未完了項目の現在地を証拠付きで整理したものである。**未実施を完了扱いにしない。**

| # | 条件 | 現在地 | 根拠 / 未実施の理由 |
|---|---|---|---|
| 2 | 主要 1〜3 Flow E2E | ⏸ 一部 | `scripts/e2e/dataflow-integration.mjs` は 88 checks / failed 0 で通るが、stub AI・`--mock` 実行器・`AUTH_MODE=local` の条件（[65](65-readme-dataflow-map.md) §0-1）。CI には未配線（前提は [89](89-round-20261110.md) §5）。 |
| 5 | Normal State | ⏸ 一部 | 実ブラウザで 34 画面を巡回し、主要 2 フローを完走（[24](24-verification-20261025.md)）。[39](39-full-verification-result-20261027.md) で A〜F を実測、D の一部は未実施。 |
| 6 | Empty State | ⏸ **証拠なし** | 実装はあるが、体系的な確認記録がない。 |
| 7 | Loading State | ⏸ **証拠なし** | 同上。 |
| 8 | Input Error | ⏸ **証拠なし（UI）** | API の 400 は実測済み。UI の入力エラー確認は未実施。 |
| 9 | Communication Error | ⏸ | トースト通知は実装済み（PR #32）。受入は未実施（[39](39-full-verification-result-20261027.md) §7-2）。 |
| 17 | 既知の Critical/High なし | ⏸ 条件付き | High 4 件は修正・独立再検証 PASS、配備ドリフト H-01 も解消。残: proxy unit の恒久修正の**本番反映**（[85](85-production-cutover-20261106.md) U-5）と Medium 未修正（F-13/14/15/16/10）。 |
| 20 | 公開 API | ⏸ 一部 | 公開 `/` は 302（Access）、未認証 `/api/*` は 401 `UNAUTHORIZED`（アプリ到達）、proxy 経由 `/api/health` は 200。**認証後の一般 API は未実施**（[85](85-production-cutover-20261106.md) C-3）。 |
| 21 | 公開 DB | ⏸ 一部 | proxy 経由 health の `db:"ok"`、本番 dump 復元の監査鎖検証（checked 80 / mismatch 2 は既知破断と一致、[88](88-production-dump-audit-chain-20261106.md)）。**書込経路は未実施**。 |

**E2E を CI 必須にする場合の前提（2026-11-10 実測）**: `playwright-core` は package.json 未宣言で、クリーンなチェックアウトから解決できない（`MODULE_NOT_FOUND`。実行時は `PLAYWRIGHT_CORE_PATH` で外部パスを差し替える前提）。6 ロール分の API と stub をポート 19401〜19408 固定で起動し、DB 名が `_e2e` で終わる専用 DB と migrate が必要。まず `workflow_dispatch` / nightly で所要時間と失敗率を測り、その後 PR 必須化する（[89](89-round-20261110.md) §5）。

**完了判定は引き続き「未完了」**: 実 Access OTP ログイン後の主要画面・API 確認（C-3）と、#6〜#8 の UI 状態の証拠が無いため。