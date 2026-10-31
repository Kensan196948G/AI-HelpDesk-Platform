<#
  user.marker.status Skill（読み取り専用 / 確認操作 / docs/63 §11、contract.ts）

  目的:
    HKCU\Software\AIHelpDesk\Verify の合成値の有無と値を返す。変更しない。
  入力:
    stdin の JSON {"params":{},"target":null}。
  出力:
    標準出力へ JSON 1 行。
    {"present":true,"value":"VERIFY_A"}
    失敗時は {"resultCode":"<固定コード>"} と終了コード 1。
  注意:
    Windows API の挙動は実機未実測。
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

$script:MarkerSubKey = 'Software\AIHelpDesk\Verify'
$script:MarkerValueName = 'Marker'
$script:MarkerValues = @('VERIFY_A', 'VERIFY_B')

function Test-MarkerValue {
  param([AllowNull()][object]$Value)
  if ($Value -isnot [string]) { return $false }
  foreach ($allowed in $script:MarkerValues) { if ($Value -ceq $allowed) { return $true } }
  return $false
}

function New-MarkerRegistryStore {
  # 合成値の 1 つだけを読み書きする。種類や形が違う値は Kind で知らせる（上書きしない）。
  return @{
    Read   = {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:MarkerSubKey, $false)
      if ($null -eq $key) { return @{ Exists = $false; Kind = 'none'; Value = $null } }
      try {
        $value = $key.GetValue($script:MarkerValueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { return @{ Exists = $false; Kind = 'none'; Value = $null } }
        if ($key.GetValueKind($script:MarkerValueName) -ne [Microsoft.Win32.RegistryValueKind]::String) { return @{ Exists = $true; Kind = 'other'; Value = $null } }
        if ($value -cnotmatch '^[A-Z0-9_-]{1,32}$') { return @{ Exists = $true; Kind = 'other'; Value = $null } }
        return @{ Exists = $true; Kind = 'marker'; Value = [string]$value }
      } finally {
        $key.Dispose()
      }
    }
    Write  = {
      param($value)
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($script:MarkerSubKey)
      try { $key.SetValue($script:MarkerValueName, [string]$value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    }
    Delete = {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:MarkerSubKey, $true)
      if ($null -eq $key) { return }
      try { $key.DeleteValue($script:MarkerValueName, $false) } finally { $key.Dispose() }
    }
  }
}

function Invoke-MarkerStatus {
  # 結果の辞書を返す。拒否は resultCode を含む。形の違う値は出力しない。
  param([AllowNull()][object]$Params, [Parameter(Mandatory)][hashtable]$Store)
  if ($null -eq $Params -or @($Params.PSObject.Properties).Count -ne 0) { return [ordered]@{ resultCode = 'INVALID_PARAMS' } }
  $current = & $Store.Read
  if ($current.Kind -ceq 'other') { return [ordered]@{ resultCode = 'UNEXPECTED_VALUE' } }
  return [ordered]@{ present = [bool]$current.Exists; value = $current.Value }
}

function Invoke-MarkerStatusMain {
  $skillInput = $null
  try { $skillInput = Read-SkillInput } catch { Write-SkillJson -Value ([ordered]@{ resultCode = 'BAD_INPUT' }); return 1 }
  try {
    $refusal = Get-LiveIdentityRefusal
    if ($null -ne $refusal) { Write-SkillJson -Value ([ordered]@{ resultCode = $refusal }); return 3 }
    $result = Invoke-MarkerStatus -Params $skillInput.params -Store (New-MarkerRegistryStore)
    Write-SkillJson -Value $result
    if ($result.Contains('resultCode')) { return 1 }
    return 0
  } catch {
    Write-SkillJson -Value ([ordered]@{ resultCode = 'INTERNAL_ERROR' })
    return 1
  }
}

if (-not $NoMain) {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { $null = $_ }
  exit (Invoke-MarkerStatusMain)
}
