#!/usr/bin/env bash
#
# Start a Cloudflare quick tunnel to the local dev server AND point the Circle
# webhook subscription at it — one command, so the ephemeral tunnel URL never
# has to be copied by hand.
#
# WHY: a quick tunnel gets a NEW hostname on every restart. The webhook
# subscription stores that hostname, so after a restart the old one is dead and
# escrow events silently stop arriving. This script re-registers automatically
# (setup-webhook-subscription.mjs deletes the stale trycloudflare subscription
# first, so they never pile up).
#
# Usage:
#   bash scripts/tunnel.sh              # tunnel port 3000
#   PORT=3001 bash scripts/tunnel.sh
#   bash scripts/tunnel.sh --no-webhook # tunnel only, don't touch Circle
#
# Leave it running while you test. Ctrl+C stops the tunnel.
#
# NOTE: this is for LOCAL testing. In production the app is deployed to a stable
# HTTPS origin and the subscription points there instead — no tunnel involved.

set -euo pipefail

PORT="${PORT:-3000}"
LOG="${TUNNEL_LOG:-.secrets/tunnel.log}"
ORIGIN="http://localhost:${PORT}"
REGISTER_WEBHOOK=1

for arg in "$@"; do
  case "$arg" in
    --no-webhook) REGISTER_WEBHOOK=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

# Resolve the binary. `winget` adds its install dir to the PATH of NEW shells
# only, so a shell that was already open (or a non-login shell) will not see
# `cloudflared` even right after a successful install. Probe the usual locations
# instead of trusting PATH alone.
find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi

  local candidates=(
    "/c/Program Files (x86)/cloudflared/cloudflared.exe"
    "/c/Program Files/cloudflared/cloudflared.exe"
    "/opt/homebrew/bin/cloudflared"
    "/usr/local/bin/cloudflared"
    "/usr/bin/cloudflared"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done

  # winget package cache (path contains a version-stamped folder).
  if [ -n "${LOCALAPPDATA:-}" ] && [ -d "${LOCALAPPDATA}/Microsoft/WinGet/Packages" ]; then
    c="$(find "${LOCALAPPDATA}/Microsoft/WinGet/Packages" -iname 'cloudflared.exe' -print -quit 2>/dev/null || true)"
    if [ -n "$c" ]; then
      echo "$c"
      return 0
    fi
  fi

  return 1
}

CF_BIN="$(find_cloudflared || true)"
if [ -z "$CF_BIN" ]; then
  echo "cloudflared tidak ditemukan."
  echo "Install:  winget install --id Cloudflare.cloudflared -e"
  echo "       (atau: brew install cloudflared / apt install cloudflared)"
  echo ""
  echo "Kalau sudah terinstall tapi tetap tidak terdeteksi, jalankan langsung:"
  echo "  CLOUDFLARED=/path/ke/cloudflared bash scripts/tunnel.sh"
  exit 1
fi

# Allow an explicit override for unusual installs.
if [ -n "${CLOUDFLARED:-}" ]; then
  CF_BIN="$CLOUDFLARED"
fi

# Any HTTP status means the server is up. Do NOT use `curl -f`: it treats 4xx/5xx
# as failure, and `/api/health` deliberately returns 503 while the app is merely
# DEGRADED (no Upstash locally, indexer not run yet) — which made this warn
# "tidak merespons" on a perfectly healthy dev server. Only a transport failure
# (status 000) means nothing is listening.
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${ORIGIN}/api/health" || true)"
if [ -z "$HEALTH_CODE" ] || [ "$HEALTH_CODE" = "000" ]; then
  echo "PERINGATAN: ${ORIGIN} tidak merespons. Jalankan 'npm run dev' dulu di terminal lain."
  echo "(Lanjut saja — tunnel tetap dibuat, tapi endpoint-nya belum bisa diverifikasi.)"
elif [ "$HEALTH_CODE" != "200" ]; then
  echo "Catatan: ${ORIGIN}/api/health → HTTP ${HEALTH_CODE}."
  echo "  503 itu NORMAL di lokal (redis/indexer belum siap) — server tetap jalan."
fi

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

echo "cloudflared   : ${CF_BIN}"
echo "Menyalakan tunnel ke ${ORIGIN} ..."
"$CF_BIN" tunnel --url "$ORIGIN" --no-autoupdate >>"$LOG" 2>&1 &
TUNNEL_PID=$!

cleanup() {
  echo ""
  echo "Menghentikan tunnel (pid ${TUNNEL_PID}) ..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
  echo "Tunnel berhenti."
}
trap cleanup EXIT INT TERM

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared berhenti tak terduga. Isi log:"
    tail -20 "$LOG"
    exit 1
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Gagal membaca URL tunnel dari ${LOG}. Isi log terakhir:"
  tail -20 "$LOG"
  exit 1
fi

echo ""
echo "  Tunnel publik : ${URL}"
echo "  Webhook       : ${URL}/api/webhooks/escrow"
echo ""

# Reachability check — Circle requires the endpoint to answer with 2XX.
for _ in $(seq 1 10); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -I "${URL}/api/webhooks/escrow" || true)"
  [ "$CODE" = "200" ] && break
  sleep 2
done
echo "  HEAD /api/webhooks/escrow → ${CODE:-gagal}  (Circle butuh 200)"
echo ""

if [ "$REGISTER_WEBHOOK" = "1" ]; then
  echo "Mendaftarkan subscription Circle ke endpoint ini ..."
  node scripts/setup-webhook-subscription.mjs --create "$URL"
  echo ""
fi

echo "--------------------------------------------------------------------"
echo "Tunnel AKTIF. Biarkan terminal ini terbuka."
echo ""
echo "Uji end-to-end: lakukan satu checkout, lalu:"
echo "  docker exec -i supabase_db_slimemarket psql -U postgres -d postgres \\"
echo "    -c \"select notification_type, mapped_status, created_at from webhook_events order by created_at desc limit 5;\""
echo ""
echo "Ctrl+C untuk berhenti. URL ini akan HILANG setelah berhenti —"
echo "jalankan ulang script ini dan subscription-nya didaftarkan ulang otomatis."
echo "--------------------------------------------------------------------"

wait "$TUNNEL_PID"
