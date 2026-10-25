#!/usr/bin/env bash
# AI HelpDesk の DB 日次バックアップ。
# - 認証情報は ~/.config/ai-helpdesk/api.conf（0600）から読み、出力には出さない。
# - PG16 の pg_dump を使う（PG17 の dump は PG16 サーバーで transaction_timeout 警告になる）。
# - 取得後に pg_restore --list で読めることを確認し、保持期間を超えた dump だけを削除する。
# - 既存 DB への復元は行わない（復元は docs/09-operations.md §4 の手順で新規 DB に対して行う）。
set -euo pipefail

ENV_FILE="${AIHD_ENV_FILE:-$HOME/.config/ai-helpdesk/api.conf}"
if [ ! -r "$ENV_FILE" ]; then
  echo "env file is not readable: $ENV_FILE" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required in $ENV_FILE" >&2
  exit 2
fi

BACKUP_DIR="${AIHD_BACKUP_DIR:-$HOME/backups/ai-helpdesk}"
KEEP_DAYS="${AIHD_BACKUP_KEEP_DAYS:-14}"
PG_BIN="${AIHD_PG_BIN:-/usr/lib/postgresql/16/bin}"
if [ -x "$PG_BIN/pg_dump" ]; then
  PG_DUMP="$PG_BIN/pg_dump"
  PG_RESTORE="$PG_BIN/pg_restore"
else
  PG_DUMP="$(command -v pg_dump)"
  PG_RESTORE="$(command -v pg_restore)"
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}-${TS}.dump"

"$PG_DUMP" --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL"
"$PG_RESTORE" --list "$OUT" >/dev/null
SIZE="$(stat -c %s "$OUT")"
# 保持期間を超えた dump だけを削除する（他ファイルには触れない）。
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump" -mtime +"$KEEP_DAYS" -delete
printf '%s OK db=%s file=%s bytes=%s keep=%sd\n' \
  "$(date -Is)" "$DB_NAME" "$(basename "$OUT")" "$SIZE" "$KEEP_DAYS" >> "$BACKUP_DIR/backup.log"
echo "backup ok: $OUT (${SIZE} bytes, keep ${KEEP_DAYS} days)"
