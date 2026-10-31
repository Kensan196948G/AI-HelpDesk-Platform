#!/usr/bin/env bash
# AI HelpDesk の DB 日次バックアップ。
# - 設定は ~/.config/ai-helpdesk/api.conf（0600）から DATABASE_URL だけを読む。
#   このファイルは systemd の EnvironmentFile 形式なので、シェルとして読み込まない
#   （値の中の `|` などがシェルに解釈され、2026-10-29 以降の失敗の原因になった）。
# - 接続情報は libpq の環境変数で渡し、プロセス引数・ログへ出さない。
# - PG16 の pg_dump を使う（PG17 の dump は PG16 サーバーで transaction_timeout 警告になる）。
# - 一時ファイルへ取得し、pg_restore --list で読めたものだけを正式名へ移す。
#   検証済みの dump を作れたときだけ、保持期間を超えた dump を削除する。
# - 既存 DB への復元は行わない（復元は docs/09-operations.md §4 の手順で新規 DB に対して行う）。
set -euo pipefail

BACKUP_DIR="${AIHD_BACKUP_DIR:-$HOME/backups/ai-helpdesk}"
LOG_FILE="$BACKUP_DIR/backup.log"
TMP_OUT=""
STAGE="init"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

on_exit() {
  local status=$?
  [ -n "$TMP_OUT" ] && rm -f -- "$TMP_OUT"
  if [ "$status" -ne 0 ]; then
    # 接続情報やエラー本文は残さず、段階と終了コードだけを記録する。
    printf '%s FAIL stage=%s exit=%s\n' "$(date -Is)" "$STAGE" "$status" >>"$LOG_FILE" || true
  fi
}
trap on_exit EXIT

STAGE="config"
ENV_FILE="${AIHD_ENV_FILE:-$HOME/.config/ai-helpdesk/api.conf}"
if [ ! -r "$ENV_FILE" ]; then
  echo "env file is not readable: $ENV_FILE" >&2
  exit 2
fi

# EnvironmentFile と同じく、同じキーは最後の行を採用する。
DATABASE_URL_RAW="$(sed -n 's/^[[:space:]]*DATABASE_URL=//p' "$ENV_FILE" | tail -n 1)"
if [ -z "$DATABASE_URL_RAW" ]; then
  echo "DATABASE_URL is required in $ENV_FILE" >&2
  exit 2
fi

# URL を libpq の環境変数へ分解する。解析結果は標準出力にだけ流し、ログへ出さない。
PARSED="$(DATABASE_URL_RAW="$DATABASE_URL_RAW" /usr/bin/python3 -I -c '
import os, re, sys
from urllib.parse import parse_qs, unquote, urlsplit
# 値をエラーへ出さないよう、失敗はすべて固定の文言で終える。
try:
    raw = os.environ["DATABASE_URL_RAW"].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"\x27":
        raw = raw[1:-1]
    u = urlsplit(raw)
    db = unquote(u.path.lstrip("/"))
    q = parse_qs(u.query)
    # 黙って無視すると接続条件が弱まるので、解釈できないパラメータは拒否する。
    ok = (
        u.scheme in ("postgres", "postgresql")
        and re.fullmatch(r"[A-Za-z0-9_-]+", db)
        and set(q) <= {"sslmode", "host", "port"}
        and all(len(v) == 1 for v in q.values())
        and "," not in (u.netloc + "".join(q.get("host", [])))
    )
    host = u.hostname or unquote((q.get("host") or [""])[0])
    port = str(u.port or "") or (q.get("port") or [""])[0]
    values = {
        "PGHOST": host,
        "PGPORT": port,
        "PGUSER": unquote(u.username or ""),
        "PGPASSWORD": unquote(u.password or ""),
        "PGDATABASE": db,
        "PGSSLMODE": (q.get("sslmode") or [""])[0],
    }
    ok = ok and not any("\n" in v or "\r" in v for v in values.values())
except Exception:
    ok = False
if not ok:
    sys.exit(1)
for key, value in values.items():
    if value:
        print(key + "=" + value)
' 2>/dev/null)" || {
  echo "DATABASE_URL could not be parsed" >&2
  exit 2
}
unset DATABASE_URL_RAW
while IFS= read -r line; do
  # shellcheck disable=SC2163 # "KEY=VALUE" をそのまま export する。
  case "${line%%=*}" in
    PGHOST | PGPORT | PGUSER | PGPASSWORD | PGDATABASE | PGSSLMODE)
      export "$line"
      ;;
    *)
      echo "unexpected parser output" >&2
      exit 2
      ;;
  esac
done <<<"$PARSED"
unset PARSED

KEEP_DAYS="${AIHD_BACKUP_KEEP_DAYS:-14}"
case "$KEEP_DAYS" in
  '' | *[!0-9]*)
    echo "AIHD_BACKUP_KEEP_DAYS must be a number" >&2
    exit 2
    ;;
esac
PG_BIN="${AIHD_PG_BIN:-/usr/lib/postgresql/16/bin}"
if [ -x "$PG_BIN/pg_dump" ] && [ -x "$PG_BIN/pg_restore" ]; then
  PG_DUMP="$PG_BIN/pg_dump"
  PG_RESTORE="$PG_BIN/pg_restore"
else
  PG_DUMP="$(command -v pg_dump)"
  PG_RESTORE="$(command -v pg_restore)"
fi

DB_NAME="$PGDATABASE"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}-${TS}.dump"
TMP_OUT="$BACKUP_DIR/.${DB_NAME}-${TS}.dump.tmp"

STAGE="dump"
"$PG_DUMP" --format=custom --no-owner --no-privileges --file="$TMP_OUT"
STAGE="verify"
"$PG_RESTORE" --list "$TMP_OUT" >/dev/null
SIZE="$(stat -c %s "$TMP_OUT")"
if [ "$SIZE" -le 0 ]; then
  echo "dump is empty" >&2
  exit 1
fi
SHA="$(sha256sum "$TMP_OUT" | cut -d' ' -f1)"

STAGE="publish"
mv -- "$TMP_OUT" "$OUT"
TMP_OUT=""

STAGE="retention"
# 保持期間を超えた dump だけを削除する（他ファイルには触れない）。
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump" -mtime +"$KEEP_DAYS" -delete
# 強制終了で残った一時ファイルも、1 日を過ぎたら消す（実行中のものを消さない）。
find "$BACKUP_DIR" -maxdepth 1 -type f -name ".${DB_NAME}-*.dump.tmp" -mtime +1 -delete

STAGE="done"
printf '%s OK db=%s file=%s bytes=%s sha256=%s keep=%sd\n' \
  "$(date -Is)" "$DB_NAME" "$(basename "$OUT")" "$SIZE" "$SHA" "$KEEP_DAYS" >>"$LOG_FILE"
echo "backup ok: $OUT (${SIZE} bytes, sha256 ${SHA}, keep ${KEEP_DAYS} days)"
