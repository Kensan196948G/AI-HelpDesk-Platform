#Requires -Version 5.1
<#
.SYNOPSIS
  AI HelpDesk 実端末コマンドエージェント（Windows / Node 不要 / 許可リストのみ）。

.DESCRIPTION
  /api/device/command をポーリングし、承認済みの操作だけを実行して結果を報告する。
  scripts/endpoint-command-agent.mjs と同じ fail-closed にする（docs/66）。

  - skill_id 付きのコマンドは、固定の許可リストにあり、scripts/skills/approved.json の
    id@version、contentHash、scriptHash（ファイルのバイト列の SHA-256）が一致するものだけを実行する。
    CRLF に変わったファイルはハッシュが変わるので実行しない。
  - コマンド文字列は実行しない。引数は検証した値だけを配列で渡す。
  - 既定は standard（本人権限）。昇格必須の Skill と admin は対象外。SYSTEM などのサービス
    アカウントでは起動しない。自分で昇格しない。
  - タイムアウト 60 秒。stdout / stderr は 64KB まで。報告は最大 2,000 字。
  - 結果の出所は Windows では endpoint_agent。Windows 以外（試験用）は mock と申告する。
    出所を設定や引数で変える手段は置かない（本番のサーバは mock を拒否する）。
  - トークンは画面とログに出さない。設定ファイルは本人だけが読める ACL でなければ止まる。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\command-agent.ps1 -Once `
    -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"

.NOTES
  既存の SPOOLER_RESTART（skill_id なし）の動作は変えていない。管理者権限が必要な場合がある。
#>
param(
  [string]$ConfigPath = "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json",
  [int]$IntervalSeconds = 5,
  [switch]$Once,
  [switch]$DryRun,
  # 試験で関数だけを読み込むためのスイッチ（skill-run.tests.ps1 と同じ作法）。
  [switch]$NoMain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SkillTimeoutSeconds = 60
$script:OutputLimitBytes = 64 * 1024
$script:OutputKillBytes = 1024 * 1024
$script:SummaryLimitChars = 2000
$script:Secrets = @()
$script:Headers = @{}
$script:CommandUrl = ''
$script:ReportedDeviceId = ''

# 許可リスト（standard）。endpoint-command-agent.mjs の SKILL_SCRIPTS から昇格必須を除いたもの。
# PowerShell の @{} は大文字小文字を区別しないので、序数比較の Dictionary を使う。
$script:SkillScripts = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
$script:SkillScripts.Add('os.info', 'os-info.ps1')
$script:SkillScripts.Add('disk.space', 'disk-space.ps1')
$script:SkillScripts.Add('spooler.status', 'spooler-status.ps1')
$script:SkillScripts.Add('service.status', 'service-status.ps1')
$script:SkillScripts.Add('network.adapters', 'network-adapters.ps1')
$script:SkillScripts.Add('recyclebin.clear', 'recyclebin-clear.ps1')
$script:SkillScripts.Add('temp.cleanup', 'temp-cleanup.ps1')
$script:SkillScripts.Add('dns.flush', 'dns-flush.ps1')

$script:ServiceNames = @('Spooler', 'W32Time', 'Winmgmt')
$script:TempCleanupMinDays = 1
$script:TempCleanupMaxDays = 30
# 本人権限の原則。SYSTEM、LOCAL SERVICE、NETWORK SERVICE では動かさない。
$script:ForbiddenSids = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'unix-uid-0')
# 設定ファイルの ACL に残ってよい相手（本人のほか、SYSTEM と Administrators）。
$script:AclAllowedSids = @('S-1-5-18', 'S-1-5-32-544')

function Test-IsWindowsHost {
  return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
}

function Get-ExecutionSource {
  param([bool]$OnWindows = (Test-IsWindowsHost))
  if ($OnWindows) { return 'endpoint_agent' }
  return 'mock'
}

function Protect-Text {
  param([AllowNull()][object]$Text)
  $value = [string]$Text
  foreach ($secret in $script:Secrets) {
    if ($secret) { $value = $value.Replace([string]$secret, '[masked]') }
  }
  return ($value -replace 'aihd_[A-Za-z0-9_\-]+', '[masked]')
}

function Write-AgentLog {
  param([string]$Message)
  Write-Host ('[{0}] {1}' -f (Get-Date -Format o), (Protect-Text $Message))
}

function Get-TruncatedText {
  param([AllowNull()][object]$Text, [int]$Limit)
  $value = [string]$Text
  if ($value.Length -le $Limit) { return $value }
  return $value.Substring(0, $Limit)
}

function Get-JsonProperty {
  param([AllowNull()][object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-CurrentIdentitySid {
  if (Test-IsWindowsHost) {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  }
  return 'unix-uid-' + [string](& id -u)
}

function Test-IsForbiddenIdentity {
  param([string]$Sid)
  return $script:ForbiddenSids -ccontains $Sid
}

function Test-IsElevated {
  if (-not (Test-IsWindowsHost)) { return $false }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 設定ファイルの許可の評価（純粋関数）。問題があれば理由を返す。無ければ空文字。
function Get-AclEntriesProblem {
  param([object[]]$Entries, [string]$OwnerSid, [string]$UserSid)
  if ($OwnerSid -cne $UserSid -and $script:AclAllowedSids -cnotcontains $OwnerSid) {
    return '所有者が本人ではありません'
  }
  foreach ($entry in $Entries) {
    if ([string]$entry.Type -ne 'Allow') { continue }
    $sid = [string]$entry.Sid
    if ($sid -ceq $UserSid -or $script:AclAllowedSids -ccontains $sid) { continue }
    return '本人以外に許可があります: ' + $sid
  }
  return ''
}

function Get-ConfigAclProblem {
  param([string]$Path)
  if (Test-IsWindowsHost) {
    $acl = Get-Acl -LiteralPath $Path
    $entries = @()
    foreach ($rule in $acl.Access) {
      try {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      } catch {
        return '解決できない相手に許可があります'
      }
      $entries += [pscustomobject]@{ Sid = $sid; Type = [string]$rule.AccessControlType }
    }
    $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    return (Get-AclEntriesProblem -Entries $entries -OwnerSid $owner -UserSid (Get-CurrentIdentitySid))
  }
  # Windows 以外（試験用）は mode の group / other を見る。
  $mode = [string](& stat -c '%a' -- $Path)
  if ($mode -notmatch '^[0-7]?[0-7]00$') { return 'group / other に許可があります: ' + $mode }
  return ''
}

function Import-AgentConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "設定ファイルが見つかりません: $Path"
  }
  $problem = Get-ConfigAclProblem -Path $Path
  if ($problem) {
    throw "設定ファイルは本人だけが読めるようにしてください（docs/66）。$problem"
  }
  try {
    # 例外の文面に本文（トークン）が入らないよう、理由を出さない。
    $cfg = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  } catch {
    throw '設定ファイルを JSON として読めません。'
  }

  $token = Get-JsonProperty $cfg 'deviceToken'
  if (-not $token) { throw "deviceToken が設定されていません: $Path" }
  $script:Secrets = @(
    $token,
    (Get-JsonProperty $cfg 'adminDeviceToken'),
    (Get-JsonProperty $cfg 'cfAccessClientSecret'),
    (Get-JsonProperty $cfg 'proxySecret')
  ) | Where-Object { $_ }

  $privilege = Get-JsonProperty $cfg 'agentPrivilege'
  if ($privilege -and ([string]$privilege).Trim().ToLowerInvariant() -cne 'standard') {
    throw 'このエージェントは standard 専用です（admin は対象外）。'
  }

  $url = Get-JsonProperty $cfg 'commandUrl'
  if (-not $url) { $url = Get-JsonProperty $cfg 'url' }
  if (-not $url) { throw "url が設定されていません: $Path" }
  $base = (([string]$url) -replace '/api/device/(agent|command)/?$', '').TrimEnd('/')
  if ($base -notmatch '^https://' -and $base -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?$') {
    throw 'url は https にしてください（トークンを平文で送らない）。'
  }
  $script:CommandUrl = "$base/api/device/command"

  $script:Headers = @{ Accept = 'application/json'; 'x-device-token' = [string]$token }
  $browserDeviceId = ([string](Get-JsonProperty $cfg 'browserDeviceId')).Trim()
  if ($browserDeviceId) {
    $script:Headers['x-device-id'] = $browserDeviceId
    $script:ReportedDeviceId = $browserDeviceId
  } else {
    Write-AgentLog '警告: browserDeviceId が未設定のため x-device-id を送りません（サーバは配信しません）'
    $configured = Get-JsonProperty $cfg 'deviceId'
    if ($configured) { $script:ReportedDeviceId = [string]$configured }
    else { $script:ReportedDeviceId = [string]$env:COMPUTERNAME }
  }
  $clientId = Get-JsonProperty $cfg 'cfAccessClientId'
  if ($clientId) {
    $script:Headers['CF-Access-Client-Id'] = [string]$clientId
    $script:Headers['CF-Access-Client-Secret'] = [string](Get-JsonProperty $cfg 'cfAccessClientSecret')
  }
  $proxySecret = Get-JsonProperty $cfg 'proxySecret'
  if ($proxySecret) { $script:Headers['x-proxy-secret'] = [string]$proxySecret }
}

function Get-SkillsRoot {
  return (Join-Path (Split-Path -Parent $PSScriptRoot) 'skills')
}

function Get-BytesSha256 {
  param([byte[]]$Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Bytes)
  } finally {
    $sha.Dispose()
  }
  return 'sha256:' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
}

function Get-ApprovedSkill {
  param([string]$Key)
  $manifestPath = Join-Path (Get-SkillsRoot) 'approved.json'
  try {
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  } catch {
    throw '承認 manifest を読めません（scripts/skills/approved.json）。'
  }
  foreach ($entry in @(Get-JsonProperty $manifest 'skills')) {
    if (('{0}@{1}' -f (Get-JsonProperty $entry 'id'), (Get-JsonProperty $entry 'version')) -ceq $Key) {
      return $entry
    }
  }
  return $null
}

# 実行してよいかを確かめ、スクリプトのパスを返す。一致しなければ例外。
function Resolve-ApprovedSkillScript {
  param([object]$Command)
  $skillId = [string](Get-JsonProperty $Command 'skill_id')
  $version = [string](Get-JsonProperty $Command 'skill_version')
  $key = "$skillId@$version"
  if (-not $script:SkillScripts.ContainsKey($skillId)) {
    throw "未知の Skill です（このエージェントの許可リストにありません）: $skillId"
  }
  $approved = Get-ApprovedSkill -Key $key
  if ($null -eq $approved) { throw "承認されていない Skill です: $key" }
  $contentHash = [string](Get-JsonProperty $Command 'skill_content_hash')
  if (-not $contentHash -or $contentHash -cne [string](Get-JsonProperty $approved 'contentHash')) {
    throw "Skill 定義のハッシュが一致しません: $key"
  }
  $scriptPath = Join-Path (Join-Path (Get-SkillsRoot) 'windows') $script:SkillScripts[$skillId]
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Skill スクリプトのハッシュが一致しません: $key"
  }
  # 文字列ではなくバイト列で照合する。改行を CRLF に変えたファイルは一致しない。
  $localHash = Get-BytesSha256 -Bytes ([IO.File]::ReadAllBytes($scriptPath))
  if ($localHash -cne [string](Get-JsonProperty $approved 'scriptHash')) {
    throw "Skill スクリプトのハッシュが一致しません: $key"
  }
  return $scriptPath
}

# 型付きパラメータから引数配列への唯一の変換点。許可値と整数範囲だけを通す。
function Get-SkillArguments {
  param([string]$SkillId, [AllowNull()][object]$Params)
  if ($SkillId -ceq 'service.status') {
    $service = ([string](Get-JsonProperty $Params 'service')).Trim()
    if ($script:ServiceNames -cnotcontains $service) {
      throw 'service.status の service が許可されていません'
    }
    return @('-Service', $service)
  }
  if ($SkillId -ceq 'temp.cleanup') {
    $days = Get-JsonProperty $Params 'olderThanDays'
    if (-not ($days -is [int] -or $days -is [long])) {
      throw 'temp.cleanup の olderThanDays は整数で指定してください'
    }
    if ($days -lt $script:TempCleanupMinDays -or $days -gt $script:TempCleanupMaxDays) {
      throw 'temp.cleanup の olderThanDays は範囲外です'
    }
    return @('-OlderThanDays', [string]$days)
  }
  return @()
}

function Get-PowerShellExecutable {
  if (Test-IsWindowsHost) {
    # PATH に依存しない。mjs の 'powershell.exe' と同じ本体を絶対パスで指定する。
    return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  }
  return (Get-Process -Id $PID).Path
}

# Windows の引数規則に従って 1 つの引数を引用する（.NET Framework に ArgumentList が無いため）。
function ConvertTo-WindowsArgument {
  param([string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') { $backslashes++; continue }
    if ($char -eq '"') {
      [void]$builder.Append('\', 2 * $backslashes + 1)
    } elseif ($backslashes -gt 0) {
      [void]$builder.Append('\', $backslashes)
    }
    $backslashes = 0
    [void]$builder.Append($char)
  }
  if ($backslashes -gt 0) { [void]$builder.Append('\', 2 * $backslashes) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Stop-ProcessTree {
  param([Diagnostics.Process]$Process)
  try {
    if (Test-IsWindowsHost) {
      $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
      & $taskkill /T /F /PID $Process.Id 2>&1 | Out-Null
    } else {
      $Process.Kill($true)
    }
  } catch {
    try { $Process.Kill() } catch { Write-AgentLog 'プロセスを停止できませんでした' }
  }
  try { [void]$Process.WaitForExit(5000) } catch { Write-AgentLog 'プロセスの終了を確認できませんでした' }
}

function New-StreamReader {
  param([IO.Stream]$Stream)
  $buffer = New-Object byte[] 8192
  return @{
    Stream = $Stream
    Buffer = $buffer
    Task = $Stream.ReadAsync($buffer, 0, $buffer.Length)
    Kept = New-Object IO.MemoryStream
    Total = [long]0
    Done = $false
  }
}

function Update-StreamReader {
  param([hashtable]$Reader)
  while (-not $Reader.Done -and $Reader.Task.IsCompleted) {
    if ($Reader.Task.IsFaulted -or $Reader.Task.IsCanceled) { $Reader.Done = $true; break }
    $count = [int]$Reader.Task.Result
    if ($count -le 0) { $Reader.Done = $true; break }
    $Reader.Total += $count
    $room = $script:OutputLimitBytes - [int]$Reader.Kept.Length
    if ($room -gt 0) { $Reader.Kept.Write($Reader.Buffer, 0, [Math]::Min($room, $count)) }
    $Reader.Task = $Reader.Stream.ReadAsync($Reader.Buffer, 0, $Reader.Buffer.Length)
  }
}

# 引数は配列で渡す。シェルを介さず、文字列を連結して解釈させない。
function Invoke-SkillProcess {
  param([string]$ScriptPath, [string[]]$Arguments)
  $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Get-PowerShellExecutable
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if ($null -ne $psi.PSObject.Properties['ArgumentList']) {
    foreach ($item in $argv) { $psi.ArgumentList.Add($item) }
  } else {
    $psi.Arguments = (($argv | ForEach-Object { ConvertTo-WindowsArgument -Value $_ }) -join ' ')
  }

  $watch = [Diagnostics.Stopwatch]::StartNew()
  $process = [Diagnostics.Process]::Start($psi)
  try {
    $process.StandardInput.Close()
    $out = New-StreamReader -Stream $process.StandardOutput.BaseStream
    $err = New-StreamReader -Stream $process.StandardError.BaseStream
    $timedOut = $false
    $overflow = $false
    while ($true) {
      Update-StreamReader -Reader $out
      Update-StreamReader -Reader $err
      if ($process.HasExited -and $out.Done -and $err.Done) { break }
      if ($watch.Elapsed.TotalSeconds -ge $script:SkillTimeoutSeconds) { $timedOut = $true; break }
      if ($out.Total -gt $script:OutputKillBytes -or $err.Total -gt $script:OutputKillBytes) {
        $overflow = $true
        break
      }
      Start-Sleep -Milliseconds 50
    }
    if ($timedOut -or $overflow) {
      Stop-ProcessTree -Process $process
    } else {
      $process.WaitForExit()
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    $exitCode = $null
    if ($process.HasExited) { $exitCode = $process.ExitCode }
    return @{
      TimedOut = $timedOut
      Overflow = $overflow
      ExitCode = $exitCode
      Stdout = $utf8.GetString($out.Kept.ToArray())
      Stderr = $utf8.GetString($err.Kept.ToArray())
      DurationMs = [long]$watch.ElapsedMilliseconds
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-SkillCommand {
  param([object]$Command)
  $scriptPath = Resolve-ApprovedSkillScript -Command $Command
  $skillId = [string](Get-JsonProperty $Command 'skill_id')
  $arguments = @(Get-SkillArguments -SkillId $skillId -Params (Get-JsonProperty $Command 'params'))
  Write-AgentLog ('skill {0} {1} {2}' -f (Get-JsonProperty $Command 'id'), $skillId, (Get-JsonProperty $Command 'skill_version'))

  $run = Invoke-SkillProcess -ScriptPath $scriptPath -Arguments $arguments
  if ($run.TimedOut) {
    throw "Skill の実行がタイムアウトしました（$skillId, $($script:SkillTimeoutSeconds * 1000)ms）"
  }
  if ($run.Overflow) { throw "Skill の出力が上限を超えました（$skillId）" }
  if ($run.ExitCode -ne 0) {
    $detail = Get-TruncatedText -Text $run.Stderr.Trim() -Limit 500
    throw "Skill が終了コード $($run.ExitCode) で失敗しました（$skillId）: $detail"
  }
  $stdout = $run.Stdout.Trim()
  try {
    $normalized = $stdout | ConvertFrom-Json
  } catch {
    throw "Skill の出力を JSON として解析できませんでした（$skillId）"
  }
  if ($normalized -isnot [Management.Automation.PSCustomObject]) {
    throw "Skill の出力が JSON オブジェクトではありません（$skillId）"
  }
  return [ordered]@{
    # 結果の出所。Windows 以外（試験用）は実端末の結果に見せない。サーバは本番で mock を拒否する。
    executionSource = (Get-ExecutionSource)
    normalized = $normalized
    stdoutSummary = (Protect-Text (Get-TruncatedText -Text $stdout -Limit $script:SummaryLimitChars))
    stderrSummary = (Protect-Text (Get-TruncatedText -Text $run.Stderr.Trim() -Limit $script:SummaryLimitChars))
    exitCode = $run.ExitCode
    durationMs = $run.DurationMs
    deviceId = $script:ReportedDeviceId
  }
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Uri, [AllowNull()][object]$Payload)
  $arguments = @{
    Uri = $Uri
    Method = $Method
    Headers = $script:Headers
    TimeoutSec = 30
    UseBasicParsing = $true
  }
  if ($null -ne $Payload) {
    # 5.1 は文字列の本文を UTF-8 で送らないのでバイト列で渡す。
    $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 20 -Compress))
    $arguments.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @arguments
}

function Send-CommandResult {
  param([string]$Id, [object]$Outcome)
  Invoke-AgentRequest -Method 'Post' -Uri "$($script:CommandUrl)/$Id/result" -Payload $Outcome | Out-Null
}

function Invoke-CommandTick {
  try {
    $response = Invoke-AgentRequest -Method 'Get' -Uri $script:CommandUrl -Payload $null
  } catch {
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response -and
      [int]$_.Exception.Response.StatusCode -eq 204) { return }
    throw
  }
  $command = Get-JsonProperty $response 'command'
  if ($null -eq $command) { return }
  $id = [string](Get-JsonProperty $command 'id')
  $opId = [string](Get-JsonProperty $command 'op_id')
  $skillId = [string](Get-JsonProperty $command 'skill_id')
  Write-AgentLog "command $id $opId"
  if ($DryRun) {
    Write-AgentLog 'dry-run: 実行しません'
    return
  }

  try {
    if ($skillId) {
      $result = Invoke-SkillCommand -Command $command
    } elseif ($opId -ceq 'SPOOLER_RESTART') {
      # 既存の経路（skill_id なし）。挙動を変えない。
      Restart-Service -Name Spooler -Force
      $result = @{ opId = 'SPOOLER_RESTART'; platform = 'win32'; executedAt = (Get-Date).ToString('o') }
    } else {
      throw "未対応の操作です: $opId"
    }
    Send-CommandResult -Id $id -Outcome @{ ok = $true; result = $result }
    Write-AgentLog "done $id"
  } catch {
    $message = Get-TruncatedText -Text (Protect-Text $_.Exception.Message) -Limit $script:SummaryLimitChars
    try {
      Send-CommandResult -Id $id -Outcome @{ ok = $false; error = $message }
    } catch {
      Write-AgentLog "report error $id"
    }
    Write-AgentLog "failed ${id}: $message"
  }
}

function Invoke-AgentMain {
  # 5.1 の既定は TLS 1.2 を含まないことがある（Cloudflare へ接続できない）。
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $sid = Get-CurrentIdentitySid
  if (Test-IsForbiddenIdentity -Sid $sid) {
    throw 'SYSTEM などのサービスアカウントでは実行しません（本人権限の原則。docs/66）。'
  }
  Import-AgentConfig -Path $ConfigPath
  if (Test-IsElevated) {
    Write-AgentLog '警告: 昇格したプロセスで動いています。本人の通常の権限で起動してください'
  }
  $interval = [Math]::Max(1, $IntervalSeconds)
  Write-AgentLog "command-agent start: $($script:CommandUrl) source=$(Get-ExecutionSource)"
  while ($true) {
    try {
      Invoke-CommandTick
    } catch {
      Write-AgentLog ('poll error: ' + $_.Exception.Message)
      if ($Once) { return 1 }
    }
    if ($Once) { return 0 }
    Start-Sleep -Seconds $interval
  }
}

if (-not $NoMain) {
  try {
    exit (Invoke-AgentMain)
  } catch {
    Write-AgentLog ('起動できません: ' + $_.Exception.Message)
    exit 1
  }
}
