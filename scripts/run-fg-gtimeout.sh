#!/usr/bin/env bash
# Run a command in the foreground with a hard timeout.
# Usage:
#   bash scripts/run-fg-gtimeout.sh <timeout_seconds> -- '<command>'
# Notes:
# - Uses gtimeout when available; otherwise falls back to a manual killer

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <timeout_seconds> -- '<command>'" >&2
  exit 2
fi

TIMEOUT_SEC=$1
shift
if [[ "$1" != "--" ]]; then
  echo "Second argument must be -- followed by the command string" >&2
  exit 2
fi
shift
CMD_STR=${1:-}
if [[ -z "${CMD_STR}" ]]; then
  echo "Command string is empty" >&2
  exit 2
fi

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

