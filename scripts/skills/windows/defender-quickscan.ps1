<#
  defender.quickscan Skill（実行・設定変更なし / Phase 2 / KB-2026-0008 の穴埋め）

  目的:
    Microsoft Defender のクイックスキャンを開始する。完了は待たず、
    開始できたことだけを確認して短時間で終える。
  出力:
    標準出力へ JSON 1 行。
    {"started":true,"scanType":"QuickScan","startedAt":"2026-10-25T13:00:00.0000000Z"}
  引数:
    なし。固定の -ScanType QuickScan のみ。
  終了コード:
    0 成功 / 1 実行失敗（Defender 無効・開始失敗を含む） / 3 管理者権限が必要
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
    検知名・検出パス・除外設定は取得も出力もしない。
  注意:
    - スキャンは -AsJob で開始し、完了待ちをしない（TimeoutSec 45 秒に収める）。
      実際のスキャンは Defender サービス側で継続する。
    - Defender が無効（サードパーティ AV 等）の場合は exit 1 で理由を返す。
    - Windows 実機が無いため実行検証は未実施（静的契約検証まで）。
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
    [Console]::Error.WriteLine('defender-quickscan: 管理者権限が必要です（exit 3）')
    exit 3
}

try {
    $status = Get-MpComputerStatus -ErrorAction Stop
    if ($null -eq $status -or -not [bool]$status.AntivirusEnabled) {
        [Console]::Error.WriteLine('defender-quickscan: Microsoft Defender が有効ではありません（exit 1）')
        exit 1
    }

    # 完了は待たない（-AsJob）。スキャン自体は Defender サービス側で継続する。
    Start-MpScan -ScanType QuickScan -AsJob -ErrorAction Stop | Out-Null

    [ordered]@{
        started   = $true
        scanType  = 'QuickScan'
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("defender-quickscan の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
