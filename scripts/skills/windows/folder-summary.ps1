<#
  folder.summary Skill（読み取り専用 / docs/63 §11）

  目的:
    許可フォルダ直下の件数・種別別件数・合計サイズ・truncated を返す。
    名前を返さない。内容を読まない。再帰しない。リンクを辿らない。オンデマンドファイルを開かない。
  入力:
    stdin の JSON {"params":{"target":"T1"},"target":{"root":"Documents","segments":[],"path":"<最終パス>","rootPath":"<起点の最終パス>"}}。
    対象はヘルパーが解決して渡す。ここでも Resolve-FolderTarget 相当の範囲検査を行う。
  出力:
    標準出力へ JSON 1 行。
    {"accessible":true,"fileCount":2,"directoryCount":1,"linkCount":0,"totalBytes":1024,"truncated":false}
    失敗時は {"accessible":false,"resultCode":"<固定コード>"} と終了コード 1。
  注意:
    Windows API の挙動は実機未実測。
#>
[CmdletBinding()]
param([switch]$NoMain)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:SummaryMaxEntries = 100000
$script:SummaryMaxSeconds = 15
$script:SummaryAttrDirectory = [uint32]16
$script:SummaryAttrReparsePoint = [uint32]1024
$script:SummaryTagNameSurrogateBit = [uint32]536870912
$script:SummaryTagCloudMask = [Convert]::ToUInt32('FFFF0FFF', 16)
$script:SummaryTagCloudBase = [Convert]::ToUInt32('9000001A', 16)

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

function ConvertTo-SummaryPath {
  # \\?\ を外し、ローカルドライブの絶対パスだけを返す。UNC や相対要素は $null。
  param([AllowNull()][string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { return $null }
  $p = $Path
  if ($p.StartsWith('\\?\', [StringComparison]::Ordinal)) { $p = $p.Substring(4) }
  if ($p -cnotmatch '^[A-Za-z]:(\\|$)') { return $null }
  if ($p.IndexOf('/') -ge 0) { return $null }
  if ($p.Length -eq 2) { $p = $p + '\' }
  $tail = $p.Substring(3)
  if ($tail.Length -gt 0) {
    foreach ($part in $tail.TrimEnd('\').Split('\')) {
      if ($part.Length -eq 0 -or $part -ceq '.' -or $part -ceq '..') { return $null }
    }
    $p = $p.TrimEnd('\')
  }
  return $p
}

function Test-SummaryWithin {
  param([AllowNull()][string]$Candidate, [AllowNull()][string]$Root)
  $c = ConvertTo-SummaryPath -Path $Candidate
  $r = ConvertTo-SummaryPath -Path $Root
  if ($null -eq $c -or $null -eq $r) { return $false }
  if ([string]::Equals($c, $r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = if ($r.EndsWith('\', [StringComparison]::Ordinal)) { $r } else { $r + '\' }
  return $c.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-SummaryReparseAllowed {
  param([Parameter(Mandatory)][string]$Path, [uint32]$Attributes, [uint32]$Tag, [AllowNull()][string]$CloudScope)
  if (($Attributes -band $script:SummaryAttrReparsePoint) -eq 0) { return $true }
  if (($Tag -band $script:SummaryTagNameSurrogateBit) -ne 0) { return $false }
  if ([string]::IsNullOrEmpty($CloudScope)) { return $false }
  if (($Tag -band $script:SummaryTagCloudMask) -ne $script:SummaryTagCloudBase) { return $false }
  return (Test-SummaryWithin -Candidate $Path -Root $CloudScope)
}

function Get-SummaryChain {
  param([Parameter(Mandatory)][string]$Path)
  $chain = New-Object System.Collections.Generic.List[string]
  $current = $Path.Substring(0, 3)
  $chain.Add($current)
  $tail = $Path.Substring(3)
  if ($tail.Length -gt 0) {
    foreach ($part in $tail.Split('\')) {
      $current = if ($current.EndsWith('\', [StringComparison]::Ordinal)) { $current + $part } else { $current + '\' + $part }
      $chain.Add($current)
    }
  }
  return ,$chain.ToArray()
}

function ConvertTo-SummaryProbeReason {
  param([int]$Win32Error)
  if ($Win32Error -eq 5) { return 'ACCESS_DENIED' }
  if ($Win32Error -eq 2 -or $Win32Error -eq 3) { return 'NOT_FOUND' }
  return 'IO_ERROR'
}

function Get-SummaryScopeRefusal {
  # Resolve-FolderTarget 相当。問題なければ $null。
  # $Probe: { param($extendedPath, [bool]$openReparsePoint) } -> Error, Attributes, ReparseTag, FinalPath
  param(
    [AllowNull()][string]$TargetPath,
    [AllowNull()][string]$RootPath,
    [AllowNull()][string]$ProfilePath,
    [AllowNull()][string]$OneDrivePath,
    [Parameter(Mandatory)][scriptblock]$Probe
  )
  $target = ConvertTo-SummaryPath -Path $TargetPath
  $root = ConvertTo-SummaryPath -Path $RootPath
  $profileNorm = ConvertTo-SummaryPath -Path $ProfilePath
  if ($null -eq $target -or $null -eq $root -or $null -eq $profileNorm) { return 'OUT_OF_SCOPE' }
  if ($target.Length -eq 3 -or $root.Length -eq 3 -or $profileNorm.Length -eq 3) { return 'OUT_OF_SCOPE' }
  if (-not (Test-SummaryWithin -Candidate $target -Root $root)) { return 'OUT_OF_SCOPE' }

  $profileProbe = & $Probe ('\\?\' + $profileNorm) $false
  if ($profileProbe.Error -ne 0) { return 'OUT_OF_SCOPE' }
  $profileFinal = ConvertTo-SummaryPath -Path $profileProbe.FinalPath
  if ($null -eq $profileFinal) { return 'OUT_OF_SCOPE' }
  $scopes = New-Object System.Collections.Generic.List[string]
  $scopes.Add($profileFinal)
  $cloudScope = $null
  $oneDriveNorm = ConvertTo-SummaryPath -Path $OneDrivePath
  if ($null -ne $oneDriveNorm -and $oneDriveNorm.Length -gt 3) {
    $oneDriveProbe = & $Probe ('\\?\' + $oneDriveNorm) $false
    if ($oneDriveProbe.Error -eq 0) {
      $oneDriveFinal = ConvertTo-SummaryPath -Path $oneDriveProbe.FinalPath
      if ($null -ne $oneDriveFinal -and $oneDriveFinal.Length -gt 3) {
        $scopes.Add($oneDriveFinal)
        $cloudScope = $oneDriveFinal
      }
    }
  }

  foreach ($element in (Get-SummaryChain -Path $target)) {
    $info = & $Probe ('\\?\' + $element) $true
    if ($info.Error -ne 0) { return (ConvertTo-SummaryProbeReason -Win32Error $info.Error) }
    if (-not (Test-SummaryReparseAllowed -Path $element -Attributes $info.Attributes -Tag $info.ReparseTag -CloudScope $cloudScope)) { return 'REPARSE_REJECTED' }
  }

  $rootProbe = & $Probe ('\\?\' + $root) $false
  if ($rootProbe.Error -ne 0) { return (ConvertTo-SummaryProbeReason -Win32Error $rootProbe.Error) }
  $rootFinal = ConvertTo-SummaryPath -Path $rootProbe.FinalPath
  if ($null -eq $rootFinal) { return 'OUT_OF_SCOPE' }
  $inScope = $false
  foreach ($scope in $scopes) { if (Test-SummaryWithin -Candidate $rootFinal -Root $scope) { $inScope = $true } }
  if (-not $inScope) { return 'OUT_OF_SCOPE' }

  $targetProbe = & $Probe ('\\?\' + $target) $false
  if ($targetProbe.Error -ne 0) { return (ConvertTo-SummaryProbeReason -Win32Error $targetProbe.Error) }
  $targetFinal = ConvertTo-SummaryPath -Path $targetProbe.FinalPath
  if ($null -eq $targetFinal) { return 'OUT_OF_SCOPE' }
  # ヘルパーが解決した後に差し替えられていれば最終パスが変わる。
  if (-not [string]::Equals($targetFinal, $target, [StringComparison]::OrdinalIgnoreCase)) { return 'PATH_CHANGED' }
  if (-not (Test-SummaryWithin -Candidate $targetFinal -Root $rootFinal)) { return 'OUT_OF_SCOPE' }
  if (($targetProbe.Attributes -band $script:SummaryAttrDirectory) -eq 0) { return 'NOT_A_DIRECTORY' }
  return $null
}

function New-SummaryAccumulator {
  return @{ Count = [long]0; File = [long]0; Directory = [long]0; Link = [long]0; TotalSize = [long]0; Truncated = $false }
}

function Add-SummaryEntry {
  # 名前を受け取らない。属性・タグ・サイズだけで数える。
  param([Parameter(Mandatory)][hashtable]$Accumulator, [uint32]$Attributes, [uint32]$Tag, [long]$Size)
  $Accumulator.Count++
  if (($Attributes -band $script:SummaryAttrReparsePoint) -ne 0 -and ($Tag -band $script:SummaryTagNameSurrogateBit) -ne 0) {
    $Accumulator.Link++
  } elseif (($Attributes -band $script:SummaryAttrDirectory) -ne 0) {
    $Accumulator.Directory++
  } else {
    $Accumulator.File++
    if ($Size -gt 0) { $Accumulator.TotalSize += $Size }
  }
}

function New-SummaryFailure {
  # 契約のコードへ。範囲の問題は INVALID_TARGET、知らないものは EXEC_FAILED。
  param([Parameter(Mandatory)][string]$Code)
  $mapped = 'EXEC_FAILED'
  foreach ($same in 'ACCESS_DENIED', 'NOT_FOUND', 'INTERNAL_ERROR', 'ELEVATED', 'INVALID_TARGET') { if ($Code -ceq $same) { $mapped = $Code } }
  foreach ($scope in 'OUT_OF_SCOPE', 'REPARSE_REJECTED', 'PATH_CHANGED', 'NOT_A_DIRECTORY', 'BAD_INPUT') { if ($Code -ceq $scope) { $mapped = 'INVALID_TARGET' } }
  if ($Code -ceq 'SERVICE_ACCOUNT' -or $Code -ceq 'NO_IDENTITY') { $mapped = 'ELEVATED' }
  return [ordered]@{ accessible = $false; resultCode = $mapped }
}

function New-SummaryOutput {
  param([Parameter(Mandatory)][hashtable]$Accumulator)
  return [ordered]@{
    accessible     = $true
    fileCount      = $Accumulator.File
    directoryCount = $Accumulator.Directory
    linkCount      = $Accumulator.Link
    totalBytes     = $Accumulator.TotalSize
    truncated      = $Accumulator.Truncated
  }
}

$script:SummaryNativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AIHelpDesk.SkillFolderSummary {
  public sealed class ProbeResult {
    public int Error;
    public uint Attributes;
    public uint ReparseTag;
    public string FinalPath;
  }

  public sealed class EntryInfo {
    public uint Attributes;
    public uint ReparseTag;
    public long Size;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct RawFileTime {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  internal struct FindData {
    public uint dwFileAttributes;
    public RawFileTime ftCreationTime;
    public RawFileTime ftLastAccessTime;
    public RawFileTime ftLastWriteTime;
    public uint nFileSizeHigh;
    public uint nFileSizeLow;
    public uint dwReserved0;
    public uint dwReserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string cFileName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
    public string cAlternateFileName;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct TagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  internal static class Api {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr FindFirstFileExW(string name, int level, out FindData data, int op, IntPtr filter, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindNextFileW(IntPtr handle, out FindData data);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindClose(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out TagInfo info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
  }

  public sealed class Lister : IDisposable {
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private IntPtr handle;
    private FindData first;
    private bool hasFirst;
    public int LastError;

    public Lister(string searchPath) {
      handle = Api.FindFirstFileExW(searchPath, 1, out first, 0, IntPtr.Zero, 2);
      if (handle == Invalid) {
        int error = Marshal.GetLastWin32Error();
        LastError = (error == 2) ? 0 : error;
      } else {
        hasFirst = true;
      }
    }

    // . と .. は名前を外へ出さずここで除く。
    public EntryInfo Next() {
      while (handle != Invalid) {
        FindData data;
        if (hasFirst) {
          hasFirst = false;
          data = first;
        } else if (!Api.FindNextFileW(handle, out data)) {
          LastError = Marshal.GetLastWin32Error();
          return null;
        }
        if (data.cFileName == "." || data.cFileName == "..") { continue; }
        EntryInfo entry = new EntryInfo();
        entry.Attributes = data.dwFileAttributes;
        entry.ReparseTag = data.dwReserved0;
        entry.Size = (long)(((ulong)data.nFileSizeHigh << 32) | data.nFileSizeLow);
        return entry;
      }
      return null;
    }

    public void Dispose() {
      if (handle != Invalid) {
        Api.FindClose(handle);
        handle = Invalid;
      }
    }
  }

  public static class Native {
    private static readonly IntPtr Invalid = new IntPtr(-1);

    public static ProbeResult Probe(string path, bool openReparsePoint) {
      ProbeResult result = new ProbeResult();
      uint flags = 0x02000000;
      if (openReparsePoint) { flags |= 0x00200000; }
      IntPtr handle = Api.CreateFileW(path, 0x80, 0x7, IntPtr.Zero, 3, flags, IntPtr.Zero);
      if (handle == Invalid) {
        result.Error = Marshal.GetLastWin32Error();
        return result;
      }
      try {
        TagInfo info;
        if (!Api.GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(TagInfo)))) {
          result.Error = Marshal.GetLastWin32Error();
          return result;
        }
        result.Attributes = info.FileAttributes;
        result.ReparseTag = info.ReparseTag;
        StringBuilder buffer = new StringBuilder(32768);
        uint length = Api.GetFinalPathNameByHandleW(handle, buffer, 32768, 0);
        if (length == 0 || length >= 32768) {
          result.Error = (length == 0) ? Marshal.GetLastWin32Error() : 122;
          return result;
        }
        result.FinalPath = buffer.ToString();
        return result;
      } finally {
        Api.CloseHandle(handle);
      }
    }
  }
}
'@

function Get-RegistryNoExpand {
  param([Microsoft.Win32.RegistryKey]$Key, [string]$Name)
  if ($null -eq $Key) { return $null }
  try {
    $value = $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $Key.Dispose()
  }
  if ($value -isnot [string] -or $value.IndexOf('%') -ge 0) { return $null }
  return $value
}

function Invoke-FolderSummaryMain {
  $skillInput = $null
  try { $skillInput = Read-SkillInput } catch { Write-SkillJson -Value (New-SummaryFailure -Code 'BAD_INPUT'); return 1 }
  try {
    $refusal = Get-LiveIdentityRefusal
    if ($null -ne $refusal) { Write-SkillJson -Value (New-SummaryFailure -Code $refusal); return 3 }
    $target = $skillInput.target
    if ($null -eq $target) { Write-SkillJson -Value (New-SummaryFailure -Code 'BAD_INPUT'); return 1 }
    Add-Type -TypeDefinition $script:SummaryNativeSource -Language CSharp

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    $profilePath = Get-RegistryNoExpand -Key ($hklm.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid, $false)) -Name 'ProfileImagePath'
    $oneDrivePath = Get-RegistryNoExpand -Key ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\OneDrive', $false)) -Name 'UserFolder'
    $probe = { param($path, $openReparse) [AIHelpDesk.SkillFolderSummary.Native]::Probe($path, [bool]$openReparse) }
    $reason = Get-SummaryScopeRefusal -TargetPath ([string]$target.path) -RootPath ([string]$target.rootPath) -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $probe
    if ($null -ne $reason) { Write-SkillJson -Value (New-SummaryFailure -Code $reason); return 1 }

    $acc = New-SummaryAccumulator
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $normalized = ConvertTo-SummaryPath -Path ([string]$target.path)
    $lister = New-Object AIHelpDesk.SkillFolderSummary.Lister -ArgumentList ('\\?\' + $normalized + '\*')
    try {
      if ($lister.LastError -ne 0) { Write-SkillJson -Value (New-SummaryFailure -Code (ConvertTo-SummaryProbeReason -Win32Error $lister.LastError)); return 1 }
      while ($true) {
        if ($acc.Count -ge $script:SummaryMaxEntries -or $watch.Elapsed.TotalSeconds -ge $script:SummaryMaxSeconds) { $acc.Truncated = $true; break }
        $entry = $lister.Next()
        if ($null -eq $entry) { break }
        Add-SummaryEntry -Accumulator $acc -Attributes $entry.Attributes -Tag $entry.ReparseTag -Size $entry.Size
      }
      # 18 = ERROR_NO_MORE_FILES。途中で失敗した集計は返さない。
      if (-not $acc.Truncated -and $lister.LastError -ne 0 -and $lister.LastError -ne 18) {
        Write-SkillJson -Value (New-SummaryFailure -Code (ConvertTo-SummaryProbeReason -Win32Error $lister.LastError))
        return 1
      }
    } finally {
      $lister.Dispose()
    }
    Write-SkillJson -Value (New-SummaryOutput -Accumulator $acc)
    return 0
  } catch {
    # 例外メッセージはパスを含み得るので出さない。
    Write-SkillJson -Value (New-SummaryFailure -Code 'INTERNAL_ERROR')
    return 1
  }
}

if (-not $NoMain) {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { $null = $_ }
  exit (Invoke-FolderSummaryMain)
}
