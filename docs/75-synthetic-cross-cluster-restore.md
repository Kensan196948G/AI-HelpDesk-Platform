# 75. 合成DBの別クラスタ復元・全行/主要カタログ照合（2026-11-06 JST）

## 結論と境界（要件1はPARTIAL）

**前回の合成検証クラスタにあった合成DBだけをcustom dumpし、別に新規initdbしたクラスタの空DBへ1回復元して、全ユーザーテーブル行（35表・54行）と、列挙した主要DDLカタログ（制約153・index 114・trigger 4・function 1・sequence定義5・sequence状態5）の一致を確認した。** 復元直前にDB名・port・データ領域・dump SHA-256を再確認し、6つの負対照はすべて復元を拒否した。別手法（`pg_dump`のCOPY multisetと正規化schema）による独立監査でも一致した。

ただし依頼条件1のうち、**owner・ACL・role・role membership・default privileges・tablespace・database-level設定は比較していない**（dump/restoreとも`--no-owner --no-privileges`、source userとtarget userも異なる）。したがって「全スキーマ定義が一致した」とは言わず、**要件1はPARTIAL**とする。要件2・3・4はPASS。総合でも**PARTIAL**であり、`deploymentReady:false`を維持する。

これは**合成fixture・同一ホスト・局所実験**であり、本番dump/DB/secret、正式なbackup運用、RPO/RTO、PITR、offsite、DR受入ではない。Git管理境界の数字1/2は未回答のため、stage/commit/PR/必須CI/merge/配備は未実施。

### 依頼条件への対応

| 条件 | 判定 | 根拠と範囲 |
|---|---|---|
| 1. 件数だけでなく全行の内容・schema定義・制約・index・trigger・function・sequence状態を比較 | **PARTIAL** | 全35ユーザーテーブルの全行をcanonical JSONBで比較し一致。制約153/index 114/trigger 4/function 1/sequence定義5/状態5も一致。**owner/ACL/role/tablespace/default privilegesは未比較**のため「全スキーマ定義一致」とは言わない |
| 2. 復元先は別の新規クラスタ内の空DBに限定 | **PASS**（空判定の範囲限定） | 新規`initdb`・別データ領域・別port・別PID。`template0`から新DBを作成。復元前のユーザーリレーション/sequence/view/matview/foreign tableは0。**function/type/policy等の全件列挙はしていない**（`template0`由来で空という補強のみ） |
| 3. DB名・port・データ領域・dumpハッシュを復元直前にも再確認 | **PASS**（TOCTOUの残余あり） | 復元直前にDB/user/port/data directory/空object数/dump bytes・mode・SHA-256を再取得。負対照6件は`restoreCalls:0`。ただしpath再読→`pg_restore` openの間の競合をfd固定で排除はしていない |
| 4. 再開でWAL/checkpointが更新されるため「ディスク無変更」とは扱わず、SQLデータの前後一致を確認 | **PASS** | 物理ディスクの同一性は主張しない。source before/afterのSQLレベル・カタログ・sequence状態が一致（`SOURCE_SQL_DATA_UNCHANGED`）。制約として`LOGICAL_DATA_NOT_DISK_BYTE_IMMUTABILITY`を記録 |

## 1. 材料と分離

| 項目 | 値 |
|---|---|
| 復元元 | `/tmp/aihd-portable-runtime-wpytdm08/pgdata`（前回の合成可搬runtimeのPG16クラスタ、停止済みから開始） |
| 復元元DB | `aihd_test_cfb66e429d8ba824`（当該クラスタ内で`aihd_test_<16hex>`パターンに一致するDBはこの1件だけ。37 migration・skills16・prototype state 1を事前確認） |
| 復元先クラスタ | `/tmp/aihd-synthetic-restore-v5-Oi5l1eIc/target-pgdata`（今回新規`initdb`、SCRAM、loopback、ランダムport） |
| 復元先DB | `aihd_test_ae684a44e554000c`（`template0`から新規作成。復元前のユーザーリレーション等0） |
| dump | custom形式、127,648 bytes、SHA-256 `ac03d7e69e87017284505151c1c9991daf04aab0ad959b8fca8619f38843a8e4`、mode `0600`、TOC読取成功 |
| 復元 | `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges`、exit 0 |

両クラスタはデータ領域・port・postmaster PIDが別であることを記録（`cluster-isolation.json`）。接続は127.0.0.1のランダムportとprivate Unix socketだけを使い、既存クラスタへは接続していない。本番dump/DB/secretは読取・copy・hashしていない。

## 2. 手順（1回の実復元）

1. 復元元クラスタを起動し、`aihd_test_<16hex>`パターンに一致するDBが1件だけであること、期待する合成データ（37/16/1）を確認。
2. 復元元の全テーブル行・カタログ・sequence状態を逐次取得（**単一トランザクションではない**）。
3. custom dumpを作成し、`pg_restore --list`でTOCを読取。dumpは0600、単一link、通常fileであることを確認。
4. 別の新規クラスタを`initdb`し、新DBを`template0`から作成。ユーザーリレーション等0を確認。
5. 6つの負対照（未作成扱い・非空・DB名不一致・port不一致・データ領域不一致・dump SHA不一致）が復元を呼ばないことを確認。
6. **復元直前に**、対象のDB名・user・port・データ領域・空オブジェクト数・dump bytes/SHA-256/modeを再確認。
7. `pg_restore`を1回だけ実行（`--single-transaction`）。
8. 復元先の全行・カタログ・sequence状態を取得し、復元元の復元前スナップショットと比較。
9. 復元元を再度スナップショットし、復元前後でSQLデータが変わっていないことを比較。

### 照合したカタログ群（10群）

`schemas`（1）/ `relations`（35）/ `columns`（535）/ `constraints`（153）/ `indexes`（114）/ `triggers`（4）/ `functions`（1）/ `views`（0）/ `extensions`（1）/ `sequence_definitions`（5）。

各群の定義はcanonical SHA-256で比較し、sequenceの状態は`last_value`と`is_called`を5件すべて比較した。`m`（materialized view）・`f`（foreign table）が存在すれば試験を失敗させるガードを置いた。system catalog行、large object、owner/ACL/role/tablespace/default privilegesは対象外。

## 3. 結果

| 比較 | 結果 |
|---|---|
| テーブル数 / 総行数 | 35 / 54 |
| 全行内容（テーブル別canonical SHA-256） | 復元元・復元先で全35テーブル一致 |
| カタログ10群 | 一致（制約153/index 114/trigger 4/function 1等） |
| sequence状態5件 | 一致 |
| 総合スナップショットSHA-256 | `2621ab6fed356762270c8b130ac52e944d1063fa135f9c925d11a4644c687d97`（復元前・復元先・復元元の復元後がすべて同一） |
| 14 checks | 14/14 PASS、失敗0 |
| 実復元回数 | 1（負対照の復元呼出0） |

複数回の実行でも合成スナップショットSHA-256は同じ値を再現した（dump自体のSHA-256はcustom headerの時刻等を含むため実行ごとに変わる。記録しているのは各実行のdumpとその束縛）。

## 4. 独立監査（別手法）とその限界

一次試験とは別に、`pg_dump`の出力だけを使うread-only監査を実施した。一次試験の`snapshot()`関数は使っていない。

| 監査項目 | 結果 |
|---|---|
| dump-at-rest | 記録したdump SHA-256と実ファイルが一致 |
| データ | `--data-only`のCOPY sectionをテーブルごとに分解し、行のmultiset SHA-256を比較。35テーブル・54行すべて一致（`bd53eec0…bba5`） |
| sequence | `setval`行のmultiset一致 |
| schema | `--schema-only --no-owner --no-privileges`を正規化（コメント・SET・restrict等を除外）した979行のmultisetが一致（`aaba1ec5…fb59`） |
| クラスタ分離 | データ領域・port・PIDが別であることを再確認 |
| 終了 | 両クラスタともfast stop exit0、port接続拒否、postmaster.pid不存在、PID不存在 |

限界：

- 監査は一次試験の`restore-verification.json`の`ok:true`と復元直前確認を入力として信頼しており、復元前にtargetが空だったことを独立経路で再取得してはいない。
- 監査時点で残っているdumpとmetadataの一致を見たもので、`pg_restore`実行直前のTOCTOUを監視したものではない。
- schema比較は行のmultiset（順序非依存）。今回は順序込みの比較でも979行一致したが、その事実は監査JSONには記録していない。
- `--no-owner --no-privileges`のためowner/ACLは比較しない。
- data-only監査dumpには循環FKのwarningがある（比較専用であり、そのSQLの再復元可能性の証明ではない）。

この監査は「復元後のデータ・schema比較を別方法で補強した」ものであり、restore全体を独立再現した証明ではない。

## 5. 再開とWAL/checkpointの扱い

復元元は「前回の検証用クラスタ」であり、今回の試験と独立監査で複数回起動・停止した。**起動のたびにWAL・checkpoint等の物理状態は更新され得るため、「ディスクが無変更」とは扱わない。** 比較したのはSQL上の全行・カタログ・sequence状態だけである。復元元の復元前後スナップショットが同一であること、および独立監査でも復元先と一致したことをもって、SQLデータが試験前後で一致したと判断する。autovacuum等の統計情報は比較対象外。

## 6. 停止と後始末

| 対象 | PID / port（一次試験） | 終了確認 |
|---|---|---|
| 復元先 | 3974801 / 49413 | fast stop exit0、portClosed、postmaster.pid不存在、PID不存在 |
| 復元元 | 3974361 / 35855 | 同上 |

独立監査の両クラスタ（3978992/50151、3978961/43217）も同様に停止確認済み。復元先DB・クラスタ・dumpはprivate `/tmp`領域に残しており、本番領域や既存DBには触れていない。

## 7. 反証レビューで残ったリスク（過大主張の禁止）

独立レビューは、要件2・3・4をPASS、要件1をPARTIALと判定した。残存リスクは次のとおり。

1. **所有者・ACL・role・default privileges・tablespace・database-level設定は未比較**。source userは`aihd_portable`、target userは`aihd_restore`で、一致を検証していない。「全スキーマ定義一致」は不可。
2. **スナップショットは原子的ではない**。テーブル・カタログ・sequenceを複数セッションで順次取得しており、単一のrepeatable-readトランザクションではない。
3. **並行writerの明示的排除は記録していない**。privateかつアプリ停止状態であることは補強材料だが、writerの排他・検証はしていない。
4. **復元直前確認はpathベース**。SHAを再読した直後に`pg_restore`がpathをopenするまでのTOCTOUを、fd固定・immutable参照で排除していない。
5. **空DB判定の範囲**。復元前の空判定は`r,p,S,v,m,f`のリレーション種別に限られ、function/type/policy等を全件列挙していない。`template0`由来であることが補強材料。
6. **独立監査の依存**。監査は一次試験の`ok`と復元直前確認を信頼し、復元前の空状態を独立に再検証していない。
7. **schema監査は順序非依存**。行のmultiset比較であり、理論上はオブジェクト間の行の入れ替わりを検出できない（今回は順序込みでも一致）。
8. **署名・外部改ざん耐性はない**。ファイル/JSONに電子署名はなく、環境外の改ざん耐性までは証明しない。
9. `source-binding.json`は復元側rootにあり、portable runtime側には置いていない。束縛した3ハッシュ（controller/final-freeze/runtime-verification）は実ファイルと一致した。

## 8. 支持できる主張 / 支持できない主張

支持できる：

- 合成・非本番の小規模な論理`pg_dump`/`pg_restore`実験で、全35ユーザーテーブル・54行の全列値が一致した。
- 列挙した主要DDLカタログ（制約・index・trigger・function・sequence定義・sequence状態）が一致した。
- targetは新規initdbクラスタ内の`template0`由来DBで、データ領域・port・PIDがsourceと別だった。
- 復元直前にDB名・port・データ領域・dump SHA-256を再確認し、6負対照を拒否した。
- SQLレベルのsource before/afterが一致し、disk不変を主張していない。
- production DB/dumpへの参照はない。

支持できない：

- 所有者・ACL・roles・default privileges・tablespacesを含む「全スキーマ定義の一致」。
- 復元前の空状態をprobeとは別経路で事後検証したこと。
- 原子的かつwriter隔離されたスナップショット。
- 物理ディスク/WAL/checkpointの不変性。
- restore全体の完全な独立再現監査、大規模データ・特殊スキーマでの成立。

## 9. 証跡

- 一次試験: `restore-probe.py`、`restore-verification.json`（14 checks）、`restore-target-confirmation.json`、`cluster-isolation.json`、`restore-guard-negative.json`、`dump-metadata.json`、`source-binding.json`、`source-before-snapshot.json`、`restored-snapshot.json`、`source-after-snapshot.json`
- 独立監査: `independent-audit.py`、`independent-audit.json`
- 引継ぎ: `AI-HelpDesk-Platform-cto-handoff/synthetic-restore-round-five/`
- 生データ（dump・PGDATA・password・private log）は証跡に含めない。snapshotは行内容そのものではなく、テーブル別の行数とcanonical SHA-256だけを保持する。

## 2026-11-06 追記（現況）

本記録は作成時点のもの。その後 PR #135 で commit・CI・merge 済み（merge `2deffab`）。**要件1 は PARTIAL のまま**で、owner・ACL・role・default privileges・tablespace・database-level 設定が未比較である点も変わらない。現況と follow-up は [docs/76](76-followup-20261106.md) を参照。本文の実測結果・数値・限界は作成時点の記録としてそのまま維持する。
