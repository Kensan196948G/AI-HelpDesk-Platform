<#
  spooler.queue.purge Skill（取消不可 / Phase 2）

  目的:
    印刷キューに残った「エラー状態」の印刷ジョブだけを削除する。
    正常・印刷中のジョブには触れない。
  出力:
    標準出力へ JSON 1 行。
    {"purgedCount":2,"failedCount":0,"remainingErrorCount":0,"irreversible":true}
  引数:
    -ConfirmPurge（必須スイッチ）
      endpoint-command-agent.mjs は params.confirm が 'PURGE' のときだけ付与する。
      利用者の実行前 Y/N（承認ハッシュ）と合わせて二重確認とする。
  終了コード:
    0 成功 / 1 実行失敗 / 2 引数不足（-ConfirmPurge なし） / 3 管理者権限が必要
  PII:
    プリンタ名・ジョブ名・利用者名は出力しない（件数だけを返す）。
  注意:
    - **取消不可**。削除した印刷ジョブは復元できない（Skill 定義の rollback に明記）。
    - 対象は全プリンタのキュー。他ユーザーのジョブを削除するには管理者権限が要るため
      昇格を要求する。
    - エラー判定は JobStatus の文字列に対する固定パターンだけで行い、
      利用者入力からコマンドを組み立てない。
    - Windows 実機が無いため実行検証は未実施（静的契約検証まで）。
#>
[CmdletBinding()]
param(
    [switch]$ConfirmPurge
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

if (-not $ConfirmPurge) {
    [Console]::Error.WriteLine('spooler-queue-purge: 取消不可の操作のため -ConfirmPurge が必要です（exit 2）')
    exit 2
}

if (-not (Test-IsElevated)) {
    [Console]::Error.WriteLine('spooler-queue-purge: 管理者権限が必要です（exit 3）')
    exit 3
}

# エラー状態とみなす JobStatus の固定パターン（正常・印刷中は含めない）。
$errorStatusPattern = 'Error|Blocked|Offline|PaperOut|PaperProblem|UserIntervention'

try {
    $printers = @(Get-Printer -ErrorAction Stop)
} catch {
    [Console]::Error.WriteLine(("spooler-queue-purge: プリンタ一覧の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}

$purgedCount = 0
$failedCount = 0

foreach ($printer in $printers) {
    try {
        $jobs = @(Get-PrintJob -PrinterName $printer.Name -ErrorAction Stop)
    } catch {
        # 1 台の失敗で全体を止めない（削除できなかった件数には数えない）。
        continue
    }
    foreach ($job in $jobs) {
        # JobStatus が空のジョブは状態を判定できないため触れない（安全側）。
        if ([string]::IsNullOrWhiteSpace([string]$job.JobStatus)) { continue }
        if ($job.JobStatus -notmatch $errorStatusPattern) { continue }
        try {
            Remove-PrintJob -PrinterName $printer.Name -ID $job.Id -Confirm:$false -ErrorAction Stop
            $purgedCount += 1
        } catch {
            $failedCount += 1
        }
    }
}

# 残っているエラー状態のジョブを数え直す（Skill 定義の verify 条件）。
$remainingErrorCount = 0
foreach ($printer in $printers) {
    try {
        $jobs = @(Get-PrintJob -PrinterName $printer.Name -ErrorAction Stop)
    } catch {
        continue
    }
    foreach ($job in $jobs) {
        if ($job.JobStatus -match $errorStatusPattern) { $remainingErrorCount += 1 }
    }
}

[ordered]@{
    purgedCount         = [int]$purgedCount
    failedCount         = [int]$failedCount
    remainingErrorCount = [int]$remainingErrorCount
    irreversible        = $true
} | ConvertTo-Json -Compress -Depth 6
