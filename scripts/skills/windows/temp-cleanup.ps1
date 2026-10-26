<#
  temp.cleanup Skill（修復・復元不可 / Phase 2）

  目的:
    実行ユーザーの TEMP フォルダ配下から、LastWriteTime が olderThanDays より
    古い「ファイル」だけを削除し、前後の空き容量を計測する。
  出力:
    標準出力へ JSON 1 行。
    {"freeBytesBefore":...,"freeBytesAfter":...,"freedBytes":...,"freedMB":...,
     "deletedBytes":...,"deletedCount":12,"skippedCount":0,"truncated":false}
  引数:
    -OlderThanDays <1-30>
      endpoint-command-agent.mjs が整数 1..30 を検証してから配列で渡す。
      未指定・範囲外は exit 2（暗黙の既定値で削除しない）。
  終了コード:
    0 成功 / 1 実行失敗 / 2 引数不正・対象外のパス
  PII:
    ユーザー名・IP・MAC・シリアル・メールアドレスは取得も出力もしない
    （TEMP のフルパスも出力しない）。
  注意:
    - 削除したファイルは復元できない（Skill 定義の rollback に影響範囲を明記）。
    - 対象は実行ユーザーの %TEMP% 配下のファイルのみ。フォルダは削除しない。
    - システム TEMP（%SystemRoot% 配下）は対象外として exit 2 で拒否する。
    - ジャンクション/シンボリックリンクは辿らない（再帰ループを避ける）。
    - エージェントの 60 秒タイムアウトより先に終わるよう、内部期限 45 秒で打ち切る。
    - Windows 実機が無いため実行検証は未実施（静的契約検証まで）。
#>
[CmdletBinding()]
param(
    [int]$OlderThanDays = 0
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if ($OlderThanDays -lt 1 -or $OlderThanDays -gt 30) {
    [Console]::Error.WriteLine('temp-cleanup: -OlderThanDays は 1..30 の整数で指定してください（exit 2）')
    exit 2
}

try {
    $tempPath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
} catch {
    [Console]::Error.WriteLine(("temp-cleanup: TEMP パスの解決に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}

if ([string]::IsNullOrWhiteSpace($tempPath)) {
    [Console]::Error.WriteLine('temp-cleanup: TEMP パスが空です（exit 2）')
    exit 2
}

# ドライブ直下や %SystemRoot% 配下（システム TEMP）は対象外にする。
$driveRoot = [System.IO.Path]::GetPathRoot($tempPath)
if ($tempPath -eq $driveRoot.TrimEnd('\')) {
    [Console]::Error.WriteLine('temp-cleanup: ドライブ直下は対象外です（exit 2）')
    exit 2
}
$systemRoot = $env:SystemRoot
if (-not [string]::IsNullOrWhiteSpace($systemRoot)) {
    $systemRootFull = [System.IO.Path]::GetFullPath($systemRoot).TrimEnd('\')
    if ($tempPath.StartsWith($systemRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        [Console]::Error.WriteLine('temp-cleanup: システム TEMP は対象外です（exit 2）')
        exit 2
    }
}

$cutoffUtc = (Get-Date).ToUniversalTime().AddDays(-1 * $OlderThanDays)
$deadline = (Get-Date).AddSeconds(45)

$freeBytesBefore = 0
try {
    $drive = New-Object System.IO.DriveInfo($driveRoot)
    $freeBytesBefore = [long]$drive.AvailableFreeSpace
} catch {
    $freeBytesBefore = 0
}

$deletedCount = 0
$skippedCount = 0
$deletedBytes = 0
$truncated = $false

# 自前でスタック探索する（ジャンクションを辿らず、期限で打ち切れるようにする）。
$pending = New-Object System.Collections.Stack
$pending.Push($tempPath)

while ($pending.Count -gt 0) {
    if ((Get-Date) -ge $deadline) { $truncated = $true; break }

    $current = [string]$pending.Pop()
    $entries = @()
    try {
        $entries = [System.IO.Directory]::GetFileSystemEntries($current)
    } catch {
        $skippedCount += 1
        continue
    }

    foreach ($entry in $entries) {
        if ((Get-Date) -ge $deadline) { $truncated = $true; break }

        try {
            $attributes = [System.IO.File]::GetAttributes($entry)
        } catch {
            $skippedCount += 1
            continue
        }

        $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

        if ($isDirectory) {
            # ジャンクション/シンボリックリンクは辿らない。
            if (-not $isReparsePoint) { $pending.Push($entry) }
            continue
        }

        if ($isReparsePoint) {
            # ファイルのリンクは削除対象にしない（リンク先を壊さない）。
            $skippedCount += 1
            continue
        }

        try {
            if ([System.IO.File]::GetLastWriteTimeUtc($entry) -gt $cutoffUtc) { continue }
            $length = [long](([System.IO.FileInfo]::new($entry)).Length)
            [System.IO.File]::Delete($entry)
            $deletedCount += 1
            $deletedBytes += $length
        } catch {
            $skippedCount += 1
        }
    }
}

$freeBytesAfter = 0
try {
    $drive = New-Object System.IO.DriveInfo($driveRoot)
    $freeBytesAfter = [long]$drive.AvailableFreeSpace
} catch {
    $freeBytesAfter = 0
}

$freedBytes = $freeBytesAfter - $freeBytesBefore
$freedMB = [math]::Round(([double]$freedBytes / 1MB), 2)

[ordered]@{
    freeBytesBefore = [long]$freeBytesBefore
    freeBytesAfter  = [long]$freeBytesAfter
    freedBytes      = [long]$freedBytes
    freedMB         = $freedMB
    deletedBytes    = [long]$deletedBytes
    deletedCount    = [int]$deletedCount
    skippedCount    = [int]$skippedCount
    truncated       = [bool]$truncated
} | ConvertTo-Json -Compress -Depth 6
