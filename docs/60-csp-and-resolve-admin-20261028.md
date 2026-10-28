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
| 配信 HTML の CSP | `script-src 'unsafe-inline' https://static.cloudflareinsights.com` を含む |
| 回帰 | typecheck / build PASS、`me` + `resolve` テスト **167 passed**、lint error 0 |

- 非管理者では `/api/resolve/admin/pending` を呼ばないため、通常のログインでは **403 が出ない**。
- 管理者（許可リスト該当者）は従来どおり 200 で承認待ちを取得できる。

## 4. インシデント（同日・復旧済み）

- 最初の実装では **原本 HTML の meta CSP を直接変更**した。しかし配信時に行われる
  `html.replace("connect-src 'none'", "connect-src 'self'")` が**置換対象を見失い**、
  配信 CSP が `connect-src https://cloudflareinsights.com` だけになった。
- 結果、画面から同一オリジンの API 呼び出し（`/api/me`・`/api/state`・`/api/case-handovers` 等）が
  **すべて CSP でブロック**された（ユーザーのコンソールで確認）。同時に beacon も従来どおりブロック。
- 対応: 原本 HTML を変更前に戻して再起動（**API 呼び出しは復旧**）。その後、**配信時の書き換え**を
  正しく修正する方式に変更した（本稿 §2-1）。
- 教訓: CSP は「原本」と「配信時の書き換え」の2箇所に存在する。**配信時の置換マーカーを壊さない**。

## 5. 本番反映

- ビルド → `COMMIT_SHA` 更新 → `systemctl --user restart ai-helpdesk-api.service`
  （HTML・ブリッジは起動時にキャッシュされるため、**再起動が必要**）。
- 反映後: `/api/health` が `ok`・`db ok`、公開URL 302、5xx 0 を確認。
- ロールバック: 変更を revert して再起動（CSP と UI の分岐のみ。DB 変更なし）。
