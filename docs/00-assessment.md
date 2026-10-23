# 初動 Assessment（2026-10-23）

## 1. 結論

本ワークスペースは **新規プロジェクト**であり、アプリケーションのソースコード・Git 履歴・CI・DB・デプロイ設定は存在しない。
既存資産は **要件定義書 6 文書**と**単一 HTML の試作アプリ**であり、これらを正本・参考として MVP を新規に構築する。

WebUI は OpenDesign で設計し、ユーザーの Y/N 承認後に実装する。承認待ちの間は、UI に依存しない DB・API・CI・デプロイ準備を進める。

## 2. ワークスペース

| 項目 | 実測 |
|---|---|
| パス | `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform` |
| Git | 当初は **非 Git ディレクトリ**。2026-10-23 に `main` で `git init` |
| 既存ファイル | `Docs/`（6 HTML）、`File-Archieves/`（12 HTML）、ルートに試作 HTML 1 件（494,914 bytes） |
| AGENTS.md / CLAUDE.md / README / ADR / テスト / CI | なし（新規作成） |

### 2-1. 要件・設計の原文

| 文書 | 用途 |
|---|---|
| `Docs/Mirai-AI-Helpdesk-V3.1_01_Concept-Plan_企画構想案.html` | 構想・本番構成・段階導入 |
| `Docs/Mirai-AI-Helpdesk-V3.1_02_Requirements_要件定義書 (1).html` | 業務要件・機能要件（FR-01〜43）・非機能要件・データ要件 |
| `Docs/Mirai-AI-Helpdesk-V3.1_03_Detailed-Specification_詳細仕様書.html` | 画面・STEP・PC 基本情報 31 項目・操作レベル・テスト |
| `Docs/Mirai-AI-Helpdesk-V3.1_04_Easy-Guide_やさしい解説版.html` | 用語・利用者向け説明 |
| `Docs/Mirai-AI-Helpdesk-V3.1_05_Department-Catalog_部署別活用カタログ.html` | 部署別の相談例 |
| `Docs/AppSuite ヘルプデスク整理ガイド.html` | 台帳・移行・個人情報の扱い |
| `Docs/Lightblue_vs_Cowork_Helpdesk_Workload_Comparison_V1.0.html` | 工数比較の参考 |

### 2-2. 既存試作の特徴

- 単一 HTML（約 490KB、JS 約 321KB、CSS 約 68KB）。外部通信なし（CSP `connect-src 'none'`）。
- `localStorage` キー `mirai-wizard-v31-cowork` / `mirai-wizard-v31-helpdesk` に保存。
- STEP 1〜7、PC 基本情報の事前取得、ボード、一覧、業務ツール 28 画面を含む。
- AI はルールベースの模擬。実端末・外部 AI には接続しない。
- **コードは流用せず**、画面構成・用語・STEP・信号色・PC 情報 31 項目の仕様を参考にする（要件が正本）。

## 3. 実行環境（実測）

| 項目 | 実測値 | 判定 |
|---|---|---|
| Node.js | v22.22.3 | 利用可 |
| npm / pnpm | npm 10.9.8 / pnpm は `.npmrc` の `${NPM_TOKEN}` 警告あり | pnpm は corepack 経由で利用予定 |
| PostgreSQL クライアント | psql 18.4 | 利用可 |
| Local PostgreSQL | `127.0.0.1:5435` / PostgreSQL 16.14 / DB `deepseek_harness` / ロール `deepseek_harness`（superuser, createdb） | 専用 DB を追加作成する |
| PostgreSQL 5432 | パスワード必須（未保有） | **使用しない** |
| GitHub CLI | `Kensan196948G` で認証済み（`repo`, `workflow`） | 利用可 |
| GitHub リポジトリ | `Kensan196948G/AI-HelpDesk-Platform` は未作成（404） | 新規作成する（Private） |
| Cloudflare | wrangler OAuth ログイン済み。Account `4f1e888469df7e0b896bb4e211b12633`。Zone `mirai-dx-platform.com` あり | Pages/Workers/Tunnel を利用可 |
| cloudflared | 既存トンネル多数。`mirai-dx-platform.com` の DNS を管理 | 新規トンネルを追加する（既存は変更しない） |
| OpenDesign | daemon `127.0.0.1:7456`（v0.21.1, active）、Web `:5173`、Tunnel `ai-design.mirai-dx-platform.com` | 画面設計に利用可 |
| Playwright | Chromium 複数バージョン導入済み | E2E に利用可 |

## 4. Gap Discovery（重大度順）

| # | Gap | 重大度 | MVP への影響 | 対応 |
|---|---|---|---|---|
| G-01 | Git リポジトリ・GitHub リポジトリ・CI がない | High | 変更管理・PR・CI ができない | `main` 初期化、Private リポジトリ作成、CI 追加 |
| G-02 | アプリのソースコードがない | High | MVP が存在しない | React + Fastify で新規実装 |
| G-03 | DB スキーマ・Migration・Seed がない | High | 主要 Flow の永続化ができない | `db/migrations` + 冪等 Seed |
| G-04 | OpenDesign の設計成果物がない | High | UI 実装の承認ができない | OpenDesign プロジェクトに設計 artifact を作成 |
| G-05 | 認証・権限がない | High（公開時） | 誰でも参照・更新できてしまう | 3 ロールのログイン＋サーバ側認可 |
| G-06 | 外部 AI の API キーがない | Medium | AI 回答が作れない | ルールベース + 承認済みナレッジ検索。Adapter で将来差替え |
| G-07 | 実 PC エージェントがない | Medium | PC 基本情報が取得できない | 31 項目のデモデータを生成（読み取り専用表示） |
| G-08 | 添付・外部ヘルプデスク基盤・SSO がない | Medium | 一部 FR が未実装 | MVP 対象外として Backlog 化 |
| G-09 | Cloudflare から Local PostgreSQL へ直接接続できない | High | 公開 API が DB に届かない | Local Node API を Tunnel で公開し、Worker からプロキシ |
| G-10 | Secret 管理の仕組みがない | High | 認証情報の混入リスク | systemd `EnvironmentFile`（0600）＋ Worker Secret。リポジトリには置かない |
| G-11 | テスト・E2E・受入証跡がない | High | 完了判定できない | vitest + Playwright + Preview 実操作 |
| G-12 | ドキュメント（Setup/API/DB/Test/Deploy/Limitations）がない | Medium | 再現・引継ぎができない | 実装と同時に整備 |
| G-13 | 本番向けの高度機能（28 画面・修復実行・監査 SIEM 等）が多い | Medium | 過剰実装のリスク | MVP 3 Flow に限定し、Issue/Backlog へ分離 |

## 5. 制約・前提

- 本番正式環境・Production deploy・費用発生・契約変更は行わない。
- Local PostgreSQL はインターネットへ直接公開しない。Tunnel 経由の API のみ公開する。
- 外部 AI は接続しない（API キー未保有）。AI 表示は「ルールベース MVP」と明記する。
- PC 基本情報はデモデータ。実端末・個人情報を取得しない。
- 添付ファイルは MVP 対象外（メタデータのみの表示も行わない）。
- WebUI は OpenDesign 設計＋ユーザー Y/N 承認後に実装する。
- Cloudflare の既存リソース（既存 Pages/Tunnel/DNS）は変更しない。新規名のみ追加する。

## 6. 初期判断

1. 既存の `Docs/`・`File-Archieves/`・試作 HTML は**参照専用**として残す。
2. 新規モノレポ（`apps/web`, `apps/api`, `db`, `worker`）を作る。
3. 元試作の localStorage 実装は引き継がず、PostgreSQL + API に置き換える。
4. UI は元試作の「紺のサイドバー・STEP バー・信号色・カード」を踏襲しつつ、OpenDesign で MVP 用に再設計する。
5. 3 ロール（相談者・ヘルプデスク・承認者）のデモログインで、認可を実演する。
6. 完了判定は Cloudflare Preview 上の実操作を必須とする。

## 7. 次のアクション

- `docs/01-mvp-scope.md` と `docs/02-plan.md` を確定する。
- OpenDesign に画面設計 artifact を作成する。
- 日本語の数字選択式質問＋Y/N 承認を依頼する。
- 承認後、DB → API → Web の順に実装する。
