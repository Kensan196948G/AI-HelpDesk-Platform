#Requires -Version 5.1
<#
.SYNOPSIS
  command-agent.ps1 の試験。Pester に依存しない。Linux の pwsh でも実行できる。

.DESCRIPTION
  一時フォルダに本番と同じ配置（scripts/windows、scripts/skills）を作り、スタブの HTTP サーバと
  スタブの Skill スクリプトで、エージェントを別プロセスとして実行する。Skill は模擬で実端末の結果ではない。

  このテストで確認できないこと（Windows PowerShell 5.1 の実機が要る）:
  - 5.1 の Invoke-RestMethod の 204 と文字コード、ConvertFrom-Json / ConvertTo-Json の差
  - ArgumentList が無い 5.1 での引数の引用の実動作（引用の関数はベクトルで確認する）
  - Windows の ACL（Get-Acl の読み取り。許可の評価は純粋関数で確認する）
  - SYSTEM の実トークンと taskkill によるプロセスツリーの停止
  - endpoint_agent の申告での実送信（Linux では mock を申告する。分岐は関数で確認する）
  - Windows の共有モードによる書込み、削除、改名の拒否（Linux の FileShare は助言ロックで、拒否されるのは
    FileShare.None を求める排他オープンだけ。WriteAllBytes、Set-Content、改名、削除は通る）。
    SKIP と表示して件数を分け、PASS に数えない。実機は script-identity-windows.ps1 で確かめる。

.EXAMPLE
  pwsh -NoProfile -NonInteractive -File scripts/windows/tests/command-agent.tests.ps1
#>
param()

$ErrorActionPreference = 'Stop'
$windowsDir = Split-Path -Parent $PSScriptRoot
$agentSource = Join-Path $windowsDir 'command-agent.ps1'
$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0
$Token = 'aihd_test-token-not-a-secret-0123456789'
$CfSecret = 'cf-secret-not-a-secret-0123456789'
$DeviceId = 'stub-device-0001'
$ContentHash = 'sha256:' + ('c' * 64)

function Assert-True {
  param([string]$Name, [object]$Actual, [string]$Detail = '')
  if ($Actual -is [bool] -and $Actual) { $script:Passed++ }
  else { $script:Failed++; Write-Output ('FAIL ' + $Name + ' ' + $Detail) }
}

function Assert-Equal {
  param([string]$Name, [object]$Expected, [object]$Actual)
  if ([string]$Expected -ceq [string]$Actual) { $script:Passed++ }
  else { $script:Failed++; Write-Output ('FAIL ' + $Name + ' : expected [' + [string]$Expected + '] got [' + [string]$Actual + ']') }
}

function Write-Skip {
  param([string]$Name, [string]$Reason)
  $script:Skipped++
  Write-Output ('SKIP ' + $Name + ' : ' + $Reason)
}

function Get-Sha256Hex {
  param([string]$Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash([IO.File]::ReadAllBytes($Path)) } finally { $sha.Dispose() }
  return 'sha256:' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
}

# ── 配置 ─────────────────────────────────────────────────────────────
$root = Join-Path ([IO.Path]::GetTempPath()) ('cmd-agent-' + [Guid]::NewGuid().ToString('N'))
$agentDir = Join-Path $root 'scripts/windows'
$skillsDir = Join-Path $root 'scripts/skills/windows'
New-Item -ItemType Directory -Path $agentDir, $skillsDir -Force | Out-Null
$agentPath = Join-Path $agentDir 'command-agent.ps1'
Copy-Item -LiteralPath $agentSource -Destination $agentPath
$markerDir = Join-Path $root 'markers'
New-Item -ItemType Directory -Path $markerDir | Out-Null
$manifestPath = Join-Path $root 'scripts/skills/approved.json'
$configPath = Join-Path $root 'config.json'

function Write-Stub {
  param([string]$File, [string]$Body)
  $marker = (Join-Path $markerDir ($File + '.ran')).Replace("'", "''")
  $text = "param([string]`$Service, [string]`$OlderThanDays)`nSet-Content -LiteralPath '$marker' -Value ([string]`$args.Count + '|' + `$Service + '|' + `$OlderThanDays)`n$Body`n"
  [IO.File]::WriteAllBytes((Join-Path $skillsDir $File), [Text.Encoding]::UTF8.GetBytes($text))
}

function Write-Manifest {
  $map = [ordered]@{
    'os.info' = 'os-info.ps1'; 'spooler.status' = 'spooler-status.ps1'; 'service.status' = 'service-status.ps1'
    'temp.cleanup' = 'temp-cleanup.ps1'; 'disk.space' = 'disk-space.ps1'; 'network.adapters' = 'network-adapters.ps1'
    'dns.flush' = 'dns-flush.ps1'; 'recyclebin.clear' = 'recyclebin-clear.ps1'; 'spooler.restart' = 'spooler-restart.ps1'
    'not.listed' = 'not-listed.ps1'
  }
  $skills = @()
  foreach ($id in $map.Keys) {
    $skills += [ordered]@{
      id = $id; version = '1.0.0'; contentHash = $ContentHash
      scriptHash = (Get-Sha256Hex -Path (Join-Path $skillsDir $map[$id]))
    }
  }
  [IO.File]::WriteAllText($manifestPath, (@{ version = 1; skills = $skills } | ConvertTo-Json -Depth 5))
}

$okBody = "Write-Output '{""name"":""Spooler"",""status"":""Running"",""stub"":""模擬""}'"
Write-Stub 'spooler-status.ps1' $okBody
# 実行された自分のバイト列と、子の実行中に親がハンドルを持っているかを報告するスタブ。
$identityBody = @'
$self = [IO.File]::ReadAllBytes($PSCommandPath)
$sha = [Security.Cryptography.SHA256]::Create()
$hex = ([BitConverter]::ToString($sha.ComputeHash($self))).Replace('-', '').ToLowerInvariant()
$locked = $false
try { $probe = [IO.File]::Open($PSCommandPath, 'Open', 'Write', 'None'); $probe.Dispose() } catch { $locked = $true }
Write-Output ('{"variant":"approved","selfHash":"sha256:' + $hex + '","lockedDuringRun":' + $locked.ToString().ToLowerInvariant() + '}')
'@
Write-Stub 'os-info.ps1' $identityBody
Write-Stub 'service-status.ps1' "Write-Output ('{""service"":""' + `$Service + '""}')"
Write-Stub 'temp-cleanup.ps1' "Write-Output ('{""days"":""' + `$OlderThanDays + '""}')"
Write-Stub 'disk-space.ps1' "Start-Sleep -Seconds 300; Write-Output '{}'"
Write-Stub 'network-adapters.ps1' "[Console]::Error.WriteLine('stderr $Token'); exit 7"
Write-Stub 'dns-flush.ps1' "Write-Output ('{""big"":""' + ('x' * 5000) + '""}')"
Write-Stub 'recyclebin-clear.ps1' "Write-Output 'これは JSON ではありません'"
Write-Stub 'spooler-restart.ps1' "Write-Output '{}'"
Write-Stub 'not-listed.ps1' "Write-Output '{}'"
Write-Manifest

# ── スタブの HTTP サーバ ──────────────────────────────────────────────
$listenerSocket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listenerSocket.Start()
$port = ([Net.IPEndPoint]$listenerSocket.LocalEndpoint).Port
$listenerSocket.Stop()
$baseUrl = "http://127.0.0.1:$port"

$state = [hashtable]::Synchronized(@{
    Command = $null; Results = [Collections.ArrayList]::Synchronized((New-Object Collections.ArrayList))
    Polls = [Collections.ArrayList]::Synchronized((New-Object Collections.ArrayList)); PollStatus = 200; ResultStatus = 200
    Stop = $false; Token = $Token
  })
$serverPs = [powershell]::Create()
[void]$serverPs.AddScript({
    param($prefix, $state)
    $listener = New-Object Net.HttpListener
    $listener.Prefixes.Add($prefix)
    $listener.Start()
    $state.Started = $true
    while (-not $state.Stop) {
      $pending = $listener.GetContextAsync()
      while (-not $pending.IsCompleted -and -not $state.Stop) { Start-Sleep -Milliseconds 20 }
      if ($state.Stop) { break }
      $ctx = $pending.Result
      $req = $ctx.Request
      $res = $ctx.Response
      $headers = @{}
      foreach ($key in $req.Headers.AllKeys) { $headers[$key.ToLowerInvariant()] = $req.Headers[$key] }
      if ($req.HttpMethod -eq 'GET') {
        [void]$state.Polls.Add($headers)
        $res.StatusCode = [int]$state.PollStatus
        if ($state.PollStatus -ne 200) {
          $bytes = [Text.Encoding]::UTF8.GetBytes('{"error":"echo ' + $state.Token + '"}')
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } elseif ($null -eq $state.Command) {
          $res.StatusCode = 204
        } else {
          $bytes = [Text.Encoding]::UTF8.GetBytes((@{ ok = $true; command = $state.Command } | ConvertTo-Json -Depth 8))
          $state.Command = $null
          $res.ContentType = 'application/json; charset=utf-8'
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
      } else {
        $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        [void]$state.Results.Add(@{ path = $req.Url.AbsolutePath; body = $body; headers = $headers })
        $res.StatusCode = [int]$state.ResultStatus
        $bytes = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
        $res.ContentType = 'application/json'
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      $res.Close()
    }
    $listener.Stop()
  }).AddArgument("$baseUrl/").AddArgument($state)
$serverHandle = $serverPs.BeginInvoke()
$deadline = (Get-Date).AddSeconds(10)
while (-not $state['Started'] -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }

function Set-TestConfig {
  param([hashtable]$Over = @{}, [string]$Mode = '600')
  $cfg = [ordered]@{
    url = "$baseUrl/api/device/agent"; deviceToken = $Token; browserDeviceId = $DeviceId
    cfAccessClientId = 'cf-id'; cfAccessClientSecret = $CfSecret; proxySecret = 'proxy-secret-not-a-secret'
  }
  foreach ($key in $Over.Keys) {
    if ($null -eq $Over[$key]) { $cfg.Remove($key) } else { $cfg[$key] = $Over[$key] }
  }
  if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
  [IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json))
  & chmod $Mode $configPath
}

$script:AllLogs = New-Object Text.StringBuilder

function Invoke-Agent {
  param([string[]]$Extra = @())
  $out = Join-Path $root 'out.log'
  $err = Join-Path $root 'err.log'
  $self = (Get-Process -Id $PID).Path
  $proc = Start-Process -FilePath $self -PassThru -Wait -RedirectStandardOutput $out -RedirectStandardError $err `
    -ArgumentList (@('-NoProfile', '-NonInteractive', '-File', $agentPath, '-Once', '-ConfigPath', $configPath) + $Extra)
  $log = [IO.File]::ReadAllText($out) + [IO.File]::ReadAllText($err)
  [void]$script:AllLogs.Append($log)
  return @{ Exit = $proc.ExitCode; Log = $log }
}

function New-TestCommand {
  param([string]$SkillId = 'spooler.status', [hashtable]$Over = @{})
  $command = [ordered]@{
    id = [Guid]::NewGuid().ToString(); op_id = $SkillId; params = @{}; skill_id = $SkillId
    skill_version = '1.0.0'; skill_content_hash = $ContentHash; device_id = $DeviceId
  }
  foreach ($key in $Over.Keys) { $command[$key] = $Over[$key] }
  return $command
}

# コマンドを 1 件渡してエージェントを 1 回動かし、結果と実行の有無を返す。
function Invoke-Case {
  param([object]$Command, [string]$Marker = '')
  Get-ChildItem -LiteralPath $markerDir | Remove-Item -Force
  $state.Results.Clear()
  $state.Command = $Command
  $run = Invoke-Agent
  $body = $null
  if ($state.Results.Count -gt 0) { $body = $state.Results[0].body | ConvertFrom-Json }
  $ran = $false
  if ($Marker) { $ran = Test-Path -LiteralPath (Join-Path $markerDir ($Marker + '.ran')) }
  return @{ Run = $run; Body = $body; Ran = $ran; Count = $state.Results.Count; Result = $(if ($state.Results.Count) { $state.Results[0] } else { $null }) }
}

try {
  Set-TestConfig

  # ── 許可 ─────────────────────────────────────────────────────────
  $case = Invoke-Case (New-TestCommand) 'spooler-status.ps1'
  Assert-Equal 'allowed: exit' 0 $case.Run.Exit
  Assert-True 'allowed: 実行した' $case.Ran
  Assert-True 'allowed: ok' ($case.Body.ok -eq $true) $case.Run.Log
  Assert-Equal 'allowed: 結果' 'Running' $case.Body.result.normalized.status
  Assert-Equal 'allowed: 日本語（UTF-8）' '模擬' $case.Body.result.normalized.stub
  Assert-Equal 'allowed: Linux は実端末と申告しない' 'mock' $case.Body.result.executionSource
  Assert-Equal 'allowed: exitCode' 0 $case.Body.result.exitCode
  Assert-Equal 'allowed: deviceId' $DeviceId $case.Body.result.deviceId
  Assert-True 'allowed: durationMs' ($case.Body.result.durationMs -ge 1)
  Assert-Equal 'allowed: x-device-id（取得）' $DeviceId $state.Polls[$state.Polls.Count - 1]['x-device-id']
  Assert-Equal 'allowed: x-device-id（報告）' $DeviceId $case.Result.headers['x-device-id']
  Assert-Equal 'allowed: x-device-token' $Token $case.Result.headers['x-device-token']
  Assert-Equal 'allowed: CF ヘッダ' 'cf-id' $case.Result.headers['cf-access-client-id']
  Assert-True 'allowed: 報告先' ($case.Result.path -like '/api/device/command/*/result')

  # ── 引数 ─────────────────────────────────────────────────────────
  $case = Invoke-Case (New-TestCommand 'service.status' @{ params = @{ service = 'W32Time' } }) 'service-status.ps1'
  Assert-Equal 'args: service' 'W32Time' $case.Body.result.normalized.service
  $case = Invoke-Case (New-TestCommand 'temp.cleanup' @{ params = @{ olderThanDays = 7 } }) 'temp-cleanup.ps1'
  Assert-Equal 'args: days' '7' $case.Body.result.normalized.days
  foreach ($bad in @('Spooler; Remove-Item x', 'spooler', '-Service', '')) {
    $case = Invoke-Case (New-TestCommand 'service.status' @{ params = @{ service = $bad } }) 'service-status.ps1'
    Assert-True ('args: 拒否 ' + $bad) (-not $case.Ran -and $case.Body.ok -eq $false)
  }
  foreach ($bad in @(0, 31, '7', 1.5, $true)) {
    $case = Invoke-Case (New-TestCommand 'temp.cleanup' @{ params = @{ olderThanDays = $bad } }) 'temp-cleanup.ps1'
    Assert-True ('args: 拒否 days ' + [string]$bad) (-not $case.Ran -and $case.Body.ok -eq $false)
  }

  # ── ハッシュ不一致 ──────────────────────────────────────────────
  $case = Invoke-Case (New-TestCommand 'spooler.status' @{ skill_content_hash = 'sha256:' + ('d' * 64) }) 'spooler-status.ps1'
  Assert-True 'hash: contentHash 不一致' (-not $case.Ran -and $case.Body.ok -eq $false -and $case.Body.error -like '*定義のハッシュ*')
  $case = Invoke-Case (New-TestCommand 'spooler.status' @{ skill_content_hash = $null }) 'spooler-status.ps1'
  Assert-True 'hash: contentHash なし' (-not $case.Ran -and $case.Body.ok -eq $false)
  $case = Invoke-Case (New-TestCommand 'spooler.status' @{ skill_version = '9.9.9' }) 'spooler-status.ps1'
  Assert-True 'hash: 版違い' (-not $case.Ran -and $case.Body.error -like '*承認されていない*')

  $statusPath = Join-Path $skillsDir 'spooler-status.ps1'
  $original = [IO.File]::ReadAllBytes($statusPath)
  $crlf = [Text.Encoding]::UTF8.GetBytes(([Text.Encoding]::UTF8.GetString($original) -replace "`n", "`r`n"))
  [IO.File]::WriteAllBytes($statusPath, $crlf)
  $case = Invoke-Case (New-TestCommand) 'spooler-status.ps1'
  Assert-True 'hash: CRLF は別のバイト列なので実行しない' (-not $case.Ran -and $case.Body.error -like '*スクリプトのハッシュ*')
  [IO.File]::WriteAllBytes($statusPath, [Text.Encoding]::UTF8.GetBytes('Write-Output ''{"evil":1}'''))
  $case = Invoke-Case (New-TestCommand) 'spooler-status.ps1'
  Assert-True 'hash: 改変は実行しない' ($case.Body.ok -eq $false -and $case.Body.error -like '*スクリプトのハッシュ*')
  Remove-Item -LiteralPath $statusPath -Force
  $case = Invoke-Case (New-TestCommand) 'spooler-status.ps1'
  Assert-True 'hash: ファイルなし' ($case.Body.ok -eq $false)
  [IO.File]::WriteAllBytes($statusPath, $original)
  $savedManifest = [IO.File]::ReadAllBytes($manifestPath)
  [IO.File]::WriteAllText($manifestPath, '{ broken')
  $case = Invoke-Case (New-TestCommand) 'spooler-status.ps1'
  Assert-True 'hash: manifest が壊れていれば実行しない' (-not $case.Ran -and $case.Body.ok -eq $false)
  [IO.File]::WriteAllBytes($manifestPath, $savedManifest)

  # ── 未知の Skill ────────────────────────────────────────────────
  $case = Invoke-Case (New-TestCommand 'not.listed') 'not-listed.ps1'
  Assert-True 'unknown: manifest にあっても許可リスト外は実行しない' (-not $case.Ran -and $case.Body.ok -eq $false -and $case.Body.error -like '*未知の Skill*')
  $case = Invoke-Case (New-TestCommand 'SPOOLER.STATUS') 'spooler-status.ps1'
  Assert-True 'unknown: 大文字小文字違い' (-not $case.Ran -and $case.Body.error -like '*未知の Skill*')
  $case = Invoke-Case (New-TestCommand 'spooler.restart') 'spooler-restart.ps1'
  Assert-True 'unknown: 昇格必須は standard で実行しない' (-not $case.Ran -and $case.Body.ok -eq $false)
  $case = Invoke-Case @{ id = [Guid]::NewGuid().ToString(); op_id = 'RUN_ANYTHING'; command = 'Remove-Item -Recurse C:\'; params = @{} }
  Assert-True 'unknown: コマンド文字列は実行しない' ($case.Body.ok -eq $false -and $case.Body.error -like '*未対応の操作*')

  # ── 失敗と上限 ──────────────────────────────────────────────────
  $case = Invoke-Case (New-TestCommand 'network.adapters')
  Assert-True 'fail: 終了コード' ($case.Body.ok -eq $false -and $case.Body.error -like '*終了コード 7*')
  Assert-True 'fail: 報告にトークンを出さない' (-not $case.Result.body.Contains($Token))
  $case = Invoke-Case (New-TestCommand 'recyclebin.clear')
  Assert-True 'fail: JSON でない出力' ($case.Body.ok -eq $false -and $case.Body.error -like '*JSON*')
  $case = Invoke-Case (New-TestCommand 'dns.flush')
  Assert-True 'limit: 報告は 2000 字まで' ($case.Body.result.stdoutSummary.Length -eq 2000)

  # ── 出所 / 既存の SPOOLER_RESTART / 204 / DryRun ────────────────
  $state.Results.Clear(); $state.Command = $null
  $run = Invoke-Agent
  Assert-True 'poll: コマンドなしは報告しない' ($run.Exit -eq 0 -and $state.Results.Count -eq 0) $run.Log
  $state.Command = New-TestCommand
  Get-ChildItem -LiteralPath $markerDir | Remove-Item -Force
  $run = Invoke-Agent -Extra @('-DryRun')
  Assert-True 'dry-run: 実行も報告もしない' ($state.Results.Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $markerDir 'spooler-status.ps1.ran')))

  # ── サーバ応答にトークンがあってもログに出さない ───────────────
  $state.PollStatus = 500
  $run = Invoke-Agent
  Assert-Equal 'poll: 失敗は終了コード 1' 1 $run.Exit
  $state.PollStatus = 200
  $state.ResultStatus = 403
  $case = Invoke-Case (New-TestCommand)
  Assert-True 'report: 拒否されても落ちない' ($case.Run.Exit -eq 0 -and $case.Count -ge 1)
  $state.ResultStatus = 200

  # ── タイムアウト（実時間 60 秒） ───────────────────────────────
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $case = Invoke-Case (New-TestCommand 'disk.space')
  $watch.Stop()
  Assert-True 'timeout: 失敗を報告' ($case.Body.ok -eq $false -and $case.Body.error -like '*タイムアウト*60000ms*') ([string]$case.Body.error)
  Assert-True 'timeout: 60 秒で止める' ($watch.Elapsed.TotalSeconds -ge 59 -and $watch.Elapsed.TotalSeconds -lt 90) ([string]$watch.Elapsed.TotalSeconds)
  $stray = @(Get-Process | Where-Object { $_.Id -ne $PID -and $_.ProcessName -like 'pwsh*' -and
      (& ps -o args= -p $_.Id 2>$null) -like '*disk-space.ps1*' })
  Assert-Equal 'timeout: プロセスが残らない' 0 $stray.Count

  # ── ローカル保持期限（通信なしで判定する。docs/66 §7） ──────────
  $contactPath = $configPath + '.last-contact'
  function Set-FileAge {
    param([string]$Path, [double]$Hours)
    [IO.File]::SetLastWriteTimeUtc($Path, [DateTime]::UtcNow.AddHours(-1 * $Hours))
  }
  Set-TestConfig
  if (Test-Path -LiteralPath $contactPath) { Remove-Item -LiteralPath $contactPath -Force }
  $state.Command = $null
  $run = Invoke-Agent
  Assert-True 'retention: 通信できたら時刻を記録する' (Test-Path -LiteralPath $contactPath) $run.Log

  Set-FileAge -Path $configPath -Hours 300
  Set-FileAge -Path $contactPath -Hours 167
  $polled = $state.Polls.Count
  $run = Invoke-Agent
  Assert-Equal 'retention: 期限内は動く' 0 $run.Exit
  Assert-True 'retention: 期限内は通信する' ($state.Polls.Count -gt $polled)
  Assert-True 'retention: 期限内は消さない' (Test-Path -LiteralPath $configPath)
  Assert-True 'retention: 通信できたら更新する' (([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($contactPath)).TotalHours -lt 1)

  Set-FileAge -Path $configPath -Hours 300
  Set-FileAge -Path $contactPath -Hours 100
  $state.PollStatus = 500
  $run = Invoke-Agent
  Assert-True 'retention: 通信の失敗では更新しない' (([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($contactPath)).TotalHours -gt 99)
  $state.PollStatus = 401
  $run = Invoke-Agent
  Assert-True 'retention: 認証の失敗でも更新しない' (([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($contactPath)).TotalHours -gt 99)
  $state.PollStatus = 200

  Set-FileAge -Path $configPath -Hours 300
  Set-FileAge -Path $contactPath -Hours 169
  $state.Results.Clear()
  $state.Command = New-TestCommand
  $polled = $state.Polls.Count
  $run = Invoke-Agent -Extra @('-DryRun')
  Assert-Equal 'retention: DryRun も期限切れで止まる' 3 $run.Exit
  Assert-Equal 'retention: DryRun は通信しない' $polled $state.Polls.Count
  Assert-True 'retention: DryRun は消さない' (Test-Path -LiteralPath $configPath)

  $run = Invoke-Agent
  Assert-Equal 'retention: 期限切れは成功でない終了コード' 3 $run.Exit
  Assert-Equal 'retention: 通信しない' $polled $state.Polls.Count
  Assert-True 'retention: 設定ファイル（トークン）を消す' (-not (Test-Path -LiteralPath $configPath))
  Assert-True 'retention: 記録も消す' (-not (Test-Path -LiteralPath $contactPath))
  Assert-Equal 'retention: 報告しない' 0 $state.Results.Count
  Assert-True 'retention: 成功や停止確認と書かない' ($run.Log -like '*停止の確認ではありません*' -and $run.Log -notlike '*done*')
  Assert-True 'retention: トークンを出さない' (-not $run.Log.Contains($Token))
  $run = Invoke-Agent
  Assert-True 'retention: 消した後は起動しない' ($run.Exit -eq 1 -and $state.Polls.Count -eq $polled)

  # 記録が無ければ設定ファイルの時刻を起点にする（一度も通信しないまま持ち続けない）。
  Set-TestConfig
  Set-FileAge -Path $configPath -Hours 169
  $run = Invoke-Agent
  Assert-True 'retention: 記録なしで古い設定は消す' ($run.Exit -eq 3 -and -not (Test-Path -LiteralPath $configPath))
  # 発行し直した設定は、古い記録で消さない。
  Set-TestConfig
  [IO.File]::WriteAllText($contactPath, 'contact')
  Set-FileAge -Path $contactPath -Hours 500
  $run = Invoke-Agent
  Assert-Equal 'retention: 新しい設定は動く' 0 $run.Exit
  # 時計が戻って未来の記録になっても期限を延ばさない。
  [IO.File]::SetLastWriteTimeUtc($contactPath, [DateTime]::UtcNow.AddHours(48))
  [IO.File]::SetLastWriteTimeUtc($configPath, [DateTime]::UtcNow.AddHours(-300))
  $run = Invoke-Agent
  Assert-True 'retention: 未来の記録は期限切れとして扱う' ($run.Exit -eq 3 -and -not (Test-Path -LiteralPath $configPath))
  Set-TestConfig

  # ── 起動時の拒否 ────────────────────────────────────────────────
  $polled = $state.Polls.Count
  Set-TestConfig -Mode '644'
  $run = Invoke-Agent
  Assert-True 'acl: 緩い設定ファイルは止まる' ($run.Exit -eq 1 -and $run.Log -like '*本人だけ*') $run.Log
  Assert-Equal 'acl: 通信しない' $polled $state.Polls.Count
  Set-TestConfig -Over @{ deviceToken = $null }
  $run = Invoke-Agent
  Assert-True 'config: トークンなし' ($run.Exit -eq 1)
  Set-TestConfig -Over @{ agentPrivilege = 'admin' }
  $run = Invoke-Agent
  Assert-True 'config: admin は対象外' ($run.Exit -eq 1 -and $run.Log -like '*standard 専用*')
  Set-TestConfig -Over @{ url = 'http://helpdesk.example.test/api/device/agent' }
  $run = Invoke-Agent
  Assert-True 'config: http の外部宛は止まる' ($run.Exit -eq 1 -and $run.Log -like '*https*')
  if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
  [IO.File]::WriteAllText($configPath, ('{ broken "deviceToken": "' + $Token + '"'))
  & chmod 600 $configPath
  $run = Invoke-Agent
  Assert-True 'config: 壊れた JSON の本文を出さない' ($run.Exit -eq 1 -and -not $run.Log.Contains($Token))
  Assert-Equal 'config: 通信しない' $polled $state.Polls.Count
  Set-TestConfig

  # ── トークンがログに出ない（ここまでの全ログ） ─────────────────
  $logs = $script:AllLogs.ToString()
  Assert-True 'log: 記録がある' ($logs.Length -gt 100)
  Assert-True 'log: デバイストークンを出さない' (-not $logs.Contains($Token))
  Assert-True 'log: CF シークレットを出さない' (-not $logs.Contains($CfSecret))
  Assert-True 'log: proxy シークレットを出さない' (-not $logs.Contains('proxy-secret-not-a-secret'))

  # ── 関数の試験（同じプロセスへ読み込む） ─────────────────────────
  . $agentPath -NoMain -ConfigPath $configPath -Once

  # SYSTEM の拒否。実トークンは Windows が要るので、識別子の取得だけを差し替える。
  function Get-CurrentIdentitySid { return 'S-1-5-18' }
  $polled = $state.Polls.Count
  $threw = ''
  try { Invoke-AgentMain | Out-Null } catch { $threw = $_.Exception.Message }
  Assert-True 'system: SYSTEM では起動しない' ($threw -like '*サービスアカウント*') $threw
  Assert-Equal 'system: 通信しない' $polled $state.Polls.Count
  foreach ($sid in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'unix-uid-0')) {
    Assert-True ('system: 拒否 ' + $sid) (Test-IsForbiddenIdentity -Sid $sid)
  }
  Assert-True 'system: 一般ユーザーは通す' (-not (Test-IsForbiddenIdentity -Sid 'S-1-5-21-1-2-3-1001'))

  # 出所の分岐。設定や引数で変える手段が無いことはソースで確かめる。
  Assert-Equal 'source: Windows' 'endpoint_agent' (Get-ExecutionSource -OnWindows $true)
  Assert-Equal 'source: それ以外' 'mock' (Get-ExecutionSource -OnWindows $false)

  # 保持期限の境界。
  $base = [DateTimeOffset]::Parse('2026-11-01T00:00:00Z')
  Assert-True 'retention: 168 時間ちょうどは期限切れ' (Test-LocalRetentionExpired -RecordTime $base -Now $base.AddHours(168) -Hours 168)
  Assert-True 'retention: 168 時間より前は期限内' (-not (Test-LocalRetentionExpired -RecordTime $base -Now $base.AddHours(167.9) -Hours 168))
  Assert-True 'retention: 24 時間を超える未来' (Test-LocalRetentionExpired -RecordTime $base.AddHours(25) -Now $base -Hours 168)
  Assert-True 'retention: 24 時間以内の未来は期限内' (-not (Test-LocalRetentionExpired -RecordTime $base.AddHours(23) -Now $base -Hours 168))

  # Windows の ACL の評価。
  $user = 'S-1-5-21-1-2-3-1001'
  $private = @([pscustomobject]@{ Sid = $user; Type = 'Allow' }, [pscustomobject]@{ Sid = 'S-1-5-18'; Type = 'Allow' })
  Assert-Equal 'acl: 本人のみ' '' (Get-AclEntriesProblem -Entries $private -OwnerSid $user -UserSid $user)
  foreach ($other in @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-21-1-2-3-1002')) {
    $wide = $private + [pscustomobject]@{ Sid = $other; Type = 'Allow' }
    Assert-True ('acl: 拒否 ' + $other) ([bool](Get-AclEntriesProblem -Entries $wide -OwnerSid $user -UserSid $user))
  }
  $denied = $private + [pscustomobject]@{ Sid = 'S-1-1-0'; Type = 'Deny' }
  Assert-Equal 'acl: Deny は問題にしない' '' (Get-AclEntriesProblem -Entries $denied -OwnerSid $user -UserSid $user)
  Assert-True 'acl: 他人の所有' ([bool](Get-AclEntriesProblem -Entries $private -OwnerSid 'S-1-5-21-1-2-3-1002' -UserSid $user))

  # 5.1 で使う引数の引用（実際の起動は Windows が要る）。
  Assert-Equal 'quote: そのまま' '-File' (ConvertTo-WindowsArgument -Value '-File')
  Assert-Equal 'quote: 空白' '"C:\Users\山田 太郎\a.ps1"' (ConvertTo-WindowsArgument -Value 'C:\Users\山田 太郎\a.ps1')
  Assert-Equal 'quote: 引用符' '"a\"b"' (ConvertTo-WindowsArgument -Value 'a"b')
  Assert-Equal 'quote: 末尾の円記号' '"a b\\"' (ConvertTo-WindowsArgument -Value 'a b\')
  Assert-Equal 'quote: 空' '""' (ConvertTo-WindowsArgument -Value '')

  # 既存の SPOOLER_RESTART は挙動を変えない（Restart-Service だけ差し替える）。
  $script:RestartArgs = $null
  function Restart-Service { param($Name, [switch]$Force) $script:RestartArgs = "$Name/$Force" }
  $state.Results.Clear()
  $state.Command = @{ id = [Guid]::NewGuid().ToString(); op_id = 'SPOOLER_RESTART'; params = @{} }
  Import-AgentConfig -Path $configPath
  Invoke-CommandTick
  Assert-Equal 'spooler: Restart-Service' 'Spooler/True' $script:RestartArgs
  $spooler = $state.Results[0].body | ConvertFrom-Json
  Assert-Equal 'spooler: opId' 'SPOOLER_RESTART' $spooler.result.opId
  Assert-Equal 'spooler: platform' 'win32' $spooler.result.platform
  Assert-True 'spooler: 出所を足さない' ($null -eq $spooler.result.PSObject.Properties['executionSource'])

  # ── 検査と実行の同一性（TOCTOU。docs/66 §8） ─────────────────────
  # ここより後ろで $agentSource を読み込むと本物の Skill を指す。差替えは一時配置だけに行う。
  if (-not (Get-SkillsRoot).StartsWith($root)) { throw '試験の配置が一時フォルダを指していません' }
  $probePath = Join-Path $skillsDir 'os-info.ps1'
  $probeOriginal = [IO.File]::ReadAllBytes($probePath)
  $probeHash = Get-Sha256Hex -Path $probePath
  $probeText = [Text.Encoding]::UTF8.GetString($probeOriginal)
  $probeCommand = [pscustomobject]@{ skill_id = 'os.info'; skill_version = '1.0.0'; skill_content_hash = $ContentHash }
  function Write-AgentLog { param([string]$Message) [void]$script:AllLogs.Append((Protect-Text $Message)) }

  function Test-ExclusiveOpenDenied {
    param([string]$Path)
    try {
      $handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch {
      return $true
    }
    $handle.Dispose()
    return $false
  }

  # 排他オープンで上書きする。Linux で親のハンドルに拒否されるのはこの形の書込みだけ。
  function Invoke-ExclusiveOverwrite {
    param([string]$Path, [byte[]]$Bytes)
    try {
      $handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch {
      return 'denied'
    }
    try {
      $handle.SetLength(0)
      $handle.Write($Bytes, 0, $Bytes.Length)
    } finally {
      $handle.Dispose()
    }
    return 'written'
  }

  # 継ぎ目。本番の経路に分岐を足さず、検査の直後と子の終了の直後に割り込む。
  $script:RealInvokeSkillProcess = ${function:Invoke-SkillProcess}
  $script:BeforeChild = $null
  $script:AfterChild = $null
  function Invoke-SkillProcess {
    param([string]$ScriptPath, [string[]]$Arguments)
    if ($script:BeforeChild) { & $script:BeforeChild $ScriptPath }
    $run = & $script:RealInvokeSkillProcess -ScriptPath $ScriptPath -Arguments $Arguments
    if ($script:AfterChild) { & $script:AfterChild $ScriptPath }
    return $run
  }
  $script:RealOpenStream = $null
  if (Test-Path -LiteralPath 'function:Open-SkillScriptStream') { $script:RealOpenStream = ${function:Open-SkillScriptStream} }
  $script:OpenHook = $null
  $script:OpenCalls = 0
  function Open-SkillScriptStream {
    param([string]$Path)
    $script:OpenCalls++
    if ($script:OpenHook) { return (& $script:OpenHook $Path) }
    return (& $script:RealOpenStream -Path $Path)
  }

  function Invoke-TickCase {
    param([object]$Command, [string]$Marker = '')
    Get-ChildItem -LiteralPath $markerDir | Remove-Item -Force
    $state.Results.Clear()
    $state.Command = $Command
    $script:HeldAtChildEnd = $null
    Invoke-CommandTick
    $body = $null
    if ($state.Results.Count -gt 0) { $body = $state.Results[0].body | ConvertFrom-Json }
    $normalized = Get-JsonProperty (Get-JsonProperty $body 'result') 'normalized'
    return @{
      Ok = (Get-JsonProperty $body 'ok'); Error = [string](Get-JsonProperty $body 'error'); Normalized = $normalized
      Ran = ($Marker -and (Test-Path -LiteralPath (Join-Path $markerDir ($Marker + '.ran'))))
    }
  }

  # 子の終了の時点でハンドルを持っているか、終わった後に閉じたか。
  $script:AfterChild = { param($path) $script:HeldAtChildEnd = (Test-ExclusiveOpenDenied -Path $path) }

  $swaps = [ordered]@{
    '差替え（別の内容）' = [Text.Encoding]::UTF8.GetBytes($probeText.Replace('"variant":"approved"', '"variant":"evil"'))
    '改行変更（LF→CRLF）' = [Text.Encoding]::UTF8.GetBytes($probeText.Replace("`n", "`r`n"))
    '配布更新（新版への上書き）' = [Text.Encoding]::UTF8.GetBytes($probeText.Replace('"variant":"approved"', '"variant":"v2"'))
  }
  foreach ($name in $swaps.Keys) {
    $script:SwapBytes = $swaps[$name]
    $script:SwapResult = ''
    $script:BeforeChild = { param($path) $script:SwapResult = Invoke-ExclusiveOverwrite -Path $path -Bytes $script:SwapBytes }
    $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
    $script:BeforeChild = $null
    $label = 'swap(Linux は排他オープンの書込み) ' + $name
    Assert-Equal ($label + ': 書込みを拒否') 'denied' $script:SwapResult
    Assert-Equal ($label + ': 承認の版を実行') 'approved' (Get-JsonProperty $case.Normalized 'variant')
    Assert-Equal ($label + ': 実行したバイト列') $probeHash (Get-JsonProperty $case.Normalized 'selfHash')
    Assert-Equal ($label + ': ファイルは変わらない') $probeHash (Get-Sha256Hex -Path $probePath)
    Assert-Equal ($label + ': 子の実行中はハンドルが開いている') 'True' ([string](Get-JsonProperty $case.Normalized 'lockedDuringRun'))
    Assert-Equal ($label + ': 子の終了時点でハンドルが開いている') 'True' ([string]$script:HeldAtChildEnd)
    Assert-True ($label + ': 終わったら閉じる') (-not (Test-ExclusiveOpenDenied -Path $probePath))
    [IO.File]::WriteAllBytes($probePath, $probeOriginal)
  }

  # ハッシュはパスではなくハンドルから読んだバイト列で計算する。パスとハンドルの中身を食い違わせて確かめる。
  $evilBytes = $swaps['差替え（別の内容）']
  $script:OpenBytes = $evilBytes
  $script:OpenHook = { param($path) New-Object IO.MemoryStream -ArgumentList @(,[byte[]]$script:OpenBytes) }
  $threw = ''
  $resolved = $null
  try { $resolved = Resolve-ApprovedSkillScript -Command $probeCommand } catch { $threw = $_.Exception.Message }
  Assert-True 'handle: ハンドルの中身が承認外なら、パスが正しくても拒否' ($threw -like '*スクリプトのハッシュ*') $threw
  if ($resolved -is [hashtable]) { $resolved.Stream.Dispose() }

  $script:OpenBytes = $probeOriginal
  [IO.File]::WriteAllBytes($probePath, $evilBytes)
  $threw = ''
  $resolved = $null
  try { $resolved = Resolve-ApprovedSkillScript -Command $probeCommand } catch { $threw = $_.Exception.Message }
  Assert-True 'handle: 照合の対象はハンドルの中身（パスの中身は見ない）' ($threw -eq '' -and $resolved -is [hashtable]) $threw
  if ($resolved -is [hashtable]) { $resolved.Stream.Dispose() }
  [IO.File]::WriteAllBytes($probePath, $probeOriginal)
  $script:OpenHook = $null

  # 他者が排他で開いていれば fail-closed（Windows では書込み中の相手もここへ来る）。
  $holder = [IO.File]::Open($probePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  } finally {
    $holder.Dispose()
  }
  Assert-True 'fail-closed: 開けなければ実行しない' (-not $case.Ran)
  Assert-True 'fail-closed: 同じ形で失敗を報告' ($case.Ok -eq $false -and $case.Error -like '*Skill スクリプトを開けません*') $case.Error
  Assert-True 'fail-closed: パスを報告に出さない' (-not $case.Error.Contains($root))

  # シンボリックリンクはハンドルで固定できない（リンク自体を張り替えられる）ので実行しない。
  $moved = $probePath + '.real'
  [IO.File]::Move($probePath, $moved)
  New-Item -ItemType SymbolicLink -Path $probePath -Target $moved | Out-Null
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  Remove-Item -LiteralPath $probePath -Force
  [IO.File]::Move($moved, $probePath)
  Assert-True 'reparse: ファイルがリンクなら実行しない' (-not $case.Ran -and $case.Ok -eq $false) $case.Error
  $movedDir = $skillsDir + '.real'
  [IO.Directory]::Move($skillsDir, $movedDir)
  New-Item -ItemType SymbolicLink -Path $skillsDir -Target $movedDir | Out-Null
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  Remove-Item -LiteralPath $skillsDir -Force
  [IO.Directory]::Move($movedDir, $skillsDir)
  Assert-True 'reparse: フォルダがリンクなら実行しない' (-not $case.Ran -and $case.Ok -eq $false) $case.Error

  # 昇格。Skill は実行しない。SPOOLER_RESTART は従来どおり（Windows 以外の Test-IsElevated は偽のまま）。
  Assert-True 'elevated: Windows 以外は昇格と判定しない' (-not (Test-IsElevated))
  $savedElevated = ${function:Test-IsElevated}
  ${function:Test-IsElevated} = { return $true }
  $script:OpenCalls = 0
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  Assert-True 'elevated: Skill を実行しない' (-not $case.Ran)
  Assert-True 'elevated: 失敗を報告' ($case.Ok -eq $false -and $case.Error -like '*昇格*') $case.Error
  Assert-Equal 'elevated: ファイルを開く前に止める' 0 $script:OpenCalls
  $script:RestartArgs = $null
  $state.Results.Clear()
  $state.Command = @{ id = [Guid]::NewGuid().ToString(); op_id = 'SPOOLER_RESTART'; params = @{} }
  Invoke-CommandTick
  Assert-Equal 'elevated: SPOOLER_RESTART は従来どおり実行' 'Spooler/True' $script:RestartArgs
  Assert-True 'elevated: SPOOLER_RESTART の報告は成功' (($state.Results[0].body | ConvertFrom-Json).ok -eq $true)
  ${function:Test-IsElevated} = { throw '判定できない' }
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  Assert-True 'elevated: 判定に失敗したら Skill を実行しない' (-not $case.Ran -and $case.Ok -eq $false) $case.Error
  ${function:Test-IsElevated} = $savedElevated

  # タイムアウト、出力超過、例外の経路でもハンドルを閉じる。「開いていた」も確かめて、素通りを合格にしない。
  $diskPath = Join-Path $skillsDir 'disk-space.ps1'
  $savedTimeout = $script:SkillTimeoutSeconds
  $script:SkillTimeoutSeconds = 2
  $case = Invoke-TickCase (New-TestCommand 'disk.space') 'disk-space.ps1'
  $script:SkillTimeoutSeconds = $savedTimeout
  Assert-True 'close: タイムアウトを報告' ($case.Ok -eq $false -and $case.Error -like '*タイムアウト*') $case.Error
  Assert-Equal 'close: タイムアウトの停止までハンドルが開いている' 'True' ([string]$script:HeldAtChildEnd)
  Assert-True 'close: タイムアウトの後に閉じる' (-not (Test-ExclusiveOpenDenied -Path $diskPath))

  $dnsPath = Join-Path $skillsDir 'dns-flush.ps1'
  Write-Stub 'dns-flush.ps1' "[Console]::Out.Write('x' * 4096); [Console]::Out.Flush(); Start-Sleep -Seconds 30; Write-Output '{}'"
  Write-Manifest
  $savedKill = $script:OutputKillBytes
  $script:OutputKillBytes = 1024
  $case = Invoke-TickCase (New-TestCommand 'dns.flush') 'dns-flush.ps1'
  $script:OutputKillBytes = $savedKill
  Assert-True 'close: 出力超過を報告' ($case.Ok -eq $false -and $case.Error -like '*出力が上限*') $case.Error
  Assert-Equal 'close: 出力超過の停止までハンドルが開いている' 'True' ([string]$script:HeldAtChildEnd)
  Assert-True 'close: 出力超過の後に閉じる' (-not (Test-ExclusiveOpenDenied -Path $dnsPath))

  $statusPath = Join-Path $skillsDir 'service-status.ps1'
  $case = Invoke-TickCase (New-TestCommand 'service.status' @{ params = @{ service = 'NotAllowed' } }) 'service-status.ps1'
  Assert-True 'close: 引数の拒否を報告' (-not $case.Ran -and $case.Ok -eq $false -and $case.Error -like '*許可されていません*') $case.Error
  Assert-True 'close: 引数の拒否の後に閉じる' (-not (Test-ExclusiveOpenDenied -Path $statusPath))

  $script:HeldBeforeThrow = $null
  $script:BeforeChild = {
    param($path)
    $script:HeldBeforeThrow = (Test-ExclusiveOpenDenied -Path $path)
    throw '子を起動する前の例外'
  }
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  $script:BeforeChild = $null
  Assert-True 'close: 例外を報告' (-not $case.Ran -and $case.Ok -eq $false) $case.Error
  Assert-Equal 'close: 例外の時点ではハンドルが開いている' 'True' ([string]$script:HeldBeforeThrow)
  Assert-True 'close: 例外の後に閉じる' (-not (Test-ExclusiveOpenDenied -Path $probePath))

  $savedExecutable = ${function:Get-PowerShellExecutable}
  ${function:Get-PowerShellExecutable} = { return (Join-Path $root 'no-such-powershell') }
  $case = Invoke-TickCase (New-TestCommand 'os.info') 'os-info.ps1'
  ${function:Get-PowerShellExecutable} = $savedExecutable
  Assert-True 'close: 子を起動できない失敗を報告' (-not $case.Ran -and $case.Ok -eq $false) $case.Error
  Assert-True 'close: 子を起動できない失敗の後に閉じる' (-not (Test-ExclusiveOpenDenied -Path $probePath))
  $script:AfterChild = $null

  # Windows の共有モードでだけ意味を持つ検査。Linux では確かめられないので PASS に数えない。
  $windowsOnly = @(
    'Set-Content の拒否', '[IO.File]::WriteAllBytes の拒否', 'Copy-Item の上書きの拒否', 'Remove-Item の拒否',
    'Move-Item（改名）の拒否', '別ファイルの移動による置換の拒否', '親フォルダの改名の可否',
    'powershell.exe -File（5.1）がハンドルを持ったまま開ける'
  )
  foreach ($name in $windowsOnly) {
    Write-Skip $name 'Windows 実機が要る（scripts/windows/tests/script-identity-windows.ps1）'
  }

  # リポジトリの本物の Skill: 許可リストの全件がバイト列で approved.json と一致する（実行はしない）。
  . $agentSource -NoMain -ConfigPath $configPath
  $realManifest = [IO.File]::ReadAllText((Join-Path (Split-Path -Parent $windowsDir) 'skills/approved.json')) | ConvertFrom-Json
  Assert-Equal 'real: 許可リストは 8 件' 8 $script:SkillScripts.Count
  foreach ($skillId in @($script:SkillScripts.Keys)) {
    $entry = @($realManifest.skills | Where-Object { $_.id -ceq $skillId })[0]
    $resolved = Resolve-ApprovedSkillScript -Command ([pscustomobject]@{
        skill_id = $skillId; skill_version = $entry.version; skill_content_hash = $entry.contentHash
      })
    $resolved.Stream.Dispose()
    Assert-True ('real: ハッシュ一致 ' + $skillId) ((Split-Path -Leaf $resolved.Path) -ceq $script:SkillScripts[$skillId])
    $bytes = [IO.File]::ReadAllBytes($resolved.Path)
    Assert-True ('real: LF のまま ' + $skillId) (-not ([Text.Encoding]::UTF8.GetString($bytes).Contains("`r`n")))
  }

  # ソースの静的な確認。
  $source = [IO.File]::ReadAllText($agentSource)
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($agentSource, [ref]$tokens, [ref]$errors)
  Assert-Equal 'source: 構文エラーなし' 0 @($errors).Count
  Assert-True 'source: Set-StrictMode' ($source -match 'Set-StrictMode -Version Latest')
  Assert-True 'source: パスからの読み直しで照合しない' (-not ($source -match 'ReadAllBytes\(\$scriptPath\)'))
  Assert-True 'source: 共有は読み取りだけ' ($source -match '\[IO\.FileShare\]::Read\)' -and $source -notmatch 'FileShare\]::(ReadWrite|Write|Delete)')
  Assert-True 'source: BOM（5.1 が UTF-8 と解釈する）' ([IO.File]::ReadAllBytes($agentSource)[0] -eq 0xEF)
  foreach ($word in @('Invoke-Expression', 'iex ', 'cmd /c', 'cmd.exe', 'Start-Process', 'executionSource = ''endpoint_agent''')) {
    Assert-True ('source: 使わない ' + $word) (-not $source.Contains($word))
  }
  # 5.1 に無い構文を使わない。
  foreach ($t in $tokens) {
    if ($t.Kind -in @('QuestionQuestion', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark')) {
      Assert-True ('source: 5.1 に無い構文 ' + $t.Text) $false
    }
  }
} finally {
  $state.Stop = $true
  try { [void]$serverPs.EndInvoke($serverHandle) } catch { Write-Output 'server stop failed' }
  $serverPs.Dispose()
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ('passed=' + $script:Passed + ' failed=' + $script:Failed + ' skipped=' + $script:Skipped)
if ($script:Failed -gt 0) { exit 1 }
exit 0
