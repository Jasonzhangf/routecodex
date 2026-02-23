#!/usr/bin/env bash
# Run a command in the foreground with a hard timeout.
# Usage:
#   bash scripts/run-fg-gtimeout.sh <timeout_seconds> [--replace] [--port <port>] -- '<command>'
# Notes:
# - Uses gtimeout when available; otherwise falls back to a manual killer
# - Only manages processes via pid file with command validation; refuses to kill unknown listeners

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
if [[ -z "${CMD_STR:-}" ]]; then
  echo "Command string is empty" >&2
  exit 2
fi

detect_port() {
  local p="${TARGET_PORT:-}"
  if [[ -n "$p" ]]; then echo "$p"; return; fi
  if [[ -n "${ROUTECODEX_PORT:-}" ]]; then echo "${ROUTECODEX_PORT}"; return; fi
  local cfg="$HOME/.routecodex/config.json"
  if command -v jq >/dev/null 2>&1 && [[ -f "$cfg" ]]; then
    p=$(jq -r '.port // empty' "$cfg" 2>/dev/null || true)
    if [[ -n "$p" && "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  echo 5520
}

# Returns 0 when command is a trusted RouteCodex server command.
is_routecodex_process() {
  local pid="$1"
  local cmd
  cmd=$(ps -o command= -p "$pid" 2>/dev/null || echo "")
  local normalized
  normalized=$(echo "$cmd" | tr '[:upper:]' '[:lower:]')

  if [[ "$normalized" == *"routecodex/dist/index.js"* ]]; then
    return 0
  fi
  if [[ "$normalized" == *"@jsonstudio/rcc"* && "$normalized" == *"/dist/index.js"* ]]; then
    return 0
  fi
  if [[ "$normalized" == *"jsonstudio-rcc"* && "$normalized" == *"/dist/index.js"* ]]; then
    return 0
  fi
  return 1
}

list_listener_pids_by_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local raw
  raw=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -z "${raw:-}" ]]; then
    return 0
  fi
  echo "$raw" | awk 'NF>0 && !seen[$1]++ { print $1 }'
}

stop_routecodex_pid() {
  local pid="$1"
  if [[ -z "${pid:-}" ]]; then
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if ! is_routecodex_process "$pid"; then
    echo "[run-fg] WARNING: refusing to stop non-RouteCodex PID $pid" >&2
    return 1
  fi

  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    if is_routecodex_process "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    else
      echo "[run-fg] WARNING: PID $pid changed owner before force kill, skip" >&2
    fi
  fi
  return 0
}

stop_managed_server() {
  local port="$1"
  local pid_file="$HOME/.routecodex/server-${port}.pid"
  
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  
  local pid
  pid=$(cat "$pid_file" 2>/dev/null || echo "")
  
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    return 0
  fi
  
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    return 0
  fi
  
  # 验证进程归属
  if ! is_routecodex_process "$pid"; then
    echo "[run-fg] WARNING: PID $pid from pid file is not a RouteCodex process, refusing to kill" >&2
    rm -f "$pid_file"
    return 1
  fi
  
  echo "[run-fg] stopping managed server PID $pid on port $port" >&2
  stop_routecodex_pid "$pid" || true
  
  rm -f "$pid_file"
}

ensure_singleton() {
  local port
  port=$(detect_port)
  local pid_file="$HOME/.routecodex/server-${port}.pid"
  local listener_pids
  listener_pids=$(list_listener_pids_by_port "$port")

  if [[ -n "${listener_pids:-}" ]]; then
    local trusted_pids=""
    local foreign_pids=""
    while read -r lp; do
      [[ -z "${lp:-}" ]] && continue
      if is_routecodex_process "$lp"; then
        trusted_pids="${trusted_pids}${trusted_pids:+ }$lp"
      else
        foreign_pids="${foreign_pids}${foreign_pids:+ }$lp"
      fi
    done <<< "$listener_pids"

    if [[ -n "${foreign_pids:-}" ]]; then
      echo "[run-fg] port $port is occupied by non-RouteCodex listener(s): ${foreign_pids}. Refusing to stop listener." >&2
      exit 9
    fi

    if [[ "$REPLACE" -ne 1 ]]; then
      if [[ "$(echo "${CMD_STR:-}" | tr '[:upper:]' '[:lower:]')" == *"dist/index.js"* ]]; then
        echo "[run-fg] RouteCodex server already listening on port $port (PID(s): ${trusted_pids:-unknown}); auto-replacing trusted server listener." >&2
        REPLACE=1
      else
        echo "[run-fg] RouteCodex server already listening on port $port (PID(s): ${trusted_pids:-unknown}). Use --replace to replace it." >&2
        exit 9
      fi
    fi

    if [[ -f "$pid_file" ]]; then
      stop_managed_server "$port" || true
    else
      echo "[run-fg] replacing trusted RouteCodex listener(s) on port $port (PID(s): ${trusted_pids})" >&2
      while read -r tp; do
        [[ -z "${tp:-}" ]] && continue
        stop_routecodex_pid "$tp" || true
      done <<< "$trusted_pids"
    fi
  fi
  
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file" 2>/dev/null || echo "")
    
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # 验证进程归属
      if is_routecodex_process "$pid"; then
        if [[ "$REPLACE" -eq 1 ]]; then
          echo "[run-fg] replacing managed server PID $pid on port $port" >&2
          stop_managed_server "$port"
        else
          echo "[run-fg] managed server already running on port $port (PID $pid). Use --replace to stop it." >&2
          exit 9
        fi
      else
        echo "[run-fg] WARNING: PID $pid from pid file is not a RouteCodex process, cleaning stale pid file" >&2
        rm -f "$pid_file"
      fi
    else
      rm -f "$pid_file"
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
