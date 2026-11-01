<#
  diag.sleep Skill（検証専用 / 停止試験 / 本番の manifest に載せない）

  目的:
    孫プロセスを作って待つだけ。Job Object の終了で孫まで止まるかを確かめる。データに触れない。
  入力:
    stdin の JSON {"params":{"seconds":30,"children":2},"target":null}。seconds は 1-300、children は 0-3。
  出力:
    標準出力へ JSON 1 行（最後まで待てたときだけ）。
    {"slept":30,"children":2}
    失敗時は {"resultCode":"<固定コード>"} と終了コード 1。
  注意:
    Windows API の挙動は実機未実測。孫のコマンドは整数のみを埋めた固定形。
#>
[CmdletBinding()]
param([switch]$NoMain)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Read-SkillInput {
  # stdin の JSON を読む（UTF-8、上限 64KB）。ヘルパーが Job と SID を確認してから渡すので、これより前に何もしない。
  param([IO.Stream]$Stream)
  if ($null -eq $Stream) { $Stream = [Console]::OpenStandardInput() }
  $memory = New-Object IO.MemoryStream
  $buffer = New-Object byte[] 4096
  while ($true) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { break }
    if (($memory.Length + $read) -gt 65536) { throw 'INPUT_TOO_LARGE' }
    $memory.Write($buffer, 0, $read)
  }
  $text = (New-Object Text.UTF8Encoding -ArgumentList @($false, $true)).GetString($memory.ToArray())
  return (ConvertFrom-Json -InputObject $text)
}

function Get-IdentityRefusal {
  # 本人の非昇格トークン以外では動かない。SYSTEM へ切り替える経路は持たない。
  param([AllowNull()][string]$Sid, [bool]$IsAdministrator)
  if ([string]::IsNullOrEmpty($Sid)) { return 'NO_IDENTITY' }
  if ($Sid -ceq 'S-1-5-18' -or $Sid -ceq 'S-1-5-19' -or $Sid -ceq 'S-1-5-20') { return 'SERVICE_ACCOUNT' }
  if ($IsAdministrator) { return 'ELEVATED' }
  return $null
}

function Get-LiveIdentityRefusal {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
  return (Get-IdentityRefusal -Sid $identity.User.Value -IsAdministrator $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
}

function Write-SkillJson {
  param([Parameter(Mandatory)][object]$Value)
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Write("`n")
}

function Test-DiagParams {
  param([AllowNull()][object]$Params)
  if ($null -eq $Params) { return $false }
  foreach ($name in 'seconds', 'children') { if ($null -eq $Params.PSObject.Properties[$name]) { return $false } }
  $seconds = $Params.seconds
  $children = $Params.children
  if (($seconds -isnot [int] -and $seconds -isnot [long]) -or ($children -isnot [int] -and $children -isnot [long])) { return $false }
  return ($seconds -ge 1 -and $seconds -le 300 -and $children -ge 0 -and $children -le 3)
}

function New-DiagChildArguments {
  param([Parameter(Mandatory)][int]$Seconds)
  return ('-NoProfile -NonInteractive -Command "Start-Sleep -Seconds {0}"' -f $Seconds)
}

function Invoke-DiagSleepMain {
  $skillInput = $null
  try { $skillInput = Read-SkillInput } catch { Write-SkillJson -Value ([ordered]@{ resultCode = 'BAD_INPUT' }); return 1 }
  try {
    $refusal = Get-LiveIdentityRefusal
    if ($null -ne $refusal) { Write-SkillJson -Value ([ordered]@{ resultCode = $refusal }); return 3 }
    if (-not (Test-DiagParams -Params $skillInput.params)) { Write-SkillJson -Value ([ordered]@{ resultCode = 'INVALID_PARAMS' }); return 1 }
    $seconds = [int]$skillInput.params.seconds
    $children = [int]$skillInput.params.children
    for ($i = 0; $i -lt $children; $i++) {
      $info = New-Object Diagnostics.ProcessStartInfo
      $info.FileName = [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0\powershell.exe'
      $info.Arguments = New-DiagChildArguments -Seconds $seconds
      $info.UseShellExecute = $false
      $info.CreateNoWindow = $true
      $null = [Diagnostics.Process]::Start($info)
    }
    Start-Sleep -Seconds $seconds
    Write-SkillJson -Value ([ordered]@{ slept = $seconds; children = $children })
    return 0
  } catch {
    Write-SkillJson -Value ([ordered]@{ resultCode = 'INTERNAL_ERROR' })
    return 1
  }
}

if (-not $NoMain) {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { $null = $_ }
  exit (Invoke-DiagSleepMain)
}
