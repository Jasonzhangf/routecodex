#!/usr/bin/env bash
# Claude CLI E2E test via RouteCodex (Anthropic endpoint)
# Usage:
#   bash scripts/claude-e2e-listdir.sh [prompt]
# Default prompt: 列出本地文件目录

set -euo pipefail

PROMPT=${1:-"列出本地文件目录"}

# 1) Ensure server is ready (background start + /ready check)
READY_JSON=$(node scripts/start-verify.mjs --mode bg --timeout 120 || true)
echo "$READY_JSON" | sed -n '1,1p' >/dev/null

# 2) Configure Claude environment (same as RCC code)
export ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-http://127.0.0.1:5520}
export ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-rcc-proxy-key}
unset ANTHROPIC_TOKEN ANTHROPIC_AUTH_TOKEN || true

echo "[Claude E2E] BASE=$ANTHROPIC_BASE_URL"
echo "[Claude E2E] PROMPT=$PROMPT"

# 3) Invoke Claude CLI
claude --version || true
claude --print "$PROMPT"

