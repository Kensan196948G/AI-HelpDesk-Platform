# 最終報告書 / 遠隔支援の実測証跡（2026-10-23）

このディレクトリは、[docs/21-final-report-export.md](../../../21-final-report-export.md) と
[docs/22-remote-assist-handover.md](../../../22-remote-assist-handover.md) の実装を、
ヘッドレス Chromium で実際に操作した記録です。

## ファイル

| ファイル | 内容 |
|---|---|
| `CASE-0001-ai.html` | STEP 3（AIで解決）の Standalone HTML |
| `CASE-0001-ai.pdf` | STEP 3（AIで解決）の PDF（3ページ） |
| `CASE-0002-hd.html` | STEP 5（担当者対応で解決）の Standalone HTML |
| `CASE-0002-hd.pdf` | STEP 5（担当者対応で解決）の PDF（7ページ） |
| `step7-ai-report.png` | STEP 7 の「最終報告書」カード |
| `step6-hd-report.png` | STEP 6（解決後）の「最終報告書」カード |
| `step5-remote-console.png` | STEP 5 の遠隔支援コンソール（担当者視点） |
| `verification.txt` | 実行環境・流れ・PDF テキスト・マスキング・SHA-256 の実測ログ |

## 再現方法

1. テスト DB を用意する（`NODE_ENV=test npm run db:migrate` / `npm run db:seed`）。
2. 専用の API を起動する（本番の 18950 は使わない）。

   ```bash
   NODE_ENV=test PORT=18958 HOST=127.0.0.1 DEV_AUTH_EMAIL=<test-email> \
     npx tsx apps/api/src/index.ts
   ```

3. Playwright（Chromium headless）で `http://127.0.0.1:18958/` を開き、
   `verification.txt` の「実測した流れ」を実施する。
4. ダウンロードした HTML / PDF を保存する。

## 注意

- 氏名・端末情報はすべてデモデータです。実個人情報・秘密情報は含みません。
- 報告書は画面状態から生成する MVP 実装です。サーバー側の案件台帳との突合は行っていません。
- PDF は検証環境の Google Chrome 150 / IPAゴシックで生成しています。
