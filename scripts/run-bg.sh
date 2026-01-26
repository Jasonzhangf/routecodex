#!/usr/bin/env bash
# Run a command in the background with optional watchdog timeout.
# Usage:
#   bash scripts/run-bg.sh [--replace] [--port <port>] -- '<command to run>' [timeout_seconds]
# Notes:
# - Always backgrounds the command using nohup and &
# - If timeout_seconds > 0, a watchdog will terminate the process after the timeout
# - Detects an existing RouteCodex server listener on the target port. With --replace, it will terminate
#   the existing listener (regardless of worktree/global install). Without --replace, it exits non‑zero.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [--replace] [--port <port>] -- '<command>' [timeout_seconds]" >&2
  exit 2
fi

REPLACE=0
TARGET_PORT=""

# Parse optional flags until --
while [[ $# -gt 0 ]]; do
  case "$1" in
    --replace)
      REPLACE=1; shift ;;
    --port)
      TARGET_PORT=${2:-}; shift 2 ;;
    --)
      shift; break ;;
    *)
      echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CMD_STR=${1:-}
TIMEOUT_SEC=${2:-0}

if [[ -z "${CMD_STR}" ]]; then
  echo "Command string is empty" >&2
  exit 2
fi

detect_port() {
  local p="${TARGET_PORT}"
  if [[ -n "$p" ]]; then echo "$p"; return; fi
  # Prefer env
  if [[ -n "${ROUTECODEX_PORT:-}" ]]; then echo "${ROUTECODEX_PORT}"; return; fi
  # Try user config
  local cfg="$HOME/.routecodex/config.json"
  if command -v jq >/dev/null 2>&1 && [[ -f "$cfg" ]]; then
    p=$(jq -r '.port // empty' "$cfg" 2>/dev/null || true)
    if [[ -n "$p" && "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  echo 5520
}

ensure_singleton() {
  local port=$(detect_port)
  # Check existing listener on port
  local pids
  pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    if [[ "$REPLACE" -eq 1 ]]; then
      echo "[run-bg] port $port is in use by PIDs: $pids; attempting graceful replace" >&2
      # First send TERM
      while read -r pid; do
        [[ -z "$pid" ]] && continue
        kill -TERM "$pid" 2>/dev/null || true
      done <<< "$pids"
      sleep 1
      # Force kill survivors
      pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
      if [[ -n "$pids" ]]; then
        while read -r pid; do
          [[ -z "$pid" ]] && continue
          kill -KILL "$pid" 2>/dev/null || true
        done <<< "$pids"
        sleep 1
      fi
    else
      echo "[run-bg] detected existing listener on port $port (PIDs: $pids). Use --replace to replace it." >&2
      exit 9
    fi
  fi
}

ensure_singleton

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
