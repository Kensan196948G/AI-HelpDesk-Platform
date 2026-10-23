# 完了条件の照合（32 項目）

最終更新: 2026-10-23 / 状態: **未完了（Y/N 承認待ち・Preview Blocker）**

凡例: ✅ 完了 / ⏸ 一部完了・承認待ち / ⛔ Blocker

| # | 完了条件 | 状態 | Evidence / 備考 |
|---|---|---|---|
| 1 | README に MVP 目的・利用者 | ✅ | README「みらいAI窓口 × ヘルプデスク MVP」 |
| 2 | 主要 1〜3 Flow を E2E 実行可能 | ⏸ | API は integration test で 3 Flow 成功。UI は既存プロトタイプを配信し、状態/AI を Playwright で確認。全 STEP の E2E は未実施 |
| 3 | OpenDesign / 採用 UI 方針と主要画面が整合 | ✅ | ユーザー指示により実画面は既存プロトタイプ HTML を 100% 配信（[docs/14](14-prototype-ui-integration.md)）。OpenDesign は参考記録 |
| 4 | Seed / Dummy Data で操作可能 | ✅ | users 6 / knowledge 4 / cases 3 / PC 31 項目 |
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
| 15 | 主要 Test 成功 | ✅ | 59 tests（unit/auth/worker + integration/UI + 許可リスト） |
| 16 | Build 成功 | ✅ | API build 成功。UI は既存 HTML を配信 |
| 17 | Critical / High の既知問題なし | ⏸ | 既知の Critical なし。Access ポリシーは設定済み。OTP 実ログイン / 全 STEP E2E が未 |
| 18 | Cloudflare Preview Deployment 成功 | ✅ | Tunnel + Access で公開。公開 URL は 302 → Access OTP 画面（[08](08-deployment.md) §0） |
| 19 | Preview 主要画面確認 | ⏸ | Access allow ポリシー（`kensan1969@gmail.com` / `@mirai-const.co.jp`）設定済み。OTP 実ログインはユーザー確認待ち。ローカル origin はヘッダー付きで確認済み |
| 20 | Preview API 確認 | ⏸ | ローカル origin で `/api/state` / `/api/ai/answer` 200。公開 URL からの確認は OTP ログイン後 |
| 21 | Preview DB 接続確認 | ⏸ | ローカル origin から `prototype_states` の Read/Write を確認。公開 URL からの確認は OTP ログイン後 |
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
3. 現状: UI と Preview は配信済みで、Cloudflare Access の allow ポリシーとアプリ許可リスト（`docs/MailAddress.txt`）も設定済み。残るのは **OTP の実ログイン確認**、**UI の全 STEP E2E**、**CI**。

## 完了判定

「個人利用者が MVP の主要価値を Cloudflare Preview 上で実際に操作して確認できること」を満たしていないため、
**MVP 完了とは判定しない**。
