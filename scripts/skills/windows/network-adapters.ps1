<#
  network.adapters Skill（読み取り専用 / Phase B）

  目的:
    ネットワークアダプタの名前・状態・リンク速度・説明を取得する。読み取りのみ。
    取得できない場合は Win32_NetworkAdapter（CIM）へフォールバックする。
  出力:
    {"adapters":[{"name":"Ethernet","status":"Up","linkSpeed":"1 Gbps",
      "interfaceDescription":"..."}, ...]}
  PII:
    IP アドレス・MAC アドレス・シリアル・メールアドレスは取得も出力もしない
    （Get-NetAdapter / Win32_NetworkAdapter の許可したプロパティだけを抜き出す）。
  呼び出し:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File network-adapters.ps1
  注意:
    Windows PowerShell 5.1 / PowerShell 7 の両方で動作する構文のみを使う。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Convert-NetConnectionStatus {
    param([object]$Status)

    if ($null -eq $Status) { return $null }
    switch ([int]$Status) {
        0 { return 'Disconnected' }
        1 { return 'Connecting' }
        2 { return 'Up' }
        3 { return 'Disconnecting' }
        4 { return 'HardwareNotPresent' }
        5 { return 'Disabled' }
        6 { return 'HardwareMalfunction' }
        7 { return 'Disconnected' }
        8 { return 'Authenticating' }
        9 { return 'Authenticated' }
        10 { return 'AuthenticationFailed' }
        default { return [string]$Status }
    }
}

function Format-LinkSpeed {
    param([object]$BitsPerSecond)

    if ($null -eq $BitsPerSecond) { return $null }
    $value = [double]$BitsPerSecond
    if ($value -le 0) { return $null }
    if ($value -ge 1e9) { return ('{0:0.##} Gbps' -f ($value / 1e9)) }
    if ($value -ge 1e6) { return ('{0:0.##} Mbps' -f ($value / 1e6)) }
    return ('{0:0} bps' -f $value)
}

try {
    $adapters = @()
    $netAdapterCommand = Get-Command -Name Get-NetAdapter -ErrorAction SilentlyContinue

    if ($null -ne $netAdapterCommand) {
        # 通常経路: NetAdapter モジュール（Name/Status/LinkSpeed は文字列で返る）。
        $adapters = @(
            Get-NetAdapter -ErrorAction Stop | ForEach-Object {
                [ordered]@{
                    name                 = [string]$_.Name
                    status               = [string]$_.Status
                    linkSpeed            = [string]$_.LinkSpeed
                    interfaceDescription = [string]$_.InterfaceDescription
                }
            }
        )
    } else {
        throw 'Get-NetAdapter が見つかりません'
    }
} catch {
    # フォールバック: NetAdapter モジュールが無い / 取得に失敗した場合のみ CIM を使う。
    try {
        $adapters = @(
            Get-CimInstance -ClassName Win32_NetworkAdapter -ErrorAction Stop |
                Where-Object { $_.Name } |
                ForEach-Object {
                    [ordered]@{
                        name                 = [string]$_.Name
                        status               = Convert-NetConnectionStatus -Status $_.NetConnectionStatus
                        linkSpeed            = Format-LinkSpeed -BitsPerSecond $_.Speed
                        interfaceDescription = [string]$_.Description
                    }
                }
        )
    } catch {
        [Console]::Error.WriteLine(("network-adapters の取得に失敗しました: {0}" -f $_.Exception.Message))
        exit 1
    }
}

[ordered]@{ adapters = @($adapters) } | ConvertTo-Json -Compress -Depth 6
