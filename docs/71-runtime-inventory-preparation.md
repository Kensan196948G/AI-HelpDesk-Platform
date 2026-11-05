# 71. 第2組11の準備 — Runtime inventory（2026-11-05）

## 状態と今回の範囲

**第2組11は準備中であり、immutable release・Staging構築・配備完了ではない。** 第1組の正規Git統合も、Git MCPのpath/root制約とCI編集の実行ポリシー拒否により未完了である。これらを別経路で迂回しない。

今回はアプリケーションを変更せず、実行に関係する一部の許可済ファイルの相対名・サイズ・SHA-256を記録して再照合する、読取専用inventoryを準備する。Gitのbase SHAやhealth SHAだけでは未コミット候補・build結果・HTML/bridgeの組を識別できない問題に対し、ファイル内容の整合性を限定的に記録する。

- 第1組の21ファイルは凍結を維持し、現候補と保全済patchが一致することを再確認した。
- 本番は `a5e0a6719699d4711fc1811bbdb79c74d9aab393`。21:46以降の再観測でもhealth正常、API/proxy/TunnelのPIDとNRestarts=0が不変。
- 新規ファイルだけを担当別に分離する。本体はPlatform Developer、合成負対照はTest Safety Developer、静的レビューはSecurity Reviewer、実行結果受入はSRE、必要ファイル/責務はArchitect、Leadが統合と記録を担当する。
- 一覧を得る成功は**完全なbundle、実依存の解決、署名、信頼された出自、承認、本番GOを意味しない**。出力の `deploymentReady` は常に `false`。

## 入力と除外境界（実装契約）

### 許可する対象

- rootの `package.json` / `package-lock.json` / APIの `package.json`
- UIの正本である元プロトタイプHTML（変更しない）
- 実行用 `apps/api/dist` 内の JavaScript（source mapは含めない、最低限index/config/db/serverの4本が必須）。含有/非空はimport閉包・余剰old buildの排除・source→build一致を証明しない
- 配信コードに列挙されたprototype bridge 11本（常用9本、条件付き2本）
- サーバcatalogが参照するWindows Skill実体20本（resolve16＋assist独自4、共有は重複排除）。物理21本目の検証用`diag-sleep.ps1`は含めず、inventory対象と実行承認を混同しない

`repoRoot` はbuildされたconfigの位置を基準に解決され、prototype配信はHTMLとbridgeをsourceの相対pathから読む。したがってdistのhashだけではUIの同梱・同一性を示せない。今回もファイルを移動・同梱・配備してはいない。

### 内容を読まず、hashにも含めない対象

- 環境ファイル、資格情報、実名簿、実Access allowlist
- 実承認者情報を含み得るSkillの承認manifest
- `node_modules`、DB dump、ログ、利用者の保存状態
- 未許可の任意ファイル

除外対象以外のsource/packageにも個人metadata等が残る可能性がある。許可ファイルのhash出力もPII/secret不存在の認証ではなく、今回内容copyはしていない。

承認manifestの欠落やhash不一致でもアプリ起動が成功し、Skillがdraft化する場合がある。存在/件数やhealthだけで承認が機能しているとは判断しない。検証用manifestを本番承認の代用品にしない。

### Manifestの受入

生成物は専用の `runtime-inventory.json` として管理する。CLIの検証入力も専用basenameに限定し、任意JSON/実承認manifestを読み取る機能にはしない。相対pathのallowlist、重複・順序・型・未知キー・空一覧・自己申告の`deploymentReady:true`を拒否する。

Linux/Node22の`/proc/self/fd`を親アンカーにして各ディレクトリを固定し、regular/non-symlink/non-hardlink・親path境界・個別/全体のサイズ上限を確認する。Windows移植や任意の敵対的FS全体を保証するsandboxではない。各fileは同一FDでhashを計算して前後属性を照合する。最終に一覧全体の属性を再検査するが、敵対的な同時差替えを排除する原子的snapshotではない。検査に失敗したときは固定codeと非成功exitにし、例外本文・実path・入力本文を出力しない。

## 部品と依存関係

| タスク | 役割 | 依存 | 状態 |
|---|---|---|---|
| 12 | Architectによる必要file/未準備契約 | なし | 静的整理済み。常用9＋条件付き2bridge、server参照20ps1を確定 |
| 13 | 読取専用inventory生成・strictverify | なし、12の補足を反映 | 新規1ファイルに実装済み、凍結 |
| 14 | 独立した合成負対照・DB無し設定 | 13とAPIを共有し並列 | 新規test/config。113件成功、凍結 |
| 15 | 凍結差分の独立安全レビュー | 13,14 | 独立静的PASS-with-limits、新規未修正Critical/High/Medium/Low=0/0/0/0。新3/3と旧21/21のhash一致を確認 |
| 16 | 明示root実測・SRE照合・記録 | 12–14、レビュー結果を照合 | Leadのinspect/strictverifyと改竄/false-ready負対照を実測、task17で独立SREの限定証跡照合PASS。item11完全bundle/配備の受入ではない |

## 引き続き未準備のもの

1. **build出自**：コードの全量snapshot、正規commitと必須CI、compiler/依存の同一性。ファイルhashだけでは証明しない。
2. **承認manifestとallowlist**：外部の運用入力として供給・権限・失効/鮮度・内容束縛を別検証する。今回内容を読まない。
3. **実依存**：lockのhashはnode_modules解決、Node22/OS/PDF binaryの互換性やSBOMの証明ではない。
4. **DBと復旧**：migrationファイルは今回inventory対象外。DDL集合のhashも、実DBのschema・適用・全表復元・監査・rollbackの証拠ではない。今回DB接続しない。
5. **配備と受入**：HTML/bridge/JSを同じreleaseで配信する仕組み、独立Staging、Access認証後UI、実社員/貸与PC/別人物承認は未受入。
6. **原子性**：管理された停止中/静止した作業領域で使う。動作中の敵対的な全tree差替え防止や改ざん不能監査をうたわない。

R2/R3のNo-Goは[第1組記録](70-cto-staging-production-readiness.md)と[経路③レビュー](69-route3-review-20261104.md)のとおり維持する。

## 実行結果（inventory準備の限定scope受入済み）

新3ファイルは本体 `scripts/runtime-inventory.mjs`、独立テスト `scripts/runtime-inventory.test.mjs`、DB setupなしの `vitest.inventory.config.ts`。第1組の21ファイルは変更していない。新ツールはアプリをimportせず、Git/DB/配備を実行しない。

| 検査 | 結果 |
|---|---|
| 担当の独立合成テスト | 113件/1ファイル成功、exit0、4.43秒、setup0ms。固定集合、欠落、0byte、strictschema、リンク/非regular/容量、除外contents読取0、同size改変/途中差替え、CLI禁止manifest読取0など |
| Leadの凍結後再実行 | 同113件を独立再実行しexit0、5.82秒。既存pure220件も別configでexit0、1.84秒。今回新規113件を過去の全量1,860件に含めた全量runは行っていない |
| 構文/style/scan | nodecheck、対象2ファイルのBiome、secret scanがexit0。既存Biome設定の非推奨noticeのみ残る |
| Leadの実CLI inspect | exit0。133件（dist98＋bridge11＋serverps1 20＋root4）、合計2,148,647bytes、`deploymentReady:false`、limitations9件 |
| Leadの実CLI strictverify | exit0、inspectと同じ全entries/snapshot |
| 改竄manifest | 1 entryのdigestを変更しsnapshot自体も再計算した負対照をexit1 `INVENTORY_MISMATCH`で拒否 |
| false-ready | `deploymentReady:true`をexit1 `INVENTORY_MANIFEST_INVALID`で拒否 |
| 第1組候補の保全 | 21/21ファイルのhash不変、保全patchも不変 |
| 本番不変 | healthは`a5e0a67…`/production/DB ok、API/proxy/TunnelのPIDとNRestarts=0不変。今回切替・再起動・DB操作なし |

inspect/verifyのsnapshot SHA-256は `ce975357775993295176f0acd67625ba25030a586b95771425a6f7e8d5ee70dc`。manifestファイルのSHA-256は `b2bb2a7172bff4ead438eec6f9fd7cfe533ba95c1c018858815adae74d390c3f`。前者はentriesの内容整合用、後者は出力bytesの識別用であり、どちらも署名・正規commit/CI・信頼された出自の証明ではない。

証跡はprivate出力 `/tmp/aihd-runtime-inventory-jaotm_ar`（0700）に保存。`runtime-inventory.json`、`source-fingerprints.json`、`acceptance-summary.json`、改竄負対照の別manifestを保持し、生秘密値・名簿・承認者の内容は含めていない。対象code3ファイルの指紋台帳SHA-256は `00fb29467d37d292511c1f7754cbd8a5e77fcf0e69ca8a188189a9fa58918b4c`。

準備ツールの成功をitem11完了や配備準備完了に読み替えない。item12〜20は前回提示の未着手条件を維持する。Git commit/PR/必須CI/mergeと本番配備も未実施のままである。
