# みらいAI窓口 × ヘルプデスク MVP

社員の IT 相談を「1つの入口」で受け、**PC 基本情報の事前取得（読み取りのみ・デモ）→ AI 一次対応 → ヘルプデスクへの引継ぎ → 対応・解決記録 → ナレッジ化・承認**までを一気通貫で体験できる、個人利用向けの MVP です。

- 位置づけ: **MVP / Prototype**（正式版ではありません）
- **WebUI**: 既存プロトタイプ `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html` を **そのまま配信**（画面構成・CSS・28 業務ツールを維持）
- **公開 URL**: https://ai-helpdesk.mirai-dx-platform.com （**Cloudflare Access** の OTP ログイン）
- **AI**: 自由記述の回答に **DeepSeek API**。診断・修復・セキュリティ初動は元の決定ルール
- **DB**: Local PostgreSQL 16（`ai_helpdesk_preview` / `ai_helpdesk_mvp`）
- **認証**: Cloudflare Access のみ（One-time PIN / 12h / `kensan1969@gmail.com` と `@mirai-const.co.jp`）

## 状態（2026-10-23）

| 項目 | 状態 |
|---|---|
| 初動 Assessment / MVP Scope | 完了（[docs/00](docs/00-assessment.md) / [docs/01](docs/01-mvp-scope.md)） |
| OpenDesign | 設計検討の記録（[design/opendesign](design/opendesign/)）。実画面はユーザー指示により既存 HTML が正本 |
| WebUI（既存プロトタイプ） | **配信中**（レイアウト変更なし。状態/AI のみブリッジ） |
| Local PostgreSQL | Migration / Seed / Read・Write / Backup-Restore 検証済み |
| API | Fastify。認証（local / Cloudflare Access）、案件、引継ぎ、解決、ナレッジ、監査、状態保存、AI |
| Tests | **59 tests 成功**（Unit / API integration / Worker / UI / Access / 許可リスト） |
| Cloudflare Preview | **公開中**（Tunnel + Access。OTP ログイン画面を確認） |
| Access 許可メール | **設定済み**（`docs/MailAddress.txt` + Cloudflare allow ポリシー） |
| Access OTP ログイン | **確認済み**（2026-10-23 15:32 JST / `onetimepin` / `allowed=true`） |
| DeepSeek API キー | **設定済み・実回答確認済み**（`provider: deepseek` / `deepseek-chat`） |
| CI | **Blocker**（policy gate が `.github/workflows/` を拒否） |

## 主要 3 Flow

1. **相談受付〜引継ぎ**: 相談種類 → 内容＋PC 基本情報 → AI 一次対応 → 解決 or 引継ぎ（TKT/INC）
2. **ヘルプデスク対応**: ボード → 案件詳細 → 担当割当 → 解決記録
3. **ナレッジ化〜完了**: 伏せ字済み下書き → 承認申請 → 別の承認者が承認 → 公開

## 構成

```
Browser
  │  Cloudflare Access（OTP / 12h / 許可メールのみ）
  ▼
Cloudflare Tunnel  ai-helpdesk.mirai-dx-platform.com
  │
  ▼
Node 22 / Fastify  ai-helpdesk-api.service（127.0.0.1:18950）
  │  ├─ 既存プロトタイプ HTML を配信（boot / bridge を注入）
  │  ├─ /api/state（prototype_states）
  │  └─ /api/ai/answer（DeepSeek + 承認済みナレッジ）
  ▼
Local PostgreSQL  ai_helpdesk_preview
```

- Cloudflare Worker / Pages は、DSH の self-evolution policy gate が `wrangler` 配備を DEPLOY（critical）として拒否するため使用していません。
- Tunnel + Access は policy gate で拒否されず、既存 HTML をそのまま配信できるため採用しました。

## アクセス制御

許可リストの正本は **[docs/MailAddress.txt](docs/MailAddress.txt)** です。

- 完全一致メール（例: `kensan1969@gmail.com`）と `@domain`（例: `@mirai-const.co.jp`）を 1 行 1 件で書く。
- `#` 以降のコメント、`例：` / `e.g.` 以降の例示は無視する（例示用の typo メールを誤って許可しないため）。
- アプリは `ACCESS_ALLOWLIST_FILE`（既定 `docs/MailAddress.txt`）を読み、Cloudflare Access のヘッダーと照合する。**ファイルが無い・空の場合は全拒否（fail-closed）**。
- **Cloudflare Access の allow ポリシーと同じ内容に保つ**（二重チェック）。変更時は両方を更新して API を再起動する。

## ローカル起動

```bash
npm install
cp .env.example .env.local
# DATABASE_URL / SESSION_SECRET / SEED_PASSWORD を設定
chmod 600 .env.local

npm run db:migrate
npm run db:seed
npm run dev:api
# http://127.0.0.1:18950/ （開発モードは認証なし）
```

本番相当（Access モード）:

```bash
npm run build
AUTH_MODE=cloudflare-access ACCESS_ALLOWLIST_FILE=docs/MailAddress.txt \
  DATABASE_URL=... SESSION_SECRET=... npm run start:api
```

## 検証

```bash
npm run typecheck   # API + worker
npm run lint
npm test            # 59 tests（PostgreSQL テスト DB）
npm run build
bash scripts/scan-secrets.sh
npm audit --omit=dev --audit-level=high
```

実測: TypeCheck ✅ / Lint ✅ / 59 tests ✅ / Build ✅ / Secret scan ✅ / npm audit 0 vulnerabilities。

## ドキュメント

- [初動 Assessment](docs/00-assessment.md) / [MVP Scope](docs/01-mvp-scope.md) / [Plan](docs/02-plan.md)
- [WebUI 確認質問（旧）](docs/03-questions.md)
- [Database](docs/04-database.md) / [API](docs/05-api.md) / [Test](docs/06-test.md)
- [Security](docs/07-security.md) / [Deployment](docs/08-deployment.md) / [Operations](docs/09-operations.md)
- [Backlog](docs/10-backlog.md) / [受入照合](docs/11-acceptance.md)
- [Round Log](docs/12-round-log.md) / [Blocker 報告](docs/13-blocked-report.md)
- **[既存プロトタイプ UI 100% 適用（現行）](docs/14-prototype-ui-integration.md)**
- [OpenDesign 設計（参考）](design/opendesign/DESIGN.md)

## 既知の制約・要ユーザー対応

- UI の全 STEP E2E（ウィザード全 STEP・ヘルプデスク・ナレッジ承認）は未実施です。
- DeepSeek API キーは `~/.config/ai-helpdesk/api.conf`（0600）に設定済み。自由記述の回答は `deepseek-chat` で生成され、承認済みナレッジを根拠にします。
- **CI 未設定**。`.github/workflows/` は policy gate で拒否されます。人間による追加、または policy 例外が必要です。
- ローカル DNS（192.168.245.11）が新ホストを NXDOMAIN キャッシュ中です。1.1.1.1 では解決済み。TTL 経過後に再確認してください。
- アプリ内の「操作する人」切替は**デモ用**です。実際のログインは Cloudflare Access のみです。
- 既存プロトタイプの「完全オフライン」等の表示は、事実と異なる主要ラベルだけ更新しています（[docs/14](docs/14-prototype-ui-integration.md) §2-1）。
- 添付実体・端末修復実行・外部ヘルプデスク基盤連携・SSO は対象外です。

## ライセンス

未設定（個人利用 MVP。必要に応じて追加）。
