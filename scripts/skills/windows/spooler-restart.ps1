<#
  spooler.restart Skill（修復・可逆 / Phase 2）

  目的:
    Print Spooler サービスを再起動し、起動状態を確認する。
    サービス名はスクリプト内の固定値だけで、引数から受け取らない。
  出力:
    標準出力へ JSON 1 行。
    {"name":"Spooler","displayName":"Print Spooler","status":"Running","startType":"Auto",
     "previousStatus":"Running","restarted":true}
  引数:
    なし（AI は Skill ID と型付きパラメータだけを選び、コマンド文字列は生成しない）。
  終了コード:
    0 成功 / 1 実行失敗 / 3 管理者権限が必要
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  注意:
    Windows 実機が無いため実行検証は未実施。出力 JSON 契約・固定コマンド・
    権限チェックの静的契約検証までを対象とする。
    Spooler の再起動は管理者権限が必要なため、昇格していない場合は exit 3 で
    明示的に失敗する（曖昧な失敗にしない）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Test-IsElevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

if (-not (Test-IsElevated)) {
    [Console]::Error.WriteLine('spooler-restart: 管理者権限が必要です（exit 3）')
    exit 3
}

$serviceName = 'Spooler'

try {
    $before = Get-Service -Name $serviceName -ErrorAction Stop
    $previousStatus = [string]$before.Status

    Restart-Service -Name $serviceName -Force -ErrorAction Stop

    # 起動完了を最大 30 秒待つ（端末エージェントの 60 秒タイムアウトより短くする）。
    $deadline = (Get-Date).AddSeconds(30)
    $after = Get-Service -Name $serviceName -ErrorAction Stop
    while ($after.Status -ne 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $after = Get-Service -Name $serviceName -ErrorAction Stop
    }

    if ($after.Status -ne 'Running') {
        [Console]::Error.WriteLine(("spooler-restart: 再起動後も Running になりません: {0}" -f $after.Status))
        exit 1
    }

    $startType = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name = 'Spooler'" -ErrorAction Stop
        if ($null -ne $cim) { $startType = [string]$cim.StartMode }
    } catch {
        $startType = $null
    }

    [ordered]@{
        name           = [string]$after.Name
        displayName    = [string]$after.DisplayName
        status         = [string]$after.Status
        startType      = $startType
        previousStatus = $previousStatus
        restarted      = $true
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("spooler-restart の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
