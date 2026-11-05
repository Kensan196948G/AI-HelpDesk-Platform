# 72. 隔離した本番依存再現とGit操作境界（2026-11-05）

## 結論と対象

**依存の限定再現は成功。Git正規統合・immutable bundle・独立Staging・本番構築は未完了。** 第1組＋inventory準備の25ファイルを変更せず、新たな非配備scratchだけで依存導入と直接依存のentry importを確認した。本番のNode依存・サービス・DB・Cloudflare設定は変更していない。

この実測は、[Runtime inventory準備](71-runtime-inventory-preparation.md)で未検証だった依存条件の一部を埋めるものであり、同文書の過去結果や`deploymentReady:false`を上書きしない。新しいアプリコード・認証設定・承認manifest readerの変更もない。

## 1. Git MCP拒否の確定原因（SREのreadonly診断）

- 稼働プロバイダーは `@cyanheads/git-mcp-server 2.15.1`。実nodeプロセスとインストール済み単一bundleを特定した。
- 明示設定 `GIT_BASE_DIR=/home/kensan/Projects/Deep-Seek-Harness-Project` を**その1キーだけ**観測。HelpDesk主作業ツリーと候補worktreeは、この許可rootの外にある。
- sourceの working-directory resolver はセッションdir解決後にもこのbaseDirでpathを検証し、root外で `Path traversal detected: attempts to escape the defined root directory.` を返す。
- `git_set_working_dir` はセッション保存であり、`skipPathResolution:true` のため設定成功と操作拒否が両立する。作業場所の表示は操作権限の付与ではない。
- 主/候補pathはcanonicalでsymlinkなし、linked worktreeの`.git`/commondir/gitdir関係も相互一致。今回の拒否はsymlink異常でも曖昧なcwd仮説でもなく、明示root境界に一致する。

根拠はインストール済みv2.15.1のresolver/サニタイズ/set-working-dirと、[公式設定文書](https://github.com/cyanheads/git-mcp-server#configuration)。公式mainの版と実機版を混同せず、動作経路は実機sourceで照合した。診断はreadonly・20分以内。Git操作の再試行、設定/root/policy変更、サービス再起動は行っていない。

### 正規解消案（未実行・管理者判断が必要）

1. **候補リポジトリだけに限定する専用Git MCP接続を管理者が登録する。** 現在のDSH用Git接続を置換せず、親Projects全体やroot無制限へ広げない。candidate worktreeのGitオブジェクト/設定等は主repoの共通gitdirを使うため、path制約は完全なOS sandboxではないという共有範囲も承認対象とする。
2. 現在の境界を維持し、管理者へ保存patch・指紋・検証記録を引き継いで正規統合してもらう。

どちらも、このセッションが別shell/APIでGit拒否を迂回する許可ではない。新しい接続の登録・再起動・権限変更も今回実施しない。解消後はまずreadonly status/diffで対象と同一性を確認し、明示stage/正規PR/同一head必須CI/独立レビュー/自動mergeの順を守る。CI YAMLのDEPLOY critical拒否は別の未達として維持する。

## 2. 本番依存の再現実験

### 分離条件

- 新規private scratch `/tmp/aihd-prod-deps-tsn1m6c7`（0700）へ、root `package.json` / `package-lock.json` / API `package.json` の**3ファイルのみ**コピーした。
- 既存`node_modules`、プロジェクト/HOMEの`.npmrc`、環境ファイル、token・資格情報はコピーしない。空のHOME・user/global npm config・新規cache、固定Node/npmの最小環境を使用。
- 管理されたnetwork proxyの既知キーだけを転送し、userinfoを含まないことを値を表示せず検査。拒否された場合にproxy/registry/TLSを切り替える手段は用いない。
- 通信前にlockの198エントリを確認。resolvedは`https://registry.npmjs.org`で認証userinfoなし、唯一のlocal workspace linkは`apps/api`。任意git/file/外部URLは受け入れていない。
- Node **22.22.3** / npm **10.9.8** / Linux x86_64で実施。別OS/Node/npm、署名済みbuildや完全なsupply-chain保証の証明ではない。

実行した導入条件:

```text
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  --registry=https://registry.npmjs.org/ --fetch-timeout=30000 --fetch-retries=0
```

`npm ci`はlock不一致を拒否し、lock/manifestを更新しない契約（[npm 10公式](https://github.com/npm/cli/blob/v10.9.9/docs/lib/content/commands/npm-ci.md)）。既存依存を消す動作があるため、空のscratch以外では実行していない。devをlockから削除/剪定した新lockも生成していない。

### 実測結果

| 検査 | 結果 |
|---|---|
| 新規production-only導入 | exit0、2.47秒、55 packages追加、install scripts無効 |
| manifests/lock不変 | 元/copy/導入後の3ファイルSHA-256が一致 |
| `npm ls --omit=dev --all --json --ignore-scripts` | exit0、全treeのproblems/missing/invalid/extraneousは0 |
| graphの件数 | 列挙経路69件（重複を含む）。物理55 package数やlockの198entryと同じ意味ではない |
| installed metadata | hidden lock56entry（workspace linkを含む）を入力lockへ照合し不一致0、dev entry導入0、production install-script entry0 |
| 直接依存6種類 | scratch内のESMから全6entryを先にresolve/realpath照合後、そのentryだけimport成功。アプリ/distはimportしない |

直接依存の実解決版：`@fastify/cookie 11.1.3`、`fastify 5.12.7`、`dotenv 16.6.1`、`nodemailer 10.2.1`、`postgres 3.4.9`、`zod 4.6.7`。

probeは全entryが当該scratchの`node_modules`にあることを**import前に**確認した。`dotenv/config`でなく`dotenv`本体をimportし、アプリのconfig、constructor/config/connect/listen/send等のメソッドは呼ばない。ただし依存のimport自体はコード実行であり、OS sandboxや完全な無通信・無副作用の証明ではない。明示メソッド未呼出と、依存内部の全動作を監視/証明したことは区別する。

今回は別途の脆弱性監査・SBOM・アプリ実稼働・PDF/SMTP/DB/JWKS機能・正署名Access受入を検証していない。過去のaudit成功をこのscratchの独立audit結果として流用しない。`deploymentReady`はfalseのままである。

## 3. 本番資産化に残る3契約（Architectの未採択案）

### A. 承認manifestとPIIの外部供給

現在はresolve側とsupport側の2readerが固定相対pathを読む。候補は、①release内既定相対位置への外部read-only bind mount（コード変更不要、OS権限/所有者/更新契約が必要）、②両readerへ一元的な絶対path設定を追加（mount不要だが別scope・認可/負対照レビューが必要）。承認metadataの投影は帰属・監査を変えるため今回採択しない。どの案も実装/本番適用/秘密読取の許可ではない。

重要な副作用として、`buildServer`のカタログ同期は起動時にDB upsertを行い、manifest/PSが欠けたり一致しなければapproved→draft、承認者/日時のnull化が起き得る。R2/R3 offでも起動をreadonly検査として実DBで試さない。将来のアプリ受入は専用合成DBを前提とする。実承認manifest・allowlist内容は今回未読。

### B. dependency closure

root/API manifests/lockを1組で扱う。今回、空scratchでの導入・一覧整合・直接6entry importまで確認したが、全アプリ経路・optional/peerの全動作・OS外部binary・future releaseへの同一性を証明したわけではない。API packageだけを切り出して別graphの`npm install`を行わない。

### C. build出自

次はsource/tsconfig/compiler/Node/npm/lockと、**新規outdir**に生成したJSを束縛する。既存distをhashし直すだけでは残留oldbuild排除やsource→build一致を示せない。新outdirへの2回build同一性、source差分の負対照、正規commit/同一head CI、署名/immutable artifact、配信bytes照合は今後の別検証であり未実施。

## 4. 証跡と受入状態

scratch内に `input-hashes.json`、`install-summary.json`、`npm-ci.log`、`npm-ls.json`、`entry-probe.json`、`verification-summary.json`、`installed-metadata-summary.json` と専用probeソースを保存（ログ/要約0600）。元の25ファイルは全hash不変。Leadのread-only確認では本番health `a5e0a6719699d4711fc1811bbdb79c74d9aab393` / production / DB ok、API/proxy/Tunnel PIDとNRestarts=0不変。

実験主体はLead、task21の独立Security受入はPASS-with-limits、新規未修正Critical/High/Medium/Low=0/0/0/0。指定安全証跡9/9のhash一致、input/source/copy/導入後の3manifest一致、実依存一覧の問題0・直接6entry・private権限・probe境界をreadonlyで独立照合した。再実行・全installed bytesの証明ではない。検証要約SHA-256は`d927a23a2eb70f9863343bc1265189889eee9100281274ebf974cd5ddaf43a42`。受入後の変更はこの結果追記だけで、旧候補25ファイル・probe/証跡は不変。

Git root診断はSRE、契約案はArchitectのreadonly報告であり、実適用・配備完了の自己申告と混ぜない。正規commit/PR/今回必須CI/merge/配備は未実施。R2/R3 No-Go、独立Staging・復元・実社員/貸与PC・別人物承認の未受入を維持する。次は上記のGit管理境界の正規解消方法だけを数字選択で確認する。他root拡張・認可コード変更・秘密読取・配備の承認へ拡張しない。
