#Requires -Version 5.1
<#
.SYNOPSIS
  本人同意付きフォルダ一覧ヘルパーのタスクとトークンを削除し、サーバへの失効通知を試みる。

.DESCRIPTION
  失効通知は可能な範囲で行う。通信できない・未対応でも、端末側の削除は続行する。
  SYSTEM などのサービスアカウントでは実行しない（本人のトークンを復号できず、別人のタスクを消す恐れがある）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try {
  $sourceScript = Join-Path $PSScriptRoot 'folder-helper.ps1'
  if (-not (Test-Path -LiteralPath $sourceScript)) { throw 'folder-helper.ps1 が見つかりません。' }
  . $sourceScript -NoMain

  $identity = Get-CurrentIdentityInfo
  foreach ($restricted in $script:RestrictedSids) {
    if ($identity.Sid -ceq $restricted) { throw 'サービスアカウントでは実行しません。' }
  }
  $stateDir = Get-StateDirectory
  $taskName = Get-HelperTaskName -Sid $identity.Sid

  # 先に止める。止める前に通知すると、動作中のヘルパーがトークンを使い続ける。
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }

  $notified = 'skipped'
  if (Test-Path -LiteralPath $stateDir) {
    $tokenInfo = Read-HelperToken
    $config = $null
    try { $config = Read-HelperConfig } catch { $config = $null }
    if ($null -ne $tokenInfo -and $null -ne $config) {
      $server = [string](Get-OpField -Op $config -Name 'serverUrl')
      $allowInsecure = ((Get-OpField -Op $config -Name 'allowInsecureHttp') -eq $true)
      if (Test-ServerUrl -Url $server -AllowInsecure $allowInsecure) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        # POST /revoke は docs/62 §9.3 の提案。未実装のサーバでは 404 になるが削除は続行する。
        $response = Invoke-HelperHttp -Url (Get-HelperApiUrl -ServerBase $server -Action 'revoke') -Token ([string]$tokenInfo.helperToken) -BodyJson '{}' -TimeoutSec 10
        $notified = 'status=' + $response.Status
      }
    }
  }

  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }

  if (Test-Path -LiteralPath $stateDir) {
    $info = New-Object IO.DirectoryInfo -ArgumentList $stateDir
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '状態フォルダがリンクなので削除しません。' }
    # token.dat、report-token.dat、runs、report-runs をまとめて消す。報告専用トークンでは通知しない。
    Remove-Item -LiteralPath $stateDir -Recurse -Force
  }
  Write-Output ('[uninstall] task={0} notify={1}' -f $taskName, $notified)
} catch {
  Write-Error ('[uninstall] ERROR ' + $_.Exception.Message)
  exit 1
}
