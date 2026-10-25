<#
  bitlocker.status Skill（読み取り専用 / Phase 2 / KB-2026-0007 の穴埋め）

  目的:
    各ボリュームの BitLocker 保護状態・暗号化方式・進捗を読み取りで確認する。
  出力:
    標準出力へ JSON 1 行。
    {"supported":true,"volumeCount":1,
     "volumes":[{"mountPoint":"C:","volumeStatus":"FullyEncrypted",
                 "protectionStatus":"On","encryptionMethod":"XtsAes256",
                 "encryptionPercentage":100}],
     "bdeStatusExitCode":null}
  引数:
    なし（全ボリュームを対象にする）。
  終了コード:
    0 成功 / 1 実行失敗 / 3 管理者権限が必要
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
    **回復キー（数値パスワード）は取得も出力もしない**。
    manage-bde の本文（ローカライズされた自由文）も出力しない。
  注意:
    - 構造化取得には Get-BitLockerVolume を使う（manage-bde -status の本文は
      ロケール依存で JSON 契約にできないため、実行可否の終了コードだけを返す）。
    - BitLocker の参照は管理者権限が必要なため、昇格していない場合は exit 3。
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
    [Console]::Error.WriteLine('bitlocker-status: 管理者権限が必要です（exit 3）')
    exit 3
}

$supported = $true
$volumes = @()
$bdeStatusExitCode = $null

try {
    $blv = @(Get-BitLockerVolume -ErrorAction Stop)
    foreach ($volume in $blv) {
        # 回復キー・キープロテクタは参照しない（出力もしない）。
        $volumes += [ordered]@{
            mountPoint           = [string]$volume.MountPoint
            volumeStatus         = [string]$volume.VolumeStatus
            protectionStatus     = [string]$volume.ProtectionStatus
            encryptionMethod     = [string]$volume.EncryptionMethod
            encryptionPercentage = [int]$volume.EncryptionPercentage
        }
    }
} catch [System.Management.Automation.CommandNotFoundException] {
    $supported = $false
    # Get-BitLockerVolume が無い環境では manage-bde の実行可否だけを確認する。
    $bdePath = Join-Path -Path ([string]$env:SystemRoot) -ChildPath 'System32\manage-bde.exe'
    if (Test-Path -LiteralPath $bdePath -PathType Leaf) {
        try {
            & $bdePath '-status' 2>&1 | Out-Null
            $bdeStatusExitCode = [int]$LASTEXITCODE
        } catch {
            $bdeStatusExitCode = $null
        }
    }
} catch {
    [Console]::Error.WriteLine(("bitlocker-status の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}

[ordered]@{
    supported         = [bool]$supported
    volumeCount       = [int]$volumes.Count
    volumes           = @($volumes)
    bdeStatusExitCode = $bdeStatusExitCode
} | ConvertTo-Json -Compress -Depth 6
