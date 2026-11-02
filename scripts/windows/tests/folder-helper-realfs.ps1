#Requires -Version 5.1
<#
.SYNOPSIS
  実 Windows の範囲検査の確認（docs/62 §10）。本人権限で実行し、合成フォルダだけを見る。
  名前は出力せず、結果コードと件数だけを JSON で出力する。

.PARAMETER TestRoot
  Documents 直下の合成フォルダ名。次を準備しておく:
  sub\ / deny\（本人に ACL なし） / many\（501 件以上） / link-junction / link-symlink / synthetic-a.txt（ADS 付き）
#>
param([string]$TestRoot = 'AIHD-Verify', [string]$OutFile)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\folder-helper.ps1') -NoMain
if (-not (Test-Path (Join-Path $PSScriptRoot '..\folder-helper.ps1'))) { throw 'folder-helper.ps1 がありません。' }

Initialize-NativeInterop
$identity = Get-CurrentIdentityInfo
$session = Get-SessionInfo
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add((@{
      kind = 'identity'
      sidMatchesProfile = (-not [string]::IsNullOrEmpty((Get-ProfileImagePathForSid -Sid $identity.Sid)))
      isSystem = [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
      isAdministrator = $identity.IsAdministrator
      sessionId = $session.SessionId
      sessionState = $session.SessionState
      refusal = (Get-StartupRefusal -Sid $identity.Sid -IsAdministrator $identity.IsAdministrator -LanguageMode ([string]$ExecutionContext.SessionState.LanguageMode))
    } | ConvertTo-Json -Compress))

$cases = @(
  @{ name = '選択フォルダ'; segments = @($TestRoot) },
  @{ name = '子フォルダ'; segments = @($TestRoot, 'sub') },
  @{ name = 'ACL 拒否'; segments = @($TestRoot, 'deny') },
  @{ name = '上限超過'; segments = @($TestRoot, 'many') },
  @{ name = 'ジャンクション'; segments = @($TestRoot, 'link-junction') },
  @{ name = 'シンボリックリンク'; segments = @($TestRoot, 'link-symlink') },
  @{ name = 'ファイル指定'; segments = @($TestRoot, 'synthetic-a.txt') },
  @{ name = 'ADS'; segments = @($TestRoot, 'synthetic-a.txt:hidden') },
  @{ name = '親へのトラバーサル'; segments = @($TestRoot, '..', '..') },
  @{ name = 'UNC'; segments = @('\\127.0.0.1\c$') },
  @{ name = 'デバイスパス'; segments = @('\\?\C:\Windows') },
  @{ name = '絶対パス'; segments = @('C:\Windows') },
  @{ name = 'ワイルドカード'; segments = @($TestRoot, '*') },
  @{ name = '予約デバイス名'; segments = @('CON') },
  @{ name = '末尾ドット'; segments = @("$TestRoot.") },
  @{ name = '存在しない'; segments = @($TestRoot, 'no-such-folder') }
)

foreach ($case in $cases) {
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $op = [pscustomobject]@{
    opId = 'op-realfs'; requestId = 'req-realfs'; sid = $identity.Sid; sessionId = $session.SessionId
    root = 'Documents'; segments = $case.segments; operation = 'list_metadata'
    expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')
    maxEntries = 500; maxBytes = 32768; maxSeconds = 15
  }
  $deps = @{
    Probe           = { param($path, $openReparse) Invoke-NativeProbe -Path $path -OpenReparsePoint ([bool]$openReparse) }
    OpenDirectory   = { param($path) New-NativeDirectoryHandle -Path $path }
    GetKnownFolder  = { param($root) Get-KnownFolderPath -Root $root }
    GetProfilePath  = { Get-ProfileImagePathForSid -Sid $identity.Sid }
    GetOneDrivePath = { Get-OneDriveUserFolders }
    ElapsedMs       = { $stopwatch.ElapsedMilliseconds }
    ShouldCancel    = { $false }
    IsExpired       = { $false }
  }
  $record = [ordered]@{ kind = 'case'; name = $case.name }
  $badSegment = -not (Test-PathSegments -Segments $case.segments)
  if ($badSegment) {
    $record.status = 'refused'; $record.reason = 'INVALID_SEGMENT'
  } else {
    try {
      $outcome = Invoke-ListOperation -Op $op -Deps $deps
      $record.status = $outcome.Status; $record.reason = $outcome.Reason
      $record.truncated = $outcome.Truncated; $record.count = @($outcome.Entries).Count
      $record.types = @(@($outcome.Entries) | ForEach-Object { $_.type } | Group-Object | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ','
      $record.linkChildren = @(@($outcome.Entries) | Where-Object { $_.type -eq 'link' }).Count
    } catch { $record.status = 'exception'; $record.reason = $_.Exception.GetType().Name }
  }
  $record.elapsedMs = $stopwatch.ElapsedMilliseconds
  $lines.Add(($record | ConvertTo-Json -Compress))
}

if ($OutFile) { [IO.File]::WriteAllLines($OutFile, $lines.ToArray(), (New-Object Text.UTF8Encoding($true))) } else { $lines }
