#Requires -Version 5.1
<#
.SYNOPSIS
  command-agent.ps1 の「検査したバイト列と実行されるバイト列の同一性」を Windows 実機で確かめる（docs/66 §8）。

.DESCRIPTION
  Linux の FileShare は助言ロックなので、書込み、削除、改名の拒否は Windows でしか確かめられない。
  その実機確認だけを行う単体のスクリプト。

  - 触るのは新しい一時フォルダの中だけ。エージェントもその中へ写して読み込むので、実 Skill、approved.json、
    本番の設定、トークンを読まない。通信しない。終わったら一時フォルダを消す。
  - Skill は模擬（自分のバイト列のハッシュを報告するだけ）で、端末の状態を変えない。
  - 拒否の検査は陽性対照つき。ハンドルを持つ間に拒否され、閉じた後に同じ操作が成功したときだけ PASS にする。
    引数の誤りなどで失敗しているだけのものを PASS に数えない。
  - 標準出力は JSON 1 つ。パス、ユーザー名、例外の本文は出さない（例外は型名だけ）。

  昇格していない本人権限で実行する。昇格していると Skill の経路は拒否されるので、その確認だけをして ok=false を返す。
  終了コード: 0 = すべて PASS、1 = FAIL あり、2 = Windows 以外で実行した。

.PARAMETER ProbeOnNonWindows
  Windows 以外で手順そのものが最後まで動くかを確かめる（試験用）。結果は実機の確認にならないので
  platformValid=false、ok=false を返す。Linux では拒否の検査は FAIL になる。

.EXAMPLE
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\windows\tests\script-identity-windows.ps1
#>
param(
  [switch]$ProbeOnNonWindows
)

$ErrorActionPreference = 'Stop'
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$checks = New-Object Collections.ArrayList
$script:ChildVersion = ''

function Add-Check {
  param([string]$Name, [string]$Status, [string]$Detail = '')
  [void]$checks.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail })
}

function Write-Report {
  param([string]$Reason = '', [bool]$Elevated = $false)
  $passed = @($checks | Where-Object { $_.status -ceq 'PASS' }).Count
  $failed = @($checks | Where-Object { $_.status -ceq 'FAIL' }).Count
  $skipped = @($checks | Where-Object { $_.status -ceq 'SKIP' }).Count
  $ok = $onWindows -and (-not $Elevated) -and (-not $Reason) -and $failed -eq 0 -and $passed -gt 0
  # 戻り値と混ざらないよう、パイプラインではなく標準出力へ直接書く。
  $json = [ordered]@{
        schema = 1
        ok = $ok
        platformValid = $onWindows
        reason = $Reason
        psVersion = $PSVersionTable.PSVersion.ToString()
        psEdition = [string]$PSVersionTable.PSEdition
        childPsVersion = $script:ChildVersion
        isElevated = $Elevated
        passed = $passed
        failed = $failed
        skipped = $skipped
        checks = @($checks)
      } | ConvertTo-Json -Depth 5 -Compress
  [Console]::Out.WriteLine($json)
  return $ok
}

if (-not $onWindows -and -not $ProbeOnNonWindows) {
  [void](Write-Report -Reason 'not-windows')
  exit 2
}

# 例外の本文にはパスが入る。型名だけを鎖の順に返す。
function Get-ExceptionTypes {
  param([Exception]$Exception)
  $names = @()
  while ($null -ne $Exception) {
    $names += $Exception.GetType().Name
    $Exception = $Exception.InnerException
  }
  return ($names -join '>')
}

$runId = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) ('script identity 確認 ' + $runId)
$exitCode = 1
try {
  # ── 一時の配置（空白と日本語を含むパス。実機の引数の引用も通る） ─────
  $agentDir = Join-Path $root 'scripts\windows'
  $skillsDir = Join-Path $root 'scripts\skills\windows'
  if (-not $onWindows) {
    $agentDir = Join-Path $root 'scripts/windows'
    $skillsDir = Join-Path $root 'scripts/skills/windows'
  }
  New-Item -ItemType Directory -Path $agentDir, $skillsDir -Force | Out-Null
  $agentCopy = Join-Path $agentDir 'command-agent.ps1'
  Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'command-agent.ps1') -Destination $agentCopy

  $probeText = @'
$self = [IO.File]::ReadAllBytes($PSCommandPath)
$sha = [Security.Cryptography.SHA256]::Create()
$hex = ([BitConverter]::ToString($sha.ComputeHash($self))).Replace('-', '').ToLowerInvariant()
$locked = $false
try { $probe = [IO.File]::Open($PSCommandPath, 'Open', 'Write', 'None'); $probe.Dispose() } catch { $locked = $true }
Write-Output ('{"variant":"approved","selfHash":"sha256:' + $hex + '","lockedDuringRun":' + $locked.ToString().ToLowerInvariant() + ',"psVersion":"' + $PSVersionTable.PSVersion.ToString() + '"}')
'@
  $utf8 = New-Object Text.UTF8Encoding($false)
  $probePath = Join-Path $skillsDir 'os-info.ps1'
  $sleepPath = Join-Path $skillsDir 'disk-space.ps1'
  $probeBytes = $utf8.GetBytes($probeText.Replace("`r`n", "`n"))
  [IO.File]::WriteAllBytes($probePath, $probeBytes)
  [IO.File]::WriteAllBytes($sleepPath, $utf8.GetBytes("Start-Sleep -Seconds 300`nWrite-Output '{}'`n"))

  # エージェントを読み込む（Main は動かさない）。ログは標準出力へ出さない。
  . $agentCopy -NoMain -ConfigPath (Join-Path $root 'no-config.json') -Once
  function Write-AgentLog { param([string]$Message) }
  # 一時フォルダの親は 8.3 形式のことがあるので、前方一致ではなく一意の名前で確かめる。
  if (-not (Get-SkillsRoot).Contains($runId)) { throw '一時の配置を指していません' }

  $contentHash = 'sha256:' + ('c' * 64)
  $probeHash = Get-BytesSha256 -Bytes $probeBytes
  $manifest = @{
    version = 1
    skills = @(
      [ordered]@{ id = 'os.info'; version = '1.0.0'; contentHash = $contentHash; scriptHash = $probeHash },
      [ordered]@{ id = 'disk.space'; version = '1.0.0'; contentHash = $contentHash; scriptHash = (Get-BytesSha256 -Bytes ([IO.File]::ReadAllBytes($sleepPath))) }
    )
  }
  [IO.File]::WriteAllText((Join-Path (Get-SkillsRoot) 'approved.json'), ($manifest | ConvertTo-Json -Depth 5))

  function New-ProbeCommand {
    param([string]$SkillId = 'os.info')
    return [pscustomobject]@{
      id = [Guid]::NewGuid().ToString(); skill_id = $SkillId; skill_version = '1.0.0'
      skill_content_hash = $contentHash; params = @{}
    }
  }

  # 実際の昇格の有無。昇格していれば拒否だけを確かめて終わる（書込みの検査を管理者権限で流さない）。
  $elevated = Test-IsElevated
  if ($elevated) {
    try {
      [void](Invoke-SkillCommand -Command (New-ProbeCommand))
      Add-Check 'elevated_real_refused' 'FAIL' 'skill ran'
    } catch {
      if ($_.Exception.Message -like '*昇格*') { Add-Check 'elevated_real_refused' 'PASS' }
      else { Add-Check 'elevated_real_refused' 'FAIL' (Get-ExceptionTypes $_.Exception) }
    }
    [void](Write-Report -Reason 'run-unelevated' -Elevated $true)
    exit 1
  }

  # ── 1. ハンドルを持ったまま、本物の子プロセスが開いて実行できる ─────
  try {
    $result = Invoke-SkillCommand -Command (New-ProbeCommand)
    $normalized = $result['normalized']
    $script:ChildVersion = [string](Get-JsonProperty $normalized 'psVersion')
    if ((Get-JsonProperty $normalized 'selfHash') -ceq $probeHash -and (Get-JsonProperty $normalized 'lockedDuringRun') -eq $true) {
      Add-Check 'child_opens_while_handle_held' 'PASS'
    } else {
      Add-Check 'child_opens_while_handle_held' 'FAIL' 'bytes or lock mismatch'
    }
  } catch {
    Add-Check 'child_opens_while_handle_held' 'FAIL' (Get-ExceptionTypes $_.Exception)
  }

  # ── 2. ハンドルを持つ間の拒否（閉じた後の成功を陽性対照にする） ─────
  $operations = [ordered]@{
    set_content = { param($target, $caseDir) Set-Content -LiteralPath $target -Value 'x' }
    write_all_bytes = { param($target, $caseDir) [IO.File]::WriteAllBytes($target, [byte[]](65, 66)) }
    copy_item_overwrite = { param($target, $caseDir) Copy-Item -LiteralPath (Join-Path $caseDir 'new.ps1') -Destination $target -Force }
    remove_item = { param($target, $caseDir) Remove-Item -LiteralPath $target -Force }
    move_item_rename = { param($target, $caseDir) Move-Item -LiteralPath $target -Destination ($target + '.moved') }
    move_item_replace = { param($target, $caseDir) Move-Item -LiteralPath (Join-Path $caseDir 'new.ps1') -Destination $target -Force }
    file_replace = { param($target, $caseDir) [IO.File]::Replace((Join-Path $caseDir 'new.ps1'), $target, (Join-Path $caseDir 'backup.ps1')) }
    rename_parent_folder = { param($target, $caseDir) Rename-Item -LiteralPath (Split-Path -Parent $target) -NewName 'renamed' }
    rename_grandparent_folder = { param($target, $caseDir) Rename-Item -LiteralPath (Split-Path -Parent (Split-Path -Parent $target)) -NewName 'renamed2' }
  }
  $index = 0
  foreach ($name in $operations.Keys) {
    $index++
    $caseDir = Join-Path $root ("ops$index")
    $folder = Join-Path (Join-Path $caseDir 'skills') 'windows'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $target = Join-Path $folder 'target.ps1'
    [IO.File]::WriteAllBytes($target, $probeBytes)
    [IO.File]::WriteAllBytes((Join-Path $caseDir 'new.ps1'), $utf8.GetBytes("Write-Output 'new'`n"))

    $stream = Open-SkillScriptStream -Path $target
    $denied = ''
    $intact = $false
    try {
      try {
        & $operations[$name] $target $caseDir
      } catch {
        $denied = Get-ExceptionTypes $_.Exception
      }
      if (Test-Path -LiteralPath $target) {
        $intact = (Get-BytesSha256 -Bytes ([IO.File]::ReadAllBytes($target))) -ceq $probeHash
      }
    } finally {
      $stream.Dispose()
    }
    if (-not $denied) {
      Add-Check $name 'FAIL' 'not denied while handle held'
      continue
    }
    if (-not $intact) {
      Add-Check $name 'FAIL' ('denied but file changed: ' + $denied)
      continue
    }
    try {
      & $operations[$name] $target $caseDir
      Add-Check $name 'PASS' $denied
    } catch {
      Add-Check $name 'FAIL' ('control failed after release: ' + (Get-ExceptionTypes $_.Exception))
    }
  }

  # ── 3. 検査の直後の差替え（実際の経路で、承認のバイト列が実行される） ──
  $script:RealInvokeSkillProcess = ${function:Invoke-SkillProcess}
  $script:BeforeChild = $null
  function Invoke-SkillProcess {
    param([string]$ScriptPath, [string[]]$Arguments)
    if ($script:BeforeChild) { & $script:BeforeChild $ScriptPath }
    return (& $script:RealInvokeSkillProcess -ScriptPath $ScriptPath -Arguments $Arguments)
  }
  $swaps = [ordered]@{
    swap_other_content = $utf8.GetBytes($probeText.Replace("`r`n", "`n").Replace('"variant":"approved"', '"variant":"evil"'))
    swap_lf_to_crlf = $utf8.GetBytes($probeText.Replace("`r`n", "`n").Replace("`n", "`r`n"))
    swap_new_version = $utf8.GetBytes($probeText.Replace("`r`n", "`n").Replace('"variant":"approved"', '"variant":"v2"'))
  }
  foreach ($name in $swaps.Keys) {
    $script:SwapBytes = $swaps[$name]
    $script:SwapDenied = ''
    $script:BeforeChild = {
      param($path)
      try { [IO.File]::WriteAllBytes($path, $script:SwapBytes) } catch { $script:SwapDenied = Get-ExceptionTypes $_.Exception }
    }
    try {
      $normalized = (Invoke-SkillCommand -Command (New-ProbeCommand))['normalized']
      if ($script:SwapDenied -and (Get-JsonProperty $normalized 'variant') -ceq 'approved' -and (Get-JsonProperty $normalized 'selfHash') -ceq $probeHash) {
        Add-Check $name 'PASS' $script:SwapDenied
      } else {
        Add-Check $name 'FAIL' 'unapproved bytes ran or write not denied'
      }
    } catch {
      Add-Check $name 'FAIL' (Get-ExceptionTypes $_.Exception)
    }
    $script:BeforeChild = $null
    [IO.File]::WriteAllBytes($probePath, $probeBytes)
  }

  # ── 4. 他者が書込みで開いていれば fail-closed ───────────────────────
  $writer = [IO.File]::Open($probePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  try {
    try {
      [void](Invoke-SkillCommand -Command (New-ProbeCommand))
      Add-Check 'fail_closed_when_writer_open' 'FAIL' 'skill ran'
    } catch {
      if ($_.Exception.Message -like '*開けません*') { Add-Check 'fail_closed_when_writer_open' 'PASS' }
      else { Add-Check 'fail_closed_when_writer_open' 'FAIL' (Get-ExceptionTypes $_.Exception) }
    }
  } finally {
    $writer.Dispose()
  }

  # ── 5. タイムアウトの停止の後にハンドルを閉じる（taskkill の経路） ───
  $savedTimeout = $script:SkillTimeoutSeconds
  $script:SkillTimeoutSeconds = 3
  try {
    [void](Invoke-SkillCommand -Command (New-ProbeCommand 'disk.space'))
    Add-Check 'handle_released_after_timeout' 'FAIL' 'no timeout'
  } catch {
    $message = $_.Exception.Message
    try {
      $probeHandle = [IO.File]::Open($sleepPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $probeHandle.Dispose()
      if ($message -like '*タイムアウト*') { Add-Check 'handle_released_after_timeout' 'PASS' }
      else { Add-Check 'handle_released_after_timeout' 'FAIL' 'other failure' }
    } catch {
      Add-Check 'handle_released_after_timeout' 'FAIL' (Get-ExceptionTypes $_.Exception)
    }
  }
  $script:SkillTimeoutSeconds = $savedTimeout

  # ── 6. リンクの拒否（ジャンクションは一般ユーザーでも作れる） ──────────
  if ($onWindows) {
    $realFolder = $skillsDir + '.real'
    [IO.Directory]::Move($skillsDir, $realFolder)
    try {
      New-Item -ItemType Junction -Path $skillsDir -Target $realFolder | Out-Null
      try {
        [void](Invoke-SkillCommand -Command (New-ProbeCommand))
        Add-Check 'junction_refused' 'FAIL' 'skill ran'
      } catch {
        if ($_.Exception.Message -like '*リンク*') { Add-Check 'junction_refused' 'PASS' }
        else { Add-Check 'junction_refused' 'FAIL' (Get-ExceptionTypes $_.Exception) }
      }
      [IO.Directory]::Delete($skillsDir)
    } finally {
      [IO.Directory]::Move($realFolder, $skillsDir)
    }
  } else {
    Add-Check 'junction_refused' 'SKIP' 'windows only'
  }

  # ── 7. 昇格の拒否の分岐（判定だけ差し替える。実際の昇格は上で確かめる） ─
  $savedElevated = ${function:Test-IsElevated}
  ${function:Test-IsElevated} = { return $true }
  try {
    [void](Invoke-SkillCommand -Command (New-ProbeCommand))
    Add-Check 'elevated_branch_refused' 'FAIL' 'skill ran'
  } catch {
    if ($_.Exception.Message -like '*昇格*') { Add-Check 'elevated_branch_refused' 'PASS' }
    else { Add-Check 'elevated_branch_refused' 'FAIL' (Get-ExceptionTypes $_.Exception) }
  }
  ${function:Test-IsElevated} = $savedElevated

  if (Write-Report) { $exitCode = 0 } else { $exitCode = 1 }
} catch {
  Add-Check 'fatal' 'FAIL' (Get-ExceptionTypes $_.Exception)
  [void](Write-Report -Reason 'fatal')
  $exitCode = 1
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
exit $exitCode
