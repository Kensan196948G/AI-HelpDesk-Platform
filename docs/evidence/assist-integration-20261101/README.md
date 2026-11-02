# #120 の統合後の受入（2026-11-01）

- ブランチ: `verify/dataflow-assist-integration`。#127 の検証統合 `74dbc21` に #120 `abb9a38`（#117 を含む）を merge（`48cbff3`）。
- 試験を流した SHA: `f086d4f`。この文書の commit は証跡の追加だけで、コードを変えていない。
- 環境: Linux、pwsh、専用 DB `ai_helpdesk_integ2_test`（127.0.0.1:5435）。実 DeepSeek、RSP、実機は使っていない。AI と RSP はスタブ。
- **実機の確認範囲はこの統合で増えていない。** ここの「成功」は試験の成功で、実端末、実画面、Access の受入ではない。

## 全体の結果

| 検査 | 結果 |
|---|---|
| migration（空 DB から 001〜037、2 回目は全件 skip） | 成功 |
| `npm run typecheck` / `biome check … --diagnostic-level=error` / `npm run build` | 成功 |
| `npm audit --audit-level=high` | 脆弱性 0 件 |
| vitest 全件 | 1525 件中 1524 件成功、**1 件失敗**、skip 0 件。同じ DB の 2 回目 |
| `folder-helper.tests.ps1`（CI の手順） | passed=428 failed=0 |
| `skill-run.tests.ps1`（CI の手順） | passed=759 failed=0 |

**失敗の 1 件:** `command-agent.pwsh.test.mjs` の「スタブの HTTP サーバと Skill で fail-closed を確かめる」（pwsh の内訳 passed=153 failed=31 skipped=8。`close:`、`elevated:`、`fail-closed:`、`handle:`、`reparse:`、`source:`、`swap`）。`74dbc21` の修正前の再現試験で、**別担当が元ブランチで修正中**なのでこの統合では触っていない。#120 の統合で増えた失敗ではない（試験は `command-agent.ps1` だけを対象にし、この統合はそのファイルを変えていない）。

## CI

| 項目 | 内容 |
|---|---|
| 実行 | [run 41304395529](https://github.com/Kensan196948G/AI-HelpDesk-Platform/actions/runs/41304395529)、`9435ebd`、`workflow_dispatch`。`ci.yml` は main 宛ての PR と push でしか走らないので手動で起動した |
| 結果 | **failure**。`Test` の手順で 1525 件中 1 件失敗（上と同じ `command-agent.pwsh.test.mjs` の 1 件） |
| 成功した手順 | Secret scan、Dependency audit（2 種）、Typecheck、Lint、Migrate（2 回） |
| **走らなかった手順** | **Build、Folder helper tests (pwsh)、Skill executor tests (pwsh)。** `Test` の失敗で止まった。この 3 つの成功はローカルの結果だけで、CI では確かめていない |

`continue-on-error` などでゲートを弱めていない。この節の追加は文書だけで、CI は `9435ebd` の結果である。

**追記（2026-11-02）:** 上の failure は `9435ebd` の結果で、後の SHA で解消した。`command-agent.pwsh.test.mjs` の修正後は [`bdc01cb`](https://github.com/Kensan196948G/AI-HelpDesk-Platform/actions/runs/41315289929) と [`5f404ff`](https://github.com/Kensan196948G/AI-HelpDesk-Platform/actions/runs/41318921072) の CI が成功し、Build と pwsh の 2 手順も CI で走った。

main（`056c3ae`、#122 と #124）を取り込んだ後の `1b9d4ec` のローカルの結果: typecheck、lint、build、vitest 全 1537 件が成功、通し E2E は 88 項目で失敗 0（`e2e/result.json`）。**通し E2E はスタブ AI と模擬の実行器で、実機の確認は増えていない。** `POST /api/device/command` の 410 は通し E2E の項目ではなく、統合試験で確かめている。

**追記（2026-11-02、#129 の後）:** main（`75f2359`）を取り込んだ `930e39e` で、空にした専用 DB で migration を 2 回、vitest 全 1547 件が成功、通し E2E は 88 項目で失敗 0。

**追記（2026-11-02、#123 の後）:** main（`dc529c9`）を取り込んだ `c6e19ea` で、vitest 全 1547 件が成功、通し E2E は 88 項目で失敗 0。

## 受入表

「③」は支援セッションの本人ヘルパー、「②」は resolve ループ（[docs/67](../../67-execution-paths.md)）。成功数はこの SHA の vitest の結果を試験名で引いた値である。integration は `apps/api/src/support-session/support-session.integration.test.ts`。

| 項目 | ③ の試験（ファイル: 試験名の要約） | ③ の結果 | ② への接続 |
|---|---|---|---|
| 症状の否定 | `support-session/case-facts.test.ts`: 否定を症状にしない | 10/10 | **未接続**（実測 `probe-resolve-path.json`: 「印刷エラーはありません」でも `spooler.status` を提案） |
| 症状の解消 | 同: 解消、まだ直っていない、どれが直ったか | 12/12 | **未接続** |
| 過去形 | 同: 過去、昨日、時点 | 6/6 | **未接続**（実測: 「昨日は印刷できなかったが今は印刷できます」でも提案） |
| 複数症状 | 同: 複数の症状、同じ節、分類 | 3/3 | **未接続** |
| 断定的な AI の表現の拒否 | 同: 確かめていないのに解決、確かめた後の説明。`support-session.integration.test.ts`: AI の説明、事実と推測 | 2/2、2/2 | **未接続**（実測: `rationale` の「解決しました」が `proposalFromAiBody` をそのまま通る。解決の判定には使わない） |
| `phase` / `verification` | `support-session/state.test.ts`: 導出、検証は完了と別、報告の期限切れ。integration: `/start` の応答を失った、期限切れの後の状態 | 14/14、2/2 | **未接続**。② は `executionSource` で出所を分ける（別の仕組み） |
| real だけで「実行した」と出さない | `support-session/bridge.test.ts`: real でも実行前の拒否、開始と完了、解決の確認の前 | 3/3 | **未接続**（② のカードは `resolve-bridge.js`） |
| `ASSIST_SESSION_MODE` の起動条件 | `config.test.ts` | 6/6 | 効かない（フラグは ③ だけ） |
| drain: 新規の停止 | integration: 新しいセッション・同意・提案・Y を受け付けない | 1/1 | 同上 |
| drain: 既存の終了 | integration: N・取消・中止、承認済みの実行、Y の後、定期処理と伝搬 | 4/4 | 同上 |
| off | integration: 404 だが消える、保持期限の前、終わらないまま無効、結果が来ていない実行 | 4/4 | 同上 |
| 失効後の完結 | integration: 失効の後でも期限内、報告が来ないまま期限を過ぎた | 2/2 | 同上 |
| 画面の配信 | `prototype.test.ts`: 両方のフラグが有効なときだけ、drain でも配信 | 1/1 | 同上 |
| ローカル保持期限 | `skill-run.tests.ps1`: `retention:` 32 項目を含む全体 | passed=759 failed=0 | `folder-helper.ps1` だけ。② は `command-agent.ps1` の別実装（docs/66 §7）で、上の失敗の試験に含まれる |
| UI 経路の KB（`ui-sync` で作成 → 別アカウントが一覧の指紋で承認 → 新ループの入力） | integration: 承認で固定のタグを保存し参照に入る、承認待ちは入らない、列の前の承認 | 3/3 | ② は別の入力（`findApprovedKnowledge`、`/api/resolve` の試験）。タグは使わない |
| 固定の語彙の外を AI へ渡さない | integration: 固定の語彙の外、ID と固定タグだけ | 2/2 | - |
| KB は根拠にしてよい行だけ（**統合で追加**） | integration: 自己承認、承認者なし、承認後の更新の行は入らない | 3/3 | ② は #125 の条件 |
| タグの指紋（**統合で追加**） | `knowledge-approval-binding.integration.test.ts`: タグだけの変更で 409、行ロックの競合、語彙、端末情報、無効の間 | 10/10 | ②の経路ではなく KB の承認 |

**修正前の再現:** タグの指紋は 8 件、KB の参照の条件は 3 件が修正前に失敗することを確かめてから直した。

## 統合で見つけたこと

1. **KB の承認の指紋の外にタグがあった。** 確認の後にタグだけ書き換えても公開できた。修正した（docs/64 §11）。
2. **新ループが自己承認の KB を AI の入力へ渡していた。** 修正した（docs/67 §3）。
3. **`terminal.integration.test.ts` の 1 件が `74dbc21` の時点で失敗していた。** 指紋なしで承認していた試験で、試験を直した。サーバは変えていない。
4. **#120 の対策の多くは ② に効かない。** 上の表の「未接続」のとおり。

## ベースの状態（2026-11-01 の確認時）

このブランチは `74dbc21` から分かれた。その後 `origin/verify/dataflow-integration` は `3b1a662` へ進み、`command-agent.ps1` の修正（`049f84d`）を含む。**この統合には取り込んでいない。** 試しの merge（`git merge-tree`）で `knowledge-approval-binding.integration.test.ts`、`docs/14`、`docs/65` が競合する。取り込めば上の 1 件の失敗が解消する可能性があるが、確かめていない。

## 確かめていないこと

実端末、実 Windows、実ブラウザの操作、Access、実 DeepSeek、貸与照合の本番の経路、通しの E2E（`scripts/e2e/dataflow-integration.mjs` は統合の後に流していない）。UI 経路の KB は `ui-sync` の API を直接呼んだ結果で、画面のクリックではない。ローカル保持期限は pwsh、Linux、スタブでの確認である。

## 追記: 経路②への接続

上の表の「未接続」のうち、否定、解消、過去形、複数症状、AI の断定は、この表の後で②へつないだ。実装と試験は [docs/67](../../67-execution-paths.md) の追記を正とする。`phase` / `verification`、`ASSIST_SESSION_MODE`、保持期限（folder-helper）は②に効かないまま。

