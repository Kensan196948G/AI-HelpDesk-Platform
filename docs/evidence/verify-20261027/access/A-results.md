# Phase 1 — A: アクセス・ログイン・初期化（2026-10-27 08:40〜08:45 JST）

環境: P=本番 https://ai-helpdesk.mirai-dx-platform.com / V=検証 :18951（HEAD 84bba83 + 020）
実行者: Playwright(Firefox) / curl / psql。実名・メールは伏せ字。

| ID | 検証内容 | 実測 | 判定 |
|---|---|---|---|
| A-01 | 未認証で公開URL | 302 → winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/login | PASS |
| A-02 | One-time PIN 送信→コード入力 | k-***@mirai-const.co.jp へ送信、6桁コードで認証成功（08:41） | PASS |
| A-03 | 認証後の GET / | 200・タイトル「みらいAI窓口 × ヘルプデスク ステップ受付 V3.1」・boot `__AIHD_BOOT__` 正常 | PASS |
| A-04 | リロード | 再認証なしで表示（同一セッション） | PASS |
| A-05 | Cookie 属性 | `CF_Authorization`（ai-helpdesk…）HttpOnly/Secure/残り12.0h、`CF_AppSession` 10.9h | PASS |
| A-06 | 許可外メール | `test@example.com` でもコード送信画面へ進む（Access は列挙防止のため送信を拒否しない）。アクセス付与は無し（コード検証後のポリシー評価で拒否される仕様） | **FAIL（仕様差・Low）** |
| A-07 | ログアウト→再アクセス | 未実施（再PINが必要なため Phase 6 後に実施） | 保留 |
| A-08 | 名簿解決（DX） | `/api/me` = MK0623・管理本部DX推進部。canonical email = owner(gmail)・loginEmail = k-***@mirai-const.co.jp（別名正規化） | PASS |
| A-09 | 名簿解決（一般社員・V） | `/api/me` = MK0122・東京支店工事部、switchMode=self | PASS |
| A-10 | 名簿外（合成） | `/api/me` employee=null・switchMode=self（手動選択へ）。通知1回は未確認 | 部分PASS |
| A-11 | switchMode | owner=any（`PERSONA_SWITCH_ALLOWLIST`）／一般社員=self（本人以外へ切替不可） | PASS |
| A-12 | 初期画面・コンソール | 表示・3ペイン正常。コンソールエラー **4件**（CSP が favicon を img-src で拒否 ×2、Cloudflare beacon を script-src で拒否 ×2） | **FAIL（Low）** |

## 判明した重要事項
1. **ログインは owner と兼用** — `k-***@mirai-const.co.jp` は `EMAIL_ALIASES` により owner(gmail) へ正規化され、switchMode は any。夜間の A1 ペルソナ切替はこのセッションで可能。ただし Access セッションは **約20:41 に失効**するため、夜間は再PINが必要。
2. A-06 は「コード送信前に遮断」ではなく「送信はする・アクセスは付与しない」挙動。期待値の変更可否を G4 で判断する。
3. A-12 の CSP エラーはアプリコード由来ではなく（favicon・Cloudflare Web Analytics）。CSP を締めているため分析ビーコンが動かない。修正候補: `img-src` に `'self'`、beacon を許可 or 無効化。

## 証跡
- `A-01-headers.txt`（302 ヘッダ）
- `verify-20261027-A03-initial.png`（初期画面）
- 実行ログ: 本セッション
