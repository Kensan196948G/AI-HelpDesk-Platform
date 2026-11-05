#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----|CLOUDFLARE_API_TOKEN=[A-Za-z0-9_-]{20,})'

scan_status=0
grep -RInE "$PATTERN" \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=coverage \
  --exclude='scan-secrets.sh' \
  --exclude='*.map' \
  . >/dev/null 2>&1 || scan_status=$?

case "$scan_status" in
  0)
    echo "ERROR: potential secret patterns found." >&2
    exit 1
    ;;
  1)
    echo "No obvious secret patterns found."
    ;;
  *)
    echo "ERROR: secret scan could not be completed." >&2
    exit 2
    ;;
esac
