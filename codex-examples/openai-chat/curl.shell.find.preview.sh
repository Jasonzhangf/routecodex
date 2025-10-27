#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://127.0.0.1:5520}
API_KEY=${API_KEY:-routecodex-local}

curl -sS -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @codex-examples/openai-chat/request.shell.find.preview.json | jq -r '.'

