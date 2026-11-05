#!/usr/bin/env bash
# AI HelpDesk Staging: 死活と「release 束縛」を確認する（読み取りのみ）。
#
# health が 200 で ok=true / db=ok でも、commit が空なら「どの release が動いているか」は
# 分からない。本スクリプトは health の commit を current release の dist-manifest.json が
# 主張する commit と突き合わせ、一致しない場合は異常として exit 1 する。
#
# 出力は $STG_ROOT/state/healthcheck.log（0600）。秘密は扱わない。
set -euo pipefail
umask 077

STG_ROOT=${AIHD_STG_ROOT:-$HOME/ai-helpdesk-stg}
URL=${AIHD_STG_HEALTH_URL:-http://127.0.0.1:18952/api/health}
STATE_DIR=${AIHD_STG_STATE_DIR:-$STG_ROOT/state}
MANIFEST=${AIHD_STG_MANIFEST:-$STG_ROOT/current/dist-manifest.json}
LOG="$STATE_DIR/healthcheck.log"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

record() {
  printf '%s %s\n' "$(date -Is)" "$1" >> "$LOG"
  chmod 600 "$LOG" 2>/dev/null || true
}

# --noproxy: このホストには HTTP(S)_PROXY が設定されている場合があり、
# loopback への確認が proxy 経由になって誤判定するのを避ける。
body=$(curl -fsS -m 5 --noproxy '*' "$URL" 2>/dev/null) || {
  record "FAIL reason=request_failed url=$URL"
  printf 'healthcheck failed: request failed (%s)\n' "$URL" >&2
  exit 1
}

RESULT=$(printf '%s' "$body" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { console.log("FAIL reason=invalid_json"); return; }
  const commit = typeof parsed.commit === "string" ? parsed.commit : "";
  const okCommit = /^[0-9a-f]{40}$/.test(commit);
  const ok = parsed.ok === true && parsed.db === "ok" && okCommit;
  console.log(`${ok ? "OK" : "FAIL"} ok=${parsed.ok === true} db=${parsed.db} env=${parsed.env} commit=${commit || "(empty)"}`);
});
')

EXPECTED=$(node -e '
const fs = require("node:fs");
try {
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const commit = typeof manifest.commit === "string" ? manifest.commit : "";
  process.stdout.write(/^[0-9a-f]{40}$/.test(commit) ? commit : "");
} catch { process.stdout.write(""); }
' "$MANIFEST")

ACTUAL=$(printf '%s' "$RESULT" | sed -n 's/.*commit=\([0-9a-f]\{40\}\).*/\1/p')

if printf '%s' "$RESULT" | grep -q '^FAIL'; then
  record "$RESULT expected=${EXPECTED:-(unavailable)}"
  printf 'healthcheck failed: %s\n' "$RESULT" >&2
  exit 1
fi

if [ -z "$EXPECTED" ]; then
  record "FAIL reason=manifest_commit_missing manifest=$MANIFEST actual=${ACTUAL:-(empty)}"
  printf 'healthcheck failed: cannot read manifest commit\n' >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  record "FAIL reason=release_binding_mismatch actual=${ACTUAL:-(empty)} expected=$EXPECTED"
  printf 'healthcheck failed: release binding mismatch (actual=%s expected=%s)\n' \
    "${ACTUAL:-(empty)}" "$EXPECTED" >&2
  exit 1
fi

record "OK ok=true db=ok env=production commit=$ACTUAL release_bound=1"
printf 'healthcheck ok: commit=%s\n' "$ACTUAL"
