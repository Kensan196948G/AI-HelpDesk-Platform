#Requires -Version 5.1
<#
.SYNOPSIS
  skill_run（docs/63）の純粋関数テスト。Pester に依存しない。Linux の pwsh でも実行できる。

.DESCRIPTION
  OS 依存部は差し替えたスタブで検証する。Job Object、トークン、stdin の受け渡し、レジストリなど
  Windows API の実挙動はこのテストでは確認できない（未実測）。

.EXAMPLE
  pwsh -NoProfile -File scripts/windows/tests/skill-run.tests.ps1
#>
param()

$ErrorActionPreference = 'Stop'
$windowsDir = Split-Path -Parent $PSScriptRoot
$skillsDir = Join-Path (Split-Path -Parent $windowsDir) 'skills/windows'
$helperPath = Join-Path $windowsDir 'folder-helper.ps1'
$summaryPath = Join-Path $skillsDir 'folder-summary.ps1'
$setPath = Join-Path $skillsDir 'user-marker-set.ps1'
$clearPath = Join-Path $skillsDir 'user-marker-clear.ps1'
$statusPath = Join-Path $skillsDir 'user-marker-status.ps1'
$diagPath = Join-Path $skillsDir 'diag-sleep.ps1'
$installPath = Join-Path $windowsDir 'install-assist-skills.ps1'

. $helperPath -NoMain
. $summaryPath -NoMain
. $setPath -NoMain
. $clearPath -NoMain
. $statusPath -NoMain
. $diagPath -NoMain

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
# 署名ベクトル（apps/api/src/support-session/contract.test.ts の固定ベクトルと同じ値）
# ---------------------------------------------------------------------------
$vectorToken = 'test-helper-token-not-a-secret'
$hashA = 'sha256:' + ('a' * 64)
$hashB = 'sha256:' + ('b' * 64)
$vSid = 'S-1-5-21-1000-2000-3000-1001'
$vGuid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

function New-RunOp {
  param([hashtable]$Over = @{})
  $o = [ordered]@{
    canon = 'skill_run/1'; opId = 'op-0001'; requestId = 'req-0001'; supportSessionId = 'ss-0001'; proposalId = 'prop-0001'
    stepSeq = 1; role = 'main'; sid = $vSid; sessionId = 2; machineGuid = $vGuid; operation = 'skill_run'
    skillId = 'folder.summary'; skillVersion = '1.0.0'; contentHash = $hashA; scriptHash = $hashB
    paramsJson = '{"target":"T1"}'; targetRoot = 'Documents'; targetSegments = [object[]]@()
    startNonce = 'nonce-0001-not-a-secret'; expiresAt = '2026-11-01T00:00:00.000Z'; maxSeconds = 60; maxOutputBytes = 8192
  }
  foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
  return [pscustomobject]$o
}

function New-SignedRunOp {
  param([hashtable]$Over = @{})
  $op = New-RunOp -Over $Over
  $sig = Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $op)
  $op | Add-Member -NotePropertyName 'sig' -NotePropertyValue $sig
  return $op
}

$v1Canonical = '{"canon":"skill_run/1","opId":"op-0001","requestId":"req-0001","supportSessionId":"ss-0001","proposalId":"prop-0001","stepSeq":1,"role":"main","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"machineGuid":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","operation":"skill_run","skillId":"folder.summary","skillVersion":"1.0.0","contentHash":"' + $hashA + '","scriptHash":"' + $hashB + '","paramsJson":"{\"target\":\"T1\"}","targetRoot":"Documents","targetSegments":[],"startNonce":"nonce-0001-not-a-secret","expiresAt":"2026-11-01T00:00:00.000Z","maxSeconds":60,"maxOutputBytes":8192}'
$op = New-RunOp
Assert-Equal 'canon: contract.test.ts の正準形' $v1Canonical (Get-SkillRunCanonicalJson -Op $op)
Assert-Equal 'canon: ベクトル フォルダ対象' 'f00c3a5a6e12c1dd71e9f072dc81576018de2d2df6af6da48d556f2ccd297ee5' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $op))
$op2 = New-RunOp -Over @{ opId = 'op-0002'; targetSegments = [object[]]@('資料', '2026年度 計画', 'テスト😀') }
Assert-Equal 'canon: ベクトル 非 ASCII' 'a489c7af6f413e16a2aa330a2c658f3415df26c8c7ea7a27c8d415109a2d824d' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $op2))
$op3 = New-RunOp -Over @{ opId = 'op-0003'; role = 'verify'; skillId = 'user.marker.status'; paramsJson = '{}'; targetRoot = $null }
Assert-Equal 'canon: ベクトル 対象なし・確認操作' 'd482093fffe5496ead5c5f5de4bfa84f14ad4ba1375d4edee89827ffb389f03f' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $op3))
# contract.test.ts の op-0004: canonicalParamsJson の結果を paramsJson として文字列のまま署名する
$quoteText = 'q"b\s/<&>' + "'"
$paramsSpecial = ConvertTo-HelperJson -Value (ConvertTo-SortedParams -Params ([pscustomobject][ordered]@{ z = $quoteText; a = 1; m = $true }))
Assert-Equal 'canon: params の正準形' ('{"a":1,"m":true,"z":"q\"b\\s/<&>' + "'" + '"}') $paramsSpecial
$op4 = New-RunOp -Over @{ opId = 'op-0004'; paramsJson = $paramsSpecial; targetSegments = [object[]]@($quoteText, ("`n`t" + [char]8 + [char]12 + "`r" + [char]1 + [char]0x7F), ([string][char]0x2028 + [char]0x2029 + [char]0xE9)) }
Assert-Equal 'canon: ベクトル エスケープの境界' 'b211f49c9bf231fe93abfc2e0b3cd0eed4c4650adaedd8c492b9e0cba3bbda44' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $op4))

$fromJson = ConvertFrom-HelperJson -Json $v1Canonical
Assert-Equal 'canon: JSON 読込後も同じ' 'f00c3a5a6e12c1dd71e9f072dc81576018de2d2df6af6da48d556f2ccd297ee5' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-SkillRunCanonicalJson -Op $fromJson))
Assert-True 'canon: expiresAt は文字列' ($fromJson.expiresAt -is [string])

$sorted = ConvertTo-SortedParams -Params ([pscustomobject][ordered]@{ b = 1; a = 2; Z = 3; _x = $true })
Assert-Equal 'params: 序数順（大文字が先）' 'Z,_x,a,b' (@($sorted.Keys) -join ',')
foreach ($badCase in @(
    @{ n = '小数'; v = [pscustomobject]@{ a = 1.5 } },
    @{ n = '配列'; v = [pscustomobject]@{ a = @(1) } },
    @{ n = 'null'; v = [pscustomobject]@{ a = $null } },
    @{ n = '入れ子'; v = [pscustomobject]@{ a = [pscustomobject]@{ b = 1 } } },
    @{ n = '範囲外'; v = [pscustomobject]@{ a = [long]9007199254740992 } },
    @{ n = '文字列本体'; v = 'x' }
  )) {
  $threw = $false
  try { $null = ConvertTo-SortedParams -Params $badCase.v } catch { $threw = $true }
  Assert-True ('params: 拒否 ' + $badCase.n) $threw
}

foreach ($badField in @(@{ sessionId = '2' }, @{ maxSeconds = '30' }, @{ stepSeq = '1' }, @{ targetSegments = 'a' }, @{ targetRoot = 1 }, @{ skillId = 1 }, @{ paramsJson = @{} })) {
  $threw = $false
  try { $null = Get-SkillRunCanonicalJson -Op (New-RunOp -Over $badField) } catch { $threw = $true }
  Assert-True ('canon: 型違いは例外 ' + (@($badField.Keys) -join ',')) $threw
}

# list_metadata の正準形と署名は変わらない
$listOp = [pscustomobject][ordered]@{ opId = 'op-0001'; requestId = 'req-0001'; sid = 'S-1-5-21-1000-2000-3000-1001'; sessionId = 2; root = 'Documents'; segments = [object[]]@(); operation = 'list_metadata'; expiresAt = '2026-11-01T00:00:00.000Z' }
Assert-Equal 'list: 既存ベクトルは不変' 'b70e5c50b8a96ed675de7f16e4eed2f0d001649d7564be1e606ff31691342ad9' (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $listOp))

# ドメイン分離: skill_run の op は list の検証を通らない。未知の種別は BAD_OP のまま。
$now = [DateTimeOffset]::Parse('2026-10-31T00:00:00Z')
$listCtx = @{ Sid = $vSid; SessionId = 2; SessionState = 'active'; NowUtc = $now; IsElevated = $false }
Assert-Equal 'list: skill_run は Get-OpRefusal で BAD_OP' 'BAD_OP' (Get-OpRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context $listCtx)
$unknown = [pscustomobject][ordered]@{ opId = 'op-9'; requestId = 'r'; sid = $vSid; sessionId = 2; root = 'Documents'; segments = [object[]]@(); operation = 'delete_all'; expiresAt = '2026-11-01T00:00:00.000Z' }
$unknown | Add-Member -NotePropertyName 'sig' -NotePropertyValue (Get-HmacSha256Hex -Key $vectorToken -Message (Get-CanonicalOpJson -Op $unknown))
Assert-Equal 'list: 未知の種別は BAD_OP' 'BAD_OP' (Get-OpRefusal -Op $unknown -Token $vectorToken -Context $listCtx)

# poll: skillOps を受け、capabilities を申告する
$pollState = New-PollState
Update-PollState -State $pollState -Response (ConvertFrom-HelperJson -Json '{"ops":[{"opId":"l-1"}],"skillOps":[{"opId":"s-1"},{"opId":"bad/id"}],"cancel":[],"revoked":false}')
Assert-Equal 'poll: ops と skillOps を受ける' 2 $pollState.Queue.Count
Update-PollState -State $pollState -Response (ConvertFrom-HelperJson -Json '{"ops":[],"skillOps":[{"opId":"s-1"}],"cancel":[],"revoked":false}')
Assert-Equal 'poll: skillOps も再実行しない' 2 $pollState.Queue.Count
Assert-Equal 'poll: capabilities' ('{"sid":"' + $vSid + '","sessionId":2,"sessionState":"active","capabilities":["skill_run/1"]}') (New-PollBodyJson -Sid $vSid -SessionId 2 -SessionState 'active')

# ---------------------------------------------------------------------------
# 実行前の検証
# ---------------------------------------------------------------------------
function New-RunContext {
  param([hashtable]$Over = @{})
  $c = @{ Sid = $vSid; SessionId = 2; SessionState = 'active'; NowUtc = $now; IsElevated = $false; IntegrityRid = 0x2000; MachineGuid = $vGuid.ToUpperInvariant() }
  foreach ($k in $Over.Keys) { $c[$k] = $Over[$k] }
  return $c
}

$markerOver = @{ skillId = 'user.marker.set'; paramsJson = '{"value":"VERIFY_A"}'; targetRoot = $null }
Assert-Equal 'refuse: 正常（GUID は大文字小文字を区別しない）' $null (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: 鍵違い' 'BAD_SIGNATURE' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token 'other-token' -Context (New-RunContext))
foreach ($tamper in @(@{ k = 'maxSeconds'; v = 61 }, @{ k = 'scriptHash'; v = $hashA }, @{ k = 'paramsJson'; v = '{"target":"T2"}' }, @{ k = 'startNonce'; v = 'other-nonce-not-a-secret' }, @{ k = 'role'; v = 'verify' }, @{ k = 'targetSegments'; v = [object[]]@('a') })) {
  $tampered = New-SignedRunOp
  $tampered.($tamper.k) = $tamper.v
  Assert-Equal ('refuse: 改ざん ' + $tamper.k) 'BAD_SIGNATURE' (Get-SkillRunRefusal -Op $tampered -Token $vectorToken -Context (New-RunContext))
}
$upper = New-SignedRunOp; $upper.sig = $upper.sig.ToUpperInvariant()
Assert-Equal 'refuse: 大文字の署名' 'BAD_SIGNATURE' (Get-SkillRunRefusal -Op $upper -Token $vectorToken -Context (New-RunContext))
$noField = New-RunOp; $noField | Add-Member -NotePropertyName 'sig' -NotePropertyValue ('0' * 64); $noField.PSObject.Properties.Remove('paramsJson')
Assert-Equal 'refuse: 署名対象の欠落' 'BAD_OP' (Get-SkillRunRefusal -Op $noField -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: canon の版違い' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ canon = 'skill_run/2' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: operation 違い' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ operation = 'list_metadata' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: 昇格' 'ELEVATED' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ IsElevated = $true }))
Assert-Equal 'refuse: 整合性 High' 'ELEVATED' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ IntegrityRid = 0x3000 }))
Assert-Equal 'refuse: 整合性 System' 'ELEVATED' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ IntegrityRid = 0x4000 }))
Assert-Equal 'refuse: 整合性不明' 'ELEVATED' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ IntegrityRid = -1 }))
Assert-Equal 'refuse: SYSTEM' 'ELEVATED' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ sid = 'S-1-5-18' }) -Token $vectorToken -Context (New-RunContext -Over @{ Sid = 'S-1-5-18' }))
Assert-Equal 'refuse: SID 違い' 'SID_MISMATCH' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ Sid = 'S-1-5-21-9-9-9-9' }))
Assert-Equal 'refuse: セッション違い' 'SESSION_MISMATCH' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ SessionId = 3 }))
Assert-Equal 'refuse: 切断中' 'SESSION_NOT_ACTIVE' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ SessionState = 'disconnected' }))
Assert-Equal 'refuse: 期限切れ' 'EXPIRED' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ NowUtc = [DateTimeOffset]::Parse('2026-11-01T00:00:00Z') }))
Assert-Equal 'refuse: 期限の形式' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ expiresAt = 'soon' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: MachineGuid 違い' 'DEVICE_MISMATCH' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ MachineGuid = 'ffffffff-1111-4111-8111-aaaaaaaaaaaa' }))
Assert-Equal 'refuse: MachineGuid 取得失敗' 'DEVICE_MISMATCH' (Get-SkillRunRefusal -Op (New-SignedRunOp) -Token $vectorToken -Context (New-RunContext -Over @{ MachineGuid = $null }))
Assert-Equal 'refuse: 未登録 Skill' 'SKILL_NOT_FOUND' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ skillId = 'evil.run' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: Skill ID は大文字小文字を区別' 'SKILL_NOT_FOUND' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ skillId = 'FOLDER.SUMMARY' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: scriptHash の形式' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ scriptHash = 'abc' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: contentHash の形式' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ contentHash = 'abc' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: maxSeconds 0' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ maxSeconds = 0 }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: maxOutputBytes 0' 'BAD_OP' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ maxOutputBytes = 0 }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: 対象不要の Skill に root' 'INVALID_TARGET' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ skillId = 'disk.space'; paramsJson = '{}' }) -Token $vectorToken -Context (New-RunContext))
Assert-Equal 'refuse: marker 正常' $null (Get-SkillRunRefusal -Op (New-SignedRunOp -Over $markerOver) -Token $vectorToken -Context (New-RunContext))
foreach ($r in 'Windows', 'documents') { Assert-Equal ('refuse: root ' + $r) 'INVALID_TARGET' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ targetRoot = $r }) -Token $vectorToken -Context (New-RunContext)) }
Assert-Equal 'refuse: root なし' 'INVALID_TARGET' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ targetRoot = $null }) -Token $vectorToken -Context (New-RunContext))
foreach ($seg in '..', 'a:b', 'a\b', 'NUL.txt', 'a.') {
  Assert-Equal ('refuse: セグメント ' + $seg) 'INVALID_TARGET' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ targetSegments = [object[]]@($seg) }) -Token $vectorToken -Context (New-RunContext))
}
foreach ($pj in '{"target":"T2"}', '{}', '{"path":"C:\\Windows"}', '{"target":"T1","x":1}', '[1]', 'not json', '') {
  Assert-Equal ('refuse: params ' + $pj) 'INVALID_PARAMS' (Get-SkillRunRefusal -Op (New-SignedRunOp -Over @{ paramsJson = $pj }) -Token $vectorToken -Context (New-RunContext))
}

$markerSchema = (Get-SkillDefinition -SkillId 'user.marker.set').Params
Assert-True 'schema: 正常' (Test-SkillParams -Params ([pscustomobject]@{ value = 'VERIFY_A' }) -Schema $markerSchema)
foreach ($case in @(
    @{ n = '必須なし'; p = [pscustomobject]@{} },
    @{ n = '余分'; p = [pscustomobject]@{ value = 'VERIFY_A'; x = 1 } },
    @{ n = 'enum 外'; p = [pscustomobject]@{ value = 'VERIFY_C' } },
    @{ n = 'enum の大文字小文字'; p = [pscustomobject]@{ value = 'verify_a' } },
    @{ n = '任意文字列'; p = [pscustomobject]@{ value = 'iex (evil)' } },
    @{ n = '文字列に整数'; p = [pscustomobject]@{ value = 1 } },
    @{ n = 'キーの大文字小文字'; p = [pscustomobject]@{ VALUE = 'VERIFY_A' } },
    @{ n = 'null'; p = $null }
  )) {
  Assert-False ('schema: 拒否 ' + $case.n) (Test-SkillParams -Params $case.p -Schema $markerSchema)
}
$diagSchema = (Get-SkillDefinition -SkillId 'diag.sleep').Params
Assert-True 'schema: 整数' (Test-SkillParams -Params ([pscustomobject]@{ seconds = 1; children = 0 }) -Schema $diagSchema)
foreach ($case in @(
    @{ n = '下限'; p = [pscustomobject]@{ seconds = 0; children = 0 } },
    @{ n = '上限'; p = [pscustomobject]@{ seconds = 301; children = 0 } },
    @{ n = '真偽'; p = [pscustomobject]@{ seconds = $true; children = 0 } },
    @{ n = '文字列'; p = [pscustomobject]@{ seconds = '1'; children = 0 } }
  )) {
  Assert-False ('schema: 整数の拒否 ' + $case.n) (Test-SkillParams -Params $case.p -Schema $diagSchema)
}
Assert-True 'schema: 真偽' (Test-SkillParams -Params ([pscustomobject]@{ flag = $true }) -Schema @(@{ Name = 'flag'; Type = 'bool'; Required = $true }))
Assert-False 'schema: 真偽に整数' (Test-SkillParams -Params ([pscustomobject]@{ flag = 1 }) -Schema @(@{ Name = 'flag'; Type = 'bool'; Required = $true }))

foreach ($def in $script:SkillCatalog) {
  Assert-True ('catalog: ファイル名が固定 ' + $def.Id) ($def.File -cmatch '^[a-z-]+\.ps1$')
  Assert-True ('catalog: Skill がある ' + $def.Id) (Test-Path -LiteralPath (Join-Path $skillsDir $def.File))
  foreach ($spec in $def.Params) { Assert-True ('catalog: 型は enum/int/bool のみ ' + $def.Id + '.' + $spec.Name) ($spec.Type -ceq 'enum' -or $spec.Type -ceq 'int' -or $spec.Type -ceq 'bool') }
}
Assert-Equal 'catalog: 変更操作は marker のみ' 'user.marker.clear,user.marker.set' ((@($script:SkillCatalog | Where-Object { $_.Effect -ceq 'modify' } | ForEach-Object { $_.Id }) | Sort-Object) -join ',')

# ---------------------------------------------------------------------------
# 小さな判定
# ---------------------------------------------------------------------------
Assert-Equal 'timeout: 署名値が小さい' 30 (Get-EffectiveTimeoutSeconds -Signed 30)
Assert-Equal 'timeout: 固定上限が小さい' 120 (Get-EffectiveTimeoutSeconds -Signed 9999)
Assert-Equal 'timeout: 不正値は固定上限' 120 (Get-EffectiveTimeoutSeconds -Signed 0)

function Get-StopFor {
  param([hashtable]$Over = @{})
  $a = @{ Revoked = $false; Cancelled = $false; TokenRejected = $false; SessionState = 'active'; ElapsedMs = 1000; TimeoutMs = 30000; MsSincePollOk = 0 }
  foreach ($k in $Over.Keys) { $a[$k] = $Over[$k] }
  return (Get-RunStopReason @a)
}
Assert-Equal 'stop: 継続' $null (Get-StopFor)
Assert-Equal 'stop: 失効' 'REVOKED' (Get-StopFor -Over @{ Revoked = $true; Cancelled = $true })
Assert-Equal 'stop: トークン拒否' 'TOKEN_REJECTED' (Get-StopFor -Over @{ TokenRejected = $true })
Assert-Equal 'stop: cancel' 'CANCELLED' (Get-StopFor -Over @{ Cancelled = $true })
Assert-Equal 'stop: 切断' 'SESSION_NOT_ACTIVE' (Get-StopFor -Over @{ SessionState = 'disconnected' })
Assert-Equal 'stop: 状態不明も止める' 'SESSION_NOT_ACTIVE' (Get-StopFor -Over @{ SessionState = 'unknown' })
Assert-Equal 'stop: タイムアウト' 'TIMEOUT' (Get-StopFor -Over @{ ElapsedMs = 30000 })
Assert-Equal 'stop: 通信断' 'COMM_LOST' (Get-StopFor -Over @{ MsSincePollOk = 30000 })

Assert-Equal 'child: 本人' $null (Get-ChildRefusal -ChildSid $vSid -ExpectedSid $vSid -ChildIntegrityRid 0x2000)
Assert-Equal 'child: 別人' 'CHILD_SID_MISMATCH' (Get-ChildRefusal -ChildSid 'S-1-5-18' -ExpectedSid $vSid -ChildIntegrityRid 0x2000)
Assert-Equal 'child: 取得失敗' 'CHILD_SID_MISMATCH' (Get-ChildRefusal -ChildSid $null -ExpectedSid $vSid -ChildIntegrityRid 0x2000)
Assert-Equal 'child: 昇格' 'CHILD_INTEGRITY_REJECTED' (Get-ChildRefusal -ChildSid $vSid -ExpectedSid $vSid -ChildIntegrityRid 0x3000)
Assert-Equal 'child: 整合性不明' 'CHILD_INTEGRITY_REJECTED' (Get-ChildRefusal -ChildSid $vSid -ExpectedSid $vSid -ChildIntegrityRid -1)

Assert-Equal 'partial: read' '' ((@(Get-PartialEffectCodes -Effect 'read' -InputDelivered $true -CompletedOk $false -StopFailed $false)) -join ',')
Assert-Equal 'partial: modify 未入力' '' ((@(Get-PartialEffectCodes -Effect 'modify' -InputDelivered $false -CompletedOk $false -StopFailed $false)) -join ',')
Assert-Equal 'partial: modify 完了' '' ((@(Get-PartialEffectCodes -Effect 'modify' -InputDelivered $true -CompletedOk $true -StopFailed $false)) -join ',')
Assert-Equal 'partial: modify 中断' 'PARTIAL_EFFECT_POSSIBLE' ((@(Get-PartialEffectCodes -Effect 'modify' -InputDelivered $true -CompletedOk $false -StopFailed $false)) -join ',')
Assert-Equal 'partial: 停止不能は read でも報告' 'STOP_FAILED_CHILD_RUNNING' ((@(Get-PartialEffectCodes -Effect 'read' -InputDelivered $true -CompletedOk $false -StopFailed $true)) -join ',')

foreach ($c in 'REVOKED', 'TOKEN_REJECTED', 'COMM_LOST') { Assert-Equal ('code: ' + $c) 'CANCELLED' (ConvertTo-ReportableCode -Code $c) }
Assert-Equal 'code: 子の SID' 'SID_MISMATCH' (ConvertTo-ReportableCode -Code 'CHILD_SID_MISMATCH')
Assert-Equal 'code: 子の整合性' 'ELEVATED' (ConvertTo-ReportableCode -Code 'CHILD_INTEGRITY_REJECTED')
Assert-Equal 'code: 契約のコードはそのまま' 'ACCESS_DENIED' (ConvertTo-ReportableCode -Code 'ACCESS_DENIED')
foreach ($c in 'JOB_ASSIGN_FAILED', 'SPAWN_FAILED', 'UNEXPECTED_VALUE', 'whatever', $null) { Assert-Equal ('code: 知らないコード ' + [string]$c) 'EXEC_FAILED' (ConvertTo-ReportableCode -Code $c) }

Assert-Equal 'output: 1 行 JSON' '{"a":1}' (ConvertFrom-SkillOutput -Text ('{"a":1}' + "`r`n")).Json
Assert-Equal 'output: 小数を整形しない' '{"freeGB":118.40}' (ConvertFrom-SkillOutput -Text '{"freeGB":118.40}').Json
Assert-Equal 'output: resultCode' 'ACCESS_DENIED' (ConvertFrom-SkillOutput -Text '{"resultCode":"ACCESS_DENIED"}').ResultCode
Assert-Equal 'output: 不正な resultCode は無視' $null (ConvertFrom-SkillOutput -Text '{"resultCode":"C:\\Users\\x"}').ResultCode
foreach ($bad in '', '   ', 'hello', '[1]', '{"a":1}{', ('{"a":1}' + "`n" + '{"b":2}'), $null) { Assert-Equal ('output: 拒否 [' + [string]$bad + ']') $null (ConvertFrom-SkillOutput -Text $bad) }

Assert-True 'start: started:true' (Test-StartResponse -Status 200 -Body '{"ok":true,"started":true,"opId":"x","deadlineAt":"y"}')
foreach ($case in @(@{ s = 0; b = '' }, @{ s = 200; b = '' }, @{ s = 200; b = '{"ok":true}' }, @{ s = 200; b = '{"ok":false,"started":false,"reason":"NONCE_CONSUMED"}' }, @{ s = 200; b = '{"started":"true"}' }, @{ s = 200; b = '{}' }, @{ s = 200; b = 'x' }, @{ s = 201; b = '{"started":true}' }, @{ s = 409; b = '{"started":true}' }, @{ s = 500; b = '{"started":true}' })) {
  Assert-False ('start: 開始しない ' + $case.s + ' ' + $case.b) (Test-StartResponse -Status $case.s -Body $case.b)
}

$memory = New-Object IO.MemoryStream -ArgumentList (, [Text.Encoding]::UTF8.GetBytes('abc'))
Assert-Equal 'hash: 既知の SHA-256' 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' (Get-Sha256Prefixed -Stream $memory)

$arguments = New-SkillArguments -ScriptPath 'C:\Users\a b\AppData\Local\AIHelpDesk\folder-helper\skills\x.ps1'
Assert-Equal 'args: 固定形' '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\a b\AppData\Local\AIHelpDesk\folder-helper\skills\x.ps1"' $arguments
$threw = $false; try { $null = New-SkillArguments -ScriptPath 'C:\a" -Command evil' } catch { $threw = $true }
Assert-True 'args: 引用符は例外' $threw
Assert-Equal 'stdin: params と target' '{"params":{"a":7,"b":"x"},"target":null}' (New-SkillStdinJson -Params ([pscustomobject][ordered]@{ b = 'x'; a = 7 }) -Target $null)

# ---------------------------------------------------------------------------
# C#（C# 5 で通ること。DllImport は呼ばない）
# ---------------------------------------------------------------------------
$roslyn = $false
try { Add-Type -AssemblyName Microsoft.CodeAnalysis.CSharp -ErrorAction Stop; $roslyn = $true } catch { $roslyn = $false }
foreach ($pair in @(@{ n = 'helper'; s = $script:NativeSource }, @{ n = 'folder-summary'; s = $script:SummaryNativeSource })) {
  if ($roslyn) {
    $options = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
    $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($pair.s, $options)
    $diagnostics = @($tree.GetDiagnostics() | ForEach-Object { $_.ToString() })
    Assert-Equal ('native: C# 5 構文 ' + $pair.n + ' ' + ($diagnostics -join ' ; ')) 0 $diagnostics.Count
  } else {
    Write-Output ('SKIP native: Roslyn なし ' + $pair.n)
  }
  $compiled = $true
  try { Add-Type -TypeDefinition $pair.s -Language CSharp -ErrorAction Stop } catch { $compiled = $false; Write-Output ('compile error: ' + $_.Exception.Message) }
  Assert-True ('native: コンパイルできる ' + $pair.n) $compiled
}
if ([IntPtr]::Size -eq 8) {
  Assert-Equal 'job: 拡張制限の構造体サイズ（x64）' 144 ([AIHelpDesk.FolderHelper.SkillJob]::ExtendedLimitSize())
}
Assert-Equal 'job: 会計情報の構造体サイズ' 48 ([AIHelpDesk.FolderHelper.SkillJob]::BasicAccountingSize())

$reader = New-Object AIHelpDesk.FolderHelper.BoundedReader -ArgumentList @((New-Object IO.MemoryStream -ArgumentList (, [byte[]](1..200 | ForEach-Object { [byte]65 }))), 50)
$reader.Start()
Assert-True 'reader: 終わる' $reader.Join(5000)
Assert-Equal 'reader: 上限まで保持' 50 $reader.GetBytes().Length
Assert-Equal 'reader: 上限後も読み続ける' 200 $reader.TotalBytes
Assert-True 'reader: 切り詰めを記録' $reader.Truncated
$reader = New-Object AIHelpDesk.FolderHelper.BoundedReader -ArgumentList @((New-Object IO.MemoryStream -ArgumentList (, [Text.Encoding]::UTF8.GetBytes('ok'))), 50)
$reader.Start()
$null = $reader.Join(5000)
Assert-False 'reader: 上限内は切り詰めなし' $reader.Truncated
Assert-Equal 'reader: 内容' 'ok' ([Text.Encoding]::UTF8.GetString($reader.GetBytes()))

# ---------------------------------------------------------------------------
# 実行の流れ（スタブ）。呼び出し順を $script:Calls に記録する。
# ---------------------------------------------------------------------------
$script:Calls = New-Object System.Collections.Generic.List[string]
$script:Sim = @{}

function Reset-Sim {
  param([hashtable]$Over = @{})
  $script:Calls.Clear()
  $script:Sim = @{
    RecordExists = $false; TargetReason = $null; Hash = $hashB; ScriptReason = $null
    Start = @{ Ok = $true; Status = 200 }; RecordOk = $true; LaunchReason = $null; LaunchStop = 'stopped'
    ExitAfterWaits = 1; Waits = 0; Elapsed = [long]0; StepMs = [long]1000
    PollResult = @{ Ok = $true; Status = 200 }; Revoked = $false; Cancelled = $false; SessionState = 'active'
    StopResult = @{ Stopped = $true; ExitCode = 1067 }
    Finished = @{ ExitCode = 0; Stdout = '{"accessible":true}' + "`n"; StdoutTruncated = $false; StderrBytes = 3; LeftoverStopFailed = $false }
    Handle = $null; Stdin = $null; Cap = 0; RecordEffect = $null; CancelAt = -1; RevokeAt = -1; DropAt = -1
  }
  foreach ($k in $Over.Keys) { $script:Sim[$k] = $Over[$k] }
}

function New-SimDeps {
  return @{
    RecordExists  = { param($id) $script:Calls.Add('recordExists'); $script:Sim.RecordExists }
    ResolveTarget = { param($o) $script:Calls.Add('resolve'); @{ Reason = $script:Sim.TargetReason; TargetFinal = 'C:\Users\a\Documents'; RootFinal = 'C:\Users\a\Documents' } }
    OpenScript    = {
      param($d)
      $script:Calls.Add('open')
      $script:Sim.Handle = New-Object IO.MemoryStream
      @{ Reason = $script:Sim.ScriptReason; Hash = $script:Sim.Hash; Handle = $script:Sim.Handle; Path = 'C:\s\x.ps1' }
    }
    PostStart     = { param($o) $script:Calls.Add('start'); $script:Sim.Start }
    WriteRecord   = { param($o, $eff, $at) $script:Calls.Add('record'); $script:Sim.RecordEffect = $eff; $script:Sim.RecordOk }
    Launch        = {
      param($path, $stdin, $cap)
      $script:Calls.Add('launch')
      $script:Sim.Stdin = $stdin
      $script:Sim.Cap = $cap
      if ($null -ne $script:Sim.LaunchReason) { return @{ Reason = $script:Sim.LaunchReason; Runner = $null; StopOutcome = $script:Sim.LaunchStop; ExitCode = 1067 } }
      @{ Reason = $null; Runner = @{ Fake = $true }; StopOutcome = $null; ExitCode = $null }
    }
    WaitExit      = {
      param($r, $ms)
      $script:Sim.Elapsed += $script:Sim.StepMs
      $script:Sim.Waits++
      if ($script:Sim.Waits -eq $script:Sim.CancelAt) { $script:Sim.Cancelled = $true }
      if ($script:Sim.Waits -eq $script:Sim.RevokeAt) { $script:Sim.Revoked = $true }
      if ($script:Sim.Waits -eq $script:Sim.DropAt) { $script:Sim.SessionState = 'disconnected' }
      ($script:Sim.Waits -ge $script:Sim.ExitAfterWaits)
    }
    StopRunner    = { param($r) $script:Calls.Add('kill'); $script:Sim.StopResult }
    FinishRunner  = { param($r) $script:Calls.Add('finish'); $script:Sim.Finished }
    DisposeRunner = { param($r) $script:Calls.Add('dispose') }
    Poll          = { $script:Calls.Add('poll'); $script:Sim.PollResult }
    GetStopFlags  = { @{ Revoked = $script:Sim.Revoked; Cancelled = $script:Sim.Cancelled; SessionState = $script:Sim.SessionState } }
    ElapsedMs     = { $script:Sim.Elapsed }
    NowIso        = { '2026-10-31T00:00:00.000Z' }
  }
}

function Invoke-Sim {
  param([hashtable]$Over = @{}, [hashtable]$OpOver = @{})
  Reset-Sim -Over $Over
  $simOp = New-SignedRunOp -Over $OpOver
  $outcome = Invoke-SkillRun -Op $simOp -Definition (Get-SkillDefinition -SkillId $simOp.skillId) -ActorSid $vSid -SessionId 2 -Deps (New-SimDeps)
  $body = $null
  if ($null -ne $outcome.Json) { $body = ConvertFrom-HelperJson -Json $outcome.Json }
  return @{ Action = $outcome.Action; Recorded = $outcome.Recorded; Json = $outcome.Json; Body = $body }
}

function Test-HasField { param($Body, [string]$Name) return ($null -ne $Body.PSObject.Properties[$Name]) }

$markerSim = @{ skillId = 'user.marker.set'; paramsJson = '{"value":"VERIFY_A"}'; targetRoot = $null }

$r = Invoke-Sim
Assert-Equal 'run: 順序（検証 → start → 記録 → 起動）' 'recordExists,resolve,open,start,record,launch,finish,dispose' ($script:Calls -join ',')
Assert-Equal 'run: 成功' 'ok' $r.Body.status
Assert-Equal 'run: resultCode は OK' 'OK' $r.Body.resultCode
Assert-True 'run: 記録あり' $r.Recorded
Assert-Equal 'run: 実行モードは real' 'real' $r.Body.executionMode
Assert-Equal 'run: 実行主体は OS の SID' $vSid $r.Body.actorSid
Assert-Equal 'run: skillVersion' '1.0.0' $r.Body.skillVersion
Assert-Equal 'run: scriptHash' $hashB $r.Body.scriptHash
Assert-True 'run: 出力はオブジェクトのまま' $r.Body.output.accessible
Assert-Equal 'run: 終了コード' 0 $r.Body.exitCode
Assert-False 'run: 部分変更なしなら省く' (Test-HasField $r.Body 'partialEffect')
Assert-False 'run: 停止なしなら省く' (Test-HasField $r.Body 'stopOutcome')
Assert-Equal 'run: 効果は表から' 'read' $script:Sim.RecordEffect
Assert-Equal 'run: stdin の対象' '{"params":{"target":"T1"},"target":{"root":"Documents","segments":[],"path":"C:\\Users\\a\\Documents","rootPath":"C:\\Users\\a\\Documents"}}' $script:Sim.Stdin
Assert-Equal 'run: 出力上限は署名値' 8192 $script:Sim.Cap
$r = Invoke-Sim -OpOver @{ maxOutputBytes = 1000000 }
Assert-Equal 'run: 出力上限は固定上限まで' 16384 $script:Sim.Cap

$r = Invoke-Sim -Over @{ Start = @{ Ok = $false; Status = 0 } }
Assert-Equal 'run: 応答なしは起動しない' 'recordExists,resolve,open,start' ($script:Calls -join ',')
Assert-Equal 'run: 応答なしの申告' 'rejected' $r.Body.status
Assert-Equal 'run: 応答なしのコード' 'START_NO_RESPONSE' $r.Body.resultCode
Assert-False 'run: 応答なしは記録なし' $r.Recorded
$r = Invoke-Sim -Over @{ Start = @{ Ok = $false; Status = 503 } }
Assert-Equal 'run: 5xx も起動しない' 'START_NO_RESPONSE' $r.Body.resultCode
Assert-False 'run: 5xx は launch なし' ($script:Calls.Contains('launch'))
$r = Invoke-Sim -Over @{ Start = @{ Ok = $false; Status = 409 } }
Assert-Equal 'run: 拒否は起動しない' 'recordExists,resolve,open,start' ($script:Calls -join ',')
Assert-Equal 'run: 拒否は rejected_at_start' 'rejected_at_start' $r.Action
Assert-Equal 'run: 拒否は結果を送らない' $null $r.Json

$r = Invoke-Sim -Over @{ RecordExists = $true }
Assert-Equal 'run: 記録があれば再実行しない' 'recordExists' ($script:Calls -join ',')
Assert-Equal 'run: 記録ありの動作' 'already_recorded' $r.Action

$r = Invoke-Sim -Over @{ RecordOk = $false }
Assert-Equal 'run: 記録できなければ起動しない' 'recordExists,resolve,open,start,record' ($script:Calls -join ',')
Assert-Equal 'run: 記録失敗' 'INTERNAL_ERROR' $r.Body.resultCode

$r = Invoke-Sim -Over @{ Hash = $hashA }
Assert-Equal 'run: ハッシュ不一致は start しない' 'recordExists,resolve,open' ($script:Calls -join ',')
Assert-Equal 'run: ハッシュ不一致は rejected' 'rejected' $r.Body.status
Assert-Equal 'run: ハッシュ不一致のコード' 'SCRIPT_HASH_MISMATCH' $r.Body.resultCode
Assert-False 'run: ハンドルを閉じる' $script:Sim.Handle.CanRead

$r = Invoke-Sim -Over @{ ScriptReason = 'SCRIPT_MISSING' }
Assert-Equal 'run: スクリプトなし' 'SKILL_NOT_FOUND' $r.Body.resultCode
Assert-False 'run: スクリプトなしは start しない' ($script:Calls.Contains('start'))

$r = Invoke-Sim -Over @{ LaunchReason = 'CHILD_SID_MISMATCH' } -OpOver $markerSim
Assert-Equal 'run: 子の SID 違い' 'SID_MISMATCH' $r.Body.resultCode
Assert-Equal 'run: 子の停止を報告' 'stopped' $r.Body.stopOutcome
Assert-True 'run: 起動後の失敗は記録経路' $r.Recorded
Assert-False 'run: stdin 前なので部分変更なし' (Test-HasField $r.Body 'partialEffect')
$r = Invoke-Sim -Over @{ LaunchReason = 'JOB_ASSIGN_FAILED'; LaunchStop = 'stop_failed' } -OpOver $markerSim
Assert-Equal 'run: Job に入らない' 'EXEC_FAILED' $r.Body.resultCode
Assert-Equal 'run: 止められない子を報告' 'STOP_FAILED_CHILD_RUNNING' (@($r.Body.partialEffect) -join ',')

$r = Invoke-Sim -Over @{ TargetReason = 'REPARSE_REJECTED' }
Assert-Equal 'run: 範囲外は start しない' 'recordExists,resolve' ($script:Calls -join ',')
Assert-Equal 'run: 範囲外のコード' 'INVALID_TARGET' $r.Body.resultCode
$r = Invoke-Sim -Over @{ TargetReason = 'ACCESS_DENIED' }
Assert-Equal 'run: ACL 拒否' 'ACCESS_DENIED' $r.Body.resultCode

# 停止
$r = Invoke-Sim -Over @{ ExitAfterWaits = 99; CancelAt = 3 } -OpOver $markerSim
Assert-Equal 'stop: cancel で kill してから確定' 'recordExists,open,start,record,launch,kill,finish,dispose' ($script:Calls -join ',')
Assert-Equal 'stop: cancelled' 'cancelled' $r.Body.status
Assert-Equal 'stop: cancel のコード' 'CANCELLED' $r.Body.resultCode
Assert-Equal 'stop: stopped' 'stopped' $r.Body.stopOutcome
Assert-Equal 'stop: 終了コード' 1067 $r.Body.exitCode
Assert-Equal 'stop: modify は部分変更あり得る' 'PARTIAL_EFFECT_POSSIBLE' (@($r.Body.partialEffect) -join ',')
Assert-Equal 'stop: 停止時は出力を返さない' $null $r.Body.output

$r = Invoke-Sim -Over @{ ExitAfterWaits = 99; RevokeAt = 2; StopResult = @{ Stopped = $false; ExitCode = $null } }
Assert-Equal 'stop: 失効も cancelled' 'cancelled' $r.Body.status
Assert-Equal 'stop: 失効のコード' 'CANCELLED' $r.Body.resultCode
Assert-Equal 'stop: 止まらなければ stop_failed' 'stop_failed' $r.Body.stopOutcome
Assert-Equal 'stop: 停止不能を報告' 'STOP_FAILED_CHILD_RUNNING' (@($r.Body.partialEffect) -join ',')
Assert-Equal 'stop: 終了コードなし' $null $r.Body.exitCode

$r = Invoke-Sim -Over @{ ExitAfterWaits = 99; DropAt = 2 }
Assert-Equal 'stop: ログオフ・切替で止める' 'SESSION_NOT_ACTIVE' $r.Body.resultCode

$r = Invoke-Sim -Over @{ ExitAfterWaits = 999 } -OpOver @{ maxSeconds = 3 }
Assert-Equal 'stop: タイムアウト' 'timeout' $r.Body.status
Assert-Equal 'stop: タイムアウトのコード' 'TIMEOUT' $r.Body.resultCode
Assert-Equal 'stop: タイムアウトは約 3 秒' 3000 $script:Sim.Elapsed

$r = Invoke-Sim -Over @{ ExitAfterWaits = 999 } -OpOver @{ maxSeconds = 99999 }
Assert-Equal 'stop: 固定上限でも止まる' 'TIMEOUT' $r.Body.resultCode
Assert-Equal 'stop: 上限は 120 秒' 120000 $script:Sim.Elapsed

$r = Invoke-Sim -Over @{ ExitAfterWaits = 6 }
Assert-True 'heartbeat: 実行中に poll する' ($script:Calls.Contains('poll'))
Assert-Equal 'heartbeat: 正常終了' 'ok' $r.Body.status

$r = Invoke-Sim -Over @{ ExitAfterWaits = 999; PollResult = @{ Ok = $false; Status = 0 } }
Assert-Equal 'stop: 通信断が続けば止める' 'CANCELLED' $r.Body.resultCode
Assert-Equal 'stop: 通信断の判定時間' 30000 $script:Sim.Elapsed
$r = Invoke-Sim -Over @{ ExitAfterWaits = 999; PollResult = @{ Ok = $false; Status = 401 } }
Assert-Equal 'stop: 401 なら止める' 'cancelled' $r.Body.status
Assert-Equal 'stop: 401 は 5 秒後の poll で判定' 5000 $script:Sim.Elapsed

# 子が先に終わっていても取消を受けたことを明示する
$r = Invoke-Sim -Over @{ Cancelled = $true }
Assert-Equal 'stop: 取消を受けたが動いていない' 'not_running' $r.Body.stopOutcome

# 終了後の判定
$base = @{ ExitCode = 0; Stdout = '{"a":1}'; StdoutTruncated = $false; StderrBytes = 0; LeftoverStopFailed = $false }
$f = $base.Clone(); $f.ExitCode = 2
$r = Invoke-Sim -Over @{ Finished = $f } -OpOver $markerSim
Assert-Equal 'exit: 非 0' 'error' $r.Body.status
Assert-Equal 'exit: 非 0 のコード' 'EXEC_FAILED' $r.Body.resultCode
Assert-Equal 'exit: 非 0 の modify は部分変更あり得る' 'PARTIAL_EFFECT_POSSIBLE' (@($r.Body.partialEffect) -join ',')
$f = $base.Clone(); $f.ExitCode = 1; $f.Stdout = '{"resultCode":"ACCESS_DENIED"}'
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: Skill の固定コード' 'ACCESS_DENIED' $r.Body.resultCode
$f = $base.Clone(); $f.ExitCode = 1; $f.Stdout = '{"resultCode":"UNEXPECTED_VALUE"}'
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 契約外のコードは丸める' 'EXEC_FAILED' $r.Body.resultCode
$f = $base.Clone(); $f.ExitCode = $null
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 終了コード不明は成功にしない' 'error' $r.Body.status
$f = $base.Clone(); $f.Stdout = ''
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 出力欠落は成功にしない' 'OUTPUT_INVALID' $r.Body.resultCode
$f = $base.Clone(); $f.Stdout = 'C:\Users\a\secret.txt'
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 自由文は出力にしない' $null $r.Body.output
Assert-False 'exit: 自由文は本文に入らない' ($r.Json.Contains('secret'))
$f = $base.Clone(); $f.StdoutTruncated = $true
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 切り詰めは成功にしない' 'OUTPUT_TOO_LARGE' $r.Body.resultCode
Assert-Equal 'exit: 切り詰めの出力は返さない' $null $r.Body.output
$f = $base.Clone(); $f.LeftoverStopFailed = $true
$r = Invoke-Sim -Over @{ Finished = $f }
Assert-Equal 'exit: 孫が止まらない' 'error' $r.Body.status
Assert-Equal 'exit: 孫が止まらない状態' 'stop_failed' $r.Body.stopOutcome

# 署名の検証前の拒否でも schema を満たす（未検証の値を本文へ入れない）
$forged = New-SkillNotRunOutcome -Op ([pscustomobject]@{ skillId = 'C:\evil path'; skillVersion = '$(x)'; scriptHash = 'zz' }) -ActorSid $vSid -SessionId 2 -Status 'rejected' -ResultCode 'BAD_SIGNATURE' -ElapsedMs 1 -Recorded $false
$forgedBody = ConvertFrom-HelperJson -Json $forged.Json
Assert-Equal 'body: 不正な skillId は捨てる' 'unknown' $forgedBody.skillId
Assert-Equal 'body: 不正な版は捨てる' '0' $forgedBody.skillVersion
Assert-Equal 'body: 不正なハッシュは捨てる' ('sha256:' + ('0' * 64)) $forgedBody.scriptHash

$json = New-SkillResultJson -ActorSid $vSid -SessionId 2 -SkillId 'disk.space' -SkillVersion '1.0.0' -ScriptHash $hashB -Status 'ok' -ResultCode 'OK' -ExitCode 0 -StartedAt '2026-11-01T00:00:00.000Z' -FinishedAt '2026-11-01T00:00:01.000Z' -ElapsedMs 5 -OutputJson '{"volumes":[{"freeGB":1.50}]}' -StopOutcome $null -PartialEffect @()
Assert-Equal 'body: 形（小数を保つ）' ('{"executionMode":"real","actorSid":"' + $vSid + '","sessionId":2,"skillId":"disk.space","skillVersion":"1.0.0","scriptHash":"' + $hashB + '","status":"ok","resultCode":"OK","exitCode":0,"startedAt":"2026-11-01T00:00:00.000Z","finishedAt":"2026-11-01T00:00:01.000Z","elapsedMs":5,"output":{"volumes":[{"freeGB":1.50}]}}') $json

# ---------------------------------------------------------------------------
# 再起動と報告の順序
# ---------------------------------------------------------------------------
$recordJson = New-RunRecordJson -Op (New-RunOp -Over $markerSim) -Effect 'modify' -StartedAt '2026-10-31T00:00:00.000Z'
Assert-Equal 'record: 名前・params を持たない' ('{"opId":"op-0001","skillId":"user.marker.set","skillVersion":"1.0.0","scriptHash":"' + $hashB + '","effect":"modify","startedAt":"2026-10-31T00:00:00.000Z","expiresAt":"2026-11-01T00:00:00.000Z"}') $recordJson
$report = ConvertFrom-HelperJson -Json (Get-RunReportJson -RecordJson $recordJson -ResultJson $null -ActorSid $vSid -SessionId 2 -NowIso '2026-10-31T00:00:09.000Z')
Assert-Equal 'interrupted: 状態' 'interrupted' $report.status
Assert-Equal 'interrupted: コード' 'INTERRUPTED' $report.resultCode
Assert-Equal 'interrupted: modify は部分変更あり得る' 'PARTIAL_EFFECT_POSSIBLE' (@($report.partialEffect) -join ',')
Assert-Equal 'interrupted: Skill' 'user.marker.set' $report.skillId
Assert-Equal 'interrupted: scriptHash' $hashB $report.scriptHash
Assert-Equal 'interrupted: 開始時刻' '2026-10-31T00:00:00.000Z' $report.startedAt
$readRecord = New-RunRecordJson -Op (New-RunOp) -Effect 'read' -StartedAt 's'
Assert-False 'interrupted: read は部分変更なし' (Test-HasField (ConvertFrom-HelperJson -Json (Get-RunReportJson -RecordJson $readRecord -ResultJson $null -ActorSid $vSid -SessionId 2 -NowIso 'n')) 'partialEffect')
Assert-Equal 'interrupted: 壊れた記録は部分変更あり得る' 'PARTIAL_EFFECT_POSSIBLE' (@((ConvertFrom-HelperJson -Json (Get-RunReportJson -RecordJson 'broken' -ResultJson $null -ActorSid $vSid -SessionId 2 -NowIso 'n')).partialEffect) -join ',')
Assert-Equal 'report: 保存済みの結果を優先' '{"saved":1}' (Get-RunReportJson -RecordJson $recordJson -ResultJson '{"saved":1}' -ActorSid $vSid -SessionId 2 -NowIso 'n')

foreach ($s in 200, 204, 400, 403, 404, 409, 410, 413) { Assert-True ('report: 確定 ' + $s) (Test-ReportFinal -Status $s) }
foreach ($case in @(@{ s = 200; e = 'sent' }, @{ s = 410; e = 'expired' }, @{ s = 404; e = 'rejected' }, @{ s = 403; e = 'rejected' }, @{ s = 401; e = 'retry' }, @{ s = 429; e = 'retry' }, @{ s = 503; e = 'retry' }, @{ s = 0; e = 'retry' })) {
  Assert-Equal ('report: 扱い ' + $case.s) $case.e (Get-ReportDisposition -Status $case.s)
}
Assert-Equal 'report: 報告専用の 401 は再送しない' 'rejected' (Get-ReportDisposition -Status 401 -ReportOnly $true)
Assert-Equal 'report: 報告専用の 410' 'expired' (Get-ReportDisposition -Status 410 -ReportOnly $true)
foreach ($s in 0, 401, 408, 429, 500, 503) { Assert-False ('report: 再送 ' + $s) (Test-ReportFinal -Status $s) }

$script:Sent = New-Object System.Collections.Generic.List[string]
$script:Marked = New-Object System.Collections.Generic.List[string]
$script:SendStatus = 200
$flushDeps = @{
  ListUnsent = { @('op-a', 'bad/id', 'op-b') }
  ReadReport = { param($id) if ($id -ceq 'op-b') { '' } else { '{"id":"' + $id + '"}' } }
  SendReport = { param($id, $json) $script:Sent.Add($id); @{ Status = $script:SendStatus } }
  MarkSent   = { param($id) $script:Marked.Add($id) }
}
Invoke-RunReportFlush -Deps $flushDeps
Assert-Equal 'flush: 不正な ID と空の報告は送らない' 'op-a' ($script:Sent -join ',')
Assert-Equal 'flush: 2xx で確定' 'op-a' ($script:Marked -join ',')
$script:Sent.Clear(); $script:Marked.Clear(); $script:SendStatus = 0
Invoke-RunReportFlush -Deps $flushDeps
Assert-Equal 'flush: 接続失敗でも送信は試みる' 'op-a' ($script:Sent -join ',')
Assert-Equal 'flush: 接続失敗は確定しない' '' ($script:Marked -join ',')

$script:Order = New-Object System.Collections.Generic.List[string]
$script:Unsent = @()
$revDeps = @{
  Flush = { $script:Order.Add('report') }
  OnFlushError = { param($e) $script:Order.Add('error') }
  ListUnsent = { $script:Unsent }
  RemoveToken = { $script:Order.Add('token') }
  Wait = { param($n) $script:Order.Add('wait') }
  HandOff = { $script:Order.Add('handoff') }
}
$revDone = Complete-HelperRevocation -Deps $revDeps
Assert-Equal 'revoke: 報告してからトークン削除' 'report,token' ($script:Order -join ',')
Assert-Equal 'revoke: 全件報告なら完了' 'True' ([string]$revDone)
$script:Order.Clear()
$script:Unsent = @('op-a')
$revDone = Complete-HelperRevocation -Deps $revDeps -MaxAttempts 3
Assert-Equal 'revoke: 再試行しても残れば報告専用へ移す' 'report,wait,report,wait,report,handoff' ($script:Order -join ',')
Assert-Equal 'revoke: 未報告が残れば未完了' 'False' ([string]$revDone)
$script:Order.Clear()
$failing = $revDeps.Clone(); $failing.Flush = { throw 'x' }
$revDone = Complete-HelperRevocation -Deps $failing -MaxAttempts 1
Assert-Equal 'revoke: 送信の例外でも報告専用へ移す' 'error,handoff' ($script:Order -join ',')
$script:Order.Clear()
$script:Attempts = 0
$recover = $revDeps.Clone()
$recover.Flush = { $script:Attempts++; if ($script:Attempts -ge 2) { $script:Unsent = @() }; $script:Order.Add('report') }
$revDone = Complete-HelperRevocation -Deps $recover -MaxAttempts 3
Assert-Equal 'revoke: 再試行で送れたらトークンを消す' 'report,wait,report,token' ($script:Order -join ',')

# 主ループの順序（静的に確認。kill → 報告 → トークン削除）
$helperSource = [IO.File]::ReadAllText($helperPath, [Text.Encoding]::UTF8)
$mainStart = $helperSource.IndexOf('function Invoke-HelperMain')
$revokedAt = $helperSource.IndexOf('if ($state.Revoked) {', $mainStart)
$flushAt = $helperSource.IndexOf('Invoke-HelperRevocationFlush -ServerBase', $revokedAt)
$flagAt = $helperSource.IndexOf("'revoked.flag'), 'revoked')", $revokedAt)
$tokenAt = $helperSource.IndexOf("Remove-StateFile -Name 'token.dat'", $revokedAt)
Assert-True 'main: 失効分岐は報告を先に行い、未報告なら直接トークンを消さない' ($flushAt -gt $revokedAt -and $flagAt -gt $flushAt -and ($tokenAt -lt 0 -or $tokenAt -gt $flagAt))
$flagStart = $helperSource.IndexOf("'revoked_flag_present'", $mainStart)
Assert-True 'main: 再起動時に未報告を再送する' ($helperSource.IndexOf('Invoke-HelperRevocationFlush', $flagStart) -gt $flagStart -and $helperSource.IndexOf('Invoke-HelperRevocationFlush', $flagStart) -lt $revokedAt)
$flagAt = $helperSource.IndexOf("'revoked.flag'", $revokedAt)
Assert-True 'main: 失効フラグも報告の後' ($flagAt -gt $flushAt)

# 報告専用トークンの静的な境界
$helperAst = [Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$null, [ref]$null)
$reportTokenReaders = @($helperAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -cne 'Read-HelperToken' -and $n.Extent.Text.Contains("Read-HelperToken -Name 'report-token.dat'") }, $true) | ForEach-Object { $_.Name })
Assert-Equal 'report-only: 報告専用トークンを読むのは 1 関数だけ' 'Invoke-ReportOnlyFlush' ($reportTokenReaders -join ',')
$reportFlushText = $helperAst.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-ReportOnlyFlush' }, $true).Extent.Text
foreach ($word in 'Invoke-HelperPoll', 'Invoke-SkillStartRequest', "'poll'", "/start'", 'Invoke-HelperOperation') {
  Assert-False ('report-only: 使わない ' + $word) ($reportFlushText.Contains($word))
}
$installSource = [IO.File]::ReadAllText((Join-Path $windowsDir 'install-folder-helper.ps1'), [Text.Encoding]::UTF8)
$installMove = $installSource.IndexOf('Move-RevokedTokenToReportStore')
$installFlag = $installSource.IndexOf("Remove-StateFile -Name 'revoked.flag'")
$installRegister = $installSource.IndexOf('Invoke-HelperRegistration')
Assert-True 'install: 失効済みの旧トークンを移してから登録する' ($installMove -ge 0 -and $installMove -lt $installFlag -and $installFlag -lt $installRegister)
# 導入コードの静的な境界
foreach ($case in @(@{ s = 403; b = '{"error":{"code":"ENROLL_CODE_INVALID"}}'; e = $true }, @{ s = 403; b = '{"error":{"code":"FORBIDDEN"}}'; e = $false }, @{ s = 403; b = ''; e = $false }, @{ s = 400; b = 'ENROLL_CODE_INVALID'; e = $false }, @{ s = 0; b = ''; e = $false })) {
  Assert-Equal ('enroll: 判定 ' + $case.s + ' ' + $case.b) $case.e (Test-EnrollCodeRejected -Status $case.s -Body $case.b)
}
$mainText = $helperAst.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-HelperMain' }, $true).Extent.Text
Assert-False 'enroll: 本体は登録を呼ばない' ($mainText.Contains('Invoke-HelperRegistration'))
$registrationCallers = @($helperAst.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Invoke-HelperRegistration' }, $true))
Assert-Equal 'enroll: ヘルパー内に登録の呼び出しがない' 0 $registrationCallers.Count
Assert-True 'enroll: コードは必須' ((Get-Command Invoke-HelperRegistration).Parameters['EnrollCode'].Attributes.Where({ $_ -is [Parameter] }).Mandatory -contains $true)
Assert-False 'enroll: 本体はコードを受け取らない' ($helperAst.ParamBlock.Parameters.Name.VariablePath.UserPath -contains 'EnrollCode')
$codeVarUses = @($helperAst.FindAll({ param($n) $n -is [Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -ieq 'EnrollCode' }, $true))
Assert-Equal 'enroll: 本体で使うのは引数と本文だけ' 2 $codeVarUses.Count
$installAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $windowsDir 'install-folder-helper.ps1'), [ref]$null, [ref]$null)
$installCodeUses = @($installAst.FindAll({ param($n) $n -is [Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -ieq 'EnrollCode' }, $true))
Assert-Equal 'enroll: install で使うのは引数と登録だけ' 2 $installCodeUses.Count
Assert-True 'enroll: install の引数は必須' ($installSource.Contains('[Parameter(Mandatory)][string]$EnrollCode'))
Assert-True 'enroll: 無効なコードは固定の文言で終了' ($installSource.Contains("throw '導入コードが無効です。"))

$uninstallSource = [IO.File]::ReadAllText((Join-Path $windowsDir 'uninstall-folder-helper.ps1'), [Text.Encoding]::UTF8)
Assert-True 'uninstall: 状態フォルダごと消す（両方のトークンと報告専用の記録）' ($uninstallSource.Contains('Remove-Item -LiteralPath $stateDir -Recurse -Force'))

# ---------------------------------------------------------------------------
# folder-summary
# ---------------------------------------------------------------------------
# 検査後の差し替え（ハンドルの実体で判定する）
$tagMountHandle = [Convert]::ToUInt32('A0000003', 16)
$handleDir = [uint32]16
$handleReparse = [uint32](16 + 1024)
function New-HandleInfo { param([int]$Err = 0, [uint32]$Attr, [uint32]$Tag = 0, [string]$Final) [pscustomobject]@{ Error = $Err; Attributes = $Attr; ReparseTag = $Tag; FinalPath = $Final } }
$handleTarget = 'C:\Users\u\Documents\T'
Assert-True 'handle: 検査した対象そのものなら通す' ($null -eq (Get-SummaryHandleRefusal -Info (New-HandleInfo -Attr $handleDir -Final ('\\?\' + $handleTarget)) -TargetPath $handleTarget -CloudScope $null))
Assert-Equal 'handle: 別の場所を指していれば PATH_CHANGED' 'PATH_CHANGED' (Get-SummaryHandleRefusal -Info (New-HandleInfo -Attr $handleDir -Final '\\?\C:\Windows') -TargetPath $handleTarget -CloudScope $null)
Assert-Equal 'handle: ジャンクションへ差し替えられていれば拒否' 'REPARSE_REJECTED' (Get-SummaryHandleRefusal -Info (New-HandleInfo -Attr $handleReparse -Tag $tagMountHandle -Final ('\\?\' + $handleTarget)) -TargetPath $handleTarget -CloudScope $null)
Assert-Equal 'handle: ファイルなら拒否' 'NOT_A_DIRECTORY' (Get-SummaryHandleRefusal -Info (New-HandleInfo -Attr ([uint32]32) -Final ('\\?\' + $handleTarget)) -TargetPath $handleTarget -CloudScope $null)
Assert-Equal 'handle: 開けなければ理由を返す' 'ACCESS_DENIED' (Get-SummaryHandleRefusal -Info (New-HandleInfo -Err 5 -Attr 0 -Final '') -TargetPath $handleTarget -CloudScope $null)
$summarySource = [IO.File]::ReadAllText($summaryPath, [Text.Encoding]::UTF8)
Assert-False 'handle: パス指定の列挙を使わない' ($summarySource.Contains('FindFirstFile'))
Assert-True 'handle: 共有に FILE_SHARE_DELETE を含めない' ($summarySource.Contains('CreateFileW(path, 0x81, 0x3,'))
Assert-True 'handle: リンクを辿らず開く' ($summarySource.Contains('0x02200000'))
$sumMain = $summarySource.IndexOf('function Invoke-FolderSummaryMain')
$sumEnum = $summarySource.IndexOf('$directory.Next()', $sumMain)
$sumCheck = $summarySource.IndexOf('Get-SummaryHandleRefusal', $sumMain)
$sumAfter = $summarySource.IndexOf('Get-SummaryHandleRefusal', $sumEnum)
Assert-True 'handle: 列挙の前と後の両方で確かめる' ($sumCheck -ge 0 -and $sumCheck -lt $sumEnum -and $sumAfter -gt $sumEnum)

$tagSymlinkS = [Convert]::ToUInt32('A000000C', 16)
$tagMountS = [Convert]::ToUInt32('A0000003', 16)
$tagCloudS = [Convert]::ToUInt32('9000601A', 16)
$script:SumFs = @{}
function Set-SumFs {
  $script:SumFs = @{
    'C:\' = @{ Attr = 16; Tag = 0 }; 'C:\Users' = @{ Attr = 16; Tag = 0 }; 'C:\Users\a' = @{ Attr = 16; Tag = 0 }
    'C:\Users\a\Documents' = @{ Attr = 16; Tag = 0 }; 'C:\Users\a\Documents\sub' = @{ Attr = 16; Tag = 0 }
    'C:\Users\a\Documents\file.txt' = @{ Attr = 32; Tag = 0 }; 'C:\Users\b\Documents' = @{ Attr = 16; Tag = 0 }; 'C:\Users\b' = @{ Attr = 16; Tag = 0 }
    'C:\Users\a\OneDrive' = @{ Attr = 16; Tag = 0 }; 'C:\Users\a\OneDrive\Docs' = @{ Attr = 1040; Tag = $tagCloudS }
  }
}
$sumProbe = {
  param($extended, $openReparse)
  $p = $extended.Substring(4)
  if (-not $script:SumFs.ContainsKey($p)) { return @{ Error = 2; Attributes = 0; ReparseTag = 0; FinalPath = $null } }
  $e = $script:SumFs[$p]
  $final = if ($e.ContainsKey('Final')) { $e.Final } else { $p }
  return @{ Error = [int]$(if ($e.ContainsKey('Err')) { $e.Err } else { 0 }); Attributes = [uint32]$e.Attr; ReparseTag = [uint32]$e.Tag; FinalPath = '\\?\' + $final }
}
function Get-SumRefusal {
  param([string]$Target, [string]$Root = 'C:\Users\a\Documents', [string]$OneDrive = $null)
  return (Get-SummaryScopeRefusal -TargetPath $Target -RootPath $Root -ProfilePath 'C:\Users\a' -OneDrivePath $OneDrive -Probe $sumProbe)
}
Set-SumFs
Assert-Equal 'summary: 起点' $null (Get-SumRefusal -Target 'C:\Users\a\Documents')
Assert-Equal 'summary: 子' $null (Get-SumRefusal -Target 'C:\Users\a\Documents\sub')
Assert-Equal 'summary: 起点の外' 'OUT_OF_SCOPE' (Get-SumRefusal -Target 'C:\Users\a')
Assert-Equal 'summary: 別ユーザー' 'OUT_OF_SCOPE' (Get-SumRefusal -Target 'C:\Users\b\Documents' -Root 'C:\Users\b\Documents')
Assert-Equal 'summary: UNC' 'OUT_OF_SCOPE' (Get-SumRefusal -Target '\\server\share')
Assert-Equal 'summary: 相対要素' 'OUT_OF_SCOPE' (Get-SumRefusal -Target 'C:\Users\a\Documents\..\..')
Assert-Equal 'summary: ドライブ直下' 'OUT_OF_SCOPE' (Get-SumRefusal -Target 'C:\')
Assert-Equal 'summary: 存在しない' 'NOT_FOUND' (Get-SumRefusal -Target 'C:\Users\a\Documents\none')
Assert-Equal 'summary: ファイル' 'NOT_A_DIRECTORY' (Get-SumRefusal -Target 'C:\Users\a\Documents\file.txt')
$script:SumFs['C:\Users\a\Documents\sub'] = @{ Attr = 1040; Tag = $tagSymlinkS }
Assert-Equal 'summary: symlink' 'REPARSE_REJECTED' (Get-SumRefusal -Target 'C:\Users\a\Documents\sub')
Set-SumFs
$script:SumFs['C:\Users'] = @{ Attr = 1040; Tag = $tagMountS }
Assert-Equal 'summary: 祖先の junction' 'REPARSE_REJECTED' (Get-SumRefusal -Target 'C:\Users\a\Documents')
Set-SumFs
$script:SumFs['C:\Users\a\Documents\sub'] = @{ Attr = 16; Tag = 0; Final = 'C:\Windows' }
Assert-Equal 'summary: 解決後の差し替え' 'PATH_CHANGED' (Get-SumRefusal -Target 'C:\Users\a\Documents\sub')
Set-SumFs
$script:SumFs['C:\Users\a\Documents\sub'] = @{ Attr = 16; Tag = 0; Err = 5 }
Assert-Equal 'summary: ACL 拒否は昇格しない' 'ACCESS_DENIED' (Get-SumRefusal -Target 'C:\Users\a\Documents\sub')
Set-SumFs
Assert-Equal 'summary: OneDrive のクラウドタグ' $null (Get-SumRefusal -Target 'C:\Users\a\OneDrive\Docs' -Root 'C:\Users\a\OneDrive\Docs' -OneDrive 'C:\Users\a\OneDrive')
Assert-Equal 'summary: OneDrive の範囲外のクラウドタグ' 'REPARSE_REJECTED' (Get-SumRefusal -Target 'C:\Users\a\OneDrive\Docs' -Root 'C:\Users\a\OneDrive\Docs')

# OneDrive の複数アカウント
Set-SumFs
$script:SumFs['C:\Users\a\OneDrive - Corp'] = @{ Attr = 1040; Tag = $tagCloudS }
$script:SumFs['D:\'] = @{ Attr = 16; Tag = 0 }; $script:SumFs['D:\Evil'] = @{ Attr = 1040; Tag = $tagCloudS }
function Get-SumScopes { param([string[]]$Candidates, [string]$Root = 'C:\Users\a\Documents') return (@(Get-SummaryCloudScopes -Candidates $Candidates -ProfileFinal 'C:\Users\a' -RootFinal $Root -Probe $sumProbe) -join ',') }
Assert-Equal 'summary-cloud: プロファイル配下の複数アカウント' 'C:\Users\a\OneDrive,C:\Users\a\OneDrive - Corp' (Get-SumScopes -Candidates @('C:\Users\a\OneDrive', 'C:\Users\a\OneDrive - Corp'))
Assert-Equal 'summary-cloud: 範囲外は不可' '' (Get-SumScopes -Candidates @('D:\Evil'))
Assert-Equal 'summary-cloud: 起点を含めば可' 'D:\Evil' (Get-SumScopes -Candidates @('D:\Evil') -Root 'D:\Evil')
Assert-Equal 'summary-cloud: プロファイル自身は不可' '' (Get-SumScopes -Candidates @('C:\Users\a'))
Assert-Equal 'summary-cloud: 祖先は不可' '' (Get-SumScopes -Candidates @('C:\Users'))
Assert-Equal 'summary-cloud: ドライブ直下は不可' '' (Get-SumScopes -Candidates @('D:\'))
Assert-Equal 'summary-cloud: 2 つ目のアカウントで許可' $null (Get-SummaryScopeRefusal -TargetPath 'C:\Users\a\OneDrive - Corp' -RootPath 'C:\Users\a\OneDrive - Corp' -ProfilePath 'C:\Users\a' -OneDrivePath @('C:\Users\a\OneDrive', 'C:\Users\a\OneDrive - Corp') -Probe $sumProbe)
Assert-Equal 'summary-cloud: 範囲外の既知フォルダは不可' 'REPARSE_REJECTED' (Get-SummaryScopeRefusal -TargetPath 'D:\Evil' -RootPath 'D:\Evil' -ProfilePath 'C:\Users\a' -OneDrivePath @('C:\Users\a\OneDrive') -Probe $sumProbe)
Assert-True 'summary-cloud: アカウント名' ((Test-SummaryAccountName -Name 'Business1') -and (Test-SummaryAccountName -Name 'Personal'))
Assert-False 'summary-cloud: アカウント名の拒否' (Test-SummaryAccountName -Name 'Evil')
Set-SumFs

$acc = New-SummaryAccumulator
Add-SummaryEntry -Accumulator $acc -Attributes 32 -Tag 0 -Size 100
Add-SummaryEntry -Accumulator $acc -Attributes 32 -Tag 0 -Size 50
Add-SummaryEntry -Accumulator $acc -Attributes 16 -Tag 0 -Size 4096
Add-SummaryEntry -Accumulator $acc -Attributes 1040 -Tag $tagSymlinkS -Size 7
Add-SummaryEntry -Accumulator $acc -Attributes 1056 -Tag $tagCloudS -Size 900
Assert-Equal 'summary: 出力の形（名前なし）' '{"accessible":true,"fileCount":3,"directoryCount":1,"linkCount":1,"totalBytes":1050,"truncated":false}' (ConvertTo-HelperJson -Value (New-SummaryOutput -Accumulator $acc))
foreach ($case in @(@{ c = 'ACCESS_DENIED'; e = 'ACCESS_DENIED' }, @{ c = 'NOT_FOUND'; e = 'NOT_FOUND' }, @{ c = 'REPARSE_REJECTED'; e = 'INVALID_TARGET' }, @{ c = 'OUT_OF_SCOPE'; e = 'INVALID_TARGET' }, @{ c = 'PATH_CHANGED'; e = 'INVALID_TARGET' }, @{ c = 'IO_ERROR'; e = 'EXEC_FAILED' }, @{ c = 'SERVICE_ACCOUNT'; e = 'ELEVATED' })) {
  Assert-Equal ('summary: 失敗コード ' + $case.c) ('{"accessible":false,"resultCode":"' + $case.e + '"}') (ConvertTo-HelperJson -Value (New-SummaryFailure -Code $case.c))
}
$acc.Truncated = $true
Assert-True 'summary: truncated' (New-SummaryOutput -Accumulator $acc).truncated

$summaryText = [IO.File]::ReadAllText($summaryPath, [Text.Encoding]::UTF8)
Assert-False 'summary: Add-SummaryEntry は名前を受けない' ((Get-Command Add-SummaryEntry).Parameters.ContainsKey('Name'))
foreach ($word in 'public string Name', 'entry.Name', 'ReadAllBytes', 'ReadAllText', 'OpenRead', 'Get-ChildItem') {
  Assert-False ('summary: 使わない ' + $word) ($summaryText.Contains($word))
}

# ---------------------------------------------------------------------------
# マーカー
# ---------------------------------------------------------------------------
$script:Reg = @{ Marker = $null; Kind = 'none' }
$fakeStore = @{
  Read   = { if ($script:Reg.Kind -ceq 'none') { @{ Exists = $false; Kind = 'none'; Value = $null } } else { @{ Exists = $true; Kind = $script:Reg.Kind; Value = $script:Reg.Marker } } }
  Write  = { param($v) $script:Reg.Marker = [string]$v; $script:Reg.Kind = 'marker' }
  Delete = { $script:Reg.Marker = $null; $script:Reg.Kind = 'none' }
}
$noParams = [pscustomobject]@{}
Assert-Equal 'marker: status 無し' '{"present":false,"value":null}' (ConvertTo-HelperJson -Value (Invoke-MarkerStatus -Params $noParams -Store $fakeStore))
Assert-Equal 'marker: set 前値なし' '{"applied":true,"previousPresent":false,"previousValue":null}' (ConvertTo-HelperJson -Value (Invoke-MarkerSet -Params ([pscustomobject]@{ value = 'VERIFY_A' }) -Store $fakeStore))
Assert-Equal 'marker: status 値あり' '{"present":true,"value":"VERIFY_A"}' (ConvertTo-HelperJson -Value (Invoke-MarkerStatus -Params $noParams -Store $fakeStore))
Assert-Equal 'marker: set 前値を返す' '{"applied":true,"previousPresent":true,"previousValue":"VERIFY_A"}' (ConvertTo-HelperJson -Value (Invoke-MarkerSet -Params ([pscustomobject]@{ value = 'VERIFY_B' }) -Store $fakeStore))
Assert-Equal 'marker: clear 前値を返す' '{"cleared":true,"previousPresent":true,"previousValue":"VERIFY_B"}' (ConvertTo-HelperJson -Value (Invoke-MarkerClear -Params $noParams -Store $fakeStore))
Assert-Equal 'marker: 消えている' 'none' $script:Reg.Kind
Assert-Equal 'marker: clear 2 回目' '{"cleared":true,"previousPresent":false,"previousValue":null}' (ConvertTo-HelperJson -Value (Invoke-MarkerClear -Params $noParams -Store $fakeStore))

foreach ($bad in @([pscustomobject]@{ value = 'Run' }, [pscustomobject]@{ value = 1 }, [pscustomobject]@{ value = 'verify_a' }, [pscustomobject]@{}, $null)) {
  Assert-Equal 'marker: set 拒否' 'INVALID_PARAMS' (Invoke-MarkerSet -Params $bad -Store $fakeStore).resultCode
}
Assert-Equal 'marker: clear に params' 'INVALID_PARAMS' (Invoke-MarkerClear -Params ([pscustomobject]@{ x = 1 }) -Store $fakeStore).resultCode
Assert-Equal 'marker: status に params' 'INVALID_PARAMS' (Invoke-MarkerStatus -Params ([pscustomobject]@{ x = 1 }) -Store $fakeStore).resultCode
$script:Reg = @{ Marker = $null; Kind = 'other' }
Assert-Equal 'marker: 合成値以外を上書きしない' 'UNEXPECTED_VALUE' (Invoke-MarkerSet -Params ([pscustomobject]@{ value = 'VERIFY_A' }) -Store $fakeStore).resultCode
Assert-Equal 'marker: 合成値以外を消さない' 'UNEXPECTED_VALUE' (Invoke-MarkerClear -Params $noParams -Store $fakeStore).resultCode
Assert-Equal 'marker: 合成値以外を出力しない' 'UNEXPECTED_VALUE' (Invoke-MarkerStatus -Params $noParams -Store $fakeStore).resultCode
Assert-Equal 'marker: 上書きされていない' 'other' $script:Reg.Kind
$script:Reg = @{ Marker = $null; Kind = 'none' }
$brokenStore = @{ Read = $fakeStore.Read; Write = { param($v) $null = $v }; Delete = $fakeStore.Delete }
Assert-Equal 'marker: 書込の確認' 'WRITE_NOT_CONFIRMED' (Invoke-MarkerSet -Params ([pscustomobject]@{ value = 'VERIFY_A' }) -Store $brokenStore).resultCode

# ---------------------------------------------------------------------------
# diag-sleep と共通部
# ---------------------------------------------------------------------------
Assert-True 'diag: 正常' (Test-DiagParams -Params ([pscustomobject]@{ seconds = 5; children = 2 }))
foreach ($bad in @(
    [pscustomobject]@{ seconds = 0; children = 0 },
    [pscustomobject]@{ seconds = 301; children = 0 },
    [pscustomobject]@{ seconds = 5; children = 4 },
    [pscustomobject]@{ seconds = '5; evil'; children = 0 },
    [pscustomobject]@{ seconds = 5 }
  )) {
  Assert-False 'diag: 拒否' (Test-DiagParams -Params $bad)
}
Assert-Equal 'diag: 孫の引数は整数のみ' '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 5"' (New-DiagChildArguments -Seconds 5)

$parsed = Read-SkillInput -Stream (New-Object IO.MemoryStream -ArgumentList (, [Text.Encoding]::UTF8.GetBytes('{"params":{"value":7},"target":null}')))
Assert-Equal 'input: params' 7 $parsed.params.value
$threw = $false
try { $null = Read-SkillInput -Stream (New-Object IO.MemoryStream -ArgumentList (, [byte[]]::new(70000))) } catch { $threw = $true }
Assert-True 'input: 64KB 超は拒否' $threw
$threw = $false
try { $null = Read-SkillInput -Stream (New-Object IO.MemoryStream -ArgumentList (, [byte[]]@(0xFF, 0xFE))) } catch { $threw = $true }
Assert-True 'input: 不正な UTF-8 は拒否' $threw
Assert-Equal 'identity: 本人' $null (Get-IdentityRefusal -Sid $vSid -IsAdministrator $false)
Assert-Equal 'identity: SYSTEM' 'SERVICE_ACCOUNT' (Get-IdentityRefusal -Sid 'S-1-5-18' -IsAdministrator $false)
Assert-Equal 'identity: 昇格' 'ELEVATED' (Get-IdentityRefusal -Sid $vSid -IsAdministrator $true)
Assert-Equal 'identity: なし' 'NO_IDENTITY' (Get-IdentityRefusal -Sid '' -IsAdministrator $false)

# ---------------------------------------------------------------------------
# 静的検査（BOM・5.1 互換・禁止事項）
# ---------------------------------------------------------------------------
$newFiles = @($summaryPath, $setPath, $clearPath, $statusPath, $diagPath, $installPath, $PSCommandPath)
foreach ($path in ($newFiles + $helperPath)) {
  $leaf = Split-Path -Leaf $path
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ('BOM: ' + $leaf) ($bytes.Length -gt 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $tokens = $null; $parseErrors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
  Assert-Equal ('parse: ' + $leaf) 0 $parseErrors.Count
  $ps7Only = @($tokens | Where-Object { $_.Kind -in 'AndAnd', 'OrOr', 'QuestionMark', 'QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket' })
  Assert-Equal ('5.1 互換の演算子のみ: ' + $leaf) 0 $ps7Only.Count
  if ($path -ceq $PSCommandPath) { continue }
  $code = (@($tokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text }) -join ' ')
  foreach ($forbidden in 'Invoke-Expression', 'iex', 'Invoke-Command', 'Add-Content', 'CreateProcessAsUser', 'CreateProcessWithLogon', 'LogonUser', 'runAs', 'Get-Credential', 'ConvertTo-SecureString', 'Password', 'schtasks', 'Register-ScheduledTask', 'Invoke-RestMethod', 'Invoke-WebRequest', 'meshagent', 'meshctrl') {
    if ($forbidden -ceq 'Add-Content' -and $path -ceq $helperPath) { continue }
    Assert-False ('禁止: ' + $leaf + ' ' + $forbidden) ($code -imatch ('(?<![\w-])' + [regex]::Escape($forbidden) + '(?![\w-])'))
  }
  $envVars = @($tokens | Where-Object { $_.Kind -eq 'Variable' -and $_.Text -match '^\$env:' })
  Assert-Equal ('環境変数を使わない: ' + $leaf) 0 $envVars.Count
}

foreach ($path in $summaryPath, $setPath, $clearPath, $statusPath, $diagPath) {
  $leaf = Split-Path -Leaf $path
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
  $mainFn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -cmatch '^Invoke-.*Main$' }, $true)
  Assert-True ('skill: main がある ' + $leaf) ($null -ne $mainFn)
  # 最初の実処理は stdin の読取（Job と SID の確認が終わるまで動かない）。
  $firstRead = $mainFn.Extent.Text.IndexOf('Read-SkillInput')
  $firstOther = $mainFn.Extent.Text.IndexOf('Get-LiveIdentityRefusal')
  Assert-True ('skill: stdin を最初に読む ' + $leaf) ($firstRead -ge 0 -and $firstRead -lt $firstOther)
}

# ---------------------------------------------------------------------------
# 実配線（子プロセスの起動・Job・トークンだけ差し替え、ファイル・HTTP 本文・判定は本物を通す）
# これより後は関数を上書きするので、ファイルの最後に置く。
# ---------------------------------------------------------------------------
$wireRoot = Join-Path ([IO.Path]::GetTempPath()) ('aihd-skill-' + [Guid]::NewGuid().ToString('N'))
$wireSkills = Join-Path $wireRoot 'skills'
$null = New-Item -ItemType Directory -Path $wireSkills
$wireScript = Join-Path $wireSkills 'disk-space.ps1'
[IO.File]::WriteAllText($wireScript, 'synthetic', (New-Object Text.UTF8Encoding -ArgumentList $false))
$wireStream = [IO.File]::OpenRead($wireScript)
$wireHash = Get-Sha256Prefixed -Stream $wireStream
$wireStream.Dispose()

function Get-StateDirectory { return $wireRoot }
function Get-SkillsDirectory { return $wireSkills }
function Get-RunsDirectory { return (Join-Path $wireRoot 'runs') }
function Get-SessionInfo { return @{ SessionId = 2; SessionState = $script:WireSessionState } }
function Get-CurrentIdentityInfo { return @{ Sid = $vSid; Name = 'synthetic'; IsAdministrator = $false } }
function Get-MachineGuidValue { return $vGuid }
function Get-CurrentIntegrityRid { return 0x2000 }
function Invoke-NativeProbe { param($Path, $OpenReparsePoint) return @{ Error = 0; Attributes = [uint32]32; ReparseTag = [uint32]0; FinalPath = $Path } }
$script:WireLog = New-Object System.Collections.Generic.List[string]
function Write-HelperLog { param($EventName, $Fields) $script:WireLog.Add([string]$EventName) }

$script:WireHttp = New-Object System.Collections.Generic.List[object]
$script:WireRegisterStatus = 200
$script:WireRegisterFailBody = ''
function Initialize-NativeInterop { $null = 0 }
function Initialize-StateDirectory { param($Sid) return $wireRoot }
$script:WireStartStatus = 200
$script:WirePollBody = '{"ops":[],"cancel":[],"revoked":false}'
$script:WireResultStatus = 200
$script:WireSessionState = 'active'
function Invoke-HelperHttp {
  param($Url, $Token, $BodyJson, $TimeoutSec = 30)
  $action = $Url.Substring($Url.LastIndexOf('/') + 1)
  $script:WireHttp.Add(@{ Action = $action; Url = $Url; Body = $BodyJson; Token = $Token })
  if ($action -ceq 'start') {
    if ($script:WireStartStatus -eq 0) { return @{ Status = 0; Body = ''; RetryAfter = 0; ErrorType = 'WebException' } }
    return @{ Status = $script:WireStartStatus; Body = '{"ok":true,"started":true}'; RetryAfter = 0; ErrorType = $null }
  }
  if ($action -ceq 'register') {
    if ($script:WireRegisterStatus -ne 200) { return @{ Status = $script:WireRegisterStatus; Body = $script:WireRegisterFailBody; RetryAfter = 0; ErrorType = $null } }
    return @{ Status = 200; Body = $script:WireRegisterBody; RetryAfter = 0; ErrorType = $null }
  }
  if ($action -ceq 'poll') { return @{ Status = 200; Body = $script:WirePollBody; RetryAfter = 0; ErrorType = $null } }
  return @{ Status = $script:WireResultStatus; Body = '{"ok":true,"accepted":true}'; RetryAfter = 0; ErrorType = $null }
}

$script:WireChildSeconds = 0
$script:WireStdin = $null
function Start-SkillChild {
  param($ScriptPath, $StdinJson, $ExpectedSid, $MaxOutputBytes)
  $script:WireStdin = $StdinJson
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = '/bin/sleep'
  $info.Arguments = [string]$script:WireChildSeconds
  $info.UseShellExecute = $false
  return @{ Reason = $null; StopOutcome = $null; ExitCode = $null; Runner = @{ Process = [Diagnostics.Process]::Start($info); Job = (New-Object IO.MemoryStream) } }
}
function Stop-SkillChild {
  param($Runner)
  $Runner.Process.Kill()
  $null = $Runner.Process.WaitForExit(5000)
  return @{ Stopped = $true; ExitCode = $Runner.Process.ExitCode }
}
function Complete-SkillChild {
  param($Runner)
  $null = $Runner.Process.WaitForExit(5000)
  return @{ ExitCode = $Runner.Process.ExitCode; Stdout = '{"volumes":[{"freeGB":1.50}]}'; StdoutTruncated = $false; StderrBytes = 0; LeftoverStopFailed = $false }
}

# DPAPI は Linux に無いので、トークン本体だけ平文のスタブにする（引き渡しはファイルのバイト列で行う）。
function Save-HelperToken { param($HelperId, $HelperToken) [IO.File]::WriteAllText((Get-StatePath -Name 'token.dat'), $HelperToken) }
function Read-HelperToken {
  param([string]$Name = 'token.dat')
  $path = Get-StatePath -Name $Name
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = [IO.File]::ReadAllText($path)
  if ($text -ceq 'UNREADABLE') { return $null }
  return [pscustomobject]@{ helperId = 'h'; helperToken = $text }
}

function Get-WireActions { return (@($script:WireHttp | ForEach-Object { $_.Action }) -join ',') }

$wireIdentity = @{ Sid = $vSid; Name = 'synthetic'; IsAdministrator = $false }
function New-WireOp {
  param([string]$OpId, [hashtable]$Over = @{})
  $o = @{ opId = $OpId; skillId = 'disk.space'; paramsJson = '{}'; targetRoot = $null; machineGuid = $vGuid; scriptHash = $wireHash; expiresAt = '2099-01-01T00:00:00.000Z'; maxSeconds = 30 }
  foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
  return (New-SignedRunOp -Over $o)
}

if ($IsLinux -and (Test-Path -LiteralPath '/bin/sleep')) {
  try {
    # 正常系
    $wireState = New-PollState
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-1') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State $wireState
    Assert-Equal 'wire: start → skill-result の順' 'start,skill-result' (Get-WireActions)
    Assert-True 'wire: start の URL' $script:WireHttp[0].Url.EndsWith('/api/device/agent/folder-helper/ops/wire-1/start')
    Assert-True 'wire: skill-result の URL' $script:WireHttp[1].Url.EndsWith('/api/device/agent/folder-helper/ops/wire-1/skill-result')
    Assert-Equal 'wire: start の本文' ('{"actorSid":"' + $vSid + '","sessionId":2,"machineGuid":"' + $vGuid + '","startNonce":"nonce-0001-not-a-secret","scriptHash":"' + $wireHash + '"}') $script:WireHttp[0].Body
    $wireBody = ConvertFrom-HelperJson -Json $script:WireHttp[1].Body
    Assert-Equal 'wire: 成功の報告' 'ok' $wireBody.status
    Assert-True 'wire: 小数の出力をそのまま送る' $script:WireHttp[1].Body.Contains('"output":{"volumes":[{"freeGB":1.50}]}')
    Assert-Equal 'wire: real' 'real' $wireBody.executionMode
    Assert-Equal 'wire: 実行した scriptHash' $wireHash $wireBody.scriptHash
    Assert-True 'wire: 記録がある' (Test-Path -LiteralPath (Get-RunFilePath -OpId 'wire-1' -Kind 'run'))
    Assert-True 'wire: 報告済み' (Test-Path -LiteralPath (Get-RunFilePath -OpId 'wire-1' -Kind 'sent'))
    Assert-Equal 'wire: stdin' '{"params":{},"target":null}' $script:WireStdin

    # 同じ op の再配信（再起動後を含む）は再実行しない
    $script:WireHttp.Clear()
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-1') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-Equal 'wire: 再配信は start も実行もしない' '' (Get-WireActions)

    # 再起動: 記録だけあれば interrupted を報告し、報告後は繰り返さない
    $null = Write-RunRecord -Op (New-WireOp -OpId 'wire-2' -Over @{ skillId = 'user.marker.set'; paramsJson = '{"value":"VERIFY_A"}' }) -Effect 'modify' -StartedAt '2026-10-31T00:00:00.000Z'
    Assert-False 'wire: CreateNew で 2 回目は失敗' (Write-RunRecord -Op (New-WireOp -OpId 'wire-2') -Effect 'read' -StartedAt 'x')
    $script:WireHttp.Clear()
    Invoke-PendingSkillReports -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity
    Assert-Equal 'wire: INTERRUPTED を 1 回送る' 'skill-result' (Get-WireActions)
    $wireBody = ConvertFrom-HelperJson -Json $script:WireHttp[0].Body
    Assert-Equal 'wire: interrupted' 'interrupted' $wireBody.status
    Assert-Equal 'wire: INTERRUPTED' 'INTERRUPTED' $wireBody.resultCode
    Assert-Equal 'wire: modify の中断は部分変更あり得る' 'PARTIAL_EFFECT_POSSIBLE' (@($wireBody.partialEffect) -join ',')
    $script:WireHttp.Clear()
    Invoke-PendingSkillReports -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity
    Assert-Equal 'wire: 報告後は送らない' '' (Get-WireActions)

    # 報告に失敗したら残し、次の機会に保存済みの結果を送る
    $script:WireResultStatus = 503
    $script:WireHttp.Clear()
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-3') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-False 'wire: 失敗時は未報告のまま' (Test-Path -LiteralPath (Get-RunFilePath -OpId 'wire-3' -Kind 'sent'))
    $script:WireResultStatus = 200
    $script:WireHttp.Clear()
    Invoke-PendingSkillReports -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity
    Assert-Equal 'wire: 保存した結果を再送' 'ok' (ConvertFrom-HelperJson -Json $script:WireHttp[0].Body).status

    # start に応答がなければ子を起動しない
    $script:WireStartStatus = 0
    $script:WireHttp.Clear()
    $script:WireStdin = $null
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-4') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-Equal 'wire: 応答なしは起動しない' $null $script:WireStdin
    Assert-False 'wire: 応答なしは記録しない' (Test-Path -LiteralPath (Get-RunFilePath -OpId 'wire-4' -Kind 'run'))
    Assert-Equal 'wire: 応答なしの申告' 'START_NO_RESPONSE' (ConvertFrom-HelperJson -Json $script:WireHttp[1].Body).resultCode
    $script:WireStartStatus = 200

    # start の拒否（409）は起動も報告もしない
    $script:WireStartStatus = 409
    $script:WireHttp.Clear()
    $script:WireStdin = $null
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-4b') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-Equal 'wire: 409 は start のみ' 'start' (Get-WireActions)
    Assert-Equal 'wire: 409 は起動しない' $null $script:WireStdin
    $script:WireStartStatus = 200

    # スクリプトの差し替えは実ファイルのハッシュで止まる
    $script:WireHttp.Clear()
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-5' -Over @{ scriptHash = $hashA }) -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-Equal 'wire: ハッシュ不一致は start しない' 'skill-result' (Get-WireActions)
    Assert-Equal 'wire: ハッシュ不一致の報告' 'SCRIPT_HASH_MISMATCH' (ConvertFrom-HelperJson -Json $script:WireHttp[0].Body).resultCode

    # 実行中の cancel（実プロセスを kill してから報告）
    $savedEvery = $script:SkillPollEveryMs
    $script:SkillPollEveryMs = 0
    $script:WireChildSeconds = 30
    $script:WirePollBody = '{"ops":[],"cancel":["wire-6"],"revoked":false}'
    $script:WireHttp.Clear()
    $wireWatch = [Diagnostics.Stopwatch]::StartNew()
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-6') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-True 'wire: 30 秒待たずに止まる' ($wireWatch.Elapsed.TotalSeconds -lt 15)
    Assert-Equal 'wire: start → poll → skill-result' 'start,poll,skill-result' (Get-WireActions)
    $wireBody = ConvertFrom-HelperJson -Json $script:WireHttp[2].Body
    Assert-Equal 'wire: cancel の報告' 'CANCELLED' $wireBody.resultCode
    Assert-Equal 'wire: stopped' 'stopped' $wireBody.stopOutcome

    # 実行中の失効も kill → 報告の順。呼び出し側がトークンを消すのはこの後。
    $script:WirePollBody = '{"ops":[],"cancel":[],"revoked":true}'
    $script:WireHttp.Clear()
    $wireState = New-PollState
    Invoke-HelperOperation -Op (New-WireOp -OpId 'wire-7') -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State $wireState
    Assert-Equal 'wire: 失効の報告' 'cancelled' (ConvertFrom-HelperJson -Json $script:WireHttp[2].Body).status
    Assert-True 'wire: 失効を状態へ反映' $wireState.Revoked
    Assert-Equal 'wire: 失効の報告にもトークンを使う' $vectorToken $script:WireHttp[2].Token
    $script:SkillPollEveryMs = $savedEvery

    # ---- 報告用資格情報の分離 ----
    function Reset-WireStore {
      foreach ($d in (Get-RunsDirectory), (Get-ReportRunsDirectory)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
      foreach ($n in 'token.dat', 'report-token.dat', 'revoked.flag') { Remove-StateFile -Name $n }
      $script:WireHttp.Clear()
      $script:WireResultStatus = 200
      $script:WirePollBody = '{"ops":[],"cancel":[],"revoked":false}'
    }
    function Add-WireRun { param([string]$Id) $null = Write-RunRecord -Op (New-WireOp -OpId $Id) -Effect 'read' -StartedAt '2026-10-31T00:00:00.000Z' }
    function Test-StateFile { param([string]$Name) return (Test-Path -LiteralPath (Get-StatePath -Name $Name)) }
    function Test-RunFile { param([string]$Id, [string]$Kind, [string]$Store = 'runs') return (Test-Path -LiteralPath (Get-RunFilePath -OpId $Id -Kind $Kind -Store $Store)) }
    $wireServer = 'https://x.example.com'

    # 全件報告できれば移さない
    Reset-WireStore
    Save-HelperToken -HelperToken 'OLD-TOKEN'
    Add-WireRun -Id 'sep-1'
    Assert-True 'sep: 全件報告で完了' (Invoke-HelperRevocationFlush -ServerBase $wireServer -Token 'OLD-TOKEN' -Identity $wireIdentity -MaxAttempts 1)
    Assert-False 'sep: token.dat を消す' (Test-StateFile 'token.dat')
    Assert-False 'sep: 報告専用トークンを作らない' (Test-StateFile 'report-token.dat')

    # 未報告が残れば token.dat と記録を移す
    Reset-WireStore
    Save-HelperToken -HelperToken 'OLD-TOKEN'
    Add-WireRun -Id 'sep-2'
    Save-RunResult -OpId 'sep-2' -Json '{"saved":"old"}'
    Add-WireRun -Id 'sep-done'
    Set-RunState -OpId 'sep-done' -Kind 'sent'
    $script:WireResultStatus = 503
    Assert-False 'sep: 未報告が残れば未完了' (Invoke-HelperRevocationFlush -ServerBase $wireServer -Token 'OLD-TOKEN' -Identity $wireIdentity -MaxAttempts 1)
    Assert-False 'sep: token.dat を消す（install が新規登録できる）' (Test-StateFile 'token.dat')
    Assert-Equal 'sep: 報告専用トークンは旧トークン' 'OLD-TOKEN' (Read-HelperToken -Name 'report-token.dat').helperToken
    Assert-Equal 'sep: 既定の読取は無し' $null (Read-HelperToken)
    Assert-True 'sep: 記録を移す' (Test-RunFile 'sep-2' 'run' 'report-runs')
    Assert-True 'sep: 結果も移す' (Test-RunFile 'sep-2' 'res' 'report-runs')
    Assert-False 'sep: runs に残さない' (Test-RunFile 'sep-2' 'run')
    Assert-True 'sep: 報告済みは移さない' (Test-RunFile 'sep-done' 'run')

    # install の再登録: 新しいトークンを得る。旧実行は新トークンで報告しない。
    $script:WireHttp.Clear()
    $script:WireRegisterBody = '{"helperId":"h2","helperToken":"NEW-TOKEN","pairingCode":"12345678","pairingExpiresAt":"2099-01-01T00:00:00.000Z"}'
    Assert-Equal 'install: token.dat が無いので登録へ進む' $null (Read-HelperToken)
    Assert-True 'install: 新規登録できる' (Invoke-HelperRegistration -ServerBase $wireServer -Identity $wireIdentity -EnrollCode 'SYNTHETIC-ENROLL-CODE' -InBackground $true).Ok
    Remove-StateFile -Name 'pairing-code.txt'
    Assert-Equal 'install: 新しいトークン' 'NEW-TOKEN' (Read-HelperToken).helperToken
    Assert-Equal 'install: 旧トークンは報告専用のまま' 'OLD-TOKEN' (Read-HelperToken -Name 'report-token.dat').helperToken
    Assert-False 'install: 移した記録を諦めない' (Test-RunFile 'sep-2' 'abandoned' 'report-runs')

    # 新旧の分離
    $script:WireHttp.Clear()
    $script:WireResultStatus = 200
    Invoke-PendingSkillReports -ServerBase $wireServer -Token 'NEW-TOKEN' -Identity $wireIdentity
    Assert-Equal 'sep: 新トークンで旧実行を報告しない' '' (Get-WireActions)
    $script:WireResultStatus = 503
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-Equal 'sep: 旧実行は報告専用トークンで' 'OLD-TOKEN' $script:WireHttp[0].Token
    Assert-Equal 'sep: 報告だけ' 'skill-result' (Get-WireActions)
    Assert-Equal 'sep: 保存した結果を送る' '{"saved":"old"}' $script:WireHttp[0].Body
    Assert-True 'sep: 再送のあいだトークンを残す' (Test-StateFile 'report-token.dat')
    # 新トークンの実行と poll / start は新トークンだけを使う
    $script:WireResultStatus = 503
    $script:WireHttp.Clear()
    $script:WireChildSeconds = 0
    $sepOp = New-WireOp -OpId 'sep-new'
    $sepOp.sig = Get-HmacSha256Hex -Key 'NEW-TOKEN' -Message (Get-SkillRunCanonicalJson -Op $sepOp)
    Invoke-HelperOperation -Op $sepOp -ServerBase $wireServer -Token 'NEW-TOKEN' -Identity $wireIdentity -State (New-PollState)
    $null = Invoke-HelperPoll -ServerBase $wireServer -Token 'NEW-TOKEN' -Identity $wireIdentity -State (New-PollState)
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    foreach ($call in $script:WireHttp) {
      if ($call.Action -ceq 'poll' -or $call.Action -ceq 'start') { Assert-Equal ('sep: ' + $call.Action + ' は新トークン') 'NEW-TOKEN' $call.Token }
      if ($call.Url.Contains('/ops/sep-new/')) { Assert-Equal 'sep: 新しい実行は新トークン' 'NEW-TOKEN' $call.Token }
      if ($call.Url.Contains('/ops/sep-2/')) { Assert-Equal 'sep: 旧実行は旧トークン' 'OLD-TOKEN' $call.Token }
    }
    Assert-True 'sep: poll と start を通った' ((Get-WireActions).Contains('start') -and (Get-WireActions).Contains('poll'))

    # 報告成功で記録を閉じてトークンを消す
    $script:WireResultStatus = 200
    $script:WireHttp.Clear()
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-True 'report-only: 報告済み' (Test-RunFile 'sep-2' 'sent' 'report-runs')
    Assert-False 'report-only: 成功後にトークンを消す' (Test-StateFile 'report-token.dat')
    Assert-True 'report-only: 新トークンは残す' (Test-StateFile 'token.dat')
    $script:WireHttp.Clear()
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-Equal 'report-only: トークンが無ければ何もしない' '' (Get-WireActions)

    # 410 は報告済みと区別する
    Reset-WireStore
    [IO.File]::WriteAllText((Get-StatePath -Name 'report-token.dat'), 'OLD-TOKEN')
    $null = New-Item -ItemType Directory -Path (Get-ReportRunsDirectory)
    [IO.File]::WriteAllText((Get-RunFilePath -OpId 'exp-1' -Kind 'run' -Store 'report-runs'), (New-RunRecordJson -Op (New-WireOp -OpId 'exp-1') -Effect 'read' -StartedAt 's'))
    $script:WireResultStatus = 410
    $script:WireLog.Clear()
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-True 'expired: 別の状態ファイル' (Test-RunFile 'exp-1' 'expired' 'report-runs')
    Assert-False 'expired: 報告済みにしない' (Test-RunFile 'exp-1' 'sent' 'report-runs')
    Assert-False 'expired: トークンを消す' (Test-StateFile 'report-token.dat')
    Assert-True 'expired: ログに残す' ($script:WireLog.Contains('report_expired'))
    $script:WireHttp.Clear()
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-Equal 'expired: 再送しない' '' (Get-WireActions)

    # 通常経路の 410 も区別する
    Reset-WireStore
    Add-WireRun -Id 'exp-2'
    $script:WireResultStatus = 410
    Invoke-PendingSkillReports -ServerBase $wireServer -Token 'T' -Identity $wireIdentity
    Assert-True 'expired: 通常経路でも別の状態ファイル' (Test-RunFile 'exp-2' 'expired')
    Assert-False 'expired: 通常経路でも報告済みにしない' (Test-RunFile 'exp-2' 'sent')

    # 報告専用の 401 と復号不能
    Reset-WireStore
    [IO.File]::WriteAllText((Get-StatePath -Name 'report-token.dat'), 'OLD-TOKEN')
    $null = New-Item -ItemType Directory -Path (Get-ReportRunsDirectory)
    [IO.File]::WriteAllText((Get-RunFilePath -OpId 'rej-1' -Kind 'run' -Store 'report-runs'), (New-RunRecordJson -Op (New-WireOp -OpId 'rej-1') -Effect 'read' -StartedAt 's'))
    $script:WireResultStatus = 401
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-True 'report-only: 401 は拒否として閉じる' (Test-RunFile 'rej-1' 'rejected' 'report-runs')
    Assert-False 'report-only: 401 でトークンを消す' (Test-StateFile 'report-token.dat')
    Reset-WireStore
    [IO.File]::WriteAllText((Get-StatePath -Name 'report-token.dat'), 'UNREADABLE')
    $null = New-Item -ItemType Directory -Path (Get-ReportRunsDirectory)
    [IO.File]::WriteAllText((Get-RunFilePath -OpId 'bad-1' -Kind 'run' -Store 'report-runs'), (New-RunRecordJson -Op (New-WireOp -OpId 'bad-1') -Effect 'read' -StartedAt 's'))
    Invoke-ReportOnlyFlush -ServerBase $wireServer -Identity $wireIdentity
    Assert-True 'report-only: 復号できなければ諦めて記録' (Test-RunFile 'bad-1' 'abandoned' 'report-runs')
    Assert-Equal 'report-only: 復号できなければ送らない' '' (Get-WireActions)
    Assert-False 'report-only: 復号できないトークンを消す' (Test-StateFile 'report-token.dat')

    # 報告先の無い記録は新しいトークンで送らない
    Reset-WireStore
    Add-WireRun -Id 'orphan-1'
    $script:WireHttp.Clear()
    $null = Invoke-HelperRegistration -ServerBase $wireServer -Identity $wireIdentity -EnrollCode 'SYNTHETIC-ENROLL-CODE' -InBackground $true
    Remove-StateFile -Name 'pairing-code.txt'
    Assert-True 'orphan: 登録時に諦めて記録' (Test-RunFile 'orphan-1' 'abandoned')
    Invoke-PendingSkillReports -ServerBase $wireServer -Token 'NEW-TOKEN' -Identity $wireIdentity
    Assert-Equal 'orphan: 新トークンで送らない' 'register' (Get-WireActions)

    # 引き渡しの途中で落ちてもやり直せる。枠が埋まっていれば前回分を諦めて記録する。
    Reset-WireStore
    Save-HelperToken -HelperToken 'OLD-TOKEN'
    [IO.File]::WriteAllBytes((Get-StatePath -Name 'report-token.dat'), [IO.File]::ReadAllBytes((Get-StatePath -Name 'token.dat')))
    Add-WireRun -Id 'retry-1'
    Assert-Equal 'handoff: 同じトークンならやり直し' 'moved' (Move-RevokedTokenToReportStore)
    Assert-Equal 'handoff: やり直しでも旧トークン' 'OLD-TOKEN' (Read-HelperToken -Name 'report-token.dat').helperToken
    Assert-False 'handoff: 前回分を諦めない' (Test-RunFile 'retry-1' 'abandoned' 'report-runs')
    Save-HelperToken -HelperToken 'SECOND-TOKEN'
    Add-WireRun -Id 'retry-2'
    Assert-Equal 'handoff: 別のトークン' 'moved' (Move-RevokedTokenToReportStore)
    Assert-True 'handoff: 枠が埋まっていれば前回分を諦めて記録' (Test-RunFile 'retry-1' 'abandoned' 'report-runs')
    Assert-Equal 'handoff: 枠は新しい失効' 'SECOND-TOKEN' (Read-HelperToken -Name 'report-token.dat').helperToken
    Assert-False 'handoff: 新しい記録は生きている' (Test-RunFile 'retry-2' 'abandoned' 'report-runs')

    # 導入コード: 本文にだけ入れる
    Reset-WireStore
    $script:WireRegisterBody = '{"helperId":"h2","helperToken":"NEW-TOKEN","pairingCode":"12345678","pairingExpiresAt":"2099-01-01T00:00:00.000Z"}'
    $reg = Invoke-HelperRegistration -ServerBase $wireServer -Identity $wireIdentity -EnrollCode 'SYNTHETIC-ENROLL-CODE' -InBackground $true
    Assert-True 'enroll: 登録できる' $reg.Ok
    Assert-Equal 'enroll: 本文に入れる' 'SYNTHETIC-ENROLL-CODE' (ConvertFrom-HelperJson -Json $script:WireHttp[0].Body).enrollCode
    Write-HelperConfig -ServerBase $wireServer -AllowInsecure $false
    $leaked = @(Get-ChildItem -LiteralPath $wireRoot -Recurse -File | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains('SYNTHETIC-ENROLL-CODE') })
    Assert-Equal 'enroll: 状態ファイルに残さない' 0 $leaked.Count
    Remove-StateFile -Name 'pairing-code.txt'

    # 無効なコード: 1 回で止め、トークンも記録も変えない
    Reset-WireStore
    Add-WireRun -Id 'enroll-keep'
    $script:WireRegisterStatus = 403
    $script:WireRegisterFailBody = '{"ok":false,"error":{"code":"ENROLL_CODE_INVALID"}}'
    $reg = Invoke-HelperRegistration -ServerBase $wireServer -Identity $wireIdentity -EnrollCode 'SYNTHETIC-ENROLL-CODE' -InBackground $true
    Assert-False 'enroll: 無効なコードは失敗' $reg.Ok
    Assert-True 'enroll: 無効なコードを判別' $reg.EnrollRejected
    Assert-Equal 'enroll: 再試行しない' 'register' (Get-WireActions)
    Assert-False 'enroll: トークンを作らない' (Test-StateFile 'token.dat')
    Assert-False 'enroll: 記録を閉じない' (Test-RunFile 'enroll-keep' 'abandoned')
    $script:WireRegisterFailBody = '{"ok":false,"error":{"code":"FORBIDDEN"}}'
    Assert-False 'enroll: 別の 403 は無効なコードにしない' (Invoke-HelperRegistration -ServerBase $wireServer -Identity $wireIdentity -EnrollCode 'SYNTHETIC-ENROLL-CODE' -InBackground $true).EnrollRejected
    $script:WireRegisterStatus = 200

    # 本体はコードなしで登録しない。報告専用の再送は動く。
    $ServerUrl = $wireServer
    $AllowInsecureHttp = $false
    $RegisterOnly = $false
    foreach ($mode in $true, $false) {
      $Background = $mode
      Reset-WireStore
      [IO.File]::WriteAllText((Get-StatePath -Name 'report-token.dat'), 'OLD-TOKEN')
      $null = New-Item -ItemType Directory -Path (Get-ReportRunsDirectory)
      [IO.File]::WriteAllText((Get-RunFilePath -OpId 'main-1' -Kind 'run' -Store 'report-runs'), (New-RunRecordJson -Op (New-WireOp -OpId 'main-1') -Effect 'read' -StartedAt 's'))
      $mainExit = Invoke-HelperMain 6>$null
      Assert-Equal ('main: トークンなしは終了 ' + $mode) 0 $mainExit
      Assert-Equal ('main: 登録せず報告だけ ' + $mode) 'skill-result' (Get-WireActions)
      Assert-Equal ('main: 報告は旧トークン ' + $mode) 'OLD-TOKEN' $script:WireHttp[0].Token
      Assert-False ('main: 報告後にトークンを消す ' + $mode) (Test-StateFile 'report-token.dat')
    }
    Reset-WireStore
    $Background = $true
    $RegisterOnly = $true
    Assert-Equal 'main: RegisterOnly でも登録しない' 3 (Invoke-HelperMain 6>$null)
    Assert-Equal 'main: RegisterOnly の通信なし' '' (Get-WireActions)
    $RegisterOnly = $false

    Reset-WireStore
    $script:SkillPollEveryMs = 0
    $script:WireChildSeconds = 30
    $script:WirePollBody = '{"ops":[],"cancel":[],"revoked":false}'

    # 実行前の拒否（署名不正）は start しない
    $script:WireHttp.Clear()
    $forged = New-WireOp -OpId 'wire-8'
    $forged.sig = 'f' * 64
    Invoke-HelperOperation -Op $forged -ServerBase 'https://x.example.com' -Token $vectorToken -Identity $wireIdentity -State (New-PollState)
    Assert-Equal 'wire: 署名不正は結果のみ' 'skill-result' (Get-WireActions)
    $wireBody = ConvertFrom-HelperJson -Json $script:WireHttp[0].Body
    Assert-Equal 'wire: 署名不正は rejected' 'rejected' $wireBody.status
    Assert-Equal 'wire: 署名不正の報告' 'BAD_SIGNATURE' $wireBody.resultCode
  } finally {
    Remove-Item -LiteralPath $wireRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Output 'SKIP wire: /bin/sleep がない環境'
  Remove-Item -LiteralPath $wireRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ('passed={0} failed={1}' -f $script:Passed, $script:Failed)
if ($script:Failed -gt 0) { exit 1 }
exit 0
