# AGENTS.md — AI-HelpDesk-Platform

このリポジトリで作業する AI エージェント／開発者向けの指示です。日本語で報告してください。

## 1. 目的

「みらいAI窓口 × ヘルプデスク V3.1」の**個人利用可能な MVP**を、検証環境で実際に操作できる形で提供する。
対象は MVP / Prototype であり、本番正式版・大規模組織向け設計は対象外。

## 2. 正本（Source of Truth）の優先順位

1. この `AGENTS.md` と適用中のリポジトリ指示
2. `docs/01-mvp-scope.md`（承認済み MVP スコープ）と `design/opendesign/DESIGN.md`（承認済み UI 仕様）
3. `Docs/` の要件定義書・詳細仕様書（既存の業務要件）
4. `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`（既存試作。画面の参考。実装の正本ではない）
5. `docs/` の設計・API・DB・テスト・運用ドキュメント
6. Git 履歴 / Issue / PR
7. OpenDesign の成果物（`design/opendesign/` と OpenDesign プロジェクト）
8. 実行結果（テスト・ログ）

既存の `Docs/`・`File-Archieves/`・試作 HTML は**削除・上書きしない**。参照のみ。

## 3. 技術スタック（MVP）

- Frontend: React + TypeScript + Vite（`apps/web`）
- Backend: Node.js 22 + Fastify + TypeScript（`apps/api`）
- DB: Local PostgreSQL 16（`127.0.0.1:5435`、DB 名 `ai_helpdesk_mvp`）
- DB driver: `postgres`（postgres.js）
- Validation: `zod`
- Test: `vitest`（Unit / Integration）、`@playwright/test`（E2E、WebUI 承認後）
- Lint/Format: `biome`
- Edge: Cloudflare Worker（静的配信 + API プロキシ、`worker/`）
- API 公開: Cloudflare Tunnel（ローカル Node API → 検証用ホスト名）
- CI: GitHub Actions（**現在は self-evolution policy gate により workflow ファイルの追加が拒否される。Blocker として docs/08-deployment.md に記録**）

## 4. コマンド

```bash
npm install
npm run typecheck        # 全 workspace の tsc --noEmit
npm run lint             # biome check
npm test             # vitest
npm run build            # web + api
npm run db:migrate       # 空 DB から再実行可能（冪等）
npm run db:seed          # 再実行可能（TRUNCATE はしない。upsert のみ）
npm run dev              # api + web
npm run e2e              # Playwright
```

## 5. 実装規約

- TypeScript `strict`。`any` を安易に使わない。
- API は `/api` 配下。入力は必ず zod で検証する。
- 権限判定は**サーバ側**で行う。UI の非表示だけに頼らない。
- 未実装機能を実装済みに見せない。画面上に「MVP」「デモデータ」「ルールベース」等の表示を出す。
- 1 変更 = 1 目的。無関係なリファクタや大規模書き換えをしない。
- 既存の要件番号（FR-xx / NFR-xx / BR-xx）をコメントや docs で参照してよい。

## 6. セキュリティ

- Secret / Credential / 実个人情報をリポジトリ・ログ・Seed・PR に書かない。
- `.env` はコミットしない。`.env.example` のみ。
- 相談本文は保存前にパスワード・メール・電話・IP・カード番号等を伏せ字にする。
- PC 基本情報は**読み取り専用のデモデータ**。実端末情報は取得しない。
- ローカル PostgreSQL をインターネットへ直接公開しない。公開は Cloudflare Tunnel 経由の API のみ。
- 本番環境・Production deploy・破壊的 DB 操作は行わない（承認がある場合を除く）。

## 7. WebUI の承認

WebUI の新規構築・改修は、OpenDesign で設計し、`design/opendesign/` に成果物を残す。
ユーザーの明示的な Y（承認）前に WebUI 実装を開始しない。承認済み仕様の重大変更は再承認。

## 8. Git / PR

- 基準ブランチ: `main`（保護）
- 作業ブランチ: `feat/*`, `fix/*`, `chore/*`
- Conventional Commits（例: `feat(web): 相談ウィザード STEP1-2 を実装`）
- PR には Goal / Changes / UI / API / DB / Security / Tests / Deploy / Limitations / Rollback を書く。
- Required Checks が緑になるまでマージしない。Squash Merge。
- 1 コミットに無関係な差分を混ぜない。

## 9. 完了条件

`docs/01-mvp-scope.md` の受入条件と、ユーザー Goal の 32 項目を Evidence 付きで満たすこと。
「コードを書いた」「CI が緑」「デプロイ成功」だけでは完了にしない。
Cloudflare Preview 上で 3 つの主要 Flow を実操作し、UI / API / DB / Runtime を確認する。
