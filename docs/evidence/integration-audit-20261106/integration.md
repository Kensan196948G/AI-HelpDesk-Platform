# 他リポジトリ連携 実測記録（2026-11-06）

対象: AI-HelpDesk-Platform（`git HEAD=e7d7f6f`, `main`）
実施: repo-integrator（read-only 調査）。実測時刻 2026-11-06 08:07〜08:25 JST（Asia/Tokyo）。

## 0. 前提と制約（この記録の意味）

- 対象リポジトリへの**書込・git 書込操作（commit/push/branch）は行っていない**。実行した git は `log` / `remote -v` / `rev-parse` / `merge-base` の読み取りのみ。
- DB は **SELECT と集計のみ**。`INSERT/UPDATE/DELETE`、`systemctl`、サービス再起動は行っていない。
- `.env`・環境ファイル・`/proc/<pid>/environ` は**読んでいない**。したがって**キー・トークンの値と一致は未検証**（Secret を出さない方針のため、意図的に未測定）。
- 本記録の「未確認」は成功扱いにしていない。読めなかった／資格情報が必要だったものは §6-3 に分離した。

参照必須文書（既読）: `README.md`、`AGENTS.md`、`.env.example`、`docs/72-runtime-dependencies-and-git-boundary.md`、`docs/65-readme-dataflow-map.md`。
接続点の根拠として `docs/36-rsp-integration.md`（RSP⇄HelpDesk 契約 v0.1 / 2026-10-26 合意）、`docs/62-consented-folder-access.md`、`docs/77-staging-environment-design.md`、`docs/53-delta-verification-20261028.md`、`docs/26-meshagent-autoinstall-remote-support.md` も読んだ。

## 1. 実在確認（ls と symlink 解決）

`/home/kensan/Projects/Mirai-Admin-Platform` 直下の symlink 11 本を `readlink` と `test -e` で解決した。**全 11 本が実在**（broken link 0）。

| symlink | 解決先 | 実在 |
|---|---|---|
| ArcSphere-Civil-Twin | `/home/kensan/Projects/Mirai-Construction-DX/ArcSphere-Civil-Twin` | 実在 |
| Civil-Docs-Platform | 同上/Civil-Docs-Platform | 実在 |
| Civil-Open-Data-Intelligence-Platform | 同上/Civil-Open-Data-Intelligence-Platform | 実在 |
| CivilPDF-DX | 同上/CivilPDF-DX | 実在 |
| Construction-Enterprise-OS | 同上/Construction-Enterprise-OS | 実在 |
| Mirai-AI-Coding-Harness | 同上/Mirai-AI-Coding-Harness | 実在 |
| Mirai-Construction-Agent-Harness | 同上/Mirai-Construction-Agent-Harness | 実在 |
| Mirai-Construction-Information-Platform | 同上/Mirai-Construction-Information-Platform | 実在 |
| Mirai-Harness-Core | 同上/Mirai-Harness-Core | 実在 |
| **Mirai-Platform-Infra** | 同上/**Mirai-Platform-Infra** | **実在・今回の対象** |
| Mirai-Web-CAD | 同上/Mirai-Web-CAD | 実在 |

**配置の実測（重要）**: タスク本文の候補 `Mirai-Info` / `Remote-Service-Platform-for-Linux` / `Software-Factory` / `Development-Dispatcher` / `ACCC` は
**Mirai-Admin-Platform 直下には存在しない（不在）**。実体は次の別ディレクトリにあった。候補名で「不在」と誤記しないよう、実パスを正とする。

| 候補名 | 実パス | 実在 | `Mirai-Admin-Platform` 直下 |
|---|---|---|---|
| Mirai-Info（名簿ハブ） | `/home/kensan/Projects/Mirai-Project/Mirai-Info` | 実在 | 不在 |
| Remote-Service-Platform-for-Linux（RSP） | `/home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux` | 実在 | 不在 |
| Software-Factory | `/home/kensan/Projects/Software-Factory-Project` | 実在 | 不在 |
| Development-Dispatcher（DD） | `/home/kensan/Projects/Business-Project/Development-Dispatcher` | 実在 | 不在 |
| ACCC（AI-Company-Control-Center） | `/home/kensan/Projects/Business-Project/AI-Company-Control-Center` | 実在 | 不在 |
| Mirai-Platform-Infra | `/home/kensan/Projects/Mirai-Construction-DX/Mirai-Platform-Infra` | 実在 | **symlink 経由で実在** |

補足（実測）: ACCC には linked worktree `/home/kensan/Projects/Business-Project/_work/t12-accc`（同 repo の worktree）がある。`_work/t9/accc-main` は **git リポジトリではない**（scratch）。本調査は主チェックアウトのみを対象にした。

## 2. 一覧表（対象 / 実在 / 読取権限 / 依存方向 / 契約 / 版 / テスト方法 / 接続状態）

| 対象 | 実在 | 読取権限 | 依存方向 | 契約（API・テーブル・キー名） | 版（commit / branch） | テスト方法 | 接続状態（実測 / 未確認） |
|---|---|---|---|---|---|---|---|
| **Mirai-Info** | 実在 | 可（owner=kensan、`ls`/`git`/README/docs 読取成功） | **AI-HelpDesk → Mirai-Info の片方向（読み取りのみ）** | ① PII API `GET /api/device-staff?employee_no=`（18083・Cloudflare Access サービストークン必須、18084 は 403）② 名簿 DB `mirai_info.employee_directory`（`employee_no`/`name`/`organization`/`division`/`section`/`status`）を Unix ソケット peer で `SELECT` | `main` **6d2c810**（2026-11-01 / PR #262「/api/device-staff に社員絞り込みと鮮度・在籍・返却の情報を追加」）。worktree clean | `pytest tests/`（`test_read_api.py`, `test_openapi_contract.py`）、`docs/openapi.yaml` の契約検査 | **一部実測**: 18084 応答あり（`/health` は 404＝経路違い）、18083 `/api/device-staff` 未認証 **403**（Access ゲート有効）、`employee_directory` **447 行 / 有効 432 行**、`devices` **860 行**、`device_staff_view` 存在。<br>**未確認**: サービストークンでの `device-staff` 200 応答（トークン未発行のため） |
| **Remote-Service-Platform-for-Linux（RSP）** | 実在 | 可 | **双方向**<br>① HelpDesk → RSP（サービス API）<br>② RSP → HelpDesk（`/api/v1/helpdesk/*` 中継） | ① `X-RSP-Service-Key`（32 文字以上・空なら 503）。`GET /api/v1/service/devices?hostname=` / `POST /api/v1/service/devices/{id}/ensure-agent` / `POST /api/v1/service/commands`（201） / `GET /api/v1/service/commands/{log_id}` / `GET /api/v1/service/commands/{log_id}/correlation`<br>② `HELPDESK_BASE_URL`（既定 `http://127.0.0.1:18950`）・`HELPDESK_SERVICE_KEY`・`X-Helpdesk-Service-Key` + `X-Operator-Email` + loopback。10 ルート（context/cases/sessions/steps/record/close/report/knowledge-draft） | `main` **70c738d**（2026-11-02）。HEAD は main と同一。未追跡 HTML 3 件あり（調査対象外・未読） | `pytest api/tests/`（`test_helpdesk_proxy.py`・`test_command_*` 等）、`webui/` Playwright | **実測**: `127.0.0.1:8130` 稼働（`/` 200）。サービス API をキー無しで叩くと **401 `INVALID_SERVICE_KEY`**（＝503 `SERVICE_AUTH_DISABLED` ではないため **`RSP_SERVICE_KEYS` は設定済み**）。HelpDesk `/api/terminal/context` を偽ヘッダで叩くと **401「RSP 連携の認証に失敗しました。」**（＝`RSP_INTEGRATION_KEY` は設定済み）。<br>**未確認**: 両キーの**値の一致**（秘密）、RSP JWT セッションでの `/api/v1/helpdesk/*` 200 |
| **Software-Factory** | 実在 | 可 | **なし（接続点なし）** | なし。AI-HelpDesk は「公開リポジトリ候補の台帳」に名前が出るだけで、**L-14 により対象外**と明記（`docs/devline/assessment/2026-11-04-cross-repo-status.md`） | HEAD **cd8c09a**（branch `auto/issue-102-docs`）／ `main` **cbf7bc7**（2026-11-06） | `pnpm test`（vitest unit + integration）。`pnpm test:e2e`（Playwright） | **接続なし（実測）**: AI-HelpDesk 側に `Software-Factory` の参照 **0 件**、Software-Factory 側もコード・設定に HelpDesk 連携なし（docs の言及のみ） |
| **Development-Dispatcher（DD）** | 実在 | 可 | **なし（接続点なし）**<br>DD ⇄ ACCC の内部連携は別系統 | なし | HEAD **113b76f**（branch `feat/dd-production-batch5-20261106`）／ `main` **98c97f3**（2026-11-03） | `pytest tests/`（`tests/e2e` 含む） | **接続なし（実測）**: AI-HelpDesk 側参照 0 件、DD 側に `helpdesk` 参照 0 件。README は「pre-merge / production not deployed」 |
| **ACCC（AI-Company-Control-Center）** | 実在 | 可 | **なし（接続点なし）** | なし | HEAD **132f992**（branch `fix/test-database-guard-20261105`）／ `main` **1f75e92**（2026-11-03） | `pytest tests/`（`integration` / `e2e`） | **接続なし（実測）**: 双方に参照 0 件。本番/Staging は `*.mirai-dx-platform.com` + Cloudflare Access（別アプリ） |
| **Mirai-Platform-Infra** | 実在（symlink 経由） | 可 | **なし（未登録）** | なし。`systems.yaml`（System Registry の正本）と `envs/stg/services.yaml`（Staging 台帳 **14 system**）に **AI-HelpDesk は未登録** | HEAD **81f9e6c**（branch `auto/stg-scope-20261026`）／ `main` **148b9e7**（2026-10-23） | `pytest tests/`、`tools/check_releases.py`（R-07 等） | **接続なし（実測）**: リポジトリ全体で `helpdesk` / `ai-helpdesk` / `18950` の参照 **0 件**。README 上、Cloudflare・Azure・実 DB は「未設定」 |

## 3. 接続点の突き合わせ（AI-HelpDesk 側コード × 相手側の実装）

`rg` で AI-HelpDesk 側の設定キーと利用箇所を列挙し、相手側の実装・文書と突き合わせた。

| キー | AI-HelpDesk 側の実装（実測行） | 相手側の実装 | 突合結果 |
|---|---|---|---|
| `MIRAI_INFO_DATABASE_URL` | `apps/api/src/config.ts:166`（optional）、`apps/api/src/lib/mirai-info.ts:35-36`。未設定時は `host=/var/run/postgresql` / `database=mirai_info` / `username=$USER` へ fallback | Mirai-Info `mirai_info.employee_directory`（migration `0014`、`0026`）。`devices`（`0018`）、`device_staff_view`（`0017`） | **一致**。AI-HelpDesk の SQL は `employee_no, name, organization, division, section FROM mirai_info.employee_directory WHERE status='有効' LIMIT 1000` で、列名・スキーマ名が一致。実 DB で 447 行・有効 432 行を確認 |
| `LEASE_API_URL` + `LEASE_API_TOKEN_ID` / `_SECRET` | `.env.example:112-115`、`apps/api/src/config.ts:143-146`、`apps/api/src/folder-access/lease.ts`（`CF-Access-Client-Id` / `-Secret` ヘッダ、`redirect:'error'`、timeout 8s、失敗は `LEASE_UNAVAILABLE` で fail-closed） | Mirai-Info `GET /api/device-staff?employee_no=`（`docs/openapi.yaml:412-436`、`docs/CONSUMER-GUIDE.md` §「貸与端末の照会」） | **一致（フィールド単位で確認）**。AI-HelpDesk 側 `ResponseSchema`/`RecordSchema` の `ok` / `source` / `generatedAt` / `filter.employee_no` / `dataAsOf.employeeDirectoryLastSeenAt` / `records[].hostname|asset_tag|employee_no|mesh_node_id|employee_active|lease_active` が、Mirai-Info の `DeviceStaffOK` + PR #262 の追加項目と一致。**AI-HelpDesk 側コメントが「Mirai-Info PR #262 / docs/CONSUMER-GUIDE.md」を明示参照**しており、版が固定されている |
| `RSP_BASE_URL` | `apps/api/src/config.ts:181`（既定 `https://rsp.mirai-remotetools.com/`）、`apps/api/src/remote-support/rsp.ts:25` | RSP の公開 URL / API `127.0.0.1:8130` | **一致**（URL は既定値ベース）。**実効値は未確認**（`.env` を読まないため） |
| `RSP_SERVICE_KEY` | `apps/api/src/config.ts:124`、`rsp.ts:31-41`（未設定なら 503 `RSP_NOT_CONFIGURED`）。送信ヘッダ `X-RSP-Service-Key` | RSP `api/app/routers/service_commands.py:42`（`X-RSP-Service-Key`）、`core/config.py:168`（`rsp_service_keys`・32 文字未満は無視・空なら 503） | **契約一致（5 エンドポイントすべて）**。RSP 側は route 有効（無キー 401）を実測。**キー値の一致は未確認** |
| `RSP_INTEGRATION_KEY` | `apps/api/src/config.ts:128`（`optionalSecret`）、`apps/api/src/auth/rsp-integration.ts`（constant-time 比較・loopback 必須・`x-proxy-secret` 付きは 403・`AUTH_MODE=cloudflare-access` なら許可リスト照合） | RSP `docs/helpdesk-integration.md`（**契約の正本は AI-HelpDesk `docs/36-rsp-integration.md` §2〜§4（v0.1 / 2026-10-26 合意）と明記**）、`api/app/routers/helpdesk.py`（`X-Helpdesk-Service-Key` / `X-Operator-Email` / `HELPDESK_BASE_URL` / `HELPDESK_SERVICE_KEY`） | **双方向で一致**。RSP の中継先 10 ルートは HelpDesk 側 `/api/terminal/*` に**すべて存在**（`context` / `cases` / `sessions` / `sessions/:id` / `steps` / `steps/:id/record` / `close` / `report` / `knowledge-draft` を `routes/terminal.ts` と `routes/reports.ts` で確認）。**キー値の一致は未確認** |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | `config.ts:172`（既定 `https://api.deepseek.com`）、`ai/deepseek.ts:145,275`、`support-session/ai-input.ts:134`、`resolve/proposer.ts:326`（`POST {base}/chat/completions`） | 外部 SaaS（リポジトリなし） | **到達性のみ実測**: `https://api.deepseek.com/` → **401**（経路は開通・認証必須）。**実呼び出しは未確認**（キー無し）。既存証跡: `docs/53`（2026-10-28 実 DeepSeek 呼び出し）、`docs/65` §0-1（2026-11-01） |
| Cloudflare **Access** | `config.ts:85`（`AUTH_MODE`）、`:91`（`ACCESS_JWT_MODE`）、`:93`（`ACCESS_TEAM_DOMAIN`）、`:95`（`ACCESS_AUD`）。**本番は `AUTH_MODE=local` を起動拒否**（`config.ts:207-209`） | Cloudflare Access（Terraform 等のリポジトリなし） | **実測**: `https://ai-helpdesk.mirai-dx-platform.com/` → **302 → `winter-lake-f4c9.cloudflareaccess.com/.../access/login/...`**。`rsp.mirai-remotetools.com`・`allinfo.mirai-info.com` も**同じ Access チーム**へ 302。実行中 API の `/api/health` は `env=production` を返すため、`AUTH_MODE=cloudflare-access` はコード上必然（`local` なら起動失敗） |
| Cloudflare **Tunnel** | `docs/08-deployment.md`（Tunnel 名 `ai-helpdesk`、config は `~/.cloudflared/ai-helpdesk-config.yml`＝**リポジトリ外**）、`ops/systemd/ai-helpdesk-tunnel-watch.{service,timer}`、`scripts/tunnel-watch.mjs`（journal を読むだけ・再起動しない） | Mirai-Platform-Infra には Tunnel 管理なし | **接続点はリポジトリ外の設定ファイル**。Tunnel の実在・稼働は Access 302 と API 200 から**間接的に実測**。`cloudflared` 設定本文と Tunnel 一覧は**未読（対象外）** |

### 3-1. 依存方向の要点（AI-HelpDesk が「読む側」か「読まれる側」か）

- **Mirai-Info**: AI-HelpDesk は**読み取り専用の消費者**。Mirai-Info 側 `config/projects.json` は AI-HelpDesk を `dataNeeds: ["device_staff_lease"]` / `writeAuthority: "none-for-company-source-data"` で登録案として持つ（Issue #261）。**会社ソースデータへの書込権限は与えない**設計。
- **RSP**: **双方向**。HelpDesk→RSP は端末探索・エージェント導入・コマンド投入。RSP→HelpDesk は案件・AI 提案・実行記録・報告書・ナレッジ下書き。責務分界は「RSP＝実行・端末・監査／HelpDesk＝案件・AI・引継ぎ・報告書・ナレッジ」（`docs/36` 表）。
- **Software-Factory / DD / ACCC / Mirai-Platform-Infra**: **接続なし**。いずれも AI-HelpDesk を参照していない（0 件）。

## 4. 実測ログ（再現用・値は非秘密のみ）

```text
# AI-HelpDesk 稼働（127.0.0.1:18950）
GET /api/health -> 200
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0",
 "commit":"a5e0a67...","db":"ok","env":"production"}
  ※ 実行中 commit a5e0a67（2026-11-04 / PR #132）は main HEAD e7d7f6f の祖先。
     main とは 9 コミット差（＝本番ランタイムは main より 9 コミット古い）。docs/72 §4 の記載と整合。

# 未認証の扱い（Access 前段）
GET https://ai-helpdesk.mirai-dx-platform.com/ -> 302 (winter-lake-f4c9.cloudflareaccess.com)
GET https://rsp.mirai-remotetools.com/           -> 302 (同 Access チーム)
GET https://allinfo.mirai-info.com/             -> 302 (同 Access チーム)

# Mirai-Info read API
GET http://127.0.0.1:18084/health                    -> 404（経路違い。プロセスは応答）
GET http://127.0.0.1:18083/api/device-staff?employee_no=TEST -> 403（Access ゲート有効）
SELECT count(*) FROM mirai_info.employee_directory                    -> 447
SELECT count(*) FROM mirai_info.employee_directory WHERE status='有効' -> 432
SELECT count(*) FROM mirai_info.devices                              -> 860
SELECT to_regclass('mirai_info.device_staff_view')                   -> 存在

# RSP
GET  http://127.0.0.1:8130/                              -> 200
GET  http://127.0.0.1:8130/api/v1/service/devices?hostname=TEST
                                                          -> 401 INVALID_SERVICE_KEY
     （503 SERVICE_AUTH_DISABLED ではない ⇒ RSP_SERVICE_KEYS は設定済み）
GET  http://127.0.0.1:18950/api/terminal/context         -> 401（ヘッダ無し＝Access へフォールバック）
GET  同 + X-Helpdesk-Service-Key(偽値) + X-Operator-Email(検証用ダミー)
                                                          -> 401「RSP 連携の認証に失敗しました。」
     （「RSP 連携が設定されていません」ではない ⇒ RSP_INTEGRATION_KEY は設定済み）

# DeepSeek
GET https://api.deepseek.com/ -> 401（到達可・認証必須）
```

補足（実測）: `/api/nonexistent-probe` も 401 を返すため、**認証前の 401 だけでは機能フラグ（`FOLDER_ACCESS_ENABLED` 等）を外部から判別できない**。`/api/folder-access*` の有効・無効は**未確認**。

## 5. 参照文書の版（突き合わせの基準）

| 文書 | 版・日付 | 内容 |
|---|---|---|
| AI-HelpDesk `docs/36-rsp-integration.md` | v0.1（2026-10-26 合意） | RSP⇄HelpDesk の API 契約・認証条件・中継 10 ルート |
| AI-HelpDesk `docs/62-consented-folder-access.md` | 2026-11 | 貸与端末は Mirai-Info PII API から取得（`device_staff` ビューの直接 SELECT 禁止） |
| AI-HelpDesk `docs/77-staging-environment-design.md` | 2026-11-06 | `MIRAI_INFO_DATABASE_URL` 未設定時の実名簿 fallback（R4 / 未解決） |
| Mirai-Info `docs/CONSUMER-GUIDE.md` / `DATA-GOVERNANCE.md` | 2026-11（Issue #261） | AI-HelpDesk を `device_staff_lease` の登録案に。**サービストークン発行と Access 許可はオーナー操作で未実施** |
| RSP `docs/helpdesk-integration.md` | 契約 v0.1 を正本として参照 | 中継の設定キー・fail-closed・エラー正規化 |

## 6. 3 分類

### 6-1. 今すぐ実装できる連携（新しい人間承認・資格情報を要さない）

1. **Mirai-Info 名簿 DB の読み取り経路**（実装済み・稼働実測あり）。改善余地は「`status='有効'` 依存の妥当性確認」と、`MIRAI_INFO_DATABASE_URL` 未設定時の fallback が**本番以外で実名簿を読み得る**点の fail-closed 化（`docs/77` R4 が未解決と明記）。※実名簿を読む挙動自体は本番の想定内。
2. **RSP サービス API の既存 5 エンドポイント**（実装済み・route 有効を実測）。未実測なのは `ensure-agent` の **`triggered_deploy=true`**（未導入端末）経路のみ。合意端末が決まれば実測できる。
3. **RSP→HelpDesk 中継 10 ルート**（両側に実装あり・`knowledge-draft` まで対称性を確認）。残るは **RSP の JWT セッションでの 200 通し**（既存証跡は 2026-10-27 の S5）。
4. **`docs/36` v0.1 の契約維持**（RSP 側が AI-HelpDesk の文書を正本として参照している）。契約変更時は両リポジトリ同時更新が必要で、いまは版が一致している。

### 6-2. 人間判断が必要な連携（オーナー／管理者の操作・承認が前提）

1. **Mirai-Info の Cloudflare Access サービストークン発行 + Access ポリシー許可**。Mirai-Info 側の記録は「**オーナー操作で未実施**」。これが無いと貸与情報連携（`LEASE_API_URL`）は本番で `LEASE_UNAVAILABLE` のまま（fail-closed 設計どおり）。→ **未実施を「実装済み」と扱わない**。
2. **サービス間キー 2 組の本番値の一致確認**: ①`RSP_SERVICE_KEY`（HelpDesk）＝`RSP_SERVICE_KEYS`（RSP）②`HELPDESK_SERVICE_KEY`（RSP）＝`RSP_INTEGRATION_KEY`（HelpDesk）。両側とも「設定済み」は実測できたが、**値の一致は秘密のためエージェントでは検証できない**。ローテーション時の同時更新も運用判断。
3. **AI-HelpDesk を Mirai-Platform-Infra の System Registry / Staging 台帳へ登録するか**（`system_id` 発番・owner・`production` 可否）。現状 **未登録**で、Infra 側の R-07 等の統制対象外。
4. **本番ランタイムの版更新**（本番 `a5e0a67` は main `e7d7f6f` より 9 コミット古い）。配備判断であり、この調査では操作していない。
5. **Software-Factory / DD / ACCC との新規連携の要否**（現状は接続 0 件。業務判断であり、勝手に契約を作らない）。

### 6-3. アクセス不能・未確認（成功扱いにしない）

| 項目 | 理由 | 状態 |
|---|---|---|
| Mirai-Info `/api/device-staff` の **200 応答** | Access サービストークン未発行・値は秘密 | **未確認** |
| サービス間キー 2 組の**一致** | 秘密（`.env` を読まない方針） | **未確認** |
| RSP `/api/v1/helpdesk/*` の **200 通し** | RSP の JWT（Entra）セッションが必要 | **本日未確認**（既存証跡 `docs/40` S5/S6・`docs/53` は PASS） |
| DeepSeek の**実 API 呼び出し** | API キーが必要（本調査では未使用） | **未確認**（到達性 401 のみ実測。既存証跡 `docs/53`・`docs/65` §0-1） |
| `FOLDER_ACCESS_ENABLED` / `ASSIST_SESSION_ENABLED` の実効値 | 認証前 401 のため外部から判別不能 | **未確認** |
| `RSP_BASE_URL` / `MIRAI_INFO_DATABASE_URL` の**実効値** | `.env` 非読取 | **未確認**（既定値と fallback のみ確認） |
| Cloudflare Tunnel の設定本文・トンネル一覧 | リポジトリ外（`~/.cloudflared`）・対象外 | **未読**（302 と 200 で間接実測） |
| Mirai-Platform-Infra の実環境（Cloudflare/Azure/実 DB） | リポジトリ README が「未設定」と明記 | **未確認** |
| RSP の未追跡ファイル 3 件（HTML） | 調査対象外 | **未読** |
| Mirai-Admin-Platform 直下の候補 5 件 | そもそも直下に無い（別ディレクトリに実在） | **不在（配置）** |

## 7. 結論

- **実際につながっているのは 2 系統だけ**である（実測）: **Mirai-Info**（名簿 DB の読み取りが稼働・PII API はゲート有効だがトークン未発行）と **RSP**（双方向・両側ともキー設定済み・route 有効）。
- **Software-Factory / DD / ACCC / Mirai-Platform-Infra は接続点が存在しない**（コード・設定の参照 0 件）。名簿や資料に名前が出ることと、実行時の依存があることを混同しない。
- 未達の中心は **Access サービストークンの発行（オーナー操作）** と **キー値の一致確認（秘密）**。いずれも「未実施／未確認」であり、完了として扱わない。
