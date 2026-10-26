# 端末エージェント配備手順（Windows 実機）

| 項目 | 値 |
|---|---|
| 対象 | 社内実機 `202307036M`（Windows 10/11） |
| 目的 | 修復 Skill（昇格必須 5 件を含む）を実機で実行し、`exit 3` と PowerShell の実挙動を確認する |
| 前提 | Node.js 20+（または同梱ランタイム）／管理者権限／Cloudflare Access のサービスドメイン |
| 状態 | **手順書のみ（未配備）**。トークン発行と Access サービスドメインの設定は Human Gate |

---

## 1. 全体像

```
[PC 202307036M]
  標準エージェント（ユーザー権限・常駐）
      └─ 昇格不要 Skill（os.info / disk.space / spooler.status / service.status /
                          network.adapters / dns.flush / temp.cleanup など）
  管理者エージェント（SYSTEM サービス・別トークン）
      └─ 昇格必須 Skill（spooler.restart / spooler.queue.purge / service.start /
                          bitlocker.status / defender.quickscan）
        │  どちらも outbound で API を polling（inbound 不要）
        ▼
[Cloudflare Tunnel] → [ai-helpdesk API]（Access のサービスドメインで保護）
```

- 端末は**サーバから到達できない**（NAT 内）。エージェントが API を polling する。
- 配信は `device_tokens.privilege` で分離される（standard / admin）。**サーバ側で強制**。

## 2. 事前に必要なもの（Human Gate）

| # | 項目 | 取得方法 |
|---|---|---|
| 1 | **デバイストークン（standard）** | 本リポジトリで発行（§3） |
| 2 | **デバイストークン（admin）** | 同上。standard と**別の値** |
| 3 | **Cloudflare Access サービスドメイン**（Client ID / Secret） | Cloudflare ダッシュボード → Access → Service Auth。`/api/device/*` を許可するポリシーに紐づける |
| 4 | API のベース URL | `https://ai-helpdesk.mirai-dx-platform.com/api/device/agent` |

> トークン値と Client Secret は**リポジトリ・チャット・Issue に書かない**。PC 上の設定ファイル（ACL 制限）のみ。

## 3. デバイストークンの発行（サーバ側）

```bash
# 32 バイトの乱数を生成し、SHA-256 ハッシュだけを DB に保存する（値は表示しない）
node -e '
const {randomBytes, createHash} = require("node:crypto");
const t = "aihd_" + randomBytes(24).toString("base64url");
console.log("TOKEN=" + t);                       // ← PC の設定へ。画面に出さない
console.log("HASH=" + createHash("sha256").update(t).digest("hex"));
'
```

```sql
-- 端末 ID はエージェントが名乗る値（初回でバインドされる）
INSERT INTO device_tokens (token_hash, user_email, label, device_id, privilege)
VALUES ('<HASH>', '<担当者メール>', '202307036M-standard', NULL, 'standard'),
       ('<HASH2>', '<担当者メール>', '202307036M-admin',   NULL, 'admin');
```

> `privilege` が `admin` のトークンは昇格必須コマンドだけを受信する（逆も同じ）。誤って同じ値を使うと
> エージェントが起動を拒否する（実装済み）。

## 4. 設定ファイル（PC 上）

`C:\aihd\endpoint-agent.json`（ACL で Administrators + SYSTEM のみ読み取り可）

```json
{
  "url": "https://ai-helpdesk.mirai-dx-platform.com/api/device/agent",
  "deviceToken": "<standard の TOKEN>",
  "adminDeviceToken": "<admin の TOKEN>",
  "cfAccessClientId": "<Access Client ID>",
  "cfAccessClientSecret": "<Access Client Secret>",
  "browserDeviceId": "202307036M"
}
```

## 5. 配備

### 5-1. 標準エージェント（ユーザー権限）

```powershell
# 依存を入れる（Node 20+ が無い場合）
# リポジトリから scripts/endpoint-command-agent.mjs と scripts/skills/windows/*.ps1 を配置
node C:\aihd\endpoint-command-agent.mjs --config C:\aihd\endpoint-agent.json --once
# 疎通確認（204 = 対象コマンドなし / 200 = 実行）
```

常駐はタスクスケジューラ（ログオン時）で 30 秒間隔。

### 5-2. 管理者エージェント（SYSTEM）

```powershell
# 管理者 PowerShell で
sc.exe create aihd-agent-admin binPath= "C:\Program Files\nodejs\node.exe C:\aihd\endpoint-command-agent.mjs --config C:\aihd\endpoint-agent.json" start= auto
sc.exe description aihd-agent-admin "AI HelpDesk 管理者エージェント（昇格必須 Skill のみ）"
# 環境変数で admin を明示（別プロセスとして動かす）
setx /M AIHD_AGENT_PRIVILEGE admin
sc.exe start aihd-agent-admin
```

> 管理者エージェントは**昇格必須 5 件だけ**を実行する（許可リスト）。未知 ID は拒否（fail-closed）。

## 6. 実機での確認項目（検収）

| # | 確認 | 期待 |
|---|---|---|
| 1 | 標準エージェント起動 | `os.info` が実行でき、結果が API に反映される |
| 2 | 管理者エージェント起動 | `spooler.restart` が配信される（standard には配信されない） |
| 3 | `spooler.restart` 実実行 | Print Spooler が再起動し、追撃 `service.status` が `Running` を返す |
| 4 | **非昇格実行** | 管理者トークンを外すと `exit 3`（管理者権限が必要）で失敗し、**状態が変わらない** |
| 5 | `spooler.queue.purge` | `confirm:"PURGE"` が無ければ実行されない（exit 2） |
| 6 | 監査 | `resolution.verify_enqueued` / `resolution.verify_result` / `resolution.awaiting_decision` が記録される |
| 7 | UI | 「原因の対処まで完了しました／解決しましたか？」カードが出て、`解決した` で `resolved` になる |

## 7. 切り戻し

```powershell
sc.exe stop aihd-agent-admin ; sc.exe delete aihd-agent-admin
schtasks /delete /tn "AIHD Endpoint Agent" /f
```

サーバ側は `UPDATE device_tokens SET revoked_at = now() WHERE label LIKE '202307036M-%';`。

---

## 8. 実機検証結果（2026-10-26 / `202307036M`）

実際に配備して確認した結果。**未検証だった層がすべて実機で通った**。

| # | 検証 | 方法 | 結果 |
|---|---|---|---|
| 1 | 修復 Skill の単体実行 | `spooler-restart.ps1` を管理者 PowerShell で実行 | `{"previousStatus":"Running","restarted":true}` / `exit=0` |
| 2 | 読取 Skill | `spooler-status.ps1` | `{"status":"Running","startType":"Auto"}` / `exit=0` |
| 3 | **PowerShell 5.1 互換** | 同上（`powershell.exe`） | **BOM なしで構文エラー → BOM 付与で解決**（PR #57） |
| 4 | デバイストークン認証 | 標準エージェント `--once` | コマンド取得・実行・結果報告 OK |
| 5 | **権限分離（standard）** | 昇格必須 `spooler.restart` を積んで標準エージェント実行 | **配信されない**（`queued` / `delivered_at: null` のまま） |
| 6 | **権限分離（admin）** | `--privilege admin` で同コマンドを実行 | 取得・実行・`done` |
| 7 | 昇格実行の実効性 | サーバ側の結果 | `{status:"Running", restarted:true}` / `exitCode 0` |
| 8 | 結果のサーバ反映 | `device_commands` | `done`、`normalized.flushed=true`（dns.flush）/ `restarted=true`（spooler.restart） |

### 8-1. 実機で見つけた欠陥（修正済み）

| 欠陥 | 影響 | 修正 |
|---|---|---|
| **`.ps1` が UTF-8 BOM なし** | Windows PowerShell 5.1 が ANSI として解釈し、日本語コメントで**構文エラー**。修復 Skill が実機で動かない | 全12件に BOM 付与＋回帰テスト（PR #57、`62dad79`） |
| **`/api/device/command` が Access で 302** | エージェントがポーリングできない（`/api/device/agent` だけが bypass されていた） | `api/device/command` を bypass アプリとして追加（アプリ層の device token 認証は維持、不正トークンで 401 を実測） |

### 8-2. 未検証として残るもの

- 管理者エージェントを **Windows サービス（SYSTEM）** として常駐させた状態での動作（本検証は管理者 PowerShell からの `--once`）
- 端末の再起動・ネットワーク断からの自動復帰
- 複数端末への一斉配備
