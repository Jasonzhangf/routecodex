#!/usr/bin/env bash
# Run a command in the background with optional watchdog timeout.
# Usage:
#   bash scripts/run-bg.sh -- '<command to run>' [timeout_seconds]
# Notes:
# - Always backgrounds the command using nohup and &
# - If timeout_seconds > 0, a watchdog will terminate the process after the timeout

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 -- '<command>' [timeout_seconds]" >&2
  exit 2
fi

# Extract command after --
if [[ "$1" != "--" ]]; then
  echo "First argument must be -- followed by the command string" >&2
  exit 2
fi
shift

CMD_STR=${1:-}
TIMEOUT_SEC=${2:-0}

if [[ -z "${CMD_STR}" ]]; then
  echo "Command string is empty" >&2
  exit 2
fi

cleanup_existing_servers() {
  local killed=0
  if [[ "${CMD_STR}" == *"dist/index.js"* || "${CMD_STR}" == *"routecodex"* ]]; then
    echo "[run-bg] ensuring no previous RouteCodex server is running" >&2
    pkill -f "/opt/homebrew/lib/node_modules/routecodex/dist/index.js" 2>/dev/null && killed=1 || true
    pkill -f "$(pwd)/dist/index.js" 2>/dev/null && killed=1 || true
    pkill -f "routecodex/dist/index.js" 2>/dev/null && killed=1 || true
    if [[ "${killed}" -eq 1 ]]; then
      sleep 1
    fi
  fi
}

cleanup_existing_servers

ts=$(date +%s)
log_file="/tmp/routecodex-bg-${ts}.log"

echo "[run-bg] starting: ${CMD_STR} (log: ${log_file})" >&2
nohup bash -lc "${CMD_STR}" >"${log_file}" 2>&1 &
pid=$!
echo "[run-bg] started pid=${pid}" >&2

if [[ "${TIMEOUT_SEC}" =~ ^[0-9]+$ && ${TIMEOUT_SEC} -gt 0 ]]; then
  (
    sleep "${TIMEOUT_SEC}" || true
    if kill -0 "${pid}" 2>/dev/null; then
      echo "[run-bg] timeout ${TIMEOUT_SEC}s reached. Sending SIGTERM to ${pid}" >&2
      kill -TERM "${pid}" 2>/dev/null || true
      sleep 1
      if kill -0 "${pid}" 2>/dev/null; then
        echo "[run-bg] process still alive. Sending SIGKILL to ${pid}" >&2
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    fi
  ) & disown || true
  echo "[run-bg] watchdog armed: ${TIMEOUT_SEC}s" >&2
fi

echo "pid=${pid} log=${log_file}"
