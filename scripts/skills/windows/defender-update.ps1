<#
  defender.update Skill（定義更新 / Phase 7）

  目的:
    Microsoft Defender のウイルス定義（署名）を更新し、更新前後の定義バージョンを返す。
  出力:
    標準出力へ JSON 1 行。
    {"updated":true,"previousVersion":"1.415.118.0","currentVersion":"1.415.120.0",
     "lastUpdated":"2026-10-25T00:00:00.0000000Z"}
  引数:
    なし（AI は Skill ID と型付きパラメータだけを選び、コマンド文字列は生成しない）。
  終了コード:
    0 成功 / 1 実行失敗 / 3 管理者権限が必要
  PII:
    端末名・ユーザー名・検知名は取得も出力もしない（定義バージョンだけを返す）。
  注意:
    `updated` は「定義バージョンが実際に進んだか」を表す。既に最新だった場合は
    false になる（temp.cleanup の deletedBytes と同じ考え方で、何も変わっていない
    のに「解決」と判定しない）。更新コマンド自体の成否は終了コードで表す。
    Windows 実機が無いため実行検証は未実施（出力 JSON 契約・固定コマンド・
    権限チェックの静的契約検証まで）。
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
    [Console]::Error.WriteLine('defender-update: 管理者権限が必要です（exit 3）')
    exit 3
}

try {
    $previousVersion = $null
    try {
        $before = Get-MpComputerStatus -ErrorAction Stop
        if ($null -ne $before) { $previousVersion = [string]$before.AntivirusSignatureVersion }
    } catch {
        $previousVersion = $null
    }

    Update-MpSignature -ErrorAction Stop

    $status = Get-MpComputerStatus -ErrorAction Stop
    $currentVersion = $null
    $lastUpdated = $null
    if ($null -ne $status) {
        $currentVersion = [string]$status.AntivirusSignatureVersion
        $lastUpdated = [string]$status.AntivirusSignatureLastUpdated
    }

    $updated = $false
    if (-not [string]::IsNullOrWhiteSpace($currentVersion)) {
        $updated = ($previousVersion -ne $currentVersion)
    }

    [ordered]@{
        updated         = $updated
        previousVersion = $previousVersion
        currentVersion  = $currentVersion
        lastUpdated     = $lastUpdated
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("defender-update の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
