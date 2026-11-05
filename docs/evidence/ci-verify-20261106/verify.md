# main e7d7f6f の CI・静的検証 独立確認（Step3b）

- 実施者: ci-verifier（独立確認担当。他担当の結論を引用せず、本ファイルの実測のみを根拠とする）
- 実施日時: 2026-11-06 08:06–08:10 JST
- 対象リポジトリ: `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
- 対象 HEAD: `e7d7f6f9dc945bff48419b020bab40696fe05e3f`（branch `main`、`git rev-parse HEAD` で確認）
- 制約: `npm run build` は未実行（本番参照 dist の上書き防止）。dist への書込・systemctl 操作・DB 書込・git commit/push は未実施。
- 本確認で作成したリポジトリ内ファイルは本ファイルのみ。コマンドログはリポジトリ外の `/tmp/ci-verifier/` に保存した。

---

## 1. CI の実測

`gh run list --branch main --limit 5` で main の最新 run を取得し、`gh run view <id> --json ...` で確認した。

| 項目 | 実測値 |
|---|---|
| run id | `42119901615` |
| workflow / event / branch | `CI` / `push` / `main` |
| head sha | `e7d7f6f9dc945bff48419b020bab40696fe05e3f`（対象 HEAD と完全一致） |
| status / conclusion | `completed` / **`success`** |
| 実行時刻 | created `2026-11-05T22:15:15Z`、updated `2026-11-05T22:20:16Z`（所要 5m1s） |
| URL | https://github.com/Kensan196948G/AI-HelpDesk-Platform/actions/runs/42119901615 |

job 別結果（job は 1 件のみ）:

| job | status | conclusion | 開始–完了 |
|---|---|---|---|
| `verify` | completed | **success** | 22:15:17Z–22:20:15Z |

`verify` job のステップ別 conclusion は全 19 ステップが `success`（Set up job / Initialize containers / checkout / setup-node / Install / Secret scan / Dependency audit (runtime, high+) / Dependency audit (all deps, high+) / Typecheck / Lint / Migrate (empty DB) and re-run (idempotent) / Test / Build / Folder helper tests (pwsh) / Skill executor tests (pwsh) / Post setup-node / Post checkout / Stop containers / Complete job）。

CI ログから読み取れた実測値（ログ本文を `gh run view 42119901615 --log` で取得）:

- Typecheck ステップ: `npm run typecheck` が成功（api の `tsc --noEmit -p tsconfig.json` と worker の `tsc --noEmit -p worker/tsconfig.json` の 2 段構成）。
- Lint ステップ: `Checked 253 files`、`Found 346 warnings`、`Found 152 infos`。**警告 346 件・info 152 件は存在する**が、biome の exit code は 0 でステップは success。
- Test ステップ: `Test Files 98 passed (98)`、`Tests 2042 passed (2042)`、Duration 238.78s（DB コンテナを使うフルスイート）。
- Build ステップ: `tsc -p tsconfig.json` が success（CI 環境内でのビルドであり、本番 dist とは無関係）。
- Migrate ステップ: 空 DB への migrate と再実行（冪等性）が success。
- Secret scan / npm audit（runtime・全依存、high 以上）/ pwsh テスト 2 本も success。

補足: 上記 CI ログには CI 専用のダミー環境変数（テスト用 DB URL・CI 専用の固定文字列）が表示されるが、本ファイルには値を転記しない。

---

## 2. ローカル検証の実測

実行時刻: 2026-11-06 08:06:55–08:07:14 JST。4 コマンドを順に実行し、各 exit code を記録（`/tmp/ci-verifier/*.log` に保存）。

| # | コマンド | exit code | 実測件数・備考 |
|---|---|---|---|
| 1 | `npm run typecheck` | **0** | api（`tsc --noEmit -p tsconfig.json`）→ worker（`tsc --noEmit -p worker/tsconfig.json`）の順に実行され、エラー出力なし |
| 2 | `npm run lint` | **0** | `Checked 253 files in 600ms. No fixes applied.` / `Found 346 warnings.` / `Found 152 infos.` / 表示上限超過で `Diagnostics not shown: 478`。CI の Lint 実測値（253 files / 346 warnings / 152 infos）と一致 |
| 3 | `npm run test:pure` | **0** | `Test Files 7 passed (7)` / `Tests 289 passed (289)` / Duration 4.57s（内訳: ops-readiness 133、test-database-guard 78、dist-manifest 21、scan-secrets 9、smoke-guards 30、staging-smoke 8、test-database 10） |
| 4 | `npx vitest run --config vitest.inventory.config.ts` | **0** | `Test Files 1 passed (1)` / `Tests 113 passed (113)` / Duration 4.01s（`scripts/runtime-inventory.test.mjs`） |

ローカル合計: 8 ファイル / **402 テスト passed**。

**ローカルで実行していない検査（未実施であり、成功扱いしない）**:

- `npm test`（CI のフルスイート 98 ファイル / 2042 テスト）。DB を要し、DB 書込が禁止のため未実行。したがってローカル 402 テストは CI 2042 テストの**部分集合**であり、CI と同等の検証をしたとは言えない。
- Migrate / seed の冪等性確認、Secret scan、`npm audit`、pwsh の 2 テスト。
- `npm run build`（禁止事項のため意図的に未実行）。

---

## 3. 本番 dist との乖離

### 3.1 本番が参照している dist の特定（read-only）

systemd user unit ファイル `~/.config/systemd/user/ai-helpdesk-api.service`（＋ drop-in `restart-always.conf`）を**読取のみ**で確認した（systemctl は未実行）。

- `WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
- `ExecStart=/home/kensan/.nvm/versions/node/v22.22.3/bin/node apps/api/dist/index.js`
- すなわち本番は**リポジトリ直下の `apps/api/dist`** を実行している。

本番 health（`curl http://127.0.0.1:18950/api/health`、08:07:41 JST）:

```
ok:true / service:ai-helpdesk-api / version:0.1.0
commit:a5e0a6719699d4711fc1811bbdb79c74d9aab393 / db:ok / env:production
```

注意（重要な限界）: health の `commit` は `apps/api/src/index.ts:22` の `commit: config.COMMIT_SHA ?? ''` であり、**環境変数 `COMMIT_SHA` の自己申告値**である。dist の内容と commit を暗号学的に結び付けるものではない。
（参考: proxy 側ポート `127.0.0.1:18949` も同時刻に同一 payload を返した。docs/77 の構成では 18949 は 18950 への sidecar proxy であり、staging の状態評価は本タスクの範囲外・未検証。）

### 3.2 本番 dist の現物

| 項目 | 実測値 |
|---|---|
| `apps/api/dist` 内の `.js` 本数 | **98** |
| 最終更新時刻（最新ファイル） | `2026-11-04 10:04:02 +09:00`（`index.js` 等。ディレクトリ mtime は 11-04 09:54） |
| git 管理 | 対象外。`.gitignore:18` の `apps/api/dist/` で ignore されており、`git status --porcelain apps/api/dist` は差分を出さない |
| dist-manifest | リポジトリ直下・`apps/api` 配下のいずれにも `dist-manifest.json` は**存在しない** |

`git diff --stat a5e0a67..e7d7f6f` の実測: **67 files changed, 7337 insertions(+), 88 deletions(-)**（うち `apps/api` は 16 ファイル）。
`apps/api` の変更 16 ファイル（変更 13・追加 3）の内訳: 実装 10（`config.ts` / `db.ts` / `folder-access/service.ts` / `lib/mirai-info.ts` / `lib/test-database.ts`（追加）/ `server.ts` / `support-session/helper-routes.ts` / `support-session/routes.ts` / `support-session/service.ts` / `support-session/skill-source.ts`）とテスト 6（`auth/access-jwt.test.ts` / `config.test.ts` / `lib/test-database.test.ts`（追加）/ `route-inventory.integration.test.ts`（追加）/ `support-session/skill-source.test.ts` / `support-session/support-session.integration.test.ts`）。

### 3.3 本番 dist と main(e7d7f6f) ビルド成果物の直接比較

`npm run build` は実行できないため、既に存在する e7d7f6f のビルド成果物（不可変 release、下記）と本番 dist を `diff -rq` で read-only 比較した。

比較対象: `/home/kensan/ai-helpdesk-prod/releases/20261106T071603-e7d7f6f9dc94/apps/api/dist`（2026-11-06 07:15–07:16 に生成、`.js` 98 本、manifest 196 ファイル）

結果: **一致しない**。

- 差分（differ）: 18 ファイル（9 モジュール × `.js` + `.js.map`）
  - `config`、`db`、`folder-access/service`、`lib/mirai-info`、`server`、`support-session/helper-routes`、`support-session/routes`、`support-session/service`、`support-session/skill-source`
- 本番 dist のみに存在: 2 ファイル
  - `lib/prototype-knowledge.js` / `lib/prototype-knowledge.js.map`
  - 当該ソースは commit `4533215`（#130）で削除済み。tsc は dist を掃除しないため、**本番 dist には削除済みソースの古い生成物が残存**している。
- e7d7f6f release のみに存在: 2 ファイル
  - `lib/test-database.js` / `lib/test-database.js.map`（#136 以降で追加されたソース。本番 dist には未反映）

結論: **本番が実行している dist は e7d7f6f のビルド成果物ではない**。`a5e0a67`（2026-11-04 10:03:37 コミット）の 25 秒後に dist が更新されている点は状況証拠にすぎず、本番 dist の由来を commit に結び付ける manifest は存在しない。

### 3.4 dist-manifest の現況（read-only、書換なし）

- (a) **CLI 検証は失敗**: `node scripts/dist-manifest.mjs --verify --manifest <release>/dist-manifest.json --commit e7d7f6f...` → exit **1**、`DIST_MANIFEST_MODE_INVALID`。
  - 原因: `scripts/lib/dist-manifest.mjs:266` が manifest のパーミッション `0600` を要求するが、release は配備時に読取専用化されており実ファイルは `0400`。検証のための chmod は dist/release への書込に当たるため**実施していない**。
- (b) 同一ライブラリによる読み取り専用の等価検証（`readFileSync` + `verifyManifestAgainstDist`、CLI ではない）: **OK**、`sha256 = 29913c01625b1cb568d5fa78b95bf3e6ecc57c6791cb38f5ce92ea3e7b8f6061`（196 ファイル）。e7d7f6f release の dist は自身の manifest と整合している。
- (c) 本番 dist 側: manifest 自体が存在せず、`a5e0a67` の時点で dist-manifest 機能は未導入（`git ls-tree a5e0a67` に該当スクリプトなし）。よって**本番 dist の整合性は manifest では検証できない**。

### 3.5 既存 release の状態（本番には未適用）

- `/home/kensan/ai-helpdesk-prod/releases/20261106T071603-e7d7f6f9dc94` が存在（e7d7f6f のビルド、生成 2026-11-06 07:15–07:16）。
- 同ディレクトリの `state/deploy-*.json`: `{"ref":"e7d7f6f...","previous":null,"result":"dry-run","healthPort":18950}`。
- `/home/kensan/ai-helpdesk-prod/current` シンボリックリンクは**存在しない**（`deploy-release.sh` の `--dry-run` は「build のみ、switch・restart なし」）。
- したがって本番は引き続き上記 3.1 の repo 直下 dist（health 上 `a5e0a67`）を実行しており、e7d7f6f への切替は行われていない。本確認で切替・再起動は一切実施していない。

---

## 4. 未検証事項（実施していない・断定できないこと）

1. `npm test`（フルスイート 98 ファイル / 2042 テスト）のローカル再現。DB 書込禁止のため未実行。ローカルの緑（402 テスト）は CI の緑の代替にならない。
2. Migrate / seed / 冪等性、Secret scan、`npm audit`、pwsh テストのローカル再現。CI 上では success（1 章）だが、本確認ではローカル実行していない。
3. `npm run build` の再現と、生成物とソースの一致確認。本番 dist 保護のため意図的に未実行。
4. 本番 dist（98 JS）が `a5e0a67` のソースから生成されたことの証明。manifest 不在・`COMMIT_SHA` は自己申告のため、mtime の状況証拠しかない。
5. 本番 dist と e7d7f6f の差分が**実行時に与える影響**の評価（差分 9 モジュールの挙動差の検証、ステージングでの受入）。
6. e7d7f6f の release を本番へ適用する作業そのもの（dry-run 記録のみが存在。切替・health 再確認・rollback 訓練は未実施）。
7. systemd の稼働状態・PID・NRestarts（systemctl 操作禁止のため未確認。unit ファイルの読取のみ）。
8. staging 環境（18949 側の構成・health の意味）の評価。本タスクの範囲外。
9. dist-manifest CLI による release 検証の完了（`0400` のパーミッション制約により CLI では失敗。同等のライブラリ検証のみ成功）。

---

## 付録: 実行コマンド（要旨）

```
git rev-parse HEAD
gh run list --branch main --limit 5
gh run view 42119901615 --json headSha,headBranch,event,status,conclusion,workflowName,url
gh run view 42119901615 --json jobs --jq '.jobs[] | {name, steps: [.steps[]? | {name, conclusion}]}'
gh run view 42119901615 --log            # Test/Lint/Typecheck/Build の件数を抽出
npm run typecheck ; npm run lint ; npm run test:pure ; npx vitest run --config vitest.inventory.config.ts
git diff --stat a5e0a67..e7d7f6f ; git diff --name-status a5e0a67..e7d7f6f -- apps/api
git ls-tree -r --name-only a5e0a67 | grep -E 'dist-manifest|test-database|prototype-knowledge'
find apps/api/dist -name '*.js' -type f | wc -l ; find apps/api/dist -type f -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n'
git check-ignore -v apps/api/dist
diff -rq apps/api/dist <release>/apps/api/dist
node scripts/dist-manifest.mjs --verify --manifest <release>/dist-manifest.json --commit e7d7f6f...
curl -sS -m 5 http://127.0.0.1:18950/api/health
```
