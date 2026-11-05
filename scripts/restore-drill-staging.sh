#!/usr/bin/env bash
# AI HelpDesk Staging: 最新の staging dump を「使い捨て DB」へ復元し、行数を照合する。
#
# 目的は「バックアップが実際に復元できる」ことの定期確認であり、本番 DB・本番クラスタには
# 一切触れない。接続先は staging 設定ファイルの DATABASE_URL だけを使い、host/port/DB 名を
# 照合して staging 以外へは接続しない。
#
# 復元先は $EXPECTED_DB ではなく `aihd_restore_drill_<UTC14桁>` を新規作成する。
# 後処理で必ず削除する（接頭辞と形式を検証してから drop。PII の残留コピーを作らない）。
#
# 使い方:
#   bash scripts/restore-drill-staging.sh            # 最新 dump を使う
#   bash scripts/restore-drill-staging.sh <dump>     # 指定 dump を使う
set -euo pipefail
umask 077

CONF=${AIHD_STG_CONF:-$HOME/.config/ai-helpdesk/stg-api.conf}
STG_ROOT=${AIHD_STG_ROOT:-$HOME/ai-helpdesk-stg}
BACKUP_DIR=${AIHD_STG_BACKUP_DIR:-$STG_ROOT/shared/backup}
STATE_DIR=${AIHD_STG_STATE_DIR:-$STG_ROOT/state}
PG_BIN=/usr/lib/postgresql/16/bin
EXPECTED_DB=ai_helpdesk_stg
EXPECTED_PORT=5437
DRILL_RE='^aihd_restore_drill_[0-9]{14}$'

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1" >&2; }

[ -f "$CONF" ] || fail "staging config not found: $CONF"
case "$(stat -c '%a' "$CONF")" in 600|400) ;; *) fail 'staging config must be 0600/0400' ;; esac

DB_URL=$(sed -n 's/^DATABASE_URL=//p' "$CONF" | head -1)
[ -n "$DB_URL" ] || fail 'DATABASE_URL is not set in staging config'

URL_RE='^postgres(ql)?://[^@]*@([^:/]+):([0-9]+)/([^?]+).*'
HOST=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\2|")
PORT=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\3|")
DBNAME=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\4|")
[ "$HOST" = '127.0.0.1' ] || fail 'refusing non-loopback host'
[ "$PORT" = "$EXPECTED_PORT" ] || fail 'refusing unexpected port'
[ "$DBNAME" = "$EXPECTED_DB" ] || fail 'refusing unexpected database'

DUMP=${1:-}
if [ -z "$DUMP" ]; then
  DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${EXPECTED_DB}-*.dump" -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | head -1 | cut -d' ' -f2-)
fi
[ -n "$DUMP" ] || fail 'no staging dump found'
[ -f "$DUMP" ] || fail 'dump file not found'

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
LOG="$STATE_DIR/restore-drill.log"
TS=$(date -u +%Y%m%d%H%M%S)
DRILL_DB="aihd_restore_drill_${TS}"

case "$DRILL_DB" in
  aihd_restore_drill_*) ;;
  *) fail 'drill database name must keep the drill prefix' ;;
esac
printf '%s\n' "$DRILL_DB" | grep -Eq "$DRILL_RE" || fail 'drill database name format is invalid'

# 接続情報は psql/pg_restore の env へ渡す（argv・ログに出さない）。
export PGHOST=$HOST PGPORT=$PORT PGDATABASE=$DBNAME
USERINFO=$(printf '%s' "$DB_URL" | sed -E 's|^postgres(ql)?://([^@]*)@.*$|\2|')
[ -n "$USERINFO" ] && [ "$USERINFO" != "$DB_URL" ] || fail 'failed to parse credentials from DATABASE_URL'
case "$USERINFO" in
  *%*) fail 'percent-encoded credentials are not supported by this drill' ;;
  *:*) ;;
  *) fail 'DATABASE_URL must contain user:password' ;;
esac
export PGUSER=${USERINFO%%:*}
export PGPASSWORD=${USERINFO#*:}

# 既存の drills が残っていたら掃除する（前回異常終了の後始末）。
for stale in $(psql -At -d postgres -c \
  "SELECT datname FROM pg_database WHERE datname ~ '${DRILL_RE}'"); do
  note "dropping stale drill database: $stale"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$stale\" WITH (FORCE)" >&2 \
    || fail "failed to drop stale drill database"
done

ROW_COUNTS_SQL="SELECT c.relname AS table_name,
  (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), true, true, '')
  ))[1]::text::bigint AS rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1;"

count_rows() {
  local db=$1
  psql -At -F '|' -v ON_ERROR_STOP=1 -d "$db" -c "$ROW_COUNTS_SQL"
}

cleanup() {
  if psql -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$DRILL_DB'" | grep -q 1; then
    psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >&2 || true
  fi
}
trap cleanup EXIT

# 1) 復元先を作る
psql -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"$DRILL_DB\"" >&2 \
  || fail 'failed to create drill database'

# 2) 復元する
"$PG_BIN/pg_restore" --no-owner --no-privileges --exit-on-error -d "$DRILL_DB" "$DUMP" >&2 \
  || fail 'pg_restore failed'

# 3) 行数を照合する
SOURCE_COUNTS=$(count_rows "$EXPECTED_DB")
DRILL_COUNTS=$(count_rows "$DRILL_DB")

TABLES=$(printf '%s\n' "$SOURCE_COUNTS" | cut -d'|' -f1 | grep -c . || true)
[ "$TABLES" -gt 0 ] || fail 'no base tables found in source database'

if ! diff -u <(printf '%s\n' "$SOURCE_COUNTS") <(printf '%s\n' "$DRILL_COUNTS") > "$STATE_DIR/.restore-drill.diff"; then
  printf '%s FAIL tables=%s dump=%s\n' "$(date -Is)" "$TABLES" "$(basename -- "$DUMP")" >> "$LOG"
  note 'row count mismatch:'
  note "$(cat "$STATE_DIR/.restore-drill.diff")"
  fail 'row counts differ between source and restored database'
fi
rm -f -- "$STATE_DIR/.restore-drill.diff"

MIGRATIONS=$(psql -At -d "$DRILL_DB" -c 'SELECT count(*) FROM schema_migrations')
SZ=$(stat -c '%s' "$DUMP")
SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
printf '%s OK tables=%s rows_match=1 migrations=%s bytes=%s sha256=%s dump=%s\n' \
  "$(date -Is)" "$TABLES" "$MIGRATIONS" "$SZ" "$SHA" "$(basename -- "$DUMP")" >> "$LOG"
chmod 600 "$LOG"

# 後処理（trap と二重にならないよう先に落とす）
psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >&2 \
  || fail 'failed to drop drill database'
printf 'restore drill ok: tables=%s migrations=%s (dump %s)\n' "$TABLES" "$MIGRATIONS" "$(basename -- "$DUMP")"
