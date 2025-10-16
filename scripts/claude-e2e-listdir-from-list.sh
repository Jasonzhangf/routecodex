#!/usr/bin/env bash
# E2E: Read a JSON file containing an array of config file paths, and run Claude listdir test for each.
# Usage:
#   bash scripts/claude-e2e-listdir-from-list.sh /path/to/configs.json
# Optionally override prompt via env: PROMPT="列出本地文件目录（只输出名称列表）"

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <configs.json>" >&2
  exit 2
fi

LIST_JSON="$1"
if [ ! -f "$LIST_JSON" ]; then
  echo "JSON list not found: $LIST_JSON" >&2
  exit 2
fi

PROMPT=${PROMPT:-"列出本地文件目录（只输出名称列表）"}

run_one() {
  local cfg="$1"
  echo "\n=== Testing config: $cfg ==="
  local READY
  READY=$(node scripts/start-verify.mjs --mode bg --timeout 120 --config "$cfg" || true)
  echo "$READY" | sed -n '1,1p'
  local ok=$(echo "$READY" | jq -r .ok 2>/dev/null || echo false)
  local host=$(echo "$READY" | jq -r .host 2>/dev/null || echo 127.0.0.1)
  local port=$(echo "$READY" | jq -r .port 2>/dev/null || echo 5520)
  local pid=$(echo "$READY" | jq -r .pid 2>/dev/null || echo "")
  if [ "$ok" != "true" ]; then
    echo "[WARN] Not ready for $cfg" >&2
    return 0
  fi
  export ANTHROPIC_BASE_URL="http://$host:$port"
  export ANTHROPIC_API_KEY="rcc-proxy-key"
  unset ANTHROPIC_TOKEN ANTHROPIC_AUTH_TOKEN || true
  echo "CLAUDE_PROMPT: $PROMPT"
  claude --version || true
  (claude --print "$PROMPT" || true) | head -n 40
  # Graceful shutdown
  curl -s -X POST "http://$host:$port/shutdown" >/dev/null 2>&1 || true
  if [ -n "$pid" ]; then kill -TERM "$pid" >/dev/null 2>&1 || true; fi
}

CFGS=$(jq -r '.[]' "$LIST_JSON" 2>/dev/null || true)
if [ -z "$CFGS" ]; then
  echo "No configs in list: $LIST_JSON" >&2
  exit 1
fi

echo "$CFGS" | while IFS= read -r cfg; do
  if [ -f "$cfg" ]; then
    run_one "$cfg"
  else
    echo "[WARN] config not found: $cfg" >&2
  fi
done

echo "\n=== All done ==="
