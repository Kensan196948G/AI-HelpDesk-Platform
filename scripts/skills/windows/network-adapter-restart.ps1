<#
  network.adapter.restart Skill（修復・可逆 / Phase 7）

  目的:
    指定したネットワークアダプタを無効化（Disable）→ 有効化（Enable）して
    リンクを張り直し、有効化後の状態を再取得して返す。
  出力:
    標準出力へ JSON 1 行。
    {"name":"Ethernet","interfaceDescription":"Intel(R) ...","previousStatus":"Up",
     "status":"Up","restarted":true}
  引数:
    -InterfaceAlias <アダプタ名>
      endpoint-command-agent.mjs が params.interfaceAlias の形（長さ・先頭文字）を
      検証してから配列で渡す。ここでは「実行端末に実在するアダプタ名と完全一致」
      するものだけを対象にする（許可リストは実行時の実機一覧）。
      一致しなければ exit 2 で拒否し、コマンドは実行しない。
  終了コード:
    0 成功 / 1 実行失敗 / 2 引数不正 / 3 管理者権限が必要
  PII:
    IP・MAC・シリアル・メールアドレスは取得も出力もしない
    （Name / InterfaceDescription / Status だけを使う）。
  注意:
    有効化後 30 秒待っても Up にならない場合（ケーブル未接続・Wi-Fi 圏外等）は、
    実行失敗（exit 1）にせず、取得できた status をそのまま返す。
    これは「操作は成功したが、Up にならなかった」ことを verify（status=Up）で
    判定させるため（実行失敗と混同しない）。
    Windows 実機が無いため実行検証は未実施（出力 JSON 契約・引数検証・
    権限チェックの静的契約検証まで）。
#>
[CmdletBinding()]
param(
    [string]$InterfaceAlias
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

# ── 引数の形を先に検証する（AI が生成した値でもここで弾く） ──────────────
if ([string]::IsNullOrWhiteSpace($InterfaceAlias)) {
    [Console]::Error.WriteLine('network-adapter-restart: -InterfaceAlias が必要です')
    exit 2
}
if ($InterfaceAlias.Length -gt 64) {
    [Console]::Error.WriteLine('network-adapter-restart: -InterfaceAlias が長すぎます（64 文字以内）')
    exit 2
}
# 先頭 '-' は PowerShell のパラメータ名として解釈され得るため拒否する。
if ($InterfaceAlias.StartsWith('-')) {
    [Console]::Error.WriteLine('network-adapter-restart: -InterfaceAlias を "-" で開始できません')
    exit 2
}
# 制御文字（改行・タブ等）はアダプタ名に現れない。
if ($InterfaceAlias -match '[\x00-\x1F\x7F]') {
    [Console]::Error.WriteLine('network-adapter-restart: -InterfaceAlias に制御文字を含められません')
    exit 2
}

if (-not (Test-IsElevated)) {
    [Console]::Error.WriteLine('network-adapter-restart: 管理者権限が必要です（exit 3）')
    exit 3
}

try {
    # 実行端末に実在するアダプタ名と完全一致するものだけを対象にする。
    $matched = @(
        Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Name -eq $InterfaceAlias }
    )
    if ($matched.Count -ne 1) {
        [Console]::Error.WriteLine(("network-adapter-restart: 一致するアダプタがありません: {0}" -f $InterfaceAlias))
        exit 2
    }

    $adapterName = [string]$matched[0].Name
    $description = [string]$matched[0].InterfaceDescription
    $previousStatus = [string]$matched[0].Status

    Disable-NetAdapter -Name $adapterName -Confirm:$false -ErrorAction Stop

    # 無効化の反映を最大 10 秒待つ（待ちきれなくても有効化へ進む）。
    $disableDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $disableDeadline) {
        $disabled = Get-NetAdapter -Name $adapterName -ErrorAction Stop
        if ([string]$disabled.Status -eq 'Disabled') { break }
        Start-Sleep -Milliseconds 500
    }

    Enable-NetAdapter -Name $adapterName -Confirm:$false -ErrorAction Stop

    # Up になるまで最大 30 秒待つ（端末エージェントの 60 秒タイムアウトより短くする）。
    $deadline = (Get-Date).AddSeconds(30)
    $after = Get-NetAdapter -Name $adapterName -ErrorAction Stop
    while ([string]$after.Status -ne 'Up' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $after = Get-NetAdapter -Name $adapterName -ErrorAction Stop
    }

    [ordered]@{
        name                 = $adapterName
        interfaceDescription = $description
        previousStatus       = $previousStatus
        status               = [string]$after.Status
        restarted            = $true
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    [Console]::Error.WriteLine(("network-adapter-restart の実行に失敗しました: {0}" -f $_.Exception.Message))
    exit 1
}
