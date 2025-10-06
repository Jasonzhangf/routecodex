#!/usr/bin/env bash

set -euo pipefail

SERVER="http://localhost:5520"
AUTH_HEADER=""

if [[ -n "${LMSTUDIO_API_KEY:-}" ]]; then
  AUTH_HEADER="-H Authorization: Bearer\ ${LMSTUDIO_API_KEY}"
fi

echo "=== Verify LM Studio dual endpoints via RouteCodex (OpenAI + Anthropic) ==="
echo "Server: ${SERVER}"

echo "-- 1) OpenAI /v1/chat/completions --"
openai_req='{
  "model": "gpt-oss-20b-mlx",
  "max_tokens": 64,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Say: openai-ok" }
  ]
}'
echo "Request:"; echo "$openai_req" | jq .
openai_resp=$(curl -sS -X POST "$SERVER/v1/chat/completions" -H "Content-Type: application/json" $AUTH_HEADER -d "$openai_req")
echo "Response summary:"; echo "$openai_resp" | jq '{model, object, choices: (.choices|[.[]|{finish_reason, message:{role,content}}])}'

echo "-- 2) Anthropic /v1/messages --"
anth_req='{
  "model": "gpt-oss-20b-mlx",
  "max_tokens": 64,
  "messages": [
    { "role": "user", "content": [{"type":"text", "text": "Say: anthropic-ok"}] }
  ]
}'
echo "Request:"; echo "$anth_req" | jq .
anth_resp=$(curl -sS -X POST "$SERVER/v1/messages" -H "Content-Type: application/json" $AUTH_HEADER -d "$anth_req")
echo "Response summary:"; echo "$anth_resp" | jq '{model, role, stop_reason, content: (.content|if type=="array" then [.[0]] else . end)}'

echo "-- Checks --"
openai_ok=$(echo "$openai_resp" | jq -r '.choices[0].message.content // empty' | grep -c "openai-ok" || true)
anth_ok=$(echo "$anth_resp" | jq -r '..|objects|select(has("text")).text? // empty' | grep -c "anthropic-ok" || true)

if [[ "$openai_ok" -ge 1 ]]; then echo "✓ OpenAI endpoint responded"; else echo "✗ OpenAI endpoint content check weak"; fi
if [[ "$anth_ok" -ge 1 ]]; then echo "✓ Anthropic endpoint responded"; else echo "✗ Anthropic endpoint content check weak"; fi

echo "Done."

