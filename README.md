<div align="center">

<img src="docs/assets/readme/hero.svg" alt="みらい AI 窓口 — 社員の IT 相談をひとつの窓口で" width="100%">

<br><br>

**「PC が動かない」「この作業、どうやるの？」を、ひとつの窓口で。**

<a href="https://ai-helpdesk.mirai-dx-platform.com"><img src="https://img.shields.io/badge/%F0%9F%8C%90%20%E3%83%87%E3%83%A2-%E5%85%AC%E9%96%8B%E4%B8%AD-2ea043?style=for-the-badge&logo=cloudflare&logoColor=white" alt="デモ公開中"></a>
<img src="https://img.shields.io/badge/%F0%9F%A4%96%20AI-DeepSeek%20V4.1%20Flash-4f46e5?style=for-the-badge&logo=openai&logoColor=white" alt="AI: DeepSeek V4.1 Flash">
<img src="https://img.shields.io/badge/%F0%9F%94%92%20PC%E6%83%85%E5%A0%B1-%E8%AA%AD%E3%81%BF%E5%8F%96%E3%82%8A%E3%81%AE%E3%81%BF-0ea5e9?style=for-the-badge&logo=shieldcheck&logoColor=white" alt="PC 情報は読み取りのみ">
<img src="https://img.shields.io/badge/%F0%9F%93%A6%20%E7%8A%B6%E6%85%8B-MVP%20%E8%A9%A6%E4%BD%9C-f59e0b?style=for-the-badge" alt="MVP 試作">
<img src="https://img.shields.io/badge/%F0%9F%A7%AA%20%E8%87%AA%E5%8B%95%E3%83%86%E3%82%B9%E3%83%88-%E3%81%82%E3%82%8A-22c55e?style=for-the-badge&logo=vitest&logoColor=white" alt="自動テストあり">

</div>

> [!WARNING]
> これは **試作版（MVP）** です。会社の正式システムではありません。
> 「こんなふうに使える」を確かめるためのものなので、本番の業務データは入れないでください。

---

## 🍀 これは、なに？

社員のみなさんの「困った！」を **1 つの窓口** で受け付けて、
**AI が先に答え、むずかしい話だけ人が引き継ぐ** しくみです。

いまは、聞き先がバラバラになりがちです 👇

```
メールに書く 📧 ／ 電話する 📞 ／ 直接たずねる 🚶 ／ チャットする 💬
        ↓
  担当者が毎回おなじことを聞く（型番は？ OS は？ いつから？）
        ↓
  解決しても、その知識は担当者のなかに残るだけ 😢
```

この窓口では、こう変わります 👇

```
ひとつの窓口に書く 💬（PC の情報も自動で添付）
        ↓
AI が答えるだけじゃなく、その場で直す 🤖
（許可リストの操作だけ／診断 → 対応案 → 実行）
        ↓
最後に決めるのは人。押すのは「Y」か「N」だけ ✋
        ↓
直れば解決 ✅ ／ 直らなければ DX 推進部へバトン 🧑‍🔧
        ↓
解決した内容が「ナレッジ」になり、次の人の答えになる 📚
```

---

## 😵 こんなことで、困っていませんか？

| いまの困りごと | この窓口だと |
|---|---|
| 🙋 聞きたいけど、誰に聞けばいいか分からない | 🤖 まず AI が 24 時間すぐ答えます |
| ⏰ ヘルプデスクが混んでいて、返事が遅い | ⚡ よくある質問は、その場で解決します |
| 🔁 同じ質問が、何度も何度も来る | 📚 解決した内容がナレッジになり、次の人の答えになります |
| 🖥 「PC の型番は？」と毎回聞かれる | 📋 PC の基本情報が、自動で添付されます |
| 😰 引き継ぐたびに、最初から説明し直す | 🧑‍🔧 ここまでのやりとりが、そのまま引き継がれます |

---

## ✨ できること（4 つ）

**1. 🙋 相談する**
チャットに書くだけ。むずかしい設定はありません。PC の基本情報も自動で付きます。

**2. 🤖 AI が答えて、その場で直す**
社内で **承認ずみのナレッジ** と PC の情報を根拠に答えるだけでなく、
**許可リストにある操作**（例：印刷スプーラーの再起動）は、その場で実行まで進めます。
実行してよいかは **本人が「Y」か「N」で決めます**。AI が勝手に直すことはありません。

**3. 🧑‍🔧 直らなければ、人が引き継ぐ**
「N」を選ぶか、許可リストにない対応が必要なときは、**DX 推進部** へバトンを渡します。
そのとき「ここまで何を試したか」の引継ぎ要約が自動で作られます。
宛先はグループで、必要なら名簿から担当者を選ぶこともできます（自由入力ではありません）。
届いた人は受信箱から選んで引き受け、**AI に追加で質問**することもできます。

**4. 📚 ナレッジになる**
解決した内容は、**人が承認して** はじめて「本棚」に入ります。
承認されたものだけが、次の人の答えになります。

<br>

<img src="docs/assets/readme/flow.svg" alt="相談 → AI 一次対応 → 人が引き継ぐ → ナレッジ化 の流れ" width="100%">

---

## 🤖 AI は、どこまでやる？（いちばん大事なところ）

「AI がその場で直す」と聞くと、少し不安になりますよね。範囲は次のとおりです。

| | やること | 人の関与 |
|---|---|---|
| 💬 **答える** | 症状の整理・確認・手順の説明 | なし（読むだけ） |
| 🔍 **調べる** | PC の基本情報・**読み取りだけ**の診断 | なし（変更しない） |
| 🛠 **直す** | **許可リスト**の操作を提案し、実行する | **本人が Y / N**（Lv4 の操作は管理者の承認も必要） |
| 🚫 **やらない** | 許可リスト外の操作・権限の付与・セキュリティ機能の停止・一括削除・勝手な再起動 | 提案そのものを作らない |

- 🖐 **押すのは「Y」か「N」だけ。** 実行するかどうかは、必ず本人が決めます。
- 🔁 **1 相談あたり 15 回まで。** 超えたら自動実行せず、担当者へ引き継ぎます。
- 📝 **「N」を選ぶと、引継ぎ要約が自動で作られます。** 同じ説明をやり直す必要はありません。
- 🛡 **実行前に確認します。** 本当に本人の Y か、対象はその人の端末か、危険度の高い操作かを確かめてから動きます。
- 🖥 **実機で動く操作は、いまのところ「印刷スプーラーの再起動」だけです。** ほかの操作はプロトタイプ内での模擬実行です（端末エージェントを入れた PC なら実機で動きます）。

### 🛠 「修復・作業の提案カード」って？

STEP 3「AI 一次対応」のチャットの中に、AI が **実際に何を実行するか** まで書いたカードが出ます。

| カードに載るもの | 例 |
|---|---|
| 🛠 **操作** | 印刷スプーラサービスの再起動（`SPOOLER_RESTART`） |
| 🎯 **対象** | 自分の PC のプリンター |
| ⚠️ **影響** | 再起動中（約 30 秒）は印刷できません。待機中のジョブは保持されます |
| ↩️ **戻し方** | 再起動のみ（失敗したら担当者へ引き継ぎ） |
| 🔐 **必要な承認** | 本人の Y ＋ IT 管理者の承認 |
| #️⃣ **承認ハッシュ** | 内容が変わると承認が無効になる番号 |

本人にだけ、次の 3 つが出ます。

- **Y：この操作を承認**
- **N：実行しない**
- 🙋 **担当者に相談**

押したあとは、こうなります。

```
Y →（管理者の承認が必要な操作なら承認待ち）→ 実行前の確認 → 実行
   → 結果（例：スプーラ＝実行中、待機ジョブ＝3 件保持）
   → 「✅ 解決した」／「🙋 まだ困っている」→ 必要なら「元に戻す」
N → 何も実行しません（端末は変更なし）→ 引継ぎ要約を自動で作成
```

> 💡 実行前の確認で 1 つでも不合格なら、**実行しません（端末は変更しません）**。
> 「本人の Y が記録されているか」「承認時から内容が変わっていないか」「対象は本人の端末か」「管理者の承認があるか」を確かめます。



---

## 🧭 つかいかた（3 ステップ）

### 1. 相談する 🗣️

窓口をひらいて、ふだん話すように書くだけです。

> 例：「昨日から社外の共有フォルダが開けません。Windows 11 です。」

画面が PC の基本情報（OS・メモリ・空き容量など）を自動で集めます。
**見るだけで、変更はしません。**

### 2. AI の答えをためす（その場で直せるものは直す）🤖

AI が「まずこれを試してください」と手順を返します。
許可リストにある操作なら、**提案カードからそのまま実行**できます（実行してよいかは本人の Y/N）。
やってみて、**解決した／しなかった** をボタンで選ぶだけ。

### 3. 直らなければ、人へ 🧑‍🔧

「解決しなかった」を選ぶと、DX 推進部へ自動で引き継がれます。
引き継ぎメモに、ここまでのやりとりと PC の情報が入っているので、
**同じことをもう一度説明する必要はありません。**

---

## 📚 ナレッジは「ぐるぐる」回ります

1 回の解決が、次の人の時間を短くします。

<img src="docs/assets/readme/cycle.svg" alt="相談 → 解決 → ナレッジ → 次の人へ の循環" width="560">

- 🧑‍⚖️ ナレッジは、**人が承認したものだけ** が使われます（AI が勝手に登録することはありません）
- 🙈 承認の前に、メールアドレスや電話番号などの個人情報は **自動で伏せ字** になります
- 📈 使われるほど「役に立った率」が記録され、見直しのきっかけになります

---

## 🔒 安心して使うために

| 気になること | どうなっているか |
|---|---|
| 🔍 PC の情報を勝手に見られない？ | **読み取りだけ**です。ファイルの中身・閲覧履歴・画面・キー入力・メール本文は取りません |
| 🙈 個人情報は大丈夫？ | メール・電話・IP・カード番号などを **自動で伏せ字** にしてから保存・送信します |
| 🔑 誰でも使える？ | **社内の人だけ**です。Cloudflare Access のログイン＋許可リストで判定します（許可外は全拒否） |
| 🧑‍⚖️ AI の答えが間違っていたら？ | AI の答えは **下書き** です。ナレッジとして残す前に、必ず人が承認します |
| 🖐 勝手に操作されない？ | されません。遠隔サポート（担当者）は **案内文を送るところまで**。AI のその場の修復も **本人の Y** があるときだけ動きます |
| 📤 共有は同意した分だけ？ | はい。**同意した範囲だけ** が引き継がれます（同意は情報ごと・目的ごとに分かれています） |

---

## ❓ よくある質問

<details>
<summary><b>🙋 パソコンに詳しくなくても使えますか？</b></summary>

はい。やることは「チャットに書く」と「解決した／しなかったを選ぶ」だけです。
専門用語はなるべく画面に出さないようにしています。

</details>

<details>
<summary><b>🤖 AI の答えは、どこから来ているの？</b></summary>

社内で **承認ずみのナレッジ**（9 件からスタート）と、相談者さんの PC の基本情報です。
インターネットの適当な情報をそのまま答えているわけではありません。
それでも間違うことはあるので、最後は人が確認します。

</details>

<details>
<summary><b>⏱ どれくらいで返事が来ますか？</b></summary>

AI の一次対応は、ふつう **数秒** です。
人に引き継いだ場合は、DX 推進部の受付時間内での対応になります。

</details>

<details>
<summary><b>🔐 相談した内容は、誰に見られるの？</b></summary>

自分自身と、対応する DX 推進部の担当者だけです。
「操作する人」の切り替えはデモ用の機能で、実際のログインは Cloudflare Access のみです。

</details>

<details>
<summary><b>🖥 自分の PC 以外の情報が混ざったりしませんか？</b></summary>

しません。端末ごとに情報を分けて保存しています。
いま見ている PC の情報だけが表示されます。

</details>

<details>
<summary><b>📚 ナレッジは誰が承認するの？</b></summary>

申請した人とは **別の承認者** が確認します（自分の下書きは自分で承認できません）。
承認されると、AI の答えの根拠として使われるようになります。

</details>

---

## 🚦 いまの状態（正直なところ）

| できること | 状態 |
|---|---|
| 💬 相談 → PC 情報の取得 → AI 一次対応 | ✅ 動いています |
| 🧑‍🔧 ヘルプデスクへの引き継ぎ・対応・解決記録 | ✅ 動いています |
| 📚 ナレッジ化 → 承認 → 公開 | ✅ 動いています |
| 📄 最終報告書（HTML / PDF）の出力 | ✅ 動いています |
| 🖐 本人同意つきの遠隔サポート（案内文まで） | ✅ 動いています |
| 🛠 AI がその場で直す（許可リスト + 本人 Y/N） | ✅ 動いています（実機は印刷スプーラー再起動のみ） |
| 🔍 PC の詳しい情報（導入ソフトなど） | ✅ 端末エージェントを入れた PC で取得できます |
| 🌐 別の人のアカウントへの引き継ぎ | ✅ 動いています（DX 推進部の受信箱へ） |
| 🔔 引継ぎのメール通知 | ✅ 対応（送信先 SMTP の設定が必要） |
| 🖥 画面共有・遠隔操作 | 🚧 設計のみ（実装していません） |
| 🧪 全画面の通しテスト（E2E） | 🚧 一部のみ |

> [!NOTE]
> 「動いています」は、サーバー側の動きを実際に確認した範囲です。
> 画面の全ステップを通しで自動確認するテストは、まだ一部しかありません。

---

## 🧑‍💻 エンジニア向け（たたんであります）

<details>
<summary><b>構成・起動・テスト・デプロイを見る</b></summary>

### 構成

```
Browser
  │  Cloudflare Access（OTP / 12h / 許可メールのみ）
  ▼
Cloudflare Tunnel  ai-helpdesk.mirai-dx-platform.com
  │
  ▼
Node 22 / Fastify  ai-helpdesk-api.service（127.0.0.1:18950）
  │  ├─ 既存プロトタイプ HTML を配信（boot / bridge / device-bridge / assist-bridge を注入）
  │  ├─ /api/state（prototype_states）
  │  ├─ /api/device/browser・/api/device/inventory（実 PC 情報）
  │  ├─ /api/device/agent（端末エージェント / デバイストークン）
  │  ├─ /api/ai/answer（deepseek-flash + 承認済みナレッジ + PC 情報）
  │  ├─ /api/reports/final（最終報告書: Standalone HTML / PDF）
  │  └─ /api/ai/remote-prompt（STEP5 の案内文下書き。実行はしない）
  ▼
Local PostgreSQL  ai_helpdesk_preview
```

UI は既存プロトタイプ `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html` を
**そのまま配信** し、ブリッジ JS だけで状態保存・AI・実 PC 情報を足しています。

### ローカル起動

```bash
npm install
cp .env.example .env.local      # DATABASE_URL / SESSION_SECRET / SEED_PASSWORD を設定
chmod 600 .env.local

npm run db:migrate
npm run db:seed
npm run dev:api                 # http://127.0.0.1:18950/（開発モードは認証なし）
```

### 検証

```bash
npm run typecheck   # API + worker
npm run lint
npm test            # Unit / API integration（PostgreSQL テスト DB）
npm run build
bash scripts/scan-secrets.sh
npm audit --omit=dev --audit-level=high
```

### デプロイ（Preview）

```bash
set -a; . ~/.config/ai-helpdesk/api.conf; set +a
NODE_ENV=production npx tsx scripts/migrate.ts
npm run build
systemctl --user restart ai-helpdesk-api
```

### 端末エージェント（任意・読み取りのみ）

ブラウザ取得だけで足りない情報（導入ソフト・セキュリティ状態など）は、
端末エージェントで取得できます。Windows は **Node 不要** の PowerShell 収集タスクが使えます。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-collector-task.ps1 `
  -ConfigPath "$env:USERPROFILE\.config\ai-helpdesk\device-agent-windows.json"
```

- 収集: OS / CPU / メモリ / ディスク / GPU / ネットワーク / プリンター / 音声 / USB / 導入ソフト / セキュリティ状態
- 非収集: **ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文**
- 詳細: [docs/08-deployment.md](docs/08-deployment.md) §0-1 / [docs/09-operations.md](docs/09-operations.md) §6-1

### ドキュメント

- [初動 Assessment](docs/00-assessment.md) / [MVP Scope](docs/01-mvp-scope.md) / [Plan](docs/02-plan.md)
- [Database](docs/04-database.md) / [API](docs/05-api.md) / [Test](docs/06-test.md)
- [Security](docs/07-security.md) / [Deployment](docs/08-deployment.md) / [Operations](docs/09-operations.md)
- [受入照合](docs/11-acceptance.md) / [Round Log](docs/12-round-log.md) / [Blocker 報告](docs/13-blocked-report.md)
- [既存 UI の適用](docs/14-prototype-ui-integration.md) / [AI 修復フロー](docs/16-ai-repair-flow.md) / [端末コマンド実行](docs/19-device-command-execution.md) / [社員名簿](docs/20-employee-directory.md)
- [最終報告書](docs/21-final-report-export.md) / [STEP5 引継ぎと遠隔支援](docs/22-remote-assist-handover.md) / [RSP / MeshCentral 連携設計](docs/23-rsp-meshcentral-integration.md)
- [本人同意付きフォルダ一覧](docs/62-consented-folder-access.md)

### 既知の制約

- UI の全 STEP E2E（ウィザード全 STEP・ヘルプデスク・ナレッジ承認）は未実施です。
- 修復の実行前検証（本人の Y・Lv4 の管理者承認）は**画面側の状態**で行っています。サーバー側で承認を検証する仕組みは未実装です（実機実行は現状 `SPOOLER_RESTART` のみ、他はプロトタイプ内の模擬実行）。
- 端末エージェントは 1 ユーザー 1 端末（source 単位）の MVP です。複数端末の同時管理は未対応です。
- 引継ぎはサーバーに保存され、別アカウントへ届きます。メール通知は実装済みですが、送信には SMTP（または sendmail）の設定と再起動が必要です（[docs/22](docs/22-remote-assist-handover.md) §9-6）。
- 遠隔支援（案内文の送信）は同じログイン内のデモです。画面共有（MeshCentral 等）は未実装です。
- 最終報告書は画面の状態から生成します。サーバー側の案件台帳との突合・電子署名は未実装です（[docs/21](docs/21-final-report-export.md) §7-1）。
- 添付実体・端末修復実行・外部ヘルプデスク基盤連携・SSO は対象外です。
- 本人同意付きフォルダ一覧（[docs/62](docs/62-consented-folder-access.md)）は開発中で、既定で無効です（`FOLDER_ACCESS_ENABLED=false`。全 API が 404、画面の導線も出ません）。読み取り専用で、選んだフォルダ直下の名前と属性だけを扱います。Mirai-Info の貸与情報 API が `generatedAt` を返すまでは、検証環境の `FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true` でしか先へ進めません（本番では起動を拒否します）。
- 共通支援セッションと AI 操作ループ（[docs/63](docs/63-assist-session.md)）は開発中で、既定で無効です（`ASSIST_SESSION_ENABLED=false`。全 API が 404、画面の導線も出ません）。実行器は本人権限ヘルパーだけで、`device_commands` / RSP へ配送しません。追加の Skill は人の承認（`scripts/skills/approved.json`）があるまで提案されません。
- アクセス制御の正本は [docs/MailAddress.txt](docs/MailAddress.txt)。空・不存在の場合は **全拒否**（fail-closed）です。
  Cloudflare Access の allow ポリシーと同じ内容に保ち、変更時は両方を更新して API を再起動してください。

</details>

---

## 📄 ライセンス

未設定（個人利用の試作）。

---

<div align="center">
<sub>最終更新: 2026-10-24 ／ この README は「はじめて見る人」向けに書き直しました。技術的な正本は <a href="docs/">docs/</a> にあります。</sub>
</div>
