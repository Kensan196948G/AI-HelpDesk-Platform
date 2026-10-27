# RSP ローカルログインパスワードのローテーション手順（人間作業）

- 対象: RSP `https://rsp.mirai-remotetools.com/` の**ローカルログイン**（`rspadmin`）
- 目的: 2026-10-27 の S5 検証で、資格情報をチャット添付で受け渡した。値はリポジトリ・証跡に残していないが、**受け渡し経路が残るためローテーションする**
- 実施者: 人間（RSP ホストの操作権限が必要）
- 所要: 5〜10 分（サービス再起動を含む）

> このアカウントは **単要素**（パスワードのみ）である。Entra のアプリ登録が完了したら
> `LOCAL_AUTH_USER` / `LOCAL_AUTH_PASSWORD_HASH` を空にして無効化することを推奨する
> （`settings.local_auth_enabled` は両方が設定されているときだけ true）。

## 1. 事前確認

```bash
cd /home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux
systemctl status rsp-api --no-pager | head -5          # active を確認
sudo grep -E '^LOCAL_AUTH_(USER|PASSWORD_HASH)=' .env | sed -E 's/(PASSWORD_HASH=).*/\1<redacted>/'
# 期待: LOCAL_AUTH_USER=rspadmin / LOCAL_AUTH_PASSWORD_HASH=scrypt$...
```

- `.env` は **0600** を維持する（`ls -l .env`）。
- 現在のパスワードが分からない場合でも、この手順で**置き換え**られる（旧値は不要）。

## 2. 新しいパスワードとハッシュを生成

```bash
cd /home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux
api/.venv/bin/python scripts/tools/make_local_password_hash.py
```

- パスワードは**12 文字以上**（スクリプトが強制）。
- 入力は画面に出ない（getpass）。**シェルの履歴・引数・ファイルに値を残さない**。
- 出力の `LOCAL_AUTH_PASSWORD_HASH=scrypt$...` を控える（この行だけをコピーする）。

## 3. 設定を差し替える

```bash
cd /home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux
cp -p .env ".env.bak-$(date +%Y%m%d-%H%M%S)"          # 0600 を維持して退避
# エディタで LOCAL_AUTH_PASSWORD_HASH= の行だけを新しい値へ置き換える
# （LOCAL_AUTH_USER は rspadmin のまま）
chmod 600 .env
```

## 4. 反映と検証

```bash
sudo systemctl restart rsp-api
sleep 3 && curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:8130/health
```

新パスワードで 200、旧パスワードで 401 を確認する（値はコマンド履歴に残さないよう、プロンプト入力か環境変数で渡す）:

```bash
read -rsp 'new password: ' NEWPW; echo
curl -s -o /dev/null -w 'new=%{http_code}\n' -X POST http://127.0.0.1:8130/auth/local-login \
  -H 'Content-Type: application/json' --data "{\"username\":\"rspadmin\",\"password\":\"$NEWPW\"}"
unset NEWPW
```

- ブラウザで `https://rsp.mirai-remotetools.com/` → ログインダイアログ → 新パスワードで入れること。
- 200 にならない場合は手順 3 の退避ファイルへ戻し、再起動して切り分ける。

## 5. 後始末

- 資格情報の保管先（個人のパスワード管理・`~/.config/...` 等）を新しい値へ更新し、**旧値を破棄**する。
- チャット・docs・PR・ログへ値を書かない（このリポジトリの規約）。
- 監査: RSP の `login_history` に `local_login` の success が 1 件増える。失敗が続く場合はロックアウトを疑い、
  直ちに退避 `.env` へ戻す。

## 6. ロールバック

```bash
cd /home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux
cp -p .env.bak-YYYYMMDD-HHMMSS .env && chmod 600 .env
sudo systemctl restart rsp-api
```
