#Requires -Version 5.1
<#
.SYNOPSIS
  支援セッションの Skill を、ヘルパーの状態フォルダ（ACL は本人のみ）へコピーする。

.DESCRIPTION
  install-folder-helper.ps1 はヘルパー本体だけをコピーする。skill_run にはこのスクリプトも必要。
  実行時のハッシュ検証はヘルパーが行う（サーバ署名の scriptHash と一致しなければ実行しない）。
  検証専用の Skill は -IncludeVerification を指定したときだけ配置する（無ければ SCRIPT_MISSING で実行されない）。
  管理者権限は不要。Windows での動作は未実測。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-assist-skills.ps1
#>
[CmdletBinding()]
param(
  [switch]$IncludeVerification,
  [string]$SourceDirectory
)

$ErrorActionPreference = 'Stop'

try {
  $helperScript = Join-Path $PSScriptRoot 'folder-helper.ps1'
  if (-not (Test-Path -LiteralPath $helperScript)) { throw 'folder-helper.ps1 が見つかりません。' }
  . $helperScript -NoMain

  $identity = Get-CurrentIdentityInfo
  $refusal = Get-StartupRefusal -Sid $identity.Sid -IsAdministrator $identity.IsAdministrator -LanguageMode ([string]$ExecutionContext.SessionState.LanguageMode)
  if ($null -ne $refusal) { throw ('このアカウント・権限では配置しません（' + $refusal + '）。') }

  if ([string]::IsNullOrEmpty($SourceDirectory)) {
    $SourceDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'skills\windows'
  }
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($name in 'folder-summary.ps1', 'disk-space.ps1', 'user-marker-status.ps1') { $files.Add($name) }
  if ($IncludeVerification) {
    foreach ($name in 'user-marker-set.ps1', 'user-marker-clear.ps1', 'diag-sleep.ps1') { $files.Add($name) }
  }

  $stateDir = Initialize-StateDirectory -Sid $identity.Sid
  $skillsDir = Get-SkillsDirectory
  if (-not (Test-Path -LiteralPath $skillsDir)) { New-Item -ItemType Directory -Path $skillsDir | Out-Null }
  $info = New-Object IO.DirectoryInfo -ArgumentList $skillsDir
  if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Skill フォルダがリンクです。' }
  foreach ($name in $files) {
    Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination ($skillsDir + '\' + $name) -Force
  }
  Write-Output ('[install-skills] copied={0} state={1}' -f $files.Count, (Split-Path -Leaf $stateDir))
} catch {
  Write-Error ('[install-skills] ERROR ' + $_.Exception.Message)
  exit 1
}
