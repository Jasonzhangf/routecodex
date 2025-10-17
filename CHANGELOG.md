## 0.46.36 - 2025-10-16
- Responses API full pipeline support
  - Implemented complete /v1/responses pipeline routing with protocol conversion
  - Added llmswitch-response-chat module for automatic Responses ↔ Chat format conversion
  - Supports streaming events, tool calling, and metadata preservation
  - Enhanced ProtocolHandler to route Responses requests through 4-layer pipeline
  - Configuration support: inputProtocol: 'responses' with automatic llmswitch selection
  - Test fixtures available in tests/fixtures/ for regression coverage
  - Updated documentation with configuration examples and usage instructions

## 0.46.32 - 2025-10-16
- iFlow UA moved to compatibility; no env required
  - iFlowCompatibility injects `_headers` with iFlow CLI UA及相关头
  - IFlowProvider merges `_headers` into HTTP request headers
  - OAuth path now hard-codes UA to `iflow-cli/2.0` (no env)
  - Keeps `https://apis.iflow.cn/v1` default and host heuristics

## 0.46.31 - 2025-10-16
- iFlow Provider: align with iFlow CLI (fixed UA)
  - Default base URL `https://apis.iflow.cn/v1` (CLI-preferred)
  - Heuristics: `iflow.cn` → `/api/openai/v1`, `api.iflow.cn` → `/v1`, preserve `apis.iflow.cn`
  - Use iFlow CLI User-Agent for API and OAuth
  - Add Accept + X-Requested-With + Origin/Referer headers to avoid HTML gateways
  - Keep Bearer apiKey preference from OAuth user info

## 0.46.30 - 2025-10-15
- QwenProvider: accept top-level type 'qwen-provider' or 'qwen' in validation to match registry keys.
- LMStudio Provider: enforce string tool_choice=required for object inputs (double guard).

## 0.46.29 - 2025-10-15
- LMStudio compatibility: auto-normalize object tool_choice to "required" to trigger tool calls.
- Local assembler: support lmstudio/qwen/glm/iflow providers in fallback pipelines (not only openai).

- LMStudio compatibility: auto-normalize object tool_choice to "required" to trigger tool calls.
- Local assembler: support lmstudio/qwen/glm/iflow providers in fallback pipelines (not only openai).

## 0.45.0 (2025-10-13)

Title: Anthropic SSE simulation fixes empty tool parameters in tool_use

Summary
- Implemented a stable, encapsulated Anthropic SSE simulation for non-stream responses and a transformer for true streaming responses. This ensures tool_use.input is incrementally delivered via input_json_delta so clients correctly reconstruct tool parameters.
- Eliminated reliance on final aggregated payloads. Router now uses a single, protocol-compliant incremental path for streaming and a simulator for non-stream responses.
- Verified that the previous issue “Invalid tool parameters / required parameter `command` is missing” was caused by missing incremental tool input delivery. The new implementation fixes this end-to-end.

Key changes
- Added `src/server/anthropic-sse-transformer.ts`: converts OpenAI streaming chunks (AsyncIterable) → Anthropic SSE events (message_start/content_block_*/message_delta/message_stop) with input_json_delta append-only semantics.
- Added `src/server/anthropic-sse-simulator.ts`: simulates Anthropic SSE from a complete Anthropic message when upstream is non-stream, splitting tool_use.input into multiple input_json_delta fragments.
- Updated `src/server/protocol-handler.ts`:
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

Title: Anthropic SSE simulation fixes empty tool parameters in tool_use

Summary
- Implemented a stable, encapsulated Anthropic SSE simulation for non-stream responses and a transformer for true streaming responses. This ensures tool_use.input is incrementally delivered via input_json_delta so clients correctly reconstruct tool parameters.
- Eliminated reliance on final aggregated payloads. Router now uses a single, protocol-compliant incremental path for streaming and a simulator for non-stream responses.
- Verified that the previous issue “Invalid tool parameters / required parameter `command` is missing” was caused by missing incremental tool input delivery. The new implementation fixes this end-to-end.

Key changes
- Added `src/server/anthropic-sse-transformer.ts`: converts OpenAI streaming chunks (AsyncIterable) → Anthropic SSE events (message_start/content_block_*/message_delta/message_stop) with input_json_delta append-only semantics.
- Added `src/server/anthropic-sse-simulator.ts`: simulates Anthropic SSE from a complete Anthropic message when upstream is non-stream, splitting tool_use.input into multiple input_json_delta fragments.
- Updated `src/server/protocol-handler.ts`:
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
## 0.46.26 (2025-10-15)

Title: Dual-endpoint sticky routing; remove provider fallbacks; Anthropic GLM verified

Summary
- llmswitch-anthropic-openai now supports sticky entry protocol for both endpoints:
  - Anthropic: `/v1/messages` → entry remembered, response mapped Anthropic
  - OpenAI: `/v1/chat/completions` → entry remembered, response mapped OpenAI
- Added Anthropic→OpenAI response converter and OpenAI inbound argument normalization.
- Removed all provider hardcoding and synthesis fallbacks from ConfigManager/PipelineAssembler. Provider type strictly follows exported configuration (no glm-http-provider inference).
- Improved `/v1/messages` pipeline selection to fallback to `default` when `anthropic` route pool is empty.
- Postbuild + global install now perform a background start with `/ready` self-check.

Verification
- With `~/.routecodex/config.json`:
  - Providers: `[ 'openai' ]`
  - Routing default: `[ 'openai.glm-4.6.key1' ]`
- Start: `rcc start --config ~/.routecodex/config.json`
- Checks:
  - `GET /ready` → `status=ready`
  - `POST /v1/messages` (Anthropic) → 200, Anthropic message payload
  - `POST /v1/chat/completions` (OpenAI) → 200, OpenAI chat.completion payload
- Log `pipeline-created` shows only `openai-provider`; no `glm-http-provider` artifacts.
## 0.46.27 (2025-10-15)

Title: Merge worktree into main; final build + runtime validation; global install readiness

Summary
- Merged chore/branch-grouping into main, adopting v0.46.26 changes.
- Bumped version to 0.46.27.
- Verified build triggers postbuild background start + /ready self-check.
- Ensured quick-install runs a runtime verification after global install.
- Reaffirmed Anthropic GLM path: `/v1/messages` returns Anthropic payload; OpenAI path: `/v1/chat/completions` returns OpenAI payload. No glm-http-provider fallback.
## 0.46.28 (2025-10-15)

Title: Merge additional worktrees; build + global install

Summary
- Merged feat/new-feature and fix/syntax-errors into main.
- Bumped version to 0.46.28.
- Verified build hooks and global install flows.
## 0.46.31 - 2025-10-16
- iFlow Provider: align with iFlow CLI
  - Default base URL `https://apis.iflow.cn/v1` (CLI-preferred)
  - Heuristics: `iflow.cn` → `/api/openai/v1`, `api.iflow.cn` → `/v1`, preserve `apis.iflow.cn`
  - Use iFlow CLI User-Agent for API and OAuth; override via env `IFLOW_USER_AGENT`
  - Add Accept + X-Requested-With + Origin/Referer headers to avoid HTML gateways
  - Keep Bearer apiKey preference from OAuth user info
## 0.46.35 - 2025-10-16
- protocol: add /v1/responses transparent passthrough + monitoring (off by default; enabled via ~/.routecodex/monitor.json)
  - monitor.transparent.wireApi: 'responses' | 'chat' (prefer responses when set)
  - monitor.transparent.modelMapping: minimal model remap (e.g., "glm-4.6" -> "gpt-5-codex")
  - monitor.transparent.extraHeaders: inject upstream headers (e.g., OpenAI-Beta)
- auth: upstream Authorization precedence
  - x-rcc-upstream-authorization > monitor.json Bearer > client Authorization
  - normalize Bearer prefix for raw tokens
- responses wire: default header OpenAI-Beta: responses-2024-12-17 on transparent /responses
- notes: no protocol conversion yet; pure passthrough + recording. Conversion will be sample-driven later.
## 1.0.0 - 2025-10-17
- Protocol adapters enforced at handlers
  - Auto-detect and convert cross-protocol payloads in handlers:
    - OpenAI endpoints (/v1/chat/completions, /v1/completions, /v1/embeddings) accept Anthropic/Responses-shaped inputs and normalize to OpenAI before validation and pipeline.
    - Anthropic endpoints (router: /v1/openai/messages, /v1/openai/responses) accept OpenAI-shaped inputs and normalize to Anthropic before validation and pipeline.
  - Stringify assistant tool_calls.function.arguments during normalization.
- Streaming bridge remains intact; pipeline chunks are forwarded with synthetic chunking for non-stream payloads.
- New smoke script covering three endpoints
  - `npm run smoke:protocol` starts the server (bg) if needed, then exercises:
    - Anthropic→OpenAI at /v1/chat/completions
    - OpenAI→Anthropic at /v1/openai/messages
    - OpenAI embeddings at /v1/embeddings
- Runtime fixes
  - Corrected adapter import paths to resolve llmswitch converter and debug logger reliably under ESM/bundler builds.
- Breaking changes
  - Major refactor of server protocol entrypoints finalized; version bumped to 1.0.0 to reflect stabilized modular router and adapter behavior.
## 0.50.0 - 2025-10-17
- Streaming tool-calling E2E added for three endpoints
  - Chat(OpenAI) `/v1/chat/completions`: Anthropic-shaped tool_use input → OpenAI tool_calls in pipeline; SSE emits chunks + [DONE].
  - Messages(Anthropic) `/v1/openai/messages`: OpenAI tool_calls input → Anthropic tool_use in pipeline; SSE emits chunks + [DONE].
  - Responses(Anthropic) `/v1/openai/responses`: OpenAI tool_calls input → Anthropic tool_use in pipeline; SSE emits chunks + [DONE].
- Forced adapters hardened (pre-validation conversion + model alignment) across handlers.
- Smoke script refined; major version bumped reflecting stable streaming + adapters.
## 0.50.1 - 2025-10-17
- Build/install iteration with patch bump.
- Responses endpoint: accept pure Responses-shaped requests (input/instructions) by normalizing to messages[] before validation.
- Re-verified protocol E2E (non-stream + stream) after install.
## 0.50.2 - 2025-10-17
- Responses endpoint: relaxed validation fallback for extended content types (message/reasoning/function_call/function_call_output) and system role, to avoid 400 when upstreams emit enriched blocks.
- Keep strict errors for unrelated validation failures.
## 0.51.0 - 2025-10-17
- Bump minor version and publishable build for global install.
- Includes recent Responses endpoint normalization and relaxed validation.
## 0.50.3 - 2025-10-17
- Patch release to align versioning (0.50.x line).
- Includes Responses stream completion event (response.completed) and input normalization fixes from recent work.
