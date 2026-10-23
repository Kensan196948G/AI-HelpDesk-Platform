#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----|CLOUDFLARE_API_TOKEN=[A-Za-z0-9_-]{20,})'

if grep -RInE "$PATTERN" \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=coverage \
  --exclude='scan-secrets.sh' \
  --exclude='*.map' \
  . ; then
  echo "ERROR: potential secret patterns found above." >&2
  exit 1
fi

echo "No obvious secret patterns found."
