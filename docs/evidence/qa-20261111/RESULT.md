# QA 実行結果サマリ（2026-11-11 09:15〜09:31 JST / commit 7573784）

実行者: Lead（AI）。ブランチ `qa/qa-workbench-20261111`（HEAD `992082c`、基準 commit `7573784`）。
環境: Node v22.22.3 / PostgreSQL 16 `127.0.0.1:5435` / Playwright `1.64.1`（chromium 156.0.8078.4）/ `AUTH_MODE=local`（UI のみ）。
**本番・staging・本番 DB への書込みなし。** 使用した DB はすべて使い捨て（下記）。

## 1. グループ別結果

| G | 内容 | 実行 | 結果 | 証跡 |
|---|---|---|---|---|
| G1 | migrate ×2 / seed ×2（冪等） | 09:15:28 | **PASS**（4/4 exit 0、2 回目 migrate は 37 skip、seed は users=6 / knowledge=9 / cases=3 で重複なし） | `G1-migrate-1/2.log`, `G1-seed-1/2.log` |
| G0 | 全テスト 1 回（新規 DB） | 09:15:40→09:21:59 | **PASS**（exit 0 / **Test Files 102 passed / Tests 2079 passed**） | `G0-full-suite.log` |
| G2 | 3 Flow E2E（新規 `_e2e` DB） | 09:23:04→09:26:49 | **PASS**（exit 0 / **checks=88 failed=0**） | `G2-e2e.log`, `G2-e2e-out/` |
| G3 | UI（A05 Normal / A08a Input Error） | 09:26:59→09:31 | **PASS**（下表） | `G3-normal.png`, `G3-input-error.png`, `G3-*.json` |

使用 DB（すべて `aihd_test_qa_*` の使い捨て）: `aihd_test_qa_g1_091528` / `aihd_test_qa_g0_091540` / `aihd_test_qa_g2b_092304_e2e` / `aihd_test_qa_g3_092659`。

### G3 UI の詳細

| ケース | 確認内容 | 結果 |
|---|---|---|
| A05 Normal State | トップ `/` が 200、title「みらいAI窓口 × ヘルプデスク ステップ受付 V3.1」、本文 670KB、AI相談/STEP1 表示、**コンソールエラー 0**、スクショ取得 | **PASS** |
| A08a Input Error | 相談ウィザード STEP2 で件名・本文を空のまま「AIに相談する」→ **トースト「内容を入力してください」**、**STEP2 に留まる**、**POST /api/cases なし**、コンソールエラー 0 | **PASS** |

## 2. P0 38 件の結果

「証拠の性質」: **直接**=ケースの操作そのものを実行 / **スイート**=同一契約を検証する既存テストが PASS / **条件付き**=stub・mock 等の制約あり。

| ケース | 内容 | 証拠 | 性質 | 判定 |
|---|---|---|---|---|
| TC-A02 | 主要3Flow E2E | G2（88 checks） | 条件付き（stub AI / mock 実行器 / local 認証） | PASS |
| TC-A05 | Normal State | G3（実画面） | 直接 | PASS |
| TC-A08a | Input Error（空入力） | G3（実画面） | 直接 | PASS |
| TC-A10 | Migration 冪等 | G1（×2） | 直接 | PASS |
| TC-A11 | Seed 冪等 | G1（×2） | 直接 | PASS |
| TC-A12 | DB Read/Write | routes/integration（3 tests） | スイート | PASS |
| TC-A15 | 主要テスト | G0（102 files / 2079） | 直接 | PASS |
| TC-D01 | 認証 3 ロール・Cookie | auth/password(3), access-jwt(12), persona-switch(3), ui(8) | スイート | PASS |
| TC-D02 | 認可マトリクス | auth/role-separation(9), helpdesk-scope(11), routes/extra(6) | スイート | PASS |
| TC-D03 | PII 伏せ字 | domain/pii(20), pii-knowledge(20) | スイート | PASS |
| TC-D04 | AI 文脈の除外 | pii-knowledge(20), ai/deepseek(6) | スイート | PASS |
| TC-D05 | 監査ハッシュ鎖 | domain/audit(8), routes/audit(2) | スイート | PASS |
| TC-D06 | 承認ハッシュ・期限切れ | resolve/approval(6), resolve/verify(20) | スイート | PASS |
| TC-D07 | estop 中の拒否 | resolve/routes.integration(43) | スイート | PASS |
| TC-D08 | device 所有者・許可リスト | resolve/skills(45), real-path(50) | スイート | PASS |
| TC-C01 | 相談受付 正常系 | routes/integration(3) | スイート | PASS |
| TC-C02 | 相談受付 異常系・境界 | routes/extra(6) | スイート | PASS |
| TC-C05 | 引継ぎ 正常系 | case-handovers(16) | スイート | PASS |
| TC-C06 | 引継ぎ 異常系・境界 | case-handovers(16) | スイート | PASS |
| TC-C07 | ヘルプデスク 正常系 | routes/extra(6), routes/integration(3) | スイート | PASS |
| TC-C08 | ヘルプデスク 異常系 | helpdesk-scope(11), routes/extra(6) | スイート | PASS |
| TC-C09 | KB 下書き・申請 | knowledge-ui(7) | スイート | PASS |
| TC-C10 | KB 承認 正常系 | knowledge-approval-binding(28) | スイート | PASS |
| TC-C11 | KB 承認 異常系 | knowledge-ui(7), approval-origin(6) | スイート | PASS |
| TC-C12 | AI 一次対応 正常系 | ai/deepseek(6), domain/ai(5) | スイート | PASS |
| TC-C13 | AI 赤信号 | ai/deepseek(6), routes/integration(3) | スイート | PASS |
| TC-C14 | 命令文耐性 | ai/remote-prompt(10), ai/deepseek(6) | スイート | PASS |
| TC-C15 | 報告書 HTML 正常系 | domain/final-report(17) | スイート | PASS |
| TC-C17 | 報告書 異常系 | routes/reports(6) | スイート | PASS |
| TC-C20 | 端末エージェント 正常系 | routes/device(23) | スイート | PASS |
| TC-C21 | 端末エージェント 異常系 | routes/device(23), rate-limit(3) | スイート | PASS |
| TC-C22 | 読み取り専用・許可リスト | allowlist(11), auth/ui(8), resolve/skills(45) | スイート | PASS |
| TC-C23 | 最小取得・フォルダ既定無効 | folder-access/state(61), rate-limit(3) | スイート | PASS |
| TC-C24 | 外部 AI 送信の最小化 | pii-knowledge(20), ai/deepseek(6) | スイート | PASS |
| TC-C26 | ヘッダ（CSP/no-store/Origin/Cookie） | routes/prototype(21), server.access(1) | スイート | PASS |
| TC-C27 | 監査メタ情報限定 | domain/audit(8), routes/audit(2) | スイート | PASS |
| TC-C32 | 認証境界（local 拒否/404/allowlist） | access-jwt(12), allowlist(11), routes/extra(6) | スイート | PASS |
| TC-C37 | KB 一覧の可視性 | knowledge-ui(7), routes/integration(3) | スイート | PASS |

**集計**: 38 件中 **PASS 38 / FAIL 0 / BLOCKED 0**（直接証拠 5 件、スイート証拠 32 件、条件付き 1 件）。
スイート証拠は「同一契約を検証する既存テストが PASS」であり、ケース固有の手順を再現したものではない（その旨をボードに明記すること）。

## 3. 実行中に検出した問題と対応（重要）

### 3-1. E2E の初回失敗と、開発 DB への意図しない migration 適用

- **症状**: G2 の初回実行（09:22:06）が `relation "device_commands" does not exist` で失敗。
- **原因**: `scripts/migrate.ts` / `seed.ts` は `NODE_ENV != test` のとき `.env.local` を `override: true` で読み込み、E2E が渡した `DATABASE_URL` を **開発 DB（`ai_helpdesk_mvp`）の値で上書き**する。E2E の `prepareDb()` は `NODE_ENV=development` で migrate/seed を起動するため、E2E DB ではなく開発 DB に適用されていた。
- **副作用（実測）**: 開発 DB `ai_helpdesk_mvp` に migration **035 / 036 / 037 が 2026-11-11 00:22:08 UTC（09:22:08 JST）に適用**された（`schema_migrations` 37 件、users 6 のまま）。additive な migration でありデータ破壊はないが、**意図しない変更**である。seed は `.env.local` の値で upsert されるため、デモ用パスワードの変更はない。
- **対応**: E2E は **`.env.local` の無い隔離 worktree**（`git worktree add --detach` → `npm ci`）で再実行し、**PASS**（G2b）。初回の E2E DB（`aihd_test_qa_g2_092206_e2e`）は空のまま残置。
- **申し送り**: 手順書の E2E コマンドは「隔離 worktree で実行」に修正が必要。開発 DB の状態は「37 migration 適用済み」に変わった（コードと一致する方向）。

### 3-2. UI の状態持ち越し

- 同じテストユーザーで画面状態が `prototype_states` に保存されるため、2 回目以降はホームの表示が変わる。
- **対応**: UI テスト DB の `prototype_states` をクリアし、Playwright の `addInitScript` で localStorage/sessionStorage を消去してから実行した（自分のテスト DB のみ）。

## 4. 未実施・制約

- 実 Cloudflare Access の OTP ログイン後の画面確認（C-3）— 人間の OTP が必要。**BLOCKED**。
- 実 Windows 端末・実貸与・実社員（#121）— **BLOCKED**。
- 本番/staging 配備、本番 DB 書込み、systemd 操作は未実施。
- スイート証拠 32 件は、ケース固有の手順を個別に再現したものではない（既存テストの契約検証）。
- G0 は 1 回のみ（同一 DB の再利用は不可）。

## 5. 次のアクション

1. この結果を QA ボードの 38 件へ反映（PASS 38、証拠 path を添付）。
2. レポート v3（実行 38 / 未実行 69 / 制約 / 副作用の申し送り）。
3. リリース判定ゲートの申請可否を人間が判断（Go 条件: 全 P0 PASS だが、実 Access・実機が BLOCKED のため条件付き）。

## 6. 反映結果（2026-11-11 10:30 JST 実測）

| 項目 | 実測 |
|---|---|
| testcases | **executed 61 / reviewed 31**（P0 **43/43**、P1 5/33、P2 13/16） |
| testruns | **7 件**（既存 3 + 今回 4。いずれも `imported` / `unknown` / `imported-summary`） |
| defects | **0** |
| gates | **pending 0**（approved 2 = 統合92用例・要件分析 / rejected 3 = 旧用例レビュー） |

**注**: 「ゲート 5 件 pending」は誤り。5 件はすべて決定済み（pending 0）。レポート v3 ではこの表の値を正とする。
