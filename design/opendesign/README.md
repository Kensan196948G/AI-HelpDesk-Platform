# OpenDesign 成果物（WebUI 設計）

- 作成日: 2026-10-23
- 状態: **ユーザー承認待ち（Y/N）**
- 実装: 未着手（承認後に開始）

## 1. OpenDesign プロジェクト

| 項目 | 値 |
|---|---|
| Project ID | `b740d7e6-e0df-483f-91e6-32cce94c5d75` |
| Project 名 | Mirai AI HelpDesk MVP — 画面設計 |
| 作成方法 | ローカル OpenDesign daemon（v0.21.1 / `127.0.0.1:7456`）の `POST /api/projects` |
| Design direction | `tech-utility`（`od tools directions --id tech-utility --json` で取得） |
| ローカル URL | `http://192.168.0.185:5173/projects/b740d7e6-e0df-483f-91e6-32cce94c5d75/` |
| Tunnel URL | `https://ai-design.mirai-dx-platform.com/projects/b740d7e6-e0df-483f-91e6-32cce94c5d75/`（HTTP 200 確認済み） |

## 2. 成果物（artifact）

| ファイル | 版 | サイズ | contentDigest | 備考 |
|---|---|---|---|---|
| `design-board.html` | 3 | 132,109 bytes | `ab47ade6979b0deee78a04415da63de308277ff7eb049c30c49dcd6a59ba7e0d` | 全 16 ビュー（Tokens / Flow / S1〜S8 / States） |

- 作成: `od artifacts create --name design-board.html --input design/opendesign/design-board.html --project <id>`
- 更新: OpenDesign daemon の `POST /api/projects/:id/files`（`overwrite: true`）で Version 3 に更新
- OpenDesign プロジェクト実体: `/home/kensan/Projects/open-design/.od/projects/b740d7e6-e0df-483f-91e6-32cce94c5d75/design-board.html`
- manifest: `design-board.html.artifact.json`（kind: html, renderer: html, status: complete）

## 3. 設計レビュー（OpenDesign anti-slop linter）

```bash
cd /home/kensan/Projects/open-design
node apps/daemon/bin/od.mjs lint \
  /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform/design/opendesign/design-board.html --json
```

結果:

| 重要度 | 件数 | 内容 |
|---|---:|---|
| P0 | 0 | なし（`scrollIntoView` を `scrollTo` に修正済み） |
| P1 | 1 | `raw-hex` 129 箇所。トークン見本（色見本）として意図的に実値を表示しているため許容。実装 CSS は `:root` の CSS 変数を使用する |
| P2 | 0 | 全 16 セクションに `data-od-id` を付与済み |

判定: P0/P2 は解消。P1 は設計ボードの色見本表示のため受容（理由を本節に記録）。

## 4. スクリーンショット（設計ボード）

`design/opendesign/screenshots/` に以下を保存（1440×1200、ヘッドレス Chrome で撮影）。

- `home-req.png` — ホーム（相談者）
- `w3.png` — 相談ウィザード STEP 3（AI 一次対応）
- `desk.png` — ヘルプデスク ボード
- `login.png` — ログイン

## 5. 設計内容

- 画面: S1 ログイン / S2 ホーム（相談者・担当者）/ S3 相談ウィザード（STEP 1〜4）/ S4 相談状況 / S5 ボード / S6 案件対応 / S7 ナレッジ（一覧・承認）/ S8 監査ログ
- 状態: 正常 / 空 / 読込中 / 入力エラー / 通信エラー / 権限なし / 404 / 成功 / 赤信号 / 改ざん検知
- ロール: 相談者 / ヘルプデスク / 承認者（サーバ側で認可）
- デザイン: navy サイドバー、信号の3色（色＋日本語ラベル）、カード、STEP バー、右レール
- レスポンシブ: PC 中心。820px 以下はサイドバーを縮小し、1カラム
- アクセシビリティ: フォーカスリング、色＋文字、キーボード、Esc、`prefers-reduced-motion`

詳細は [DESIGN.md](./DESIGN.md) を参照。

## 6. 承認

`docs/03-questions.md` の質問に回答し、最後に **Y（承認して進める） / N（修正する）** を選択してください。
Y を得るまで WebUI の実装は開始しません。
