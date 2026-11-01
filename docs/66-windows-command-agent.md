# 66. Windows の端末エージェント（Node 不要）

`scripts/windows/command-agent.ps1` は Node の無い Windows 端末で動くコマンドエージェントである。`scripts/endpoint-command-agent.mjs` と同じ fail-closed で Skill を実行する。

**状態:** Windows PowerShell 5.1 と実端末では未実行である（§6）。Linux の pwsh とスタブの Skill で確かめた範囲は §5。

## 1. 動作

| 項目 | 内容 |
|---|---|
| 取得と報告 | `GET /api/device/command`、`POST /api/device/command/:id/result`。`x-device-token`、`x-device-id` を送る |
| 権限 | standard のみ。本人権限で動き、自分で昇格しない。設定の `agentPrivilege` が standard 以外なら起動しない |
| 起動の拒否 | SYSTEM、LOCAL SERVICE、NETWORK SERVICE。設定ファイルの ACL が緩いとき。`url` が https でないとき（`127.0.0.1` と `localhost` は除く） |
| 実行の条件 | 許可リストにあり、`approved.json` の id@version、contentHash、scriptHash（ファイルのバイト列の SHA-256）がすべて一致する。`skill_content_hash` が無いコマンドも拒否する |
| 許可リスト（8 件） | `os.info`、`disk.space`、`spooler.status`、`service.status`、`network.adapters`、`recyclebin.clear`、`temp.cleanup`、`dns.flush`。mjs の Skill から昇格必須を除いたもの。試験で一致を確かめる |
| 引数 | `service.status` の `service` は許可値、`temp.cleanup` の `olderThanDays` は 1〜30 の整数だけ。コマンド文字列は実行しない。シェルを介さない |
| 上限 | タイムアウト 60 秒で停止（子プロセスを含む）。stdout / stderr は 64KB まで、1MiB を超えたら停止。報告は最大 2,000 字 |
| 出所 | Windows では `executionSource=endpoint_agent`。Windows 以外は `mock`。設定や引数で変えられない。本番のサーバは `mock` を拒否する |
| 秘密 | トークン、CF のシークレット、proxy シークレット、`aihd_...` の形は画面、ログ、報告に出さない |
| 既存の操作 | `SPOOLER_RESTART`（skill_id なし）は従来どおり `Restart-Service -Name Spooler -Force`。一般ユーザーでは権限不足で失敗することがある |

昇格したプロセスで起動すると警告を出すが、止めない（`SPOOLER_RESTART` の従来の使い方を変えないため）。**Skill の確認には通常の権限で起動する。**

**改行に注意:** `scriptHash` はバイト列のハッシュで、リポジトリのファイルは LF + BOM である。`core.autocrlf=true` の Windows で clone すると CRLF に変わり、実行を拒否する。`.gitattributes` で `-text` にした。**配置は ZIP か `git archive` で行い、エディタで開いて保存しない。**

## 2. 必要なファイル

次の 10 個を、**この相対配置のまま** 同じフォルダの下に置く。例: `%LOCALAPPDATA%\AIHelpDesk\agent\`。

```
scripts\windows\command-agent.ps1
scripts\skills\approved.json
scripts\skills\windows\os-info.ps1
scripts\skills\windows\disk-space.ps1
scripts\skills\windows\spooler-status.ps1
scripts\skills\windows\service-status.ps1
scripts\skills\windows\network-adapters.ps1
scripts\skills\windows\recyclebin-clear.ps1
scripts\skills\windows\temp-cleanup.ps1
scripts\skills\windows\dns-flush.ps1
```

読み取りの確認だけなら `spooler-status.ps1`、`os-info.ps1` などその Skill の分だけでも動く（無いファイルの Skill は拒否する）。Node、npm、リポジトリ全体は要らない。

## 3. 設定ファイル

既定の場所は `%USERPROFILE%\.config\ai-helpdesk\device-agent-windows.json`。値はユーザーが入れる。リポジトリ、PR、ログに書かない。

| 項目 | 必須 | 内容 |
|---|---|---|
| `url` | 必須 | `https://<ホスト>/api/device/agent`。`/api/device/command` は自動で作る |
| `deviceToken` | 必須 | 管理者が `scripts/issue-device-token.ts --email <本人のメール>` で発行した standard のトークン |
| `browserDeviceId` | 必須 | ブラウザの端末 ID。その PC のブラウザの `localStorage` の `aihd.device.id`（未接続のカードに表示される）。画面の `WEB-XXXXXXXX` は短縮形なので使わない。無いとサーバは配信しない |
| `cfAccessClientId` / `cfAccessClientSecret` | 環境による | Access のサービストークン。`/api/device/command` を Access のパス限定で bypass していれば不要（docs/19 §4-3） |
| `proxySecret` | 環境による | サーバが `REQUIRE_PROXY_SECRET` のとき |

本人だけが読めるようにする。緩ければエージェントは起動しない（本人、SYSTEM、Administrators 以外に Allow があると拒否）。

```powershell
$cfg = "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
icacls $cfg /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
```

## 4. 実行、停止、アンインストール

**相談者本人のユーザー（mirai-user 相当の一般ユーザー）** でログオンし、昇格していない PowerShell で実行する。管理者として実行しない。SYSTEM のタスクにしない。

```powershell
$agent = "$env:LOCALAPPDATA\AIHelpDesk\agent\scripts\windows\command-agent.ps1"

# 1 回だけ（まずこれで確認する）。コマンドが無ければ何もせず終わる
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -Once

# 実行せず、受け取るコマンドだけ確認する（報告もしない）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -Once -DryRun

# 常駐（Ctrl+C で止まる）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent
```

`-ConfigPath <パス>` で設定ファイルを変えられる。`-Once` はポーリングに失敗すると終了コード 1 で終わる。

**ログオン時に自動で起動する場合:** 本人のスタートアップフォルダ（`shell:startup`）に上の常駐のコマンドのショートカットを置く。一般ユーザーがログオントリガのタスクを登録できるかは未確認である。

**停止:** 前面なら Ctrl+C。背面なら次で探して止める。

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*command-agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

**アンインストール:** 停止する → スタートアップのショートカットを消す → `%LOCALAPPDATA%\AIHelpDesk\agent` と設定ファイルを消す → 管理者がサーバ側でトークンを失効する（`device_tokens.revoked_at`。専用のスクリプトは無い）。

## 5. 確かめたこと

| 試験 | 内容 | 結果 |
|---|---|---|
| `scripts/windows/tests/command-agent.tests.ps1`（pwsh、Linux） | スタブの HTTP サーバとスタブの Skill で、許可、ハッシュ不一致（CRLF を含む）、未知の Skill、昇格必須、引数の検証、タイムアウト（実時間 60 秒）、SYSTEM の拒否、ACL、トークンのログ、本物の 8 件のバイト列の一致 | `npm test` の `command-agent.pwsh.test.mjs` から実行する。CI の手順に入る |
| `command-agent.pwsh.test.mjs`（vitest） | 許可リストと上限が mjs と一致する。pwsh が無ければ CI で失敗する | 同上 |
| `scripts/e2e/command-agent-ps1.mjs`（pwsh + 実 API、専用 DB） | 案件 → 本人 Y → 配信 → **スタブの Skill**（模擬）→ 結果の保存。本番モードのサーバが `mock` を拒否すること | [docs/evidence/command-agent-ps1-20261101/](evidence/command-agent-ps1-20261101/) |

試験の手順を確認するため、ハッシュ照合、許可リスト、SYSTEM の拒否、ログの伏せ字を外した写しで流し、試験が失敗することを確かめた。

CI の `.github/workflows` は変えていない。#117 / #120 の CI には pwsh の手順があるので、それらと統合するときに `pwsh -NoProfile -NonInteractive -File scripts/windows/tests/command-agent.tests.ps1` を足してもよいが、`npm test` から実行されるので必須ではない。

## 6. 確認できていないこと（実機が要る）

Linux の pwsh 7 では次を確かめられない。

- Windows PowerShell 5.1 での実行そのもの（構文は 5.1 に無いものを使っていないことを字句で確認しただけ）。
- 5.1 の `Invoke-RestMethod` の 204 の扱いと文字コード、`ConvertFrom-Json` / `ConvertTo-Json` の差。
- `ArgumentList` の無い .NET Framework での引数の引用（関数はベクトルで確認。実際に空白や日本語を含むパスで起動するのは未確認）。
- Windows の ACL の読み取り（`Get-Acl`）と `icacls` の手順。評価の関数だけ確認した。
- SYSTEM の実トークンでの拒否（識別子の取得を差し替えて確認した）。
- `taskkill /T` によるプロセスツリーの停止。
- `endpoint_agent` の申告の実送信（Linux は `mock` を申告する。分岐は関数で確認した）と、本番のサーバが受け付けること。
- 本物の Skill の実行結果と、その出力の文字コード。
- TLS 1.2 の有効化（5.1 のときだけ `ServicePointManager` へ足す。実際の接続は未確認）。
- Cloudflare Access 越しの通信、スタートアップからの起動、昇格していないユーザーでの `SPOOLER_RESTART`。
