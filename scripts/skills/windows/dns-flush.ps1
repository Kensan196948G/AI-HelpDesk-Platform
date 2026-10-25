<#
  dns.flush Skill（読み取りに近い変更・取消不要 / Phase 2）

  目的:
    名前解決のキャッシュをクリアする（ipconfig /flushdns）。
    設定ファイル・レジストリは変更しない。
  出力:
    標準出力へ JSON 1 行。
    {"flushed":true,"exitCode":0}
  引数:
    なし。実行するのは %SystemRoot%\System32\ipconfig.exe の固定引数 '/flushdns' のみで、
    利用者入力や変数をコマンド文字列へ連結しない。
  終了コード:
    0 成功 / 1 実行失敗
  PII:
    ipconfig の出力（ホスト名・IP 等を含みうる）は JSON 契約を壊さないよう破棄し、
    取得も出力もしない。
  注意:
    DNS キャッシュは参照時に自動再構築されるためロールバックは不要。
    Windows 実機が無いため実行検証は未実施（静的契約検証まで）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$ipconfigPath = Join-Path -Path ([string]$env:SystemRoot) -ChildPath 'System32\ipconfig.exe'
if (-not (Test-Path -LiteralPath $ipconfigPath -PathType Leaf)) {
    [Console]::Error.WriteLine('dns-flush: ipconfig.exe が見つかりません（exit 1）')
    exit 1
}

try {
    # 固定引数のみ。標準出力/標準エラーは JSON に混ぜないため破棄する。
    & $ipconfigPath '/flushdns' 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }

    if ([int]$exitCode -ne 0) {
        [Console]::Error.WriteLine(("dns-flush: ipconfig /flushdns が終了コード {0} で失敗しました" -f $exitCode))
        exit 1
    }

    [ordered]@{
        flushed  = $true
        exitCode = [int]$exitCode
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("dns-flush の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
