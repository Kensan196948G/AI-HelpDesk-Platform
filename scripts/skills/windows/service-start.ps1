<#
  service.start Skill（修復・可逆 / Phase 2）

  目的:
    許可リストにあるサービスを起動し、起動状態を確認する。
    許可名: Spooler / W32Time（それ以外は exit 2 で拒否）。
  出力:
    標準出力へ JSON 1 行。
    {"name":"Spooler","displayName":"Print Spooler","status":"Running","startType":"Auto",
     "previousStatus":"Stopped","started":true}
  引数:
    -Service <Spooler|W32Time>
      endpoint-command-agent.mjs が params.name を許可リストで検証してから配列で渡す。
  終了コード:
    0 成功 / 1 実行失敗 / 2 引数不正 / 3 管理者権限が必要
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  注意:
    Get-Service / Start-Service の -Name はワイルドカードを受け付けるため、
    許可リストの正規名へ置き換えてから実行する（引数をそのまま -Name へ渡さない）。
    Windows 実機が無いため実行検証は未実施（静的契約検証まで）。
#>
[CmdletBinding()]
param(
    [string]$Service
)

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

$allowed = @('Spooler', 'W32Time')

if ([string]::IsNullOrWhiteSpace($Service)) {
    [Console]::Error.WriteLine('service-start: -Service が必要です（Spooler / W32Time）')
    exit 2
}

# 大文字小文字を無視して許可リストの正規名へ解決する。
$canonical = $null
foreach ($name in $allowed) {
    if ($name -ieq $Service.Trim()) { $canonical = $name; break }
}
if ($null -eq $canonical) {
    [Console]::Error.WriteLine(("service-start: 許可されていないサービスです: {0}" -f $Service))
    exit 2
}

if (-not (Test-IsElevated)) {
    [Console]::Error.WriteLine('service-start: 管理者権限が必要です（exit 3）')
    exit 3
}

try {
    $before = Get-Service -Name $canonical -ErrorAction Stop
    $previousStatus = [string]$before.Status

    if ($before.Status -ne 'Running') {
        Start-Service -Name $canonical -ErrorAction Stop
    }

    # 起動完了を最大 30 秒待つ（端末エージェントの 60 秒タイムアウトより短くする）。
    $deadline = (Get-Date).AddSeconds(30)
    $after = Get-Service -Name $canonical -ErrorAction Stop
    while ($after.Status -ne 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $after = Get-Service -Name $canonical -ErrorAction Stop
    }

    if ($after.Status -ne 'Running') {
        [Console]::Error.WriteLine(("service-start: 起動後も Running になりません: {0}" -f $after.Status))
        exit 1
    }

    $startType = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter ("Name = '{0}'" -f $canonical) -ErrorAction Stop
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
        started        = $true
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("service-start の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
