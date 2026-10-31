#Requires -Version 5.1
<#
.SYNOPSIS
  本人同意付きフォルダ一覧ヘルパーを、実行ユーザー本人のログオン時タスクとして登録する。

.DESCRIPTION
  管理者権限は不要。パスワードを扱わない。RunLevel は Limited、LogonType は Interactive。
  ヘルパーを本人のみの状態フォルダへコピーし、前面で登録してペアリングコードを本人の画面に表示する。
  手順と実機での確認項目は docs/62-consented-folder-access.md §9。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-folder-helper.ps1 -ServerUrl https://helpdesk.example.com
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ServerUrl,
  [switch]$AllowInsecureHttp,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

try {
  $sourceScript = Join-Path $PSScriptRoot 'folder-helper.ps1'
  if (-not (Test-Path -LiteralPath $sourceScript)) { throw 'folder-helper.ps1 が見つかりません。' }
  # param の変数を上書きしないように同じ値を渡してドットソースする。
  . $sourceScript -ServerUrl $ServerUrl -AllowInsecureHttp:$AllowInsecureHttp -NoMain

  $identity = Get-CurrentIdentityInfo
  $refusal = Get-StartupRefusal -Sid $identity.Sid -IsAdministrator $identity.IsAdministrator -LanguageMode ([string]$ExecutionContext.SessionState.LanguageMode)
  if ($null -ne $refusal) {
    throw ('このアカウント・権限では登録しません（' + $refusal + '）。本人の標準権限のウィンドウで実行してください。')
  }
  if (-not (Test-ServerUrl -Url $ServerUrl -AllowInsecure ([bool]$AllowInsecureHttp))) {
    throw 'ServerUrl が不正です。https のベース URL を指定してください（http は -AllowInsecureHttp を明示）。'
  }
  if ($AllowInsecureHttp) { Write-Warning 'http を許可しています。検証環境以外で使わないでください。' }

  Initialize-NativeInterop
  $stateDir = Initialize-StateDirectory -Sid $identity.Sid
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $targetScript = $stateDir + '\folder-helper.ps1'
  Copy-Item -LiteralPath $sourceScript -Destination $targetScript -Force
  Write-HelperConfig -ServerBase $ServerUrl -AllowInsecure ([bool]$AllowInsecureHttp)
  Remove-StateFile -Name 'revoked.flag'

  if ($null -eq (Read-HelperToken)) {
    $registered = Invoke-HelperRegistration -ServerBase $ServerUrl -Identity $identity -InBackground $false
    if (-not $registered.Ok) { throw 'サーバへの登録に失敗しました。接続先を確認してください。' }
  } else {
    Write-Host '登録済みのトークンがあるので再登録しません。やり直す場合は uninstall-folder-helper.ps1 を先に実行してください。'
  }

  $taskName = Get-HelperTaskName -Sid $identity.Sid
  $powershellExe = [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Background' -f $targetScript
  $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'AI HelpDesk 本人同意付きフォルダ一覧ヘルパー（本人権限・読み取り専用）' -Force | Out-Null

  if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
  Write-Output ('[install] task={0} runLevel=Limited logonType=Interactive' -f $taskName)
} catch {
  Write-Error ('[install] ERROR ' + $_.Exception.Message)
  exit 1
}
