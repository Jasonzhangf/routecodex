#!/usr/bin/env bash
# Run a command in the foreground with a hard timeout.
# Usage:
#   bash scripts/run-fg-gtimeout.sh <timeout_seconds> [--replace] [--port <port>] -- '<command>'
# Notes:
# - Uses gtimeout when available; otherwise falls back to a manual killer

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <timeout_seconds> [--replace] [--port <port>] -- '<command>'" >&2
  exit 2
fi

TIMEOUT_SEC=$1
shift
REPLACE=0
TARGET_PORT=""

# Parse optional flags until --
while [[ $# -gt 0 ]]; do
  case "$1" in
    --replace) REPLACE=1; shift ;;
    --port) TARGET_PORT=${2:-}; shift 2 ;;
    --) shift; break ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CMD_STR=${1:-}
if [[ -z "${CMD_STR}" ]]; then
  echo "Command string is empty" >&2
  exit 2
fi

detect_port() {
  local p="${TARGET_PORT}"
  if [[ -n "$p" ]]; then echo "$p"; return; fi
  if [[ -n "${ROUTECODEX_PORT:-}" ]]; then echo "${ROUTECODEX_PORT}"; return; fi
  local cfg="$HOME/.routecodex/config.json"
  if command -v jq >/dev/null 2>&1 && [[ -f "$cfg" ]]; then
    p=$(jq -r '.port // empty' "$cfg" 2>/dev/null || true)
    if [[ -n "$p" && "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  echo 5520
}

ensure_singleton() {
  local port=$(detect_port)
  local pids
  pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    if [[ "$REPLACE" -eq 1 ]]; then
      echo "[run-fg] port $port is in use by PIDs: $pids; attempting graceful replace" >&2
      while read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done <<< "$pids"
      sleep 1
      pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
      if [[ -n "$pids" ]]; then while read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <<< "$pids"; fi
      sleep 1
    else
      echo "[run-fg] detected existing listener on port $port (PIDs: $pids). Use --replace to replace it." >&2
      exit 9
    fi
  fi
}

ensure_singleton

if command -v gtimeout >/dev/null 2>&1; then
  echo "[run-fg] using gtimeout ${TIMEOUT_SEC}s: ${CMD_STR}" >&2
  exec gtimeout "${TIMEOUT_SEC}s" bash -lc "${CMD_STR}"
else
  echo "[run-fg] gtimeout not found; using fallback timeout ${TIMEOUT_SEC}s: ${CMD_STR}" >&2
  bash -lc "${CMD_STR}" &
  pid=$!
  (
    sleep "${TIMEOUT_SEC}" || true
    if kill -0 "${pid}" 2>/dev/null; then
      echo "[run-fg] timeout reached. Sending SIGTERM to ${pid}" >&2
      kill -TERM "${pid}" 2>/dev/null || true
      sleep 1
      if kill -0 "${pid}" 2>/dev/null; then
        echo "[run-fg] process still alive. Sending SIGKILL to ${pid}" >&2
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    fi
  ) &
  waiter=$!
  # Wait for the process to exit or the watcher kills it
  wait "${pid}" 2>/dev/null || true
  # Cleanup watcher if still running
  if kill -0 "${waiter}" 2>/dev/null; then kill "${waiter}" 2>/dev/null || true; fi
fi
