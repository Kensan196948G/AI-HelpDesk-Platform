# みらいAI窓口 × ヘルプデスク MVP

社員の IT 相談を「1つの入口」で受け、**PC 基本情報の事前取得（読み取りのみ・デモ）→ AI 一次対応（ルールベース）→ ヘルプデスクへの引継ぎ → 対応・解決記録 → ナレッジ化・承認**までを一気通貫で体験できる、個人利用向けの MVP です。

- 位置づけ: **MVP / Prototype**（本番正式版ではありません）
- 利用者: 検証者 1 名（相談者・ヘルプデスク担当・承認者の 3 ロールをデモアカウントで切替）
- 公開先: Cloudflare の検証環境（Preview）
- データ: Local PostgreSQL（`127.0.0.1:5435`）＋ デモ用 Seed

> 本リポジトリは `Docs/` の要件定義書 V3.1 と、既存試作 HTML（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`）を出典としています。既存ファイルは削除・上書きしません。

## 状態

| 項目 | 状態 |
|---|---|
| 初動 Assessment | 完了（[docs/00-assessment.md](docs/00-assessment.md)） |
| MVP スコープ | 承認待ち（[docs/01-mvp-scope.md](docs/01-mvp-scope.md)） |
| OpenDesign 画面設計 | 作成中（[design/opendesign/](design/opendesign/)） |
| 実装 | 未着手（WebUI は Y/N 承認後） |
| 検証環境 | 未配備 |

## 主要 3 Flow

1. **相談受付〜引継ぎ**: 相談種類 → 内容入力＋PC 基本情報の事前取得 → AI 一次対応 → 解決 or 引継ぎ（TKT/INC 発行）
2. **ヘルプデスク対応**: ボード／一覧 → 案件詳細 → 担当割当 → 解決記録（原因・手順・所要時間）
3. **ナレッジ化〜完了**: 解決記録から伏せ字済み下書き → 申請 → 別の承認者がチェックリスト承認 → 公開 → 相談者へ反映

## 技術スタック（予定）

- Web: React + TypeScript + Vite
- API: Node.js 22 + Fastify + TypeScript
- DB: PostgreSQL 16（Local）
- Edge: Cloudflare Worker（静的配信 + API プロキシ）
- 公開: Cloudflare Tunnel（API）＋ Worker Preview
- CI: GitHub Actions

## ローカル起動（実装後に確定）

```bash
cp .env.example .env
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev
```

## ドキュメント

- [初動 Assessment](docs/00-assessment.md)
- [MVP スコープ・受入条件](docs/01-mvp-scope.md)
- [実装計画](docs/02-plan.md)
- [UI 設計（OpenDesign）](design/opendesign/DESIGN.md)
- 要件の原文: `Docs/Mirai-AI-Helpdesk-V3.1_*.html`

## 既知の制約（MVP）

- AI 一次対応は**ルールベース**（外部 AI API 未接続）。「AI」と表示する箇所には MVP であることを明記。
- PC 基本情報は**デモデータ**。実端末の読み取りは行わない。
- 添付ファイル・端末修復実行・外部ヘルプデスク基盤連携・SSO は対象外。
- 本番正式環境へのデプロイは行わない。

## ライセンス

未設定（個人利用 MVP。必要に応じて追加）。
