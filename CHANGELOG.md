## 0.45.0 (2025-10-13)

Title: Anthropic SSE simulation fixes empty tool parameters in tool_use

Summary
- Implemented a stable, encapsulated Anthropic SSE simulation for non-stream responses and a transformer for true streaming responses. This ensures tool_use.input is incrementally delivered via input_json_delta so clients correctly reconstruct tool parameters.
- Eliminated reliance on final aggregated payloads. Router now uses a single, protocol-compliant incremental path for streaming and a simulator for non-stream responses.
- Verified that the previous issue “Invalid tool parameters / required parameter `command` is missing” was caused by missing incremental tool input delivery. The new implementation fixes this end-to-end.

Key changes
- Added `src/server/anthropic-sse-transformer.ts`: converts OpenAI streaming chunks (AsyncIterable) → Anthropic SSE events (message_start/content_block_*/message_delta/message_stop) with input_json_delta append-only semantics.
- Added `src/server/anthropic-sse-simulator.ts`: simulates Anthropic SSE from a complete Anthropic message when upstream is non-stream, splitting tool_use.input into multiple input_json_delta fragments.
- Updated `src/server/openai-router.ts`:
  - If provider returns AsyncIterable: use transformer incrementally.
  - Else (non-stream): convert OpenAI → Anthropic message via llmswitch, then simulate SSE using the simulator.
  - Always send tool_use.content_block_start with `input:{}`, append-only `input_json_delta` fragments, content_block_stop, message_delta (stop_reason mapping), message_stop.
  - Optional SSE capture to `~/.routecodex/codex-samples/anth-replay/sse-events-<RID>.log` via `RCC_SSE_CAPTURE=1`.
- Kept llmswitch (llmswitch-anthropic-openai) responsible for request/response field mapping and finish_reason/usage mapping (config-driven).

How to verify (end-to-end)
1) Start the server (reads `~/.routecodex/config.json` for host/port):
   - `routecodex start`
2) Set environment for local Claude Code client:
   - `export ANTHROPIC_BASE_URL=http://127.0.0.1:5520`
   - `export ANTHROPIC_API_KEY=routecodex-local`
   - `unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_TOKEN`
   - Optional: `export RCC_SSE_CAPTURE=1` to capture SSE events
3) Send a tool-calling prompt with `stream: true` using the same client as before (e.g., `claude --print`).
4) Inspect snapshots under `~/.routecodex/codex-samples`:
   - Provider pair: `anth-replay/openai-provider-pair_*.json` (tool_calls.arguments should include `command`)
   - SSE events: `anth-replay/sse-events-<requestId>.log` should show:
     - `content_block_start` (type=tool_use, input:{})
     - multiple `content_block_delta` (type=input_json_delta, partial_json appended in order)
     - `content_block_stop`, `message_delta`, `message_stop`
   - Next-hop ingress: `pipeline-in-anth_<requestId>.json` should show `assistant.tool_use.input` containing `command`, not `{}`.

Notes
- This change does not require fallback or hardcoding specific tools. Behavior is schema/llmswitch driven.
- For upstream non-stream behavior, the Router simulates compliant SSE sequences so clients always receive incremental tool parameters.

