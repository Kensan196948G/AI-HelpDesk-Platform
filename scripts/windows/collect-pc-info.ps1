#Requires -Version 5.1
<#
.SYNOPSIS
  AI HelpDesk 端末情報コレクタ（Windows / 読み取り専用 / Node不要）。

.DESCRIPTION
  ログオン時やタスクスケジューラから1回実行し、端末のハードウェア・導入ソフト・
  セキュリティ状態を API（/api/device/agent）へ送信する。常駐プロセスは持たない。
  ファイル内容・閲覧履歴・画面・キー入力・メール本文は取得しない。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\collect-pc-info.ps1 -DryRun -PrintJson
  powershell -ExecutionPolicy Bypass -File .\collect-pc-info.ps1
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\ai-helpdesk\device-agent-windows.json'),
  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'AIHelpDesk\collector.log'),
  [switch]$DryRun,
  [switch]$PrintJson
)

$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

function Write-CollectorLog {
  param([string]$Message)
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value ('{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message) -Encoding UTF8
  } catch { }
}

function Get-Safe {
  param([scriptblock]$Block)
  try { & $Block } catch { Write-Verbose ('command failed: ' + $_.Exception.Message); $null }
}

function Get-ArraySafe {
  param([scriptblock]$Block)
  try { @(& $Block | Where-Object { $null -ne $_ }) } catch { Write-Verbose ('command failed: ' + $_.Exception.Message); @() }
}

function Remove-NullValues {
  param($InputObject)
  if ($null -eq $InputObject) { return $null }
  if ($InputObject -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $InputObject.Keys) {
      $value = Remove-NullValues $InputObject[$key]
      if ($null -ne $value) { $result[$key] = $value }
    }
    return $result
  }
  if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
    $list = @()
    foreach ($item in $InputObject) {
      $value = Remove-NullValues $item
      if ($null -ne $value) { $list += ,$value }
    }
    return ,$list
  }
  return $InputObject
}

try {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "設定ファイルが見つかりません: $ConfigPath"
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $config.url) { throw '設定ファイルに url がありません。' }
  if (-not $DryRun -and -not $config.deviceToken) { throw '設定ファイルに deviceToken がありません。' }

  $onWindows = ($env:OS -eq 'Windows_NT')
  $os = Get-Safe { Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop }
  $cs = Get-Safe { Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop }
  $cpu = Get-Safe { Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1 }
  $bios = Get-Safe { Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop }
  $enclosure = Get-Safe { Get-CimInstance -ClassName Win32_SystemEnclosure -ErrorAction Stop | Select-Object -First 1 }

  $hostname = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
  $deviceId = if ($config.deviceId) { [string]$config.deviceId } else { $hostname }
  $arch = if ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
  $platform = if ($onWindows) { 'Windows' } elseif ([System.Runtime.InteropServices.RuntimeInformation]::OSDescription -match 'Darwin') { 'macOS' } elseif ($PSVersionTable.Platform -eq 'Unix') { 'Linux' } else { 'Unknown' }
  $osName = if ($os) {
    $caption = ('{0} {1}' -f $os.Caption, $os.Version).Trim()
    if ($os.BuildNumber) { $caption = ('{0} (build {1})' -f $caption, $os.BuildNumber) }
    $caption
  } else {
    [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
  }

  $cpuInfo = [ordered]@{
    model = if ($cpu) { $cpu.Name } else { $null }
    cores = if ($cpu) { $cpu.NumberOfCores } else { $null }
    logicalCores = if ($cpu) { $cpu.NumberOfLogicalProcessors } else { $null }
    speedMHz = if ($cpu) { $cpu.MaxClockSpeed } else { $null }
    usagePercent = if ($cpu) { $cpu.LoadPercentage } else { $null }
  }

  $totalMemory = if ($cs -and $cs.TotalPhysicalMemory) { [double]$cs.TotalPhysicalMemory } else { $null }
  $freeMemory = if ($os -and $os.FreePhysicalMemory) { [double]$os.FreePhysicalMemory * 1024 } else { $null }
  $memoryUsage = if ($totalMemory -and $null -ne $freeMemory) {
    [Math]::Round((1 - ($freeMemory / $totalMemory)) * 100)
  } else { $null }

  $disks = @()
  foreach ($disk in Get-ArraySafe { Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop }) {
    if (-not $disk) { continue }
    $disks += [ordered]@{
      name = if ($disk.VolumeName) { $disk.VolumeName } else { $disk.DeviceID }
      mount = $disk.DeviceID
      totalBytes = if ($disk.Size) { [double]$disk.Size } else { $null }
      freeBytes = if ($disk.FreeSpace -ne $null) { [double]$disk.FreeSpace } else { $null }
    }
  }

  $gpus = @()
  foreach ($gpu in Get-ArraySafe { Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop }) {
    if (-not $gpu) { continue }
    $gpus += [ordered]@{
      name = $gpu.Name
      vendor = $gpu.AdapterCompatibility
      driver = $gpu.DriverVersion
    }
  }

  $adapters = @()
  foreach ($adapter in Get-ArraySafe { Get-NetAdapter -ErrorAction Stop }) {
    if (-not $adapter) { continue }
    $label = ('{0} {1}' -f $adapter.Name, $adapter.InterfaceDescription)
    $adapters += [ordered]@{
      name = $adapter.Name
      type = $adapter.InterfaceDescription
      status = [string]$adapter.Status
      vpn = [bool]($label -match 'vpn|wireguard|forti|anyconnect|globalprotect|openvpn|tap|tun')
    }
  }

  $ipv4 = @()
  foreach ($address in Get-ArraySafe { Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop }) {
    if ($address -and $address.IPAddress -and $address.IPAddress -notlike '127.*') {
      $ipv4 += [string]$address.IPAddress
    }
  }

  $batteryItem = Get-Safe { Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop | Select-Object -First 1 }
  $battery = if ($batteryItem) {
    [ordered]@{
      levelPercent = if ($batteryItem.EstimatedChargeRemaining -ne $null) { [double]$batteryItem.EstimatedChargeRemaining } else { $null }
      charging = ([string]$batteryItem.BatteryStatus -eq '2')
    }
  } else { $null }

  $sound = Get-ArraySafe { Get-CimInstance -ClassName Win32_SoundDevice -ErrorAction Stop }
  $usb = Get-ArraySafe { Get-CimInstance -ClassName Win32_USBHub -ErrorAction Stop }
  $spooler = Get-Safe { (Get-Service -Name Spooler -ErrorAction Stop).Status.ToString() }
  $printerItems = Get-ArraySafe { Get-Printer -ErrorAction Stop }
  $printJobs = Get-ArraySafe { Get-PrintJob -ErrorAction Stop }
  $printers = @()
  foreach ($printer in $printerItems) {
    if (-not $printer) { continue }
    $jobs = @($printJobs | Where-Object { $_.PrinterName -eq $printer.Name }).Count
    $printers += [ordered]@{
      name = $printer.Name
      status = [string]$printer.PrinterStatus
      jobs = $jobs
    }
  }

  $software = @()
  $registryPaths = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $apps = Get-Safe {
    Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName } |
      Select-Object DisplayName, DisplayVersion, Publisher -Unique |
      Sort-Object DisplayName
  }
  foreach ($app in @($apps)) {
    if (-not $app -or -not $app.DisplayName) { continue }
    $software += [ordered]@{
      name = [string]$app.DisplayName
      version = if ($app.DisplayVersion) { [string]$app.DisplayVersion } else { $null }
      publisher = if ($app.Publisher) { [string]$app.Publisher } else { $null }
    }
    if ($software.Count -ge 300) { break }
  }

  $defender = Get-Safe { Get-MpComputerStatus -ErrorAction Stop }
  $bitlocker = Get-ArraySafe { Get-BitLockerVolume -ErrorAction Stop }
  $encryptable = Get-ArraySafe { Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -ErrorAction Stop }
  $hotfix = Get-Safe { Get-HotFix -ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 1 }
  $recentErrors = Get-Safe {
    (Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-1) } -ErrorAction SilentlyContinue | Measure-Object).Count
  }
  $firewall = Get-Safe { Get-NetFirewallProfile -ErrorAction Stop | Select-Object -First 1 }

  $antivirus = if ($defender) {
    [ordered]@{
      enabled = [bool]$defender.AntivirusEnabled
      name = 'Microsoft Defender'
      signature = if ($defender.AntivirusSignatureVersion) { [string]$defender.AntivirusSignatureVersion } else { $null }
    }
  } else { $null }

  $bitlockerEnabled = if ($bitlocker.Count -gt 0) {
    [bool](@($bitlocker | Where-Object { [string]$_.ProtectionStatus -match '^(On|1)$' }).Count -gt 0)
  } elseif ($encryptable.Count -gt 0) {
    # 非管理者でも Win32_EncryptableVolume から保護状態を取得できる場合がある。
    [bool](@($encryptable | Where-Object { [string]$_.ProtectionStatus -match '^(1|On)$' }).Count -gt 0)
  } else { $null }
  $diskEncryption = if ($null -ne $bitlockerEnabled) {
    [ordered]@{ enabled = $bitlockerEnabled; detail = 'BitLocker' }
  } else { $null }

  $assetTag = if ($enclosure -and $enclosure.SMBIOSAssetTag) { ([string]$enclosure.SMBIOSAssetTag).Trim() } else { '' }

  $payload = [ordered]@{
    deviceId = $deviceId
    hostname = $hostname
    os = $osName
    platform = $platform
    arch = $arch
    hardware = [ordered]@{
      assetNo = if ($assetTag) { $assetTag } elseif ($env:AIHD_ASSET_NO) { $env:AIHD_ASSET_NO } else { $null }
      serial = if ($bios -and $bios.SerialNumber) { [string]$bios.SerialNumber } else { $null }
      model = if ($cs) { $cs.Model } else { $null }
      manufacturer = if ($cs) { $cs.Manufacturer } else { $null }
      domainJoined = if ($cs -and $cs.PartOfDomain) { ('ドメイン参加済み（{0}）' -f $cs.Domain) } elseif ($cs) { '未参加（ワークグループ）' } else { $null }
      cpu = $cpuInfo
      memory = [ordered]@{
        totalBytes = $totalMemory
        freeBytes = $freeMemory
        usagePercent = $memoryUsage
      }
      disks = @($disks)
      gpu = @($gpus)
      network = [ordered]@{
        adapters = @($adapters)
        ipv4 = @($ipv4)
        online = $true
      }
      battery = $battery
      mediaDevices = [ordered]@{ audioOutput = if ($sound.Count -gt 0) { $sound.Count } else { $null } }
      printers = @($printers)
      printSpooler = if ($spooler) { if ($spooler -eq 'Running') { '実行中' } else { '停止' } } else { $null }
      audioOutput = if ($sound.Count -gt 0 -and $sound[0].Name) { [string]$sound[0].Name } else { $null }
      usbDevices = if ($usb.Count -gt 0) { $usb.Count } else { $null }
      uptimeSeconds = if ($os -and $os.LastBootUpTime) { [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalSeconds) } else { $null }
    }
    software = @($software)
    security = [ordered]@{
      antivirus = $antivirus
      diskEncryption = $diskEncryption
      windowsUpdate = [ordered]@{
        pending = $null
        lastInstalled = if ($hotfix -and $hotfix.HotFixID) { [string]$hotfix.HotFixID } else { $null }
        detail = if ($hotfix -and $hotfix.HotFixID) { ('最新の更新: {0}' -f $hotfix.HotFixID) } else { $null }
      }
      firewall = if ($firewall) { [ordered]@{ enabled = ([string]$firewall.Enabled -eq 'True'); detail = [string]$firewall.Name } } else { $null }
      recentErrors = $recentErrors
    }
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  if ($config.browserDeviceId) {
    $payload.browserDeviceId = [string]$config.browserDeviceId
  }

  $clean = Remove-NullValues $payload
  $json = $clean | ConvertTo-Json -Depth 12 -Compress

  $summary = '[agent] host={0} os={1} software={2} browserDeviceId={3}' -f $hostname, $osName, $software.Count, $config.browserDeviceId
  if ($DryRun) {
    Write-Output ('[agent] dry-run ' + $summary)
    if ($PrintJson) { Write-Output $json }
    exit 0
  }

  $headers = @{ 'X-Device-Token' = [string]$config.deviceToken }
  if ($config.proxySecret) { $headers['X-Proxy-Secret'] = [string]$config.proxySecret }
  $response = Invoke-RestMethod -Method Post -Uri $config.url -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60

  $linked = if ($response.PSObject.Properties.Name -contains 'linked') { $response.linked } else { '?' }
  $items = if ($response.snapshot -and $response.snapshot.items) { @($response.snapshot.items).Count } else { '?' }
  $message = '[agent] posted {0} linked={1} snapshot_items={2}' -f $summary, $linked, $items
  Write-Output $message
  Write-CollectorLog $message
  exit 0
} catch {
  $message = '[agent] ERROR ' + $_.Exception.Message
  if ($_.ScriptStackTrace) { $message += ' | ' + $_.ScriptStackTrace }
  Write-Error $message
  Write-CollectorLog $message
  exit 1
}
