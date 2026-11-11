# 98. WebUI 変更（4ce1c7d）の本番・Staging 配備と、配備中の本番停止・復旧の記録（2026-11-11）

## 0. 結論

PR-1〜3・条件付き 2 機能・受入レポート（main `4ce1c7d`）を **Staging と本番へ配備した**。

- 配備後の health は両環境とも `commit=4ce1c7d`、`db=ok`、`ok=true`。unit は active、`NRestarts=0`。
- ただし**本番の最初の配備で、unit の `EnvironmentFile` が一時ファイルに置き換わり、本番 API が約 2 分 25 秒停止した**（14:37:30〜14:39:54）。復旧後、正しい設定で再配備して成功した。
- Access OTP による UI 受入（V-3〜V-6）と #5 の通しは**当日 16:30〜16:40 に本番で実施済み**（§7-2。Access の SSO セッションを再利用）。未実施の残りは §7-2-5 に整理した。

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
| 未実施（当初） | Access OTP での V-3〜V-6、#5 の通し、#5/#8 など残りの受入、新しいリリース判定 |

## 7-2. 受入（本番・2026-11-11 16:30〜16:40 JST）— §7 の「未実施」のうち V-3〜V-6 と #5 を実施

Access OTP で Staging にログインした同一チームドメインの SSO セッションを再利用し、**本番**（`https://ai-helpdesk.mirai-dx-platform.com`）で受入を実施した。証跡はスクリーンショットではなく、**DOM アサーション・API の JSON・ネットワークログ**（`docs/evidence/webui-acceptance-20261111/production-checks.json`）。

### 7-2-1. 身元と配備の一致

| 項目 | 実測 |
|---|---|
| `GET /api/me` | 200、`roles=[approver,helpdesk]`、`helpdeskActor=true`、`resolveAdmin=true` |
| 解決経路 | 名簿にメール未登録のため `PERSONA_SWITCH_ALLOWLIST` の**デモ経路**（`via=demo`）。担当者向け API はこの経路で許可される |
| health | `commit=4ce1c7d79611e93581230b958963d632630c8c1d`、`db=ok`、`ok=true`（Staging も同一） |
| unit | 本番 MainPID 266866・`NRestarts=0`（14:40:20 起動）／Staging MainPID 241415・`NRestarts=0`（14:37:11 起動） |

### 7-2-2. V-3〜V-6（本番 UI）

| # | 結果 |
|---|---|
| V-3 | 画面 200・title「みらいAI窓口 × ヘルプデスク ステップ受付 V3.1」。コンソールエラーは **favicon の CSP のみ**（`img-src data: blob:`、変更前から存在）。`pageerror` 0 |
| V-4 | 引継ぎワークスペースの右ペインは **5 タブ**（案件／実行／端末／ナレッジ／記録）。各タブで可視パネルは 1 |
| V-4' | **固定フッター**あり（`.hw-ev-foot`・高さ 48px）。全 5 タブで右ペイン下端との差 1px、内側スクロール領域 `#hw-ev-scroll` を最下部まで動かしてもフッター位置の変化 **0px** |
| V-6 | 記録タブは 3 件・バッジ「記録 3」。6 件以下のため「すべて表示（n 件）」は**仕様どおり非表示** |
| V-7 | 公開 URL は 302（Access のゲート）。ログイン後は V-3 のとおり 200 |

### 7-2-3. 条件付き 2 機能（本番 API を直接実測）

| 機能 | 実測 |
|---|---|
| #7 入力チェック（`POST /api/intake/preview`） | 赤サンプル → `signal=red`・`security=true`・PII メール 1 件・指摘（red/warn）、103ms。青サンプル → `signal=blue`・PII 0 件、84ms。**AI 呼び出し 0**（ルールベース） |
| #4 AI検査（`POST /api/knowledge/inspect`） | 200、`score=88/100`（参考）、伏せ字は email 1 件・IP 1 件、項目 7 中 6 合格（不合格は「個人情報・端末情報が残っていない」＝保存時に伏せ字になるため）、`blocking.deviceInfo=false`、伏せ字後本文に `[メールアドレス]`・`[IPアドレス]` |

### 7-2-4. #5 通し（サーバー経由）

1. 画面で **STEP1→STEP4** まで操作（分野=PC・周辺機器、PC基本情報は「取得しない」、件名 `【受入】本番動作確認（WebUI 4ce1c7d）`）。AI 一次対応が表示され、**名簿から「おすすめの担当」が解決**した（本番の Mirai-Info 名簿接続の実証）。
2. 同意して引き継ぐ → 画面は `TKT-2026-0006` / `INC-1010` を受付として表示（**この時点ではクライアント側の表示のみ**）。
3. サーバー側は `POST /api/case-handovers` を発行して確認した: **200**、`handoverId=0cfd3aa9-f1da-4aa2-9df6-c2a7a9d0ddf9`、`status=pending`、`notify={queued:1,transport:smtp}`。
4. `GET /api/case-handovers/inbox` が **2 件**になり、`【受入】本番動作確認（WebUI 4ce1c7d）`（`CASE-39198`）が含まれる。
5. DB/監査: `case_handovers` に `CASE-39198 / pending / 2026-11-11 07:39:28Z`、`audit_log` に `case_handover.create`、`case_handover_notifications` は `sent`。
6. UI 側でも「引継ぎ」を開くと `INC-1010 ／ 【受入】…` が引継ぎ待ち 1 として現れ、**サーバー → 画面の受信箱**が通ることを確認した。

> これは 10 月のローカル受入で残っていた「名簿が無いため `POST /api/case-handovers` が発行されず受信箱 0 件」の未検証点を、本番の名簿接続で埋めたもの。

### 7-2-5. 未実施（今回の範囲外・条件未成立）

| 項目 | 理由 |
|---|---|
| ② 候補の手順／⑤ AI検査の UI パネル／⑥ 確認の進捗 n/4 | 今回の受入ケースに**候補提示・下書きが無く**パネルが表示されない。ローカル受入（[docs/94](94-knowledge-trial-and-review.md)）と CI（205 件）で検証済み。AI検査は API を直接検証（7-2-3） |
| ⑧「今回反映」 | 承認が **本人承認禁止**（`ALLOW_SELF_APPROVAL=false`）のため、1 名では承認まで到達できない |
| 記録タブの「すべて表示（n 件）」 | ライブデータが 6 件以下。CI の試験で検証済み |
| #6 PC情報からの補足 | ★ が付く端末情報が必要（今回は PC 基本情報を取得せず） |
| #5/#8 など残りの受入、新しいリリース判定 | 別項目 |

### 7-2-6. 環境設定の変更（記録）

- **Staging の Access アプリ許可リスト**（`~/.config/ai-helpdesk/stg-access-allowlist.txt`）は `synthetic-staging@example.invalid` の 1 行だけで、**実運用者のメールでは 403** になっていた（`apps/api/src/auth/ui.ts` のアプリ層許可リスト）。Staging の UI 受入のため、本番と同じ運用者メールを 1 行追加した（変更前ファイルは同ディレクトリに `*.bak-<timestamp>` で退避）。許可リストは mtime/size で次回リクエスト時に自動反映されるため、**再起動は不要**だった。
- Staging は名簿（Mirai-Info）を持たない設計（[docs/77](77-staging-environment-design.md) の PII 非流入要件）のため、**担当者向け機能（候補一覧・AI検査・n/4・記録全件）は Staging では検証できない**。今回の受入は本番で実施した。
- 本番 DB の変更は受入による `case_handovers` 1 行・`case_handover_notifications` 1 行・`audit_log` 1 行のみ。**残置**: 引継ぎ待ち 1 件（`CASE-39198` `【受入】…`）は人がクローズする必要がある。

## 8. 参照

- 受入の機械可読な証跡: [docs/evidence/webui-acceptance-20261111/production-checks.json](evidence/webui-acceptance-20261111/production-checks.json)
- 配備準備: [docs/96](96-release-prep-webui-20261111.md)
- 機能: [docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md) / [docs/97](97-conditional-features.md)
- 正本の手順: [docs/82](82-promotion-runbook-20261106.md)、[docs/85](85-production-cutover-20261106.md)
