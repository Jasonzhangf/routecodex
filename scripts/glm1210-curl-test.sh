#!/usr/bin/env bash
set -euo pipefail

REQ_ID="${1:-}"
if [[ -z "${REQ_ID}" ]]; then
  echo "Usage: $0 <request_id> (e.g., req_1762230957735_k1tw8zp9p)" >&2
  exit 1
fi

SNAP_DIR="$HOME/.routecodex/codex-samples/openai-chat"
RAW_FILE="$SNAP_DIR/${REQ_ID}_raw-request.json"
if [[ ! -f "$RAW_FILE" ]]; then
  echo "Raw request not found: $RAW_FILE" >&2
  exit 2
fi

CONFIG_PATH="${ROUTECODEX_CONFIG_PATH:-${ROUTECODEX_CONFIG:-$HOME/.routecodex/config.json}}"
CONFIG_PATH="${CONFIG_PATH/#\~\//$HOME/}"
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config not found: $CONFIG_PATH" >&2
  exit 3
}

BASE_URL=$(jq -r '.virtualrouter.providers.glm.baseURL' "$CONFIG_PATH")
API_KEY=$(jq -r '.virtualrouter.providers.glm.apiKey[0]' "$CONFIG_PATH")
if [[ -z "${BASE_URL}" || -z "${API_KEY}" || "${BASE_URL}" == "null" || "${API_KEY}" == "null" ]]; then
  echo "Missing baseURL or apiKey in $CONFIG_PATH" >&2
  exit 4
fi

ORIG_PAY="/tmp/${REQ_ID}_orig.json"
DROP_ASSIST_TC_PAY="/tmp/${REQ_ID}_drop_asst_tc.json"
DROP_TOOL_PAY="/tmp/${REQ_ID}_drop_tool.json"

# Extract original OpenAI Chat body
jq '.body' "$RAW_FILE" > "$ORIG_PAY"

# Build payload with last assistant(tool_calls) removed
jq '
  . as $root |
  .messages as $m |
  ([$m | length] | .[0]) as $len |
  .messages = (
    reduce range(0; $len) as $i (
      {arr: [], lastAsstWithTC: -1};
      . as $acc |
      ($m[$i]) as $x |
      (if ($x.role == "assistant" and ($x.tool_calls|type=="array") and (($x.tool_calls|length) > 0)) then $i else $acc.lastAsstWithTC end) as $mark |
      {arr: ($acc.arr + [$x]), lastAsstWithTC: $mark}
    ) | . as $t |
    ($t.lastAsstWithTC) as $idx |
    if ($idx >= 0) then
      [ range(0; $t.arr|length) | select(. != $idx) | $t.arr[.] ]
    else
      $t.arr
    end
  )
' "$ORIG_PAY" > "$DROP_ASSIST_TC_PAY"

# Build payload with last tool message removed
jq '
  . as $root |
  .messages as $m |
  ([$m | length] | .[0]) as $len |
  .messages = (
    reduce range(0; $len) as $i (
      {arr: [], lastTool: -1};
      . as $acc |
      ($m[$i]) as $x |
      (if ($x.role == "tool") then $i else $acc.lastTool end) as $mark |
      {arr: ($acc.arr + [$x]), lastTool: $mark}
    ) | . as $t |
    ($t.lastTool) as $idx |
    if ($idx >= 0) then
      [ range(0; $t.arr|length) | select(. != $idx) | $t.arr[.] ]
    else
      $t.arr
    end
  )
' "$ORIG_PAY" > "$DROP_TOOL_PAY"

echo "== Testing original payload -> GLM =="
curl -sS -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  --data @"$ORIG_PAY" \
  "${BASE_URL}/chat/completions" -w "\nHTTP_STATUS:%{http_code}\n" | tee "/tmp/${REQ_ID}_orig.out"

echo "\n== Testing drop last assistant(tool_calls) -> GLM =="
curl -sS -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  --data @"$DROP_ASSIST_TC_PAY" \
  "${BASE_URL}/chat/completions" -w "\nHTTP_STATUS:%{http_code}\n" | tee "/tmp/${REQ_ID}_drop_asst_tc.out"

echo "\n== Testing drop last tool message -> GLM =="
curl -sS -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  --data @"$DROP_TOOL_PAY" \
  "${BASE_URL}/chat/completions" -w "\nHTTP_STATUS:%{http_code}\n" | tee "/tmp/${REQ_ID}_drop_tool.out"

echo "\nOutputs saved under /tmp/${REQ_ID}_*.{json,out}"
