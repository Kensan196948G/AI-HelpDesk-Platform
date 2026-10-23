# 実端末コマンド実行（許可リスト方式）

| 項目 | 値 |
|---|---|
| 版 | v0.1 |
| 日付 | 2026-10-23 |
| 対象 | `POST /api/device/command` / `GET /api/device/command` / `POST /api/device/command/:id/result` |
| 実行できる操作 | `SPOOLER_RESTART`（印刷スプーラの再起動）のみ |

## 1. 目的

AI相談の修復提案で「Y」を選んだあと、**実際の端末（Windows）で許可リストの操作を実行**し、結果を画面へ戻す。
現状の `applyOp` は模擬のため、端末エージェント経由の実実行チャネルを追加する。

## 2. 構成

```
[ブラウザ] --POST /api/device/command--> [API] --(device_commands キュー)
                                              ^            |
                                              |            v
[状態確認] <--GET /api/device/command/:id-- [API] <--GET /api/device/command-- [端末エージェント]
                                              ^            |
                                              +--POST /result--+
```

- コマンドは DB の `device_commands` に **queued** で登録。
- 端末エージェントが `x-device-token` で取得すると **delivered**、実行後に **done / failed**。
- UI は `GET /api/device/command/:id` で状態を確認。

## 3. セキュリティ

- **許可リスト**（`SPOOLER_RESTART` のみ）。任意のシェル文字列は受け付けない。
- UI 側は `authenticateUi`（Cloudflare Access + 許可リスト）。
- 端末側はデバイストークン（SHA-256 ハッシュ保存）。`/api/device/command` は Access のパス限定 bypass（またはサービスドメイン）を前提。
- レート制限: 10 回/分/利用者。
- 1 回だけ配信（`queued` → `delivered`）。配信前の結果報告は 404。

## 4. 端末エージェント

### 4-1. Node（Windows / macOS / Linux）

```bash
node scripts/endpoint-command-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json
# 1回だけ / 実行せず確認
node scripts/endpoint-command-agent.mjs --once --dry-run
```

- Windows: `Restart-Service -Name Spooler -Force` を実行。
- Windows 以外: 実行せず「未対応OS」として失敗報告（Linux での動作確認用）。

### 4-2. Windows PowerShell（Node 不要）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\command-agent.ps1 `
  -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
# 1回だけ
... -Once
```

- 管理者権限が必要な場合があります。
- 設定は既存の `device-agent-windows.json`（`url` / `deviceToken` / `cfAccessClientId` / `cfAccessClientSecret` / `proxySecret`）を共用。

### 4-3. Cloudflare Access

端末エージェントは Access のログイン画面を通れないため、`/api/device/agent` と同様に
**`/api/device/command` をパス限定で bypass**（またはサービスドメインのサービス トークン）にしてください。
設定変更後は API を再起動します。

## 5. 画面

- 提案カードの「Y」で模擬実行したあと、`SPOOLER_RESTART` の提案に **「実端末で実行（エージェント）」** が出る。
- 押すとコマンドを登録し、3 秒間隔で状態を確認。完了すると結果（JSON）を表示。
- エージェント未接続の場合は「応答がありません」と表示。

## 6. 検証（2026-10-23）

モックエージェント（Linux）でチャネル全体を実測。

| ステップ | 結果 |
|---|---|
| UI がコマンド登録 | `queued` / `SPOOLER_RESTART` |
| エージェントが取得 | `delivered`（二重配信なし） |
| 結果報告 | `done` / `result: {platform: "win32", mock: true}` |
| UI が状態確認 | `done` と結果を取得 |

証跡: [command-created.json](evidence/device-command/20261023/command-created.json) / [command-done.json](evidence/device-command/20261023/command-done.json) / [mock-agent.log](evidence/device-command/20261023/mock-agent.log)

- `npm test`: **127 passed**（22 files、コマンドチャネル 6 件を含む）。
- **実機（Windows）での実行は未実施**。上記 PowerShell を対象PCで実行して確認する。

## 7. 制限・今後

- 承認（Y/N）は現在ブラウザ側の状態で管理しており、サーバは「認証済み利用者の要求」として受け付ける。本番では **承認状態をサーバ側へ移す**（提案・承認ハッシュを DB 化）べき。
- デバイストークンは利用者単位。複数端末を厳密に分離するにはコマンドに `device_id` を必須化し、エージェントの端末IDと照合する。
- 操作は `SPOOLER_RESTART` のみ。`REBOOT` / `TEMP_CLEAN_USER` / `VPN_ADAPTER_ENABLE` は、実行条件・権限・ロールバックを決めてから追加する。
- コマンドの期限切れ（expired）・掃除は未実装。
