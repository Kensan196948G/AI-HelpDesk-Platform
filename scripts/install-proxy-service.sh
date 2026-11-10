#!/usr/bin/env bash
# Tunnel と API の間に置くローカル・プロキシ（X-Proxy-Secret 付与）を systemd user に登録する。
# 事前に ~/.config/ai-helpdesk/api.conf へ PROXY_SECRET（16 文字以上）を設定しておくこと。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONF="${HOME}/.config/ai-helpdesk/api.conf"

# 設定が無いと proxy は X-Proxy-Secret を付与できず、上流は 401 を返し続ける。
if [ ! -f "$CONF" ]; then
  echo "設定ファイルがありません: $CONF" >&2
  echo "  PROXY_SECRET（16 文字以上）を $CONF に設定してから再実行してください。" >&2
  exit 1
fi
# 秘密を含むファイルの権限は 0600/0400 を推奨。危険側でも install は止めず警告に留める。
CONF_MODE="$(stat -c '%a' "$CONF" 2>/dev/null || echo unknown)"
case "$CONF_MODE" in
  600|400) ;;
  *) echo "警告: $CONF のパーミッションが $CONF_MODE です（0600 を推奨）。" >&2 ;;
esac

mkdir -p "$UNIT_DIR"
install -m 0644 "$ROOT/ops/systemd/ai-helpdesk-proxy.service" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-proxy.service
sleep 1

# 上流 unit の状態は表示だけ行う（legacy/preview 構成でも install を止めない）。
for upstream in ai-helpdesk-prod-api.service ai-helpdesk-api.service; do
  state="$(systemctl --user is-active "$upstream" 2>/dev/null || true)"
  printf '上流 unit: %s = %s\n' "$upstream" "${state:-unknown}"
done

# health が最終的な合否。失敗時は上流と PROXY_SECRET の確認手順を示して止める。
# --noproxy '*' は README / docs の確認手順と揃え、環境の proxy 設定で偶然通るのを避ける。
if ! curl -fsS --noproxy '*' -m 5 http://127.0.0.1:18949/api/health >/dev/null; then
  echo "health check に失敗しました: http://127.0.0.1:18949/api/health" >&2
  echo "  上流 API と PROXY_SECRET を確認してください。" >&2
  echo "  systemctl --user status ai-helpdesk-proxy.service ai-helpdesk-prod-api.service" >&2
  echo "  journalctl --user -u ai-helpdesk-proxy.service -n 50 --no-pager" >&2
  exit 1
fi
echo "proxy ok: http://127.0.0.1:18949 -> http://127.0.0.1:18950"
