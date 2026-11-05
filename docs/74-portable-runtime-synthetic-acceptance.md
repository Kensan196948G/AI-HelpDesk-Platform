# 74. 可搬runtimeの合成受入（2026-11-06 JST）

## 結論と未達

**元の作業treeと無関係な新規runtime配置を、production-mode・合成TLS/JWT・新規合成DBで起動し、HTTP配信・認証境界・合成state保存を確認した。** これは未コミットcandidateの可搬性に関する局所実験であり、実Cloudflare Access/OTP、ブラウザ描画、全workflow、実承認・貸与端末、正式Staging、本番配備の受入ではない。`deploymentReady:false`を維持する。

Git接続の数字選択は未回答のため、[Git管理境界](72-runtime-dependencies-and-git-boundary.md)は変更しない。stage/commit/PR/今回必須CI/merge/配備は未実施。以前の候補27ファイル・元dist・本番チェックアウト・DB・Cloudflare設定・他Repoは変更していない。今回は新しいprivate実験領域と本書だけを追加した。

## 1. 合成runtimeの組み立て

新規private root `/tmp/aihd-portable-runtime-wpytdm08`（0700）に、以下を既定の相対配置を保って組み合わせた。

| 部品 | 件数 / 由来 |
|---|---|
| 実行用JS | 98。[cache無効クリーンビルドA](73-clean-build-reproducibility.md)の検証済み出力と全hash一致 |
| 元HTML | 1。正本原本を変更せずcopy |
| prototype bridge | 11。常用9＋条件付き2、元candidateとhash一致 |
| server参照Windows Skill | 20。固定catalogの実体、検証用diag-sleepは除外 |
| package manifests/lock | 3。root/API/package-lockを同じ組でcopy |
| 合計 | 133 assets。実験前後の全hash不一致0 |

既存node_modulesはcopyせず、空HOME/config/cacheと最小envで新規に`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`を実行（標準registry/lock先事前確認、exit0、2.429秒）。既存env・秘密・実承認manifest・実allowlist・名簿・DB dumpは読取/copy/hashしていない。

外部運用入力の代わりに、**検証専用**の空承認manifest `{version:1,skills:[]}` とsyntheticメール1件のallowlistを新規生成した。これは実承認の移送・外部供給方式の採択ではない。固定reader pathの合成manifestと、絶対path指定の合成allowlistだけを使う。

起動cwdはbundle内でも元treeでもないprivate `home` にした。moduleの配置から解決するrepoRootだけでHTML/bridge/Skillを読み取れるかを検証し、元sourceへのsymlink/fallbackは用意していない。mapsはこのruntimeへ含めず、デバッガの動作は試していない。

## 2. 新規DBと起動副作用の拘束

- 専用の新規PG16クラスタをSCRAM、127.0.0.1、ランダムportと`aihd_test_*`名で作成。既存5435等のDBへは接続しない。
- 親controllerとharnessでexpected port/DB名、最初の`current_database()`を照合してから、新DBだけへmigration37本を適用した。
- 起動時のカタログupsertや定期sweepはreadonlyではない。R2/R3 offでも残るため、新しい空DB以外は使わない。空manifestで起動後**Skill16件すべてdraft、approved0**を確認した。実Skill承認が利用可能という意味ではない。
- `MIRAI_INFO_DATABASE_URL`もこの新DBへ明示し、実名簿Unixソケットへの既定fallbackを防ぐ。RSP/AI/Lease等は資格情報なし・閉loopback、mail disabled。関連機能は呼び出さない。
- アプリchildは明示production/Access enforce/proxy必須/R2 off/R3 off、検証フラグの有効化・認証bypassコード・fetch差替えは使わない。

## 3. 合成TLS/JWKSと認証

JWKSは数値loopbackのランダムport、固定`/cdn-cgi/access/certs`だけを返すHTTPS fixture。IP SAN127.0.0.1を持つ新規自己署名証明書を使い、その証明書への追加信頼は当該アプリchildの起動時`NODE_EXTRA_CA_CERTS`だけに限定した。OS trust store、既存サービスのenv、TLS検証無効化は変更していない。CA:trueの自己署名両用はfixture限定であり、本物Access/JWKS/TLS運用受入とはしない。

親harnessでは証明書を信頼せず、既知の自己署名/chain検証error codeで失敗することを確認。アプリchildはTLS検証を有効のまま追加CAを読み、公開JWK取得の実要求1回をfixtureが記録した。RSA秘密鍵はメモリ、proxy/session秘密・DB口令・JWTは合成値だけ、argv/報告へ出さない。

| 経路 | 実測 |
|---|---|
| health | newDB ok、production、候補base SHAの自己申告。artifact由来は別の133hashで束縛 |
| proxy欠落 / 誤proxy | 各401 `PROXY_REQUIRED` |
| 正proxy＋許可メール、JWT未添付 | 401 `UNAUTHORIZED` |
| 誤署名 / 誤aud / 十分期限切れ / 誤issuer / JWTメール不一致 | 正しいproxyを付けて各401 `UNAUTHORIZED`。JWT到達前のproxy拒否と分離 |
| allowlist不一致 | 403 `FORBIDDEN` |
| 正署名・正issuer/aud/期限・許可合成メール | root HTML 200、892,980 bytes、boot scriptあり |
| 配信asset | 常用9bridgeの実bytesがすべてHTML内に含まれる。offの条件付き2bridgeは含まれない |
| header / 無効入口 | CSP/no-store/nosniffを確認、helper登録は404 `NOT_FOUND` |

HTTP本文のSHA-256は `f0ee497aad1418b65435f314b09d870e57785d41ef4417682e8c3e11b282b7e0`。本文そのもの・JWT・実個人情報は安全proofへ保存しない。HTTP200とbytes供給は、ブラウザのDOM描画/console正常や利用者workflow成功を証明しない。

## 4. 合成stateの保存・読取

同じ正しい合成認証で、新DBだけへsynthetic markerを含むstateをPUTし200、その後GETで同じ値を確認。該当syntheticユーザーのstate行は1件、次のHTML bootにもmarkerが反映された。これは新DBの保存経路だけの実測であり、実業務案件・通知・KB承認・AI/RSP・端末操作へは進めていない。

## 5. 停止制御と結果

起動前の独立レビューで、owner不一致/子停止失敗/fast-stop timeout/TERM中断で後続PGcleanupを飛ばす可能性を指摘・修正した。実controllerのASTからhandler/except/finallyだけを抽出し、subprocess/harness/emergency/network/signalをfake化した5caseはすべて成功した（normal、owner mismatch、fast timeout→immediate、harness timeout、TERM中断）。初回stub側IntEnum/AST TypeErrorの未完了試行は成功に数えず、修正後5caseだけを証拠化した。

このstubは本物のOS障害注入・SIGKILL・host障害での停止保証ではない。実験はcontroller1回だけ実起動し、正常終了時の停止を別に確認した。

| 対象 | PID / port | 終了確認 |
|---|---|---|
| 新PG | 1718589 / 43189 | fast stop exit0、PID不存在、port接続拒否、postmaster.pid不存在 |
| アプリ | 1718810 / 37135 | 子close後PID不存在、port接続拒否 |
| JWKS/harness | 1718636 / 43267 | server close・harness終了、PID不存在、port接続拒否 |

controllerはexit0、harness9.786秒。**69checks全合格**だが、37migration bytes照合を含む単一実験のassertion集合であり、独立69テストケースとは数えない。過去の全量1,860件/pure220件/inventory113件へ加算しない。

privateアプリlogに対し、既知の生成proxy/session/JWT/DB口令等のsubstringをLeadが終了後検査し一致0。log読取不能は未検査としてfailさせる。これは全秘密検出の網羅性やOS全漏洩不存在の証明ではない。log原文・生成key/password/PGDATAは独立reviewerや安全handoffへ渡さない。

## 6. 証跡と独立受入（限定scope）

安全proofはassembly/prestart指紋、依存導入要約、harness/controller/cleanup stubのsourceと安全結果、runtime/controller結果、owned PID/port metadata、owner停止確認要約だけ。証明書/private key・DB password・private application/PGログ・PGDATA・依存payloadは含めない。

`final-freeze.json` SHA-256は `e2615da012c4597d659d9625e30835e1cfdf2fa150dab13a1671bde2ce1dfedb`、指定14proofのhashを束縛する。元candidate27/新bundle133assets/起動前harness指紋はいずれも不一致0。実行主体はLead、Architectureは設計を担当した。

Security task27の独立readonly受入は限定PASS-with-limits、新規未修正Critical/High/Medium/Low=0/0/0/0。安全14proofの14/14 hash、69assertionsとauth負対照9/合成DB/配信/終了の記録、assemblyのJS98とRound3 final-A台帳の98/98一致を独立照合した。実bundle/元candidateの全bytes、実SQL/HTTP、既知合成秘密のlog検査と終了probeはLeadの凍結記録として区別し、reviewer自身は再実行・DB/HTTP接続・秘密payload読取0。

SRE task29の限定独立照合もPASS。14proofとprestart6指紋が全一致、133asset/JS98由来/69assertions/5stubcaseの台帳・安全結果が整合し、PG/app/JWKS-harnessの指定3PID不存在・3port ECONNREFUSEDを独立に確認した（DB/HTTP protocol送信0）。asset/deps payloadや秘密/privateログは読まず、旧候補27/本番不変はLeadの別実測として区別した。どちらも実Access/業務受入/正式Staging/本番GOへ拡張しない。

Git/CI境界未解消・管理者の数字回答待ち、R2/R3 No-Go・独立Staging/復元/実Access/実人物/貸与PC/別人物承認未受入を維持する。今回は可搬配置の非配備candidateを合成認証・合成DBで局所smokeした段階であり、item11の完全bundle正式受入や本番GOに昇格させない。

## 2026-11-06 追記（現況）

本記録は作成時点のもの。その後 PR #135 で commit・CI・merge 済み（merge `2deffab`）。現況と follow-up は [docs/76](76-followup-20261106.md) を参照。本文の実測結果・数値・限界は作成時点の記録としてそのまま維持する。
