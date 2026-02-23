#!/usr/bin/env bash
# Run a command in the background with optional watchdog timeout.
# Usage:
#   bash scripts/run-bg.sh [--replace] [--port <port>] -- '<command to run>' [timeout_seconds]
# Notes:
# - Always backgrounds the command using nohup and &
# - If timeout_seconds > 0, a watchdog will terminate the process after the timeout
# - Only manages processes via pid file with command validation; refuses to kill unknown listeners

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [--replace] [--port <port>] -- '<command>' [timeout_seconds]" >&2
  exit 2
fi

REPLACE=0
TARGET_PORT=""
PRESTART_TRUSTED_LISTENERS=""

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

is_routecodex_server_command() {
  local normalized
  normalized=$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')
  if [[ "$normalized" == *"dist/index.js"* ]]; then
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
    echo "[run-bg] WARNING: refusing to stop non-RouteCodex PID $pid" >&2
    return 1
  fi

  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    if is_routecodex_process "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    else
      echo "[run-bg] WARNING: PID $pid changed owner before force kill, skip" >&2
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
    echo "[run-bg] WARNING: PID $pid from pid file is not a RouteCodex process, refusing to kill" >&2
    rm -f "$pid_file"
    return 1
  fi
  
  echo "[run-bg] stopping managed server PID $pid on port $port" >&2
  stop_routecodex_pid "$pid" || true
  
  rm -f "$pid_file"
}

capture_prestart_trusted_listeners() {
  local listener_pids="$1"
  PRESTART_TRUSTED_LISTENERS=""
  if [[ -z "${listener_pids:-}" ]]; then
    return 0
  fi
  while read -r lp; do
    [[ -z "${lp:-}" ]] && continue
    if is_routecodex_process "$lp"; then
      PRESTART_TRUSTED_LISTENERS="${PRESTART_TRUSTED_LISTENERS}${PRESTART_TRUSTED_LISTENERS:+ }$lp"
    fi
  done <<< "$listener_pids"
}

wait_routecodex_server_ready() {
  local port="$1"
  local pid="$2"
  local excluded_pids="${3:-}"
  local attempts=20
  while [[ "$attempts" -gt 0 ]]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    local listener_pids
    listener_pids=$(list_listener_pids_by_port "$port")
    if [[ -n "${listener_pids:-}" ]]; then
      while read -r lp; do
        [[ -z "${lp:-}" ]] && continue
        if [[ "$lp" == "$pid" ]]; then
          return 0
        fi
        if is_routecodex_process "$lp"; then
          case " ${excluded_pids} " in
            *" ${lp} "*) ;;
            *) return 0 ;;
          esac
        fi
      done <<< "$listener_pids"
    fi
    sleep 0.2
    attempts=$((attempts - 1))
  done
  return 1
}

ensure_singleton() {
  local port
  port=$(detect_port)
  local pid_file="$HOME/.routecodex/server-${port}.pid"
  local listener_pids
  listener_pids=$(list_listener_pids_by_port "$port")
  capture_prestart_trusted_listeners "$listener_pids"

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
      echo "[run-bg] port $port is occupied by non-RouteCodex listener(s): ${foreign_pids}. Refusing to stop listener." >&2
      exit 9
    fi

    if [[ "$REPLACE" -ne 1 ]]; then
      if is_routecodex_server_command "${CMD_STR}"; then
        echo "[run-bg] RouteCodex server already listening on port $port (PID(s): ${trusted_pids:-unknown}); auto-replacing trusted server listener." >&2
        REPLACE=1
      else
        echo "[run-bg] RouteCodex server already listening on port $port (PID(s): ${trusted_pids:-unknown}). Use --replace to replace it." >&2
        exit 9
      fi
    fi

    if [[ -f "$pid_file" ]]; then
      stop_managed_server "$port" || true
    else
      echo "[run-bg] replacing trusted RouteCodex listener(s) on port $port (PID(s): ${trusted_pids})" >&2
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
          echo "[run-bg] replacing managed server PID $pid on port $port" >&2
          stop_managed_server "$port"
        else
          echo "[run-bg] managed server already running on port $port (PID $pid). Use --replace to stop it." >&2
          exit 9
        fi
      else
        echo "[run-bg] WARNING: PID $pid from pid file is not a RouteCodex process, cleaning stale pid file" >&2
        rm -f "$pid_file"
      fi
    else
      rm -f "$pid_file"
    fi
  fi
}

ensure_singleton

ts=$(date +%s)
log_file="/tmp/routecodex-bg-${ts}.log"
port=$(detect_port)

echo "[run-bg] starting: ${CMD_STR} (log: ${log_file})" >&2
nohup bash -lc "${CMD_STR}" >"${log_file}" 2>&1 &
pid=$!
echo "[run-bg] started pid=${pid}" >&2

if is_routecodex_server_command "${CMD_STR}"; then
  if ! wait_routecodex_server_ready "$port" "$pid" "${PRESTART_TRUSTED_LISTENERS:-}"; then
    echo "[run-bg] ERROR: RouteCodex server failed to become ready on port ${port} (pid=${pid})." >&2
    if [[ -f "$log_file" ]]; then
      echo "[run-bg] recent log tail:" >&2
      tail -n 40 "$log_file" >&2 || true
    fi
    exit 1
  fi
fi

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
