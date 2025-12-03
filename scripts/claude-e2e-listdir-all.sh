#!/usr/bin/env bash
# E2E: Iterate providers, set anthropic routing to each, and run Claude CLI listdir prompt.
# Usage:
#   bash scripts/claude-e2e-listdir-all.sh

set -euo pipefail

CONF="${ROUTECODEX_CONFIG_PATH:-${ROUTECODEX_CONFIG:-$HOME/.routecodex/config.json}}"
CONF="${CONF/#\~\//$HOME/}"
export CONF
if [ ! -f "$CONF" ]; then
  echo "Config not found: $CONF" >&2
  exit 2
fi

PROMPT="列出本地文件目录（只输出名称列表）"

# Helper: update anthropic routing to a single target and save
set_routing() {
  node - <<'NODE'
const fs=require('fs'); const p=process.env.CONF;
const j=JSON.parse(fs.readFileSync(p,'utf8'));
if(!j.virtualrouter) j.virtualrouter={};
if(!j.virtualrouter.routing) j.virtualrouter.routing={};
j.virtualrouter.routing.anthropic=[`${process.env.P}:${process.env.M}.${process.env.K}`.replace(':','.')];
fs.writeFileSync(p, JSON.stringify(j,null,2));
console.log('anthropic routing ->', j.virtualrouter.routing.anthropic[0]);
NODE
}

# Helper: start server and wait ready
start_ready() {
  node scripts/start-verify.mjs --mode bg --timeout 120 || true
}

# Force Claude env for local proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:5520"
export ANTHROPIC_API_KEY="rcc-proxy-key"
unset ANTHROPIC_TOKEN ANTHROPIC_AUTH_TOKEN || true

echo "=== Providers from source config ==="
node - <<'NODE'
const fs=require('fs'); const p=process.env.CONF;
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const prov=Object.keys(j?.virtualrouter?.providers||{});
console.log(prov.join('\n'));
NODE

echo "=== Begin E2E (Claude CLI) ==="
node - <<'NODE'
const fs=require('fs'); const p=process.env.CONF;
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const prov=j?.virtualrouter?.providers||{};
for(const pid of Object.keys(prov)){
  const models=Object.keys((prov[pid]?.models)||{});
  if(models.length===0) continue;
  console.log(`[E2E] ${pid} -> ${models[0]}`);
}
NODE

# Iterate providers with first model
SRC_LIST="$CONF"
while IFS= read -r pid; do
  [ -z "$pid" ] && continue
  model=$(jq -r --arg P "$pid" '.virtualrouter.providers[$P].models | keys[0] // empty' "$CONF")
  [ -z "$model" ] && continue
  echo "\n-- Testing $pid model=$model"
  P="$pid" M="$model" K="key1" CONF="$CONF" set_routing >/dev/null
  start_ready >/dev/null
  echo "CLAUDE_PROMPT: $PROMPT"
  # Run Claude CLI; ignore debug EPERM and capture first lines
  (claude --print "$PROMPT" || true) | head -n 20
done < <(jq -r '.virtualrouter.providers | keys[]' "$SRC_LIST")

echo "\n=== Done ==="
