#Requires -Version 5.1
<#
.SYNOPSIS
  Windows のログオン時 + 一定間隔で端末情報コレクタを実行するタスクを登録する。

.DESCRIPTION
  常駐エージェントではなく、タスクスケジューラから collect-pc-info.ps1 を1回実行する。
  Node.js は不要。設定ファイル（deviceToken / browserDeviceId）を
  %LOCALAPPDATA%\AIHelpDesk にコピーしてからタスクを登録する。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-collector-task.ps1 `
    -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\ai-helpdesk\device-agent-windows.json'),
  [int]$IntervalMinutes = 60,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

try {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "設定ファイルが見つかりません: $ConfigPath"
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $config.url) { throw '設定ファイルに url がありません。' }
  if (-not $config.deviceToken) { throw '設定ファイルに deviceToken がありません。' }
  if (-not $config.browserDeviceId) {
    Write-Warning 'browserDeviceId が未設定です。この場合、PC情報はブラウザ端末にリンクされず表示されません。'
  }

  $targetDir = Join-Path $env:LOCALAPPDATA 'AIHelpDesk'
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $collectorSource = Join-Path $PSScriptRoot 'collect-pc-info.ps1'
  if (-not (Test-Path -LiteralPath $collectorSource)) {
    throw "collect-pc-info.ps1 が見つかりません: $collectorSource"
  }
  $collectorTarget = Join-Path $targetDir 'collect-pc-info.ps1'
  $configTarget = Join-Path $targetDir 'device-agent-windows.json'
  Copy-Item -LiteralPath $collectorSource -Destination $collectorTarget -Force
  Copy-Item -LiteralPath $ConfigPath -Destination $configTarget -Force

  $taskName = 'AIHelpDesk-Collector'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -ConfigPath "{1}"' -f $collectorTarget, $configTarget
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
  $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes ([Math]::Max(5, $IntervalMinutes))) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName $taskName -Action $action `
    -Trigger @($logonTrigger, $repeatTrigger) -Settings $settings `
    -Description 'AI HelpDesk 端末情報コレクタ（読み取り専用・常駐なし）' `
    -RunLevel Limited -Force | Out-Null

  if (-not $NoStart) {
    Start-ScheduledTask -TaskName $taskName
  }

  Write-Output ('[install] task={0} interval={1}min config={2}' -f $taskName, [Math]::Max(5, $IntervalMinutes), $configTarget)
  Write-Output ('[install] log={0}' -f (Join-Path $targetDir 'collector.log'))
  Write-Output '[install] 手動実行: Start-ScheduledTask -TaskName AIHelpDesk-Collector'
} catch {
  Write-Error ('[install] ERROR ' + $_.Exception.Message)
  exit 1
}
