# 最終報告書のエクスポート（Standalone HTML / PDF）

| 項目 | 値 |
|---|---|
| 版 | v0.1 |
| 日付 | 2026-10-23 |
| 対象 | `POST /api/reports/final` / `GET /api/reports/final/:id/html` / `GET /api/reports/final/:id/pdf` |
| 画面 | STEP 3（AIで解決）・STEP 5（担当者対応で解決）の完了時 |

## 1. 目的

「新しい相談」の STEP 1〜7 のうち、次の **2 つの完了経路**で、同じ形式の詳細な最終報告書を出力できるようにする。

1. **STEP 3 で AI の一次対応により解決**（担当者への引継ぎなし）
2. **STEP 5 で担当者の対応により解決**（引継ぎ・解決記録・ナレッジ化を含む）

出力は次の 2 形式。

- **Standalone HTML**: 外部 CSS / JS / 画像を参照しない 1 ファイル。保存してそのまま開ける。
- **PDF**: サーバー側のヘッドレス Chrome で A4 に印刷した PDF。日本語フォントは OS のものを使う。

## 2. 画面

STEP 3 で「解決した」を押した後、または STEP 5 で解決記録が登録された後、ウィザードのペイン下部に「📄 最終報告書」カードが出る。

- `Standalone HTML` / `PDF` の 2 ボタン。
- 出力後は、前回の出力日時・形式・SHA-256 の先頭 16 文字を表示する。
- HTML と PDF はそれぞれ別のスナップショットとして保存する（出力日時が異なる）。
- 出力は「相談した本人」または「ヘルプデスク担当（DX推進部）」のみ。

実装は `apps/api/src/prototype/assist-bridge.js`。既存プロトタイプ HTML は変更せず、ブリッジだけを追加している（[14-prototype-ui-integration.md](14-prototype-ui-integration.md) §2-7）。

## 3. 報告書の内容

| 章 | 内容 |
|---|---|
| 表紙 | 完了経路（AI解決 / 担当者解決）、案件番号、STEP、件名 |
| 概要 | 相談者・所属・相談日時・種類・急ぎ具合・対応結果・AIモデル・出力者・受付番号・ヘルプデスク番号・担当・ナレッジ |
| 相談内容 | 件名・本文（伏せ字化） |
| 対応の経過 | 相談送信、AI診断、ナレッジ提示、引継ぎ、担当開始、解決、ナレッジ承認、遠隔支援の依頼・承認・案内 |
| PC基本情報 | 共有された範囲の全項目と「気になる点」。IP・シリアル・資産番号は必ず伏せる |
| AIの一次対応 | やり取り、診断結果、修復の提案・実行結果、根拠にした承認済みナレッジ |
| 担当者への引継ぎ | 理由、受付番号、共有した情報、AIがまとめた引継ぎメモ |
| 担当者の対応・解決記録 | 原因、対応手順、所要時間、担当、備考 |
| ナレッジ化 | 下書きID、状態、承認されたナレッジID・版・承認者 |
| 遠隔支援 | 同意した範囲、依頼・承認・終了、本人へ送った案内と実施結果 |
| フッター | 報告書ID、SHA-256、出力日時、形式、生成上の注意 |

## 4. API

### 4-1. 作成

```http
POST /api/reports/final
Content-Type: application/json
```

```jsonc
{
  "report": {
    "kind": "ai_resolved" | "helpdesk_resolved",
    "generatedAt": "2026-10-23T14:25:20.624Z",
    "generatedBy": { "name": "...", "role": "...", "dept": "..." },
    "requester": { "name": "...", "dept": "...", "employeeNo": "..." },
    "case": { "id": "CASE-0001", "created": "...", "kindLabel": "...", "subject": "...", "body": "...", "urgency": "通常" },
    "pc": { "available": true, "device": "...", "collectedAt": "...", "itemCount": 35, "flags": [], "items": [] },
    "ai": { "messages": [], "diagnoses": [], "proposals": [], "sources": [] },
    "handover": { "reason": "...", "ticketId": "TKT-2026-0002", "incId": "INC-1008", "shared": [], "memo": "..." },
    "resolution": { "cause": "...", "steps": [], "minutes": 25, "by": "..." },
    "knowledge": { "draftId": "DR-003", "status": "approved", "kbId": "KB-...", "version": "1.1", "approvedBy": "..." },
    "remote": { "status": "approved", "prompts": [] },
    "timeline": []
  }
}
```

レスポンス:

```json
{
  "ok": true,
  "report": {
    "id": "uuid",
    "sha256": "64-hex",
    "kind": "helpdesk_resolved",
    "caseId": "CASE-0001",
    "createdAt": "2026-10-23T14:25:20.000Z",
    "files": {
      "html": { "url": "/api/reports/final/<id>/html", "filename": "AIHelpDesk-CASE-0001-HD-20261023.html" },
      "pdf":  { "url": "/api/reports/final/<id>/pdf",  "filename": "AIHelpDesk-CASE-0001-HD-20261023.pdf" }
    }
  }
}
```

- 入力は `apps/api/src/domain/final-report.ts` の zod スキーマで検証する（`FinalReportSchema`）。
- **すべての文字列フィールド**を、保存前に `redactPII` で伏せ字化する（自由記述だけでなく、role / dept / device / approvedBy なども対象）。
- PC情報の `IPアドレス` / `シリアル番号` / `資産番号` は、項目名で判定して必ず伏せる。
- 画面上で手編集した案内文も、保存前に `dlpMask` で伏せ字化する。
- 保存する `payload`・SHA-256・HTML は、すべて **伏せ字化後**の同じ内容から作る。
- レート制限: 作成 10 回/分/利用者、PDF 10 回/分/利用者。
- 保存量の上限: 1 利用者あたり **24 時間で 50 件**（超過は 429 `REPORT_QUOTA`）。最大 512KiB × 50 = 約 25MiB。

### 4-2. 取得

- `GET /api/reports/final/:id/html` … `text/html; charset=utf-8`、`Content-Disposition: attachment`。
- `GET /api/reports/final/:id/pdf` … `application/pdf`、`Content-Disposition: attachment`。
- **作成した利用者（Access メール）だけ**が取得できる。`user_email` が一致しない場合は 404（存在自体を隠す）。
- HTML は `CSP: default-src 'none'; style-src 'unsafe-inline'` で返す。スクリプトは含まない。

## 5. DB

`db/migrations/006_final_reports.sql`。

| 列 | 型 | 内容 |
|---|---|---|
| `id` | uuid | 報告書ID |
| `user_email` | text | 作成者（Access 正規化後のメール） |
| `case_id` | text | 案件番号 |
| `kind` | text | `ai_resolved` / `helpdesk_resolved` |
| `payload` | jsonb | 伏せ字化後の構造化データ |
| `html` | text | Standalone HTML |
| `html_filename` | text | ダウンロード名の基底 |
| `sha256` | text | `payload` の SHA-256 |
| `created_at` | timestamptz | 作成日時 |

PDF は保存せず、取得時に保存済み HTML から生成する（ストレージを増やさない）。

## 6. PDF 生成

- `renderFinalReportPdf(html)` が `mkdtemp` で一時ディレクトリを作り、`report.html` を 0600 で書く。
- ヘッドレス Chrome を `execFile` で起動する（シェルを介さない）。
  - `--headless --no-sandbox --disable-gpu --disable-dev-shm-usage`
  - `--user-data-dir=<temp>/profile`
  - `--no-pdf-header-footer --print-to-pdf-no-header --virtual-time-budget=3000`
  - `--print-to-pdf=<temp>/report.pdf <file://...>`
- PDF のマジック（`%PDF`）と 1,000 バイト以上を検証する。
- 一時ディレクトリは `finally` で必ず削除する。
- バイナリは `REPORT_PDF_BIN` → `google-chrome` → `google-chrome-stable` → `chromium` → `chromium-browser` → `microsoft-edge` の順で自動検出する。
- 見つからない場合は **503 `PDF_UNAVAILABLE`**。HTML は常に出力できる。
- 生成に失敗した場合は **502 `PDF_FAILED`**。混雑時は **503 `PDF_BUSY`**。
- タイムアウトは `REPORT_PDF_TIMEOUT_MS`（既定 30,000ms）。
- **同時実行は 1 本**（待ち行列 10 件まで）。CPU / メモリの急増を防ぐ。
- PDF は 10MiB を上限とし、`stat` でサイズを確認してから読み込む。
- `--disable-extensions --disable-background-networking --host-resolver-rules=MAP * ~NOTFOUND` で外部通信を抑止する。
- UI は PDF が 503 のとき、同じ報告書の HTML を自動でダウンロードする（「PDF を生成できないため HTML を出力しました」）。

### 6-1. 前提と制約

- サーバーに日本語フォント（この環境では IPAゴシック）と Chrome が必要。
- `--no-sandbox` は検証環境の制約。**外部リソースを参照しない・スクリプトを含まない** HTML だけを変換するため、任意の Web ページを開かせる用途には使わない。
- Standalone HTML 自体にも CSP メタタグ（`default-src 'none'; style-src 'unsafe-inline'`）を入れる。
- PDF はサーバー側で生成するため、利用者のブラウザ設定（印刷ダイアログ）に依存しない。

## 7. セキュリティ

| 統制 | 内容 |
|---|---|
| HTMLエスケープ | すべての自由記述を `escapeHtml` する。`<script>` や `<img onerror>` は文字列として表示される |
| PII 伏せ字 | 保存・出力の前に、**すべての文字列**へ `redactPII`。PCのIP・シリアル・資産番号は項目名で強制マスク。手編集の案内文は `dlpMask` |
| アクセス制御 | 作成者のみ取得可。他人の報告書は 404 |
| 入力検証 | zod。本文 12,000 文字、メッセージ 200 件、タイムライン 300 件などの上限。日時・STEP と完了経路・遠隔支援の状態整合も `superRefine` で検証 |
| ボディ上限 | 512KiB |
| レート制限 | 作成 10 回/分、PDF 10 回/分。24 時間 50 件/利用者の上限 |
| 監査 | 画面側で `report_exported`（案件・形式・報告書ID・SHA-256）を監査チェーンに追加 |
| 一時ファイル | 0600 / 0700、処理後に削除 |
| CSP | HTML は `default-src 'none'` のメタタグ + レスポンスヘッダ。PDF 変換時も外部参照なし |
| PDF 資源 | 同時実行 1 本・待ち行列 10 件・サイズ 10MiB 上限 |

### 7-1. 明示的な限界（MVP）

- 報告書の内容は **画面（クライアント）の状態**から組み立てている。サーバー側の案件台帳と突合していない。
  - そのため、SHA-256 は「出力内容の同一性」を示すが、「サーバーが承認した事実」を示す電子署名ではない。
  - 正式な監査証跡にする場合は、案件・引継ぎ・解決記録をサーバー側の正本に移し、報告書をサーバーで組み立てる必要がある。
- 報告書の保存期間・削除方針は未定。`final_reports` の保持期間を運用で決める（当面は 24 時間 50 件の作成上限で増加を抑える）。
- PDF のヘッダー/フッターは無効化している。ページ番号が必要な場合は Chrome のオプションを見直す。
- 添付ファイルの実体は含まない（名前のみ）。

## 8. 検証（2026-10-23）

- 単体: `final-report.test.ts` 11 件（スキーマ、伏せ字、XSS、ファイル名、日時・STEP・遠隔状態の整合、PDF マジック）。
- API: `reports.integration.test.ts` 4 件（作成・HTML取得・PDF取得・他人404（HTML/PDF）・不正400）。
- 遠隔支援: `remote-prompt.test.ts` 10 件（候補アクション、危険出力の拒否、PII 伏せ字）。
- 全テスト: **175 passed**（31 files）。
- 実 UI（ヘッドレス Chromium・専用 API/テストDB）:
  - STEP 3「解決した」→ STEP 7 で `Standalone HTML` / `PDF` をダウンロード。
  - STEP 5 で担当者が解決 → STEP 6 で同様にダウンロード。
  - PDF を `pdftotext` で確認し、日本語・案件番号・解決原因・遠隔支援の案内が入っていることを確認。
- 証跡: [docs/evidence/final-report/20261023](evidence/final-report/20261023/)。

例:

```
$ file AIHelpDesk-CASE-0002-HD-20261023.pdf
PDF document, version 1.4, 8 page(s)
$ pdftotext AIHelpDesk-CASE-0002-HD-20261023.pdf - | grep -E '担当者の対応で解決|異動後の所属グループ'
担当者の対応で解決
異動後の所属グループが共有フォルダの閲覧グループに未追加だったため。
```

## 9. 運用手順（利用者）

1. STEP 3 で解決した場合: 「解決した」→ STEP 7（または STEP 3）の「最終報告書」。
2. STEP 5 で解決した場合: 担当者が解決記録を登録 → STEP 6 の「最終報告書」。
3. まず `Standalone HTML` を保存し、必要なら `PDF` も保存する。
4. 報告書には個人情報が伏せ字で入る。共有先は案件の関係者に限定する。

## 10. 今後の拡張

- サーバー側の案件正本からの報告書生成（クライアント改ざん耐性）。
- 電子署名 / タイムスタンプ（長期保存する場合）。
- ページ番号・機密区分（社外秘）の印刷オプション。
- 報告書の保持期間・自動削除・監査SIEMへの転送。
- 添付ファイル名の一覧と、必要に応じたハッシュのみの記録。
