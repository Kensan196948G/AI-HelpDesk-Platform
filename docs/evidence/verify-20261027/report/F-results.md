# Phase 4 — F: STEP7 完了・最終報告書（2026-10-27 09:14〜09:29 JST）

環境: **V**（自前インスタンス・既存に触れない）
- `:18958` = 一般社員（`AUTH_MODE=local`, 社員番号 MK0122）/ `:18962` = DX 推進部（MK0623）
- DB `ai_helpdesk_f`（`createdb` → migration 020 まで適用・冪等）。`MAIL_TRANSPORT=disabled`。
- ビルド: `/tmp/aihd-head`（HEAD 84bba83 のクリーンビルド・`dist` あり）
- 実行者: Playwright MCP（Chromium・DOM テキストで記録）/ curl / psql
- 既存 18950/18951/18952/18954/18956/18957 と本番 DB `ai_helpdesk_preview` には触れていない。
- 検証用インスタンスは再現のため起動したまま（`:18958` / `:18962`・DB `ai_helpdesk_f`）。既存ポートは不使用。
- 実名・メールは伏せ字（社員番号のみ記載）。スクリーンショットは実名が写るため取得せず、DOM テキストと HTTP/DB 実測で記録した。

## 判定サマリ

| 区分 | 件数 | 内訳 |
|---|---|---|
| PASS | 6 | F-02, F-03, F-04, F-05, F-06, F-07 |
| FAIL | 4 | F-01（部分）, F-08, F-09, F-10 |
| BLOCKED | 0 | — |
| 未実施 | 2項目 | F-04 の「実行記録」（端末セッション無し）、F-07 の 403 期待（実装は 404） |

**新規 High: 1件（F-12）** — 承認チェックリスト未確認でもサーバー承認が先に成立し、以後その案件を完了できなくなる（F-01 の FAIL と直結）。
新規 Medium: 4件（F-13〜F-16）。Low/仕様差: 1件（F-17）。

## 実施した一気通貫（担当者解決）
1. **CASE-0001**: STEP1→3（AI 相談・実 DeepSeek）→ STEP4 引継ぎ（宛先 MK0623）→ DX が claim → 担当開始 → 解決記録（DR-003）→ **承認時にクライアント検証が成立せずサーバーだけ承認 → 案件が完了不能に**（F-12）
2. **CASE-0002**: 同じ経路を再実行 → 解決記録（DR-004）→ チェックリスト ON 後に承認 → **KB-111 v1.0** → **STEP7 完了表示** → 報告書 HTML/PDF

| # | 検証内容 | 実測 | 判定 |
|---|---|---|---|
| F-01 | 完了表示・一覧更新 | **担当者側 PASS**: STEP7 で「解決内容がナレッジ KB-111 になりました」「次にやる人 完了／この案件は完了しています」、ボード「完了 2」に CASE-0002（青）。**依頼者側 FAIL**: 承認・完了後も :18958 の CASE-0002 は STEP4「引継ぎ待ち」、ボード「完了 0」。サーバーの `case_handovers.status=completed` を依頼者の画面が読まない | **FAIL（Medium）** |
| F-02 | 報告書 HTML（担当者解決） | `GET /api/reports/final/738be248…/html` → **200**、`content-type: text/html; charset=utf-8`、22,949 bytes。`<h2>担当者への引継ぎ</h2>` **あり**（受付番号 TKT-2026-0003 / INC-1009 / 共有情報 / 引継ぎメモ）。他の節: 概要・相談内容・対応の経過・PC基本情報・AIの一次対応・担当者の対応・解決記録・ナレッジ化 | **PASS** |
| F-03 | 報告書 PDF | `GET …/pdf` → **200**、`application/pdf`、511,835 bytes、9 ページ（A4）。`pdftotext -enc UTF-8` で日本語が正しく抽出（`�` 0 件）、`IPAGothic` 埋め込み（pdffonts で emb=yes）。表題「最終報告書 CASE-0002 - 担当者の対応で解決」 | **PASS** |
| F-04 | 内容（PII マスク・時系列・実行記録） | PII: 本文・解決手順に入れた `k.verif@example.com` / `03-1234-5678` / `10.20.30.40` は HTML・PDF とも **0 出現**、`[メールアドレス]` 13 / `[IPアドレス]` 7 / `[電話番号]` 6 に置換。時系列: 「対応の経過」18 行（09:22 相談送信 → AI 診断 → 共有同意 → 担当者へ引継ぎ → …）。実行記録: 端末セッションが無い案件のため「RSP実行セッション」節は生成されない（設計どおり） | **PASS**（実行記録は未実施） |
| F-05 | AI解決は STEP5 で作成不可 | 同じ payload で `kind=ai_resolved, case.step=5` → **400 VALIDATION_ERROR**「AI解決の報告書は STEP 7 で作成してください。」／`step=7` → **200** | **PASS** |
| F-06 | 担当者解決は STEP5〜7 で作成可 | `kind=helpdesk_resolved` で `step=4` → **400**「担当者解決の報告書は STEP 5〜7 で作成してください。」／`step=5` **200**・`step=6` **200**・`step=7` **200**。UI でも STEP6（承認申請後）と STEP7 の両方に「📄 最終報告書」が出た | **PASS** |
| F-07 | 報告書 URL の権限 | 作成者（:18962）: html **200** / pdf **200**。別ユーザー（:18958）: html **404** / pdf **404**、存在しない UUID も **404**（区別不能＝列挙不可）。非 UUID は 400。RSP 統合ヘッダ（service-key + `x-operator-email` 別人）でも **404**（`user_email` 一致のみ） | **PASS**（実効拒否。403 ではなく 404 で秘匿） |
| F-08 | 監査（作成者・時刻・案件ID） | 報告書 HTML 内には 出力者（部署/氏名・社員番号）・出力日時・案件番号・報告書ID・SHA-256 がある。一方 **`audit_log` は 0 行**（報告書作成の前後で増えない）。`GET /api/audit` は 401。サーバ側に「誰がいつどの案件の報告書を出したか」の監査が残らない | **FAIL（Medium）** |
| F-09 | 報告書→ナレッジ下書きリンク | 「ナレッジ化」節に `DR-004` / `approved` / `KB-111` / 版 1.0 / 承認者 *** を表示。ただし HTML 全体の `<a>` 要素は **0 個**で、下書き・ナレッジへのリンクは無い（文字列のみ）。報告書は `default-src 'none'` の単体 HTML でアプリへ戻る導線も無い | **FAIL（Medium）** |
| F-10 | 再発行・冪等 | 同一 payload を 2 回 POST → 別 ID `07c87b4a…` / `5cd8cdb3…` が **2 行**（sha256 は同一 `cff61118…`）。`final_reports` の一意制約は PK のみで (user_email, sha256) の一意索引なし。UI の再出力でも同内容が `0e8e935b…` で 2 行（c787998f…, b6e97790…） | **FAIL（Medium）** |

## 新規の指摘

### F-12【High】承認チェックリスト未確認でもサーバー承認が先に成立し、案件が完了不能になる
- 実測（CASE-0002 / 09:24、CASE-0001 / 09:20 も同順序）:
  - 06承認者の確認で「承認してDB保存・本棚に反映」を押した時点でクライアント検証（チェックリスト 4 件）が成立していないと、**サーバーだけが先に承認される**。
    - サーバー: `POST /api/case-handovers/{id}/approve` → **200**、`case_handovers.status=completed`・`approved_by`/`approved_at` 記録・`self_approved=true`
    - 画面: ローカル承認は実行されず DR は `review` のまま・KB を作らない（toast は「チェックリストをすべて確認してください」）
  - その後、チェックリストを ON にして押し直すと **409 NOT_CLAIMED**「引き受けていない案件は承認できません」（`apps/api/src/routes/case-handovers.ts:494-500` は `claimed|resolved` のみ許可、既に `completed` のため）
  - 結果: **ナレッジが作られず STEP7 完了に到達できない**（依頼者にも結果が戻らない）。再現: 同名サーバーログの approve 2 連（req-35/req-36 ほか）
- 原因: `apps/api/src/prototype/assist-bridge.js:1740-1770` のラッパが、クライアント側の検証（`Mirai_AIHelpDesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html:2320` の `approve(id)`＝チェックリスト必須）より**先に**サーバー承認を実行し、成功後にのみローカル承認を呼ぶ。ローカルが失敗してもサーバー状態は巻き戻さない。
- 影響: 誤操作 1 回で案件が「承認済み・未完了」の詰み状態になる。復旧は `PATCH /api/case-handovers/{id}` で `resolved` に戻す運用手順が必要（本検証でも回避策として実施。一般ユーザーには不可）。
- 修正方針（Phase 6）: サーバー呼び出しの前にクライアント検証を完了させる／サーバー承認とローカル承認を同一トランザクション相当にし、失敗時に補償（`PATCH resolved`）する。

### F-13【Medium】依頼者側の案件に完了・解決が反映されない（F-01）
- DX が解決記録・承認・完了しても、依頼者（:18958）の CASE-0002 は STEP4「引継ぎ待ち」・ボード「完了 0」のまま。再読込しても変わらない。
- 原因: 案件はユーザー単位のクライアント状態（`prototype_states`）にあり、`case_handovers.status` を依頼者側で取得していない（`GET /api/case-handovers/:id` は存在するが画面が使わない）。
- 影響: 「結果はここに戻ってきます」という画面説明と実装が一致しない。E 領域の F-06 と同じ構造（サーバーとクライアント状態の二重管理）。

### F-14【Medium】報告書の見出しが常に「STEP 5 完了」（STEP 整合）
- STEP7 で完了した担当者解決の報告書でも、表紙バッジは **「STEP 5 完了」**（HTML 1 箇所・PDF も同文）。
- 原因: `apps/api/src/domain/final-report.ts:844` が `kind` だけで「STEP 3 完了 / STEP 5 完了」を固定表示し、`case.step` を見ていない。
- 影響: 計画 §9「報告書は STEP 整合」に反する。監査・説明資料として誤読を招く。

### F-15【Medium】報告書作成が監査ログに残らない（F-08）
- `POST /api/reports/final` は `final_reports` にしか書かず、`audit_log` への記録が無い（`apps/api/src/routes/reports.ts:86-125`）。`audit_log` は 1 操作を通して **0 行**。
- 影響: 誰がいつどの案件の報告書を出したかをサーバー側で検証できない（報告書 HTML の自己申告のみ）。計画 §9「監査欠落 0」に抵触。

### F-16【Medium】報告書からナレッジ下書きへ辿れない（F-09）
- `renderKnowledge`（`apps/api/src/domain/final-report.ts:611-618`）は ID・状態・版・承認者を表で出すだけでリンクを持たない。
- 影響: 「報告書→ナレッジ下書き」の追跡ができず、G-01 の突合も人手になる。

### F-17【Low・仕様差】閲覧権限の拒否が 403 ではなく 404
- 計画は「本人/DX 以外は 403」。実装は `WHERE id AND user_email` で 0 件 → **404 NOT_FOUND**（`apps/api/src/routes/reports.ts:31-39,118-135`）。
- 実効的な拒否は成立し、存在有無も区別できないため情報漏えいは無い。期待値の側を 404 に合わせるのが妥当（G4 で判断）。
- 併せて: GET の preHandler は `authenticateTerminal`（RSP 統合ヘッダ許容）。実測では RSP 経路でも他人の報告書は 404 で読めなかったが、`user_email` 判定だけが境界である点は設計メモとして残す。

### 既知指摘の再確認（B/D/E 領域・本 Phase の新規ではない）
- **F-04（High・既知）**: `case_handovers.snapshot` にメール・電話・IP が平文保存（CASE-0001/0002 とも `t`）。報告書側はマスクされるが保存データは平文のまま（`docs/evidence/verify-20261027/step1-3/B8-B14-results.md`）。
- **F-06（Medium・既知）**: サーバーの `knowledge` / `knowledge_reviews` は **0 行**。KB-111 はクライアント状態のみで、サーバー側ナレッジ・承認の永続化は無い（E 領域 E-10 と同根）。

## E2E 到達点

| ラン | ルート | 到達 | 備考 |
|---|---|---|---|
| 1 | 担当者解決（STEP1→7） | **STEP7 到達**（CASE-0002） | 報告書 HTML/PDF 200・KB-111 承認 |
| 2 | 担当者解決（STEP1→7） | STEP6 で停止（CASE-0001） | F-12 の誤操作で完了不能（再現用に保持） |
| — | AI解決（STEP3→7） | **API のみ**（`kind=ai_resolved, step=7` で 200） | UI の AI解決ランは未実施（時間の制約） |

## 未実施と理由
- **F-04「実行記録」**: RSP 実行セッション（terminal）を含む案件を作っていないため。`renderTerminal` 節は端末記録がある場合のみ生成される設計。
- **F-05 の UI 側**: AI解決ランの STEP7 出力は API で確認（画面はコード経路と F-06 の実測で代替）。
- **別担当者による承認（職務分離）**: local モードでは :18958/:18962 のどちらも同一 Access 主体（canonical email）に正規化され、claim 者と承認者が同一になる。E-03 と同じ理由で **BLOCKED（環境制約）**。`self_approved=true` はこの環境要因で、画面にも警告が出る（仕様どおり）。
- **F-07 の 403 期待**: 実装が 404 のため「403 であること」は未確認（拒否自体は確認）。

## 証跡
- `docs/evidence/verify-20261027/report/F-results.md`（本ファイル）
- `raw/api-step-matrix.txt`（STEP 別 200/400 マトリクス）
- `raw/report-http-headers.txt`（HTML/PDF のレスポンスヘッダ）
- `raw/report-content-checks.txt`（PII 出現数・文字化け・フォント・節・バナー・アンカー数）
- `raw/db-crosscheck.txt`（final_reports / audit_log / case_handovers / knowledge の突合）
- `raw/ui-flow.txt`（画面操作の時系列・toast・件数）
- 報告書の実体は `/tmp/f-report7.html`・`/tmp/f-report7.pdf`（PII を含むため **/tmp 保管・非コミット**）
