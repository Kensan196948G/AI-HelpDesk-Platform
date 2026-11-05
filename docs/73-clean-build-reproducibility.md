# 73. クリーン出力でのビルド再現性（2026-11-05）

## 結論と境界

**同一入力・同一compiler導入・同一local環境で、別の空出力先へ2回ビルドした結果の一致を確認した。** source変更の合成負対照も検出できた。正規commit/CI/署名による出自証明、独立した2回の依存導入、完全なruntime bundle、Staging/本番受入ではない。`deploymentReady:false`を維持する。

Git接続方法の数字選択はまだ回答されていない。回答を仮定せず、[Git管理境界](72-runtime-dependencies-and-git-boundary.md)の設定・権限・接続を変更しない。今回もstage/commit/PR/必須CI/merge/配備は未実施。候補26ファイル・本番チェックアウト・既存distは変更していない。

## 1. 入力と分離

新規private scratch `/tmp/aihd-clean-build-zjqi81oj`（0700）へ、次の103入力だけをコピーした。

| 入力 | 件数 |
|---|---:|
| APIの非test TypeScript | 98 |
| rootとAPIのpackage manifests | 2 |
| root package lock | 1 |
| base/API tsconfig | 2 |
| 合計 | 103 |

regular/non-symlink、元sourceとcopyのSHA-256一致を確認。既存dist、既存node_modules、env、承認manifest、allowlist、実名簿はコピーしない。input manifestは相対path・サイズ・hashのみで、Gitのdirty candidateを正規commitと表現しない。

空HOME・user/global npm config・cache・最小envと既知の管理proxyキーだけを使い、lockのresolved先が認証なしの標準registry、唯一のworkspace linkがapps/apiであることを検証してから、新しい依存導入を行った。

```text
npm ci --include=dev --ignore-scripts --no-audit --no-fund
  --registry=https://registry.npmjs.org/ --fetch-timeout=30000 --fetch-retries=0
```

導入はexit0、14.005秒、103入力の変更0。実compilerは新scratchのTypeScript **5.9.3**。Node **22.22.3** / npm **10.9.8** / Linux x86_64を使用した。compilerのpackage、shim `lib/tsc.js`、実装 `lib/_tsc.js`のhashを別に記録し、既存treeのcompilerへ解決を戻さない。

アプリ/config/server/distはimportせず、DB・SMTP・Access・端末操作の機能も呼ばない。compiler/依存コードの実行であり、OS sandboxや全外部write・通信不存在の実証ではない。

## 2. Node compile cacheへの対応

先行の`build-a/b/c`は196出力一致と合成差分検出に成功したが、TypeScriptの`tsc.js` shimが`module.enableCompileCache()`を呼ぶことを確認した。既定では共通TMPのcompile cacheを利用し得るため、先行結果を「全writeがscratch内」とする根拠にはしない。先行証跡は参考履歴として残し、最終結果へ流用しない。

最終実験は次を明示し、別の未存在outdir `final-a/b/c`で全工程を再実行した。

```text
NODE_DISABLE_COMPILE_CACHE=1
TMPDIR=<当該scratch>/tmp
```

Node組込APIのprobeはcompile cache status **3（DISABLED）**、exit0を返した。[Node 22公式仕様](https://nodejs.org/docs/latest-v22.x/api/module.html#module-compile-cache)とも整合する。専用TMPDIRとcache無効指定は、OSレベルの全write監視の代わりではない。

## 3. 比較方法

API tsconfigはrootDir=src、sourceMap=true、declaration=false。A/B/Cはすべてapps/api直下の同じ深さの新規ディレクトリにし、source mapの相対位置差を意図せず作らない。同一cwd/compiler/env/引数で、outDirだけを変更した。

```text
node <新scratchのtypescript>/lib/tsc.js
  --project apps/api/tsconfig.json --outDir apps/api/final-a
  --incremental false --noEmitOnError true --pretty false
```

B/Cは末尾の出力名だけ変更。`--build`モードは使わない。出力ごとの相対path・サイズ・SHA-256を記録し、98入力から期待する98JS＋98mapsの全集合と比較する。mapを正規化して差を隠さない。予期しない.d.ts/.tsbuildinfo/残留old outputも許容しない。

## 4. 最終実測（cache無効）

| 検査 | 結果 |
|---|---|
| final-A | exit0、7.121秒、98JS＋98maps＝196、欠落/余剰0 |
| final-B | exit0、8.433秒、同196、欠落/余剰0 |
| A/B一致 | 196相対path・サイズ・hashが全て一致。Cの後もA/B出力を再hashして不変 |
| 既存候補distとの比較 | JavaScript98件のbytehash差0。既存map・配信中bytesとの一致はこの比較の対象外 |
| final-C合成負対照 | scratchのerrors.ts末尾だけに合成コメントを追加、新規outdirへbuild、exit0、6.966秒、196出力 |
| Cで検出した差 | errors.jsとerrors.js.mapの2件だけ。JS/maps双方が変わることを設計の前提にはせず、実測として記録 |
| 入力復元 | Cの成否にかかわらずfinallyで元bytesへ戻す。復元後103入力のhash不一致0、元sourceとの不一致0 |
| mapsの相対参照 | A/B/C各98mapのsourcesはsnapshot内の元TSへ解決。mapを使ったデバッガ動作は未検証 |
| 元候補の保全 | 26/26ファイルのhash不変、元distの上書きなし |

最終要約 `final-verification-summary.json` のSHA-256は `7e1fded2829b585b29ed0f8df9027ec3e0c2e8419bcf142783d87ded0fea388f`。入力台帳SHA-256は `70aa75147e027eadebf69deeb869ad37708ddb0ce0c5c84bed46c6b6b83d9c9e`。出力台帳はA/B/Cのpath名を含むため、台帳ファイル自体のhashと、台帳内196entriesの一致は別の指標である。

実行主体はLead。Architectは比較契約のreadonly設計、独立Security/SREは別途の証跡照合を担当する。今回、アプリの全量テスト・正署名Access・実社員/貸与PC・別人物承認・復元・正式Staging/本番受入は行っていない。以前の全量1,860件や新inventory113件を、このbuild再現の追加テスト件数へ加算しない。

## 5. 未達と次工程

- A/Bは同じfresh npm installのcompiler treeで2回実行した。独立2install、別host/OS/Node/compiler、reproducible-buildの一般保証ではない。
- 103入力の束縛と出力一致は、未コミットcandidateを信頼された正本へ昇格させない。正規Git統合・同一head必須CI・署名/immutable artifactと配信bytes照合は未達。
- HTML/bridge/Skill/外部承認manifest/allowlist/実依存を同じreleaseへ安全にまとめる契約も未完了。item11は準備段階のまま。
- 起動時のカタログ同期はDB upsertを伴うため、build成功の次に実DBで「readonly起動確認」を行わない。アプリ受入は新規の専用合成DBに限定し、本番反映と別に扱う。
- Git管理境界の数字選択を未回答のまま変更しない。R2/R3 No-Go、独立Staging/復旧/実人物受入の未達を維持する。

## 独立受入（限定scope）

task24の独立Security受入はPASS-with-limits、新規未修正Critical/High/Medium/Low=0/0/0/0。最終要約とfreezeの束縛、指定10proofsの10/10 hash、入力台帳から独立生成した196出力集合、A/Bのpath/bytes/hash一致、A/C差2件をreadonlyで照合した。103入力復元・実compiler/output bytes・元26保全などはLeadの凍結記録として扱い、reviewer自身の再build・payload全再hashと混同しない。

task25の独立SRE受入も限定PASS。指定10proofsのhash一致、復元copy入力103件とA/B/Cの全588出力をhashだけ再計算し不一致0、A/B差0・C差2・欠落/余剰0を確認した。compiler payload・mapの意味解析は行わず、実compiler identity/元source一致/旧候補26保全/既存dist比較/本番不変はLeadの別実測として区別する。SREの再build・アプリ/DB/ネットワーク操作も0。

先行cache未指定の参考履歴は最終証拠に混ぜない。どちらの受入も正規CI/署名出自/完全bundle/アプリ・DB・Staging・本番受入の代替ではない。
