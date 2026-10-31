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
  前面で登録だけを行い、コードを本人の画面に表示して終了する。
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

$script:HelperVersion = '0.1.0'
$script:HardMaxEntries = 500
$script:HardMaxBytes = 32768
$script:HardMaxSeconds = 15
$script:MaxSegments = 16
$script:MaxSegmentLength = 255
$script:PollBaseSeconds = 5
$script:PollMaxSeconds = 300
$script:CancelCheckMs = 5000
$script:MaxResponseBytes = 1048576
$script:MaxLogBytes = 262144
$script:AllowedRoots = @('Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos')
$script:RestrictedSids = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')
$script:ApiBasePath = '/api/device/agent/folder-helper'

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
    [AllowNull()][string]$CloudScope
  )
  if (($Attributes -band $script:AttrReparsePoint) -eq 0) { return $true }
  if (Test-IsNameSurrogateTag -Tag $Tag) { return $false }
  if ([string]::IsNullOrEmpty($CloudScope)) { return $false }
  if (-not (Test-IsCloudTag -Tag $Tag)) { return $false }
  return (Test-PathWithin -Candidate $Path -Root $CloudScope)
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
  # 子を開かない。.Next() は FindNextFileW の 1 件分。時間は件の間でしか判定できない。
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

function Resolve-FolderTarget {
  # 起点とセグメントから対象を決める。文字列の前方一致だけで判定しない:
  #  1. ボリューム直下から対象まで全要素を「リンクを開く」モードで開き、reparse を確認する
  #  2. 起点・プロファイル・OneDrive を同じ手順で最終パスにし、最終パス同士で範囲を判定する
  # $Probe: { param($extendedPath, [bool]$openReparsePoint) } -> Error, Attributes, ReparseTag, FinalPath
  param(
    [AllowNull()][string]$BasePath,
    [AllowEmptyCollection()][object[]]$Segments,
    [AllowNull()][string]$ProfilePath,
    [AllowNull()][string]$OneDrivePath,
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

  $scopes = New-Object System.Collections.Generic.List[string]
  $scopes.Add($profileFinal)
  $cloudScope = $null
  $oneDriveNorm = ConvertTo-NormalizedPath -Path $OneDrivePath
  if ($null -ne $oneDriveNorm -and -not (Test-IsDriveRoot -Path $oneDriveNorm)) {
    $oneDriveProbe = & $Probe (ConvertTo-ExtendedPath -Path $oneDriveNorm) $false
    if ($oneDriveProbe.Error -eq 0) {
      $oneDriveFinal = ConvertTo-NormalizedPath -Path $oneDriveProbe.FinalPath
      if ($null -ne $oneDriveFinal -and -not (Test-IsDriveRoot -Path $oneDriveFinal)) {
        $scopes.Add($oneDriveFinal)
        $cloudScope = $oneDriveFinal
      }
    }
  }

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

  return @{ Reason = $null; TargetFinal = $targetFinal; RootFinal = $rootFinal }
}

function Invoke-ListOperation {
  # 検証済みの op を実行する。$Deps: Probe, OpenLister, GetKnownFolder, GetProfilePath, GetOneDrivePath,
  # ElapsedMs, ShouldCancel, IsExpired。結果には名前が入るので、呼び出し側でログに出さないこと。
  param([Parameter(Mandatory)][object]$Op, [Parameter(Mandatory)][hashtable]$Deps)
  $finish = {
    param($status, $reason, $truncated, $entries, $discard)
    return @{ Status = $status; Reason = $reason; Truncated = [bool]$truncated; Entries = $entries; Discard = [bool]$discard; ElapsedMs = [long](& $Deps.ElapsedMs) }
  }
  $noEntries = @()
  $basePath = & $Deps.GetKnownFolder $Op.root
  $profilePath = & $Deps.GetProfilePath
  $oneDrivePath = & $Deps.GetOneDrivePath
  if ([string]::IsNullOrEmpty($basePath)) { return (& $finish 'error' 'OUT_OF_SCOPE' $false $noEntries $false) }

  $segments = @($Op.segments)
  $before = Resolve-FolderTarget -BasePath $basePath -Segments $segments -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $Deps.Probe
  if ($null -ne $before.Reason) { return (& $finish 'error' $before.Reason $false $noEntries $false) }

  $limits = Resolve-ListLimits -Op $Op
  $lister = & $Deps.OpenLister (ConvertTo-ExtendedPath -Path ($before.TargetFinal.TrimEnd('\') + '\*'))
  try {
    if ($lister.LastError -ne 0) {
      return (& $finish 'error' (ConvertTo-ProbeReason -Win32Error $lister.LastError) $false $noEntries $false)
    }
    $read = Read-DirectoryEntries -Lister $lister -Limits $limits -ElapsedMs $Deps.ElapsedMs -ShouldCancel $Deps.ShouldCancel -CancelCheckMs $script:CancelCheckMs
  } finally {
    $lister.Dispose()
  }
  if ($read.Cancelled) { return (& $finish 'error' 'CANCELLED' $false $noEntries $true) }
  # 18 = ERROR_NO_MORE_FILES。途中で失敗した一覧は部分結果として返さない。
  if ($read.LastError -ne 0 -and $read.LastError -ne 18) {
    return (& $finish 'error' (ConvertTo-ProbeReason -Win32Error $read.LastError) $false $noEntries $false)
  }

  # 列挙の間に祖先が差し替えられていないか再確認する。
  $after = Resolve-FolderTarget -BasePath $basePath -Segments $segments -ProfilePath $profilePath -OneDrivePath $oneDrivePath -Probe $Deps.Probe
  if ($null -ne $after.Reason -or -not [string]::Equals($after.TargetFinal, $before.TargetFinal, [StringComparison]::OrdinalIgnoreCase)) {
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
  $ops = Get-OpField -Op $Response -Name 'ops'
  if ($ops -is [array]) {
    foreach ($op in $ops) {
      $id = Get-OpField -Op $op -Name 'opId'
      if (-not (Test-SafeOpId -OpId $id)) { continue }
      if ($State.Seen.Add($id)) { $State.Queue.Enqueue($op); $State.OpSeen = $true }
    }
  }
}

function Get-NextPollDelay {
  # 成功で基準間隔へ戻し、失敗ごとに倍にする。Retry-After があれば尊重する。
  param([int]$Failures, [int]$RetryAfterSeconds = 0, [int]$BaseSeconds = 5, [int]$MaxSeconds = 300)
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
# Windows 依存部（ドットソース時には実行しない）
# ---------------------------------------------------------------------------

$script:NativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

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
  internal struct FileTimeRaw {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  internal struct Win32FindDataW {
    public uint dwFileAttributes;
    public FileTimeRaw ftCreationTime;
    public FileTimeRaw ftLastAccessTime;
    public FileTimeRaw ftLastWriteTime;
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
  internal struct FileAttributeTagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  internal static class Api {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr FindFirstFileExW(string lpFileName, int fInfoLevelId, out Win32FindDataW lpFindFileData, int fSearchOp, IntPtr lpSearchFilter, int dwAdditionalFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindNextFileW(IntPtr hFindFile, out Win32FindDataW lpFindFileData);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindClose(IntPtr hFindFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(IntPtr hFile, int fileInformationClass, out FileAttributeTagInfo lpFileInformation, uint dwBufferSize);

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

  public sealed class DirectoryLister : IDisposable {
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private const int FindExInfoBasic = 1;
    private const int FindExSearchNameMatch = 0;
    private const int FindFirstExLargeFetch = 2;
    private const int ErrorFileNotFound = 2;
    private IntPtr handle;
    private Win32FindDataW first;
    private bool hasFirst;
    public int LastError;

    public DirectoryLister(string searchPath) {
      handle = Api.FindFirstFileExW(searchPath, FindExInfoBasic, out first, FindExSearchNameMatch, IntPtr.Zero, FindFirstExLargeFetch);
      if (handle == Invalid) {
        int error = Marshal.GetLastWin32Error();
        LastError = (error == ErrorFileNotFound) ? 0 : error;
      } else {
        hasFirst = true;
      }
    }

    public RawFindEntry Next() {
      if (handle == Invalid) { return null; }
      if (hasFirst) {
        hasFirst = false;
        return Convert(first);
      }
      Win32FindDataW data;
      if (Api.FindNextFileW(handle, out data)) { return Convert(data); }
      LastError = Marshal.GetLastWin32Error();
      return null;
    }

    private static RawFindEntry Convert(Win32FindDataW data) {
      RawFindEntry entry = new RawFindEntry();
      entry.Name = data.cFileName;
      entry.Attributes = data.dwFileAttributes;
      entry.ReparseTag = data.dwReserved0;
      entry.Size = (long)(((ulong)data.nFileSizeHigh << 32) | data.nFileSizeLow);
      entry.LastWriteFileTime = (long)(((ulong)data.ftLastWriteTime.High << 32) | data.ftLastWriteTime.Low);
      return entry;
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

function New-NativeLister {
  param([Parameter(Mandatory)][string]$SearchPath)
  return (New-Object AIHelpDesk.FolderHelper.DirectoryLister -ArgumentList $SearchPath)
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

function Get-OneDriveUserFolder {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\OneDrive', $false)
  if ($null -eq $key) { return $null }
  try { return (Get-RegistryPathNoExpand -Key $key -Name 'UserFolder') } finally { $key.Dispose() }
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
  param([Parameter(Mandatory)][ValidateSet('token.dat', 'config.json', 'pairing-code.txt', 'helper.log', 'revoked.flag')][string]$Name)
  return ((Get-StateDirectory) + '\' + $Name)
}

function Save-HelperToken {
  param([Parameter(Mandatory)][string]$HelperId, [Parameter(Mandatory)][string]$HelperToken)
  Add-Type -AssemblyName System.Security
  $plain = [Text.Encoding]::UTF8.GetBytes((ConvertTo-HelperJson -Value ([ordered]@{ helperId = $HelperId; helperToken = $HelperToken })))
  $sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Get-StatePath -Name 'token.dat'), $sealed)
}

function Read-HelperToken {
  # 無い・復号できない場合は $null。
  $path = Get-StatePath -Name 'token.dat'
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
  param(
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][hashtable]$Identity,
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
    })
  $response = Invoke-HelperHttp -Url (Get-HelperApiUrl -ServerBase $ServerBase -Action 'register') -Token $null -BodyJson $body
  if ($response.Status -lt 200 -or $response.Status -ge 300) {
    Write-HelperLog -EventName 'register_failed' -Fields @{ httpStatus = $response.Status; errorType = $response.ErrorType }
    return @{ Ok = $false; RetryAfter = $response.RetryAfter }
  }
  $parsed = ConvertFrom-HelperJson -Json $response.Body
  $helperId = [string](Get-OpField -Op $parsed -Name 'helperId')
  $helperToken = Get-OpField -Op $parsed -Name 'helperToken'
  $pairingCode = Get-OpField -Op $parsed -Name 'pairingCode'
  if ($helperToken -isnot [string] -or $helperToken.Length -eq 0 -or $pairingCode -isnot [string] -or $pairingCode.Length -eq 0) {
    Write-HelperLog -EventName 'register_bad_response'
    return @{ Ok = $false; RetryAfter = 0 }
  }
  Save-HelperToken -HelperId $helperId -HelperToken $helperToken
  Show-PairingCode -Code $pairingCode -ExpiresAt ([string](Get-OpField -Op $parsed -Name 'pairingExpiresAt')) -InBackground $InBackground
  Write-HelperLog -EventName 'registered'
  return @{ Ok = $true; RetryAfter = 0 }
}

function Invoke-HelperPoll {
  # 1 回ポーリングして $State を更新する。Status と RetryAfter を返す。
  param(
    [Parameter(Mandatory)][string]$ServerBase,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][hashtable]$Identity,
    [Parameter(Mandatory)][hashtable]$State
  )
  $session = Get-SessionInfo
  $body = ConvertTo-HelperJson -Value ([ordered]@{ sid = $Identity.Sid; sessionId = [int]$session.SessionId; sessionState = $session.SessionState })
  $response = Invoke-HelperHttp -Url (Get-HelperApiUrl -ServerBase $ServerBase -Action 'poll') -Token $Token -BodyJson $body
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
    $null = Invoke-HelperPoll -ServerBase $helperOpRuntime.ServerBase -Token $helperOpRuntime.Token -Identity $helperOpRuntime.Identity -State $helperOpRuntime.State
    return ($helperOpRuntime.State.Revoked -or $helperOpRuntime.State.Cancelled.Contains($helperOpRuntime.OpId))
  }
  $deps = @{
    Probe           = { param($path, $openReparse) Invoke-NativeProbe -Path $path -OpenReparsePoint ([bool]$openReparse) }
    OpenLister      = { param($searchPath) New-NativeLister -SearchPath $searchPath }
    GetKnownFolder  = { param($root) Get-KnownFolderPath -Root $root }
    GetProfilePath  = { Get-ProfileImagePathForSid -Sid $helperOpRuntime.Sid }
    GetOneDrivePath = { Get-OneDriveUserFolder }
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
    if (-not $Background) { Write-Host 'このヘルパーは失効済みです。install-folder-helper.ps1 で再登録してください。' }
    return 0
  }

  $failures = 0
  $retryAfter = 0
  $tokenInfo = Read-HelperToken
  while ($null -eq $tokenInfo) {
    Remove-StateFile -Name 'token.dat'
    $registered = Invoke-HelperRegistration -ServerBase $serverBase -Identity $identity -InBackground ([bool]$Background)
    if ($registered.Ok) { $tokenInfo = Read-HelperToken; if ($null -ne $tokenInfo) { break } }
    if ($RegisterOnly) {
      Write-Host '登録に失敗しました。'
      return 3
    }
    $failures++
    Start-Sleep -Seconds (Get-NextPollDelay -Failures $failures -RetryAfterSeconds $registered.RetryAfter -BaseSeconds $script:PollBaseSeconds -MaxSeconds $script:PollMaxSeconds)
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
      # トークンが無効。次回ログオン時に再登録する（ペアリングには本人の操作が必要）。
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
      Remove-StateFile -Name 'token.dat'
      Remove-StateFile -Name 'pairing-code.txt'
      [IO.File]::WriteAllText((Get-StatePath -Name 'revoked.flag'), 'revoked')
      return 0
    }

    Clear-PairingCodeIfDone -Paired $state.OpSeen
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
