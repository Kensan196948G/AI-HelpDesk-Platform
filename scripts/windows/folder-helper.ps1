#Requires -Version 5.1
<#
.SYNOPSIS
  AI HelpDesk 本人同意付きフォルダ一覧ヘルパー（本人の標準権限 / 読み取り専用 / メタデータのみ）。

.DESCRIPTION
  docs/62-consented-folder-access.md の方式 B。ログオン時タスクから本人権限で起動し、
  HelpDesk へ外向きにポーリングする。本人が同意したフォルダの直下一覧とメタデータだけを返す。
  ファイル内容を読まず、ハッシュせず、再帰せず、リンクを辿らない。ACL 拒否は昇格で回避しない。

  注意: Windows API の挙動は実機未実測である。Linux の pwsh では純粋関数のみ検証している。
  実機検証の項目は docs/62 §9 のチェックリストを参照すること。

.PARAMETER ServerUrl
  HelpDesk のベース URL（https 必須）。省略時は状態フォルダの config.json を使う。
.PARAMETER AllowInsecureHttp
  検証用に http を許可する。明示したときだけ有効。
.PARAMETER Background
  タスクからの非対話起動。ペアリングコードは状態フォルダの pairing-code.txt に書く。
.PARAMETER RegisterOnly
  トークンの有無だけを確かめて終了する（無ければ終了コード 3）。登録は導入コードを持つ install-folder-helper.ps1 だけが行う。
.PARAMETER NoMain
  ドットソース時にメインループを実行しない（テスト・install / uninstall 用）。
#>
[CmdletBinding()]
param(
  [string]$ServerUrl,
  [switch]$AllowInsecureHttp,
  [switch]$Background,
  [switch]$RegisterOnly,
  [switch]$NoMain
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:HelperVersion = '0.2.0'
$script:HardMaxEntries = 500
$script:HardMaxBytes = 32768
$script:HardMaxSeconds = 15
$script:MaxSegments = 16
$script:MaxSegmentLength = 255
$script:PollBaseSeconds = 5
# サーバは heartbeat が 180 秒途絶えると同意を終了するので、それより短く保つ。
$script:PollMaxSeconds = 120
$script:CancelCheckMs = 5000
$script:MaxResponseBytes = 1048576
$script:MaxLogBytes = 262144
$script:AllowedRoots = @('Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos')
$script:RestrictedSids = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')
$script:ApiBasePath = '/api/device/agent/folder-helper'
$script:SkillRunCapability = 'skill_run/1'

# 16 進リテラルは PowerShell では符号付き Int32 になるので、上位ビットの立つ値は文字列から変換する。
$script:AttrHidden = [uint32]2
$script:AttrDirectory = [uint32]16
$script:AttrReparsePoint = [uint32]1024
$script:AttrOffline = [uint32]4096
$script:AttrRecallOnOpen = [uint32]262144
$script:AttrRecallOnDataAccess = [uint32]4194304
$script:TagNameSurrogateBit = [uint32]536870912
$script:TagCloudMask = [Convert]::ToUInt32('FFFF0FFF', 16)
$script:TagCloudBase = [Convert]::ToUInt32('9000001A', 16)

# ---------------------------------------------------------------------------
# JSON（JSON.stringify とバイト単位で一致させる）
# ---------------------------------------------------------------------------

function ConvertTo-JsonStringLiteral {
  # ConvertTo-Json は 5.1 と 7 で < > & ' と非 ASCII の扱いが違うため使わない。
  # JSON.stringify と同じく " \ と制御文字、対にならないサロゲートだけをエスケープする。
  param([AllowEmptyString()][string]$Value)
  $sb = New-Object System.Text.StringBuilder (($Value.Length + 2))
  [void]$sb.Append('"')
  for ($i = 0; $i -lt $Value.Length; $i++) {
    $code = [int]$Value[$i]
    if ($code -eq 0x22) { [void]$sb.Append('\"') }
    elseif ($code -eq 0x5C) { [void]$sb.Append('\\') }
    elseif ($code -eq 0x08) { [void]$sb.Append('\b') }
    elseif ($code -eq 0x09) { [void]$sb.Append('\t') }
    elseif ($code -eq 0x0A) { [void]$sb.Append('\n') }
    elseif ($code -eq 0x0C) { [void]$sb.Append('\f') }
    elseif ($code -eq 0x0D) { [void]$sb.Append('\r') }
    elseif ($code -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    elseif ($code -ge 0xD800 -and $code -le 0xDBFF) {
      if (($i + 1) -lt $Value.Length -and [char]::IsLowSurrogate($Value[$i + 1])) {
        [void]$sb.Append($Value[$i]); [void]$sb.Append($Value[$i + 1]); $i++
      } else {
        [void]$sb.Append(('\u{0:x4}' -f $code))
      }
    }
    elseif ($code -ge 0xDC00 -and $code -le 0xDFFF) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    else { [void]$sb.Append($Value[$i]) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ConvertTo-HelperJson {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [string]) { return (ConvertTo-JsonStringLiteral -Value $Value) }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [uint32] -or $Value -is [uint64]) {
    return ([Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture))
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Value.Keys) {
      $parts.Add((ConvertTo-JsonStringLiteral -Value ([string]$key)) + ':' + (ConvertTo-HelperJson -Value $Value[$key]))
    }
    return '{' + ($parts -join ',') + '}'
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Value) { $parts.Add((ConvertTo-HelperJson -Value $item)) }
    return '[' + ($parts -join ',') + ']'
  }
  throw 'JSON に変換できない型です。'
}

function ConvertFrom-HelperJson {
  # pwsh 7 の既定は ISO 形式の文字列を DateTime に変換するので、expiresAt が署名と一致しなくなる。
  # 5.1 は変換しない。どちらでも文字列のまま受け取る。
  param([Parameter(Mandatory)][string]$Json)
  if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    return (ConvertFrom-Json -InputObject $Json -DateKind String)
  }
  return (ConvertFrom-Json -InputObject $Json)
}

function Get-OpField {
  param([AllowNull()][object]$Op, [Parameter(Mandatory)][string]$Name)
  if ($null -eq $Op) { return $null }
  $prop = $Op.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return ,$prop.Value
}

function Get-CanonicalOpJson {
  # docs/62 §9.1。キー順固定、空白なし。sessionId は数値、expiresAt は受信した文字列のまま。
  # 型が契約と違えば例外にする（呼び出し側で BAD_OP として拒否する）。
  param([Parameter(Mandatory)][object]$Op)
  foreach ($name in 'opId', 'requestId', 'sid', 'root', 'operation', 'expiresAt') {
    $v = (Get-OpField -Op $Op -Name $name)
    if ($v -isnot [string]) { throw "署名対象の $name が文字列ではありません。" }
  }
  $sessionId = (Get-OpField -Op $Op -Name 'sessionId')
  if ($sessionId -isnot [int] -and $sessionId -isnot [long]) { throw '署名対象の sessionId が整数ではありません。' }
  $segments = (Get-OpField -Op $Op -Name 'segments')
  if ($segments -isnot [array]) { throw '署名対象の segments が配列ではありません。' }
  foreach ($s in $segments) { if ($s -isnot [string]) { throw '署名対象の segments に文字列以外があります。' } }
  $ordered = [ordered]@{
    opId      = $Op.opId
    requestId = $Op.requestId
    sid       = $Op.sid
    sessionId = $sessionId
    root      = $Op.root
    segments  = $segments
    operation = $Op.operation
    expiresAt = $Op.expiresAt
  }
  return (ConvertTo-HelperJson -Value $ordered)
}

function Get-HmacSha256Hex {
  # 鍵は helperToken 文字列の UTF-8 バイト。出力は小文字 16 進 64 文字。
  param([Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Message)
  $keyBytes = [Text.Encoding]::UTF8.GetBytes($Key)
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (, $keyBytes)
  try {
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Message))
  } finally {
    $hmac.Dispose()
  }
  $sb = New-Object System.Text.StringBuilder 64
  foreach ($b in $hash) { [void]$sb.Append($b.ToString('x2')) }
  return $sb.ToString()
}

function Test-FixedTimeEqual {
  param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
  if ($A.Length -ne $B.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $A.Length; $i++) { $diff = $diff -bor ([int]$A[$i] -bxor [int]$B[$i]) }
  return ($diff -eq 0)
}

function Test-OpSignature {
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][string]$Token)
  $sig = (Get-OpField -Op $Op -Name 'sig')
  if ($sig -isnot [string] -or $sig -cnotmatch '^[0-9a-f]{64}$') { return $false }
  $expected = Get-HmacSha256Hex -Key $Token -Message (Get-CanonicalOpJson -Op $Op)
  return (Test-FixedTimeEqual -A $expected -B $sig)
}

# ---------------------------------------------------------------------------
# 入力検証（docs/62 §6）
# ---------------------------------------------------------------------------

function Test-PathSegment {
  # 問題がなければ $true。1 つでも該当すれば $false。
  param([AllowNull()][object]$Segment)
  if ($Segment -isnot [string]) { return $false }
  if ($Segment.Length -eq 0 -or $Segment.Length -gt $script:MaxSegmentLength) { return $false }
  if ($Segment -ceq '.' -or $Segment -ceq '..') { return $false }
  for ($i = 0; $i -lt $Segment.Length; $i++) {
    $ch = $Segment[$i]
    $code = [int]$ch
    if ($code -lt 0x20 -or ($code -ge 0x7F -and $code -le 0x9F)) { return $false }
    if (':\/*?"<>|'.IndexOf($ch) -ge 0) { return $false }
    if ([char]::IsHighSurrogate($ch)) {
      if (($i + 1) -ge $Segment.Length -or -not [char]::IsLowSurrogate($Segment[$i + 1])) { return $false }
      $i++
    } elseif ([char]::IsLowSurrogate($ch)) { return $false }
  }
  $last = $Segment[$Segment.Length - 1]
  if ($last -ceq '.' -or $last -ceq ' ') { return $false }
  # 予約デバイス名は拡張子付きでも解決される（NUL.txt など）。
  $stem = $Segment.Split('.')[0].TrimEnd(' ').ToUpperInvariant()
  if ($stem -cmatch '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])$') { return $false }
  return $true
}

function Test-PathSegments {
  param([AllowNull()][object]$Segments)
  if ($Segments -isnot [array]) { return $false }
  if ($Segments.Count -gt $script:MaxSegments) { return $false }
  foreach ($s in $Segments) { if (-not (Test-PathSegment -Segment $s)) { return $false } }
  return $true
}

function Test-AllowedRoot {
  # hashtable や -contains は大文字小文字を無視するので -ceq で完全一致にする。
  param([AllowNull()][object]$Root)
  if ($Root -isnot [string]) { return $false }
  foreach ($allowed in $script:AllowedRoots) { if ($Root -ceq $allowed) { return $true } }
  return $false
}

function ConvertTo-NormalizedPath {
  # \\?\ を外し、ローカルドライブの絶対パスだけを返す。UNC や相対要素は $null（範囲外）。
  # [IO.Path] は実行 OS に依存するので使わない。
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

function Test-PathWithin {
  # 区切り込みの OrdinalIgnoreCase 比較。C:\Users\ab は C:\Users\a の配下ではない。
  param([AllowNull()][string]$Candidate, [AllowNull()][string]$Root)
  $c = ConvertTo-NormalizedPath -Path $Candidate
  $r = ConvertTo-NormalizedPath -Path $Root
  if ($null -eq $c -or $null -eq $r) { return $false }
  if ([string]::Equals($c, $r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = if ($r.EndsWith('\', [StringComparison]::Ordinal)) { $r } else { $r + '\' }
  return $c.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsDriveRoot {
  param([AllowNull()][string]$Path)
  $p = ConvertTo-NormalizedPath -Path $Path
  return ($null -ne $p -and $p.Length -eq 3)
}

function Get-PathChain {
  # C:\a\b -> C:\ , C:\a , C:\a\b
  param([Parameter(Mandatory)][string]$Path)
  $p = ConvertTo-NormalizedPath -Path $Path
  if ($null -eq $p) { throw '正規化できないパスです。' }
  $chain = New-Object System.Collections.Generic.List[string]
  $current = $p.Substring(0, 3)
  $chain.Add($current)
  $tail = $p.Substring(3)
  if ($tail.Length -gt 0) {
    foreach ($part in $tail.Split('\')) {
      $current = if ($current.EndsWith('\', [StringComparison]::Ordinal)) { $current + $part } else { $current + '\' + $part }
      $chain.Add($current)
    }
  }
  return ,$chain.ToArray()
}

function Join-TargetPath {
  param([Parameter(Mandatory)][string]$Base, [AllowEmptyCollection()][object[]]$Segments)
  $p = $Base.TrimEnd('\')
  foreach ($s in $Segments) { $p = $p + '\' + $s }
  return $p
}

function ConvertTo-ExtendedPath {
  # セグメント検証後のパスだけを渡す。\\?\ で Win32 の名前正規化を止める。
  param([Parameter(Mandatory)][string]$Path)
  return '\\?\' + $Path
}

function Test-IsCloudTag {
  param([uint32]$Tag)
  return (($Tag -band $script:TagCloudMask) -eq $script:TagCloudBase)
}

function Test-IsNameSurrogateTag {
  param([uint32]$Tag)
  return (($Tag -band $script:TagNameSurrogateBit) -ne 0)
}

function Test-ReparseAllowed {
  # 祖先の reparse point は拒否する。例外は OneDrive UserFolder 配下のクラウドタグのみ
  # （名前サロゲートではなく、別の場所へ解決しない）。実機未実測の前提。docs/62 §9.4。
  param(
    [Parameter(Mandatory)][string]$Path,
    [uint32]$Attributes,
    [uint32]$Tag,
    [AllowNull()][AllowEmptyCollection()][string[]]$CloudScope
  )
  if (($Attributes -band $script:AttrReparsePoint) -eq 0) { return $true }
  if (Test-IsNameSurrogateTag -Tag $Tag) { return $false }
  if (-not (Test-IsCloudTag -Tag $Tag)) { return $false }
  foreach ($scope in @($CloudScope)) {
    if ([string]::IsNullOrEmpty($scope)) { continue }
    if (Test-PathWithin -Candidate $Path -Root $scope) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------------------
# 一覧の整形と上限
# ---------------------------------------------------------------------------

function ConvertTo-SafeEntryName {
  # 制御文字・不正 Unicode・表示を偽装できる書式文字を除去する。全部消えたら固定の表記を返す。
  param([AllowEmptyString()][string]$Name)
  $sb = New-Object System.Text.StringBuilder ($Name.Length)
  for ($i = 0; $i -lt $Name.Length; $i++) {
    $ch = $Name[$i]
    $code = [int]$ch
    if ($code -lt 0x20 -or ($code -ge 0x7F -and $code -le 0x9F)) { continue }
    if ($code -eq 0x200E -or $code -eq 0x200F) { continue }
    if ($code -ge 0x202A -and $code -le 0x202E) { continue }
    if ($code -ge 0x2066 -and $code -le 0x2069) { continue }
    if ($code -eq 0xFEFF -or $code -eq 0xFFFE -or $code -eq 0xFFFF) { continue }
    if ([char]::IsHighSurrogate($ch)) {
      if (($i + 1) -lt $Name.Length -and [char]::IsLowSurrogate($Name[$i + 1])) {
        [void]$sb.Append($ch); [void]$sb.Append($Name[$i + 1]); $i++
      }
      continue
    }
    if ([char]::IsLowSurrogate($ch)) { continue }
    [void]$sb.Append($ch)
  }
  if ($sb.Length -eq 0) { return '[unprintable]' }
  return $sb.ToString()
}

function Get-EntryType {
  # dwReserved0 のタグは REPARSE_POINT 属性があるときだけ有効。
  param([uint32]$Attributes, [uint32]$Tag)
  if (($Attributes -band $script:AttrReparsePoint) -ne 0 -and (Test-IsNameSurrogateTag -Tag $Tag)) { return 'link' }
  if (($Attributes -band $script:AttrDirectory) -ne 0) { return 'directory' }
  return 'file'
}

function Get-EntryAttrs {
  param([uint32]$Attributes)
  $attrs = [ordered]@{}
  if (($Attributes -band $script:AttrReparsePoint) -ne 0) { $attrs['reparse'] = $true }
  $cloudMask = $script:AttrOffline -bor $script:AttrRecallOnOpen -bor $script:AttrRecallOnDataAccess
  if (($Attributes -band $cloudMask) -ne 0) { $attrs['cloudOnly'] = $true }
  if (($Attributes -band $script:AttrHidden) -ne 0) { $attrs['hidden'] = $true }
  return $attrs
}

function ConvertFrom-RawFileTime {
  param([long]$FileTime)
  if ($FileTime -le 0 -or $FileTime -gt [DateTime]::MaxValue.ToFileTimeUtc()) { return $null }
  return [DateTime]::FromFileTimeUtc($FileTime).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-ListEntry {
  param([Parameter(Mandatory)][object]$Raw)
  $type = Get-EntryType -Attributes $Raw.Attributes -Tag $Raw.ReparseTag
  $size = $null
  if ($type -ceq 'file') { $size = [long]$Raw.Size }
  return [ordered]@{
    name       = (ConvertTo-SafeEntryName -Name $Raw.Name)
    type       = $type
    size       = $size
    modifiedAt = (ConvertFrom-RawFileTime -FileTime $Raw.LastWriteFileTime)
    attrs      = (Get-EntryAttrs -Attributes $Raw.Attributes)
  }
}

function Resolve-ListLimits {
  # maxEntries / maxBytes / maxSeconds は署名の対象外なので、固定の上限を超えさせない。
  param([AllowNull()][object]$Op)
  $pick = {
    param($value, $hard)
    if (($value -is [int] -or $value -is [long]) -and $value -gt 0 -and $value -lt $hard) { return [int]$value }
    return [int]$hard
  }
  return @{
    MaxEntries = (& $pick (Get-OpField -Op $Op -Name 'maxEntries') $script:HardMaxEntries)
    MaxBytes   = (& $pick (Get-OpField -Op $Op -Name 'maxBytes') $script:HardMaxBytes)
    MaxSeconds = (& $pick (Get-OpField -Op $Op -Name 'maxSeconds') $script:HardMaxSeconds)
  }
}

function New-ListAccumulator {
  param([int]$MaxEntries, [int]$MaxBytes)
  return @{
    MaxEntries = $MaxEntries
    MaxBytes   = $MaxBytes
    Entries    = (New-Object System.Collections.Generic.List[object])
    Bytes      = 2   # entries 配列の [ ] の分。サーバの normalizeEntries と同じ数え方
    Truncated  = $false
  }
}

function Add-ListEntry {
  # 上限内なら追加して $true。超えるなら追加せず truncated を立てて $false。
  # バイト数は entries 配列を直列化したときの UTF-8 バイト数（区切り 1 バイトを各要素に計上）で数える。
  param([Parameter(Mandatory)][hashtable]$Accumulator, [Parameter(Mandatory)][object]$Entry)
  if ($Accumulator.Entries.Count -ge $Accumulator.MaxEntries) { $Accumulator.Truncated = $true; return $false }
  $json = ConvertTo-HelperJson -Value $Entry
  $added = [Text.Encoding]::UTF8.GetByteCount($json) + 1
  if (($Accumulator.Bytes + $added) -gt $Accumulator.MaxBytes) { $Accumulator.Truncated = $true; return $false }
  $Accumulator.Entries.Add($Entry)
  $Accumulator.Bytes += $added
  return $true
}

function Read-DirectoryEntries {
  # 子を開かない。.Next() は保持したハンドルのバッファから 1 件返す。時間は件の間でしか判定できない。
  param(
    [Parameter(Mandatory)][object]$Lister,
    [Parameter(Mandatory)][hashtable]$Limits,
    [Parameter(Mandatory)][scriptblock]$ElapsedMs,
    [Parameter(Mandatory)][scriptblock]$ShouldCancel,
    [int]$CancelCheckMs = 5000
  )
  $acc = New-ListAccumulator -MaxEntries $Limits.MaxEntries -MaxBytes $Limits.MaxBytes
  $maxMs = [long]$Limits.MaxSeconds * 1000
  $nextCheck = [long]$CancelCheckMs
  $cancelled = $false
  while ($true) {
    $raw = $Lister.Next()
    if ($null -eq $raw) { break }
    if ($raw.Name -ceq '.' -or $raw.Name -ceq '..') { continue }
    $elapsed = [long](& $ElapsedMs)
    if ($elapsed -ge $maxMs) { $acc.Truncated = $true; break }
    if ($elapsed -ge $nextCheck) {
      if (& $ShouldCancel) { $cancelled = $true; break }
      $nextCheck = $elapsed + $CancelCheckMs
    }
    if (-not (Add-ListEntry -Accumulator $acc -Entry (ConvertTo-ListEntry -Raw $raw))) { break }
  }
  return @{ Accumulator = $acc; Cancelled = $cancelled; LastError = [int]$Lister.LastError }
}

# ---------------------------------------------------------------------------
# 操作の検証と実行（OS 依存部は $Deps の scriptblock で差し替え可能）
# ---------------------------------------------------------------------------

function Test-SafeOpId {
  param([AllowNull()][object]$OpId)
  return ($OpId -is [string] -and $OpId -cmatch '^[A-Za-z0-9_-]{1,128}$')
}

function ConvertFrom-IsoUtc {
  # expiresAt を DateTimeOffset にする。形式が違えば $null。
  param([AllowNull()][object]$Value)
  if ($Value -isnot [string]) { return $null }
  if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$') { return $null }
  $parsed = [DateTimeOffset]::MinValue
  $ok = [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)
  if (-not $ok) { return $null }
  return $parsed
}

function Get-OpRefusal {
  # 実行前の検証。問題なければ $null、拒否なら理由コードを返す。
  # $Context: Sid, SessionId, SessionState, NowUtc(DateTimeOffset), IsElevated
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Context
  )
  try {
    if (-not (Test-OpSignature -Op $Op -Token $Token)) { return 'BAD_SIGNATURE' }
  } catch {
    return 'BAD_OP'
  }
  if ($Op.operation -cne 'list_metadata') { return 'BAD_OP' }
  if ($Context.IsElevated) { return 'ELEVATED' }
  if ($Op.sid -cne $Context.Sid) { return 'SID_MISMATCH' }
  if ([long]$Op.sessionId -ne [long]$Context.SessionId) { return 'SESSION_MISMATCH' }
  if ($Context.SessionState -cne 'active') { return 'SESSION_NOT_ACTIVE' }
  $expires = ConvertFrom-IsoUtc -Value $Op.expiresAt
  if ($null -eq $expires) { return 'BAD_OP' }
  if ($expires -le $Context.NowUtc) { return 'EXPIRED' }
  if (-not (Test-AllowedRoot -Root $Op.root)) { return 'INVALID_ROOT' }
  if (-not (Test-PathSegments -Segments $Op.segments)) { return 'INVALID_SEGMENT' }
  return $null
}

function ConvertTo-ProbeReason {
  param([int]$Win32Error)
  if ($Win32Error -eq 5) { return 'ACCESS_DENIED' }
  if ($Win32Error -eq 2 -or $Win32Error -eq 3) { return 'NOT_FOUND' }
  return 'IO_ERROR'
}

function Get-CloudScopes {
  # OneDrive の UserFolder の候補（複数アカウント）のうち、範囲として認めるものの最終パスを返す。
  # HKCU は本人が書き換えられるので、本人のプロファイル配下か、起点（既知フォルダ）の最終パスを
  # 含む場合に限る。プロファイル自身・その祖先・ドライブ直下は認めない。
  param(
    [AllowNull()][AllowEmptyCollection()][string[]]$Candidates,
    [Parameter(Mandatory)][string]$ProfileFinal,
    [AllowNull()][string]$RootFinal,
    [Parameter(Mandatory)][scriptblock]$Probe
  )
  $scopes = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @($Candidates)) {
    $norm = ConvertTo-NormalizedPath -Path $candidate
    if ($null -eq $norm -or (Test-IsDriveRoot -Path $norm)) { continue }
    # PowerShell の変数名は大文字小文字を区別しない。$Probe を上書きしない。
    $info = & $Probe (ConvertTo-ExtendedPath -Path $norm) $false
    if ($info.Error -ne 0) { continue }
    $final = ConvertTo-NormalizedPath -Path $info.FinalPath
    if ($null -eq $final -or (Test-IsDriveRoot -Path $final)) { continue }
    if (Test-PathWithin -Candidate $ProfileFinal -Root $final) { continue }
    $underProfile = Test-PathWithin -Candidate $final -Root $ProfileFinal
    $holdsRoot = (-not [string]::IsNullOrEmpty($RootFinal)) -and (Test-PathWithin -Candidate $RootFinal -Root $final)
    if (-not $underProfile -and -not $holdsRoot) { continue }
    $known = $false
    foreach ($existing in $scopes) { if ([string]::Equals($existing, $final, [StringComparison]::OrdinalIgnoreCase)) { $known = $true } }
    if (-not $known) { $scopes.Add($final) }
  }
  return $scopes.ToArray()
}

function Resolve-FolderTarget {
  # 起点とセグメントから対象を決める。文字列の前方一致だけで判定しない:
  #  1. ボリューム直下から対象まで全要素を「リンクを開く」モードで開き、reparse を確認する
  #  2. 起点・プロファイル・OneDrive を同じ手順で最終パスにし、最終パス同士で範囲を判定する
  # $Probe: { param($extendedPath, [bool]$openReparsePoint) } -> Error, Attributes, ReparseTag, FinalPath
  param(
    [AllowNull()][string]$BasePath,
    [AllowEmptyCollection()][object[]]$Segments,
    [AllowNull()][string]$ProfilePath,
    [AllowNull()][AllowEmptyCollection()][string[]]$OneDrivePath,
    [Parameter(Mandatory)][scriptblock]$Probe
  )
  $fail = { param($reason) return @{ Reason = $reason; TargetFinal = $null; RootFinal = $null } }

  $base = ConvertTo-NormalizedPath -Path $BasePath
  $profileNorm = ConvertTo-NormalizedPath -Path $ProfilePath
  if ($null -eq $base -or $null -eq $profileNorm) { return (& $fail 'OUT_OF_SCOPE') }
  if ((Test-IsDriveRoot -Path $base) -or (Test-IsDriveRoot -Path $profileNorm)) { return (& $fail 'OUT_OF_SCOPE') }

  $profileProbe = & $Probe (ConvertTo-ExtendedPath -Path $profileNorm) $false
  if ($profileProbe.Error -ne 0) { return (& $fail 'OUT_OF_SCOPE') }
  $profileFinal = ConvertTo-NormalizedPath -Path $profileProbe.FinalPath
  if ($null -eq $profileFinal) { return (& $fail 'OUT_OF_SCOPE') }

  # 起点の最終パスは範囲の判定にだけ先に使う。起点のエラーは後段の順序のまま報告する。
  $rootForScope = & $Probe (ConvertTo-ExtendedPath -Path $base) $false
  $rootFinalForScope = if ($rootForScope.Error -eq 0) { ConvertTo-NormalizedPath -Path $rootForScope.FinalPath } else { $null }
  $cloudScope = @(Get-CloudScopes -Candidates $OneDrivePath -ProfileFinal $profileFinal -RootFinal $rootFinalForScope -Probe $Probe)
  $scopes = New-Object System.Collections.Generic.List[string]
  $scopes.Add($profileFinal)
  foreach ($scope in $cloudScope) { $scopes.Add($scope) }

  $target = Join-TargetPath -Base $base -Segments $Segments
  foreach ($element in (Get-PathChain -Path $target)) {
    $info = & $Probe (ConvertTo-ExtendedPath -Path $element) $true
    if ($info.Error -ne 0) { return (& $fail (ConvertTo-ProbeReason -Win32Error $info.Error)) }
    if (-not (Test-ReparseAllowed -Path $element -Attributes $info.Attributes -Tag $info.ReparseTag -CloudScope $cloudScope)) {
      return (& $fail 'REPARSE_REJECTED')
    }
  }

  $rootProbe = & $Probe (ConvertTo-ExtendedPath -Path $base) $false
  if ($rootProbe.Error -ne 0) { return (& $fail (ConvertTo-ProbeReason -Win32Error $rootProbe.Error)) }
  $rootFinal = ConvertTo-NormalizedPath -Path $rootProbe.FinalPath
  if ($null -eq $rootFinal) { return (& $fail 'OUT_OF_SCOPE') }
  $inScope = $false
  foreach ($scope in $scopes) { if (Test-PathWithin -Candidate $rootFinal -Root $scope) { $inScope = $true } }
  if (-not $inScope) { return (& $fail 'OUT_OF_SCOPE') }

  $targetProbe = & $Probe (ConvertTo-ExtendedPath -Path $target) $false
  if ($targetProbe.Error -ne 0) { return (& $fail (ConvertTo-ProbeReason -Win32Error $targetProbe.Error)) }
  $targetFinal = ConvertTo-NormalizedPath -Path $targetProbe.FinalPath
  if ($null -eq $targetFinal) { return (& $fail 'OUT_OF_SCOPE') }
  if (-not (Test-PathWithin -Candidate $targetFinal -Root $rootFinal)) { return (& $fail 'OUT_OF_SCOPE') }
  if (($targetProbe.Attributes -band $script:AttrDirectory) -eq 0) { return (& $fail 'NOT_A_DIRECTORY') }

  return @{ Reason = $null; TargetFinal = $targetFinal; RootFinal = $rootFinal; CloudScope = $cloudScope }
}

function Get-DirectoryHandleRefusal {
  # 保持したハンドルが検査した対象そのものか。パスではなくハンドルの実体で判定する。
  # $Info: Error, Attributes, ReparseTag, FinalPath（DirectoryHandle.Describe の結果）
  param([Parameter(Mandatory)][object]$Info, [AllowNull()][string]$TargetPath, [AllowNull()][AllowEmptyCollection()][string[]]$CloudScope)
  if ($Info.Error -ne 0) { return (ConvertTo-ProbeReason -Win32Error $Info.Error) }
  $target = ConvertTo-NormalizedPath -Path $TargetPath
  $final = ConvertTo-NormalizedPath -Path $Info.FinalPath
  if ($null -eq $target -or $null -eq $final) { return 'OUT_OF_SCOPE' }
  if (-not (Test-ReparseAllowed -Path $target -Attributes $Info.Attributes -Tag $Info.ReparseTag -CloudScope $CloudScope)) { return 'REPARSE_REJECTED' }
  if (($Info.Attributes -band $script:AttrDirectory) -eq 0) { return 'NOT_A_DIRECTORY' }
  if (-not [string]::Equals($final, $target, [StringComparison]::OrdinalIgnoreCase)) { return 'PATH_CHANGED' }
  return $null
}

function Invoke-ListOperation {
  # 検証済みの op を実行する。$Deps: Probe, OpenDirectory, GetKnownFolder, GetProfilePath, GetOneDrivePath,
  # ElapsedMs, ShouldCancel, IsExpired。結果には名前が入るので、呼び出し側でログに出さないこと。
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][hashtable]$Deps)
  $finish = {
    param($status, $reason, $truncated, $entries, $discard)
    return @{ Status = $status; Reason = $reason; Truncated = [bool]$truncated; Entries = $entries; Discard = [bool]$discard; ElapsedMs = [long](& $Deps.ElapsedMs) }
  }
  $noEntries = @()
  $basePath = & $Deps.GetKnownFolder $Op.root
  $profilePath = & $Deps.GetProfilePath
  $oneDrivePath = @(& $Deps.GetOneDrivePath)
  if ([string]::IsNullOrEmpty($basePath)) { return (& $finish 'error' 'OUT_OF_SCOPE' $false $noEntries $false) }

  $segments = @($Op.segments)
  $before = Resolve-FolderTarget -BasePath $basePath -Segments $segments -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $Deps.Probe
  if ($null -ne $before.Reason) { return (& $finish 'error' $before.Reason $false $noEntries $false) }

  $limits = Resolve-ListLimits -Op $Op
  # 検査の後でパスを開き直さない。検査した対象をハンドルで保持し、同じハンドルを列挙する。
  $directory = & $Deps.OpenDirectory (ConvertTo-ExtendedPath -Path $before.TargetFinal)
  try {
    if ($directory.LastError -ne 0) {
      return (& $finish 'error' (ConvertTo-ProbeReason -Win32Error $directory.LastError) $false $noEntries $false)
    }
    $handleBefore = Get-DirectoryHandleRefusal -Info $directory.Describe() -TargetPath $before.TargetFinal -CloudScope $before.CloudScope
    if ($null -ne $handleBefore) { return (& $finish 'error' $handleBefore $false $noEntries $false) }
    $read = Read-DirectoryEntries -Lister $directory -Limits $limits -ElapsedMs $Deps.ElapsedMs -ShouldCancel $Deps.ShouldCancel -CancelCheckMs $script:CancelCheckMs
    # 差し替えて列挙して戻された場合も検知できるよう、閉じる前にハンドルの実体を確かめ直す。
    $handleAfter = Get-DirectoryHandleRefusal -Info $directory.Describe() -TargetPath $before.TargetFinal -CloudScope $before.CloudScope
  } finally {
    $directory.Dispose()
  }
  if ($read.Cancelled) { return (& $finish 'error' 'CANCELLED' $false $noEntries $true) }
  # 18 = ERROR_NO_MORE_FILES。途中で失敗した一覧は部分結果として返さない。
  if ($read.LastError -ne 0 -and $read.LastError -ne 18) {
    return (& $finish 'error' (ConvertTo-ProbeReason -Win32Error $read.LastError) $false $noEntries $false)
  }

  # 列挙の間に祖先が差し替えられていないか再確認する。
  $after = Resolve-FolderTarget -BasePath $basePath -Segments $segments -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $Deps.Probe
  if ($null -ne $handleAfter -or $null -ne $after.Reason -or -not [string]::Equals($after.TargetFinal, $before.TargetFinal, [StringComparison]::OrdinalIgnoreCase)) {
    return (& $finish 'error' 'PATH_CHANGED' $false $noEntries $false)
  }
  if (& $Deps.IsExpired) { return (& $finish 'error' 'EXPIRED' $false $noEntries $false) }
  return (& $finish 'ok' $null $read.Accumulator.Truncated $read.Accumulator.Entries.ToArray() $false)
}

function New-ResultBody {
  # §5 の結果ボディ。actorSid は op の値ではなく現在の識別子を入れる。
  param(
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [AllowEmptyString()][string]$Root,
    [Parameter(Mandatory)][string]$Status,
    [AllowNull()][string]$Reason,
    [bool]$Truncated,
    [long]$ElapsedMs,
    [AllowEmptyCollection()][object[]]$Entries
  )
  $body = [ordered]@{ actorSid = $ActorSid; sessionId = $SessionId; root = $Root; status = $Status }
  if (-not [string]::IsNullOrEmpty($Reason)) { $body['reason'] = $Reason }
  $body['truncated'] = $Truncated
  $body['elapsedMs'] = $ElapsedMs
  $body['entries'] = @($Entries)
  return $body
}

function New-PollState {
  return @{
    Queue     = (New-Object System.Collections.Generic.Queue[object])
    Cancelled = (New-Object 'System.Collections.Generic.HashSet[string]')
    Seen      = (New-Object 'System.Collections.Generic.HashSet[string]')
    Revoked   = $false
    OpSeen    = $false
  }
}

function Update-PollState {
  # poll 応答を状態へ反映する。同じ opId は 2 回実行しない。
  param([Parameter(Mandatory)][hashtable]$State, [AllowNull()][object]$Response)
  if ($null -eq $Response) { return }
  $revoked = Get-OpField -Op $Response -Name 'revoked'
  if ($revoked -is [bool] -and $revoked) { $State.Revoked = $true }
  $cancel = Get-OpField -Op $Response -Name 'cancel'
  if ($cancel -is [array]) {
    foreach ($id in $cancel) { if ($id -is [string]) { [void]$State.Cancelled.Add($id) } }
  }
  # skillOps（skill_run）も同じキューへ入れる。種別の判定と署名の検証は Invoke-HelperOperation が行う。
  foreach ($field in 'ops', 'skillOps') {
    $ops = Get-OpField -Op $Response -Name $field
    if ($ops -isnot [array]) { continue }
    foreach ($op in $ops) {
      $id = Get-OpField -Op $op -Name 'opId'
      if (-not (Test-SafeOpId -OpId $id)) { continue }
      if ($State.Seen.Add($id)) { $State.Queue.Enqueue($op); $State.OpSeen = $true }
    }
  }
}

function Test-EnrollCodeRejected {
  # POST /register の 403 ENROLL_CODE_INVALID。再試行しない。
  param([int]$Status, [AllowNull()][string]$Body)
  if ($Status -ne 403 -or [string]::IsNullOrEmpty($Body)) { return $false }
  return $Body.Contains('ENROLL_CODE_INVALID')
}

function Test-StartResponse {
  # POST /ops/:id/start の応答。200 かつ started:true だけを開始の根拠にする。
  param([int]$Status, [AllowNull()][string]$Body)
  if ($Status -ne 200 -or [string]::IsNullOrEmpty($Body)) { return $false }
  try { $parsed = ConvertFrom-HelperJson -Json $Body } catch { return $false }
  $started = Get-OpField -Op $parsed -Name 'started'
  return ($started -is [bool] -and $started)
}

function New-PollBodyJson {
  # capabilities を送らないヘルパーにサーバは skillOps を配らない。
  param([Parameter(Mandatory)][string]$Sid, [Parameter(Mandatory)][int]$SessionId, [Parameter(Mandatory)][string]$SessionState)
  return (ConvertTo-HelperJson -Value ([ordered]@{ sid = $Sid; sessionId = $SessionId; sessionState = $SessionState; capabilities = [object[]]@($script:SkillRunCapability) }))
}

function Get-NextPollDelay {
  # 成功で基準間隔へ戻し、失敗ごとに倍にする。Retry-After があれば尊重する。
  param([int]$Failures, [int]$RetryAfterSeconds = 0, [int]$BaseSeconds = 5, [int]$MaxSeconds = 120)
  if ($Failures -le 0) { $delay = $BaseSeconds }
  else {
    $exp = [Math]::Min($Failures, 10)
    $delay = [Math]::Min($MaxSeconds, $BaseSeconds * [Math]::Pow(2, $exp))
  }
  if ($RetryAfterSeconds -gt $delay) { $delay = [Math]::Min($MaxSeconds, $RetryAfterSeconds) }
  return [int]$delay
}

# ---------------------------------------------------------------------------
# 起動条件・URL・命名
# ---------------------------------------------------------------------------

function Get-StartupRefusal {
  param([AllowNull()][string]$Sid, [bool]$IsAdministrator, [AllowNull()][string]$LanguageMode)
  if ($LanguageMode -cne 'FullLanguage') { return 'NOT_FULL_LANGUAGE' }
  if ([string]::IsNullOrEmpty($Sid)) { return 'NO_IDENTITY' }
  foreach ($restricted in $script:RestrictedSids) { if ($Sid -ceq $restricted) { return 'SERVICE_ACCOUNT' } }
  if ($IsAdministrator) { return 'ELEVATED' }
  return $null
}

function Test-ServerUrl {
  # https 必須。http は明示したときだけ。認証情報・クエリ・フラグメント・パス付きは受けない。
  param([AllowNull()][string]$Url, [bool]$AllowInsecure)
  if ([string]::IsNullOrEmpty($Url)) { return $false }
  if ($Url -match '[\s"''`]') { return $false }
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $false }
  if ($uri.Scheme -cne 'https' -and -not ($AllowInsecure -and $uri.Scheme -ceq 'http')) { return $false }
  if ([string]::IsNullOrEmpty($uri.Host)) { return $false }
  if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { return $false }
  if ($uri.Query.Length -gt 0 -or $uri.Fragment.Length -gt 0) { return $false }
  if ($uri.AbsolutePath -cne '/') { return $false }
  return $true
}

function Get-HelperApiUrl {
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][string]$Action)
  return $ServerBase.TrimEnd('/') + $script:ApiBasePath + '/' + $Action
}

function Get-HelperTaskName {
  param([Parameter(Mandatory)][string]$Sid)
  if ($Sid -cnotmatch '^S-1-\d+(-\d+)+$') { throw 'SID の形式が不正です。' }
  $parts = $Sid.Split('-')
  return 'AIHelpDesk-FolderHelper-' + $parts[$parts.Length - 1]
}

function Test-SessionStateReportable {
  # サーバは active / disconnected 以外をログオフとして同意を終了させる。API の失敗や遷移中の値は
  # ログオフの根拠にならないので、heartbeat として送らない。
  param([AllowNull()][string]$State)
  return ($State -ceq 'active' -or $State -ceq 'disconnected')
}

function ConvertTo-SessionStateName {
  # WTS_CONNECTSTATE_CLASS
  param([int]$State)
  $names = @('active', 'connected', 'connectquery', 'shadow', 'disconnected', 'idle', 'listen', 'reset', 'down', 'init')
  if ($State -ge 0 -and $State -lt $names.Length) { return $names[$State] }
  return 'unknown'
}

# ---------------------------------------------------------------------------
# ログ（ファイル名・パス・トークン・コードを書かない）
# ---------------------------------------------------------------------------

function Format-HelperLogLine {
  # 許可したキーと、パスを含み得ない形の値だけを通す。
  param([Parameter(Mandatory)][string]$EventName, [hashtable]$Fields = @{})
  $allowed = @('opId', 'status', 'reason', 'count', 'truncated', 'elapsedMs', 'httpStatus', 'errorType', 'delay')
  $parts = New-Object System.Collections.Generic.List[string]
  $parts.Add('event=' + $EventName)
  foreach ($key in $allowed) {
    if (-not $Fields.ContainsKey($key)) { continue }
    $value = [string]$Fields[$key]
    if ($value -cnotmatch '^[A-Za-z0-9_.-]{0,64}$') { $value = '[redacted]' }
    $parts.Add($key + '=' + $value)
  }
  return ($parts -join ' ')
}

# ---------------------------------------------------------------------------
# skill_run（docs/63 §5-7, §10-11、apps/api/src/support-session/contract.ts）。
# Windows API の挙動は未実測。Linux では純粋関数と配線のみ検証している。
# ---------------------------------------------------------------------------

$script:SkillRunCanon = 'skill_run/1'
$script:SkillHardMaxSeconds = 120
$script:SkillPollEveryMs = 5000
$script:SkillCommLossMs = 30000
$script:SkillMaxStdoutBytes = 16384
$script:SkillMaxStderrBytes = 4096
$script:SkillKillExitCode = [uint32]1067
$script:SkillStopWaitMs = 5000
$script:SafeIntegerMax = [long]9007199254740991
$script:IntegrityHighRid = 0x3000

# 実行できる Skill はこの表だけ。op の値でスキーマを決めない。effect もここで決める（op に無い）。
# diag.sleep は検証専用。サーバのカタログに無く、install-assist-skills.ps1 の -IncludeVerification でしか配置しない。
$script:MarkerValues = @('VERIFY_A', 'VERIFY_B')
$script:SkillCatalog = @(
  @{ Id = 'folder.summary'; File = 'folder-summary.ps1'; Effect = 'read'; NeedsTarget = $true; Params = @(
      @{ Name = 'target'; Type = 'enum'; Values = @('T1'); Required = $true }
    )
  },
  @{ Id = 'disk.space'; File = 'disk-space.ps1'; Effect = 'read'; NeedsTarget = $false; Params = @() },
  @{ Id = 'user.marker.set'; File = 'user-marker-set.ps1'; Effect = 'modify'; NeedsTarget = $false; Params = @(
      @{ Name = 'value'; Type = 'enum'; Values = $script:MarkerValues; Required = $true }
    )
  },
  @{ Id = 'user.marker.clear'; File = 'user-marker-clear.ps1'; Effect = 'modify'; NeedsTarget = $false; Params = @() },
  @{ Id = 'user.marker.status'; File = 'user-marker-status.ps1'; Effect = 'read'; NeedsTarget = $false; Params = @() },
  @{ Id = 'diag.sleep'; File = 'diag-sleep.ps1'; Effect = 'read'; NeedsTarget = $false; Params = @(
      @{ Name = 'seconds'; Type = 'int'; Min = 1; Max = 300; Required = $true },
      @{ Name = 'children'; Type = 'int'; Min = 0; Max = 3; Required = $true }
    )
  }
)

# 実行後の失敗でサーバが受ける resultCode（contract.ts の HELPER_FAILURE_CODES と HELPER_REJECT_CODES）。
# それ以外を送ると改ざん（RESULT_MISMATCH）として扱われる。
$script:SkillReportableCodes = @(
  'INTERRUPTED', 'TIMEOUT', 'CANCELLED', 'EXEC_FAILED', 'OUTPUT_INVALID', 'OUTPUT_TOO_LARGE', 'ACCESS_DENIED', 'NOT_FOUND', 'INTERNAL_ERROR',
  'BAD_OP', 'BAD_SIGNATURE', 'ELEVATED', 'SID_MISMATCH', 'SESSION_MISMATCH', 'SESSION_NOT_ACTIVE', 'DEVICE_MISMATCH', 'EXPIRED',
  'SKILL_NOT_FOUND', 'SCRIPT_HASH_MISMATCH', 'INVALID_PARAMS', 'INVALID_TARGET'
)

function ConvertTo-ReportableCode {
  # 内部の理由を契約のコードへ。知らないコードは EXEC_FAILED。
  param([AllowNull()][string]$Code)
  if ($Code -ceq 'REVOKED' -or $Code -ceq 'TOKEN_REJECTED' -or $Code -ceq 'COMM_LOST') { return 'CANCELLED' }
  if ($Code -ceq 'CHILD_SID_MISMATCH') { return 'SID_MISMATCH' }
  if ($Code -ceq 'CHILD_INTEGRITY_REJECTED') { return 'ELEVATED' }
  foreach ($allowed in $script:SkillReportableCodes) { if ($Code -ceq $allowed) { return $Code } }
  return 'EXEC_FAILED'
}

function Get-SkillDefinition {
  param([AllowNull()][object]$SkillId)
  if ($SkillId -isnot [string]) { return $null }
  foreach ($def in $script:SkillCatalog) { if ($def.Id -ceq $SkillId) { return $def } }
  return $null
}

function ConvertTo-SortedParams {
  # キーを序数順に並べる（JS の Array.prototype.sort と同じ順）。値は整数・真偽・文字列のみ。
  param([AllowNull()][object]$Params)
  if ($null -eq $Params) { throw 'params がありません。' }
  $names = New-Object System.Collections.Generic.List[string]
  $values = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  if ($Params -is [System.Collections.IDictionary]) {
    foreach ($k in $Params.Keys) { $names.Add([string]$k); $values[[string]$k] = $Params[$k] }
  } elseif ($Params.PSObject.BaseObject -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $Params.PSObject.Properties) { $names.Add($p.Name); $values[$p.Name] = $p.Value }
  } else {
    throw 'params がオブジェクトではありません。'
  }
  $names.Sort([StringComparer]::Ordinal)
  $sorted = [ordered]@{}
  foreach ($name in $names) {
    $value = $values[$name]
    if ($value -is [int] -or $value -is [long]) {
      if ([Math]::Abs([long]$value) -gt $script:SafeIntegerMax) { throw 'params の整数が範囲外です。' }
    } elseif ($value -isnot [bool] -and $value -isnot [string]) {
      throw 'params の値の型が許可されていません。'
    }
    $sorted[$name] = $value
  }
  # [ordered] のキーは大文字小文字を区別しない。A と a の併存は拒否する。
  if ($sorted.Count -ne $names.Count) { throw 'params のキーが重複しています。' }
  return $sorted
}

function ConvertFrom-SkillParamsJson {
  # 署名の検証後にだけ呼ぶ。オブジェクト以外や壊れた JSON は $null。
  param([AllowNull()][string]$Json)
  if ([string]::IsNullOrEmpty($Json)) { return $null }
  if (-not $Json.StartsWith('{', [StringComparison]::Ordinal)) { return $null }
  try { return (ConvertFrom-HelperJson -Json $Json) } catch { return $null }
}

function Test-SkillParams {
  # スキーマに完全一致するときだけ $true。任意文字列は受けない（enum のみ）。
  param([AllowNull()][object]$Params, [AllowEmptyCollection()][object[]]$Schema)
  try { $sorted = ConvertTo-SortedParams -Params $Params } catch { return $false }
  foreach ($key in @($sorted.Keys)) {
    $spec = $null
    foreach ($candidate in $Schema) { if ($candidate.Name -ceq $key) { $spec = $candidate } }
    if ($null -eq $spec) { return $false }
    $value = $sorted[[string]$key]
    if ($spec.Type -ceq 'int') {
      if ($value -isnot [int] -and $value -isnot [long]) { return $false }
      if ([long]$value -lt [long]$spec.Min -or [long]$value -gt [long]$spec.Max) { return $false }
    } elseif ($spec.Type -ceq 'bool') {
      if ($value -isnot [bool]) { return $false }
    } elseif ($spec.Type -ceq 'enum') {
      if ($value -isnot [string]) { return $false }
      $found = $false
      foreach ($allowed in $spec.Values) { if ($value -ceq $allowed) { $found = $true } }
      if (-not $found) { return $false }
    } else {
      return $false
    }
  }
  foreach ($spec in $Schema) {
    if (-not $spec.Required) { continue }
    $present = $false
    foreach ($key in @($sorted.Keys)) { if ([string]$key -ceq $spec.Name) { $present = $true } }
    if (-not $present) { return $false }
  }
  return $true
}

function Get-SkillRunCanonicalJson {
  # contract.ts の canonicalSkillRunJson。list_metadata の正準形とは別のドメイン。キー順固定、空白なし。
  # paramsJson は文字列のまま署名する（解釈は署名の検証後）。
  param([Parameter(Mandatory)][object]$Op)
  foreach ($name in 'canon', 'opId', 'requestId', 'supportSessionId', 'proposalId', 'role', 'sid', 'machineGuid', 'operation', 'skillId', 'skillVersion', 'contentHash', 'scriptHash', 'paramsJson', 'startNonce', 'expiresAt') {
    $v = (Get-OpField -Op $Op -Name $name)
    if ($v -isnot [string]) { throw "署名対象の $name が文字列ではありません。" }
  }
  foreach ($name in 'stepSeq', 'sessionId', 'maxSeconds', 'maxOutputBytes') {
    $v = (Get-OpField -Op $Op -Name $name)
    if ($v -isnot [int] -and $v -isnot [long]) { throw "署名対象の $name が整数ではありません。" }
  }
  $root = (Get-OpField -Op $Op -Name 'targetRoot')
  if ($null -ne $root -and $root -isnot [string]) { throw '署名対象の targetRoot が不正です。' }
  $segments = (Get-OpField -Op $Op -Name 'targetSegments')
  if ($segments -isnot [array]) { throw '署名対象の targetSegments が配列ではありません。' }
  foreach ($s in $segments) { if ($s -isnot [string]) { throw '署名対象の targetSegments に文字列以外があります。' } }
  $ordered = [ordered]@{
    canon            = $Op.canon
    opId             = $Op.opId
    requestId        = $Op.requestId
    supportSessionId = $Op.supportSessionId
    proposalId       = $Op.proposalId
    stepSeq          = (Get-OpField -Op $Op -Name 'stepSeq')
    role             = $Op.role
    sid              = $Op.sid
    sessionId        = (Get-OpField -Op $Op -Name 'sessionId')
    machineGuid      = $Op.machineGuid
    operation        = $Op.operation
    skillId          = $Op.skillId
    skillVersion     = $Op.skillVersion
    contentHash      = $Op.contentHash
    scriptHash       = $Op.scriptHash
    paramsJson       = $Op.paramsJson
    targetRoot       = $root
    targetSegments   = $segments
    startNonce       = $Op.startNonce
    expiresAt        = $Op.expiresAt
    maxSeconds       = (Get-OpField -Op $Op -Name 'maxSeconds')
    maxOutputBytes   = (Get-OpField -Op $Op -Name 'maxOutputBytes')
  }
  return (ConvertTo-HelperJson -Value $ordered)
}

function Test-SkillRunSignature {
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][string]$Token)
  $sig = (Get-OpField -Op $Op -Name 'sig')
  if ($sig -isnot [string] -or $sig -cnotmatch '^[0-9a-f]{64}$') { return $false }
  $expected = Get-HmacSha256Hex -Key $Token -Message (Get-SkillRunCanonicalJson -Op $Op)
  return (Test-FixedTimeEqual -A $expected -B $sig)
}

function Get-IntegrityRefusal {
  # 取得できない値は安全側で拒否する。High 以上は昇格として扱う。
  param([int]$IntegrityRid)
  if ($IntegrityRid -lt 0) { return 'INTEGRITY_UNKNOWN' }
  if ($IntegrityRid -ge $script:IntegrityHighRid) { return 'ELEVATED' }
  return $null
}

function Get-SkillRunRefusal {
  # 実行前の検証。戻り値は contract.ts の HELPER_REJECT_CODES。
  # $Context: Sid, SessionId, SessionState, NowUtc, IsElevated, IntegrityRid, MachineGuid
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Context
  )
  try {
    if (-not (Test-SkillRunSignature -Op $Op -Token $Token)) { return 'BAD_SIGNATURE' }
  } catch {
    return 'BAD_OP'
  }
  if ($Op.canon -cne $script:SkillRunCanon -or $Op.operation -cne 'skill_run') { return 'BAD_OP' }
  if ($Context.IsElevated) { return 'ELEVATED' }
  # 整合性が不明でも昇格の扱いで止める。サービスアカウントも同じ（SYSTEM で実行しない）。
  if ($null -ne (Get-IntegrityRefusal -IntegrityRid $Context.IntegrityRid)) { return 'ELEVATED' }
  foreach ($restricted in $script:RestrictedSids) { if ($Context.Sid -ceq $restricted) { return 'ELEVATED' } }
  if ($Op.sid -cne $Context.Sid) { return 'SID_MISMATCH' }
  if ([long]$Op.sessionId -ne [long]$Context.SessionId) { return 'SESSION_MISMATCH' }
  if ($Context.SessionState -cne 'active') { return 'SESSION_NOT_ACTIVE' }
  $expires = ConvertFrom-IsoUtc -Value $Op.expiresAt
  if ($null -eq $expires) { return 'BAD_OP' }
  if ($expires -le $Context.NowUtc) { return 'EXPIRED' }
  if ([string]::IsNullOrEmpty($Context.MachineGuid) -or -not [string]::Equals($Op.machineGuid, $Context.MachineGuid, [StringComparison]::OrdinalIgnoreCase)) { return 'DEVICE_MISMATCH' }
  $def = Get-SkillDefinition -SkillId $Op.skillId
  if ($null -eq $def) { return 'SKILL_NOT_FOUND' }
  if ($Op.scriptHash -cnotmatch '^sha256:[0-9a-f]{64}$') { return 'BAD_OP' }
  if ($Op.contentHash -cnotmatch '^sha256:[0-9a-f]{64}$') { return 'BAD_OP' }
  if ($Op.skillVersion -cnotmatch '^[0-9A-Za-z.+-]{1,40}$') { return 'BAD_OP' }
  if ([long]$Op.maxSeconds -le 0 -or [long]$Op.maxOutputBytes -le 0) { return 'BAD_OP' }
  $root = (Get-OpField -Op $Op -Name 'targetRoot')
  $segments = (Get-OpField -Op $Op -Name 'targetSegments')
  if ($def.NeedsTarget) {
    if (-not (Test-AllowedRoot -Root $root)) { return 'INVALID_TARGET' }
    if (-not (Test-PathSegments -Segments $segments)) { return 'INVALID_TARGET' }
  } elseif ($null -ne $root -or @($segments).Count -ne 0) {
    return 'INVALID_TARGET'
  }
  $params = ConvertFrom-SkillParamsJson -Json $Op.paramsJson
  if ($null -eq $params -or -not (Test-SkillParams -Params $params -Schema $def.Params)) { return 'INVALID_PARAMS' }
  return $null
}

function Get-EffectiveTimeoutSeconds {
  # 署名値と固定上限の小さい方。
  param([long]$Signed, [int]$HardMax = $script:SkillHardMaxSeconds)
  if ($Signed -le 0) { return $HardMax }
  return [int][Math]::Min($Signed, [long]$HardMax)
}

function Get-EffectiveMaxOutputBytes {
  param([long]$Signed, [int]$HardMax = $script:SkillMaxStdoutBytes)
  if ($Signed -le 0) { return $HardMax }
  return [int][Math]::Min($Signed, [long]$HardMax)
}

function Get-RunStopReason {
  # 実行中に止める理由。止めないなら $null。op の expiresAt は開始前の条件なのでここでは見ない。
  param(
    [bool]$Revoked,
    [bool]$Cancelled,
    [bool]$TokenRejected,
    [AllowNull()][string]$SessionState,
    [long]$ElapsedMs,
    [long]$TimeoutMs,
    [long]$MsSincePollOk,
    [long]$CommLossMs = $script:SkillCommLossMs
  )
  if ($Revoked) { return 'REVOKED' }
  if ($TokenRejected) { return 'TOKEN_REJECTED' }
  if ($Cancelled) { return 'CANCELLED' }
  if ($SessionState -cne 'active') { return 'SESSION_NOT_ACTIVE' }
  if ($ElapsedMs -ge $TimeoutMs) { return 'TIMEOUT' }
  # 取消を受け取れない状態で動かし続けない。
  if ($MsSincePollOk -ge $CommLossMs) { return 'COMM_LOST' }
  return $null
}

function Get-ChildRefusal {
  # 起動直後の子の検証。本人以外・昇格・確認不能なら止める。
  param([AllowNull()][string]$ChildSid, [Parameter(Mandatory)][string]$ExpectedSid, [int]$ChildIntegrityRid)
  if ([string]::IsNullOrEmpty($ChildSid) -or $ChildSid -cne $ExpectedSid) { return 'CHILD_SID_MISMATCH' }
  $integrity = Get-IntegrityRefusal -IntegrityRid $ChildIntegrityRid
  if ($null -ne $integrity) { return 'CHILD_INTEGRITY_REJECTED' }
  return $null
}

function Get-PartialEffectCodes {
  # 既に生じた変更や停止不能を隠さず報告する固定コード（docs/63 §10）。read は変更しない。
  param([Parameter(Mandatory)][string]$Effect, [bool]$InputDelivered, [bool]$CompletedOk, [bool]$StopFailed)
  $codes = New-Object System.Collections.Generic.List[string]
  if ($Effect -ceq 'modify' -and $InputDelivered -and -not $CompletedOk) { $codes.Add('PARTIAL_EFFECT_POSSIBLE') }
  if ($StopFailed) { $codes.Add('STOP_FAILED_CHILD_RUNNING') }
  return $codes.ToArray()
}

function ConvertFrom-SkillOutput {
  # 1 行の JSON オブジェクトだけを受ける。それ以外は $null。パス等の自由文を外へ出さない。
  param([AllowNull()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $trimmed = $Text.Trim()
  if ($trimmed.IndexOf("`n") -ge 0 -or $trimmed.IndexOf("`r") -ge 0) { return $null }
  if (-not $trimmed.StartsWith('{', [StringComparison]::Ordinal)) { return $null }
  try { $parsed = ConvertFrom-HelperJson -Json $trimmed } catch { return $null }
  $resultCode = Get-OpField -Op $parsed -Name 'resultCode'
  if ($null -ne $resultCode -and ($resultCode -isnot [string] -or $resultCode -cnotmatch '^[A-Z0-9_]{1,64}$')) { $resultCode = $null }
  return @{ Json = $trimmed; ResultCode = $resultCode }
}

function Get-Sha256Prefixed {
  # 現在位置から末尾までのハッシュ（server の computeScriptHash と同じ sha256:<hex>）。
  param([Parameter(Mandatory)][IO.Stream]$Stream)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($Stream) } finally { $sha.Dispose() }
  $sb = New-Object System.Text.StringBuilder 71
  [void]$sb.Append('sha256:')
  foreach ($b in $hash) { [void]$sb.Append($b.ToString('x2')) }
  return $sb.ToString()
}

function New-SkillArguments {
  # 引数は固定。params は stdin で渡し、コマンドラインへ入れない。
  param([Parameter(Mandatory)][string]$ScriptPath)
  if ($ScriptPath.IndexOf('"') -ge 0) { throw 'スクリプトのパスが不正です。' }
  return '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
}

function New-SkillStdinJson {
  # 契約の {root, segments} に、ヘルパーが解決した最終パス（path, rootPath）を足す。端末内だけで使う。
  param([AllowNull()][object]$Params, [AllowNull()][object]$Target)
  return (ConvertTo-HelperJson -Value ([ordered]@{ params = (ConvertTo-SortedParams -Params $Params); target = $Target }))
}

function New-SkillResultJson {
  # contract.ts の SkillResultBodySchema。stderr は送らない（パスを含み得る）。
  # output は検証済みの 1 行 JSON をそのまま埋める（disk.space の小数を整形し直さない）。
  param(
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [AllowNull()][object]$SkillId,
    [AllowNull()][object]$SkillVersion,
    [AllowNull()][object]$ScriptHash,
    [Parameter(Mandatory)][string]$Status,
    [Parameter(Mandatory)][string]$ResultCode,
    [AllowNull()][object]$ExitCode,
    [AllowNull()][string]$StartedAt,
    [AllowNull()][string]$FinishedAt,
    [long]$ElapsedMs,
    [AllowNull()][string]$OutputJson,
    [AllowNull()][string]$StopOutcome,
    [AllowEmptyCollection()][string[]]$PartialEffect = @()
  )
  # 署名の検証前の拒否でも schema を満たす。未検証の文字列はここで形を確かめて捨てる。
  $safeSkill = if ($SkillId -is [string] -and $SkillId -cmatch '^[a-z0-9._-]{1,100}$') { $SkillId } else { 'unknown' }
  $safeVersion = if ($SkillVersion -is [string] -and $SkillVersion -cmatch '^[0-9A-Za-z.+-]{1,40}$') { $SkillVersion } else { '0' }
  $safeHash = if ($ScriptHash -is [string] -and $ScriptHash -cmatch '^sha256:[0-9a-f]{64}$') { $ScriptHash } else { 'sha256:' + ('0' * 64) }
  $body = [ordered]@{
    executionMode = 'real'
    actorSid      = $ActorSid
    sessionId     = $SessionId
    skillId       = $safeSkill
    skillVersion  = $safeVersion
    scriptHash    = $safeHash
    status        = $Status
    resultCode    = $ResultCode
    exitCode      = $ExitCode
    startedAt     = $(if ([string]::IsNullOrEmpty($StartedAt)) { $null } else { $StartedAt })
    finishedAt    = $(if ([string]::IsNullOrEmpty($FinishedAt)) { $null } else { $FinishedAt })
    elapsedMs     = [long][Math]::Min([Math]::Max($ElapsedMs, [long]0), [long]3600000)
  }
  if (-not [string]::IsNullOrEmpty($StopOutcome)) { $body['stopOutcome'] = $StopOutcome }
  if ($PartialEffect.Count -gt 0) { $body['partialEffect'] = [object[]]$PartialEffect }
  $json = ConvertTo-HelperJson -Value $body
  $outputText = if ([string]::IsNullOrEmpty($OutputJson)) { 'null' } else { $OutputJson }
  return $json.Substring(0, $json.Length - 1) + ',"output":' + $outputText + '}'
}

function New-RunRecordJson {
  # 名前・パス・params を入れない。再起動時の INTERRUPTED 報告に必要な値だけ。
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][string]$Effect, [Parameter(Mandatory)][string]$StartedAt)
  return (ConvertTo-HelperJson -Value ([ordered]@{
        opId = [string]$Op.opId; skillId = [string]$Op.skillId; skillVersion = [string]$Op.skillVersion
        scriptHash = [string]$Op.scriptHash; effect = $Effect; startedAt = $StartedAt; expiresAt = [string]$Op.expiresAt
      }))
}

function Get-RunReportJson {
  # 保存済みの結果があればそれを送る。無ければ実行途中で落ちたので interrupted を報告する（再実行しない）。
  param(
    [AllowNull()][string]$RecordJson,
    [AllowNull()][string]$ResultJson,
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [AllowNull()][string]$NowIso
  )
  if (-not [string]::IsNullOrEmpty($ResultJson)) { return $ResultJson }
  $record = $null
  try { $record = ConvertFrom-HelperJson -Json $RecordJson } catch { $record = $null }
  # 記録が読めないときは modify として扱う（部分変更を隠さない）。
  $effect = 'modify'
  $startedAt = $null
  $skillId = $null
  $skillVersion = $null
  $scriptHash = $null
  if ($null -ne $record) {
    if ((Get-OpField -Op $record -Name 'effect') -ceq 'read') { $effect = 'read' }
    $startedAt = [string](Get-OpField -Op $record -Name 'startedAt')
    $skillId = Get-OpField -Op $record -Name 'skillId'
    $skillVersion = Get-OpField -Op $record -Name 'skillVersion'
    $scriptHash = Get-OpField -Op $record -Name 'scriptHash'
  }
  $codes = [string[]]@(Get-PartialEffectCodes -Effect $effect -InputDelivered $true -CompletedOk $false -StopFailed $false)
  return (New-SkillResultJson -ActorSid $ActorSid -SessionId $SessionId -SkillId $skillId -SkillVersion $skillVersion -ScriptHash $scriptHash -Status 'interrupted' -ResultCode 'INTERRUPTED' -ExitCode $null -StartedAt $startedAt -FinishedAt $NowIso -ElapsedMs 0 -OutputJson $null -StopOutcome $null -PartialEffect $codes)
}

function Get-ReportDisposition {
  # 報告の応答の扱い。sent: 受理。expired: 410（期限切れ。報告済みと区別する）。rejected: 恒久的な拒否。retry: 再送。
  # 報告専用トークンの 401 は、サーバがトークンを知らないので再送しても届かない。
  param([int]$Status, [bool]$ReportOnly = $false)
  if ($Status -ge 200 -and $Status -lt 300) { return 'sent' }
  if ($Status -eq 410) { return 'expired' }
  if ($Status -eq 401) { if ($ReportOnly) { return 'rejected' } else { return 'retry' } }
  if ($Status -eq 408 -or $Status -eq 429) { return 'retry' }
  if ($Status -ge 400 -and $Status -lt 500) { return 'rejected' }
  return 'retry'
}

function Test-ReportFinal {
  # もう再送しない応答か。接続失敗・401・408・429・5xx は再送する。
  param([int]$Status)
  return ((Get-ReportDisposition -Status $Status) -cne 'retry')
}

function Invoke-RunReportFlush {
  # 未報告の実行記録を報告する。$Deps: ListUnsent, ReadReport, SendReport, MarkSent（$id, $disposition）
  param([Parameter(Mandatory)][hashtable]$Deps, [bool]$ReportOnly = $false)
  foreach ($opId in @(& $Deps.ListUnsent)) {
    if (-not (Test-SafeOpId -OpId $opId)) { continue }
    $json = & $Deps.ReadReport $opId
    if ([string]::IsNullOrEmpty($json)) { continue }
    $sent = & $Deps.SendReport $opId $json
    $disposition = Get-ReportDisposition -Status $sent.Status -ReportOnly $ReportOnly
    if ($disposition -cne 'retry') { & $Deps.MarkSent $opId $disposition }
  }
}

function Complete-HelperRevocation {
  # 順序を固定する: 実行中の子は呼び出し前に kill 済み → 報告 → トークン削除。
  # 未報告が残れば token.dat と未報告の記録を報告専用の場所へ移す（install が新規登録できるように）。
  # 戻り値: すべて報告してトークンを消したら $true、報告専用へ移したら $false。
  param([Parameter(Mandatory)][hashtable]$Deps, [int]$MaxAttempts = 5)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try { & $Deps.Flush } catch { & $Deps.OnFlushError $_ }
    if (@(& $Deps.ListUnsent).Count -eq 0) {
      & $Deps.RemoveToken
      return $true
    }
    if ($attempt -lt $MaxAttempts) { & $Deps.Wait $attempt }
  }
  & $Deps.HandOff
  return $false
}

function New-SkillNotRunOutcome {
  # 子を起動していない結果の報告本文。$Recorded は実行記録を書いた後かどうか（報告の経路が変わる）。
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [Parameter(Mandatory)][string]$Status,
    [Parameter(Mandatory)][string]$ResultCode,
    [long]$ElapsedMs,
    [bool]$Recorded,
    [AllowNull()][string]$StopOutcome = $null,
    [AllowEmptyCollection()][string[]]$PartialEffect = @(),
    [AllowNull()][object]$ExitCode = $null,
    [AllowNull()][string]$StartedAt = $null,
    [AllowNull()][string]$FinishedAt = $null
  )
  $json = New-SkillResultJson -ActorSid $ActorSid -SessionId $SessionId -SkillId (Get-OpField -Op $Op -Name 'skillId') -SkillVersion (Get-OpField -Op $Op -Name 'skillVersion') -ScriptHash (Get-OpField -Op $Op -Name 'scriptHash') -Status $Status -ResultCode $ResultCode -ExitCode $ExitCode -StartedAt $StartedAt -FinishedAt $FinishedAt -ElapsedMs $ElapsedMs -OutputJson $null -StopOutcome $StopOutcome -PartialEffect $PartialEffect
  return @{ Action = 'report'; Json = $json; Recorded = $Recorded }
}

function ConvertTo-TargetRejectCode {
  # 範囲検査の理由を契約のコードへ。ACCESS_DENIED と NOT_FOUND は共通の失敗コードのまま。
  param([AllowNull()][string]$Reason)
  if ($Reason -ceq 'ACCESS_DENIED' -or $Reason -ceq 'NOT_FOUND') { return $Reason }
  return 'INVALID_TARGET'
}

function Invoke-SkillRun {
  # 検証済みの op を実行する。OS 依存部は $Deps で差し替える:
  # RecordExists, ResolveTarget, OpenScript, PostStart, WriteRecord, Launch, WaitExit, StopRunner,
  # FinishRunner, DisposeRunner, Poll, GetStopFlags, ElapsedMs, NowIso
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][hashtable]$Definition,
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [Parameter(Mandatory)][hashtable]$Deps
  )
  $opId = [string]$Op.opId
  $effect = [string]$Definition.Effect

  # 記録があれば実行済みか途中で落ちた op。再実行しない（報告は Invoke-RunReportFlush が行う）。
  if (& $Deps.RecordExists $opId) { return @{ Action = 'already_recorded'; Json = $null; Recorded = $true } }

  $segments = @((Get-OpField -Op $Op -Name 'targetSegments'))
  $target = $null
  if ($Definition.NeedsTarget) {
    $resolved = & $Deps.ResolveTarget $Op
    if ($null -ne $resolved.Reason) {
      return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'rejected' -ResultCode (ConvertTo-TargetRejectCode -Reason $resolved.Reason) -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $false)
    }
    $target = [ordered]@{ root = [string]$Op.targetRoot; segments = [object[]]$segments; path = $resolved.TargetFinal; rootPath = $resolved.RootFinal }
  }

  $scriptOpen = & $Deps.OpenScript $Definition
  if ($null -ne $scriptOpen.Reason) {
    return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'rejected' -ResultCode 'SKILL_NOT_FOUND' -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $false)
  }
  try {
    # 実行ハンドルは読取共有で開いたまま。起動から終了まで内容を差し替えられない。
    if (-not (Test-FixedTimeEqual -A ([string]$scriptOpen.Hash) -B ([string]$Op.scriptHash))) {
      return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'rejected' -ResultCode 'SCRIPT_HASH_MISMATCH' -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $false)
    }

    # サーバの原子的な遷移が成功したときだけ実行する。応答がなければ実行しない。再送しない（nonce は 1 回限り）。
    $start = & $Deps.PostStart $Op
    if (-not $start.Ok) {
      if ($start.Status -eq 0 -or $start.Status -ge 500) {
        # サーバ側で開始済みになっている可能性があるので、実行していないことを申告する。
        return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'rejected' -ResultCode 'START_NO_RESPONSE' -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $false)
      }
      return @{ Action = 'rejected_at_start'; Json = $null; Recorded = $false }
    }

    $startedAt = [string](& $Deps.NowIso)
    if (-not (& $Deps.WriteRecord $Op $effect $startedAt)) {
      return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'error' -ResultCode 'INTERNAL_ERROR' -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $false -StartedAt $startedAt)
    }

    $stdin = New-SkillStdinJson -Params (ConvertFrom-SkillParamsJson -Json $Op.paramsJson) -Target $target
    $outputCap = Get-EffectiveMaxOutputBytes -Signed ([long]$Op.maxOutputBytes)
    $launch = & $Deps.Launch $scriptOpen.Path $stdin $outputCap
    if ($null -ne $launch.Reason) {
      # stdin を渡す前に止めたので Skill の処理は始まっていない。stdin を読まない disk-space だけは起動直後から動く（読み取りのみ）。
      $launchCodes = [string[]]@(Get-PartialEffectCodes -Effect $effect -InputDelivered $false -CompletedOk $false -StopFailed ($launch.StopOutcome -ceq 'stop_failed'))
      return (New-SkillNotRunOutcome -Op $Op -ActorSid $ActorSid -SessionId $SessionId -Status 'error' -ResultCode (ConvertTo-ReportableCode -Code $launch.Reason) -ElapsedMs ([long](& $Deps.ElapsedMs)) -Recorded $true -StopOutcome ([string]$launch.StopOutcome) -PartialEffect $launchCodes -ExitCode $launch.ExitCode -StartedAt $startedAt -FinishedAt ([string](& $Deps.NowIso)))
    }
    $runner = $launch.Runner
    try {
      $timeoutMs = [long](Get-EffectiveTimeoutSeconds -Signed ([long]$Op.maxSeconds)) * 1000
      $lastPollAt = [long](& $Deps.ElapsedMs)
      $lastPollOk = $lastPollAt
      $tokenRejected = $false
      $stopReason = $null
      $stopInfo = $null
      while ($true) {
        if (& $Deps.WaitExit $runner 1000) { break }
        $elapsed = [long](& $Deps.ElapsedMs)
        if (($elapsed - $lastPollAt) -ge $script:SkillPollEveryMs) {
          $poll = & $Deps.Poll
          $elapsed = [long](& $Deps.ElapsedMs)
          $lastPollAt = $elapsed
          if ($poll.Ok) { $lastPollOk = $elapsed }
          elseif ($poll.Status -eq 401) { $tokenRejected = $true }
        }
        $flags = & $Deps.GetStopFlags
        $stopReason = Get-RunStopReason -Revoked ([bool]$flags.Revoked) -Cancelled ([bool]$flags.Cancelled) -TokenRejected $tokenRejected -SessionState $flags.SessionState -ElapsedMs $elapsed -TimeoutMs $timeoutMs -MsSincePollOk ($elapsed - $lastPollOk)
        if ($null -ne $stopReason) {
          $stopInfo = & $Deps.StopRunner $runner
          break
        }
      }
      $finished = & $Deps.FinishRunner $runner
    } finally {
      & $Deps.DisposeRunner $runner
    }

    $finishedAt = [string](& $Deps.NowIso)
    $elapsedTotal = [long](& $Deps.ElapsedMs)
    if ($null -ne $stopReason) {
      # 順序は kill（ここまで）→ 報告（呼び出し側）→ トークン削除（Complete-HelperRevocation）。
      $stopFailed = -not [bool]$stopInfo.Stopped
      $stopOutcome = if ($stopFailed) { 'stop_failed' } else { 'stopped' }
      $status = if ($stopReason -ceq 'TIMEOUT') { 'timeout' } else { 'cancelled' }
      $codes = [string[]]@(Get-PartialEffectCodes -Effect $effect -InputDelivered $true -CompletedOk $false -StopFailed $stopFailed)
      $json = New-SkillResultJson -ActorSid $ActorSid -SessionId $SessionId -SkillId $Op.skillId -SkillVersion $Op.skillVersion -ScriptHash $Op.scriptHash -Status $status -ResultCode (ConvertTo-ReportableCode -Code $stopReason) -ExitCode $stopInfo.ExitCode -StartedAt $startedAt -FinishedAt $finishedAt -ElapsedMs $elapsedTotal -OutputJson $null -StopOutcome $stopOutcome -PartialEffect $codes
      return @{ Action = 'report'; Json = $json; Recorded = $true }
    }

    # 正常終了後に残った孫は FinishRunner が Job ごと終了させる。止められなければ成功にしない。
    $stopFailed = [bool]$finished.LeftoverStopFailed
    $parsedOutput = $null
    if (-not $finished.StdoutTruncated) { $parsedOutput = ConvertFrom-SkillOutput -Text $finished.Stdout }
    $status = 'error'
    $resultCode = $null
    if ($stopFailed) { $resultCode = 'EXEC_FAILED' }
    elseif ($finished.StdoutTruncated) { $resultCode = 'OUTPUT_TOO_LARGE' }
    elseif ($finished.ExitCode -ne 0) {
      $resultCode = 'EXEC_FAILED'
      if ($null -ne $parsedOutput -and $null -ne $parsedOutput.ResultCode) { $resultCode = ConvertTo-ReportableCode -Code $parsedOutput.ResultCode }
    }
    elseif ($null -eq $parsedOutput) { $resultCode = 'OUTPUT_INVALID' }
    else {
      $status = 'ok'
      $resultCode = 'OK'
      if ($null -ne $parsedOutput.ResultCode) { $resultCode = $parsedOutput.ResultCode }
    }
    $outputJson = if ($null -ne $parsedOutput) { [string]$parsedOutput.Json } else { $null }
    # 止める前に子が終わっていても、取消を受けたなら結果を明示する（省くと stop_unconfirmed になる）。
    $afterFlags = & $Deps.GetStopFlags
    $stopOutcome = if ($stopFailed) { 'stop_failed' } elseif ($afterFlags.Cancelled -or $afterFlags.Revoked) { 'not_running' } else { $null }
    $codes = [string[]]@(Get-PartialEffectCodes -Effect $effect -InputDelivered $true -CompletedOk ($status -ceq 'ok') -StopFailed $stopFailed)
    $json = New-SkillResultJson -ActorSid $ActorSid -SessionId $SessionId -SkillId $Op.skillId -SkillVersion $Op.skillVersion -ScriptHash $Op.scriptHash -Status $status -ResultCode $resultCode -ExitCode $finished.ExitCode -StartedAt $startedAt -FinishedAt $finishedAt -ElapsedMs $elapsedTotal -OutputJson $outputJson -StopOutcome $stopOutcome -PartialEffect $codes
    return @{ Action = 'report'; Json = $json; Recorded = $true }
  } finally {
    if ($null -ne $scriptOpen.Handle) { $scriptOpen.Handle.Dispose() }
  }
}

# ---------------------------------------------------------------------------
# Windows 依存部（ドットソース時には実行しない）
# ---------------------------------------------------------------------------

$script:NativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;

namespace AIHelpDesk.FolderHelper {
  public sealed class PathProbeResult {
    public int Error;
    public uint Attributes;
    public uint ReparseTag;
    public string FinalPath;
  }

  public sealed class RawFindEntry {
    public string Name;
    public uint Attributes;
    public uint ReparseTag;
    public long Size;
    public long LastWriteFileTime;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct FileAttributeTagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  internal static class Api {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr hFile, int fileInformationClass, out FileAttributeTagInfo lpFileInformation, uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr hFile, int fileInformationClass, IntPtr lpFileInformation, uint dwBufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr hFile, StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WTSQuerySessionInformationW(IntPtr hServer, int sessionId, int wtsInfoClass, out IntPtr ppBuffer, out uint pBytesReturned);

    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    public static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("shell32.dll", ExactSpelling = true)]
    public static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct JobBasicLimit {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct JobIoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct JobExtendedLimit {
    public JobBasicLimit Basic;
    public JobIoCounters Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct JobBasicAccounting {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  internal static class JobApi {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JobExtendedLimit info, uint length);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, out JobBasicAccounting info, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool OpenProcessToken(IntPtr hProcess, uint desiredAccess, out IntPtr hToken);

    [DllImport("advapi32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetTokenInformation(IntPtr hToken, int infoClass, IntPtr buffer, uint length, out uint returned);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);

    [DllImport("advapi32.dll", SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr LocalFree(IntPtr hMem);
  }

  // Skill の子プロセスを入れる Job。ヘルパーが落ちてハンドルが閉じれば孫ごと終了する（KILL_ON_JOB_CLOSE）。
  public sealed class SkillJob : IDisposable {
    private const int ExtendedLimitInformationClass = 9;
    private const int BasicAccountingInformationClass = 1;
    private const uint KillOnJobClose = 0x2000;
    private IntPtr handle;
    public int LastError;

    public SkillJob() {
      handle = JobApi.CreateJobObjectW(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) {
        LastError = Marshal.GetLastWin32Error();
        return;
      }
      JobExtendedLimit info = new JobExtendedLimit();
      info.Basic.LimitFlags = KillOnJobClose;
      if (!JobApi.SetInformationJobObject(handle, ExtendedLimitInformationClass, ref info, (uint)Marshal.SizeOf(typeof(JobExtendedLimit)))) {
        LastError = Marshal.GetLastWin32Error();
        JobApi.CloseHandle(handle);
        handle = IntPtr.Zero;
      }
    }

    public bool IsValid { get { return handle != IntPtr.Zero; } }

    // 親が既に別の Job に入っていても入れ子として入る前提。実機未実測。
    public bool Assign(IntPtr process) {
      if (!JobApi.AssignProcessToJobObject(handle, process)) {
        LastError = Marshal.GetLastWin32Error();
        return false;
      }
      return true;
    }

    public bool Contains(IntPtr process) {
      bool inside;
      if (!JobApi.IsProcessInJob(process, handle, out inside)) { return false; }
      return inside;
    }

    public bool Terminate(uint exitCode) {
      if (handle == IntPtr.Zero) { return false; }
      if (!JobApi.TerminateJobObject(handle, exitCode)) {
        LastError = Marshal.GetLastWin32Error();
        return false;
      }
      return true;
    }

    // 失敗時は -1。
    public int ActiveProcesses() {
      if (handle == IntPtr.Zero) { return -1; }
      JobBasicAccounting info;
      if (!JobApi.QueryInformationJobObject(handle, BasicAccountingInformationClass, out info, (uint)Marshal.SizeOf(typeof(JobBasicAccounting)), IntPtr.Zero)) {
        LastError = Marshal.GetLastWin32Error();
        return -1;
      }
      return (int)info.ActiveProcesses;
    }

    public static int ExtendedLimitSize() { return Marshal.SizeOf(typeof(JobExtendedLimit)); }
    public static int BasicAccountingSize() { return Marshal.SizeOf(typeof(JobBasicAccounting)); }

    public void Dispose() {
      if (handle != IntPtr.Zero) {
        JobApi.CloseHandle(handle);
        handle = IntPtr.Zero;
      }
    }
  }

  // 別スレッドで読み続ける。上限を超えた分は捨てて読み続ける（子がパイプで止まらないように）。
  // PowerShell の scriptblock を OutputDataReceived に付けない（runspace のないスレッドで呼ばれる）。
  public sealed class BoundedReader {
    private readonly Stream stream;
    private readonly int cap;
    private readonly MemoryStream buffer = new MemoryStream();
    private readonly object gate = new object();
    private readonly Thread thread;
    private long total;
    private bool truncated;

    public BoundedReader(Stream source, int maxBytes) {
      stream = source;
      cap = maxBytes;
      thread = new Thread(Run);
      thread.IsBackground = true;
    }

    public void Start() { thread.Start(); }

    public bool Join(int milliseconds) { return thread.Join(milliseconds); }

    public long TotalBytes { get { lock (gate) { return total; } } }

    public bool Truncated { get { lock (gate) { return truncated; } } }

    public byte[] GetBytes() { lock (gate) { return buffer.ToArray(); } }

    private void Run() {
      byte[] chunk = new byte[4096];
      try {
        while (true) {
          int count = stream.Read(chunk, 0, chunk.Length);
          if (count <= 0) { break; }
          lock (gate) {
            total += count;
            int room = cap - (int)buffer.Length;
            int take = Math.Min(room, count);
            if (take > 0) { buffer.Write(chunk, 0, take); }
            if (take < count) { truncated = true; }
          }
        }
      } catch (IOException) {
      } catch (ObjectDisposedException) {
      }
    }
  }

  public static class ProcessToken {
    private const uint TokenQuery = 0x8;
    private const int TokenUserClass = 1;
    private const int TokenIntegrityLevelClass = 25;

    private static IntPtr QueryToken(IntPtr process, int infoClass) {
      IntPtr token;
      if (!JobApi.OpenProcessToken(process, TokenQuery, out token)) { return IntPtr.Zero; }
      try {
        uint needed;
        JobApi.GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out needed);
        if (needed == 0) { return IntPtr.Zero; }
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        if (!JobApi.GetTokenInformation(token, infoClass, buffer, needed, out needed)) {
          Marshal.FreeHGlobal(buffer);
          return IntPtr.Zero;
        }
        return buffer;
      } finally {
        JobApi.CloseHandle(token);
      }
    }

    // TOKEN_USER の SID を文字列で返す。失敗時は null。
    public static string GetUserSid(IntPtr process) {
      IntPtr buffer = QueryToken(process, TokenUserClass);
      if (buffer == IntPtr.Zero) { return null; }
      try {
        IntPtr text;
        if (!JobApi.ConvertSidToStringSidW(Marshal.ReadIntPtr(buffer), out text)) { return null; }
        try {
          return Marshal.PtrToStringUni(text);
        } finally {
          JobApi.LocalFree(text);
        }
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    // TOKEN_MANDATORY_LABEL の最後の RID（0x2000 = Medium、0x3000 = High）。失敗時は -1。
    public static int GetIntegrityRid(IntPtr process) {
      IntPtr buffer = QueryToken(process, TokenIntegrityLevelClass);
      if (buffer == IntPtr.Zero) { return -1; }
      try {
        IntPtr sid = Marshal.ReadIntPtr(buffer);
        int count = Marshal.ReadByte(JobApi.GetSidSubAuthorityCount(sid));
        if (count < 1) { return -1; }
        return Marshal.ReadInt32(JobApi.GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }

  // 検査したディレクトリそのものを列挙する。パスを開き直さないので、検査の後に
  // ジャンクションへ差し替えられても範囲外を読まない。FILE_SHARE_DELETE を渡さないので、
  // 開いている間は対象を改名・削除できない前提（実機未実測）。子は開かない。
  public sealed class DirectoryHandle : IDisposable {
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private const int InfoClassIdBothRestart = 11;
    private const int InfoClassIdBoth = 10;
    private const int InfoClassAttributeTag = 9;
    private const int BufferSize = 65536;
    private const int ErrorNoMoreFiles = 18;
    private const int ErrorFileNotFound = 2;
    private const int ErrorInvalidData = 13;
    private IntPtr handle;
    private IntPtr buffer;
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

    public PathProbeResult Describe() {
      PathProbeResult result = new PathProbeResult();
      if (handle == Invalid) {
        result.Error = LastError != 0 ? LastError : 6;
        return result;
      }
      FileAttributeTagInfo info;
      if (!Api.GetFileInformationByHandleEx(handle, InfoClassAttributeTag, out info, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
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

    // . と .. もそのまま返す（呼び出し側で除く）。終端は null で LastError = 18。
    public RawFindEntry Next() {
      if (handle == Invalid) { return null; }
      if (!hasData) {
        int infoClass = started ? InfoClassIdBoth : InfoClassIdBothRestart;
        if (!Api.GetFileInformationByHandleEx(handle, infoClass, buffer, (uint)BufferSize)) {
          int error = Marshal.GetLastWin32Error();
          // 空の場合の初回のコードは 2 の可能性がある（実機未実測）。
          LastError = (!started && error == ErrorFileNotFound) ? ErrorNoMoreFiles : error;
          return null;
        }
        started = true;
        hasData = true;
        offset = 0;
      }
      int next;
      RawFindEntry entry = DirectoryEntryDecoder.Decode(buffer, offset, BufferSize, out next);
      if (entry == null) {
        // 境界の合わないバッファは読まない。部分結果にしない。
        LastError = ErrorInvalidData;
        hasData = false;
        return null;
      }
      if (next == 0) { hasData = false; } else { offset += next; }
      return entry;
    }

    public void Dispose() {
      if (handle != Invalid) {
        Api.CloseHandle(handle);
        handle = Invalid;
      }
      if (buffer != IntPtr.Zero) {
        Marshal.FreeHGlobal(buffer);
        buffer = IntPtr.Zero;
      }
    }
  }

  // FILE_ID_BOTH_DIR_INFO の 1 要素を境界検査つきで読む。Linux のテストでも検証できるよう API を呼ばない。
  public static class DirectoryEntryDecoder {
    public const int OffsetLastWrite = 24;
    public const int OffsetEndOfFile = 40;
    public const int OffsetAttributes = 56;
    public const int OffsetNameLength = 60;
    public const int OffsetEaSize = 64;
    public const int OffsetName = 104;
    private const uint AttributeReparsePoint = 0x400;

    // 不正なら null。nextOffset はこの要素から次の要素までのバイト数（0 は終端）。
    public static RawFindEntry Decode(IntPtr buffer, int offset, int bufferSize, out int nextOffset) {
      nextOffset = 0;
      if (offset < 0 || offset > bufferSize - OffsetName) { return null; }
      IntPtr item = new IntPtr(buffer.ToInt64() + offset);
      int next = Marshal.ReadInt32(item, 0);
      int nameLength = Marshal.ReadInt32(item, OffsetNameLength);
      // 名前は UTF-16 のバイト数。偶数・正でバッファ内に収まること。
      if (nameLength <= 0 || (nameLength % 2) != 0 || nameLength > bufferSize - offset - OffsetName) { return null; }
      if (next != 0) {
        if (next < OffsetName + nameLength || (next % 8) != 0 || next > bufferSize - offset) { return null; }
      }
      RawFindEntry entry = new RawFindEntry();
      entry.Name = Marshal.PtrToStringUni(new IntPtr(item.ToInt64() + OffsetName), nameLength / 2);
      entry.Attributes = (uint)Marshal.ReadInt32(item, OffsetAttributes);
      entry.ReparseTag = (entry.Attributes & AttributeReparsePoint) != 0 ? (uint)Marshal.ReadInt32(item, OffsetEaSize) : 0;
      entry.Size = Marshal.ReadInt64(item, OffsetEndOfFile);
      entry.LastWriteFileTime = Marshal.ReadInt64(item, OffsetLastWrite);
      nextOffset = next;
      return entry;
    }
  }

  public static class Native {
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private const uint FileReadAttributes = 0x80;
    private const uint ShareAll = 0x7;
    private const uint OpenExisting = 3;
    private const uint FlagBackupSemantics = 0x02000000;
    private const uint FlagOpenReparsePoint = 0x00200000;
    private const int FileAttributeTagInfoClass = 9;
    private const int WtsConnectState = 8;

    // 属性の読み取りだけで開く。内容にはアクセスしない。
    public static PathProbeResult ProbePath(string path, bool openReparsePoint) {
      PathProbeResult result = new PathProbeResult();
      uint flags = FlagBackupSemantics;
      if (openReparsePoint) { flags |= FlagOpenReparsePoint; }
      IntPtr handle = Api.CreateFileW(path, FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
      if (handle == Invalid) {
        result.Error = Marshal.GetLastWin32Error();
        return result;
      }
      try {
        FileAttributeTagInfo info;
        if (!Api.GetFileInformationByHandleEx(handle, FileAttributeTagInfoClass, out info, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
          result.Error = Marshal.GetLastWin32Error();
          return result;
        }
        result.Attributes = info.FileAttributes;
        result.ReparseTag = info.ReparseTag;
        uint capacity = 1024;
        for (int attempt = 0; attempt < 2; attempt++) {
          StringBuilder buffer = new StringBuilder((int)capacity);
          uint length = Api.GetFinalPathNameByHandleW(handle, buffer, capacity, 0);
          if (length == 0) {
            result.Error = Marshal.GetLastWin32Error();
            return result;
          }
          if (length < capacity) {
            result.FinalPath = buffer.ToString();
            return result;
          }
          capacity = length + 1;
        }
        result.Error = 122;
        return result;
      } finally {
        Api.CloseHandle(handle);
      }
    }

    // 失敗時は -1。
    public static int QueryConnectState(int sessionId) {
      IntPtr buffer;
      uint bytes;
      if (!Api.WTSQuerySessionInformationW(IntPtr.Zero, sessionId, WtsConnectState, out buffer, out bytes)) {
        return -1;
      }
      try {
        if (bytes < 4) { return -1; }
        return Marshal.ReadInt32(buffer);
      } finally {
        Api.WTSFreeMemory(buffer);
      }
    }

    public static string GetKnownFolder(Guid id) {
      IntPtr path;
      int hr = Api.SHGetKnownFolderPath(id, 0, IntPtr.Zero, out path);
      if (hr != 0) { return null; }
      try {
        return Marshal.PtrToStringUni(path);
      } finally {
        Marshal.FreeCoTaskMem(path);
      }
    }
  }
}
'@

function Initialize-NativeInterop {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'このヘルパーは Windows 専用です。' }
  if ($null -eq ('AIHelpDesk.FolderHelper.Native' -as [type])) {
    Add-Type -TypeDefinition $script:NativeSource -Language CSharp
  }
}

function Invoke-NativeProbe {
  param([Parameter(Mandatory)][string]$Path, [bool]$OpenReparsePoint)
  return [AIHelpDesk.FolderHelper.Native]::ProbePath($Path, $OpenReparsePoint)
}

function New-NativeDirectoryHandle {
  param([Parameter(Mandatory)][string]$Path)
  return (New-Object AIHelpDesk.FolderHelper.DirectoryHandle -ArgumentList $Path)
}

function Get-CurrentIdentityInfo {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
  return @{
    Sid             = $identity.User.Value
    Name            = $identity.Name
    IsAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
}

function Get-SessionInfo {
  $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $state = [AIHelpDesk.FolderHelper.Native]::QueryConnectState($sessionId)
  return @{ SessionId = $sessionId; SessionState = (ConvertTo-SessionStateName -State $state) }
}

function Open-LocalMachine64Key {
  param([Parameter(Mandatory)][string]$SubKey)
  $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  return $hklm.OpenSubKey($SubKey, $false)
}

function Get-MachineGuidValue {
  $key = Open-LocalMachine64Key -SubKey 'SOFTWARE\Microsoft\Cryptography'
  if ($null -eq $key) { return $null }
  try { return [string]$key.GetValue('MachineGuid') } finally { $key.Dispose() }
}

function Get-RegistryPathNoExpand {
  # 環境変数を展開しない。% を含む値は信用せず $null にする。
  param([AllowNull()][object]$Key, [Parameter(Mandatory)][string]$Name)
  if ($null -eq $Key) { return $null }
  $value = $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($value -isnot [string] -or $value.IndexOf('%') -ge 0) { return $null }
  return $value
}

function Get-ProfileImagePathForSid {
  param([Parameter(Mandatory)][string]$Sid)
  if ($Sid -cnotmatch '^S-1-\d+(-\d+)+$') { return $null }
  $key = Open-LocalMachine64Key -SubKey ('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid)
  if ($null -eq $key) { return $null }
  try { return (Get-RegistryPathNoExpand -Key $key -Name 'ProfileImagePath') } finally { $key.Dispose() }
}

function Test-OneDriveAccountName {
  # HKCU\Software\Microsoft\OneDrive\Accounts の配下で見る名前。
  param([AllowNull()][string]$Name)
  return ($Name -match '^(Business[0-9]{0,3}|Personal)$')
}

function Get-OneDriveUserFolders {
  # 旧来の値と、アカウントごとの値（Accounts\Business*、Accounts\Personal）をすべて返す。
  # ここでは候補を集めるだけで、範囲として認めるかは Get-CloudScopes が判定する。
  $folders = New-Object System.Collections.Generic.List[string]
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\OneDrive', $false)
  if ($null -eq $key) { return @() }
  try {
    $legacy = Get-RegistryPathNoExpand -Key $key -Name 'UserFolder'
    if ($null -ne $legacy) { $folders.Add($legacy) }
    $accounts = $key.OpenSubKey('Accounts', $false)
    if ($null -ne $accounts) {
      try {
        foreach ($name in $accounts.GetSubKeyNames()) {
          if (-not (Test-OneDriveAccountName -Name $name)) { continue }
          $account = $accounts.OpenSubKey($name, $false)
          if ($null -eq $account) { continue }
          try {
            $value = Get-RegistryPathNoExpand -Key $account -Name 'UserFolder'
            if ($null -ne $value) { $folders.Add($value) }
          } finally {
            $account.Dispose()
          }
        }
      } finally {
        $accounts.Dispose()
      }
    }
  } finally {
    $key.Dispose()
  }
  return $folders.ToArray()
}

function Get-KnownFolderPath {
  # 環境変数を使わない。Downloads は SpecialFolder に無いので FOLDERID_Downloads を使う。
  param([Parameter(Mandatory)][string]$Root)
  if ($Root -ceq 'Desktop') { return [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory) }
  if ($Root -ceq 'Documents') { return [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments) }
  if ($Root -ceq 'Pictures') { return [Environment]::GetFolderPath([Environment+SpecialFolder]::MyPictures) }
  if ($Root -ceq 'Music') { return [Environment]::GetFolderPath([Environment+SpecialFolder]::MyMusic) }
  if ($Root -ceq 'Videos') { return [Environment]::GetFolderPath([Environment+SpecialFolder]::MyVideos) }
  if ($Root -ceq 'Downloads') {
    return [AIHelpDesk.FolderHelper.Native]::GetKnownFolder([Guid]'374DE290-123F-4565-9164-39C4925E467B')
  }
  return $null
}

function Get-StateDirectory {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrEmpty($localAppData)) { throw 'LocalApplicationData を取得できません。' }
  return ($localAppData.TrimEnd('\') + '\AIHelpDesk\folder-helper')
}

function Initialize-StateDirectory {
  # 本人のみの ACL にしてから秘密を書く。リンク先や他人所有のフォルダは使わない。
  param([Parameter(Mandatory)][string]$Sid)
  $dir = Get-StateDirectory
  $parent = Split-Path -Parent $dir
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $info = New-Object IO.DirectoryInfo -ArgumentList $dir
  if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '状態フォルダがリンクです。' }
  $parentInfo = New-Object IO.DirectoryInfo -ArgumentList $parent
  if (($parentInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '状態フォルダの親がリンクです。' }

  $me = New-Object Security.Principal.SecurityIdentifier -ArgumentList $Sid
  $current = $info.GetAccessControl()
  if ($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid) { throw '状態フォルダの所有者が本人ではありません。' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList @(
    $me,
    [Security.AccessControl.FileSystemRights]::FullControl,
    ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  $info.SetAccessControl($acl)

  $verify = $info.GetAccessControl()
  if (-not $verify.AreAccessRulesProtected) { throw '状態フォルダの ACL を保護できません。' }
  foreach ($entry in $verify.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($entry.IdentityReference.Value -cne $Sid) { throw '状態フォルダの ACL に本人以外が残っています。' }
  }
  return $dir
}

function Get-StatePath {
  param([Parameter(Mandatory)][ValidateSet('token.dat', 'report-token.dat', 'config.json', 'pairing-code.txt', 'helper.log', 'revoked.flag')][string]$Name)
  return [IO.Path]::Combine((Get-StateDirectory), $Name)
}

function Save-HelperToken {
  param([Parameter(Mandatory)][string]$HelperId, [Parameter(Mandatory)][string]$HelperToken)
  Add-Type -AssemblyName System.Security
  $plain = [Text.Encoding]::UTF8.GetBytes((ConvertTo-HelperJson -Value ([ordered]@{ helperId = $HelperId; helperToken = $HelperToken })))
  $sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Get-StatePath -Name 'token.dat'), $sealed)
}

function Read-HelperToken {
  # 無い・復号できない場合は $null。report-token.dat は Invoke-ReportOnlyFlush だけが読む（poll / start に使わない）。
  param([ValidateSet('token.dat', 'report-token.dat')][string]$Name = 'token.dat')
  $path = Get-StatePath -Name $Name
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    Add-Type -AssemblyName System.Security
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $parsed = ConvertFrom-HelperJson -Json ([Text.Encoding]::UTF8.GetString($plain))
    if ($parsed.helperToken -isnot [string] -or $parsed.helperToken.Length -eq 0) { return $null }
    return $parsed
  } catch {
    return $null
  }
}

function Remove-StateFile {
  param([Parameter(Mandatory)][string]$Name)
  $path = Get-StatePath -Name $Name
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Write-HelperLog {
  param([Parameter(Mandatory)][string]$EventName, [hashtable]$Fields = @{})
  try {
    $path = Get-StatePath -Name 'helper.log'
    if ((Test-Path -LiteralPath $path) -and (New-Object IO.FileInfo -ArgumentList $path).Length -gt $script:MaxLogBytes) {
      Remove-Item -LiteralPath $path -Force
    }
    $line = (Get-Date).ToUniversalTime().ToString('o') + ' ' + (Format-HelperLogLine -EventName $EventName -Fields $Fields)
    Add-Content -LiteralPath $path -Value $line -Encoding UTF8
  } catch {
    # ログの失敗で動作を変えない。
    $null = $_
  }
}

function Get-ExceptionTypeName {
  # 例外メッセージはパスを含み得るので型名だけを扱う。
  param([Parameter(Mandatory)][object]$ErrorRecord)
  $ex = $ErrorRecord.Exception
  while ($null -ne $ex.InnerException) { $ex = $ex.InnerException }
  return $ex.GetType().Name
}

function Read-HttpResponseBody {
  param([Parameter(Mandatory)][object]$Response)
  $stream = $Response.GetResponseStream()
  try {
    $memory = New-Object IO.MemoryStream
    $buffer = New-Object byte[] 8192
    while ($true) {
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      if (($memory.Length + $read) -gt $script:MaxResponseBytes) { throw '応答が大きすぎます。' }
      $memory.Write($buffer, 0, $read)
    }
    # Invoke-RestMethod は charset 無しの応答を ISO-8859-1 で読むことがあり署名が一致しなくなる。
    return [Text.Encoding]::UTF8.GetString($memory.ToArray())
  } finally {
    $stream.Dispose()
  }
}

function Invoke-HelperHttp {
  # リダイレクトを辿らない（トークンを別ホストへ送らない）。例外は投げず Status=0 を返す。
  param(
    [Parameter(Mandatory)][string]$Url,
    [AllowNull()][string]$Token,
    [Parameter(Mandatory)][string]$BodyJson,
    [int]$TimeoutSec = 30
  )
  $result = @{ Status = 0; Body = ''; RetryAfter = 0; ErrorType = $null }
  $response = $null
  try {
    $request = [Net.WebRequest]::Create($Url)
    $request.Method = 'POST'
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Accept = 'application/json'
    $request.UserAgent = 'AIHelpDesk-FolderHelper/' + $script:HelperVersion
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutSec * 1000
    $request.ReadWriteTimeout = $TimeoutSec * 1000
    if (-not [string]::IsNullOrEmpty($Token)) { $request.Headers['x-folder-helper-token'] = $Token }
    $payload = [Text.Encoding]::UTF8.GetBytes($BodyJson)
    $request.ContentLength = $payload.Length
    $out = $request.GetRequestStream()
    try { $out.Write($payload, 0, $payload.Length) } finally { $out.Dispose() }
    try {
      $response = $request.GetResponse()
    } catch {
      $inner = $_.Exception
      while ($null -ne $inner -and $inner -isnot [Net.WebException]) { $inner = $inner.InnerException }
      if ($null -eq $inner -or $null -eq $inner.Response) { throw }
      $response = $inner.Response
    }
    $result.Status = [int]$response.StatusCode
    $retry = 0
    if ([int]::TryParse([string]$response.Headers['Retry-After'], [ref]$retry)) { $result.RetryAfter = $retry }
    $result.Body = Read-HttpResponseBody -Response $response
  } catch {
    $result.Status = 0
    $result.ErrorType = Get-ExceptionTypeName -ErrorRecord $_
  } finally {
    if ($null -ne $response) { $response.Dispose() }
  }
  return $result
}

function Show-PairingCode {
  param([Parameter(Mandatory)][string]$Code, [AllowNull()][string]$ExpiresAt, [bool]$InBackground)
  if ($InBackground) {
    # 非対話時だけ本人のみの状態フォルダへ書く。ペア後または期限切れで削除する。
    [IO.File]::WriteAllLines((Get-StatePath -Name 'pairing-code.txt'), [string[]]@($Code, [string]$ExpiresAt), (New-Object Text.UTF8Encoding -ArgumentList $false))
    return
  }
  Write-Host ''
  Write-Host ('  ペアリングコード: ' + $Code)
  if ($ExpiresAt) { Write-Host ('  有効期限: ' + $ExpiresAt) }
  Write-Host '  HelpDesk の画面（本人としてログイン）でこのコードを入力し、端末名とユーザーを確認してください。'
  Write-Host ''
}

function Clear-PairingCodeIfDone {
  param([bool]$Paired)
  $path = Get-StatePath -Name 'pairing-code.txt'
  if (-not (Test-Path -LiteralPath $path)) { return }
  $expired = $true
  try {
    $lines = [IO.File]::ReadAllLines($path)
    if ($lines.Length -ge 2) {
      $expires = ConvertFrom-IsoUtc -Value $lines[1]
      if ($null -ne $expires) { $expired = ($expires -le [DateTimeOffset]::UtcNow) }
    }
  } catch {
    $expired = $true
  }
  if ($Paired -or $expired) { Remove-StateFile -Name 'pairing-code.txt' }
}

function Invoke-HelperRegistration {
  # 導入コードはこのリクエストの本文にだけ入れる。ログ・状態ファイル・タスクの引数へ残さない。
  param(
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][hashtable]$Identity,
    [Parameter(Mandatory)][string]$EnrollCode,
    [bool]$InBackground
  )
  $session = Get-SessionInfo
  $machineGuid = Get-MachineGuidValue
  if ([string]::IsNullOrEmpty($machineGuid)) { throw 'MachineGuid を取得できません。' }
  $body = ConvertTo-HelperJson -Value ([ordered]@{
      machineGuid   = $machineGuid
      sid           = $Identity.Sid
      userName      = $Identity.Name
      sessionId     = [int]$session.SessionId
      sessionState  = $session.SessionState
      hostname      = [Environment]::MachineName
      helperVersion = $script:HelperVersion
      enrollCode    = $EnrollCode
    })
  $response = Invoke-HelperHttp -Url (Get-HelperApiUrl -ServerBase $ServerBase -Action 'register') -Token $null -BodyJson $body
  if ($response.Status -lt 200 -or $response.Status -ge 300) {
    Write-HelperLog -EventName 'register_failed' -Fields @{ httpStatus = $response.Status; errorType = $response.ErrorType }
    return @{ Ok = $false; RetryAfter = $response.RetryAfter; EnrollRejected = (Test-EnrollCodeRejected -Status $response.Status -Body $response.Body) }
  }
  $parsed = ConvertFrom-HelperJson -Json $response.Body
  $helperId = [string](Get-OpField -Op $parsed -Name 'helperId')
  $helperToken = Get-OpField -Op $parsed -Name 'helperToken'
  $pairingCode = Get-OpField -Op $parsed -Name 'pairingCode'
  if ($helperToken -isnot [string] -or $helperToken.Length -eq 0 -or $pairingCode -isnot [string] -or $pairingCode.Length -eq 0) {
    Write-HelperLog -EventName 'register_bad_response'
    return @{ Ok = $false; RetryAfter = 0; EnrollRejected = $false }
  }
  # runs に残った記録は旧トークンの実行。新しいトークンで報告しない。
  Set-UnsentRunsAbandoned
  Save-HelperToken -HelperId $helperId -HelperToken $helperToken
  Show-PairingCode -Code $pairingCode -ExpiresAt ([string](Get-OpField -Op $parsed -Name 'pairingExpiresAt')) -InBackground $InBackground
  Write-HelperLog -EventName 'registered'
  return @{ Ok = $true; RetryAfter = 0; EnrollRejected = $false }
}

function Invoke-HelperPoll {
  # 1 回ポーリングして $State を更新する。Status と RetryAfter を返す。
  param(
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Identity,
    [Parameter(Mandatory)][hashtable]$State,
    [int]$TimeoutSec = 30
  )
  $session = Get-SessionInfo
  if (-not (Test-SessionStateReportable -State $session.SessionState)) {
    return @{ Ok = $false; Status = 0; RetryAfter = 0; ErrorType = 'SessionStateNotReportable' }
  }
  $body = New-PollBodyJson -Sid $Identity.Sid -SessionId ([int]$session.SessionId) -SessionState $session.SessionState
  $response = Invoke-HelperHttp -Url (Get-HelperApiUrl -ServerBase $ServerBase -Action 'poll') -Token $Token -BodyJson $body -TimeoutSec $TimeoutSec
  if ($response.Status -ge 200 -and $response.Status -lt 300) {
    try {
      Update-PollState -State $State -Response (ConvertFrom-HelperJson -Json $response.Body)
    } catch {
      return @{ Ok = $false; Status = $response.Status; RetryAfter = 0; ErrorType = 'BadPollBody' }
    }
    return @{ Ok = $true; Status = $response.Status; RetryAfter = 0; ErrorType = $null }
  }
  return @{ Ok = $false; Status = $response.Status; RetryAfter = $response.RetryAfter; ErrorType = $response.ErrorType }
}

function Send-OpResult {
  param(
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$OpId,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Body
  )
  $url = Get-HelperApiUrl -ServerBase $ServerBase -Action ('ops/' + [Uri]::EscapeDataString($OpId) + '/result')
  return (Invoke-HelperHttp -Url $url -Token $Token -BodyJson (ConvertTo-HelperJson -Value $Body))
}

function Invoke-HelperOperation {
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Identity,
    [Parameter(Mandatory)][hashtable]$State
  )
  $opId = [string]$Op.opId
  if ($State.Cancelled.Contains($opId)) {
    Write-HelperLog -EventName 'op_cancelled' -Fields @{ opId = $opId }
    return
  }
  # skill_run だけ別経路。list_metadata と未知の種別は従来どおり Get-OpRefusal が扱う。
  $operationField = Get-OpField -Op $Op -Name 'operation'
  if ($operationField -is [string] -and $operationField -ceq 'skill_run') {
    Invoke-SkillRunOperation -Op $Op -ServerBase $ServerBase -Token $Token -Identity $Identity -State $State
    return
  }
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $session = Get-SessionInfo
  $live = Get-CurrentIdentityInfo
  $context = @{
    Sid          = $live.Sid
    SessionId    = $session.SessionId
    SessionState = $session.SessionState
    NowUtc       = [DateTimeOffset]::UtcNow
    IsElevated   = $live.IsAdministrator
  }
  $rootField = Get-OpField -Op $Op -Name 'root'
  $rootText = if ($rootField -is [string] -and (Test-AllowedRoot -Root $rootField)) { $rootField } else { '' }

  $refusal = Get-OpRefusal -Op $Op -Token $Token -Context $context
  if ($null -ne $refusal) {
    $body = New-ResultBody -ActorSid $live.Sid -SessionId ([int]$session.SessionId) -Root $rootText -Status 'error' -Reason $refusal -Truncated $false -ElapsedMs $stopwatch.ElapsedMilliseconds -Entries @()
    $sent = Send-OpResult -ServerBase $ServerBase -Token $Token -OpId $opId -Body $body
    Write-HelperLog -EventName 'op_refused' -Fields @{ opId = $opId; reason = $refusal; httpStatus = $sent.Status }
    return
  }

  # GetNewClosure は使わない。動的モジュールに束縛され、-File 実行時のスクリプトスコープの関数が
  # 見えなくなる。scriptblock は呼び出し元のスコープを動的に参照するので、衝突しない名前で渡す。
  $helperOpRuntime = @{
    ServerBase = $ServerBase
    Token      = $Token
    Identity   = $Identity
    State      = $State
    OpId       = $opId
    Sid        = $live.Sid
    Stopwatch  = $stopwatch
    ExpiresAt  = (ConvertFrom-IsoUtc -Value $Op.expiresAt)
  }
  $checkCancel = {
    $null = Invoke-HelperPoll -ServerBase $helperOpRuntime.ServerBase -Token $helperOpRuntime.Token -Identity $helperOpRuntime.Identity -State $helperOpRuntime.State -TimeoutSec 5
    return ($helperOpRuntime.State.Revoked -or $helperOpRuntime.State.Cancelled.Contains($helperOpRuntime.OpId))
  }
  $deps = @{
    Probe           = { param($path, $openReparse) Invoke-NativeProbe -Path $path -OpenReparsePoint ([bool]$openReparse) }
    OpenDirectory   = { param($path) New-NativeDirectoryHandle -Path $path }
    GetKnownFolder  = { param($root) Get-KnownFolderPath -Root $root }
    GetProfilePath  = { Get-ProfileImagePathForSid -Sid $helperOpRuntime.Sid }
    GetOneDrivePath = { Get-OneDriveUserFolders }
    ElapsedMs       = { $helperOpRuntime.Stopwatch.ElapsedMilliseconds }
    ShouldCancel    = $checkCancel
    IsExpired       = { $helperOpRuntime.ExpiresAt -le [DateTimeOffset]::UtcNow }
  }

  try {
    $outcome = Invoke-ListOperation -Op $Op -Deps $deps
  } catch {
    # 例外メッセージはパスを含み得るので送らない。
    Write-HelperLog -EventName 'op_exception' -Fields @{ opId = $opId; errorType = (Get-ExceptionTypeName -ErrorRecord $_) }
    $outcome = @{ Status = 'error'; Reason = 'INTERNAL_ERROR'; Truncated = $false; Entries = @(); Discard = $false; ElapsedMs = $stopwatch.ElapsedMilliseconds }
  }
  if ($outcome.Discard) {
    Write-HelperLog -EventName 'op_cancelled' -Fields @{ opId = $opId }
    return
  }
  # 送信の直前にもう一度 cancel を確認する。
  if (& $checkCancel) {
    Write-HelperLog -EventName 'op_cancelled' -Fields @{ opId = $opId }
    return
  }
  $body = New-ResultBody -ActorSid $live.Sid -SessionId ([int]$session.SessionId) -Root $rootText -Status $outcome.Status -Reason $outcome.Reason -Truncated $outcome.Truncated -ElapsedMs $outcome.ElapsedMs -Entries @($outcome.Entries)
  $sent = Send-OpResult -ServerBase $ServerBase -Token $Token -OpId $opId -Body $body
  Write-HelperLog -EventName 'op_done' -Fields @{ opId = $opId; status = $outcome.Status; reason = $outcome.Reason; count = @($outcome.Entries).Count; truncated = $outcome.Truncated; elapsedMs = $outcome.ElapsedMs; httpStatus = $sent.Status; errorType = $sent.ErrorType }
}

function Get-SkillsDirectory { return ((Get-StateDirectory) + '\skills') }
function Get-RunsDirectory { return ((Get-StateDirectory) + '\runs') }

function Get-ReportRunsDirectory { return [IO.Path]::Combine((Get-StateDirectory), 'report-runs') }

function Get-RunStoreDirectory {
  # runs は token.dat の実行、report-runs は report-token.dat の実行。混ぜない（別トークンで報告するとサーバは 404 を返す）。
  param([ValidateSet('runs', 'report-runs')][string]$Store = 'runs')
  if ($Store -ceq 'report-runs') { return (Get-ReportRunsDirectory) }
  return (Get-RunsDirectory)
}

function Get-RunFilePath {
  param(
    [Parameter(Mandatory)][string]$OpId,
    [Parameter(Mandatory)][ValidateSet('run', 'res', 'sent', 'expired', 'rejected', 'abandoned')][string]$Kind,
    [ValidateSet('runs', 'report-runs')][string]$Store = 'runs'
  )
  if (-not (Test-SafeOpId -OpId $OpId)) { throw 'opId が不正です。' }
  return [IO.Path]::Combine((Get-RunStoreDirectory -Store $Store), ($OpId + '.' + $Kind))
}

function Initialize-RunsDirectory {
  # 親の ACL（本人のみ）を継承する。リンクなら使わない。
  $dir = Get-RunsDirectory
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $info = New-Object IO.DirectoryInfo -ArgumentList $dir
  if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '実行記録フォルダがリンクです。' }
  return $dir
}

function Write-RunRecord {
  # CreateNew で書く。既にあれば失敗（同じ op を 2 回起動しない）。
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][string]$Effect, [Parameter(Mandatory)][string]$StartedAt)
  try {
    $null = Initialize-RunsDirectory
    $bytes = [Text.Encoding]::UTF8.GetBytes((New-RunRecordJson -Op $Op -Effect $Effect -StartedAt $StartedAt))
    $stream = New-Object IO.FileStream -ArgumentList @((Get-RunFilePath -OpId ([string]$Op.opId) -Kind 'run'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    return $true
  } catch {
    return $false
  }
}

function Save-RunResult {
  param([Parameter(Mandatory)][string]$OpId, [Parameter(Mandatory)][string]$Json)
  [IO.File]::WriteAllText((Get-RunFilePath -OpId $OpId -Kind 'res'), $Json, (New-Object Text.UTF8Encoding -ArgumentList $false))
}

function Set-RunState {
  # 終端の状態ファイルを置く。sent（報告済み）と expired（410）を区別して残す。
  param(
    [Parameter(Mandatory)][string]$OpId,
    [Parameter(Mandatory)][ValidateSet('sent', 'expired', 'rejected', 'abandoned')][string]$Kind,
    [ValidateSet('runs', 'report-runs')][string]$Store = 'runs'
  )
  [IO.File]::WriteAllText((Get-RunFilePath -OpId $OpId -Kind $Kind -Store $Store), $Kind)
  if ($Kind -cne 'sent') { Write-HelperLog -EventName ('report_' + $Kind) -Fields @{ opId = $OpId } }
}

function Get-UnsentRunIds {
  param([ValidateSet('runs', 'report-runs')][string]$Store = 'runs')
  $dir = Get-RunStoreDirectory -Store $Store
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  $ids = New-Object System.Collections.Generic.List[string]
  foreach ($file in [IO.Directory]::GetFiles($dir, '*.run')) {
    $name = [IO.Path]::GetFileNameWithoutExtension($file)
    if (-not (Test-SafeOpId -OpId $name)) { continue }
    $closed = $false
    foreach ($kind in 'sent', 'expired', 'rejected', 'abandoned') {
      if (Test-Path -LiteralPath (Get-RunFilePath -OpId $name -Kind $kind -Store $Store)) { $closed = $true }
    }
    if (-not $closed) { $ids.Add($name) }
  }
  # 呼び出し側は @() で受ける。配列のまま 1 要素として返さない。
  return $ids.ToArray()
}

function Read-RunReport {
  param([Parameter(Mandatory)][string]$OpId, [Parameter(Mandatory)][hashtable]$Identity, [ValidateSet('runs', 'report-runs')][string]$Store = 'runs')
  $resultPath = Get-RunFilePath -OpId $OpId -Kind 'res' -Store $Store
  $resultJson = $null
  if (Test-Path -LiteralPath $resultPath) { $resultJson = [IO.File]::ReadAllText($resultPath, [Text.Encoding]::UTF8) }
  $recordJson = [IO.File]::ReadAllText((Get-RunFilePath -OpId $OpId -Kind 'run' -Store $Store), [Text.Encoding]::UTF8)
  $session = Get-SessionInfo
  $now = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
  return (Get-RunReportJson -RecordJson $recordJson -ResultJson $resultJson -ActorSid $Identity.Sid -SessionId ([int]$session.SessionId) -NowIso $now)
}

function Set-UnsentRunsAbandoned {
  # 報告に使えるトークンが無い記録。新しいトークンで送らない（サーバは 404 を返し、誤って確定扱いになる）。
  param([ValidateSet('runs', 'report-runs')][string]$Store = 'runs')
  foreach ($id in @(Get-UnsentRunIds -Store $Store)) { Set-RunState -OpId $id -Kind 'abandoned' -Store $Store }
}

function Move-RevokedTokenToReportStore {
  # 失効後の引き渡し。未報告があれば token.dat を report-token.dat へ、未報告の記録を report-runs へ移して token.dat を消す。
  # 途中で落ちても token.dat を最後に消すので、次回に同じ手順をやり直せる。
  $tokenPath = Get-StatePath -Name 'token.dat'
  $reportPath = Get-StatePath -Name 'report-token.dat'
  $unsent = @(Get-UnsentRunIds)
  if ($unsent.Count -eq 0) {
    Remove-StateFile -Name 'token.dat'
    return 'none'
  }
  if (-not (Test-Path -LiteralPath $tokenPath)) {
    Set-UnsentRunsAbandoned
    return 'abandoned'
  }
  $tokenBytes = [IO.File]::ReadAllBytes($tokenPath)
  $sameToken = $false
  if (Test-Path -LiteralPath $reportPath) {
    $sameToken = ([Convert]::ToBase64String($tokenBytes) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($reportPath)))
    if (-not $sameToken) {
      # 報告専用の枠は 1 つ。前回分が残っていれば諦めて記録する（サーバは結果なしを期限切れとして扱う）。
      Set-UnsentRunsAbandoned -Store 'report-runs'
      Remove-StateFile -Name 'report-token.dat'
    }
  }
  if (-not $sameToken) { [IO.File]::WriteAllBytes($reportPath, $tokenBytes) }
  $reportDir = Get-ReportRunsDirectory
  if (-not (Test-Path -LiteralPath $reportDir)) { New-Item -ItemType Directory -Path $reportDir | Out-Null }
  $reportInfo = New-Object IO.DirectoryInfo -ArgumentList $reportDir
  if (($reportInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '報告専用フォルダがリンクです。' }
  foreach ($id in $unsent) {
    foreach ($kind in 'res', 'run') {
      $from = Get-RunFilePath -OpId $id -Kind $kind
      if (-not (Test-Path -LiteralPath $from)) { continue }
      $to = Get-RunFilePath -OpId $id -Kind $kind -Store 'report-runs'
      if (Test-Path -LiteralPath $to) { [IO.File]::Delete($from) } else { [IO.File]::Move($from, $to) }
    }
  }
  Remove-StateFile -Name 'token.dat'
  Write-HelperLog -EventName 'report_token_moved' -Fields @{ count = $unsent.Count }
  return 'moved'
}

function Invoke-ReportOnlyFlush {
  # 報告専用トークンで旧結果の報告だけを試みる。poll も /start もしない。
  # 再送で期限は延びない。未報告が無くなればトークンを消す。
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][hashtable]$Identity)
  if (-not (Test-Path -LiteralPath (Get-StatePath -Name 'report-token.dat'))) { return }
  $reportToken = Read-HelperToken -Name 'report-token.dat'
  if ($null -eq $reportToken) {
    Set-UnsentRunsAbandoned -Store 'report-runs'
    Remove-StateFile -Name 'report-token.dat'
    Write-HelperLog -EventName 'report_token_removed' -Fields @{ reason = 'UNREADABLE' }
    return
  }
  $helperReportRuntime = @{ ServerBase = $ServerBase; Token = [string]$reportToken.helperToken; Identity = $Identity }
  Invoke-RunReportFlush -ReportOnly $true -Deps @{
    ListUnsent = { Get-UnsentRunIds -Store 'report-runs' }
    ReadReport = { param($id) Read-RunReport -OpId $id -Identity $helperReportRuntime.Identity -Store 'report-runs' }
    SendReport = {
      param($id, $json)
      $sent = Send-SkillResultJson -ServerBase $helperReportRuntime.ServerBase -Token $helperReportRuntime.Token -OpId $id -Json $json
      Write-HelperLog -EventName 'report_only_send' -Fields @{ opId = $id; httpStatus = $sent.Status; errorType = $sent.ErrorType }
      $sent
    }
    MarkSent   = { param($id, $disposition) Set-RunState -OpId $id -Kind $disposition -Store 'report-runs' }
  }
  if (@(Get-UnsentRunIds -Store 'report-runs').Count -eq 0) {
    Remove-StateFile -Name 'report-token.dat'
    Write-HelperLog -EventName 'report_token_removed'
  }
}

function Send-SkillResultJson {
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$OpId, [Parameter(Mandatory)][string]$Json)
  $url = Get-HelperApiUrl -ServerBase $ServerBase -Action ('ops/' + [Uri]::EscapeDataString($OpId) + '/skill-result')
  return (Invoke-HelperHttp -Url $url -Token $Token -BodyJson $Json)
}

function Invoke-PendingSkillReports {
  # 子が動いていないときだけ呼ぶ（op の処理の間）。
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][hashtable]$Identity)
  $helperFlushRuntime = @{ ServerBase = $ServerBase; Token = $Token; Identity = $Identity }
  Invoke-RunReportFlush -Deps @{
    ListUnsent = { Get-UnsentRunIds }
    ReadReport = { param($id) Read-RunReport -OpId $id -Identity $helperFlushRuntime.Identity }
    SendReport = {
      param($id, $json)
      $sent = Send-SkillResultJson -ServerBase $helperFlushRuntime.ServerBase -Token $helperFlushRuntime.Token -OpId $id -Json $json
      Write-HelperLog -EventName 'skill_report' -Fields @{ opId = $id; httpStatus = $sent.Status; errorType = $sent.ErrorType }
      $sent
    }
    MarkSent   = { param($id, $disposition) Set-RunState -OpId $id -Kind $disposition }
  }
}

function Open-SkillScript {
  # 読取共有で開いたままにする（書込・削除を共有しない）。ハッシュはこのハンドルから計算する。
  param([Parameter(Mandatory)][hashtable]$Definition)
  $dir = Get-SkillsDirectory
  $path = [IO.Path]::Combine($dir, [string]$Definition.File)
  foreach ($element in @($dir, $path)) {
    $probe = Invoke-NativeProbe -Path (ConvertTo-ExtendedPath -Path $element) -OpenReparsePoint $true
    if ($probe.Error -ne 0) { return @{ Reason = 'SCRIPT_MISSING'; Hash = $null; Handle = $null; Path = $null } }
    if (($probe.Attributes -band $script:AttrReparsePoint) -ne 0) { return @{ Reason = 'REPARSE_REJECTED'; Hash = $null; Handle = $null; Path = $null } }
  }
  $stream = $null
  try {
    $stream = New-Object IO.FileStream -ArgumentList @($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    return @{ Reason = $null; Hash = (Get-Sha256Prefixed -Stream $stream); Handle = $stream; Path = $path }
  } catch {
    if ($null -ne $stream) { $stream.Dispose() }
    return @{ Reason = 'SCRIPT_MISSING'; Hash = $null; Handle = $null; Path = $null }
  }
}

function Stop-SkillJobAndWait {
  # Job を終了し、中のプロセスが 0 になるのを確認する。確認できなければ $false。
  param([Parameter(Mandatory)][object]$Job)
  $requested = $Job.Terminate($script:SkillKillExitCode)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $script:SkillStopWaitMs) {
    if ($Job.ActiveProcesses() -eq 0) { return $requested }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Start-SkillChild {
  # 順序: 起動 → Job へ入れる → SID と整合性を確認 → stdin を渡す。Skill は stdin を読んでから動く。
  # ログオフ・切替・失敗で別の権限へ切り替えて再試行する経路は持たない。
  param([Parameter(Mandatory)][string]$ScriptPath, [Parameter(Mandatory)][string]$StdinJson, [Parameter(Mandatory)][string]$ExpectedSid, [Parameter(Mandatory)][int]$MaxOutputBytes)
  $job = New-Object AIHelpDesk.FolderHelper.SkillJob
  if (-not $job.IsValid) { return @{ Reason = 'JOB_CREATE_FAILED'; Runner = $null; StopOutcome = 'not_running'; ExitCode = $null } }
  $process = $null
  $keep = $false
  try {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments = New-SkillArguments -ScriptPath $ScriptPath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = [Environment]::SystemDirectory
    try {
      $process = [Diagnostics.Process]::Start($info)
    } catch {
      return @{ Reason = 'SPAWN_FAILED'; Runner = $null; StopOutcome = 'not_running'; ExitCode = $null }
    }
    $reason = $null
    if (-not $job.Assign($process.Handle) -or -not $job.Contains($process.Handle)) { $reason = 'JOB_ASSIGN_FAILED' }
    if ($null -eq $reason) {
      $reason = Get-ChildRefusal -ChildSid ([AIHelpDesk.FolderHelper.ProcessToken]::GetUserSid($process.Handle)) -ExpectedSid $ExpectedSid -ChildIntegrityRid ([AIHelpDesk.FolderHelper.ProcessToken]::GetIntegrityRid($process.Handle))
    }
    if ($null -ne $reason) {
      $stopped = $false
      if ($reason -ceq 'JOB_ASSIGN_FAILED') {
        try { $process.Kill(); $stopped = $process.WaitForExit($script:SkillStopWaitMs) } catch { $stopped = $process.HasExited }
      } else {
        $stopped = Stop-SkillJobAndWait -Job $job
      }
      $exitCode = $null
      if ($process.HasExited) { $exitCode = $process.ExitCode }
      return @{ Reason = $reason; Runner = $null; StopOutcome = $(if ($stopped) { 'stopped' } else { 'stop_failed' }); ExitCode = $exitCode }
    }
    $out = New-Object AIHelpDesk.FolderHelper.BoundedReader -ArgumentList @($process.StandardOutput.BaseStream, $MaxOutputBytes)
    $err = New-Object AIHelpDesk.FolderHelper.BoundedReader -ArgumentList @($process.StandardError.BaseStream, $script:SkillMaxStderrBytes)
    $out.Start()
    $err.Start()
    # 既定のエンコーディングと BOM を避けるためバイトで渡す。子が先に終わっていれば書込は失敗してよい。
    try {
      $bytes = (New-Object Text.UTF8Encoding -ArgumentList $false).GetBytes($StdinJson)
      $stdinStream = $process.StandardInput.BaseStream
      $stdinStream.Write($bytes, 0, $bytes.Length)
      $stdinStream.Flush()
    } catch [IO.IOException] {
      $null = $_
    } finally {
      try { $process.StandardInput.Close() } catch [IO.IOException] { $null = $_ }
    }
    $keep = $true
    return @{ Reason = $null; StopOutcome = $null; ExitCode = $null; Runner = @{ Process = $process; Job = $job; Out = $out; Err = $err } }
  } finally {
    if (-not $keep) {
      if ($null -ne $process) { $process.Dispose() }
      $job.Dispose()
    }
  }
}

function Stop-SkillChild {
  param([Parameter(Mandatory)][hashtable]$Runner)
  $stopped = Stop-SkillJobAndWait -Job $Runner.Job
  $exitCode = $null
  if ($Runner.Process.WaitForExit(1000)) { $exitCode = $Runner.Process.ExitCode }
  return @{ Stopped = $stopped; ExitCode = $exitCode }
}

function Complete-SkillChild {
  # 孫が残っていれば Job ごと終了してから出力を確定する（孫がパイプを持つと読取が終わらない）。
  param([Parameter(Mandatory)][hashtable]$Runner)
  $leftoverFailed = $false
  if ($Runner.Job.ActiveProcesses() -ne 0) { $leftoverFailed = -not (Stop-SkillJobAndWait -Job $Runner.Job) }
  $null = $Runner.Out.Join(2000)
  $null = $Runner.Err.Join(2000)
  $exitCode = $null
  if ($Runner.Process.WaitForExit(1000)) { $exitCode = $Runner.Process.ExitCode }
  return @{
    ExitCode           = $exitCode
    Stdout             = [Text.Encoding]::UTF8.GetString($Runner.Out.GetBytes())
    StdoutTruncated    = $Runner.Out.Truncated
    StderrBytes        = $Runner.Err.TotalBytes
    LeftoverStopFailed = $leftoverFailed
  }
}

function Get-CurrentIntegrityRid {
  return [AIHelpDesk.FolderHelper.ProcessToken]::GetIntegrityRid([Diagnostics.Process]::GetCurrentProcess().Handle)
}

function Invoke-SkillStartRequest {
  # 再送しない。応答なし・不正な応答では開始しない。
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$ActorSid,
    [Parameter(Mandatory)][int]$SessionId,
    [Parameter(Mandatory)][string]$MachineGuid
  )
  $body = ConvertTo-HelperJson -Value ([ordered]@{ actorSid = $ActorSid; sessionId = $SessionId; machineGuid = $MachineGuid; startNonce = [string]$Op.startNonce; scriptHash = [string]$Op.scriptHash })
  $url = Get-HelperApiUrl -ServerBase $ServerBase -Action ('ops/' + [Uri]::EscapeDataString([string]$Op.opId) + '/start')
  $response = Invoke-HelperHttp -Url $url -Token $Token -BodyJson $body
  return @{ Ok = (Test-StartResponse -Status $response.Status -Body $response.Body); Status = $response.Status }
}

function Invoke-SkillRunOperation {
  param(
    [Parameter(Mandatory)][object]$Op,
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Identity,
    [Parameter(Mandatory)][hashtable]$State
  )
  $opId = [string]$Op.opId
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $session = Get-SessionInfo
  $live = Get-CurrentIdentityInfo
  $context = @{
    Sid          = $live.Sid
    SessionId    = $session.SessionId
    SessionState = $session.SessionState
    NowUtc       = [DateTimeOffset]::UtcNow
    IsElevated   = $live.IsAdministrator
    IntegrityRid = (Get-CurrentIntegrityRid)
    MachineGuid  = (Get-MachineGuidValue)
  }
  $refusal = Get-SkillRunRefusal -Op $Op -Token $Token -Context $context
  if ($null -ne $refusal) {
    # 実行していないという申告。成功の証拠にならない。
    $outcome = New-SkillNotRunOutcome -Op $Op -ActorSid $live.Sid -SessionId ([int]$session.SessionId) -Status 'rejected' -ResultCode $refusal -ElapsedMs $stopwatch.ElapsedMilliseconds -Recorded $false
    $sent = Send-SkillResultJson -ServerBase $ServerBase -Token $Token -OpId $opId -Json $outcome.Json
    Write-HelperLog -EventName 'skill_refused' -Fields @{ opId = $opId; reason = $refusal; httpStatus = $sent.Status }
    return
  }

  $helperSkillRuntime = @{
    Op = $Op; ServerBase = $ServerBase; Token = $Token; Identity = $Identity; State = $State
    OpId = $opId; Sid = $live.Sid; SessionId = [int]$session.SessionId; Stopwatch = $stopwatch; MachineGuid = [string]$context.MachineGuid
  }
  $deps = @{
    RecordExists  = { param($id) Test-Path -LiteralPath (Get-RunFilePath -OpId $id -Kind 'run') }
    ResolveTarget = {
      param($theOp)
      $basePath = Get-KnownFolderPath -Root $theOp.targetRoot
      if ([string]::IsNullOrEmpty($basePath)) { return @{ Reason = 'OUT_OF_SCOPE'; TargetFinal = $null; RootFinal = $null } }
      Resolve-FolderTarget -BasePath $basePath -Segments @($theOp.targetSegments) -ProfilePath (Get-ProfileImagePathForSid -Sid $helperSkillRuntime.Sid) -OneDrivePath @(Get-OneDriveUserFolders) -Probe { param($path, $openReparse) Invoke-NativeProbe -Path $path -OpenReparsePoint ([bool]$openReparse) }
    }
    OpenScript    = { param($def) Open-SkillScript -Definition $def }
    PostStart     = { param($theOp) Invoke-SkillStartRequest -Op $theOp -ServerBase $helperSkillRuntime.ServerBase -Token $helperSkillRuntime.Token -ActorSid $helperSkillRuntime.Sid -SessionId $helperSkillRuntime.SessionId -MachineGuid $helperSkillRuntime.MachineGuid }
    WriteRecord   = { param($theOp, $effect, $startedAt) Write-RunRecord -Op $theOp -Effect $effect -StartedAt $startedAt }
    Launch        = { param($path, $stdin, $cap) Start-SkillChild -ScriptPath $path -StdinJson $stdin -ExpectedSid $helperSkillRuntime.Sid -MaxOutputBytes $cap }
    WaitExit      = { param($runner, $ms) $runner.Process.WaitForExit([int]$ms) }
    StopRunner    = { param($runner) Stop-SkillChild -Runner $runner }
    FinishRunner  = { param($runner) Complete-SkillChild -Runner $runner }
    DisposeRunner = { param($runner) $runner.Process.Dispose(); $runner.Job.Dispose() }
    Poll          = { Invoke-HelperPoll -ServerBase $helperSkillRuntime.ServerBase -Token $helperSkillRuntime.Token -Identity $helperSkillRuntime.Identity -State $helperSkillRuntime.State -TimeoutSec 5 }
    GetStopFlags  = {
      @{
        Revoked      = $helperSkillRuntime.State.Revoked
        Cancelled    = $helperSkillRuntime.State.Cancelled.Contains($helperSkillRuntime.OpId)
        SessionState = (Get-SessionInfo).SessionState
      }
    }
    ElapsedMs     = { $helperSkillRuntime.Stopwatch.ElapsedMilliseconds }
    NowIso        = { [DateTimeOffset]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture) }
  }

  try {
    $outcome = Invoke-SkillRun -Op $Op -Definition (Get-SkillDefinition -SkillId $Op.skillId) -ActorSid $live.Sid -SessionId ([int]$session.SessionId) -Deps $deps
  } catch {
    # 例外メッセージはパスを含み得るので送らない。記録があれば再送経路が INTERRUPTED を報告する。
    Write-HelperLog -EventName 'skill_exception' -Fields @{ opId = $opId; errorType = (Get-ExceptionTypeName -ErrorRecord $_) }
    if (-not (Test-Path -LiteralPath (Get-RunFilePath -OpId $opId -Kind 'run'))) {
      $outcome = New-SkillNotRunOutcome -Op $Op -ActorSid $live.Sid -SessionId ([int]$session.SessionId) -Status 'error' -ResultCode 'INTERNAL_ERROR' -ElapsedMs $stopwatch.ElapsedMilliseconds -Recorded $false
    } else {
      $outcome = @{ Action = 'interrupted'; Json = $null; Recorded = $true }
    }
  }
  Write-HelperLog -EventName 'skill_done' -Fields @{ opId = $opId; status = $outcome.Action; elapsedMs = $stopwatch.ElapsedMilliseconds }
  if ($null -ne $outcome.Json) {
    if ($outcome.Recorded) {
      Save-RunResult -OpId $opId -Json $outcome.Json
    } else {
      $sent = Send-SkillResultJson -ServerBase $ServerBase -Token $Token -OpId $opId -Json $outcome.Json
      Write-HelperLog -EventName 'skill_report' -Fields @{ opId = $opId; httpStatus = $sent.Status; errorType = $sent.ErrorType }
    }
  }
  # kill の後に報告する。トークン削除は呼び出し側の Complete-HelperRevocation が報告の後で行う。
  Invoke-PendingSkillReports -ServerBase $ServerBase -Token $Token -Identity $Identity
}

function Read-HelperConfig {
  $path = Get-StatePath -Name 'config.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (ConvertFrom-HelperJson -Json ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)))
}

function Write-HelperConfig {
  param([Parameter(Mandatory)][string]$ServerBase, [bool]$AllowInsecure)
  $json = ConvertTo-HelperJson -Value ([ordered]@{ serverUrl = $ServerBase; allowInsecureHttp = $AllowInsecure })
  [IO.File]::WriteAllText((Get-StatePath -Name 'config.json'), $json, (New-Object Text.UTF8Encoding -ArgumentList $false))
}

function Invoke-HelperRevocationFlush {
  # 失効後の報告とトークン削除。未報告が残れば報告専用へ移して $false（次回の起動で報告専用トークンで再送する）。
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][hashtable]$Identity, [int]$MaxAttempts = 5)
  $helperRevokeRuntime = @{ ServerBase = $ServerBase; Token = $Token; Identity = $Identity }
  return (Complete-HelperRevocation -Deps @{
      Flush        = { Invoke-PendingSkillReports -ServerBase $helperRevokeRuntime.ServerBase -Token $helperRevokeRuntime.Token -Identity $helperRevokeRuntime.Identity }
      OnFlushError = { param($e) Write-HelperLog -EventName 'report_failed' -Fields @{ errorType = (Get-ExceptionTypeName -ErrorRecord $e) } }
      ListUnsent   = { Get-UnsentRunIds }
      RemoveToken  = { Remove-StateFile -Name 'token.dat' }
      Wait         = { param($attempt) Start-Sleep -Seconds ([Math]::Min(30, 5 * $attempt)) }
      HandOff      = { $null = Move-RevokedTokenToReportStore }
    } -MaxAttempts $MaxAttempts)
}

function Invoke-ReportOnlyFlushSafe {
  # 報告の失敗で常駐を止めない。
  param([Parameter(Mandatory)][string]$ServerBase, [Parameter(Mandatory)][hashtable]$Identity)
  try {
    Invoke-ReportOnlyFlush -ServerBase $ServerBase -Identity $Identity
  } catch {
    Write-HelperLog -EventName 'report_failed' -Fields @{ errorType = (Get-ExceptionTypeName -ErrorRecord $_) }
  }
}

function Invoke-HelperMain {
  # 終了コード: 0 = 正常終了（失効など）、2 = 起動条件を満たさない、3 = 設定不備
  $languageMode = [string]$ExecutionContext.SessionState.LanguageMode
  if ($languageMode -cne 'FullLanguage') { return 2 }
  try { Initialize-NativeInterop } catch { return 2 }

  $identity = Get-CurrentIdentityInfo
  $refusal = Get-StartupRefusal -Sid $identity.Sid -IsAdministrator $identity.IsAdministrator -LanguageMode $languageMode
  if ($null -ne $refusal) {
    if (-not $Background) { Write-Host ('起動しません: ' + $refusal) }
    return 2
  }
  $null = Initialize-StateDirectory -Sid $identity.Sid
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $serverBase = $ServerUrl
  $allowInsecure = [bool]$AllowInsecureHttp
  if ([string]::IsNullOrEmpty($serverBase)) {
    $config = Read-HelperConfig
    if ($null -ne $config) {
      $serverBase = [string](Get-OpField -Op $config -Name 'serverUrl')
      $allowInsecure = ((Get-OpField -Op $config -Name 'allowInsecureHttp') -eq $true)
    }
  }
  if (-not (Test-ServerUrl -Url $serverBase -AllowInsecure $allowInsecure)) {
    Write-HelperLog -EventName 'bad_server_url'
    if (-not $Background) { Write-Host 'サーバ URL が不正です（https 必須）。' }
    return 3
  }

  if (Test-Path -LiteralPath (Get-StatePath -Name 'revoked.flag')) {
    Write-HelperLog -EventName 'revoked_flag_present'
    # 前回の失効で報告できなかった結果を再送する。ヘルパーとしての動作は再開しない。
    if (Test-Path -LiteralPath (Get-StatePath -Name 'token.dat')) {
      # 引き渡しの途中で落ちた場合。
      $pendingToken = Read-HelperToken
      if ($null -ne $pendingToken) {
        $null = Invoke-HelperRevocationFlush -ServerBase $serverBase -Token ([string]$pendingToken.helperToken) -Identity $identity
      } else {
        $null = Move-RevokedTokenToReportStore
      }
    }
    Invoke-ReportOnlyFlushSafe -ServerBase $serverBase -Identity $identity
    if (-not $Background) { Write-Host 'このヘルパーは失効済みです。install-folder-helper.ps1 で再登録してください。' }
    return 0
  }

  Invoke-ReportOnlyFlushSafe -ServerBase $serverBase -Identity $identity
  $failures = 0
  $retryAfter = 0
  $tokenInfo = Read-HelperToken
  if ($null -eq $tokenInfo) {
    # 導入コードが無いので登録しない。登録は install-folder-helper.ps1 -EnrollCode だけが行う。
    # 報告専用トークンの再送は上で済ませた。
    Remove-StateFile -Name 'token.dat'
    Write-HelperLog -EventName 'no_token_exit'
    if (-not $Background) { Write-Host 'トークンがありません。install-folder-helper.ps1 -EnrollCode で登録してください。' }
    if ($RegisterOnly) { return 3 }
    return 0
  }
  if ($RegisterOnly) { return 0 }

  $token = [string]$tokenInfo.helperToken
  $state = New-PollState
  $failures = 0
  Write-HelperLog -EventName 'started'
  while ($true) {
    $poll = Invoke-HelperPoll -ServerBase $serverBase -Token $token -Identity $identity -State $state
    $retryAfter = 0
    if ($poll.Ok) {
      $failures = 0
    } elseif ($poll.Status -eq 401) {
      # トークンが無効。再登録には導入コードが必要なので install を待つ。
      Write-HelperLog -EventName 'token_rejected' -Fields @{ httpStatus = $poll.Status }
      Remove-StateFile -Name 'token.dat'
      Remove-StateFile -Name 'pairing-code.txt'
      return 0
    } else {
      $failures++
      $retryAfter = $poll.RetryAfter
      Write-HelperLog -EventName 'poll_failed' -Fields @{ httpStatus = $poll.Status; errorType = $poll.ErrorType }
    }

    if ($state.Revoked) {
      Write-HelperLog -EventName 'revoked'
      # 実行中の子は Invoke-SkillRun が kill 済み。報告してからトークンを消す。
      $done = Invoke-HelperRevocationFlush -ServerBase $serverBase -Token $token -Identity $identity
      if (-not $done) { Write-HelperLog -EventName 'revocation_reports_pending' }
      Remove-StateFile -Name 'pairing-code.txt'
      [IO.File]::WriteAllText((Get-StatePath -Name 'revoked.flag'), 'revoked')
      return 0
    }

    Clear-PairingCodeIfDone -Paired $state.OpSeen
    # 再起動前の実行記録を先に報告する（再実行しない）。
    try {
      Invoke-PendingSkillReports -ServerBase $serverBase -Token $token -Identity $identity
    } catch {
      Write-HelperLog -EventName 'report_failed' -Fields @{ errorType = (Get-ExceptionTypeName -ErrorRecord $_) }
    }
    Invoke-ReportOnlyFlushSafe -ServerBase $serverBase -Identity $identity
    while ($state.Queue.Count -gt 0) {
      $op = $state.Queue.Dequeue()
      try {
        Invoke-HelperOperation -Op $op -ServerBase $serverBase -Token $token -Identity $identity -State $state
      } catch {
        # 1 件の失敗で常駐を止めない。メッセージはパスを含み得るので型名だけ記録する。
        Write-HelperLog -EventName 'op_exception' -Fields @{ errorType = (Get-ExceptionTypeName -ErrorRecord $_) }
      }
      if ($state.Revoked) { break }
    }
    if ($state.Revoked) { continue }

    Start-Sleep -Seconds (Get-NextPollDelay -Failures $failures -RetryAfterSeconds $retryAfter -BaseSeconds $script:PollBaseSeconds -MaxSeconds $script:PollMaxSeconds)
  }
}

if (-not $NoMain) {
  exit (Invoke-HelperMain)
}
