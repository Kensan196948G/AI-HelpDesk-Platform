# API 仕様（MVP）

- Base URL（local）: `http://127.0.0.1:18950/api`
- 形式: JSON。認証は HttpOnly Cookie `aihd_session`。
- エラー: `{ "error": { "code": "...", "message": "...", "details": ... } }`
- 認可は**サーバ側**で実施。UI の非表示だけに依存しない。

## 1. 認証・共通

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| POST | `/auth/login` | なし | メール＋パスワード。成功でセッション Cookie。試行は 10 回 / 15 分で制限 |
| POST | `/auth/logout` | 認証済み | セッション削除＋Cookie 削除 |
| GET | `/auth/me` | 認証済み | 現在のユーザー |
| GET | `/health` | なし | DB 接続確認。`{ok, service, version, commit, db, time, env}` |
| GET | `/dashboard` | 認証済み | ロール別の件数・信号内訳・最近の案件・自分の番 |

## 2. 案件（相談）

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| POST | `/cases` | 認証済み | 相談作成＋PC デモ取得＋AI 一次対応を1トランザクションで実行 |
| GET | `/cases` | 認証済み | 一覧。相談者は自分の案件のみ。`status` / `signal` / `limit` |
| GET | `/cases/:id` | 認証済み | 詳細。相談者は自分のみ。PC 情報は本人 or 共有済みの担当者のみ |
| POST | `/cases/:id/resolve` | 相談者（本人） | 「解決した」。赤信号・セキュリティは 409 |
| POST | `/cases/:id/handoff` | 相談者（本人） | 引継ぎ同意。TKT/INC 発行、step 5、黄信号 |
| POST | `/cases/:id/knowledge-draft` | ヘルプデスク | 解決記録から伏せ字済み下書きを作成（冪等） |

### 2-1. 作成リクエスト例

```json
{
  "category": "file_share",
  "subject": "共有フォルダが開けません",
  "body": "保存時にアクセスが拒否されます。",
  "urgency": "normal",
  "pcEnabled": true
}
```

- `category`: `pc_network` / `account` / `file_share` / `procedure` / `security` / `other`
- `pcEnabled` 省略時は種類ごとの既定（BR-09）。
- 本文・件名は保存前に PII を伏せ字化する。
- レスポンス: `{ case, assessment }`。`assessment` には `intent` / `signal` / `answer` / `steps` / `sources` / `recommendHandoff` / `security` / `pcSummary` を含む。
- AI はルールベース。外部 AI には接続しない。根拠は承認済みナレッジのみ。

### 2-2. 引継ぎリクエスト例

```json
{ "sharedFields": ["consultation", "ai", "device", "pc"] }
```

- `consultation` は必須。`pc` は本人が同意した場合のみ担当者に表示される。
- TKT は案件番号（`TKT-YYYY-NNNN`）、INC は別採番（`INC-YYYY-NNNN`）。

## 3. ヘルプデスク

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/desk/queue` | ヘルプデスク / 承認者 | 引継ぎ待ち・対応中の一覧。赤→黄→青の順 |
| PATCH | `/tickets/:id` | ヘルプデスク | 担当割当（`assigneeId`）・状態（`assigned` / `in_progress`） |
| POST | `/tickets/:id/resolution` | ヘルプデスク | 解決記録（原因・手順・所要時間）。案件は step 6 へ |

- 担当者に指定できるのは `role=helpdesk` の有効ユーザーだけ。
- 解決記録の原因・手順も保存前に伏せ字化。
- 解決記録の登録でチケットは `resolved`、案件は `knowledge_pending` になる。

## 4. ナレッジ

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/knowledge` | 認証済み | 相談者は `approved` のみ。担当者以上は全状態 |
| GET | `/knowledge/:id` | 認証済み | 相談者は `approved` のみ |
| PATCH | `/knowledge/:id` | ヘルプデスク（作成者） | 下書き・差戻しの編集。PII を再伏せ字化 |
| POST | `/knowledge/:id/submit` | ヘルプデスク（作成者） | 下書き / 差戻し → 承認待ち |
| POST | `/knowledge/:id/review` | 承認者 | 承認（4 項目すべて true）/ 差戻し（理由必須） |

- **自分の申請は承認できない**（サーバ側で 400）。
- 承認すると `knowledge.status=approved`、案件は `completed` / step 7、チケットは `closed`。
- 承認済みナレッジは次の相談の AI 根拠として検索される。

## 5. 監査

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/audit` | 承認者 | 直近の監査ログ（`limit` 100 既定） |
| POST | `/audit/verify` | 承認者 | ハッシュチェーン検証。`{ok, checked, brokenAtId?}` |

- 記録は追記のみ。`prev_hash` と SHA-256 の連結で改ざんを検知する。
- 認証・案件作成・AI 評価・引継ぎ・担当変更・解決・ナレッジ申請/承認/差戻しを記録。

## 6. エラーコード

| HTTP | code | 意味 |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `BAD_REQUEST` | 入力不正、職務分離違反など |
| 401 | `UNAUTHORIZED` / `PROXY_REQUIRED` | 未ログイン、セッション切れ、Worker 以外からの直接アクセス |
| 403 | `FORBIDDEN` | ロール・Origin 不正 |
| 404 | `NOT_FOUND` | 対象なし（他人の案件も 404 で存在を隠す） |
| 409 | `CONFLICT` / `DUPLICATE` | 状態遷移不可、二重登録 |
| 429 | `RATE_LIMITED` | ログイン試行過多 |
| 503 | — | `/health` の DB 異常 |

## 6-1. プロトタイプ UI / Access / DeepSeek

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/` / `/index.html` | Access 認証 | 既存プロトタイプ HTML を配信（boot / bridge 注入） |
| GET | `/api/state` | Access 認証 | `{email, cowork, helpdesk}` を取得 |
| GET | `/api/me` | Access 認証 | ログイン本人の社員情報（氏名・所属・社員番号のみ。**メールは返さない**）。60 回/分 |
| GET | `/api/employees?scope=staff\|all` | Access 認証 | 社員名簿（`all`=445 / `staff`=5）。氏名・所属・社員番号のみ。60 回/分 |
| PUT | `/api/state/:name` | Access 認証 | `cowork` / `helpdesk` の状態を保存（最大 4MB） |
| POST | `/api/ai/answer` | Access 認証 | 承認済みナレッジ + PC 情報 + DeepSeek-V4.1-Flash（未設定時フォールバック）。利用者単位 20 回/分（超過 429） |

- `AUTH_MODE=cloudflare-access` では `/api/auth/login` は登録されない（404）。
- Access のヘッダー `Cf-Access-Authenticated-User-Email` を、`docs/MailAddress.txt`（`ACCESS_ALLOWLIST_FILE`）の許可リストと照合する。完全一致メールと `@domain` を許可し、ヘッダーなし 401、許可外 403、許可リストなし・空は全拒否（fail-closed）。
- ローカル開発/テストのみ `AUTH_MODE=local`（`DEV_AUTH_EMAIL`）。

## 6-2. 実PC情報 / 端末エージェント

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| POST | `/api/device/browser` | Access 認証 | ブラウザで取得した実端末情報（OS / 画面 / CPU コア / メモリ推定 / GPU / 回線 / 音声）を保存 |
| GET | `/api/device/inventory` | Access 認証 | `?deviceId=` のブラウザ端末情報（同一端末にリンクされたエージェントのみマージ） |
| POST | `/api/device/agent` | デバイストークン | 端末エージェントのハードウェア・導入ソフト・セキュリティ情報を取り込み |

- `POST /api/device/browser` の応答: `{ok, inventory, snapshot}`。`snapshot` は既存プロトタイプの `pcSnapshot()` と同じ形（`at`, `device`, `items[35]`, `ver`）。
- `POST /api/device/agent` は `X-Device-Token` 必須。トークンは `device_tokens` に SHA-256 ハッシュで保存し、ユーザーに紐づける。IP 単位 30 回/分。
- 在庫は `(user_email, source, device_id)` 単位。`POST /api/device/agent` の `browserDeviceId`（画面の `WEB-XXXXXXXX`）でブラウザ端末へリンクする。未リンクの場合 `linked: false` で保存のみ行い、ブラウザのスナップショットには混ぜない。
- `GET /api/device/inventory` は `?deviceId=<browser UUID>` を指定するとそのブラウザ端末を基準にする。省略時は最新のブラウザ端末。
- `/api/device/agent` だけは Cloudflare Access のパス限定 bypass（アプリ ID `250fa30a-d49c-4a83-b773-8fbdec3c0b6a`）。人間の UI / API は Access 必須。
- `/api/ai/answer` の応答に `device: {source, collectedAt}` を含む。PC コンテキストから IP・シリアル・資産番号・メールは除外する。
- `/api/ai/answer` の根拠は、DB の承認済みナレッジに加え、**本人の helpdesk 画面状態で承認済み（`status: active`）のナレッジ**も対象にする。`sources[].kbNo` は画面の KB 番号（例: `KB-111`）と一致する。使用停止中・形式不正の要素は除外し、他ユーザーの状態は参照しない（`lib/prototype-knowledge.ts`）。

## 6-3. 最終報告書 / 遠隔支援

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| POST | `/api/reports/final` | Access 認証 | 画面の構造化データから Standalone HTML と SHA-256 を生成・保存。10 回/分 |
| GET | `/api/reports/final/:id/html` | Access 認証（作成者のみ） | Standalone HTML（`attachment`。`?inline=1` でブラウザ内表示） |
| GET | `/api/reports/final/:id/pdf` | Access 認証（作成者のみ） | 保存済み HTML をヘッドレス Chrome で PDF 化。10 回/分 |
| POST | `/api/ai/remote-prompt` | Access 認証 | STEP 5 の担当者向け「A さんへの案内文」の下書き。実行はしない。20 回/分 |

- 報告書の入力は `FinalReportSchema`（`apps/api/src/domain/final-report.ts`）で検証する。自由記述・PC 情報は保存前に伏せ字化する。
- 報告書は作成者の `user_email` に紐づけ、他人の ID は 404 にする。
- PDF 生成のヘッドレスブラウザが見つからない場合は 503 `PDF_UNAVAILABLE`（HTML は利用可能）。
- `/api/ai/remote-prompt` は文章だけを返す。端末操作は既存の `/api/device/command`（許可リスト + Y/N + 管理者承認）のみ。
- 報告書のエラー: 429 `RATE_LIMITED` / `REPORT_QUOTA`、502 `PDF_FAILED`、503 `PDF_UNAVAILABLE` / `PDF_BUSY`。
- 詳細: [21-final-report-export.md](21-final-report-export.md) / [22-remote-assist-handover.md](22-remote-assist-handover.md)。

## 6-4. 解決ループ / Skills（Phase B / 2026-10-25 追加）

設計: [25-skill-resolution-loop.md](25-skill-resolution-loop.md)。すべて Access 認証済み（`authenticateUi`）。
AI は Skill ID とパラメータだけを提案し、コマンド文字列は生成しない。

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/api/resolve/skills` | Access 認証 | 承認済み Skill の一覧（読み取り専用の 5 件） |
| POST | `/api/resolve/sessions` | 本人 | `{caseId, deviceId}` でセッション開始＋初回提案。`step.approvalChallenge` を返す |
| POST | `/api/resolve/steps/:id/approve` | 本人 | `{decision:'Y'|'N', approvalHash}`。Y は承認ハッシュ検証後 `device_commands` に登録 |
| GET | `/api/resolve/steps/:id` | 本人 | 実行状態。`done` / `failed` を検知してセッションを更新 |
| POST | `/api/resolve/steps/:id/continue` | 本人 | 結果後の Y/N。Y は次の提案、N は停止 |
| POST | `/api/resolve/sessions/:id/stop` | 本人 | 中止 |
| GET | `/api/resolve/sessions/:id` | 本人 | セッションとステップ概要 |

- 承認ハッシュ: `stableStringify(payload)` → SHA-256（hex）。`payload` は `sessionId, stepId, seq, skillId,
  skillVersion, skillContentHash, params, deviceId, userEmail, riskLevel, nonce, expiresAt` の 12 キー。
- Skill は `scripts/skills/approved.json`（人間レビュー済みの定義ハッシュ）と一致するものだけが approved。
  deviceId は本人の `device_inventories` と照合し、デバイストークンは `x-device-id` にバインドする。
- 停止・期限切れ時は未実行 step を cancelled、queued コマンドを expired にし、停止後の結果では状態を進めない。
  estop 中はセッション開始・承認を 409 `ESTOP_ACTIVE` で拒否する。
- 実行は `device_commands`（`skill_id` / `session_id` / `step_id` 付き）に登録し、端末エージェントが
  `GET /api/device/command` で取得して実行する。Phase B は読み取り専用 Skill のみ。
- エラー: `APPROVAL_MISMATCH` / `APPROVAL_EXPIRED` / `SESSION_EXPIRED` / `STEP_NOT_APPROVABLE` /
  `STEP_NOT_CONTINUABLE` / `STEP_LIMIT` / `SKILL_NOT_ALLOWED` / `PARAM_INVALID` / `NO_SKILL` / `RATE_LIMITED`。
- 上限: 最大 6 ステップ・30 分・同一 Skill+params の再実行禁止。失敗は安全側で `escalated`。

## 6-5. RSP実行セッション（2026-10-26 追加）

設計: [35-terminal-session.md](35-terminal-session.md)。すべて Access 認証（`authenticateUi`）。
AI は 1 コマンドを「提案」するだけで、**サーバは実行しない**。担当者が RSP のターミナルで実行し、
実行したコマンドと出力を記録する（提案と実行は別物）。

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/api/terminal/context?caseId=` | 参照可 | 案件・依頼者・引継ぎ・PC情報（IP/シリアル/資産番号はマスク）・最新セッション |
| GET | `/api/terminal/cases?hostname=&limit=` | 担当者 | 自分が claim した案件の一覧（RSP から案件を探す用） |
| GET | `/api/terminal/sessions?caseId=` | 参照可 | その案件の最新セッション・ステップ（無ければ `session:null`） |
| POST | `/api/terminal/sessions` | claim 済み担当者 | `{caseId, consent:{screenShare,remoteControl}, ttlMinutes?}`。同意必須・同時 1 件 |
| GET | `/api/terminal/sessions/:id` | 参照可 | セッションとステップ |
| POST | `/api/terminal/sessions/:id/steps` | 担当者 | `{intent, lastOutput?}`。AI が次の一手を提案（10 回/分） |
| POST | `/api/terminal/steps/:id/record` | 担当者 | `{command, output?, outputSource, exitStatus, note?}`。1 ステップ 1 回 |
| GET | `/api/terminal/sessions/:id/capture` | 参照可 | 出力の自動取込の可否（現状 `supported:false` と理由） |
| POST | `/api/terminal/sessions/:id/close` | 担当者/依頼者 | `{reason:'resolved'|'stopped'|'escalated', note?}` |
| POST | `/api/terminal/sessions/:id/report` | 担当者 | 報告書をサーバで組み立て `final_reports` に保存。`files.html.previewUrl`（inline）を開く |
| POST | `/api/terminal/sessions/:id/knowledge-draft` | 担当者 | `{title?, cause?}`。ナレッジは **status `draft`**（自動公開しない） |

- 出力とコマンドは保存前に伏せ字化（`redactPII`）し、出力は 20,000 文字で切り詰め（切り詰めを明示）。
  実行記録の SHA-256 はマスク後の `{sessionId, stepId, seq, command, output, outputSource, exitStatus}`。
- 上限: 20 ステップ / 出力 20,000 文字 / TTL 30 分（最大 120 分）。期限切れは参照時に `closed`/`expired` へ。
- エラー: `NOT_CLAIMED_OPERATOR` / `CONSENT_REQUIRED` / `SESSION_ACTIVE` / `SESSION_CLOSED` /
  `STEP_LIMIT` / `STEP_RECORDED` / `CAPTURE_UNAVAILABLE` / `NO_RECORDED_STEPS` / `AI_UNAVAILABLE` / `RATE_LIMITED`。
- 自動取込は RSP のログ/API が未提供のため未対応。差し替え点は `apps/api/src/terminal/capture.ts`。
- RSP の WebUI（AI支援パネル）からは、RSP のバックエンド経由で本 API を呼ぶ。
  そのリクエストだけ `X-Helpdesk-Service-Key`（`RSP_INTEGRATION_KEY`）と `X-Operator-Email`、
  loopback 送信元で認証する（[36-rsp-integration.md](36-rsp-integration.md) §2）。
- SessionDTO / StepDTO の形は [35-terminal-session.md](35-terminal-session.md) §3・§4 を参照。作成済みの
  ナレッジは `session.knowledge = {id, kbNo, status, title}`、報告書は `session.report = {id, sha256}` で返す。

## 7. セキュリティ上の前提

- Preview では Worker が `X-Proxy-Secret` を付与し、API は共有秘密のない直接アクセスを拒否する（`REQUIRE_PROXY_SECRET=true`）。
- POST/PATCH は `Origin` を許可リストと照合する（SameSite=Lax と併用）。
- Cookie は `HttpOnly` / `SameSite=Lax` / Preview では `Secure`。
- API は `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` を返す。
