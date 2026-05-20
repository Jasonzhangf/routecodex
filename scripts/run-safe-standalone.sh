#!/usr/bin/env bash
set -euo pipefail
PORT="${1:-5533}"
LOG="${2:-/tmp/routecodex-${PORT}.log}"

if netstat -anv -p tcp | grep "\\.${PORT} " | grep -q LISTEN; then
  echo "[safe-standalone] port ${PORT} already in use; refuse to start" >&2
  exit 9
fi

export ROUTECODEX_PROVIDER_DIR="${ROUTECODEX_PROVIDER_DIR:-/Volumes/extension/.rcc/provider}"
export ROUTECODEX_PORT="${PORT}"

nohup node dist/index.js >"${LOG}" 2>&1 &
PID=$!
echo "[safe-standalone] pid=${PID} log=${LOG}"

for i in $(seq 1 20); do
  if netstat -anv -p tcp | grep "\\.${PORT} " | grep -q LISTEN; then
    echo "[safe-standalone] listening on ${PORT}"
    exit 0
  fi
  if ! ps -p "$PID" >/dev/null 2>&1; then
    echo "[safe-standalone] process exited; log tail:" >&2
    tail -30 "${LOG}" >&2 || true
    exit 10
  fi
  sleep 0.5
done

echo "[safe-standalone] timeout waiting for port ${PORT}" >&2
exit 11
