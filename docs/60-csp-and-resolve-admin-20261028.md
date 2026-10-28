# A-12（初期画面）のコンソール2件の是正 — 2026-10-28

- 背景: 本番 A-12 の実測で、画面・機能は正常だがコンソールに次の2件が出た。
  1. **CSP 違反**: `https://static.cloudflareinsights.com/beacon.min.js` が `script-src 'unsafe-inline'` によりブロック（3回）
  2. **403**: `GET /api/resolve/admin/pending`（IT 管理者のみ許可）
- サーバ側の実測（直近15分）: **200×49 / 403×3 / 5xx 0**。監査の増分 0（参照のみ）。

## 1. 原因

| 事象 | 原因 |
|---|---|
| CSP | ゾーン `mirai-dx-platform.com` の **Cloudflare Web Analytics（RUM）が `on`**（site_tag あり）で、エッジが HTML に beacon を注入する。アプリの meta CSP は `script-src 'unsafe-inline'` / `connect-src 'none'` の意図的に厳しい設定のため遮断される |
| 403 | 「リスク4以上の Skill 承認」は IT 管理者のみ（`isResolveAdmin`）。画面は管理者以外でも承認待ちを取りに行き、403 を握り潰していた（存在秘匿のため 403 は妥当） |

## 2. 是正

| # | 変更 | 内容 |
|---|---|---|
| 1 | **配信時の CSP 書き換え**（`apps/api/src/routes/prototype.ts`） | オフライン原本の `connect-src 'none'` を配信時だけ `'self'` に緩めている既存処理へ、`https://cloudflareinsights.com` を追加。併せて `script-src 'unsafe-inline'` に `https://static.cloudflareinsights.com` を追加。**原本 HTML の CSP は変更しない** |
| 1-2 | **レスポンスヘッダの CSP**（同ファイルの `CSP` 定数） | `script-src` に `https://static.cloudflareinsights.com`、`connect-src` に `https://cloudflareinsights.com` を追加。**ヘッダと meta は積集合で評価**されるため、片方だけ緩めても beacon は通らない（2026-10-28 10:32 実測） |
| 2 | `isResolveAdmin` を `apps/api/src/resolve/admin.ts` へ抽出 | `routes.ts` と `me.ts` で共用（ロジック不変） |
| 3 | `GET /api/me` | `resolveAdmin: boolean` を追加（IT 管理者か） |
| 4 | 画面（`resolve-bridge.js`） | `/api/me` の `resolveAdmin` が true のときだけ承認待ちを取得。**false なら呼ばない**（403 のコンソールノイズ解消） |

- ゾーン全体の RUM は**変更していない**（他アプリの分析を止めない）。
- 管理者判定はサーバが返す値（UI の自己申告は使わない）。

## 3. 検証（検証インスタンス `:18963`・同一コード）

| 観点 | 実測 |
|---|---|
| `/api/me`（非管理者） | `k-aritoh` → `resolveAdmin=false` |
| `/api/me`（管理者） | `gmail`（`RESOLVE_ADMIN_ALLOWLIST` に設定） → `resolveAdmin=true` |
| 配信ヘッダの CSP | `script-src 'unsafe-inline' https://static.cloudflareinsights.com` / `connect-src 'self' https://cloudflareinsights.com` を含む |
| 配信 HTML の meta CSP | 同上（両方が許可しないとブラウザは遮断する） |
| 実ブラウザ（隔離インスタンス・`k-aritoh`） | `/api/me`・`/api/employees`・`/api/state/*`・`/api/case-handovers/inbox`・`/api/device/browser` すべて **200**。beacon スクリプトの注入と RUM への fetch で **CSP 違反 0**。負の対照 `https://example.com/x.js` は `script-src-elem` で遮断（＝計測が効いている） |
| 回帰 | typecheck / build PASS、**515 passed**、lint error 0（新規1件: 原本マーカーと両 CSP の許可を固定） |

- 非管理者では `/api/resolve/admin/pending` を呼ばないため、通常のログインでは **403 が出ない**。
- 管理者（許可リスト該当者）は従来どおり 200 で承認待ちを取得できる。
- 補足: 隔離ブラウザではブラウザ自身の `/favicon.ico` 要求が `img-src` で遮断される（本件とは無関係の既存ノイズ）。

## 4. インシデント（同日・復旧済み）

- 最初の実装では **原本 HTML の meta CSP を直接変更**した。しかし配信時に行われる
  `html.replace("connect-src 'none'", "connect-src 'self'")` が**置換対象を見失い**、
  配信 CSP が `connect-src https://cloudflareinsights.com` だけになった。
- 結果、画面から同一オリジンの API 呼び出し（`/api/me`・`/api/state`・`/api/case-handovers` 等）が
  **すべて CSP でブロック**された（ユーザーのコンソールで確認）。同時に beacon も従来どおりブロック。
- 対応: 原本 HTML を変更前に戻して再起動（**API 呼び出しは復旧**）。その後、**配信時の書き換え**を
  正しく修正する方式に変更した（本稿 §2-1）。
- **追記（10:32 実測）**: §2-1 だけでは A-12 の CSP 違反は解消しない。レスポンスヘッダの CSP が
  `script-src 'unsafe-inline'` のままだったため、ブラウザはヘッダと meta の積集合で評価し、
  beacon は依然ブロックされる。§2-1-2 のとおりヘッダ側にも同じ2オリジンを許可して完了した。
- 教訓1: CSP は「原本」「配信時の書き換え」「レスポンスヘッダ」の**3箇所**に存在する。
  1つでも厳しいままだと遮断される。**置換マーカーを壊さない**。
- 教訓2: 検証は「配信 HTML の文字列」だけでなく、**実ブラウザで両ポリシーを通過すること**まで見る。
  `prototype.test.ts` にヘッダ・meta 双方の許可と原本マーカーを固定するテストを追加した。

## 5. 本番反映

- ビルド → `COMMIT_SHA` 更新 → `systemctl --user restart ai-helpdesk-api.service`
  （HTML・ブリッジは起動時にキャッシュされるため、**再起動が必要**）。
- 反映後: `/api/health` が `ok`・`db ok`、公開URL 302、5xx 0 を確認。
- ロールバック: 変更を revert して再起動（CSP と UI の分岐のみ。DB 変更なし）。

## 6. 本番反映記録（2026-10-28 10:37 JST）

| 項目 | 実測 |
|---|---|
| PR / main | [#110](https://github.com/Kensan196948G/AI-HelpDesk-Platform/pull/110) を squash マージ → main **daea45a** |
| main CI | run `40616115168`（push）**success** |
| ビルド | main の `daea45a` から `npm run build` PASS |
| 配備 | `COMMIT_SHA=daea45ab1c2adfc108e83bdaed2e2174050f9326`（`api.conf` 0600 維持）→ 10:37:36 再起動 |
| 稼働確認 | service **active** / `NRestarts=0` / `/api/health` = `ok`・`db ok`・commit 一致 |
| ログ | 再起動後 5xx **0** / `level:50` **0** |
| 公開経路 | `https://ai-helpdesk.mirai-dx-platform.com/` = **302**（Access。未認証のため従来どおり） |
| 検証インスタンス | `:18963` は確認後に停止（リスナ 0 を確認） |

- 補足1: 本番は `ACCESS_JWT_MODE=enforce` のため、**本番 UI のブラウザ実測は Access ログインが必要**。
  CSP の通過と API 200 は同一ビルドの隔離インスタンス（`k-aritoh`・`AUTH_MODE=cloudflare-access`）で実測済み。
- 補足2: 復旧の経過 — 10:15 の #109 配備で API が全ブロック → 原本 HTML を戻して 10:23 に再起動（復旧）
  → #110 を main へマージし 10:37 に配備（A-12 の是正完了）。
- マージ済みブランチ `fix/csp-serve-time-20261028` は残存（ポリシーにより CLI からのリモート削除は不可）。
