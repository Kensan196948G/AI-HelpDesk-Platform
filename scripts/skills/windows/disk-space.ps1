<#
  disk.space Skill（読み取り専用 / Phase B）

  目的:
    固定ディスク（DriveType=3）ごとの空き容量・総容量を取得する。読み取りのみ。
  出力:
    標準出力へ JSON 1 行。
    {"volumes":[{"deviceId":"C:","freeGB":118.42,"totalGB":475.9}, ...]}
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  呼び出し:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File disk-space.ps1
  注意:
    ボリュームが 1 つでも配列（volumes）として返す。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

try {
    $disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop)

    $volumes = @()
    foreach ($disk in $disks) {
        $freeGB = $null
        $totalGB = $null

        # 一部のボリュームは Size / FreeSpace が null を返すため個別にガードする。
        if ($null -ne $disk.FreeSpace) {
            $freeGB = [math]::Round(([double]$disk.FreeSpace / 1GB), 2)
        }
        if ($null -ne $disk.Size) {
            $totalGB = [math]::Round(([double]$disk.Size / 1GB), 2)
        }

        $volumes += [ordered]@{
            deviceId = [string]$disk.DeviceID
            freeGB   = $freeGB
            totalGB  = $totalGB
        }
    }

    [ordered]@{ volumes = @($volumes) } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("disk-space の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
