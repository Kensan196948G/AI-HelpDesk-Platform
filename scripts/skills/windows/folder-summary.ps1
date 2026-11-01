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
  param([Parameter(Mandatory)][string]$Path, [uint32]$Attributes, [uint32]$Tag, [AllowNull()][AllowEmptyCollection()][string[]]$CloudScope)
  if (($Attributes -band $script:SummaryAttrReparsePoint) -eq 0) { return $true }
  if (($Tag -band $script:SummaryTagNameSurrogateBit) -ne 0) { return $false }
  if (($Tag -band $script:SummaryTagCloudMask) -ne $script:SummaryTagCloudBase) { return $false }
  foreach ($scope in @($CloudScope)) {
    if ([string]::IsNullOrEmpty($scope)) { continue }
    if (Test-SummaryWithin -Candidate $Path -Root $scope) { return $true }
  }
  return $false
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

function Get-SummaryCloudScopes {
  # ヘルパーの Get-CloudScopes と同じ判定。OneDrive の UserFolder の候補のうち、最終パスが本人のプロファイル配下か、
  # 起点の最終パスを含むものだけを範囲にする。プロファイル自身・その祖先・ドライブ直下は認めない。
  param(
    [AllowNull()][AllowEmptyCollection()][string[]]$Candidates,
    [Parameter(Mandatory)][string]$ProfileFinal,
    [AllowNull()][string]$RootFinal,
    [Parameter(Mandatory)][scriptblock]$Probe
  )
  $scopes = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @($Candidates)) {
    $norm = ConvertTo-SummaryPath -Path $candidate
    if ($null -eq $norm -or $norm.Length -le 3) { continue }
    $info = & $Probe ('\\?\' + $norm) $false
    if ($info.Error -ne 0) { continue }
    $final = ConvertTo-SummaryPath -Path $info.FinalPath
    if ($null -eq $final -or $final.Length -le 3) { continue }
    if (Test-SummaryWithin -Candidate $ProfileFinal -Root $final) { continue }
    $underProfile = Test-SummaryWithin -Candidate $final -Root $ProfileFinal
    $holdsRoot = (-not [string]::IsNullOrEmpty($RootFinal)) -and (Test-SummaryWithin -Candidate $RootFinal -Root $final)
    if (-not $underProfile -and -not $holdsRoot) { continue }
    $known = $false
    foreach ($existing in $scopes) { if ([string]::Equals($existing, $final, [StringComparison]::OrdinalIgnoreCase)) { $known = $true } }
    if (-not $known) { $scopes.Add($final) }
  }
  return $scopes.ToArray()
}

function Get-SummaryScopeRefusal {
  # Resolve-FolderTarget 相当。問題なければ $null。
  # $Probe: { param($extendedPath, [bool]$openReparsePoint) } -> Error, Attributes, ReparseTag, FinalPath
  param(
    [AllowNull()][string]$TargetPath,
    [AllowNull()][string]$RootPath,
    [AllowNull()][string]$ProfilePath,
    [AllowNull()][AllowEmptyCollection()][string[]]$OneDrivePath,
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
  $rootForScope = & $Probe ('\\?\' + $root) $false
  $rootFinalForScope = if ($rootForScope.Error -eq 0) { ConvertTo-SummaryPath -Path $rootForScope.FinalPath } else { $null }
  $cloudScope = @(Get-SummaryCloudScopes -Candidates $OneDrivePath -ProfileFinal $profileFinal -RootFinal $rootFinalForScope -Probe $Probe)
  $scopes = New-Object System.Collections.Generic.List[string]
  $scopes.Add($profileFinal)
  foreach ($scope in $cloudScope) { $scopes.Add($scope) }

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

function Get-SummaryHandleRefusal {
  # 保持したハンドルが検査した対象そのものか。パスではなくハンドルの実体で判定する。
  # $Info: Error, Attributes, ReparseTag, FinalPath（DirectoryHandle.Describe の結果）
  param([Parameter(Mandatory)][object]$Info, [AllowNull()][string]$TargetPath, [AllowNull()][AllowEmptyCollection()][string[]]$CloudScope)
  if ($Info.Error -ne 0) { return (ConvertTo-SummaryProbeReason -Win32Error $Info.Error) }
  $target = ConvertTo-SummaryPath -Path $TargetPath
  $final = ConvertTo-SummaryPath -Path $Info.FinalPath
  if ($null -eq $target -or $null -eq $final) { return 'OUT_OF_SCOPE' }
  if (-not (Test-SummaryReparseAllowed -Path $target -Attributes $Info.Attributes -Tag $Info.ReparseTag -CloudScope $CloudScope)) { return 'REPARSE_REJECTED' }
  if (($Info.Attributes -band $script:SummaryAttrDirectory) -eq 0) { return 'NOT_A_DIRECTORY' }
  if (-not [string]::Equals($final, $target, [StringComparison]::OrdinalIgnoreCase)) { return 'PATH_CHANGED' }
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

  [StructLayout(LayoutKind.Sequential)]
  internal struct TagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  internal static class Api {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out TagInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
  }

  // 検査したディレクトリそのものを列挙する。パスを開き直さないので、検査の後に
  // ジャンクションへ差し替えられても範囲外を読まない。FILE_SHARE_DELETE を渡さないので、
  // 開いている間は対象を改名・削除できない。
  public sealed class DirectoryHandle : IDisposable {
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private const int InfoClassIdBothRestart = 11;
    private const int InfoClassIdBoth = 10;
    private const int OffsetEndOfFile = 40;
    private const int OffsetAttributes = 56;
    private const int OffsetNameLength = 60;
    private const int OffsetEaSize = 64;
    private const int OffsetName = 104;
    private IntPtr handle;
    private readonly IntPtr buffer;
    private const int BufferSize = 65536;
    private int offset;
    private bool hasData;
    private bool started;
    public int LastError;

    public DirectoryHandle(string path) {
      buffer = Marshal.AllocHGlobal(BufferSize);
      // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES、共有は READ | WRITE のみ。
      // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT（リンクを辿らない）。
      handle = Api.CreateFileW(path, 0x81, 0x3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      if (handle == Invalid) { LastError = Marshal.GetLastWin32Error(); }
    }

    public ProbeResult Describe() {
      ProbeResult result = new ProbeResult();
      if (handle == Invalid) { result.Error = LastError; return result; }
      TagInfo info;
      if (!Api.GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(TagInfo)))) {
        result.Error = Marshal.GetLastWin32Error();
        return result;
      }
      result.Attributes = info.FileAttributes;
      result.ReparseTag = info.ReparseTag;
      StringBuilder path = new StringBuilder(32768);
      uint length = Api.GetFinalPathNameByHandleW(handle, path, 32768, 0);
      if (length == 0 || length >= 32768) {
        result.Error = (length == 0) ? Marshal.GetLastWin32Error() : 122;
        return result;
      }
      result.FinalPath = path.ToString();
      return result;
    }

    public EntryInfo Next() {
      while (true) {
        if (!hasData) {
          int infoClass = started ? InfoClassIdBoth : InfoClassIdBothRestart;
          if (!Api.GetFileInformationByHandleEx(handle, infoClass, buffer, (uint)BufferSize)) {
            LastError = Marshal.GetLastWin32Error();
            return null;
          }
          started = true;
          hasData = true;
          offset = 0;
        }
        IntPtr entry = new IntPtr(buffer.ToInt64() + offset);
        int next = Marshal.ReadInt32(entry, 0);
        int nameLength = Marshal.ReadInt32(entry, OffsetNameLength);
        bool isDot = false;
        if (nameLength == 2 || nameLength == 4) {
          // 名前は . と .. の判定だけに使い、保持しない。
          short first = Marshal.ReadInt16(entry, OffsetName);
          short second = nameLength == 4 ? Marshal.ReadInt16(entry, OffsetName + 2) : (short)'.';
          isDot = first == (short)'.' && second == (short)'.';
        }
        uint attributes = (uint)Marshal.ReadInt32(entry, OffsetAttributes);
        uint tag = (attributes & 0x400) != 0 ? (uint)Marshal.ReadInt32(entry, OffsetEaSize) : 0;
        long size = Marshal.ReadInt64(entry, OffsetEndOfFile);
        if (next == 0) { hasData = false; } else { offset += next; }
        if (isDot) { continue; }
        EntryInfo info = new EntryInfo();
        info.Attributes = attributes;
        info.ReparseTag = tag;
        info.Size = size;
        return info;
      }
    }

    public void Dispose() {
      if (handle != Invalid) { Api.CloseHandle(handle); handle = Invalid; }
      Marshal.FreeHGlobal(buffer);
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

function Test-SummaryAccountName {
  param([AllowNull()][string]$Name)
  return ($Name -match '^(Business[0-9]{0,3}|Personal)$')
}

function Get-SummaryOneDriveFolders {
  # 旧来の値と Accounts\Business*、Accounts\Personal の値。候補を集めるだけで、判定は Get-SummaryCloudScopes が行う。
  $folders = New-Object System.Collections.Generic.List[string]
  $legacy = Get-RegistryNoExpand -Key ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\OneDrive', $false)) -Name 'UserFolder'
  if ($null -ne $legacy) { $folders.Add($legacy) }
  $accounts = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\OneDrive\Accounts', $false)
  if ($null -ne $accounts) {
    try {
      foreach ($name in $accounts.GetSubKeyNames()) {
        if (-not (Test-SummaryAccountName -Name $name)) { continue }
        $value = Get-RegistryNoExpand -Key ($accounts.OpenSubKey($name, $false)) -Name 'UserFolder'
        if ($null -ne $value) { $folders.Add($value) }
      }
    } finally {
      $accounts.Dispose()
    }
  }
  return $folders.ToArray()
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
    $oneDrivePath = @(Get-SummaryOneDriveFolders)
    $probe = { param($path, $openReparse) [AIHelpDesk.SkillFolderSummary.Native]::Probe($path, [bool]$openReparse) }
    $reason = Get-SummaryScopeRefusal -TargetPath ([string]$target.path) -RootPath ([string]$target.rootPath) -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $probe
    if ($null -ne $reason) { Write-SkillJson -Value (New-SummaryFailure -Code $reason); return 1 }

    # Get-SummaryScopeRefusal が通ったので、プロファイルと起点は解決できる。
    $profileForHandle = ConvertTo-SummaryPath -Path (& $probe ('\\?\' + (ConvertTo-SummaryPath -Path $profilePath)) $false).FinalPath
    $rootForHandle = ConvertTo-SummaryPath -Path (& $probe ('\\?\' + (ConvertTo-SummaryPath -Path ([string]$target.rootPath))) $false).FinalPath
    $cloudScopeForHandle = @(Get-SummaryCloudScopes -Candidates $oneDrivePath -ProfileFinal $profileForHandle -RootFinal $rootForHandle -Probe $probe)

    $acc = New-SummaryAccumulator
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $normalized = ConvertTo-SummaryPath -Path ([string]$target.path)
    # 検査の後でパスを開き直さない。開いたハンドルが検査した対象であることを確かめ、そのハンドルを列挙する。
    $directory = New-Object AIHelpDesk.SkillFolderSummary.DirectoryHandle -ArgumentList ('\\?\' + $normalized)
    try {
      $handleRefusal = Get-SummaryHandleRefusal -Info $directory.Describe() -TargetPath $normalized -CloudScope $cloudScopeForHandle
      if ($null -ne $handleRefusal) { Write-SkillJson -Value (New-SummaryFailure -Code $handleRefusal); return 1 }
      while ($true) {
        if ($acc.Count -ge $script:SummaryMaxEntries -or $watch.Elapsed.TotalSeconds -ge $script:SummaryMaxSeconds) { $acc.Truncated = $true; break }
        $entry = $directory.Next()
        if ($null -eq $entry) { break }
        Add-SummaryEntry -Accumulator $acc -Attributes $entry.Attributes -Tag $entry.ReparseTag -Size $entry.Size
      }
      # 18 = ERROR_NO_MORE_FILES。途中で失敗した集計は返さない。
      if (-not $acc.Truncated -and $directory.LastError -ne 18) {
        Write-SkillJson -Value (New-SummaryFailure -Code (ConvertTo-SummaryProbeReason -Win32Error $directory.LastError))
        return 1
      }
      # 祖先の差し替えも含め、列挙の後にもう一度確かめる。変わっていれば集計を返さない。
      $after = Get-SummaryHandleRefusal -Info $directory.Describe() -TargetPath $normalized -CloudScope $cloudScopeForHandle
      if ($null -eq $after) { $after = Get-SummaryScopeRefusal -TargetPath ([string]$target.path) -RootPath ([string]$target.rootPath) -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $probe }
      if ($null -ne $after) { Write-SkillJson -Value (New-SummaryFailure -Code $after); return 1 }
    } finally {
      $directory.Dispose()
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
