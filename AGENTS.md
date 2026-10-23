# AGENTS.md — AI-HelpDesk-Platform

このリポジトリで作業する AI エージェント／開発者向けの指示です。日本語で報告してください。

## 1. 目的

「みらいAI窓口 × ヘルプデスク V3.1」の**個人利用可能な MVP**を、検証環境で実際に操作できる形で提供する。
対象は MVP / Prototype であり、本番正式版・大規模組織向け設計は対象外。

## 2. 正本（Source of Truth）の優先順位

1. この `AGENTS.md` と適用中のリポジトリ指示
2. `docs/01-mvp-scope.md`（MVP スコープ）と `docs/14-prototype-ui-integration.md`（現行 UI の正本）
3. `Docs/` の要件定義書・詳細仕様書（既存の業務要件）
4. `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`（**UI の正本**。画面構成・CSS は変更しない）
5. `docs/` の設計・API・DB・テスト・運用ドキュメント
6. Git 履歴 / Issue / PR
7. OpenDesign の成果物（`design/opendesign/` と OpenDesign プロジェクト）
8. 実行結果（テスト・ログ）

既存の `Docs/`・`File-Archieves/`・試作 HTML は**削除・上書きしない**。参照のみ。

## 3. 技術スタック（MVP）

- Frontend: 既存プロトタイプ HTML（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`）を Fastify から配信
- Backend: Node.js 22 + Fastify + TypeScript（`apps/api`）
- DB: Local PostgreSQL 16（`127.0.0.1:5435`、DB 名 `ai_helpdesk_mvp`）
- DB driver: `postgres`（postgres.js）
- Validation: `zod`
- Test: `vitest`（Unit / Integration / UI / Access / 実PC情報・端末エージェント）
- Lint/Format: `biome`
- Edge: **Cloudflare Tunnel + Cloudflare Access**（`ai-helpdesk.mirai-dx-platform.com`）
- `worker/` は参考実装（policy gate により Workers 配備は不可）
- CI: GitHub Actions（**現在は self-evolution policy gate により workflow ファイルの追加が拒否される。Blocker として docs/08-deployment.md に記録**）

## 4. コマンド

```bash
npm install
npm run typecheck        # 全 workspace の tsc --noEmit
npm run lint             # biome check
npm test             # vitest
npm run build            # api
npm run db:migrate       # 空 DB から再実行可能（冪等）
npm run db:seed          # 再実行可能（TRUNCATE はしない。upsert のみ）
npm run dev:api          # API + 既存 UI を http://127.0.0.1:18950 で配信
node scripts/endpoint-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json --once
                          # 端末エージェント（読み取り専用）で実PC情報を送信
```

## 5. 実装規約

- TypeScript `strict`。`any` を安易に使わない。
- API は `/api` 配下。入力は必ず zod で検証する。
- 権限判定は**サーバ側**で行う。UI の非表示だけに頼らない。
- 未実装機能を実装済みに見せない。画面上に「MVP」「デモデータ」「ルールベース」等の表示を出す。
- 1 変更 = 1 目的。無関係なリファクタや大規模書き換えをしない。
- 既存の要件番号（FR-xx / NFR-xx / BR-xx）をコメントや docs で参照してよい。

## 6. セキュリティ

- Secret / Credential / 実個人情報をリポジトリ・ログ・Seed・PR に書かない。
- `.env` はコミットしない。`.env.example` のみ。
- 相談本文は保存前にパスワード・メール・電話・IP・カード番号等を伏せ字にする。
- PC 基本情報は**読み取り専用**。ブラウザ取得 + 端末エージェントで実端末のハードウェア・ソフトウェア情報を取得する。
  ファイル内容・閲覧履歴・画面・キー入力・メール本文は取得しない。IP・シリアル・資産番号・メールは AI へ渡す前に伏せる。
- 端末エージェント専用の `/api/device/agent` は Cloudflare Access のパス限定 bypass とし、アプリ側のデバイストークン（SHA-256 ハッシュ保存）で保護する。人間の UI / API は従来どおり Access 必須。
- ローカル PostgreSQL をインターネットへ直接公開しない。公開は Cloudflare Access + Tunnel 経由の Node のみ。
- 本番/Preview のログインは Cloudflare Access のみ。アプリ内ログインを追加しない。
- 本番環境・Production deploy・破壊的 DB 操作は行わない（承認がある場合を除く）。

## 7. WebUI の扱い

ユーザー指示（2026-10-23）により、WebUI は既存プロトタイプ HTML を **100% 適用**する。
DOM / CSS / 画面遷移を変更しない。状態保存・AI・認証のブリッジのみ追加する。
やむを得ず表示文言を変える場合は `docs/14-prototype-ui-integration.md` に理由を記録し、ユーザーに報告する。

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
