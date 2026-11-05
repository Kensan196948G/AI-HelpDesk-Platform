# 70. CTO 第1組 — Staging 検証と本番準備（2026-11-05）

## 現在の結論

**限定 R1 は稼働しているが、独立 Staging と正式本番の受入は未完了。** 今回は専用作業領域でのテスト安全性・read-only 運用診断・合成 DB 検証を進める。本人 PC 操作を有効にせず、経路②・③の No-Go は解除しない。通常 PR は独立レビュー・同一 head の必須 `verify` 成功後に自動マージする。保護や実行ポリシーは迂回しない。

- 公開 URL: `https://ai-helpdesk.mirai-dx-platform.com/`。旧文書の Preview と本番は同一の環境であり、2 環境ではない。
- 2026-11-05 20:17–20:27 JST の SRE 実測: API/proxy/Tunnel は active、NRestarts=0。health は `a5e0a6719699d4711fc1811bbdb79c74d9aab393` / `production` / DB ok。公開は未認証 302 → Access。**認証後 UI の受入ではない。**
- 最新 source の基準は `36c8d4bbb5a3461350cedf257746c982c1b630ba`（#133/#134）。稼働中の主チェックアウトは更新しない。HTML/bridge は主チェックアウトの source を直接読むため、Git 更新も配備となり得る（[配信コード](../apps/api/src/routes/prototype.ts)）。
- backup 最新実測: 11/05 02:30:25、266,481 bytes、0600、約 17.86 時間、親 0700。目録・実復元・由来は今回未確認。backup/watch timer は enabled/active、配置定義は source と一致。
- 直近 24h の SRE 分類集計: API 5xx / error / unhandled=0、proxy upstream error=0、Tunnel request failed=0。通知配送は今回未実行、disk 使用率 88%。

上記は今回の SRE による読取実測。DB 名・schema の直接照合、実社員・貸与 PC・別人物の承認、端末操作の実効モードは未確認。health SHA は設定の自己申告であり、artifact 出自の証明ではない。

## Agent Team と依存関係

| 役割 | 責任 | 書込範囲 |
|---|---|---|
| Lead | 分解・依存管理・統合・全量 DB 検証・PR | runner / smoke / npm scripts / 本書 |
| Architect | 仕様・相手 Repo 契約・GO 境界 | 読取のみ |
| SRE | 現環境実測・隔離手順と運用診断の独立受入 | 読取のみ |
| Security Reviewer | 安全監査・凍結差分の独立レビュー | 読取のみ |
| Test Safety Developer | DB ガード・設定分離・pure 検証 | test setup / migrate / seed / config / guard |
| Ops Developer | read-only readiness 診断・負の対照 | ops-readiness 本体と test |
| Platform Developer | secret scan の失敗閉鎖・負の対照 | scan-secrets 本体と test |

共有タスクは get → 最新 revision claim → 実装/検証 → complete → Lead 報告。独立実装は別ファイルで並列。Lead の統合 → 全体差分凍結 → 独立レビュー/受入 → 必須 CI → 正規マージを順序付ける。DB 全量試験は Lead の新規隔離クラスタだけで直列実行し、既存 DB を使わない。

## 第1組の10項目

| # | 開発ステップ | 依存 | 状態 / 受入条件 |
|---|---|---|---|
| 1 | 現状・既存変更を保全し、独立作業領域を作る | なし | 実施。既存未追跡証跡・主チェックアウト・稼働サービスは未変更 |
| 2 | test の主 DB 接続先を fail-closed に拘束 | 1 | 実装・負対照・独立静的レビュー済み。loopback / test 名 / query 拒否 / 別期待名を接続前に照合 |
| 3 | test の dotenv 上書きと実社員名簿接続を防止 | 2 | 実装・負対照済み。ESM 先行 import と親/worker NODE_ENV 不一致も防止。test 実名簿 driver は起動しない |
| 4 | DB 不要の安全・運用試験を分離 | 2,3 | 実装済み。DB setup なしの pure 220 件が成功（全量1,860件にも含む。加算しない） |
| 5 | 新規 PG16 使い捨てクラスタで再現検証 | 2–4 | 新候補を別の新規クラスタで再検証し成功。合成限定、正常終了時の PG 停止/ポート閉鎖を確認 |
| 6 | production-mode の閉鎖スモーク | 5 | 成功。Access enforce、未認証/偽メール 401、無効 helper 404、正 SHA/誤 SHA 対照。実 Access 受入ではない |
| 7 | read-only health/SHA/未認証保護の診断 | 1 | 実装・133件の負対照を含むテスト成功。SRE が既存 live で正/誤 SHA を独立確認 |
| 8 | backup 鮮度の診断と scan 障害の検出 | 4 | 実装・負対照済み。管理下の実 dump の metadata 診断も成功。復元/由来は未確認。scan は障害を失敗にする |
| 9 | 他 Repo の契約・未受入を整理 | 1 | 静的整理済み。下表。相手 Repo 書込なし・今回の実疎通は未実施 |
| 10 | 統合検証・独立レビュー・CI・正規自動マージ | 2–9 | ローカル統合検証・独立静的レビュー済み。Git MCP 制約で commit/PR/CI/merge は未実施。独立 Staging と認証受入も未達、本番配備なし |

### test DB の契約

- `NODE_ENV=test` のとき `.env` / `.env.test.local` / `.env.local` を読まない。`DATABASE_URL` を明示する。
- localhost 相当の厳格な接続先、`ai_helpdesk_test` または厳格な動的 test 名だけ。接続 query による別 host/DB/user への上書きを許さない。
- 既存 CI の固定 fixture は `ai_helpdesk_test`。`AIHD_TEST_DATABASE_NAME` 未指定時はこの固定名だけを期待し、DSN から期待名を推測しない。動的 `aihd_test_*` は別途期待名を明示し完全一致させる。
- 接続前の検証は隔離そのものを保証しない。同じ名前の既存 DB を流用せず、`verify:isolated` で新規クラスタを作る。名前・自己申告フラグだけを本番非接触の根拠にしない。

### 実行手順（稼働中 checkout では実行しない）

```bash
npm ci
npm run test:pure
npm run verify:isolated -- --ack-isolated-worktree
node scripts/ops-readiness.mjs --base-url http://127.0.0.1:18949/ \
  --expected-commit a5e0a6719699d4711fc1811bbdb79c74d9aab393
```

隔離 runner は既存 env ファイルがあると拒否する。通常 main checkout と異なる linked worktree / 物理 cwd / 専用 branch を確認するが、任意の linked 本番配置を完全に識別する保証はない。minenv は OS レベルの通信隔離ではなく、外部資格情報なし・主要 URL を閉じた loopback に固定・test 時の実名簿接続禁止による抑制である。合成データの新規 PG16 を停止して private scratch のログを残す。既存 DB の DROP・通知送信・本番サービス変更は行わない。正規の Access セッションや実端末は用いず、**この成功を正式 Staging 受入とはしない**。

運用診断の backup 検査は `O_NOFOLLOW` / inode 照合 / 同一 FD での hash と前後属性照合を行うが、親ディレクトリを固定ハンドルで辿るものではない。敵対的な同時の親パス差替えを完全に防ぐ保証はなく、権限管理された保存先で使用する。ネットワーク検査は5秒上限だが、ローカル dump の hash には容量/時間上限を設けていない。定時監視へ組み込む前に大容量/中断の負の対照と上限が必要。

隔離 runner/smoke の正常終了は実測するが、TERM・start 失敗・timeout 中断での cleanup は未実測。失敗時は即時停止への fallback と未停止の非成功終了を実装しているが、すべての異常下での停止保証とはしない。production + Access の JWT/proxy 既定値は本変更で厳格化しない。smoke の明示 enforce 成功を既定設定の安全化と同一視しない。

### 実行ポリシー上の未達

CI YAML に独立 pure step と期待 DB 名を追記する targeted edit は **DEPLOY critical の self-evolution policy に拒否された**。YAML は変更せず、別手段で迂回しない。既存 CI は固定 `ai_helpdesk_test` の互換境界を維持し、新しい scripts の unit も従来の `npm test` で実行する。新しい独立 CI step と自動配備は未適用である。

## 他リポジトリとの連携

| 連携 | 実装/既存証跡 | 今回の確認 | 未達 |
|---|---|---|---|
| RSP → HelpDesk | loopback + 統合キー + 操作者、公開 proxy 経由拒否 | 両側 source/docs の静的照合 | 現候補の認証済み UI 通し、実社員受入 |
| HelpDesk → RSP | service key と相関 API、別端末結果は拒否 | 契約の静的照合。10/27 の実端末 `hostname`→取込→未解決報告の過去証跡あり | 今回の実疎通/実行はなし。未設定/障害時の警告付き継続は「検証済み」と同一視しない |
| Mirai-Info 貸与 API | Access PII API で在籍・現貸与・鮮度を fail-closed 照合 | consumer 契約の静的照合 | 実 token/貸与/本人 SID/RSP までの正式受入 |
| Mirai-Info 社員名簿 | 既存 peer SQL、`status='有効'`、10 分 cache | source を確認。test の driver 生成禁止を実装し、合成負対照・隔離全量試験・独立静的レビュー済み | PII API 契約への統一・限定 role・失効鮮度は相手所有者との設計調整が必要 |
| MeshCentral / Windows helper | 担当者経路の実行/端末識別は RSP、経路③の実行器は本人権限 helper（HelpDesk 直結、RSP/device_commands に配送しない）。HelpDesk は受付/同意/AI/報告/KB | 静的責任分界のみ | 経路③の未修正 medium と正式受入。[レビュー記録](69-route3-review-20261104.md)の No-Go 維持 |

保存済み報告書の SHA 一致は内容の真実性/本人操作/解決の証明ではない。別アカウントは別人物の代わりにならない。Draft #127/#128 は検証用のためマージしない。

## 次組の10項目（提案、未実装）

| # | ステップ | 依存 / 合格条件 |
|---|---|---|
| 11 | immutable release に HTML/bridge/実行 JS/manifest を同梱 | build 出自と serve bytes を照合。主作業 tree から配備を分離 |
| 12 | 独立 Staging の host/DB/OS 主体/Access を分離 | 11、既存 production 非変更と least privilege、R1 範囲の認証後 UI 受入（R3 は開かない） |
| 13 | 最新 backup の新規 DB 限定の実復元と rollback 検証 | 11–12、全表/制約/監査照合。通常 rollback に DB 上書きを使わない |
| 14 | 本番相当の設定優先順位固定 | 12、明示 off が env file で有効化されない負対照。#133 の修正済み検証フラグを重複実装しない |
| 15 | unauth 入口のレート制限枯渇を正規 poll から隔離 | Edge/アプリの契約、2000 送信元後も正規 poll 継続、メモリ上限 |
| 16 | Windows 起動/導入/一覧の整合性レベル・HTTPS 境界 | Medium 本人は通る、High/SYSTEM と実利用 HTTP は拒否 |
| 17 | 停止/アンインストール/404/未報告結果の耐久性 | 取消・報告・秘密消去の順、原子的保存、失敗時も記録保持、再実行なし |
| 18 | helper 単一起動・子 Job への原子的包含 | 実 Windows 競合試験、二重実行/Job 外の孫残留を成功扱いしない |
| 19 | ログの token 非露出と RSP 相関 unknown の伝搬 | 合成 token の4103対照、未設定/timeoutをunknown、hostname不一致は拒否 |
| 20 | 実社員・貸与 PC・別担当/承認者の正式受入 | 12–19、Access 一本通し・本人解決確認。揃うまで R3 有効化なし |

Architect の元候補 C1–C10 との対応: 14=C1、15=C2、16=C3+C4、17=C5+C6、18=C7+C8、19=C9+C10。11–13/20 は本番準備として追加した項目であり、元候補を完了したとは数えない。

正式受入には実在人物と OTP 等が必要なため、エージェントが合成で代替しない。不可欠な運用判断は数字選択式または Y/N でのみ確認する。

## 検証結果と未達事項

旧候補（base `36c8d4b` + 指紋台帳の20ファイル）は 21:04–21:10 JST に新規隔離 PG16 で pure 211 / full 1,851（93ファイル）成功、migration 初回37・再実行0、型/lint/build/smoke と自分の PG 停止/ポート閉鎖が exit 0。Lint は既存 346 warnings / 152 infos があり、警告ゼロではない。正式 Access/UI/実社員/実端末/復元は未受入。

その後の独立静的レビューで、`NODE_ENV=development` を親に残した `npm test` は setup 子だけ test に変わり worker が development を保持し、env file の運用接続先へ切り替わり得る High を発見。運用 DB を使った実行・破壊的再現はしていない。旧 runner/CI は明示 test のため旧成功と矛盾しない。親が厳密 test でなければ全 I/O 前に拒否、worker も test に固定する3ファイルの最小修正と負の対照9件を追加した。独立レビューで静的根因の解消を確認し、F1/F2/F4 は closed-with-limits、新規未修正 Critical/High/Medium/Low は 0/0/0/0。実行しない reviewer の静的結論と、以下の担当/Lead 実測は分けている。

### 修正後の別クラスタ再実測（21:26–21:32 JST）

検証対象は base `36c8d4bbb5a3461350cedf257746c982c1b630ba` + v2 指紋台帳21ファイル。manifest SHA-256 は `045b1677788c9d0344a48a9673e835e695e75619443e5e28090474db65aa6ba6`、独立 reviewer と Lead が21/21一致を確認。実行後に本書だけを結果追記し、source20ファイルは同一性を保つ。未コミット候補なので、health の base SHA だけで変更を識別しない。

| 検査 | 修正後の実測 |
|---|---|
| pure | 3ファイル・220件成功（guard78 / ops133 / scan9）、1.82秒 |
| migration | 空の新規DBへ37本適用、2回目0本適用/37本skip |
| 型 / lint / build | 全て exit 0。Lint は346 warnings / 152 infosが既存として残る |
| 全量 test | 93ファイル・1,860件成功、skip/failなし、327.12秒。pure220件を含む |
| production-mode smoke | health / 未認証401 / 許可リスト内の合成メールヘッダのみ（JWTなし）→401 / 無効helper404 / readiness正SHA成功・誤SHA失敗 |
| cleanup | 検証用API close/portclosed。新規PG PID257317/port46377を停止、PID不存在/接続拒否/postmaster.pid不存在を確認。21:32:11終了 |
| 実CLI負対照 | 親NODE_ENV development/production/空の3回は全exit1・固定parent guard・migrate未開始。未設定はVitestがtestを補完する動作と区別 |
| 依存監査 / secret scan | npm audit 全依存の既知脆弱性0。scan exit0。検出網羅性の保証ではない |

private scratch `/tmp/aihd-verify.Jt9cSOZn`（0700、ログ0600）と安全要約 `/tmp/aihd-cto-deliverables/candidate-v2-verification.json` を保持。旧クラスタを再利用せず、旧PASSを新候補に流用していない。合成スモークは正署名の実Accessログイン、認証後UI、実社員/貸与端末、別人物承認、復元、正式Staging受入、本番配備を検証しない。

CI YAML の編集拒否に加え、Git MCP の操作は作業先を正規に訂正しても path traversal/root 制約で拒否された。stage/commit/PR/今回候補の必須CI/merge は未実施。別経路での迂回は行わない。通常の自動マージ方針と、現在マージできていない事実を区別する。第1組はローカル実装・合成検証まで進めたが、項目10と正式本番構築は未完了である。

## 2026-11-06 追記（現況）

本記録は作成時点のもの。その後 PR #135 で commit・CI・merge 済み（merge `2deffab`）。現況と follow-up は [docs/76](76-followup-20261106.md) を参照。本文の実測結果・数値・限界は作成時点の記録としてそのまま維持する。
