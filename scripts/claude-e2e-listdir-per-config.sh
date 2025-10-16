#!/usr/bin/env bash
# Run Claude CLI listdir prompt per provider config file, without modifying config.json.
# Discovers configs under ~/.routecodex/config matching common provider names.

set -euo pipefail

PROMPT=${PROMPT:-"列出本地文件目录（只输出名称列表）"}
CONF_DIR="$HOME/.routecodex/config"

if [ ! -d "$CONF_DIR" ]; then
  echo "Config dir not found: $CONF_DIR" >&2
  exit 2
fi

discover_configs() {
  # Discover any files under config dir containing virtualrouter (include backups)
  rg -l '"virtualrouter"' "$CONF_DIR"/* 2>/dev/null || true
}

run_one() {
  local cfg="$1"
  echo "\n=== Testing config: $cfg ==="
  # Start server with this config
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
  # Configure Claude env and run prompt
  export ANTHROPIC_BASE_URL="http://$host:$port"
  export ANTHROPIC_API_KEY="rcc-proxy-key"
  unset ANTHROPIC_TOKEN ANTHROPIC_AUTH_TOKEN || true
  echo "CLAUDE_PROMPT: $PROMPT"
  claude --version || true
  (claude --print "$PROMPT" || true) | head -n 24
  # Stop server gracefully
  curl -s -X POST "http://$host:$port/shutdown" >/dev/null 2>&1 || true
  if [ -n "$pid" ]; then kill -TERM "$pid" >/dev/null 2>&1 || true; fi
}

# If user provided explicit config file paths as arguments, use them; else discover
if [ "$#" -gt 0 ]; then
  for cfg in "$@"; do
    if [ -f "$cfg" ]; then
      run_one "$cfg"
    else
      echo "[WARN] config not found: $cfg" >&2
    fi
  done
else
  FILES=( $(discover_configs) )
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "No provider-specific configs found under $CONF_DIR; running default ~/.routecodex/config.json"
    run_one "$HOME/.routecodex/config.json"
  else
    for f in "${FILES[@]}"; do
      run_one "$CONF_DIR/$f"
    done
  fi
fi

echo "\n=== All done ==="
