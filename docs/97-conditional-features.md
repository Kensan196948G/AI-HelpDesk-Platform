# 97. PC情報からの補足と入力中のリアルタイム判定（条件付き 2 機能）（2026-11-11）

## 0. 結論

[docs/92](92-webui-flow-sample-adoption.md) §3-1 の **#6（PC 診断の「PC情報からの補足」）** と **#7（入力中のリアルタイム判定）** を実装した。どちらも「条件付き可」で、PR-1〜3 の対象外だった項目である。

- #6: 画面がすでに出している **★（相談内容に関係しそうな項目）** を読み、直近のナレッジ案内の下に「PC情報からの補足」として添える。**新しい診断規則は作らない**。IP・シリアルは出さない。
- #7: 代行受付の入力中に、**ルールベース**の入力チェックを出す。判定はサーバーの読み取り専用 API で、**実 AI は呼ばない**。規則は `domain/signal.ts` と `domain/pii.ts` の既存の正本を使う。
- 原本 HTML は変更しない。テストは 205 件（17 件追加）。

## 1. #6 PC情報からの補足

`apps/api/src/prototype/pc-supplement-bridge.js`（追加）

- 相談者のチャット（`#msgs`）で、**直近のナレッジ案内**（`[data-aihd-kb-guide]`）の直後に補足を差し込む。
- 補足の内容は、**PCエージェントのメッセージに出ている「気になる点」のうち ★ が付いた項目だけ**。★は画面がすでに計算している「相談内容に関係しそう」の印で、ブリッジは同じ表示を読むだけで、判定規則を二重に持たない。
- ★は警告・異常の項目にだけ付くため、IPアドレス・シリアル番号（正常項目）は補足に出ない。補足にも「IPアドレス・シリアル番号は表示していません」と明記する。
- 新しい取得・AI 呼び出し・保存はしない（`/api/` を呼ばない）。

**制約**: 対象はチャット画面（`#msgs` のナレッジ案内）だけ。ウィザード STEP3 のメッセージは別の描画のため、今回は補足しない（必要なら同じ考え方で追加できる）。

## 2. #7 入力中のリアルタイム判定

### 2-1. 判定 API（読み取り専用）

`POST /api/intake/preview`（`apps/api/src/routes/intake.ts`、`apps/api/src/domain/intake-preview.ts`）

| 項目 | 内容 |
|---|---|
| 認証 | `authenticateUi` ＋ ヘルプデスク相当（`requireHelpdeskActor`） |
| 入力 | `subject` / `body`（文字列）、`category`（分野。セキュリティだけ初期色に効く）、`urgency`（`normal` / `urgent`） |
| 出力 | `signal`（青/赤。`initialSignal` の結果）、`security`（`hasSecurityConcern`）、`pii`（`redactPII` の種類と件数）、`missing`（件名・内容・短さ）、`notes`（画面に出す指摘） |
| DB | 読まない・書かない |
| AI | **呼ばない**（入力のたびに実 AI を呼ばない条件を守る） |

- 規則は `domain/signal.ts`（セキュリティ語・緊急度・分野）と `domain/pii.ts`（個人情報）の既存実装をそのまま使う。
- 指示文（プロンプトインジェクション）の判定は、サーバーに正本の規則が無いため**今回の対象外**（AI 側の防御プロンプトは従来どおり）。

### 2-2. 画面（① 受付）

`apps/api/src/prototype/intake-preview-bridge.js`（追加）

- ① 受付のフォーム（`#i_sub` / `#i_body`）の下に「入力チェック（ルールベース）」を出す。
- 入力が **500ms** 止まったときだけ API を呼ぶ（1 文字ごとに呼ばない）。分野・緊急度の変更でも更新する。
- 表示: 信号の見立て（赤/青）、セキュリティ・個人情報・不足の指摘、**「ルールベース」「AIは呼びません」**、担当者の判断を置き換えない旨。
- API が失敗しても**受付の操作は止めない**（「入力チェックを取得できませんでした」と出すだけ）。

## 3. 変更ファイル

| ファイル | 変更 |
|---|---|
| `apps/api/src/domain/intake-preview.ts` | 追加（判定の純粋関数。signal / pii を再利用） |
| `apps/api/src/routes/intake.ts` | 追加（`POST /api/intake/preview`、読み取り専用） |
| `apps/api/src/server.ts` | 経路の登録 |
| `apps/api/src/prototype/pc-supplement-bridge.js` | 追加（#6） |
| `apps/api/src/prototype/intake-preview-bridge.js` | 追加（#7） |
| `apps/api/src/routes/prototype.ts` | 配信するブリッジに 2 本を追加 |
| テスト 3 本 | 追加（17 件） |
| `docs/evidence/conditional-features/*.png` | UI スモーク 2 枚 |

## 4. 検証

| 試験 | 結果 |
|---|---|
| `npm run typecheck` | 成功 |
| `biome check`（変更ファイル、エラー） | 成功 |
| prototype ＋ 検査の単体試験 | **15 ファイル / 205 件 成功**（17 件追加） |

追加した試験:

- `intake-preview.test.ts`（6 件）: 青/赤、セキュリティ語、緊急、PII の種類と件数、件名・内容の不足、分野=セキュリティの初期色。
- `intake-preview-bridge.test.ts`（5 件）: 赤/青の表示、未判定、実体参照、ルールベース・AI を呼ばない明記、500ms 間引き・分野/緊急度の変換。
- `pc-supplement-bridge.test.ts`（6 件）: ★の抽出、★なし、見出しと IP 非表示の明記、実体参照、既存表示を読むだけ（`/api/` を呼ばない）。

UI スモーク（Playwright / Firefox）:

| 画像 | 内容 |
|---|---|
| `docs/evidence/conditional-features/01-intake-preview.png` | ① 受付で「不審なメール…メールアドレス」を入力 → 赤・セキュリティ・PII の指摘（**実サーバーの API** に接続） |
| `02-pc-supplement.png` | チャットの★項目とナレッジ案内 → 「PC情報からの補足」（UIスモーク用の合成メッセージ。bridge の描画確認） |

- #7 はローカル開発サーバー（`127.0.0.1:18972`、`AUTH_MODE=local`）で、実際に `POST /api/intake/preview` を呼び、`signal=red`・PII 1 件の応答と画面表示を確認した。`pageerror` 0。
- #6 は画面の描画確認のため、実アプリのチャットに検証用メッセージ（「（UIスモーク）」と明記）を入れ、★項目と IP が補足にどう出るかを確認した。補足に IP が出ないことも確認した。

## 5. 限界（未検証）

- #7 の指示文判定は未実装（サーバーに正本の規則が無いため）。実 AI の呼び出しは無い。
- #6 はチャット画面のナレッジ案内だけ。ウィザード STEP3 のメッセージには補足しない。
- どちらも本番・Staging（Access OTP）では未確認。配備は [docs/96](96-release-prep-webui-20261111.md) の手順に含まれる（本番反映は人間の承認後）。
- #6 の UI スモークは合成メッセージによる描画確認であり、実データでの★の発生は確認していない（ローカルのデモ端末は正常で ★ が出ないため）。

## 6. 参照

- 取り込み方針: [docs/92](92-webui-flow-sample-adoption.md) §3-1 #6 / #7
- 正本: `apps/api/src/domain/signal.ts`、`apps/api/src/domain/pii.ts`
- 既存の画面: [docs/14](14-prototype-ui-integration.md)
