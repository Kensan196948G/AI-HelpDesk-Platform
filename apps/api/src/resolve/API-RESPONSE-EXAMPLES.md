# 解決ループ API レスポンス例（UI 実装用）

対象: `apps/api/src/resolve/routes.ts`（Phase B / task-7）。すべて `/api` 配下・`authenticateUi` 必須。
日時は ISO 8601（UTC）。他者リソースは 404。ボディは JSON。

## 1. 承認ハッシュの計算（UI 側）

`POST /sessions` / `POST /steps/:id/continue` が返す `step.approvalChallenge.payload` を
**そのまま** `stableStringify` → SHA-256（hex・小文字）する。キー順は sort されるため不要な並べ替えは不要。

```js
// apps/api/src/domain/audit.ts の stableStringify と同一実装を使う
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}
const approvalHash = [
  ...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(payload))),
  ),
]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
```

payload は設計 §5-2 の 12 キー（`sessionId, stepId, seq, skillId, skillVersion, skillContentHash,
params, deviceId, userEmail, riskLevel, nonce, expiresAt`）。`expiresAt` は約 5 分後。

## 2. `POST /api/resolve/sessions`

リクエスト: `{ "caseId": "CASE-0001", "deviceId": "WEB-AB12CD34" }`

```json
{
  "ok": true,
  "session": {
    "id": "327e9656-b839-4116-976c-5b9a664e7011",
    "status": "waiting_execute",
    "caseId": "CASE-0001",
    "deviceId": "WEB-AB12CD34",
    "stepCount": 1,
    "maxSteps": 6,
    "startedAt": "2026-10-25T05:43:54.505Z",
    "expiresAt": "2026-10-25T06:13:54.505Z",
    "lastSummary": null,
    "createdAt": "2026-10-25T05:43:54.505Z",
    "updatedAt": "2026-10-25T05:43:54.505Z"
  },
  "step": {
    "id": "661f3866-6dd6-487f-800d-819ba8cbd11f",
    "sessionId": "327e9656-b839-4116-976c-5b9a664e7011",
    "seq": 1,
    "skillId": "disk.space",
    "skillVersion": "1.0.0",
    "skill": {
      "id": "disk.space",
      "version": "1.0.0",
      "title": "ディスクの空き容量を確認する",
      "summary": "各ドライブの合計容量・空き容量・使用率を読み取りで確認します。",
      "script": "scripts/skills/windows/disk-space.ps1",
      "args": [],
      "riskLevel": 1,
      "paramsSchema": { "type": "object", "additionalProperties": false, "properties": {} },
      "requires": { "userConfirm": true, "adminApproval": false, "elevation": false },
      "verify": null,
      "rollback": null,
      "resultSchema": { "disks": ["..."] },
      "outputPolicy": { "maxBytes": 8192, "fieldsToAi": ["disks"], "maskPii": true },
      "timeoutSec": 60,
      "contentHash": "sha256:a07b9aae1957bb32bc7da3dbc61a9d6c502a8343a50f4b116ff52318d6eb277d"
    },
    "params": {},
    "rationale": "保存・容量に関する相談のため、ディスクの空き容量を読み取りで確認します。",
    "riskLevel": 1,
    "status": "proposed",
    "approvalChallenge": {
      "payload": {
        "sessionId": "327e9656-b839-4116-976c-5b9a664e7011",
        "stepId": "661f3866-6dd6-487f-800d-819ba8cbd11f",
        "seq": 1,
        "skillId": "disk.space",
        "skillVersion": "1.0.0",
        "skillContentHash": "sha256:a07b9aae1957bb32bc7da3dbc61a9d6c502a8343a50f4b116ff52318d6eb277d",
        "params": {},
        "deviceId": "WEB-AB12CD34",
        "userEmail": "user@example.com",
        "riskLevel": 1,
        "nonce": "0XA9DgTyw6qi_DUyHgsYbA",
        "expiresAt": "2026-10-25T05:48:54.505Z"
      },
      "nonce": "0XA9DgTyw6qi_DUyHgsYbA",
      "expiresAt": "2026-10-25T05:48:54.505Z"
    },
    "commandId": null,
    "resultSummary": null,
    "resultFull": null,
    "error": null,
    "approvedBy": null,
    "approvedAt": null,
    "executedAt": null,
    "createdAt": "2026-10-25T05:43:54.505Z"
  }
}
```

## 3. `POST /api/resolve/steps/:id/approve`

リクエスト: `{ "decision": "Y", "approvalHash": "<64桁hex>" }`（N のとき approvalHash 省略可）

Y のレスポンス（`command` 付き）:

```json
{
  "ok": true,
  "step": { "...": "上と同じ step。status は approved、approvalChallenge は null" },
  "session": { "...": "上と同じ session。status は executing" },
  "command": {
    "id": "b6c0b6a4-6e18-4855-a263-b6dc4e7333d4",
    "opId": "disk.space",
    "params": {},
    "status": "queued",
    "deviceId": "WEB-AB12CD34",
    "skillId": "disk.space",
    "skillVersion": "1.0.0",
    "sessionId": "327e9656-b839-4116-976c-5b9a664e7011",
    "stepId": "661f3866-6dd6-487f-800d-819ba8cbd11f",
    "createdAt": "2026-10-25T05:43:45.186Z"
  }
}
```

N のレスポンス: `{ "ok": true, "step": {status:"rejected"...}, "session": {status:"stopped"...} }`（command なし）。

## 4. `GET /api/resolve/steps/:id`（ポーリング用）

`step.status` の遷移: `proposed → approved → executing → done | failed`
（例外: `rejected`（実行前 N）, `cancelled`（停止・期限切れ））。
- `done`: `session.status = "waiting_continue"`、`step.resultSummary` が入る。
- `failed`: `session.status = "escalated"`、`step.error` に伏せ字済みエラー。
- `approvalChallenge` は `status === "proposed"` のときだけ非 null。

`step.resultSummary` のキー（UI 表示用）:

```json
{
  "ok": true,
  "exitCode": 0,
  "summary": "Spooler: Running / 0 jobs",
  "normalized": { "service": "Spooler", "status": "Running", "jobCount": 0 }
}
```

`summary` は最大 2,000 字・PII 伏せ字済み。`normalized` は Skill ごとの正規化 JSON（PII 伏せ字）。
`step.resultFull` は `{ "result": {...}, "error": null }`（伏せ字済み・参照用。通常表示には使わない）。

## 5. `POST /api/resolve/steps/:id/continue`

リクエスト: `{ "decision": "Y" }` または `{ "decision": "N" }`
- Y: `{ "ok": true, "session": {status:"waiting_execute", stepCount:2...}, "step": {次提案（approvalChallenge 付き）} }`
- N: `{ "ok": true, "session": {status:"stopped"...}, "step": null }`
- 上限（6 回）: 409 `STEP_LIMIT`（session は escalated に更新済み）
- 提案できる Skill が無い / 進捗なし: 200 `{ "ok": true, "session": {status:"escalated"...}, "step": null, "reason": "NO_SKILL" | "NO_PROGRESS" }`

## 6. その他

- `POST /api/resolve/sessions/:id/stop` → `{ "ok": true, "session": {status:"stopped"...} }`
- `GET /api/resolve/sessions/:id` → `{ "ok": true, "session": {...}, "steps": [{ "id", "seq", "skillId",
  "skillVersion", "skillTitle", "riskLevel", "status", "commandId", "resultSummary", "error", "createdAt",
  "executedAt" }] }`
- `GET /api/resolve/skills` → `{ "ok": true, "skills": [{ "id", "version", "title", "summary", "symptoms",
  "os", "riskLevel", "requires", "paramsSchema", "script", "args", "verify", "rollback", "timeoutSec",
  "resultSchema", "outputPolicy", "status", "contentHash", "approvedBy", "approvedAt" }] }`

## 7. エラーコード

| HTTP | code                   | 意味                                        |
| ---- | ---------------------- | ------------------------------------------- |
| 400  | `VALIDATION_ERROR`     | 入力不正                                    |
| 400  | `APPROVAL_MISMATCH`    | 承認ハッシュ不一致・欠落                    |
| 409  | `APPROVAL_EXPIRED`     | 承認チャレンジの 5 分期限切れ               |
| 409  | `SESSION_EXPIRED`      | セッションの 30 分期限切れ                  |
| 409  | `STEP_NOT_APPROVABLE`  | 承認待ちでない（nonce 再利用含む）          |
| 409  | `STEP_NOT_CONTINUABLE` | 結果未完了・継続待ちでない                  |
| 409  | `STEP_LIMIT`           | ステップ上限（6 回）                        |
| 409  | `SKILL_NOT_ALLOWED`    | Skill が未承認・内容変更                    |
| 409  | `NO_SKILL`             | 提案できる承認済み Skill が無い             |
| 409  | `PARAM_INVALID`        | Skill パラメータ不正                        |
| 429  | `RATE_LIMITED`         | レート制限（sessions 20/分、approve 10/分） |
| 404  | `NOT_FOUND`            | 案件・セッション・ステップが無い/他者のもの |
| 403  | `FORBIDDEN`            | IT 管理者以外が承認待ち/承認を操作          |
| 403  | `SELF_APPROVAL_FORBIDDEN` | 依頼者本人による管理者承認               |
| 409  | `ADMIN_APPROVAL_REQUIRED` | リスク 4 以上で管理者承認が無い           |
| 409  | `ADMIN_APPROVAL_EXPIRED`  | 管理者承認の 5 分期限切れ                 |
| 409  | `ADMIN_ALREADY_DECIDED`   | 別の管理者が承認/却下済み                 |
| 400  | `ADMIN_APPROVAL_MISMATCH` | 管理者承認ハッシュ不一致                  |
| 409  | `SKILL_RISK_FORBIDDEN`    | リスク 5（禁止）の Skill                  |
| 409  | `DEVICE_OFFLINE`          | 端末の最終応答が閾値超過                  |
| 409  | `SESSION_TERMINAL`        | 終端状態への手動クローズ                  |
| 409  | `ADMIN_APPROVAL_NOT_REQUIRED` | リスク 4 未満に管理者承認を要求        |

## 8. Phase C で追加した API

### 手動クローズ（本人）

- `POST /api/resolve/sessions/:id/resolve` `{ "reason": "任意" }` → `{ "ok": true, "session": {status:"resolved"} }`
- `POST /api/resolve/sessions/:id/escalate` `{ "reason": "任意" }` → `{ "ok": true, "session": {status:"escalated"} }`
- 終端状態からの再操作は 409 `SESSION_TERMINAL`。監査に `by: "manual"` と理由を残す。

### IT 管理者承認（リスク 4 以上）

- `GET /api/resolve/admin/pending` → `{ "ok": true, "items": [{ "stepId", "sessionId", "seq", "skillId",
  "skillTitle", "riskLevel", "requester", "deviceId", "createdAt",
  "adminApprovalChallenge": { "payload": {...13キー...}, "nonce", "expiresAt" } }] }`
  - 管理者以外は 403 `FORBIDDEN`。自己案件は一覧に出さない。
- `POST /api/resolve/steps/:id/admin-approve` `{ "decision": "Y", "approvalHash": "<sha256>" }`
  - 402/400 系: 自己承認 403 `SELF_APPROVAL_FORBIDDEN`、ハッシュ不一致 400 `ADMIN_APPROVAL_MISMATCH`、
    期限切れ 409 `ADMIN_APPROVAL_EXPIRED`、対象外 409 `ADMIN_APPROVAL_NOT_REQUIRED`。
  - 承認しても step は `proposed` のまま。依頼者本人の Y が別途必要。

管理者承認 payload は利用者側（12 キー）と別で、`adminEmail` を含む 13 キー。

### 端末オフライン / タイムアウト

- 承認時に端末の最終応答が `RESOLVE_DEVICE_OFFLINE_SEC`（既定 120 秒）より古いと 409 `DEVICE_OFFLINE`。
- 承認時に `step.timeoutSec` / `step.deadlineAt` が確定。期限超過は `step.status = "failed"`、
  `step.error = "RESULT_TIMEOUT"`、セッションは `escalated`。期限後の結果は状態を進めない。
- 端末への配信 `/api/device/command` も期限を原子的に確認し、期限切れの step のコマンドは配信しない。

### fieldsToAi

- `step.resultAi` は `outputPolicy.fieldsToAi` を適用した AI 入力用の結果。
  `outputPolicy` 欠落・`fieldsToAi` 非配列・`normalized` 非オブジェクトは空（fail-closed）。
- `step.resultSummary` は従来どおり画面表示用（PII 伏せ字のみ）。

## 9. Phase B の制限（UI 表示の前提）

- Phase B の Skill は読み取り専用・リスク 1。実行前 Y/N と結果後 Y/N の 2 段階。
- 失敗（device_commands が failed）は安全側で初回から `escalated`。
- 承認チャレンジが 5 分切れした場合はセッションを中止して作り直す（再提案 API は未提供）。
- Windows 実機での PowerShell 実行は Phase C でも未検証（mock/fixture で検証）。
