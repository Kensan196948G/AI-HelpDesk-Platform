# RSP実行セッション UI — 実ブラウザ検証（2026-10-26）

対象: `apps/api/src/prototype/handover-workspace-bridge.js`（右ペイン「RSP実行セッション」）
契約: [docs/35-terminal-session.md](../../35-terminal-session.md) §4 / §6

## 検証環境

| 項目 | 値 |
|---|---|
| URL | http://127.0.0.1:18955/（Lead が起動した隔離 local モード検証サーバ。env=test） |
| 認証 | local モード（`DEV_AUTH_EMAIL` 固定。Access ヘッダー不要） |
| AI | ローカルのモック DeepSeek（127.0.0.1:18956）。実APIキーは未使用 |
| ブラウザ | Playwright（Firefox）/ ビューポート 1600×1000 |
| 案件 | `CASE-UI-TERM-3`（引継ぎ claim 済み・セッション未作成） |

フィクスチャの補足:
- 引継ぎ `CASE-UI-TERM-3` と cowork 状態は Lead の `/tmp/aihd-ui-fixture.py` で作成。
- そのヘルプデスク状態にはチケットが無く、ヘルプデスク UI が `seed()` にフォールバックしたため、
  検証開始時に **デモ状態へ `INC-1008`（coworkTicket=`TKT-CASE-UI-TERM-3`）を1件追加**して
  `/api/state/helpdesk` に PUT した。引継ぎ・セッション・報告書・ナレッジは実 API / 実 DB。

## 手順と結果

| # | 操作 | 結果 |
|---|---|---|
| 1 | `localStorage` を消して再読み込み →「操作する人」を「ヘルプデスク担当 / 佐藤 奨太」に変更 | 左ナビに「引継ぎ」が出る。3ペインが表示される |
| 2 | 左ボードの `INC-1008` を選択 | `GET /api/terminal/sessions?caseId=CASE-UI-TERM-3` = 200。同意フォーム表示 |
| 3 | 「画面共有」「操作支援」を順にチェック | 開始ボタンが disabled → enabled に変化 |
| 4 | 「セッションを開始」 | `POST /api/terminal/sessions` = 200。実行中・残り時間 29:xx・対象端末・実行者・同意を表示 |
| 5 | 目的を入力し「AIに次の一手を提案」 | `POST .../sessions/:id/steps` = 200。`Get-Service Spooler \| Select-Object Status,Name`、目的・確認・戻し・risk 低・警告を表示。記録フォームが提案コマンドを初期値に開く |
| 6 | 「コピー」 | コマンド文字列がクリップボード API に渡り、`コマンドをコピーしました。` のトーストを確認（ヘッドレス Firefox は権限が無いため `navigator.clipboard.writeText` をスタブして検証） |
| 7 | 実行コマンドを編集＋出力＋判定「成功」＋補足を入力し「記録を保存」 | `POST /api/terminal/steps/:id/record` = 200。記録済み・成功・sha256（先頭12桁）・手動貼付を表示。記録フォームは消え、再送不可 |
| 8 | 2件目も同様に提案→記録（2/20） | 200。1ステップ目の出力が `lastOutput` として送信される |
| 9 | 終了理由の補足を入力し「解決として終了」 | `POST .../close` = 200。状態「解決」、終了日時・理由を表示。「報告書を作成」「ナレッジ下書きを作成」が有効 |
| 10 | 「報告書を作成」 | `POST .../report` = 200。`files.html.url` を新規タブで開く。sha256 表示、作成ボタンは「報告書作成済み」で無効化、`報告書を開く` を追加 |
| 11 | 「ナレッジ下書きを作成」 | `POST .../knowledge-draft` = 200。`ナレッジ下書き`＋`承認待ち（下書き）`＋`kbNo: KB-2026-10350` を表示。ボタンは「下書き作成済み」 |
| 12 | 再読み込み → ペルソナ維持 → 引継ぎを開き直し `INC-1008` を選択 | 終了済みセッション・2ステップ・報告書 sha256・「報告書を開く」・ナレッジ作成済みが復元 |

API 応答でも確認（GET `/api/terminal/sessions?caseId=CASE-UI-TERM-3`）:
`status=closed` / `closeReason=resolved` / `consent={screenShare:true,remoteControl:true}` /
`stepCount=2` / `report.id`・`report.sha256=b5235277…` / `knowledgeId=7d59f427…` /
`capture={supported:false, reason:"RSPのターミナルログAPIが未提供のため、手動貼り付けを使用します。"}`

## 契約・要件の確認

- 自動取込 `supported:false` のとき、**「自動取込は利用できません（RSPのターミナルログAPI未提供）。出力は手動で貼り付けてください。」** を表示（API の reason も併記）。
- 記録の `outputSource` は `manual` 固定。
- 記録済みステップはフォームを出さず再送不可。
- 送信中はボタンを disabled（`tcApply` の busy フラグ）。エラーはカード内メッセージ＋`hwToast`。
- 報告書はサーバ保存済みの `files.html.url` のみを開き、`/api/reports/final` へ再送しない。
- 既存 3ペイン（引継ぎボード・案件・案件情報）は維持。白画面なし。

## 証跡

| ファイル | 内容 |
|---|---|
| `01-workspace-no-handover.png` | 3ペイン表示。引継ぎの無い案件では 404 メッセージ |
| `02-consent-form.png` | `INC-1008` 選択時の同意フォーム |
| `03-consent-checked.png` | 両同意チェック後（開始ボタン有効） |
| `04-session-active.png` | 実行中・残り時間・自動取込不可の案内 |
| `05-ai-proposal.png` | AI提案（コマンド・目的・risk・確認・戻し・警告）と記録フォーム |
| `06-record-form.png` | 実行コマンド編集・出力・判定・補足の入力 |
| `07-recorded.png` | 記録済み（成功・sha256・出力・補足） |
| `08-before-close.png` | 2ステップ記録後、終了理由の入力 |
| `09-closed.png` | 終了後（報告書作成・ナレッジ下書き作成） |
| `10-report-html.png` / `10-report.html` | 作成された最終報告書 HTML（RSP実行セッション節を含む） |
| `11-report-knowledge.png` | 報告書作成済み＋ナレッジ下書き（kbNo・承認待ち） |
| `12-restored-after-reload.png` | 再読み込み後の復元 |

## 未検証・既知の事象

1. **報告書 HTML はダウンロードになる**（→ Lead が同日修正、下記「追補」参照）。
   初回検証時は既存 `GET /api/reports/final/:id/html` が `Content-Disposition: attachment` を
   返すため、新規タブは `about:blank` のままダウンロードされた。修正後は
   `?inline=1`（`files.html.previewUrl`）でブラウザ内表示になる。
2. **中止（stopped）** はボタン表示のみ確認。セッションは1案件1つ（終了後は新規開始 UI を出さない）
   ため、実操作は「解決として終了」で確認した。API は同じ close エンドポイント。
3. **二重送信の連打試験**は未実施。busy フラグとボタン disabled、記録後フォーム消去で構造的に防止。
4. **再読み込み後の kbNo**（→ Lead が同日修正、下記「追補」参照）。初回検証時は
   セッション DTO が `knowledgeId` のみだったため再読み込み後は ID 表示だった。修正後は
   `session.knowledge.kbNo` で復元する。
5. コンソールに既存の `paneHtml` TypeError（プロトタイプ本体、スタックにブリッジ無し）と
   favicon CSP エラーが出る。RSP実行セッション由来の pageerror は無し。
   ネットワークは `/api/resolve/admin/pending` 403（既存画面の権限どおり）、
   引継ぎの無い案件の terminal GET 404（想定内）のみ。5xx なし。
6. ヘッドレス Firefox では Clipboard API の許可が無いため、コピーは `writeText` をスタブして
   「渡された文字列」とトーストを確認した。実ブラウザでの実コピーは未確認。

## 追補 — Lead による修正と再検証（2026-10-26 15:26 JST）

初回検証で見つかった 2 点を修正し、同じ隔離サーバ（18955）で再確認した。

| # | 修正 | 検証 |
|---|---|---|
| A | 報告書のブラウザ内表示: `GET /api/reports/final/:id/html?inline=1` を追加（`Content-Disposition: inline`）。`POST /api/terminal/sessions/:id/report` が `files.html.previewUrl` を返し、UI はそれを新規タブで開く（`/api/reports/final` へ再送しない） | `?inline=1` = `inline; filename=...` / 従来 URL = `attachment; ...`。ブラウザで報告書タイトルが表示され、`報告書を開く` が `?inline=1` を開くことを実測（`13-report-inline.png`） |
| B | 再読み込み後の kbNo: セッション DTO に `knowledge: {id, kbNo, status, title}` を追加（`knowledge_id` から引く） | 再読み込み後の右ペインに `kbNo: KB-2026-10350` / `承認待ち（下書き）` / `報告書作成済み` を実測（`14-restored-kbno.png`） |

追加検証: `npm run typecheck` 成功、`npx vitest run apps/api/src/terminal apps/api/src/routes/terminal.integration.test.ts` 12 tests 成功
（inline/attachment ヘッダー、session.knowledge.kbNo、二重作成なしを含む）。

証跡: `13-report-inline.png`（inline 表示の報告書）/ `14-restored-kbno.png`（再読み込み後の kbNo 復元）
