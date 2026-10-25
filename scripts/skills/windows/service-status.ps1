<#
  service.status Skill（読み取り専用 / Phase B）

  目的:
    許可リストにあるサービスの状態を取得する。読み取りのみ。
    許可名: Spooler / W32Time / Winmgmt（それ以外は exit 2 で拒否）。
  出力:
    {"name":"...","displayName":"...","status":"Running","startType":"Auto"}
  引数:
    -Service <Spooler|W32Time|Winmgmt>（endpoint-command-agent.mjs が配列で渡す）
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  注意:
    Get-Service -Name はワイルドカードを受け付けるため、許可リストの正規名に
    置き換えてから実行する（引数をそのまま -Name へ渡さない）。
    拒否時は終了コード 2、取得失敗時は終了コード 1 を返す。
#>
param(
    [string]$Service
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$allowed = @('Spooler', 'W32Time', 'Winmgmt')

if ([string]::IsNullOrWhiteSpace($Service)) {
    [Console]::Error.WriteLine('service-status: -Service が必要です（Spooler / W32Time / Winmgmt）')
    exit 2
}

# 大文字小文字を無視して許可リストの正規名へ解決する。
$canonical = $null
foreach ($name in $allowed) {
    if ($name -ieq $Service.Trim()) { $canonical = $name; break }
}
if ($null -eq $canonical) {
    [Console]::Error.WriteLine(("service-status: 許可されていないサービスです: {0}" -f $Service))
    exit 2
}

try {
    $svc = Get-Service -Name $canonical -ErrorAction Stop

    $startType = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter ("Name = '{0}'" -f $canonical) -ErrorAction Stop
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
    [Console]::Error.WriteLine(("service-status の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
