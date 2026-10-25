<#
  os.info Skill（読み取り専用 / Phase B）

  目的:
    OS の基本情報を取得する。読み取りのみで、端末の設定・サービス・ファイルは変更しない。
  出力:
    標準出力へ JSON 1 行（ConvertTo-Json -Compress）。
    {"osName":"...","version":"...","buildNumber":"...","architecture":"...","computerName":"..."}
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない。
  呼び出し:
    endpoint-command-agent.mjs が引数配列で実行する（シェル文字列連結はしない）。
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File os-info.ps1
  注意:
    Windows PowerShell 5.1 / PowerShell 7 の両方で動作する構文のみを使う。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# 標準出力を UTF-8 に固定する（Windows PowerShell 5.1 のリダイレクト時の文字化け対策）。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop

    $result = [ordered]@{
        osName       = [string]$os.Caption
        version      = [string]$os.Version
        buildNumber  = [string]$os.BuildNumber
        architecture = [string]$os.OSArchitecture
        computerName = [string]$os.CSName
    }

    $result | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("os-info の取得に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
