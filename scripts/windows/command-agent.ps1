# AI HelpDesk 実端末コマンドエージェント（Windows / 許可リストのみ）
#
# 使い方（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\command-agent.ps1 `
#     -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
#   # 1回だけ確認する場合
#   ... -Once
#
# 対応操作: SPOOLER_RESTART（Restart-Service Spooler）
# 注意: 管理者権限が必要な場合があります。サービス停止中は印刷が一時的にできません。

param(
  [string]$ConfigPath = "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json",
  [int]$IntervalSeconds = 5,
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
if (-not $cfg.deviceToken) { throw "deviceToken が設定されていません: $ConfigPath" }
if (-not $cfg.url) { throw "url が設定されていません: $ConfigPath" }

$base = ($cfg.url -replace '/api/device/agent/?$', '').TrimEnd('/')
$commandUrl = "$base/api/device/command"

$headers = @{ Accept = 'application/json'; 'x-device-token' = $cfg.deviceToken }
if ($cfg.cfAccessClientId) {
  $headers['CF-Access-Client-Id'] = $cfg.cfAccessClientId
  $headers['CF-Access-Client-Secret'] = $cfg.cfAccessClientSecret
}
if ($cfg.proxySecret) { $headers['x-proxy-secret'] = $cfg.proxySecret }

function Invoke-CommandTick {
  try {
    $resp = Invoke-RestMethod -Uri $commandUrl -Headers $headers -Method Get
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 204) { return }
    throw
  }
  if (-not $resp -or -not $resp.command) { return }
  $cmd = $resp.command
  Write-Host ("[{0}] command {1} {2}" -f (Get-Date -Format o), $cmd.id, $cmd.op_id)

  try {
    switch ($cmd.op_id) {
      'SPOOLER_RESTART' {
        if ($DryRun) {
          Write-Host 'dry-run: 実行しません'
          return
        }
        Restart-Service -Name Spooler -Force
        $result = @{ opId = 'SPOOLER_RESTART'; platform = 'win32'; executedAt = (Get-Date).ToString('o') }
        $body = @{ ok = $true; result = $result } | ConvertTo-Json -Depth 5
      }
      default { throw "未対応の操作です: $($cmd.op_id)" }
    }
    Invoke-RestMethod -Uri "$commandUrl/$($cmd.id)/result" -Headers $headers -Method Post `
      -ContentType 'application/json' -Body $body | Out-Null
    Write-Host ("done {0}" -f $cmd.id)
  } catch {
    $err = $_.Exception.Message
    $body = @{ ok = $false; error = $err } | ConvertTo-Json -Depth 5
    try {
      Invoke-RestMethod -Uri "$commandUrl/$($cmd.id)/result" -Headers $headers -Method Post `
        -ContentType 'application/json' -Body $body | Out-Null
    } catch { }
    Write-Host ("failed {0}: {1}" -f $cmd.id, $err)
  }
}

Write-Host "command-agent start: $commandUrl"
do {
  try { Invoke-CommandTick } catch { Write-Host ("poll error: {0}" -f $_.Exception.Message) }
  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSeconds
} while ($true)
