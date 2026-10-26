<#
  recyclebin.clear Skill（修復・復元不可 / Phase 7）

  目的:
    実行ユーザーのごみ箱（全ドライブ）を空にし、削除前後の件数を返す。
  出力:
    標準出力へ JSON 1 行。
    {"cleared":true,"clearedCount":12,"itemsBefore":12,"itemsAfter":0,
     "alreadyEmpty":false,"irreversible":true}
  引数:
    なし（AI は Skill ID と型付きパラメータだけを選び、コマンド文字列は生成しない）。
  終了コード:
    0 成功 / 1 実行失敗
  権限:
    管理者権限は不要（自分のごみ箱だけが対象。他ユーザーのごみ箱は消さない）。
  注意:
    `cleared` は「実際に 1 件以上消して 0 件になったか」を表す。既に空だった場合は
    cleared=false / alreadyEmpty=true を返す（何も変わっていないのに「解決」と
    判定しない）。削除したファイルは復元できない。
    Windows 実機が無いため実行検証は未実施（出力 JSON 契約・固定コマンドの
    静的契約検証まで）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Get-RecycleBinItemCount {
    param([object]$Shell)

    try {
        $bin = $Shell.Namespace(0xA)
        if ($null -eq $bin) { return $null }
        return [int]$bin.Items().Count
    } catch {
        return $null
    }
}

try {
    $shell = $null
    try {
        $shell = New-Object -ComObject Shell.Application
    } catch {
        [Console]::Error.WriteLine(("recyclebin-clear: ごみ箱を参照できません: {0}" -f $_.Exception.Message))
        exit 1
    }

    $itemsBefore = Get-RecycleBinItemCount -Shell $shell
    if ($null -eq $itemsBefore) {
        [Console]::Error.WriteLine('recyclebin-clear: ごみ箱の件数を取得できませんでした')
        exit 1
    }

    if ($itemsBefore -eq 0) {
        # 既に空。削除は行わず、その事実だけを返す（cleared=false）。
        [ordered]@{
            cleared       = $false
            clearedCount  = 0
            itemsBefore   = 0
            itemsAfter    = 0
            alreadyEmpty  = $true
            irreversible  = $true
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }

    Clear-RecycleBin -Force -ErrorAction Stop

    $itemsAfter = Get-RecycleBinItemCount -Shell $shell
    if ($null -eq $itemsAfter) {
        [Console]::Error.WriteLine('recyclebin-clear: 削除後の件数を取得できませんでした')
        exit 1
    }

    $clearedCount = $itemsBefore - $itemsAfter

    [ordered]@{
        cleared       = ($itemsAfter -eq 0)
        clearedCount  = $clearedCount
        itemsBefore   = $itemsBefore
        itemsAfter    = $itemsAfter
        alreadyEmpty  = $false
        irreversible  = $true
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("recyclebin-clear の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
