# テストレポート v3（AI-HelpDesk-Platform / 2026-11-11 / commit 7573784）

- 文書種別: test-report / 版: v3
- 対象: `AI-HelpDesk-Platform`（`PRJ-2026-003`）
- 対象 commit: `7573784`（QA ブランチ `qa/qa-workbench-20261111`、HEAD `992082c`）
- 実行者: Lead（AI） / 実行日時: 2026-11-11 09:15〜09:31 JST
- 前提: 統合ゲート `gate_mwbb5vil_2bd7d342`（全92用例）と要件レビュー `gate_mwb39sh5_31bbccd2` は承認済み。旧 testcase-review 3 件は却下（統合への置換）。

## 0. 結論

**条件付き GO（宣言した対象スコープ内）。** P0 は **43/43 が executed（PASS）**、登録缺陷 0。ただし 38 件の内訳は「直接実行 5 / 条件付き 1 / 既存テストによるスイート証拠 32」であり、実 Cloudflare Access OTP・実 Windows/貸与（Issue #121）は**対象外・未検証**である。このため「無条件の GO」ではなく、残余条件を明示した条件付き判定とする。

| Go 条件 | 実測 | 判定 |
|---|---|---|
| 全 P0 が PASS または承認済み BLOCKED | P0 43/43 executed、FAIL 0 | 充足 |
| Critical / High の缺陷 0 | 缺陷 0（FAIL 0） | 充足 |
| 対象スコープの宣言 | 受入32項目＋PR#156-158回帰＋高リスク | 充足 |
| 除外の明示 | C-3（実 Access OTP）・#121（実機）・本番配備 | 充足 |
| 証跡の保存 | `docs/evidence/qa-20261111/`（G0〜G3、RESULT.md） | 充足 |

**残余条件（リリース判断時に承認が必要）**
1. 32 件は既存テストの契約検証（スイート証拠）であり、ケース固有の手順を個別再現したものではない。
2. A02（3 Flow E2E）は stub AI・mock 実行器・ローカル認証の条件付き。
3. 実 Access OTP 後の画面・API 確認（C-3 / 受入 #19〜#21）と実機受入（#121）は未実施。
4. P1 28 件・P2 3 件は未実行（reviewed のまま）。

## 1. 対象と範囲

- 対象: 受入 32 項目（docs/11）＋ PR #156〜#158 の回帰（dist-manifest `--root` / proxy unit / set-smtp / installer）＋ 高リスク領域（認証・認可 / PII / 監査 / 解決ループ）。
- ケース: 92 件（P0 43 / P1 33 / P2 16）。全件 reviewed。
- 除外: 実 Cloudflare Access OTP 後（C-3）、実 Windows・実貸与・実社員（#121）、本番/staging 配備、本番 DB 書込み、systemd 操作、Cloudflare 変更。
- 環境: Node v22.22.3 / PostgreSQL 16 `127.0.0.1:5435` / Playwright 1.64.1（chromium 156.0.8078.4）/ UI のみ `AUTH_MODE=local`。**本番・staging・本番 DB への書込みなし。** 使用 DB はすべて使い捨て（`aihd_test_qa_*`）。

## 2. 実行結果

| 区分 | 件数 |
|---|---|
| 実行済み（executed） | **61 / 92** |
| 未実行（reviewed） | 31（P1 28 / P2 3） |
| P0 | **43 / 43 executed**（今回 38 + 既存 5） |
| P1 | 5 / 33 executed |
| P2 | 13 / 16 executed |
| 登録缺陷 | **0**（FAIL 0） |
| testrun | **7 件**（既存 3 + 今回 4。いずれも imported / unknown / imported-summary） |

### グループ別（今回の実行）

| G | 内容 | 結果 |
|---|---|---|
| G1 | migrate ×2 / seed ×2 | **PASS**（4/4 exit 0、2回目 migrate は 37 skip、seed は users=6 / knowledge=9 / cases=3 で重複なし） |
| G0 | 全テスト 1 回（新規 DB） | **PASS**（exit 0 / 102 files・2079 tests passed、09:15:40〜09:21:59） |
| G2 | 3 Flow E2E（新規 `_e2e` DB） | **PASS**（checks=88 / failed=0、09:23:04〜09:26:49） |
| G3 | UI（A05 Normal / A08a Input Error） | **PASS**（A05: 200・title一致・console error 0 / A08a: トースト「内容を入力してください」・STEP2 維持・POST /api/cases なし） |

## 3. P0 38 件の内訳

| 証拠の性質 | 件数 | 内容 |
|---|---|---|
| 直接実行 | **5** | A05（UI）、A08a（UI）、A10（migrate）、A11（seed）、A15（全テスト） |
| 条件付き | **1** | A02（3 Flow E2E。stub AI・mock 実行器・local 認証） |
| スイート証拠 | **32** | 既存テストが同一契約を検証して PASS（ケース固有手順の個別再現ではない） |

38 件の個別対応（ケース ID → 証拠ファイル）は `RESULT.md` §2 を正とする。**38 件中 PASS 38 / FAIL 0 / BLOCKED 0。**

## 4. 証跡

`docs/evidence/qa-20261111/`:

- `RESULT.md`（38 件の判定表・環境・申し送り・反映結果）
- `G0-full-suite.log`（102 files / 2079 tests）
- `G1-migrate-1/2.log` / `G1-seed-1/2.log`
- `G2-e2e.log` / `G2-e2e-out/`
- `G3-normal.png` / `G3-input-error.png` / `G3-*.json` / `G3-api.log`
- 実行スクリプト（`ui-smoke.mjs` / `ui-input-error.mjs` 等）

主要証跡の SHA-256:

```
ebad5ac6…c0ce7330  RESULT.md
ff6b3097…0ce28bc3d  G0-full-suite.log
7db2fadd…5748f72e61f  G2-e2e.log
ca665737…d321c2c3  G3-input-error.json
```

## 5. ゲート

| ゲート | 状態 |
|---|---|
| 統合 92 用例レビュー（`gate_mwbb5vil_2bd7d342`） | approved（2026-11-11 08:39:15 JST） |
| 要件分析（`gate_mwb39sh5_31bbccd2`） | approved（08:52:32 JST） |
| 旧 48 件 / 33 件追加 / 91 件レビュー | rejected（08:40 JST、統合への置換） |
| **pending** | **0** |

※過去の記録にある「ゲート 5 件 pending」は誤り。5 件は総数で、すべて決定済み。

## 6. 制約と証拠境界

1. **imported testrun は不変（プラグイン仕様）**: `imported` は `status=unknown` / `resultTrust=imported-summary` が固定で、更新 API/tool は無い（`testrun_import` のみ）。close 作業は不要であり、変更できないことを缺陷・未完了として扱わない。実行の正は provenance（時刻・commit・exit code・DB 名）。
2. **スイート証拠 32 件**: 既存テストの契約検証。ケース固有の手順を個別再現したものではない。
3. **A02 は条件付き**: stub AI・mock 実行器・`AUTH_MODE=local`。実 AI・実実行器・Access 認証ではない。
4. **実 Access OTP・実 Windows/貸与（#121）は未実施（BLOCKED）**。PASS 扱いにしない。
5. **DB**: テストは使い捨て DB（`aihd_test_qa_*` / `_e2e` 終端）。既存 `ai_helpdesk_test` は蓄積のため使用しない。本番 DB・開発 DB には接続していない（ただし §8-1 の副作用あり）。
6. **部分証拠**: UI を API で代替した確認は「部分証拠」と明記し PASS にしない（今回は直接実行で PASS）。

## 7. 未実行・残課題

| # | 項目 | 状態 |
|---|---|---|
| 1 | P1 28 件 / P2 3 件 | 未実行（reviewed） |
| 2 | 実 Access OTP 後の 3 画面・API（C-3 / 受入 #19〜#21） | 未実施（人間の OTP） |
| 3 | 実 Windows・貸与・別人物承認（#121） | 未実施（実機・実人） |
| 4 | E2E の CI 配線 | 未実施（playwright-core 未宣言、nightly 検討） |
| 5 | 本番配備・リリースゲート申請 | 未実施（別ゲート・人間判断） |
| 6 | 証跡のコミット | 本版とセットで実施（`docs/evidence/qa-20261111/` のみ） |

## 8. 申し送り（重要）

### 8-1. 開発 DB への意図しない migration 適用

E2E の初回実行（09:22:06）で、**開発 DB `ai_helpdesk_mvp` に migration 035 / 036 / 037 が 09:22:08 JST に適用**された。原因は `scripts/migrate.ts` / `seed.ts` が `NODE_ENV != test` のとき `.env.local` を `override: true` で読み込み、E2E が渡した `DATABASE_URL` を開発 DB の値で上書きするため（E2E の `prepareDb()` は `NODE_ENV=development`）。additive な migration でデータ破壊はなく、seed は `.env.local` の値で upsert（users=6、デモ用パスワード不変）。E2E は **env ファイルの無い隔離 worktree** で再実行して PASS（G2b）。手順書もこの方法に修正した。

### 8-2. UI の状態持ち越し

同じテストユーザーで `prototype_states` に画面状態が保存されるため、2 回目以降はホーム表示が変わる。UI テスト DB の `prototype_states` をクリアし、Playwright の `addInitScript` で localStorage/sessionStorage を消去して実行した。

## 9. 次アクション

1. 本レポート v3 を承認者が確認し、リリース判定ゲートを申請するか判断（Go 条件は §0 の表）。
2. P1 / P2 の未実行 31 件の扱いを決定（今回のスコープ外として受容 or 次版で実行）。
3. 実 Access OTP・実機の受入を別途計画。
4. 証跡（本ファイルを含む `docs/evidence/qa-20261111/`）をコミット。
