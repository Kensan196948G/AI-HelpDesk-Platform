# 独立検証レビュー: 受入指摘修正（2026-11-16）

- タスク: task-2（Reviewer/QA・独立検証）。製品コードは編集していない。
- 対象 repo: `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
- branch: `fix/ops-acceptance-findings-20261116`（HEAD = origin/main = `0af394c9e040d13eff5c9bce40b9432d2d6bdbb7`）
- レビュー対象: **未コミットの worktree**（Lead 指示により commit 前の差分）。`git diff` + 未追跡ファイル。
- 親文書: [docs/102](../../../102-release-prep-20261113.md) §6-3 / [docs/101](../../../101-ops-ui-cutover.md) §7 / [docs/100](../../../100-ops-console-migration.md) §4-2, §4-3, §5
- 計画: [plan.md](plan.md)

## 0. 結論（サマリ）

| 区分 | 初回レビュー（18:5x〜19:0x） | 再検証（19:1x・§11） |
|---|---|---|
| P0（重大・即時ブロック） | 0 | **0** |
| P1（高・リリース前に直すべき） | **1**（バナー高さによる主要ボタンの遮蔽。本変更が原因） | **0（解消）** |
| P2（中・要対応/要判断） | **3**（リセットの非永続化＝既存 / AGENTS.md の範囲外差分 / バナー「SecOpsの監査」の根拠不足） | **1**（AGENTS.md のみ残存） |
| P3（低・改善） | **4** | **3**（うち新規 2: リセット失敗経路 / 901px 未満のバナー非表示） |
| マトリクス | PASS 19 / FAIL 2 / NOT RUN 3（§3） | **PASS 21 / FAIL 0 / NOT RUN 3**（§11） |

> **最終確認（P3-5 修正後）は §12。P0 = 0 / P1 = 0。** 残りは P2-2（AGENTS.md のコミット範囲）と docs/103 の受容記載のみ。

**受入指摘 3 件は、いずれも「修正されている」と判定した。**

- F1（設定の「既定値から変更されています」）: **PASS**（値比較へ置換済み。保存行なしの専用 DB で「すべて既定値です」を実測）
- F2（移行バナーの陳腐化）: **PASS**（文言は docs/101 §7・docs/102 §6 の実測と一致。未実装を実装済みと書いていない）
- F3（`/legacy` の自動書込）: **PASS**（`?ro=1` で PUT/POST 0 件、GET は通る。ro なしは従来どおり自動同期）

ただし **F2 の修正（バナーを長くしたこと）が新しい P1 を生んでいる**（§4 P1-1）。文言の正確性と、バナーの高さ・遮蔽は別問題として扱う。

## 1. 検証環境と方法

| 項目 | 内容 |
|---|---|
| 変更ファイル（tracked） | `Mirai_AIHelpdesk_OpsConsole_V1.0.html` / `apps/api/src/routes/ops.ts` / `ops.test.ts` / `prototype.ts` / `prototype.test.ts` / `apps/api/src/server.ts` / `AGENTS.md`（範囲外） |
| 新規ファイル（untracked） | `apps/api/src/lib/startup-retry.ts` / `startup-retry.test.ts` / `docs/evidence/release-recheck-20261116/verify/plan.md` |
| テスト DB | `aihd_test_verify_20261116`（`apps/api/src/lib/test-database.ts` の許可名 `aihd_test_*` に一致） |
| UI 実測 DB | `aihd_test_verify_ui_20261116`（migrate + seed のみ。`ops_settings` 行 0 で開始） |
| ローカル API | `AUTH_MODE=local` / `DEV_AUTH_EMAIL=watanabe@example.com`（seed の承認者）/ `PORT=18965` / `NODE_ENV=test` |
| ブラウザ | **`dsh_browser` は起動不能**（browser host が `code=1` で終了、`HostGoneError`）。代替として **Playwright 1.49.1 + `/usr/bin/google-chrome`（headless）** で実測した。**この代替は「実ブラウザでの実測」であり、`dsh_browser` 経由の確認自体は NOT RUN**（§5） |
| ポート | 指示の 18960 は**無関係の uvicorn が使用中**だったため触らず、18965 を使用。終了後にポート閉塞を確認済み |
| 秘密 | `.env.test.local` の値・資格情報は表示していない。seed は合成データのみ |

`dsh_browser` が使えなかった記録: `dsh_browser_open` → `browser host exited (code=1 ...) `、`dsh_browser_doctor` → `HostGoneError: browser host did not start`。セッション reset 後も同様。**この点は未実施として扱う。**

## 2. 指摘ごとの判定

| # | 指摘（docs/102 §6-3） | 修正前の根拠（Phase 1） | 修正後の実測 | 判定 |
|---|---|---|---|---|
| F1 | 設定の「既定値から変更されています」が `state.settings` の有無で決まる | HTML:1746（旧）`${state.settings ? ... : ...}`、getSettings:1616、boot:2198（旧）、save:2317（旧） | `isDefaultSettings()`（HTML:1618）を追加し、1748 と 1971 を値比較へ。保存行なしの `/ops` で「すべて既定値です」、`thHigh=0.5` 保存後は「変更されています」を実測 | **PASS** |
| F2 | 移行バナーが P2 時点の文言 | `ops.ts:43-45`（旧） | `ops.ts:48-49` に実データ接続済み・`/legacy` 残置・未実装/疑似を区別した文言。served HTML と定数が一致（`boot.banner === MIGRATION_BANNER`）。陳腐化文言「その他の画面は順次接続します」は消滅 | **PASS**（正確性）／副作用は P1-1 |
| F3 | `/legacy` は開くだけで PUT と POST を送る | bridge.js:95-119、device-bridge.js:372-385, 474-475 | `?ro=1`: 9 秒観測で non-GET **0 件**（PUT/POST 0）、GET 8 件は成功、旧 UI 描画・JS 例外 0。ro なし: `PUT /api/state/cowork`×4・`PUT /api/state/helpdesk`×4・`POST /api/device/browser`×1 を実測（DB に `prototype_states` 2 行） | **PASS** |

## 3. 検証マトリクス（実測）

| ID | 項目 | 期待 | 実測（手段） | 判定 |
|---|---|---|---|---|
| V01 | 設定注記が値比較 | `state.settings` の有無でなく値で判定。ネストも比較 | HTML:1618 `JSON.stringify(getSettings())===JSON.stringify(DEF_SET)`。ロジック再現で `sla.P3`・`std.forti`・`thHigh`・`pc` の単独変更をすべて「変更」と判定 | PASS |
| V02 | ネスト/部分設定 | `sla`/`std` の 1 キー変更でも「変更されています」。欠損キーは既定値補完 | `getSettings` の合成順によりキー順も正規化（サーバ JSONB が `{dc,forti}` 順で返しても一致）。`sla.P3=481`→false（＝変更あり）、`sla:{P3:480}` のみ→true（＝既定） | PASS |
| V03 | リセット文言が値比較 | 既定値なら「すでに既定値です」 | HTML:1971 `if(isDefaultSettings()){toast('すでに既定値です');return}`。値を変えた状態からのリセットで確認（§4 P2-1 の範囲） | PASS（文言条件） |
| V04 | 保存行なしの `/ops` | 「すべて既定値です」 | 専用 UI DB（`ops_settings` 0 行）で `/ops`→システム設定。`hasDefaultMsg=true`, `hasChangedMsg=false`, pageerror 0 | PASS |
| V05 | 保存→再読込の一貫性 | 変更したら「変更されています」、戻したら「すべて既定値」 | `PUT /api/ops/settings`（thHigh 0.5）→再読込で「変更されています」+ 50% 表示。既定値へ PUT→「すべて既定値です」 | PASS |
| V06 | バナーが実測と一致 | 実データ接続範囲・残機能・未実装/疑似を区別 | `ops.ts:49` を docs/101 §7・docs/102 §6-1・docs/100 §4-2/§4-3 と突合（§3-1） | PASS（「SecOpsの監査」のみ P2-3） |
| V07 | 「疑似」の整合 | 疑似を実データ扱いしない／旧 UI 専用を新 UI で可能と書かない | 「資産管理DB連携・リモート接続・SecOps 端末の状態は疑似」「RSP 接続・強制切断・フォルダアクセス・サポートセッションは /legacy」＝ docs/102 §6-1・docs/101 §7 と一致 | PASS |
| V08 | バナーの配信 | served HTML に新文言、テスト期待も一致 | `boot.banner` と `MIGRATION_BANNER` の完全一致を確認。`ops.test.ts` の新テスト（7 tests 中）pass | PASS |
| V09 | `?ro=1` のガード挿入 | ro のときだけガード+注記 | `/legacy?ro=1` に `data-aihd-readonly-guard="1"` と注記、`/legacy` には無し。ガードは最初の `<script>`（<head> 直後、boot/ブリッジより前） | PASS |
| V10 | ガードのメソッド範囲 | POST/PUT/PATCH/DELETE のみ拒否、GET/HEAD は通す | `blocked=['POST','PUT','PATCH','DELETE']`。`prototype.test.ts` の単体テストで PUT/POST 拒否・GET 通過を確認。ブラウザで GET 8 件成功 | PASS |
| V11 | `?ro=1` で PUT/POST 0 | 自動同期が飛ばない | 9 秒観測（400/1200/5000ms・load・500ms 間隔を包含）で non-GET 0。`/api/state` PUT 0、`/api/device/browser` POST 0 | PASS |
| V12 | ro の画面表示 | 旧 UI が描画され、白画面/例外なし | title「みらいAI窓口 × ヘルプデスク ステップ受付 V3.1」、本文に「新しい相談をはじめる」、注記表示、pageerror 0、console error 0 | PASS |
| V13 | ro なしの従来挙動 | 従来どおり自動同期 | PUT cowork×4 / helpdesk×4、POST browser×1。`prototype_states` 2 行を確認 | PASS |
| V14 | 権限制御と誤解されない | 検証補助だと読める／サーバ認可は不変 | `prototype.ts:284-289` のコメントに「**権限制御ではない**。サーバ側の認可・CSRF・監査は従来どおり」と明記。サーバ側変更なし | PASS（画面注記は P3-3） |
| V15 | 差分の範囲 | 対象ファイルに限定、DOM/CSS の無断変更なし | HTML の差分は 3 箇所の式のみ（CSS/構造の変更なし）。ただし **`AGENTS.md` に範囲外の差分**（§4 P2-2） | **FAIL（範囲）** |
| V16 | 秘密・PII の混入 | 差分に秘密/実 PII なし | `git diff` の追加行に email/電話/トークン様文字列なし。テストの `'bad password'` は合成文字列。`.env*` は不変 | PASS |
| V17 | テストの改変 | 削除・skip・期待値緩和なし | `git diff --numstat`: ops.test +16/-0、prototype.test +44/-0。`skip|todo|only` 追加 0、テストの削除行 0 | PASS |
| V18 | 対象テスト | 専用 DB で全 pass | `npx vitest run ops.test ops-settings.test prototype.test startup-retry.test` → **4 files / 38 tests pass、exit 0**（ops 7、ops-settings 4、prototype 23、startup-retry 4） | PASS |
| V19 | 型・lint | 成功 | `npm run typecheck` exit 0。`npm run lint` exit 0（warning 371 / info 198、error 0） | PASS |
| V20 | 既存受入への回帰 | `/ops` 配信・`/legacy` boot・CSP・`/api/state` 往復が従来どおり | 上記テスト（既存アサーションを含む）が pass。UI のスクリーンショットで `/ops` の 12 メニューと「すべて既定値です」を確認し、`/legacy` の boot・`/api/state` 往復も確認 | PASS |
| V21 | バナーが主要操作を覆わない | 追加した文言で操作を妨げない | **新バナーで「受付してAI一次対応を開始」「設定を保存」「既定値に戻す」がポインタで押せない**（§4 P1-1） | **FAIL** |
| V22 | `dsh_browser` での実測 | dsh_browser で確認 | browser host が起動せず **NOT RUN**（Playwright で代替実測） | NOT RUN |
| V23 | 本番/Staging の実機確認 | 本番で確認 | 本タスクの禁止事項（本番書込なし）。**NOT RUN**（対象外） | NOT RUN |
| V24 | 起動順序（DB より先に API）の再現 | restart で ECONNREFUSED→再試行成功 | ホスト再起動・Docker 起動順序の再現は**NOT RUN**（単体テストのみ） | NOT RUN |

### 3-1. バナー文言の突合（V06/V07 の根拠）

| バナーの記述 | 根拠 | 判定 |
|---|---|---|
| 受付・AI一次対応・引継ぎ/解決・下書き/承認・ナレッジDB・監査ログ・Skills反映・システム設定が実データ | docs/102 §6-1 の 12 画面実測（KB 9 行、Skills 7 本、監査 50 行、設定一覧） | 一致 |
| DevOps の実測値（commit/稼働時間/DB件数） | `ops-status.ts` の `loadDevopsStatus`（commit/release/uptimeSec/db.counts）と HTML:2333-2340 の「サーバ実測」カード | 一致 |
| 端末診断・修復の自動化が未実装 | docs/101 §7「端末診断・修復の自動化＝未実装」 | 一致 |
| DevOps の unit/CI/backup 表示が未実装 | docs/100 §4-2（unit/CI/backup を実状態で集約する計画）に対し、`ops-status.ts` のコメント「unit/CI の詳細は将来」 | 一致（表現は P3-5） |
| 資産管理DB連携・リモート接続・SecOps 端末の状態が「疑似」 | docs/102 §6-1 の DevOps/SecOps 実測 | 一致 |
| RSP 接続・強制切断・フォルダアクセス・サポートセッションが `/legacy` | docs/101 §7 | 一致 |
| SecOps の監査が実データ | **docs/102 §6-1 に記載なし**。`/ops` の HTML は監査鎖の検証結果（`/api/ops/status` の `audit`）を参照していない | **根拠不足（P2-3）** |

## 4. 重大度付きの指摘

### P1-1. バナーの高さ増加で主要ボタンが隠れ、ポインタ操作できない（本変更が原因）

- **事象**: 移行バナーが 1 行（1280px 幅で 32px）から 3 行（67px）になり、画面下部に固定表示されるため、`/ops` の主要ボタンがバナーの下に隠れてクリックできない。
- **実測（Playwright + Chrome、`elementFromPoint` でボタン中心を判定）**:
  - 1280×720: 新バナー top 653 / 高さ 67。**受付の「受付してAI一次対応を開始」**（top 666）と**設定の「設定を保存」「既定値に戻す」**（top 661）の中心はバナー（DIV）が返る＝被覆。
  - 同じ画面でバナー文言を旧文言に戻すと高さ 32 / top 688 になり、同ボタンは `BUTTON` が返る＝被覆なし。**文言の長さが原因**であることを同一ページで確認。
  - 1920×1080: 新バナー 50px でも受付ボタン（top 1017）は被覆。1366×768 でも設定フッターは被覆。
  - `#main` の `overflow-y` は `hidden` で、スクロールしてもボタン位置（top）は変わらず、回避できない。
- **影響**: 受付（チケット作成）と設定保存・リセットという主要操作が、一般的なノート PC 解像度でマウス操作できない。キーボード操作は未確認。バナー自体が不透明（`background:#fbf0dc`）のため、ボタンは見えない。
- **推奨対応（いずれか）**: 文言を 2 行以内に短縮する／バナーに `pointer-events:none` を付ける（ただし文言コピー不可になる）／バナーの高さぶん `body` か `#main` に `padding-bottom` を確保する／バナーを折りたたみ可能にする。**受入前に 1280×720 で受付・設定のボタンが押せることを再実測**すること。
- **スコープ**: 本変更（`ops.ts:49` の長文）が原因。文言の正確性（F2）は満たしているため、長さだけを調整すればよい。

### P2-1. 「既定値に戻す」がサーバへ永続化されず、再読込で変更値に戻る（既存・スコープ外）

- **事象**: `/ops` の「既定値に戻す」は画面内の `state.settings` を消して `save()/render()` するだけで、`PUT /api/ops/settings` を送らない。サーバの `ops_settings` 行は変更値のまま残るため、再読込すると変更値が復活する。トーストは「既定値に戻しました」と出る。
- **実測**: `thHigh=0.5` を保存 → 「変更されています」。リセットを実行 → **リクエスト 0 件**（PUT なし）、画面は「すべて既定値です」。**再読込すると「変更されています」+ 50% に戻る**。DB の `ops_settings.value->>'thHigh'` は 0.5 のまま。
- **根拠**: HTML:1971（リセット条件）と 1973 の `delete state.settings; ...; save(); render()`、2319 の `if(!state.settings||...) return;`（`App.saveSettings` 側のサーバ保存ガード）。
- **影響**: 利用者はリセットが成功したと誤認する。設定は次回保存まで戻らない。**本差分で導入されたものではなく、HEAD でも同じ**（`git diff` に当該行の変更なし）。Lead も既知の残課題として報告済み。
- **推奨対応**: リセット時に既定値を `PUT /api/ops/settings` で保存する（または専用の reset API）。今回のスコープ外なら、既知の残課題として docs に記録し、フォローアップ Issue を立てる。
- **重大度**: P2（機能の誤認。データ破壊なし）。

### P2-2. `AGENTS.md` の範囲外差分が worktree に混在

- **事象**: `AGENTS.md` に「Super-Agent 共通規約（DSH 管理下）」8 行が追加されている。Lead によれば他ツール由来で本タスクの変更ではない。
- **影響**: `git add -A` でコミットすると、無関係なリポジトリ全体の規約変更が本 PR に混入する。
- **推奨対応**: 本タスクのコミット対象から除外する（`AGENTS.md` は stage しない）。意図して入れるなら別 PR にする。
- **判定**: 範囲（V15）は FAIL。他の変更範囲（HTML/ops/prototype/server/新規 lib）は妥当。

### P2-3. バナー「SecOpsの監査」が実測・実装と一対一で対応しない

- **事象**: バナーは「…SecOpsの監査／緊急停止／接続同意は実データに接続済みです」と書くが、
  - docs/102 §6-1（実測）に SecOps の監査（鎖）の記載がない。
  - `/ops` の HTML に `監査鎖` / `audit.ok` / `__OPS_STATUS__` の参照がなく、`/api/ops/status` が返す監査鎖の検証結果は画面に出ていない。
  - SecOps の「統制チェック」は画面内計算（`secChecks`）、「接続・同意」は実 `audit_log` 由来。
- **影響**: 「監査（鎖）が実データで見られる」と読むと過大表示。docs/100 §4-3 が求める監査鎖の画面表示は未実装のまま。
- **推奨対応**: 「SecOps の接続・同意の記録」のように実際に表示しているものへ具体化するか、監査鎖の検証結果を画面に出す（後者はスコープ外）。どちらも難しければ「監査」を外す。
- **重大度**: P2（「未実装を実装済みと書かない」に触れ得る）。

### P3-1. `server.ts` のコメントが存在しない `docs/103` を参照

- `apps/api/src/server.ts:235` に「（2026-11-16 12:37 の実測。docs/103）」とあるが、`docs/103*` は存在しない（`ls docs/103*` → なし）。参照先を作るか、既存 docs（例: docs/102 §7）へ直す。

### P3-2. `isDefaultSettings` は余分なキーがあると「変更されています」になる

- `JSON.stringify(getSettings())===JSON.stringify(DEF_SET)` は、`state.settings` に想定外のキー（将来のメタ情報など）が 1 つ増えると false になる。現状 `loadSettings` は 8 キーだけを返すため実害なし。キーを固定して比較する（許可キーのみ抜き出す）方が頑健。

### P3-3. `?ro=1` の画面注記が「権限制御ではない」と書いていない

- ソースコメント（`prototype.ts:284-289`）には明記があるが、画面注記は「読み取り専用モード（?ro=1）: この画面からの保存・送信は行いません。」のみ。API を直接叩けば書き込めることを利用者が誤解し得る。注記か docs に「検証補助であり権限制御ではない」旨を 1 行足すのが望ましい（V14 はコメント根拠で PASS）。

### P3-4. `?ro=1` は読み取り目的の POST も拒否する（仕様どおりだが副作用あり）

- `intake-preview`（`POST /api/intake/preview`）や `knowledge-review`（`POST /api/knowledge/inspect`）、`logout-bridge`（Access ログアウト）は POST のため ro モードでは失敗する。入力・クリック時に該当パネルがエラー表示になり得る（画面全体は描画継続）。ro は検証補助なので許容だが、レビュー時の期待値として記録する。**ブラウザでの当該操作は NOT RUN**（ソース確認のみ）。

## 5. startup-retry（新規）のレビュー

- **恒久的な失敗を隠さない**: `isDatabaseStarting` は `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `57P03` のみ true。対象外は待機せず即 throw、上限到達時は最後のエラーを throw（`startup-retry.ts:30-70`）。テスト 4 件が「対象外は 1 回で throw」「上限で最後のエラー」を検証している。**PASS**。
- **呼び出し側**: `server.ts:237-240` で `attempts:5, delaysMs:[250,500,1000,2000]`（最大待機 3.75 秒＋実行時間）。失敗時の従来動作（`app.log.error` して起動継続）は維持。**PASS**。
- **残リスク**: 実際の「Docker の PostgreSQL より API が先に起動する」順序の再現は **NOT RUN**。再試行対象コードの網羅性（pg ドライバが接続拒否時に `code` を付けるか）は、実運用ログ 1 件の報告に依存しており、本検証では独立確認していない。
- **注意**: `ENOTFOUND`/`EAI_AGAIN` は DNS 設定の恒久故障でも一致する。3.75 秒で諦めて throw するため隠蔽にはならないが、ログ上は「再試行後失敗」となる。

## 6. `?ro=1` ガードのレビュー（独立性）

- **GET/HEAD を壊さない**: 拒否リストは 4 メソッドのみ。単体テストで GET 通過、ブラウザで GET 8 件成功。**PASS**。
- **通常表示を変えない**: `readOnly: true` のときだけ `<head>` 直後に挿入。`/legacy`（ro なし）の HTML にガードは入らない（テスト＋HTTP で確認）。ro なしの自動同期も従来どおり。**PASS**。
- **権限制御ではない**: コードコメントに明記。サーバ側の認可・CSRF・監査は不変（差分にサーバ認可の変更なし）。**PASS**（注記は P3-3）。
- **実装上の限界**: `window.fetch` の差し替えのみ。`XMLHttpRequest` は対象外（`grep -rn XMLHttpRequest apps/api/src/prototype/` → 0 件）、`navigator.sendBeacon` も未使用。フォーム送信は CSP `form-action 'none'` で従来から不可。**現状のブリッジ実装では十分**。
- **挿入位置**: ro の HTML で最初の `<script>`（index 39、`<head>` 直後）であることを確認。boot（index 79077）とブリッジより前。
- **制約の明示**: ヘッダー/クエリの細工で回避可能であり、セキュリティ境界ではない（コメントどおり）。本番の受入で「読み取り専用」と誤って運用しないこと。

## 7. 残リスク・未実施（NOT RUN）

| # | 項目 | 理由 |
|---|---|---|
| N-1 | `dsh_browser` での実測 | browser host が起動不能（electron code=1 / HostGoneError）。Playwright+Chrome で代替したが、`dsh_browser` 経由は未実施 |
| N-2 | 全テストスイート（`npm test`） | タスク指示は対象 4 ファイル。全体は Lead が実施。本レビューでは未実行 |
| N-3 | 本番/Staging の実機・実ブラウザ表示 | 本番書込禁止・対象外 |
| N-4 | 起動順序（PostgreSQL より先に API）の再現 | ホスト再起動/Docker 起動順序を再現していない。単体テストのみ |
| N-5 | ro モードでの実操作（受付入力・承認・ログアウト） | 自動同期の非送信は実測。ユーザー操作時の POST 拒否は単体テストとソース確認のみ |
| N-6 | リセット永続化の修正 | スコープ外（P2-1）。修正後の再検証は未実施 |
| N-7 | `ops-ui-roles.e2e` / `ops-ui-rollback.e2e` など e2e | 対象外（時間・DB 前提）。既存受入は `ops.test`/`prototype.test` で確認 |

## 8. 再現コマンド（秘密値は表示しない）

テスト（実行済み・exit 0）:

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
set -a; . ./.env.test.local; set +a
export NODE_ENV=test AIHD_TEST_DATABASE_NAME=aihd_test_verify_20261116
export DATABASE_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/aihd_test_verify_20261116";console.log(u.toString())')"
npx vitest run apps/api/src/routes/ops.test.ts apps/api/src/routes/ops-settings.test.ts \
  apps/api/src/routes/prototype.test.ts apps/api/src/lib/startup-retry.test.ts
# → 4 files / 38 tests passed, exit 0
```

UI 実測（実行済み・終了後にポート閉塞確認）:

```bash
export NODE_ENV=test AUTH_MODE=local PORT=18965 HOST=127.0.0.1 DEV_AUTH_EMAIL=watanabe@example.com
export AIHD_TEST_DATABASE_NAME=aihd_test_verify_ui_20261116
export DATABASE_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/aihd_test_verify_ui_20261116";console.log(u.toString())')"
npx tsx apps/api/src/index.ts
# 別シェルから Playwright(Chrome headless) で /ops と /legacy?ro=1 を観測
```

主要な実測値:

- `/ops`（ops_settings 0 行）: 「すべて既定値です」= true、「変更されています」= false、pageerror 0。
- `/legacy?ro=1` 9 秒: non-GET 0、`PUT /api/state` 0、`POST /api/device/browser` 0、GET 8 件、pageerror 0。
- `/legacy` 9 秒: `PUT /api/state/cowork`×4、`PUT /api/state/helpdesk`×4、`POST /api/device/browser`×1、`prototype_states` 2 行。
- バナー: 旧文言 32px / 新文言 67px（1280×720）。被覆は旧=false、新=true（受付送信・設定保存・リセット）。
- リセット: リクエスト 0、直後は「すべて既定値です」、再読込で「変更されています」+ 50%（サーバ行が更新されていないことの実測）。

## 9. 証跡

- 計画: [plan.md](plan.md)
- 本レビュー: `docs/evidence/release-recheck-20261116/verify/review.md`
- 実行ログ（一時・リポジトリ外）: `/tmp/verify-phase2-tests.log`、`/tmp/verify-typecheck.log`、`/tmp/verify-lint.log`、`/tmp/verify-ui-result.json`、`/tmp/verify-settings-result.json`、`/tmp/verify-banner-causality.mjs`、`/tmp/verify-ops-settings.png`
  - スクリーンショットは seed の合成データのみ。リポジトリには追加していない。
- 専用 DB: `aihd_test_verify_20261116`（テスト）、`aihd_test_verify_ui_20261116`（UI 実測。`ops_settings` は既定値へ戻し済み）。
- サーバ: ポート 18965 で起動・停止済み。停止後に接続拒否を確認（18960 は無関係プロセスが使用中のため未使用）。

## 10. Lead への依頼事項

1. **P1-1** をリリース前に修正（バナーの高さ/遮蔽）。修正後は 1280×720 で「受付してAI一次対応を開始」「設定を保存」「既定値に戻す」が押せることを再実測してください。
2. **P2-3** の「SecOpsの監査」を具体化（表示していない監査鎖を実装済みと読ませない）。
3. **P2-2** `AGENTS.md` を本タスクのコミットに含めない。
4. **P2-1** は既知の残課題として docs/フォローアップへ記録（今回はスコープ外）。
5. P3-1〜P3-4 は任意（余力があれば）。

---

# 11. 再検証（2026-11-16 19:1x）— P1-1・P2-1・P2-3・P3 の修正後

- 対象: 同じ worktree（commit 前）・同じ専用 DB（`aihd_test_verify_20261116` / UI は `aihd_test_verify_ui_20261116`）。
- 方法: 前回と同じ（専用 DB でテスト、`AUTH_MODE=local`・ポート 18965 で API 起動、Playwright + Chrome headless）。
  **`dsh_browser` は今回も未使用（前回起動不能のため）。** 秘密値は表示していない。
- レビュー対象の追加差分: HTML（バナー cssText・`settingsKey`・`resetSettings`）、`ops.ts`（バナー短縮）、`ops.test.ts`（期待更新）、`prototype.ts`（注記）、`server.ts`（docs/103 参照削除）。
  `AGENTS.md` は依然として worktree に差分あり（本タスク対象外）。

## 11-1. 修正の確認（コード）

| 修正 | 実装（file:line） | 確認 |
|---|---|---|
| P1-1 バナー被覆 | HTML:2216 の cssText を `position:fixed…` から `flex:none;padding…` へ。文言も 161 文字へ短縮（`ops.ts:48-50`） | `@media (min-width:901px)` の `body{display:flex;flex-direction:column}`（HTML:546-548）で下端の flex 要素になる。served HTML に旧 `position:fixed` なし・`flex:none` あり |
| P2-1 リセット永続化 | HTML:1975-1988。`delete state.settings` を廃止し、既定値を `PUT /api/ops/settings` へ送信。成功時のみ監査・保存・トースト | PUT 1 回・再読込後も既定値を実測（§11-3） |
| P2-3 バナー | `ops.ts:49`。「SecOpsの監査」を削除し「主要画面は実データ接続済み」に | served バナーに `SecOpsの監査` なし。`ops.test.ts` も `not.toContain('SecOpsの監査')` を追加 |
| P3-2 既定値判定 | HTML:1619-1620。既知 12 項目の配列比較 `settingsKey` | 余分キー・キー順・部分設定で誤判定しないことをロジック再現で確認（§11-5） |
| P3-3 ro 注記 | `prototype.ts:290-314`。注記に「（?ro=1・検証用）」「権限制御ではありません」 | `/legacy?ro=1` の本文で両方表示（§11-4） |
| P3-1 docs/103 | `server.ts:234-235` の参照を「2026-11-16 12:37 のホスト再起動で実測」へ | `docs/103` 参照なし |

## 11-2. 3 画面サイズでのバナー非被覆（P1-1 の再測）

Playwright でバナーとボタンの bounding box の交差面積・`elementFromPoint`・`click({trial:true})` を測定。

| viewport | バナー（top–bottom / 高さ / position） | 受付してAI一次対応を開始 | 設定を保存 | 既定値に戻す | 交差面積 | 中心の要素 | trial click |
|---|---|---|---|---|---|---|---|
| 1280×720 | 670–720 / 50px / static | 616–650 | 611–645 | 611–645 | **0** | BUTTON | ok |
| 1366×768 | 718–768 / 50px / static | 664–698 | 659–693 | 659–693 | **0** | BUTTON | ok |
| 1920×1080 | 1048–1080 / 32px / static | 993–1028 | 986–1021 | 986–1021 | **0** | BUTTON | ok |

- バナーは 3 サイズとも初期表示内（`bannerVisible=true`）で、本文に重ならない。
- `pageerror` は 3 サイズとも 0。
- 1280×720 では実際に「既定値に戻す」をクリックできた（§11-3）。**P1-1 は解消。**

## 11-3. 設定リセットの永続化（P2-1 の再測）

1. `PUT /api/ops/settings` で `thHigh=0.5` を保存（200）→ `/ops` 再読込で「既定値から変更されています」。
2. 「既定値に戻す」を実クリック（Playwright の通常 click が成功＝被覆なし）。
3. 観測: **`PUT /api/ops/settings` が 1 回だけ**送信。直後の画面は「すべて既定値です」。
4. 再読込後も「すべて既定値です」を維持（「変更されています」は false）。
5. DB 実測: `ops_settings.value` は `thHigh=0.42 / sla.P3=480 / std.forti=7.2.10`（既定値）。

**P2-1 は解消**（成功経路）。HTTP 4xx 時の「サーバ値へ戻す」処理はコード確認のみ（実行は NOT RUN）。

## 11-4. `/legacy?ro=1` の非送信（維持確認）

9 秒観測（400/1200/5000ms・load・500ms 間隔を包含）:

- non-GET **0 件**（PUT/POST/PATCH/DELETE なし）、GET 8 件は成功。
- 本文に「読み取り専用モード（?ro=1・検証用）」と「権限制御ではありません」を表示。
- 旧 UI は描画（「新しい相談をはじめる」あり）、pageerror 0。

**前回の PASS を維持。**

## 11-5. `settingsKey` の判定マトリクス

| 入力 | 判定（true=既定値） | 期待 |
|---|---|---|
| 保存行なし（undefined） | true | true |
| 既定値・キー順を JSONB 順に入替（`std:{dc,forti}` 等） | true | true |
| 既定値 + 余分キー（`extraKey`, `updatedAt`） | true | true |
| `thHigh=0.5` | false | false |
| `sla.P3=481` | false | false |
| `std.forti=7.2.11` | false | false |

**P3-2 は解消**（既知キーの配列比較でキー順・余分キーの影響を受けない）。

## 11-6. テスト・型・lint（再実行）

| コマンド | 結果 |
|---|---|
| `npx vitest run ops.test.ts ops-settings.test.ts prototype.test.ts startup-retry.test.ts`（`aihd_test_verify_20261116`） | **4 files / 38 tests pass、exit 0** |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（warning 371 / info 198、error 0） |
| `git diff -U0 -- '*test.ts' | grep '^-'` | テストの削除行なし |
| `git diff -U0 | grep -E '^\+.*\.(skip|todo|only)\('` | なし |

## 11-7. 再検証で見つかった新規・残存の指摘

### P2-2（残存）. `AGENTS.md` の範囲外差分

前回と同じ。`git status` で `M AGENTS.md` が残っている。本タスクのコミットに含めないこと（`git add -A` を使わない）。

### P3-5（新規）. リセットの「ネットワーク失敗」経路ではサーバ値へ戻らない

- **事象**: `resetSettings` は送信前に `state.settings=defaults` を代入し（HTML:1976）、`.catch` ではトーストのみ（HTML:1988）。HTTP エラー（`!res.ok`）は再取得して戻すが、**fetch 自体の失敗（接続断・タイムアウト）では戻さない**。
- **実測**（Playwright で PUT のみ `route.abort`）: トースト「設定をサーバに保存できませんでした」。直後の DOM は再描画されないため「変更されています」のまま。**別画面へ移動して再描画すると「すべて既定値です」**（内部状態だけ既定値）。再読込するとサーバ値 0.5 が復活し「変更されています」。
- **影響**: トーストで失敗は分かるが、再描画後に画面が「既定値」を示し、サーバと食い違う。データは失われない。
- **推奨**: `.catch` でも送信前の設定へ戻す（例: `const before=getSettings()` を保持し、失敗時に `state.settings=before; applySettings(); render()`）。または GET で再取得。
- **重大度**: P3（ネットワーク断の edge、トーストで通知あり）。

### P3-6（新規）. 901px 未満ではバナーが初期表示で見えない

- **事象**: `flex:none` は body が flex のときだけ効く。`@media (min-width:901px)` の外では body が `display:block` のため、バナーは本文の末尾（通常フロー）に落ちる。
- **実測**: 390×844 → バナー top 1769（初期表示外、`inViewport=false`、doc scrollHeight 1871）。768×1024 → top 1660（初期表示外）。どちらも pageerror 0。
- **影響**: デスクトップ（検証対象の 3 サイズ）は問題ない。モバイル/タブレット幅では、スクロールしないと「未実装・疑似」の注記が見えない（以前の fixed では見えていた）。ops コンソールが 901px 未満を対象外とするなら許容。
- **推奨**: 対象に含めるなら、body を常に flex にする／バナーを `position:sticky;bottom:0` にする等。
- **重大度**: P3（対象外の可能性が高いが、注記の可視性は要件次第）。

### P3-4（残存）. `?ro=1` は読み取り目的の POST も拒否

前回と同じ（intake preview / knowledge inspect / logout）。仕様どおりだが、ro 中の該当パネルはエラー表示になり得る。ブラウザ実操作は NOT RUN（ソース確認のみ）。

### 参考: Lead の未追跡エビデンス

`docs/evidence/release-recheck-20261116/lead/` に 5 ファイル（boot-ordering / monitoring / prod-db-facts / prod-readiness / public-url）が未追跡で存在。
**内容は表示せず**、秘密・PII パターン（password/secret/token/PRIVATE KEY/OPENSSH/AKIA/ghp_/資格情報付き DSN/メール）の**出現数のみ**を確認 → すべて 0。コミット対象に含める場合は内容の最終確認を推奨（本レビューの対象差分外）。

## 11-8. 環境・後始末

- 専用 API（ポート 18965）は停止済み。停止後に接続拒否・ポート空きを確認。
- 専用 DB は既定値へ戻した状態（`ops_settings` は既定値 1 行）。
- `dsh_browser` は前回同様に起動できず（今回も未使用）。UI 実測は Playwright + `/usr/bin/google-chrome` headless。
- 秘密値・資格情報は表示していない。

## 11-9. 再検証の結論

- **P0 = 0 / P1 = 0。** P1-1（バナー被覆）、P2-1（リセット永続化）、P2-3（「SecOpsの監査」）、P3-1（docs/103）、P3-2（余分キー）、P3-3（ro 注記）は**解消を実測で確認**。
- 残存: **P2-2**（AGENTS.md をコミットしないこと）、**P3-4**（ro の読み取り POST）、新規 **P3-5**（リセットのネットワーク失敗経路）、**P3-6**（901px 未満のバナー非表示）。
- 受入指摘 F1/F2/F3 の修正は、再検証後も **PASS**。リリースをブロックする P0/P1 は無い。

---

# 12. P3-5 修正後（2026-11-16 19:2x）

- 対象: 同じ worktree（commit 前）。変更は HTML の `resetSettings` の `.catch` のみ（HTML:1988-1992）。
- 方法: 前回と同じ専用 DB・`AUTH_MODE=local`・ポート 18965・Playwright + Chrome headless（`dsh_browser` は引き続き未使用）。秘密値は表示していない。

## 12-1. 修正内容

`resetSettings` は送信前に `state.settings=defaults`（HTML:1976）を入れるため、通信失敗時に画面だけ既定値になる余地があった。修正後は `.catch`（HTML:1988-1992）で `GET /api/ops/settings` を再取得し、`state.settings` をサーバ値へ戻して `applySettings(); render()` する。HTTP エラー（`!res.ok`、HTML:1981-1984）と同じ復元処理になった。

## 12-2. 通信失敗経路の実測（P3-5）

Playwright で `PUT /api/ops/settings` のみ `route.abort('failed')` してリセットを実行（GET は通す）。サーバは `thHigh=0.5`。

| 確認 | 実測 |
|---|---|
| 実行前の表示 | 「既定値から変更されています」 true / 50% true |
| トースト | 「設定をサーバに保存できませんでした」 |
| PUT 試行回数 | **1** |
| 失敗後の再取得 | `GET /api/ops/settings` **1 回** |
| 失敗直後の DOM | 「変更されています」 **true** / 「すべて既定値です」 false / 50% true |
| 別画面→設定に戻して再描画 | 「変更されています」 **true**（内部状態もサーバ値） |
| 再読込 | 「変更されています」 **true** / 50% true |

**P3-5 は解消。** 通信失敗でも「画面だけ既定値／サーバは変更値」という食い違いは残らない。

- 残る理論上の edge: PUT も再取得 GET も両方失敗した場合は、画面が既定値のまま残り得る（サーバへ到達できない状況。トーストで失敗は通知され、再読込でサーバ値に戻る）。

## 12-3. 直前の再検証への回帰確認（1280×720）

| 項目 | 実測 | 判定 |
|---|---|---|
| P1-1 バナー非被覆 | バナー 670–720（50px）、受付ボタン 616、設定ボタン 611。交差面積 **0**、中心要素 BUTTON、trial click ok（受付送信／設定保存／既定値に戻す） | 回帰なし |
| P2-1 成功時リセット | 実クリック→ **PUT 1 回** → 再読込後「すべて既定値です」維持 | 回帰なし |
| 既定値表示 | 保存行が既定値のとき「すべて既定値です」＝ true、「変更されています」＝ false | 回帰なし |
| `/legacy?ro=1` | 9 秒で non-GET **0**、GET 8、注記「（?ro=1・検証用）」「権限制御ではありません」表示、旧 UI 描画 | 回帰なし |
| pageerror | `/ops`・`/legacy?ro=1` とも **0** | 回帰なし |

## 12-4. 差分・テスト・型・lint（最終）

| 確認 | 結果 |
|---|---|
| `npx vitest run`（対象 4 files、`aihd_test_verify_20261116`） | **4 files / 38 tests pass、exit 0** |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（warning 371 / info 198、error 0） |
| 最終差分の新規 P0/P1 | **なし**（変更は `.catch` の復元処理のみ。テスト削除・skip・期待値緩和なし、秘密/PII の追加なし） |
| `git diff` の範囲 | `AGENTS.md` の範囲外差分が依然残存（P2-2）。本コミットに含めないこと |

## 12-5. 残存事項（P0/P1 ではない）

1. **P2-2**: `AGENTS.md` の範囲外差分（コミット除外）。
2. **P3-4/P3-6 の受容記載**: Lead は docs/103 に明記して受容する方針だが、**2026-11-16 19:2x 時点で `docs/103*` は worktree に存在しない**（`ls docs/103*` → なし、`git status docs/103*` → なし）。受容を記録する docs の追加が必要。
3. **P3-4**: `?ro=1` は読み取り目的の POST も拒否（安全側の設計として受容予定）。
4. **P3-5 の二重失敗 edge**: PUT と再取得 GET の両方が失敗した場合のみ、再読込まで画面が既定値のまま（トースト通知あり）。

## 12-6. 結論

- **P0 = 0 / P1 = 0。** P3-5 の修正を実測で確認し、P1-1・P2-1・P2-3・ro モードの再検証結果にも回帰は無い。
- 残りは P2-2（コミット範囲）と docs/103 の受容記載のみで、いずれもリリースをブロックする欠陥ではない。
- 専用 API（18965）は停止済み・ポート空きを確認。専用 DB は既定値（`0.42 / P3=480`）へ戻した状態。
