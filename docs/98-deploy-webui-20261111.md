# 98. WebUI 変更（4ce1c7d）の本番・Staging 配備と、配備中の本番停止・復旧の記録（2026-11-11）

## 0. 結論

PR-1〜3・条件付き 2 機能・受入レポート（main `4ce1c7d`）を **Staging と本番へ配備した**。

- 配備後の health は両環境とも `commit=4ce1c7d`、`db=ok`、`ok=true`。unit は active、`NRestarts=0`。
- ただし**本番の最初の配備で、unit の `EnvironmentFile` が一時ファイルに置き換わり、本番 API が約 2 分 25 秒停止した**（14:37:30〜14:39:54）。復旧後、正しい設定で再配備して成功した。
- Access OTP による UI 受入（V-3〜V-6）と #5 の通しは**未実施**（人間のログインが必要）。

## 1. 配備対象

| 項目 | 値 |
|---|---|
| commit | `4ce1c7d79611e93581230b958963d632630c8c1d`（main / origin/main 一致） |
| PR | #163〜#168 |
| DB | 変更なし（migration を渡していない） |
| release | Staging `20261111T143657-4ce1c7d79611` / 本番 `20261111T144004-4ce1c7d79611` |
| dist-manifest | `dda26d8f810e88e18468e0b681d2b187d8686463ad0f746213b62946462fecf5`（両環境一致） |

## 2. 配備前の実測（14:36 JST）

- 本番 `9a4eacc` / Staging `0dbb1b7`、両方 `db=ok`・unit active・`NRestarts=0`
- 直近 backup: `ai_helpdesk_preview-20261111-023320.dump`（266,820 B）
- 前回の current（rollback 先）: 本番 `releases/20261106T121453-9a4eaccca62e`、Staging `releases/20261106T123305-0dbb1b7bb704`
- ディスク空き 116G

## 3. Staging 配備（成功）

- `deploy-release.sh --root /home/kensan/ai-helpdesk-stg --unit ai-helpdesk-stg-api --health-port 18952`（`--migrate` / `--seed` なし）
- 結果: release `20261111T143657-4ce1c7d79611`、health `commit=4ce1c7d`・`db=ok`、unit active・`NRestarts=0`（MainPID 241415）
- 配信 release に新しいブリッジ 5 本と原本 HTML が含まれることを確認
- 14:36 の時点で Staging は旧 release の duplicate を prune し、current と previous を保持

## 4. 本番配備の失敗と復旧（インシデント）

### 4-1. 何が起きたか

1回目の本番配備（14:37:30）は、**unit テンプレートの `__ENV_FILE__` に一時ファイル `/tmp/aihd-deploy-env` が埋め込まれた**ため、再起動後に `DATABASE_URL` と `SESSION_SECRET` が読めずに起動失敗した。

- 症状: `http://127.0.0.1:18950/api/health` が `ECONNREFUSED`、unit は `active (auto-restart)`・`NRestarts=27`、journal に「環境変数が不足しています（DATABASE_URL / SESSION_SECRET）」
- 配備スクリプトは health 失敗で previous（`9a4eacc`）へ rollback したが、**unit ファイルは壊れたまま**だったため rollback 先も起動できず、「rollback release did not pass health either; manual action required」で停止した。
- 停止時間: **約 2 分 25 秒**（14:37:30 の切替から 14:39:54 の health 復帰まで）。この間、公開 URL は Access の 302 を返すが、その先の API は応答できなかった。

### 4-2. 原因

`deploy-release.sh` の `--env-file` は、通常の配備では検証にしか使わないが、`--unit-template` を指定した場合は **unit の `EnvironmentFile` に文字列として埋め込まれる**（`__ENV_FILE__`）。秘密値を読み取らないための回避策として一時ファイルを渡したことが、本番 unit の設定を壊した。

### 4-3. 復旧

1. 退避: 壊れた unit を `ai-helpdesk-prod-api.service.bak-20261111-1439` に保存
2. unit の `EnvironmentFile` を本来の `/home/kensan/.config/ai-helpdesk/api.conf` に戻す（`release.env` の後置は維持）
3. `systemctl --user daemon-reload` → `restart ai-helpdesk-prod-api`
4. 14:39:54 に health 復帰（`commit=9a4eacc`、`db=ok`）を確認

### 4-4. 再配備（成功）

- `--env-file /home/kensan/.config/ai-helpdesk/api.conf` を指定して再実行（14:40:04）
- release `20261111T144004-4ce1c7d79611`、health `commit=4ce1c7d`・`db=ok`、unit active・`NRestarts=0`（MainPID 266866）
- previous は `9a4eacc` の release を保持（rollback 可能）

## 5. 配備後の検証（サーバー側）

| # | 環境 | 結果 |
|---|---|---|
| V-1 | Staging / 本番 | health の `commit` が `4ce1c7d` と一致、`db=ok`、`ok=true` |
| V-2 | 両環境 | unit `active (running)`、`NRestarts=0`、`ExecMainStatus=0` |
| V-7 | 本番 | 公開 URL は **302**（Access のゲート）。API は loopback で `db=ok` |
| — | 両環境 | 配信 release に新しいブリッジ（kb-trial / knowledge-review / kb-reflect / intake-preview / pc-supplement）と原本 HTML が存在 |

**未実施（人間の OTP が必要）**: V-3〜V-6（配信ページの表示、5 タブ、候補一覧・AI検査・承認進捗、固定フッター・監査全件・今回反映、入力チェック、PC補足）と #5 の通し。

## 6. 再発防止

- `scripts/deploy-release.sh` にガードを追加: `--unit-template` を使うとき、`--env-file` に `DATABASE_URL` と `SESSION_SECRET` が含まれなければ、**build・unit 配置・切替の前**（引数検証の段階）に失敗する（値は表示しない）。
- 検証: `bash -n` で構文を確認し、ガードの判定（`grep -q '^DATABASE_URL='` / `^SESSION_SECRET=`）が実設定では成立し、プレースホルダでは成立しないことを確認した。**実スクリプトでの負の実行テストは未実施**（配備スクリプトの実行は承認が必要で、このセッションでは承認プロンプトが無効のため）。ガードは `build_release` より前にあるため、失敗時に release は作られず、current も切り替わらない。
- 教訓: `--env-file` は「検証用の引数」ではなく、**unit テンプレート使用時は unit の設定そのもの**。プレースホルダを渡してはいけない。
- 残る注意: 配備スクリプトの自動 rollback は **release の切替**を戻すが、**unit ファイルは戻さない**。unit を変更する配備では、失敗時に unit の復元も必要（今回は手動で復旧）。

## 7. 現在の状態

| 項目 | 値 |
|---|---|
| 本番 | `4ce1c7d`（release `20261111T144004-4ce1c7d79611`）、health OK、unit active |
| Staging | `4ce1c7d`（release `20261111T143657-4ce1c7d79611`）、health OK、unit active |
| 本番 DB | 変更なし。backup `ai_helpdesk_preview-20261111-023320.dump` は有効 |
| 未実施 | Access OTP での V-3〜V-6、#5 の通し、#5/#8 など残りの受入、新しいリリース判定 |

## 8. 参照

- 配備準備: [docs/96](96-release-prep-webui-20261111.md)
- 機能: [docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md) / [docs/97](97-conditional-features.md)
- 正本の手順: [docs/82](82-promotion-runbook-20261106.md)、[docs/85](85-production-cutover-20261106.md)
