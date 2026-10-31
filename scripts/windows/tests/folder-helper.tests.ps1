#Requires -Version 5.1
<#
.SYNOPSIS
  folder-helper.ps1 の純粋関数テスト。Pester に依存しない。Linux の pwsh でも実行できる。

.DESCRIPTION
  OS 依存部は差し替えたスタブで検証する。Windows API の実挙動はこのテストでは確認できない
  （実機の確認項目は docs/62-consented-folder-access.md §9.5）。

.EXAMPLE
  pwsh -NoProfile -File scripts/windows/tests/folder-helper.tests.ps1
#>
param()

$ErrorActionPreference = 'Stop'
$windowsDir = Split-Path -Parent $PSScriptRoot
$helperPath = Join-Path $windowsDir 'folder-helper.ps1'
$installPath = Join-Path $windowsDir 'install-folder-helper.ps1'
$uninstallPath = Join-Path $windowsDir 'uninstall-folder-helper.ps1'
$docPath = Join-Path (Split-Path -Parent (Split-Path -Parent $windowsDir)) 'docs/62-consented-folder-access.md'

. $helperPath -NoMain

$script:Passed = 0
$script:Failed = 0

function Assert-True {
  param([string]$Name, [object]$Actual)
  if ($Actual -is [bool] -and $Actual) { $script:Passed++ }
  else { $script:Failed++; Write-Output ('FAIL ' + $Name + ' : expected $true, got ' + [string]$Actual) }
}

function Assert-False {
  param([string]$Name, [object]$Actual)
  if ($Actual -is [bool] -and -not $Actual) { $script:Passed++ }
  else { $script:Failed++; Write-Output ('FAIL ' + $Name + ' : expected $false, got ' + [string]$Actual) }
}

function Assert-Equal {
  param([string]$Name, [object]$Expected, [object]$Actual)
  if (($null -eq $Expected -and $null -eq $Actual) -or ($null -ne $Expected -and $null -ne $Actual -and ([string]$Expected) -ceq ([string]$Actual))) { $script:Passed++ }
  else { $script:Failed++; Write-Output ('FAIL ' + $Name + ' : expected [' + [string]$Expected + '] got [' + [string]$Actual + ']') }
}

# ---------------------------------------------------------------------------
# 署名ベクトル（node の JSON.stringify + crypto.createHmac で生成。docs/62 §9.1 と同一）
# ---------------------------------------------------------------------------
$vectorToken = 'test-helper-token-not-a-secret'
function New-VectorOp {
  param([string]$OpId = 'op-0001', [string]$Root = 'Documents', [object[]]$Segments = @(), [hashtable]$Extra = @{})
  $o = [ordered]@{
    opId = $OpId; requestId = 'req-0001'; sid = 'S-1-5-21-1000-2000-3000-1001'; sessionId = 2
    root = $Root; segments = [object[]]$Segments; operation = 'list_metadata'; expiresAt = '2026-11-01T00:00:00.000Z'
  }
  foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
  return [pscustomobject]$o
}

$v1 = New-VectorOp
Assert-Equal 'canonical: 空の segments' '{"opId":"op-0001","requestId":"req-0001","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"root":"Documents","segments":[],"operation":"list_metadata","expiresAt":"2026-11-01T00:00:00.000Z"}' (Get-CanonicalOpJson -Op $v1)
Assert-Equal 'hmac: 空の segments' 'b70e5c50b8a96ed675de7f16e4eed2f0d001649d7564be1e606ff31691342ad9' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $v1))

$v2 = New-VectorOp -Segments @('alpha')
Assert-Equal 'canonical: 1 要素の segments は配列のまま' '{"opId":"op-0001","requestId":"req-0001","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"root":"Documents","segments":["alpha"],"operation":"list_metadata","expiresAt":"2026-11-01T00:00:00.000Z"}' (Get-CanonicalOpJson -Op $v2)
Assert-Equal 'hmac: 1 要素' '8312545a3c8c05654081258357d395dd2cd495c844bf83fa55eaa665fa9012cd' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $v2))

$v3 = New-VectorOp -OpId 'op-0003' -Root 'Desktop' -Segments @('資料', '2026年度 計画', 'テスト😀')
Assert-Equal 'hmac: 日本語と絵文字は生の UTF-8' '66ab20ce0c620c7eda2ce5c1a240a2f509f3073a41c009665247e966a18c37fd' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $v3))

# エスケープの境界（\x7f と U+2028/2029 は生のまま、制御文字は短縮形または \u00xx、孤立サロゲートは \ud83d）
$specialSegments = @(
  ('q"b\s/<&>' + "'"),
  ("`n`t" + [char]8 + [char]12 + "`r" + [char]1 + [char]0x7F),
  ([string][char]0x2028 + [char]0x2029 + [char]0xE9),
  ([string][char]0xD83D)
)
$v4 = New-VectorOp -OpId 'op-0004' -Segments $specialSegments
Assert-Equal 'hmac: エスケープの境界' '9f3fdea853998db0898d79174147698a8c8368adefbba4293837aeeba6306a8e' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $v4))

# Node 側 apps/api/src/folder-access/sign.test.ts の固定ベクトル
$nodeOp = [pscustomobject][ordered]@{
  opId = '11111111-1111-4111-8111-111111111111'; requestId = '22222222-2222-4222-8222-222222222222'
  sid = 'S-1-5-21-1000000001-1000000002-1000000003-1104'; sessionId = 2; root = 'Documents'
  segments = [object[]]@('業務資料', "R&D's"); operation = 'list_metadata'; expiresAt = '2026-01-02T03:04:05.000Z'
}
Assert-Equal 'hmac: Node 側の固定ベクトル' '32bb903bb816eb361d56378e98cb41d7d491cf58a18c22ecd207cca2aa69b2f7' (Get-HmacSha256Hex -Key 'test-helper-token-0123456789abcdefghijklmnop' -Message (Get-CanonicalOpJson -Op $nodeOp))

# JSON 文字列から読み込んだ場合も同じ署名になること（pwsh 7 の日付変換への回帰テスト）
$fromJson = ConvertFrom-HelperJson -Json '{"opId":"op-0001","requestId":"req-0001","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"root":"Documents","segments":["alpha"],"operation":"list_metadata","expiresAt":"2026-11-01T00:00:00.000Z","maxEntries":500}'
Assert-True 'json: expiresAt は文字列のまま' ($fromJson.expiresAt -is [string])
Assert-Equal 'json: 読込後も同じ署名' '8312545a3c8c05654081258357d395dd2cd495c844bf83fa55eaa665fa9012cd' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $fromJson))
$fromJsonEmpty = ConvertFrom-HelperJson -Json '{"opId":"op-0001","requestId":"req-0001","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"root":"Documents","segments":[],"operation":"list_metadata","expiresAt":"2026-11-01T00:00:00.000Z"}'
Assert-Equal 'json: 空配列も同じ署名' 'b70e5c50b8a96ed675de7f16e4eed2f0d001649d7564be1e606ff31691342ad9' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $fromJsonEmpty))

# docs/62 に同じベクトルが載っていること（Node 側と共有する正本）
if (Test-Path -LiteralPath $docPath) {
  $doc = [IO.File]::ReadAllText($docPath, [Text.Encoding]::UTF8)
  foreach ($hex in 'b70e5c50b8a96ed675de7f16e4eed2f0d001649d7564be1e606ff31691342ad9', '8312545a3c8c05654081258357d395dd2cd495c844bf83fa55eaa665fa9012cd', '66ab20ce0c620c7eda2ce5c1a240a2f509f3073a41c009665247e966a18c37fd', '9f3fdea853998db0898d79174147698a8c8368adefbba4293837aeeba6306a8e', '32bb903bb816eb361d56378e98cb41d7d491cf58a18c22ecd207cca2aa69b2f7') {
    Assert-True ('docs/62 にベクトルがある ' + $hex.Substring(0, 8)) ($doc.Contains($hex))
  }
} else {
  $script:Failed++
  Write-Output 'FAIL docs/62 が見つかりません'
}

# 型が違う入力は署名計算の前に拒否する
$threw = $false
try { $null = Get-CanonicalOpJson -Op (New-VectorOp -Extra @{ sessionId = '2' }) } catch { $threw = $true }
Assert-True 'canonical: sessionId が文字列なら例外' $threw
$threw = $false
try { $null = Get-CanonicalOpJson -Op (New-VectorOp -Extra @{ expiresAt = [DateTime]::UtcNow }) } catch { $threw = $true }
Assert-True 'canonical: expiresAt が DateTime なら例外' $threw
$threw = $false
try { $null = Get-CanonicalOpJson -Op (New-VectorOp -Extra @{ segments = 'alpha' }) } catch { $threw = $true }
Assert-True 'canonical: segments が文字列なら例外' $threw

Assert-True 'fixed-time: 一致' (Test-FixedTimeEqual -A 'abc' -B 'abc')
Assert-False 'fixed-time: 不一致' (Test-FixedTimeEqual -A 'abc' -B 'abd')
Assert-False 'fixed-time: 長さ違い' (Test-FixedTimeEqual -A 'abc' -B 'abcd')

# ---------------------------------------------------------------------------
# op の検証
# ---------------------------------------------------------------------------
function New-SignedOp {
  param([hashtable]$Extra = @{}, [object[]]$Segments = @('alpha'), [string]$Token = $vectorToken, [string]$Root = 'Documents')
  $op = New-VectorOp -Segments $Segments -Root $Root -Extra $Extra
  $op | Add-Member -NotePropertyName sig -NotePropertyValue (Get-HmacSha256Hex -Key $Token -Message (Get-CanonicalOpJson -Op $op))
  return $op
}
$goodContext = @{
  Sid = 'S-1-5-21-1000-2000-3000-1001'; SessionId = 2; SessionState = 'active'
  NowUtc = [DateTimeOffset]::Parse('2026-10-31T00:00:00Z', [Globalization.CultureInfo]::InvariantCulture); IsElevated = $false
}
function Copy-Context { param([hashtable]$Change) $c = $goodContext.Clone(); foreach ($k in $Change.Keys) { $c[$k] = $Change[$k] }; return $c }

Assert-Equal 'op: 正常' $null (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: 署名の鍵違い' 'BAD_SIGNATURE' (Get-OpRefusal -Op (New-SignedOp -Token 'other') -Token $vectorToken -Context $goodContext)
$tampered = New-SignedOp; $tampered.segments = [object[]]@('beta')
Assert-Equal 'op: segments 改ざん' 'BAD_SIGNATURE' (Get-OpRefusal -Op $tampered -Token $vectorToken -Context $goodContext)
$tampered = New-SignedOp; $tampered.sig = $tampered.sig.ToUpperInvariant()
Assert-Equal 'op: 大文字の sig は受けない' 'BAD_SIGNATURE' (Get-OpRefusal -Op $tampered -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: sig なし' 'BAD_SIGNATURE' (Get-OpRefusal -Op (New-VectorOp) -Token $vectorToken -Context $goodContext)
$noSeg = [pscustomobject]@{ opId = 'x'; sig = ('0' * 64) }
Assert-Equal 'op: フィールド不足' 'BAD_OP' (Get-OpRefusal -Op $noSeg -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: 別の操作' 'BAD_OP' (Get-OpRefusal -Op (New-SignedOp -Extra @{ operation = 'read_file' }) -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: 昇格' 'ELEVATED' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ IsElevated = $true }))
Assert-Equal 'op: SID 不一致' 'SID_MISMATCH' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ Sid = 'S-1-5-21-1-2-3-4' }))
Assert-Equal 'op: セッション不一致' 'SESSION_MISMATCH' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ SessionId = 3 }))
Assert-Equal 'op: 切断中' 'SESSION_NOT_ACTIVE' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ SessionState = 'disconnected' }))
Assert-Equal 'op: 状態不明' 'SESSION_NOT_ACTIVE' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ SessionState = 'unknown' }))
Assert-Equal 'op: 期限切れ' 'EXPIRED' (Get-OpRefusal -Op (New-SignedOp) -Token $vectorToken -Context (Copy-Context @{ NowUtc = [DateTimeOffset]::Parse('2026-11-01T00:00:00Z', [Globalization.CultureInfo]::InvariantCulture) }))
Assert-Equal 'op: 期限の形式違い' 'BAD_OP' (Get-OpRefusal -Op (New-SignedOp -Extra @{ expiresAt = '2026/11/01' }) -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: root が enum 外' 'INVALID_ROOT' (Get-OpRefusal -Op (New-SignedOp -Root 'Windows') -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: root の大文字小文字違い' 'INVALID_ROOT' (Get-OpRefusal -Op (New-SignedOp -Root 'documents') -Token $vectorToken -Context $goodContext)
Assert-Equal 'op: 不正セグメント' 'INVALID_SEGMENT' (Get-OpRefusal -Op (New-SignedOp -Segments @('..')) -Token $vectorToken -Context $goodContext)

# ---------------------------------------------------------------------------
# セグメント検証
# ---------------------------------------------------------------------------
foreach ($ok in 'alpha', '資料', '2026年度 計画', 'a.b', '.hidden', 'CONSOLE', 'COMPANY', 'NULL', 'con1', 'テスト😀', '~tmp', ('x' * 255)) {
  Assert-True ('segment OK: ' + $ok.Substring(0, [Math]::Min(12, $ok.Length))) (Test-PathSegment -Segment $ok)
}
$badSegments = @(
  '', '.', '..', 'a:b', 'a\b', 'a/b', 'a*', 'a?', 'a"b', 'a<b', 'a>b', 'a|b',
  'name.', 'name ', 'file:stream', 'C:', '..\..', '../x',
  'CON', 'con', 'PRN', 'AUX', 'NUL', 'nul.txt', 'NUL .txt', 'COM1', 'com9.log', 'LPT1', 'lpt0', 'CONIN$', 'conout$',
  ('COM' + [char]0xB9), ('LPT' + [char]0xB2 + '.txt'),
  ("a`nb"), ("a`tb"), ('a' + [char]0), ('a' + [char]0x1F), ('a' + [char]0x7F), ('a' + [char]0x85),
  ([string][char]0xD83D), ('a' + [char]0xDE00 + 'b'),
  ('x' * 256)
)
foreach ($bad in $badSegments) {
  $label = ($bad -replace '[^\x21-\x7E]', '#')
  Assert-False ('segment NG: [' + $label.Substring(0, [Math]::Min(12, $label.Length)) + ']') (Test-PathSegment -Segment $bad)
}
Assert-False 'segment NG: 数値' (Test-PathSegment -Segment 5)
Assert-False 'segment NG: null' (Test-PathSegment -Segment $null)
Assert-True 'segments: 空配列は起点そのもの' (Test-PathSegments -Segments ([object[]]@()))
Assert-False 'segments: 配列でない' (Test-PathSegments -Segments 'alpha')
Assert-False 'segments: null' (Test-PathSegments -Segments $null)
Assert-False 'segments: 深すぎる' (Test-PathSegments -Segments ([object[]](1..17 | ForEach-Object { 'd' })))
Assert-True 'segments: 上限ちょうど' (Test-PathSegments -Segments ([object[]](1..16 | ForEach-Object { 'd' })))
foreach ($r in 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos') { Assert-True ('root OK ' + $r) (Test-AllowedRoot -Root $r) }
foreach ($r in 'desktop', 'DOCUMENTS', 'AppData', '', 'C:\Users', '..') { Assert-False ('root NG ' + $r) (Test-AllowedRoot -Root $r) }

# ---------------------------------------------------------------------------
# 正規化と範囲判定
# ---------------------------------------------------------------------------
Assert-Equal 'norm: そのまま' 'C:\Users\a' (ConvertTo-NormalizedPath -Path 'C:\Users\a')
Assert-Equal 'norm: \\?\ を外す' 'C:\Users\a' (ConvertTo-NormalizedPath -Path '\\?\C:\Users\a')
Assert-Equal 'norm: 末尾の \' 'C:\Users\a' (ConvertTo-NormalizedPath -Path 'C:\Users\a\')
Assert-Equal 'norm: ドライブ直下' 'C:\' (ConvertTo-NormalizedPath -Path 'C:\')
Assert-Equal 'norm: UNC は範囲外' $null (ConvertTo-NormalizedPath -Path '\\?\UNC\server\share\x')
Assert-Equal 'norm: 生 UNC は範囲外' $null (ConvertTo-NormalizedPath -Path '\\server\share')
Assert-Equal 'norm: デバイス' $null (ConvertTo-NormalizedPath -Path '\\.\C:\x')
Assert-Equal 'norm: ボリューム GUID' $null (ConvertTo-NormalizedPath -Path '\\?\Volume{00000000-0000-0000-0000-000000000000}\x')
Assert-Equal 'norm: 相対' $null (ConvertTo-NormalizedPath -Path 'Users\a')
Assert-Equal 'norm: .. を含む' $null (ConvertTo-NormalizedPath -Path 'C:\Users\a\..\b')
Assert-Equal 'norm: . を含む' $null (ConvertTo-NormalizedPath -Path 'C:\Users\.\b')
Assert-Equal 'norm: / を含む' $null (ConvertTo-NormalizedPath -Path 'C:/Users/a')
Assert-Equal 'norm: 連続区切り' $null (ConvertTo-NormalizedPath -Path 'C:\Users\\a')
Assert-Equal 'norm: 空' $null (ConvertTo-NormalizedPath -Path '')

Assert-True 'within: 同一' (Test-PathWithin -Candidate 'C:\Users\a' -Root 'C:\Users\a')
Assert-True 'within: 配下' (Test-PathWithin -Candidate 'C:\Users\a\Documents' -Root 'C:\Users\a')
Assert-True 'within: 大文字小文字を無視' (Test-PathWithin -Candidate 'c:\users\A\Documents' -Root 'C:\Users\a')
Assert-True 'within: \\?\ 付き' (Test-PathWithin -Candidate '\\?\C:\Users\a\b' -Root 'C:\Users\a')
Assert-False 'within: 前方一致だけの別フォルダ' (Test-PathWithin -Candidate 'C:\Users\ab' -Root 'C:\Users\a')
Assert-False 'within: 前方一致だけの別フォルダ 2' (Test-PathWithin -Candidate 'C:\Users\a.old\x' -Root 'C:\Users\a')
Assert-False 'within: 親' (Test-PathWithin -Candidate 'C:\Users' -Root 'C:\Users\a')
Assert-False 'within: .. で脱出' (Test-PathWithin -Candidate 'C:\Users\a\..\b' -Root 'C:\Users\a')
Assert-False 'within: 別ドライブ' (Test-PathWithin -Candidate 'D:\Users\a' -Root 'C:\Users\a')
Assert-False 'within: UNC' (Test-PathWithin -Candidate '\\?\UNC\s\Users\a' -Root 'C:\Users\a')
Assert-Equal 'chain' 'C:\|C:\a|C:\a\b' ((Get-PathChain -Path 'C:\a\b') -join '|')
Assert-Equal 'chain: 直下' 'C:\' ((Get-PathChain -Path 'C:\') -join '|')
Assert-Equal 'join: セグメントなし' 'C:\a' (Join-TargetPath -Base 'C:\a' -Segments @())
Assert-Equal 'join' 'C:\a\b\c' (Join-TargetPath -Base 'C:\a\' -Segments @('b', 'c'))

$tagSymlink = [Convert]::ToUInt32('A000000C', 16)
$tagMount = [Convert]::ToUInt32('A0000003', 16)
$tagCloud = [Convert]::ToUInt32('9000001A', 16)
$tagCloudVariant = [Convert]::ToUInt32('9000F01A', 16)
$tagDedup = [Convert]::ToUInt32('80000013', 16)
$attrDir = [uint32]16
$attrReparseDir = [uint32](16 + 1024)
Assert-True 'tag: cloud' (Test-IsCloudTag -Tag $tagCloud)
Assert-True 'tag: cloud 変種' (Test-IsCloudTag -Tag $tagCloudVariant)
Assert-False 'tag: symlink は cloud でない' (Test-IsCloudTag -Tag $tagSymlink)
Assert-True 'tag: symlink は名前サロゲート' (Test-IsNameSurrogateTag -Tag $tagSymlink)
Assert-False 'tag: cloud は名前サロゲートでない' (Test-IsNameSurrogateTag -Tag $tagCloud)
Assert-True 'reparse: 通常フォルダ' (Test-ReparseAllowed -Path 'C:\Users\a' -Attributes $attrDir -Tag 0 -CloudScope $null)
Assert-False 'reparse: symlink' (Test-ReparseAllowed -Path 'C:\Users\a\OneDrive\x' -Attributes $attrReparseDir -Tag $tagSymlink -CloudScope 'C:\Users\a\OneDrive')
Assert-False 'reparse: junction' (Test-ReparseAllowed -Path 'C:\Users\a\OneDrive\x' -Attributes $attrReparseDir -Tag $tagMount -CloudScope 'C:\Users\a\OneDrive')
Assert-True 'reparse: OneDrive 配下の cloud' (Test-ReparseAllowed -Path 'C:\Users\a\OneDrive\x' -Attributes $attrReparseDir -Tag $tagCloud -CloudScope 'C:\Users\a\OneDrive')
Assert-False 'reparse: OneDrive 外の cloud' (Test-ReparseAllowed -Path 'C:\Users\a\Other' -Attributes $attrReparseDir -Tag $tagCloud -CloudScope 'C:\Users\a\OneDrive')
Assert-False 'reparse: OneDrive 未設定の cloud' (Test-ReparseAllowed -Path 'C:\Users\a\Other' -Attributes $attrReparseDir -Tag $tagCloud -CloudScope $null)
Assert-False 'reparse: その他のタグ' (Test-ReparseAllowed -Path 'C:\Users\a\OneDrive\x' -Attributes $attrReparseDir -Tag $tagDedup -CloudScope 'C:\Users\a\OneDrive')

# ---------------------------------------------------------------------------
# Resolve-FolderTarget（スタブのファイルシステム）
# ---------------------------------------------------------------------------
# $script:FakeFs のキーは通常パス、値は @{ Attr; Tag; Final; Error }。Final 省略時は同じパス。
$script:FakeFs = @{}
$script:ProbeLog = New-Object System.Collections.Generic.List[string]
$fakeProbe = {
  param($extended, $openReparse)
  $script:ProbeLog.Add([string]$extended)
  $plain = ConvertTo-NormalizedPath -Path $extended
  $entry = $null
  foreach ($k in $script:FakeFs.Keys) { if ([string]::Equals($k, $plain, [StringComparison]::OrdinalIgnoreCase)) { $entry = $script:FakeFs[$k] } }
  if ($null -eq $entry) { return [pscustomobject]@{ Error = 3; Attributes = [uint32]0; ReparseTag = [uint32]0; FinalPath = $null } }
  $errorCode = 0; if ($entry.ContainsKey('Error')) { $errorCode = $entry.Error }
  $attr = [uint32]16; if ($entry.ContainsKey('Attr')) { $attr = [uint32]$entry.Attr }
  $tag = [uint32]0; if ($entry.ContainsKey('Tag')) { $tag = [uint32]$entry.Tag }
  $final = '\\?\' + $plain; if ($entry.ContainsKey('Final')) { $final = $entry.Final }
  return [pscustomobject]@{ Error = $errorCode; Attributes = $attr; ReparseTag = $tag; FinalPath = $final }
}
function Set-BaseFs {
  $script:FakeFs = @{
    'C:\'                         = @{}
    'C:\Users'                    = @{}
    'C:\Users\a'                  = @{}
    'C:\Users\a\Documents'        = @{}
    'C:\Users\a\Documents\sub'    = @{}
    'C:\Users\a\Documents\sub\x'  = @{}
    'C:\Users\a\Documents\file'   = @{ Attr = 32 }
  }
}
function Invoke-Resolve {
  param([string]$Base = 'C:\Users\a\Documents', [object[]]$Segments = @(), [string]$ProfilePath = 'C:\Users\a', [string]$OneDrive = $null)
  return Resolve-FolderTarget -BasePath $Base -Segments $Segments -ProfilePath $ProfilePath -OneDrivePath $OneDrive -Probe $fakeProbe
}

Set-BaseFs
$r = Invoke-Resolve
Assert-Equal 'resolve: 起点' $null $r.Reason
Assert-Equal 'resolve: 起点の最終パス' 'C:\Users\a\Documents' $r.TargetFinal
$r = Invoke-Resolve -Segments @('sub', 'x')
Assert-Equal 'resolve: サブ' 'C:\Users\a\Documents\sub\x' $r.TargetFinal
Assert-True 'resolve: 全祖先を \\?\ 付きで確認' ($script:ProbeLog.Contains('\\?\C:\') -and $script:ProbeLog.Contains('\\?\C:\Users') -and $script:ProbeLog.Contains('\\?\C:\Users\a\Documents\sub'))
Assert-Equal 'resolve: ファイルは不可' 'NOT_A_DIRECTORY' (Invoke-Resolve -Segments @('file')).Reason
Assert-Equal 'resolve: 存在しない' 'NOT_FOUND' (Invoke-Resolve -Segments @('none')).Reason

Set-BaseFs; $script:FakeFs['C:\Users\a\Documents\sub'] = @{ Error = 5 }
Assert-Equal 'resolve: ACL 拒否はそのまま報告' 'ACCESS_DENIED' (Invoke-Resolve -Segments @('sub')).Reason

Set-BaseFs; $script:FakeFs['C:\Users\a\Documents\sub'] = @{ Attr = 1040; Tag = $tagSymlink }
Assert-Equal 'resolve: 中間の symlink' 'REPARSE_REJECTED' (Invoke-Resolve -Segments @('sub', 'x')).Reason
Set-BaseFs; $script:FakeFs['C:\Users'] = @{ Attr = 1040; Tag = $tagMount }
Assert-Equal 'resolve: プロファイルより上の junction' 'REPARSE_REJECTED' (Invoke-Resolve).Reason
Set-BaseFs; $script:FakeFs['C:\Users\a\Documents\sub\x'] = @{ Attr = 1040; Tag = $tagMount }
Assert-Equal 'resolve: 対象自体の junction' 'REPARSE_REJECTED' (Invoke-Resolve -Segments @('sub', 'x')).Reason

Set-BaseFs; $script:FakeFs['C:\Users\a\Documents\sub'] = @{ Final = '\\?\C:\Windows\System32' }
Assert-Equal 'resolve: 最終パスが起点の外' 'OUT_OF_SCOPE' (Invoke-Resolve -Segments @('sub')).Reason
Set-BaseFs; $script:FakeFs['C:\Users\a\Documents\sub'] = @{ Final = '\\?\UNC\server\share' }
Assert-Equal 'resolve: 最終パスが UNC' 'OUT_OF_SCOPE' (Invoke-Resolve -Segments @('sub')).Reason
Set-BaseFs; $script:FakeFs['C:\Users\a\Documents'] = @{ Final = '\\?\D:\Elsewhere' }
Assert-Equal 'resolve: 起点の最終パスがプロファイル外' 'OUT_OF_SCOPE' (Invoke-Resolve).Reason
Set-BaseFs
Assert-Equal 'resolve: 起点がプロファイル外' 'OUT_OF_SCOPE' (Invoke-Resolve -ProfilePath 'C:\Users\b').Reason
Assert-Equal 'resolve: プロファイル不明' 'OUT_OF_SCOPE' (Invoke-Resolve -ProfilePath '').Reason
Assert-Equal 'resolve: プロファイルがドライブ直下' 'OUT_OF_SCOPE' (Invoke-Resolve -ProfilePath 'C:\').Reason
Assert-Equal 'resolve: 起点がドライブ直下' 'OUT_OF_SCOPE' (Invoke-Resolve -Base 'C:\').Reason
Assert-Equal 'resolve: 起点が UNC' 'OUT_OF_SCOPE' (Invoke-Resolve -Base '\\server\share\Documents').Reason

# OneDrive へのリダイレクト
function Set-OneDriveFs {
  param([string]$OneDriveRoot = 'D:\Cloud\OneDrive')
  Set-BaseFs
  $script:FakeFs['D:\'] = @{}
  $script:FakeFs['D:\Cloud'] = @{}
  $script:FakeFs[$OneDriveRoot] = @{ Attr = 1040; Tag = $tagCloud }
  $script:FakeFs[($OneDriveRoot + '\Documents')] = @{ Attr = 1040; Tag = $tagCloud }
  $script:FakeFs[($OneDriveRoot + '\Documents\sub')] = @{ Attr = 1040; Tag = $tagCloudVariant }
}
Set-OneDriveFs
$r = Invoke-Resolve -Base 'D:\Cloud\OneDrive\Documents' -Segments @('sub') -OneDrive 'D:\Cloud\OneDrive'
Assert-Equal 'onedrive: UserFolder 配下は可' $null $r.Reason
Assert-Equal 'onedrive: 最終パス' 'D:\Cloud\OneDrive\Documents\sub' $r.TargetFinal
Assert-Equal 'onedrive: UserFolder 未設定なら不可' 'REPARSE_REJECTED' (Invoke-Resolve -Base 'D:\Cloud\OneDrive\Documents').Reason
Assert-Equal 'onedrive: UserFolder がドライブ直下なら範囲にしない' 'REPARSE_REJECTED' (Invoke-Resolve -Base 'D:\Cloud\OneDrive\Documents' -OneDrive 'D:\').Reason
Set-OneDriveFs; $script:FakeFs['D:\Cloud\OneDrive\Documents\sub'] = @{ Attr = 1040; Tag = $tagSymlink }
Assert-Equal 'onedrive: 配下の symlink は不可' 'REPARSE_REJECTED' (Invoke-Resolve -Base 'D:\Cloud\OneDrive\Documents' -Segments @('sub') -OneDrive 'D:\Cloud\OneDrive').Reason
Set-OneDriveFs; $script:FakeFs['D:\Other'] = @{}
Assert-Equal 'onedrive: 別の場所への起点は不可' 'OUT_OF_SCOPE' (Invoke-Resolve -Base 'D:\Other' -OneDrive 'D:\Cloud\OneDrive').Reason

# ---------------------------------------------------------------------------
# 名前のサニタイズと一覧の整形
# ---------------------------------------------------------------------------
Assert-Equal 'name: そのまま' '資料 2026.txt' (ConvertTo-SafeEntryName -Name '資料 2026.txt')
Assert-Equal 'name: 絵文字は残す' 'テスト😀' (ConvertTo-SafeEntryName -Name 'テスト😀')
Assert-Equal 'name: 制御文字' 'ab' (ConvertTo-SafeEntryName -Name ("a`n`r`t" + [char]1 + 'b'))
Assert-Equal 'name: DEL と C1' 'ab' (ConvertTo-SafeEntryName -Name ('a' + [char]0x7F + [char]0x85 + 'b'))
Assert-Equal 'name: 孤立上位サロゲート' 'ab' (ConvertTo-SafeEntryName -Name ('a' + [char]0xD83D + 'b'))
Assert-Equal 'name: 孤立下位サロゲート' 'ab' (ConvertTo-SafeEntryName -Name ('a' + [char]0xDE00 + 'b'))
Assert-Equal 'name: 文字方向の偽装' 'atxt.exe' (ConvertTo-SafeEntryName -Name ('a' + [char]0x202E + 'txt.exe'))
Assert-Equal 'name: 書式文字のみ' '[unprintable]' (ConvertTo-SafeEntryName -Name ([string][char]0x202E + [char]1))

Assert-Equal 'type: ファイル' 'file' (Get-EntryType -Attributes 32 -Tag 0)
Assert-Equal 'type: フォルダ' 'directory' (Get-EntryType -Attributes 16 -Tag 0)
Assert-Equal 'type: symlink' 'link' (Get-EntryType -Attributes 1040 -Tag $tagSymlink)
Assert-Equal 'type: junction' 'link' (Get-EntryType -Attributes 1040 -Tag $tagMount)
Assert-Equal 'type: クラウドのフォルダ' 'directory' (Get-EntryType -Attributes 1040 -Tag $tagCloud)
Assert-Equal 'type: クラウドのファイル' 'file' (Get-EntryType -Attributes 1056 -Tag $tagCloud)
Assert-Equal 'type: 属性なしならタグを無視' 'file' (Get-EntryType -Attributes 32 -Tag $tagSymlink)
Assert-Equal 'attrs: なし' '{}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes 32))
Assert-Equal 'attrs: hidden' '{"hidden":true}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes 34))
Assert-Equal 'attrs: recall on data' '{"cloudOnly":true}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes 4194304))
Assert-Equal 'attrs: recall on open' '{"cloudOnly":true}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes 262144))
Assert-Equal 'attrs: offline' '{"cloudOnly":true}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes 4096))
Assert-Equal 'attrs: 全部' '{"reparse":true,"cloudOnly":true,"hidden":true}' (ConvertTo-HelperJson -Value (Get-EntryAttrs -Attributes (1024 + 4096 + 2)))
Assert-Equal 'filetime: 既知の値' '2021-01-01T00:00:00.000Z' (ConvertFrom-RawFileTime -FileTime 132539328000000000)
Assert-Equal 'filetime: 0' $null (ConvertFrom-RawFileTime -FileTime 0)
Assert-Equal 'filetime: 負' $null (ConvertFrom-RawFileTime -FileTime -1)
Assert-Equal 'filetime: 範囲外' $null (ConvertFrom-RawFileTime -FileTime ([long]::MaxValue))

$rawFile = [pscustomobject]@{ Name = 'a.txt'; Attributes = [uint32]32; ReparseTag = [uint32]0; Size = 5000000000L; LastWriteFileTime = 132539328000000000L }
Assert-Equal 'entry: キー順と 32bit 超のサイズ' '{"name":"a.txt","type":"file","size":5000000000,"modifiedAt":"2021-01-01T00:00:00.000Z","attrs":{}}' (ConvertTo-HelperJson -Value (ConvertTo-ListEntry -Raw $rawFile))
$rawDir = [pscustomobject]@{ Name = 'd'; Attributes = [uint32]16; ReparseTag = [uint32]0; Size = 0L; LastWriteFileTime = 0L }
Assert-Equal 'entry: フォルダの size は null' '{"name":"d","type":"directory","size":null,"modifiedAt":null,"attrs":{}}' (ConvertTo-HelperJson -Value (ConvertTo-ListEntry -Raw $rawDir))

# ---------------------------------------------------------------------------
# 上限
# ---------------------------------------------------------------------------
$l = Resolve-ListLimits -Op ([pscustomobject]@{ maxEntries = 10; maxBytes = 1000; maxSeconds = 3 })
Assert-Equal 'limits: 小さい値は採用' '10/1000/3' ('{0}/{1}/{2}' -f $l.MaxEntries, $l.MaxBytes, $l.MaxSeconds)
$l = Resolve-ListLimits -Op ([pscustomobject]@{ maxEntries = 99999; maxBytes = 9999999; maxSeconds = 999 })
Assert-Equal 'limits: 大きい値は固定上限' '500/32768/15' ('{0}/{1}/{2}' -f $l.MaxEntries, $l.MaxBytes, $l.MaxSeconds)
$l = Resolve-ListLimits -Op ([pscustomobject]@{ maxEntries = 0; maxBytes = -1; maxSeconds = '5' })
Assert-Equal 'limits: 不正な値は固定上限' '500/32768/15' ('{0}/{1}/{2}' -f $l.MaxEntries, $l.MaxBytes, $l.MaxSeconds)
$l = Resolve-ListLimits -Op ([pscustomobject]@{})
Assert-Equal 'limits: 省略は固定上限' '500/32768/15' ('{0}/{1}/{2}' -f $l.MaxEntries, $l.MaxBytes, $l.MaxSeconds)

function New-FakeLister {
  param([object[]]$Items, [int]$EndError = 18, [int]$OpenError = 0)
  $lister = [pscustomobject]@{ Items = $Items; Index = 0; LastError = $OpenError; EndError = $EndError; Disposed = $false }
  $lister | Add-Member -MemberType ScriptMethod -Name Next -Value {
    if ($this.Index -ge $this.Items.Count) { $this.LastError = $this.EndError; return $null }
    $item = $this.Items[$this.Index]; $this.Index++; return $item
  }
  $lister | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
  return $lister
}
function New-RawItems {
  param([int]$Count)
  $items = New-Object System.Collections.Generic.List[object]
  $items.Add([pscustomobject]@{ Name = '.'; Attributes = [uint32]16; ReparseTag = [uint32]0; Size = 0L; LastWriteFileTime = 0L })
  $items.Add([pscustomobject]@{ Name = '..'; Attributes = [uint32]16; ReparseTag = [uint32]0; Size = 0L; LastWriteFileTime = 0L })
  for ($i = 0; $i -lt $Count; $i++) {
    $items.Add([pscustomobject]@{ Name = ('f{0}' -f $i); Attributes = [uint32]32; ReparseTag = [uint32]0; Size = 1L; LastWriteFileTime = 132539328000000000L })
  }
  return ,$items.ToArray()
}
$limits500 = @{ MaxEntries = 500; MaxBytes = 32768; MaxSeconds = 15 }
$noTime = { 0 }
$noCancel = { $false }

$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 3)) -Limits $limits500 -ElapsedMs $noTime -ShouldCancel $noCancel
Assert-Equal 'list: . と .. を除く' 3 $read.Accumulator.Entries.Count
Assert-False 'list: 切り詰めなし' $read.Accumulator.Truncated

$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 400)) -Limits @{ MaxEntries = 400; MaxBytes = 1000000; MaxSeconds = 15 } -ElapsedMs $noTime -ShouldCancel $noCancel
Assert-Equal 'list: 件数上限ちょうど' 400 $read.Accumulator.Entries.Count
Assert-False 'list: 件数上限ちょうどは切り詰めなし' $read.Accumulator.Truncated

$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 501)) -Limits @{ MaxEntries = 500; MaxBytes = 1000000; MaxSeconds = 15 } -ElapsedMs $noTime -ShouldCancel $noCancel
Assert-Equal 'list: 501 件目で停止' 500 $read.Accumulator.Entries.Count
Assert-True 'list: 件数超過は truncated' $read.Accumulator.Truncated

# バイト上限の境界: エントリ 2 件の JSON 長ちょうどで収まり、1 バイト少ないと 1 件になる
$sampleA = [ordered]@{ name = 'あ'; n = 1 }
$sampleB = [ordered]@{ name = 'b'; n = 2 }
$lenA = [Text.Encoding]::UTF8.GetByteCount((ConvertTo-HelperJson -Value $sampleA))
$lenB = [Text.Encoding]::UTF8.GetByteCount((ConvertTo-HelperJson -Value $sampleB))
$exact = 2 + ($lenA + 1) + ($lenB + 1)
Assert-Equal 'bytes: UTF-8 で数える' 3 ([Text.Encoding]::UTF8.GetByteCount('あ'))
$acc = New-ListAccumulator -MaxEntries 500 -MaxBytes $exact
Assert-True 'bytes: 1 件目' (Add-ListEntry -Accumulator $acc -Entry $sampleA)
Assert-True 'bytes: 上限ちょうどは可' (Add-ListEntry -Accumulator $acc -Entry $sampleB)
Assert-False 'bytes: 上限ちょうどは切り詰めなし' $acc.Truncated
Assert-Equal 'bytes: 実際の直列化に末尾区切り 1 を足した値' $exact (1 + [Text.Encoding]::UTF8.GetByteCount((ConvertTo-HelperJson -Value $acc.Entries.ToArray())))
$acc = New-ListAccumulator -MaxEntries 500 -MaxBytes ($exact - 1)
Assert-True 'bytes: 1 件目（1 少ない）' (Add-ListEntry -Accumulator $acc -Entry $sampleA)
Assert-False 'bytes: 1 バイト超過は不可' (Add-ListEntry -Accumulator $acc -Entry $sampleB)
Assert-True 'bytes: 超過は truncated' $acc.Truncated

$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 2000)) -Limits $limits500 -ElapsedMs $noTime -ShouldCancel $noCancel
Assert-True 'list: 既定の上限で truncated' $read.Accumulator.Truncated
Assert-True 'list: 既定の上限内' ($read.Accumulator.Entries.Count -le 500)

$script:Clock = 0L
$tick = { $script:Clock += 1000; return $script:Clock }
$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 100)) -Limits @{ MaxEntries = 500; MaxBytes = 32768; MaxSeconds = 3 } -ElapsedMs $tick -ShouldCancel $noCancel
Assert-True 'time: 超過は truncated' $read.Accumulator.Truncated
Assert-Equal 'time: 3 秒で停止' 2 $read.Accumulator.Entries.Count

$script:Clock = 0L
$script:CancelCalls = 0
$read = Read-DirectoryEntries -Lister (New-FakeLister -Items (New-RawItems -Count 100)) -Limits @{ MaxEntries = 500; MaxBytes = 32768; MaxSeconds = 60 } -ElapsedMs $tick -ShouldCancel { $script:CancelCalls++; $true } -CancelCheckMs 3000
Assert-True 'cancel: 列挙中に検知' $read.Cancelled
Assert-Equal 'cancel: 1 回で止まる' 1 $script:CancelCalls

# ---------------------------------------------------------------------------
# Invoke-ListOperation（列挙前後の再確認）
# ---------------------------------------------------------------------------
function New-OpDeps {
  param([object]$Lister, [scriptblock]$OnList = $null, [scriptblock]$ShouldCancel = { $false }, [bool]$Expired = $false)
  $script:DepsLister = $Lister
  $script:DepsOnList = $OnList
  $script:DepsExpired = $Expired
  $script:SearchPath = $null
  return @{
    Probe           = $fakeProbe
    OpenLister      = { param($p) $script:SearchPath = $p; if ($null -ne $script:DepsOnList) { & $script:DepsOnList }; return $script:DepsLister }
    GetKnownFolder  = { param($root) 'C:\Users\a\' + $root }
    GetProfilePath  = { 'C:\Users\a' }
    GetOneDrivePath = { $null }
    ElapsedMs       = { 1 }
    ShouldCancel    = $ShouldCancel
    IsExpired       = { $script:DepsExpired }
  }
}
Set-BaseFs
$lister = New-FakeLister -Items (New-RawItems -Count 2)
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister $lister)
Assert-Equal 'op-run: ok' 'ok' $outcome.Status
Assert-Equal 'op-run: 件数' 2 @($outcome.Entries).Count
Assert-Equal 'op-run: 最終パスのワイルドカードで列挙' '\\?\C:\Users\a\Documents\sub\*' $script:SearchPath
Assert-True 'op-run: 列挙ハンドルを閉じる' $lister.Disposed

Set-BaseFs
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @()) -Deps (New-OpDeps -Lister (New-FakeLister -Items (New-RawItems -Count 1)))
Assert-Equal 'op-run: 空の segments' 'ok' $outcome.Status
Set-BaseFs
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister (New-FakeLister -Items @() -OpenError 5))
Assert-Equal 'op-run: 列挙の ACL 拒否' 'ACCESS_DENIED' $outcome.Reason
Set-BaseFs
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister (New-FakeLister -Items (New-RawItems -Count 2) -EndError 5))
Assert-Equal 'op-run: 途中の失敗は部分結果を返さない' 'ACCESS_DENIED' $outcome.Reason
Assert-Equal 'op-run: 途中の失敗は 0 件' 0 @($outcome.Entries).Count

# 列挙中に祖先が差し替えられた場合
Set-BaseFs
$swap = { $script:FakeFs['C:\Users\a\Documents\sub'] = @{ Attr = 1040; Tag = $tagMount } }
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister (New-FakeLister -Items (New-RawItems -Count 2)) -OnList $swap)
Assert-Equal 'op-run: 列挙後の差し替えを検知' 'PATH_CHANGED' $outcome.Reason
Assert-Equal 'op-run: 差し替え時は 0 件' 0 @($outcome.Entries).Count

Set-BaseFs
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister (New-FakeLister -Items (New-RawItems -Count 2)) -Expired $true)
Assert-Equal 'op-run: 列挙後に期限切れ' 'EXPIRED' $outcome.Reason

Set-BaseFs
$script:FakeFs['C:\Users\a\Documents\sub'] = @{ Attr = 1040; Tag = $tagSymlink }
$outcome = Invoke-ListOperation -Op (New-SignedOp -Segments @('sub')) -Deps (New-OpDeps -Lister (New-FakeLister -Items (New-RawItems -Count 2)))
Assert-Equal 'op-run: リンクは列挙しない' 'REPARSE_REJECTED' $outcome.Reason
Assert-Equal 'op-run: リンクは列挙を開かない' $null $script:SearchPath

# ---------------------------------------------------------------------------
# poll の状態
# ---------------------------------------------------------------------------
$state = New-PollState
Update-PollState -State $state -Response (ConvertFrom-HelperJson -Json '{"ops":[{"opId":"a-1"},{"opId":"a-2"},{"opId":"bad/id"}],"cancel":["z-9"],"revoked":false}')
Assert-Equal 'poll: 不正な opId は捨てる' 2 $state.Queue.Count
Assert-True 'poll: cancel を記録' $state.Cancelled.Contains('z-9')
Assert-False 'poll: 失効なし' $state.Revoked
Update-PollState -State $state -Response (ConvertFrom-HelperJson -Json '{"ops":[{"opId":"a-1"}],"cancel":[],"revoked":false}')
Assert-Equal 'poll: 同じ opId は再実行しない' 2 $state.Queue.Count
Update-PollState -State $state -Response (ConvertFrom-HelperJson -Json '{"ops":[],"cancel":[],"revoked":"true"}')
Assert-False 'poll: revoked は bool のみ' $state.Revoked
Update-PollState -State $state -Response (ConvertFrom-HelperJson -Json '{"ops":{"opId":"a-3"},"cancel":"x","revoked":1}')
Assert-Equal 'poll: 配列でない ops は無視' 2 $state.Queue.Count
Assert-False 'poll: 数値の revoked は無視' $state.Revoked
Update-PollState -State $state -Response (ConvertFrom-HelperJson -Json '{"ops":[],"cancel":[],"revoked":true}')
Assert-True 'poll: 失効' $state.Revoked

Assert-Equal 'backoff: 通常' 5 (Get-NextPollDelay -Failures 0)
Assert-Equal 'backoff: 1 回失敗' 10 (Get-NextPollDelay -Failures 1)
Assert-Equal 'backoff: 上限' 120 (Get-NextPollDelay -Failures 20)
Assert-Equal 'backoff: Retry-After' 60 (Get-NextPollDelay -Failures 1 -RetryAfterSeconds 60)
Assert-Equal 'backoff: Retry-After も上限まで' 120 (Get-NextPollDelay -Failures 1 -RetryAfterSeconds 9999)

# ---------------------------------------------------------------------------
# 結果ボディ
# ---------------------------------------------------------------------------
$body = New-ResultBody -ActorSid 'S-1-5-21-1-2-3-4' -SessionId 2 -Root 'Documents' -Status 'error' -Reason 'ACCESS_DENIED' -Truncated $false -ElapsedMs 7 -Entries @()
Assert-Equal 'result: エラー' '{"actorSid":"S-1-5-21-1-2-3-4","sessionId":2,"root":"Documents","status":"error","reason":"ACCESS_DENIED","truncated":false,"elapsedMs":7,"entries":[]}' (ConvertTo-HelperJson -Value $body)
$body = New-ResultBody -ActorSid 'S-1-5-21-1-2-3-4' -SessionId 2 -Root 'Music' -Status 'ok' -Reason $null -Truncated $true -ElapsedMs 7 -Entries @([ordered]@{ name = 'a' })
Assert-Equal 'result: 1 件でも配列' '{"actorSid":"S-1-5-21-1-2-3-4","sessionId":2,"root":"Music","status":"ok","truncated":true,"elapsedMs":7,"entries":[{"name":"a"}]}' (ConvertTo-HelperJson -Value $body)

# ---------------------------------------------------------------------------
# 起動条件・URL・命名・ログ
# ---------------------------------------------------------------------------
Assert-Equal 'startup: 正常' $null (Get-StartupRefusal -Sid 'S-1-5-21-1-2-3-1001' -IsAdministrator $false -LanguageMode 'FullLanguage')
foreach ($s in 'S-1-5-18', 'S-1-5-19', 'S-1-5-20') { Assert-Equal ('startup: ' + $s) 'SERVICE_ACCOUNT' (Get-StartupRefusal -Sid $s -IsAdministrator $false -LanguageMode 'FullLanguage') }
Assert-Equal 'startup: 昇格' 'ELEVATED' (Get-StartupRefusal -Sid 'S-1-5-21-1-2-3-1001' -IsAdministrator $true -LanguageMode 'FullLanguage')
Assert-Equal 'startup: CLM' 'NOT_FULL_LANGUAGE' (Get-StartupRefusal -Sid 'S-1-5-21-1-2-3-1001' -IsAdministrator $false -LanguageMode 'ConstrainedLanguage')
Assert-Equal 'startup: 識別子なし' 'NO_IDENTITY' (Get-StartupRefusal -Sid '' -IsAdministrator $false -LanguageMode 'FullLanguage')

Assert-True 'url: https' (Test-ServerUrl -Url 'https://helpdesk.example.com' -AllowInsecure $false)
Assert-True 'url: 末尾スラッシュ' (Test-ServerUrl -Url 'https://helpdesk.example.com/' -AllowInsecure $false)
Assert-False 'url: http は既定で不可' (Test-ServerUrl -Url 'http://helpdesk.example.com' -AllowInsecure $false)
Assert-True 'url: http は明示で可' (Test-ServerUrl -Url 'http://127.0.0.1:18950' -AllowInsecure $true)
foreach ($u in 'ftp://x.example.com', 'file:///c:/x', 'https://user:pw@x.example.com', 'https://x.example.com/api', 'https://x.example.com/?a=1', 'https://x.example.com/#f', 'https://x.example.com/" -Evil', 'not a url', '') {
  Assert-False ('url NG: ' + $u) (Test-ServerUrl -Url $u -AllowInsecure $true)
}
Assert-Equal 'url: API パス' 'https://x.example.com/api/device/agent/folder-helper/poll' (Get-HelperApiUrl -ServerBase 'https://x.example.com/' -Action 'poll')
Assert-Equal 'task: SID 末尾' 'AIHelpDesk-FolderHelper-1001' (Get-HelperTaskName -Sid 'S-1-5-21-1-2-3-1001')
$threw = $false; try { $null = Get-HelperTaskName -Sid 'bad"name' } catch { $threw = $true }
Assert-True 'task: 不正な SID は例外' $threw
Assert-Equal 'session: active' 'active' (ConvertTo-SessionStateName -State 0)
Assert-Equal 'session: disconnected' 'disconnected' (ConvertTo-SessionStateName -State 4)
Assert-Equal 'session: 失敗' 'unknown' (ConvertTo-SessionStateName -State -1)
Assert-Equal 'session: 範囲外' 'unknown' (ConvertTo-SessionStateName -State 10)
Assert-True 'heartbeat: active は送る' (Test-SessionStateReportable -State 'active')
Assert-True 'heartbeat: disconnected は送る' (Test-SessionStateReportable -State 'disconnected')
foreach ($s in 'unknown', 'connected', 'connectquery', 'init', 'down', '', $null) {
  Assert-False ('heartbeat: 送らない [' + [string]$s + ']') (Test-SessionStateReportable -State $s)
}

Assert-Equal 'log: 許可キーのみ' 'event=e opId=a-1 count=3' (Format-HelperLogLine -EventName 'e' -Fields @{ opId = 'a-1'; count = 3; path = 'C:\secret'; name = 'x.txt'; token = 'abc'; pairingCode = '12345678' })
Assert-Equal 'log: パスの形は伏せる' 'event=e reason=[redacted]' (Format-HelperLogLine -EventName 'e' -Fields @{ reason = 'C:\Users\a\secret.txt' })
Assert-Equal 'log: 空白や日本語も伏せる' 'event=e errorType=[redacted]' (Format-HelperLogLine -EventName 'e' -Fields @{ errorType = '資料 2026' })

Assert-Equal 'json: 文字列のエスケープ' '"a\"b\\c/<>&''\u0001\u001f"' (ConvertTo-JsonStringLiteral -Value ('a"b\c/<>&' + "'" + [char]1 + [char]0x1F))
Assert-Equal 'json: bool と null' '[true,false,null,1]' (ConvertTo-HelperJson -Value ([object[]]@($true, $false, $null, 1)))
$threw = $false; try { $null = ConvertTo-HelperJson -Value 1.5 } catch { $threw = $true }
Assert-True 'json: 小数は扱わない' $threw

# ---------------------------------------------------------------------------
# スクリプトの静的検査（5.1 互換・BOM・禁止事項）
# ---------------------------------------------------------------------------
foreach ($path in $helperPath, $installPath, $uninstallPath, $PSCommandPath) {
  $leaf = Split-Path -Leaf $path
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ('BOM: ' + $leaf) ($bytes.Length -gt 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $tokens = $null; $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
  Assert-Equal ('parse: ' + $leaf) 0 $parseErrors.Count
  $ps7Only = @($tokens | Where-Object { $_.Kind -in 'AndAnd', 'OrOr', 'QuestionMark', 'QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket' })
  Assert-Equal ('5.1 互換の演算子のみ: ' + $leaf) 0 $ps7Only.Count
}

$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$tokens, [ref]$parseErrors)
# コメント内の説明は対象外。実際のコードと埋め込みの C# だけを検査する。
$helperText = (@($tokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text }) -join ' ')
$envVars = @($tokens | Where-Object { $_.Kind -eq 'Variable' -and $_.Text -match '^\$env:' })
Assert-Equal 'helper: 環境変数を使わない' 0 $envVars.Count
Assert-False 'helper: GetNewClosure を使わない（-File 時に関数が見えなくなる）' ($helperText.Contains('GetNewClosure'))
foreach ($forbidden in 'Invoke-RestMethod', 'ConvertTo-Json', 'Start-Transcript', 'Get-FileHash', 'Get-Content', 'ReadFile', 'GENERIC_READ', 'runAs', 'Get-Credential', 'ConvertTo-SecureString', 'New-PSDrive', 'net use') {
  Assert-False ('helper: 使わない ' + $forbidden) ($helperText -imatch ('(?<![\w-])' + [regex]::Escape($forbidden) + '(?![\w-])'))
}

$installText = [IO.File]::ReadAllText($installPath)
Assert-True 'install: Interactive' ($installText.Contains('-LogonType Interactive'))
Assert-True 'install: Limited' ($installText.Contains('-RunLevel Limited'))
Assert-True 'install: 実行時間制限なし' ($installText.Contains('-ExecutionTimeLimit ([TimeSpan]::Zero)'))
Assert-True 'install: ウィンドウ非表示' ($installText.Contains('-WindowStyle Hidden'))
Assert-True 'install: 本人のトリガ' ($installText.Contains('-AtLogOn -User $identity.Name'))
Assert-False 'install: パスワードを扱わない' ($installText.IndexOf('-Password', [StringComparison]::OrdinalIgnoreCase) -ge 0)
Assert-False 'install: Highest にしない' ($installText.Contains('Highest'))
Assert-False 'install: タスクを本人の一覧から隠さない' ($installText -cmatch '(?m)\s-Hidden(\s|$)')
$uninstallText = [IO.File]::ReadAllText($uninstallPath)
Assert-True 'uninstall: タスク削除' ($uninstallText.Contains('Unregister-ScheduledTask'))
Assert-True 'uninstall: 失効通知' ($uninstallText.Contains("-Action 'revoke'"))
Assert-True 'uninstall: サービスアカウント拒否' ($uninstallText.Contains('RestrictedSids'))

# P/Invoke のソースは Windows PowerShell 5.1 の C# 5 コンパイラで通る必要がある。
# PowerShell 7 同梱の Roslyn があれば C# 5 として構文解析する（DllImport の実行はしない）。
$roslyn = $null
try { Add-Type -AssemblyName Microsoft.CodeAnalysis.CSharp -ErrorAction Stop; $roslyn = $true } catch { $roslyn = $false }
if ($roslyn) {
  $options = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
  $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($script:NativeSource, $options)
  $diagnostics = @($tree.GetDiagnostics() | ForEach-Object { $_.ToString() })
  Assert-Equal ('native: C# 5 で構文エラーなし ' + ($diagnostics -join ' ; ')) 0 $diagnostics.Count
  Write-Output 'INFO native: Roslyn で C# 5 構文を検査した'
} else {
  Write-Output 'SKIP native: Roslyn がない環境（Windows PowerShell 5.1 など）なので C# 5 構文検査を省略'
}
# コンパイルのみで DllImport は呼ばない。Windows PowerShell 5.1 では実際の C# 5 コンパイラでの検査になる。
$compiled = $false
try {
  if ($null -eq ('AIHelpDesk.FolderHelper.Native' -as [type])) { Add-Type -TypeDefinition $script:NativeSource -Language CSharp -ErrorAction Stop }
  $compiled = ($null -ne ('AIHelpDesk.FolderHelper.Native' -as [type]))
} catch {
  Write-Output ('compile error: ' + $_.Exception.Message)
}
Assert-True ('native: コンパイルできる（' + $PSVersionTable.PSEdition + '）') $compiled

Write-Output ('passed={0} failed={1}' -f $script:Passed, $script:Failed)
if ($script:Failed -gt 0) { exit 1 }
exit 0
