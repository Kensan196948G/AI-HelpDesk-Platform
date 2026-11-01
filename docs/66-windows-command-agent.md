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
| 既存の操作 | `SPOOLER_RESTART`（skill_id なし）の実行は従来どおり `Restart-Service -Name Spooler -Force`。一般ユーザーでは権限不足で失敗することがある。起動時の拒否（SYSTEM、緩い ACL、http、admin）はこの経路にもかかる。`x-device-id` を送るようになった |

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

**端末情報の収集タスクとは別の設定ファイルと別のトークンにする。** 例: `%USERPROFILE%\.config\ai-helpdesk\command-agent-windows.json` を作り、`-ConfigPath` で指定する。既定の `device-agent-windows.json` は収集タスクの設定で、`browserDeviceId` が短縮形（`WEB-XXXXXXXX`）のことがある。トークンの端末は最初に送った `x-device-id` に固定されるので、短縮形で一度送ると以後は配信されないか `DEVICE_MISMATCH` になる。値はユーザーが入れる。リポジトリ、PR、ログに書かない。

| 項目 | 必須 | 内容 |
|---|---|---|
| `url` | 必須 | `https://<ホスト>/api/device/agent`。`/api/device/command` は自動で作る。§3-1 の接続先 |
| `deviceToken` | 必須 | 管理者が `scripts/issue-device-token.ts --email <本人のメール>` で発行した standard のトークン |
| `browserDeviceId` | 必須 | ブラウザの端末 ID。**`url` と同じオリジン**を開いたブラウザの `localStorage` の `aihd.device.id`（未接続のカードに表示される）。別のオリジンの値は使えない。画面の `WEB-XXXXXXXX` は短縮形なので使わない。無いとサーバは配信しない |
| `cfAccessClientId` / `cfAccessClientSecret` | 環境による | Access のサービストークン。`/api/device/command` を Access のパス限定で bypass していれば不要（docs/19 §4-3） |
| `proxySecret` | 環境による | サーバが `REQUIRE_PROXY_SECRET` のとき |

トークンは `scripts/issue-device-token.ts --email <本人のメール> --out <新しいファイル>` で別に発行する（既存のファイルを指定すると `deviceToken` を上書きする）。

本人だけが読めるようにする。緩ければエージェントは起動しない（本人、SYSTEM、Administrators 以外に Allow があると拒否）。

```powershell
$cfg = "$env:USERPROFILE\.config\ai-helpdesk\command-agent-windows.json"
icacls $cfg /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
```

### 3-1. 接続先

resolve カードの経路（#126）と結果の出所の判定は、この PR のブランチにあり main にはない。実機の確認は**このブランチで動かした検証インスタンス**へ接続し、トークンもその DB で発行する（docs/63 §14 と同じ形）。Preview はマージ済みの main からしか作らないので、この経路を確認できない。

## 4. 実行、停止、アンインストール

**順序:** 相談を始める前に、エージェントを常駐（`-Once` なし）で起動しておく。応答中でないと端末は「未接続」になり、読み取り診断の開始ボタンが出ない。

**相談者本人のユーザー（mirai-user 相当の一般ユーザー）** でログオンし、昇格していない PowerShell で実行する。管理者として実行しない。SYSTEM のタスクにしない。

```powershell
$agent = "$env:LOCALAPPDATA\AIHelpDesk\agent\scripts\windows\command-agent.ps1"
$cfg = "$env:USERPROFILE\.config\ai-helpdesk\command-agent-windows.json"

# 1 回だけ（まずこれで確認する）。コマンドが無ければ何もせず終わる
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -ConfigPath $cfg -Once

# 実行せず、受け取るコマンドだけ確認する（報告もしない）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -ConfigPath $cfg -Once -DryRun

# 常駐（Ctrl+C で止まる）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -ConfigPath $cfg
```

`-Once` はポーリングに失敗すると終了コード 1 で終わる。

**ログオン時に自動で起動する場合:** 本人のスタートアップフォルダ（`shell:startup`）に上の常駐のコマンドのショートカットを置く。一般ユーザーがログオントリガのタスクを登録できるかは未確認である。

**停止:** 前面なら Ctrl+C。背面なら次で探して止める。

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*command-agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

**アンインストール:** 停止する → スタートアップのショートカットを消す → `%LOCALAPPDATA%\AIHelpDesk\agent`、設定ファイル、`<設定ファイル>.last-contact` を消す → 管理者がサーバ側でトークンを失効する（`device_tokens.revoked_at`。専用のスクリプトは無い）。

## 5. 確かめたこと

| 試験 | 内容 | 結果 |
|---|---|---|
| `scripts/windows/tests/command-agent.tests.ps1`（pwsh、Linux） | スタブの HTTP サーバとスタブの Skill で、許可、ハッシュ不一致（CRLF を含む）、未知の Skill、昇格必須、引数の検証、タイムアウト（実時間 60 秒）、SYSTEM の拒否、ACL、トークンのログ、本物の 8 件のバイト列の一致 | `npm test` の `command-agent.pwsh.test.mjs` から実行する。CI の手順に入る |
| `command-agent.pwsh.test.mjs`（vitest） | 許可リストと上限が mjs と一致する。pwsh が無ければ CI で失敗する | 同上 |
| `scripts/e2e/command-agent-ps1.mjs`（pwsh + 実 API、専用 DB） | 案件 → 本人 Y → 配信 → **スタブの Skill**（模擬）→ 結果の保存。本番モードのサーバが `mock` を拒否すること | [docs/evidence/command-agent-ps1-20261101/](evidence/command-agent-ps1-20261101/) |

試験の手順を確認するため、ハッシュ照合、許可リスト、SYSTEM の拒否、ログの伏せ字を外した写しで流し、試験が失敗することを確かめた。

CI の `.github/workflows` は変えていない。#117 / #120 の CI には pwsh の手順があるので、それらと統合するときに `pwsh -NoProfile -NonInteractive -File scripts/windows/tests/command-agent.tests.ps1` を足してもよいが、`npm test` から実行されるので必須ではない。

## 5-1. 実機で確かめたこと（2026-11-01、Windows PowerShell 5.1、検証端末 1 台）

- 10 ファイルを本人権限で配置し、CRLF 変換なしでハッシュが一致して `spooler.status` が 2 回完了（各約 1.3 秒）。出所 `endpoint_agent` をサーバが受理。
- 実行者は検証ユーザー本人、切断セッション（session 2）のまま常駐で動作。接続先の再起動中の 502 の後に自動で復帰。
- `icacls` で設定ファイルを本人のみにした状態で起動できた。

**ここに書いていないものは未確認。** 昇格の拒否、SYSTEM の拒否、タイムアウトの停止、引数のある Skill、Cloudflare Access 越し、スタートアップ起動、一般ユーザーの `SPOOLER_RESTART`、変更系 Skill は実機で確かめていない。

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
- 常駐のエージェントでの端末の接続表示（E2E はコマンドを作ってから `-Once` を流した）。
- TLS 1.2 の有効化（5.1 のときだけ `ServicePointManager` へ足す。実際の接続は未確認）。
- Cloudflare Access 越しの通信、スタートアップからの起動、昇格していないユーザーでの `SPOOLER_RESTART`。

## 7. ローカルの保持期限

#120 の `folder-helper.ps1`（docs/63 §12）と同じ考え方で、サーバと連絡できないままトークンを持ち続けない。

| 項目 | 内容 |
|---|---|
| 記録 | `<設定ファイル>.last-contact` の更新時刻（内容は固定の文字列で、秘密を含まない）。例外にならなかった応答（2xx、204）だけを連絡と数える。5xx、401 / 403、通信の失敗は数えない。書き込みは最短 60 分おき |
| 起点 | 設定ファイルの更新時刻と、最後の連絡の新しいほう。発行し直した直後に古い記録で消さない。一度も通信していない設定も期限の対象になる |
| 期限 | 168 時間。記録が 24 時間より未来なら、期限を延ばさず過ぎたものとして扱う |
| 判定 | 起動時とポーリングの前。**通信しない** |
| 期限切れ | 設定ファイル（`deviceToken`）と記録を消して止まる。終了コードは 3 で、成功（0）や通常の失敗（1）と分ける。`-DryRun` は消さずに 3 で止まる |
| 再開 | トークンを再発行して設定ファイルを作り直す |

**期限切れは成功でも、停止の確認でもない。** サーバへ報告しないので、サーバ側のトークンは失効せず、実行中のコマンドの記録も変わらない。サーバ側は管理者が `device_tokens.revoked_at` で失効する。

**限界:**

- 処理はエージェントが動いたときだけ走る。**電源が入らない端末、エージェントを起動しない端末では消えない。** 常駐中は 168 時間を過ぎた次のポーリングで止まるが、スリープ中は動かない。
- 消すのは設定ファイルだけで、ディスクの上書き消去はしない。別の場所へコピーした設定やバックアップは消せない。
- 本人が時刻やファイルを書き換えれば延ばせる（本人権限の範囲で、攻撃への対策ではない）。
- 常駐の Windows 実機では未確認（pwsh、Linux の試験で確認した）。

