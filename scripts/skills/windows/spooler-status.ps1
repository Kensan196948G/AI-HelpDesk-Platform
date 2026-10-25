<#
  spooler.status Skill（読み取り専用 / Phase B）

  目的:
    Print Spooler サービスの状態を取得する。Get-Service / Get-CimInstance の読み取りのみ。
  出力:
    標準出力へ JSON 1 行。
    {"name":"Spooler","displayName":"Print Spooler","status":"Running","startType":"Auto"}
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  呼び出し:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File spooler-status.ps1
  注意:
    Get-Service の StartType は Windows PowerShell 5.1 に無いため、
    Win32_Service の StartMode で補う（取得できなければ null）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

try {
    $svc = Get-Service -Name 'Spooler' -ErrorAction Stop

    $startType = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name = 'Spooler'" -ErrorAction Stop
        if ($null -ne $cim) { $startType = [string]$cim.StartMode }
    } catch {
        $startType = $null
    }

    [ordered]@{
        name        = [string]$svc.Name
        displayName = [string]$svc.DisplayName
        status      = [string]$svc.Status
        startType   = $startType
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("spooler-status の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
