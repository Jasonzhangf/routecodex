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
## 0.50.4 - 2025-10-17
- Patch bump: Responses SSE event sequence refined and packaged for global install.
## 0.50.5 - 2025-10-17
- Patch bump for streaming tool_call SSE improvements and local capture.
- Ready for global build/install and external streaming validation.
## 0.50.6 - 2025-10-17
- Responses SSE: response.completed now includes usage with input_tokens/output_tokens/total_tokens (mapped from prompt/completion/total when needed) to satisfy strict clients.
## 0.50.7 - 2025-10-17
- Responses SSE: add tool_call.* emission from Responses output[] (type='tool_call'), in addition to Chat tool_calls and Anthropic tool_use.
- Improves visibility when upstream triggers tools but no text is returned.
## 0.50.8 - 2025-10-17
- Two-turn tool follow-up (方案A): execute whitelisted tools (shell: ls/pwd/cat) and feed results back as tool messages, then run a second generation to produce output_text.*.
- Keeps SSE tool_call.* events from first turn; emits output_text.delta/done/completed from second turn.
## 0.50.10 - 2025-10-18
- Responses streaming: response.completed now emits usage at top level (input_tokens/output_tokens/total_tokens) per Azure/OpenAI Responses clients.
- Non-stream JSON for /v1/responses returns Responses-shaped payload; prefers second-turn result when tools are used.
- Pipeline handoff for /v1/responses preserves Anthropic blocks; llmswitch handles provider conversion.

## 0.50.9 - 2025-10-18
- Responses streaming: emit final output_text from second-turn after tool calls
  - Prefer `__initial` for tool_call.* events and `__final` for text and usage
  - Map `response.completed.usage` from final payload when available
  - Fixes: multi-turn still missing text after tools (e.g., req_1760752783623_9f1t7f2oj)
## 0.50.11 - 2025-10-18
- GLM 1214 fix: stricter preflight for GLM
  - Convert unsupported `tool` role to `user` by default (opt-out: RCC_GLM_USE_TOOL_ROLE=1)
  - Strip `assistant.tool_calls` from all messages unless RCC_GLM_KEEP_LAST_ASSISTANT_TOOLCALLS=1
  - Coerce first assistant message to user for GLM safety
  - Keeps content as string and forces non-stream; Workflow re-streams downstream
## 0.50.12 - 2025-10-18
- Responses streaming: emit server-executed tool results per spec-like events
  - response.tool_result.created/delta/completed for each executed tool
  - Non-stream JSON merges tool_result items into output and prefixes output_text
  - Keeps prior behavior: tool_call.* from first turn; output_text.* from second turn
## 0.50.13 - 2025-10-18
- Azure/OpenAI Responses SSE alignment
  - Add sequence_number to all SSE events
  - Emit output_item.added/content_part.added/output_item.done for assistant text and tool results
  - Standardize tool_call.delta to carry {arguments} object
  - Emit response.done sentinel and response.error on failures
  - Replace custom tool_result.* events with standard output items
## 0.50.14 - 2025-10-18
- Tool executor: expand whitelist and add env override
  - Default allowed: ls, pwd, cat, find, git (read-only subcommands)
  - Env: ROUTECODEX_TOOL_WHITELIST to customize
  - Safety: restrict cat/find to HOME/CWD; block shell control operators; restrict git to status/log/show/diff/rev-parse/ls-files
## 0.50.15 - 2025-10-18
- Tool executor trust mode by default
  - Remove internal whitelists and path guards; execute client-defined commands as-is
  - Add optional ROUTECODEX_TOOL_SAFE_MODE=1 to re-enable minimal operator blocking in constrained envs
## 0.50.16 - 2025-10-18
- Tools passthrough to client
  - Echo request tools/tool_choice/parallel_tool_calls in response.created (metadata)
  - Non-stream JSON includes metadata.tools/tool_choice/parallel_tool_calls
  - Default server-side tool execution remains disabled; client fully controls tools
## 0.50.17 - 2025-10-18
- Fix Responses→Chat tools conversion in llmswitch
  - Generate OpenAI Chat function tools: { type: 'function', function: { name, description, parameters } }
  - Normalize parameters (parse string JSON; fallback to permissive schema)
  - Preserve tool_choice/parallel_tool_calls unchanged
## 0.50.19 - 2025-10-18
- Add SSE contract audit + tools hash metadata
  - Write per-request SSE audit summary to sse-audit-<requestId>.log (monotonic, tool_call counts, text deltas, first_turn_only)
  - response.created metadata includes tools_hash and tools_count (and echoed tool_choice/parallel_tool_calls)
  - Non-stream JSON metadata also includes tools_hash/tools_count
## 0.50.20 - 2025-10-18
- Routine patch release: build + global install
## 0.50.25 - 2025-10-18
- Responses→Chat conversion fix compiled and enabled
  - Flatten `input_text`/`output_text` blocks and nested `message` arrays into proper OpenAI Chat `messages`.
  - Removes empty assistant stubs caused by empty `output_text` blocks.
  - Prevents premature stop/empty stream by ensuring user text is preserved in Chat payload.
- Build + background readiness check wired to `npm run start:bg` as per run policy.
- Anthropic→OpenAI request converter now flattens nested `message` blocks and de-duplicates repeated user prompts; mixed tool_use + text keeps both.
 - OpenAI→Anthropic request converter now flattens nested Chat `content` arrays that embed Responses-style `message` blocks; extracts `input_text`/`output_text` to text blocks to avoid empty inputs (fixes GLM 1214).
## 0.50.26 - 2025-10-18
- Build: version bump. Foreground start path uses `gtimeout` via `npm run start:fg` (script `scripts/run-fg-gtimeout.sh`), background uses `npm run start:bg`.
## 0.50.6
- Responses module refactor: conversion and SSE decoupled, fully config‑driven.
- Added `config/responses-conversion.json` for field mappings (non‑flat expansion of nested input blocks; response text/tool extraction).
- Responses behavior is controlled via `config/modules.json` (`responses` module) and `ROUTECODEX_RESP_*` env vars.
- Handler now captures raw request and pre‑pipeline snapshots for each requestId.
- Fixed pure‑text “early stop” by ensuring user text is synthesized from nested `input[]` message/content blocks.
## 0.52.0 - 2025-10-21
- 首次 Responses 接口工作（/v1/responses）
  - 全量对齐 OpenAI Responses 流式规范：sequence_number 自 0 起、created_at、标准事件族
  - function_call 事件完整（output_item.added → arguments.delta/done → output_item.done），字段含 id/call_id/name/status/arguments
  - message 文本事件含 content_part.added/done、output_text.delta/done，携带 item_id/output_index/content_index/logprobs
  - reasoning 事件族（reasoning_summary_part.added/done + reasoning_summary_text.delta/done），保序输出
  - completed.response 输出聚合 reasoning/message/function_call，并补齐 usage.input_tokens/output_tokens/total_tokens
  - 移除非规范事件（不再发送 response.required_action）
  - 禁止服务端工具执行，工具完全由客户端执行
  - 修复“工具优先轮次误发空消息”导致客户端重发的问题（仅在有文本时发送 message 生命周期；识别 function_call/tool_call/tool_use）
## 0.52.1 - 2025-10-21
- 增强 SSE 全链路追踪
  - 本地向客户端发送的每一条 SSE 事件均落盘：`~/.routecodex/codex-samples/anth-replay/sse-audit-<requestId>.log`
  - 写入精确的 `event:`/`data:` 行，带时间戳与 `sequence_number`（与客户端实际接收一致）
  - 发生错误或连接结束也写入 `SSE_ERROR`/`SSE_END` 标记
  - 继续支持上游透传 A/B 的原始 SSE 捕获：`~/.routecodex/codex-samples/monitor-ab/ab_*/upstream.sse`
  - 修正 completed 快照：仅在存在文本时包含 message 项；function_call 项不再带 status 字段，顺序统一为 [reasoning, (message?), function_call]
## 0.52.2 - 2025-10-21
- 版本维护：重建、打包并全局安装，配合新增的 SSE 审计用于本轮复测
## 0.52.3 - 2025-10-21
- Responses→Chat 完整映射（不清洗）：
  - input[] 全量历史保序映射为 Chat messages，保留 assistant.tool_calls 与 tool 角色消息；工具输出块映射为 role:'tool' 文本
  - tools 形态兼容：支持 Responses 顶层 name/parameters 与 Chat 嵌套 function 形态，统一输出 Chat 形态，避免空的 function 体
- GLM 预处理默认保真：
  - 不再默认 strip assistant.tool_calls；仅显式 `RCC_GLM_FORCE_TOOLCALL_STRIP=1` 时剥离
  - 允许 tool 角色（`RCC_GLM_USE_TOOL_ROLE` 非 0）
  - 默认关闭上下文截断（`RCC_GLM_DISABLE_TRIM=1`）以避免历史丢失
## 0.52.4 - 2025-10-21
- 版本维护：小版本升级，确保以修复后的构建运行（Responses.completed 中 function_call 状态规范为 completed；完整历史映射与工具形态兼容已启用）。
## 0.52.5 - 2025-10-21
- Responses SSE：当已流式输出 function_call 事件时，不再在 response.completed 中包含 function_call 条目，避免客户端将 completed 视为再次触发工具的信号；其余输出（reasoning/message/usage）保留。
## 0.52.6 - 2025-10-21
- Responses→Chat 工具序列补齐：
  - function_call 块生成的 assistant.tool_calls 记录稳定 id/call_id，并缓存 lastFunctionCallId
  - function_call_output/tool_result/tool_message 块合成为 role:'tool' 消息，带 tool_call_id（优先块内 id/call_id，否则回退 lastFunctionCallId）
  - 目的：让 provider 在下一轮能“吃到”工具结果，停止重复的 function_call 循环
## 0.52.7 - 2025-10-21
- 工具 Schema 归一化（形态级，非工具名特化）：
  - 新增 utils `tool-schema-normalizer`，将任意来源的工具定义归一化为 OpenAI Chat 形态：{ type:'function', function:{ name, description?, parameters } }
  - `llmswitch-response-chat.ts` 的 convertTools 改为使用该归一化；
  - `llmswitch-anthropic-openai.ts` 的工具映射复用该归一化，确保 Responses→Chat 与 Anthropic→OpenAI 一致。
## 0.52.8 - 2025-10-21
- Arguments 形态规范化（按工具 JSON Schema）：
  - 新增 utils `arguments-normalizer`（将 function.arguments 字符串解析→按 schema 做最小类型包裹/拆包→再 stringify）
  - 在 llmswitch 出站（buildResponsesPayload）对 function_call.arguments 做规范化；
  - 在 SSE 流（streamResponsesSSE）对 function_call_arguments.delta/done 使用规范化后的 arguments，保证客户端解析与执行成功。
## 0.52.9 - 2025-10-21
- Arguments 规范化接入 tools 归一化：
  - 在 Responses SSE 层对 arguments 正规化前，先 normalizeTools(req.tools)，再按 schema normalize arguments；
  - 在 llmswitch captureRequestContext 捕获 tools，便于出站映射时使用 schema 做 arguments 形态规范化。
## 0.52.10 - 2025-10-21
- 修复 SSE 归一化路径：更正 responses.ts 中对 `arguments-normalizer` 与 `tool-schema-normalizer` 的 require 路径，确保运行时命中归一化逻辑（之前因路径错误未生效）。
## 0.53.0 - 2025-10-23
- Responses: 第一轮流式对齐透传行为（工具调用场景）
  - 流式输出 function_call 生命周期（output_item.added → content_part.added → function_call_arguments.delta/done → output_item.done）
  - 以 response.completed 作为终止事件；SSE 不再发送 response.required_action
  - 保留 provider 回包的 model/字段，不做二次转换；转换链路无 fallback，失败显式报错
- 请求侧：Chat/Anthropic → Responses 为“无损转换”，仅补全 model/stream/instructions/input
- 修正：当 provider 已返回 Responses 形状时，跳过 Chat 逆转换，避免丢失 function_call
## 0.54.0 - 2025-10-23
- OpenAI Chat tool-calling normalization aligned with Anthropic path
  - Strict schema for assistant.tool_calls with limited, deterministic fixes:
    - `function.arguments` must be JSON string; reject otherwise
    - For `command: array<string>`: JSON-array string → parse; plain string → wrap as single token (no space-splitting)
  - Tools declaration normalized and `function.strict=true` enforced (Chat path)
  - Thinking markup sanitized in compatibility layer (`<think>…</think>`, `<tool_call>…</tool_call>`) prior to llmswitch
  - Tool result flattening fixed to avoid empty content:
    - Prefer `text` → `content` (string/array) → non-empty `output`
    - If still no text, synthesize deterministic summary from metadata (exit_code/duration)
    - Never return empty string after normalization
- Responses ↔ Chat path kept consistent; no fallback heuristics; unknown shapes return 400
- Regression: last 20 chat samples show 0 empty tool outputs after normalization
## 0.55.0 - 2025-10-24
- Chat/Anthropic LLMSwitch 真流式支持（默认开启）
  - 新增 llmswitch-core streaming 转换器：OpenAI /chat/completions SSE → Anthropic /v1/messages SSE
  - /v1/messages 流路径接入：当上游返回可读流时启用真流式转换
  - 开关：`RCC_O2A_STREAM`（默认开启，设为 `0`/`false` 关闭）；聚合窗口 `RCC_O2A_COALESCE_MS=1000` ms
  - 文本 stripThinking 仅作用于文本，不影响工具结构；finish_reason/usage 映射对齐非流式
  - 保持 Provider 只负责 IO，转换在 llmswitch/compatibility 层实现

## 0.55.1 - 2025-10-24
- Responses 真流式桥接（默认开启）
  - 新增 llmswitch-core 转换器：OpenAI Chat SSE → OpenAI Responses SSE（增量）
  - /v1/responses 流路径接入：可读流时直接桥接；否则回退为合成流
  - 开关：`RCC_R2C_STREAM`（默认开启，设为 `0`/`false` 关闭）；窗口 `RCC_R2C_COALESCE_MS=1000` ms
  - 事件对齐：response.created / output_text.delta|done / output_item.added|done / function_call_arguments.delta|done / completed / error
## 0.61.1 - 2025-10-27
- Align tool guidance with CCR approach (no router-level semantic parsing):
  - Augment `shell` tool description to instruct models to put all flags/paths/patterns into `command` argv tokens only; forbid extra keys. Applied in Chat + Responses paths.
  - Force `function.strict=true` and `parameters.additionalProperties=false` for `shell` to reduce off‑schema keys (e.g., `md`, `node_modules/*`).
  - Keep execution semantics in tool handlers (client side); server only normalizes shapes and preserves arguments.
  - Keep flattened JSON for tool outputs (no `result.raw`).
## 0.61.5 - 2025-10-27
- Tool schema hardening confirmed on both Chat and Responses entries:
  - `shell` tool enforces argv-only: parameters.command is array<string>, strict=true, additionalProperties=false.
  - Guidance appended in descriptions to prevent free-form keys.
- Provider requestId unification (req_*) and capture alignment:
  - Pipeline injects route.requestId into payload `_metadata.requestId` before provider dispatch (Chat and Responses).
  - OpenAI / Generic-OpenAI / GLM providers extract that id and use it for:
    - response.metadata.requestId and `x-request-id` headers
    - all provider capture filenames (`*_provider-request.json`, `*_provider-in.json`, `*_provider-response.json`, `*_provider-pair.json`)
  - Removed `openai-`/`glm-` fallbacks; consistent `req_...` fallback used when absent.
  - Providers strip local `metadata`/`_metadata` before sending payload upstream.
## 0.70.0 - 2025-10-27
- Chat 工具调用 Schema 全面梳理与对齐（基本完成）
  - shell 工具强制 argv-only（parameters.command: array<string> + strict + additionalProperties=false），避免自由键与类型漂移。
  - assistant.tool_calls 入参严格 JSON 字符串化；保留历史内容但不再做破坏性清洗。
  - Responses 与 Chat 路径保持一致的工具处理与输出归一（tool 输出扁平 JSON，保留必要元数据）。
- 输入与执行约束
  - OpenAI Chat 请求在 llmswitch 层进行最小必要规范化，拒绝破坏性变形；结构化回显可配置（默认开启）。
  - 统一注入 route.requestId 到 Provider（捕获与 x-request-id、一致的 req_* 命名）。
- MCP 约束（CCR 风格）
  - 注入 3 个标准 MCP 函数工具：list_mcp_resources、read_mcp_resource、list_mcp_resource_templates（严格 schema）。
  - 动态发现可用 server_label（基于历史对话中的 tool 调用与结果），作为枚举约束注入到 parameters.server；未发现时不预置，系统提示要求先读取再使用。
  - Chat 出站规范化：仅在“已知 server”前提下将 dotted-name（server.fn）规范为基础函数名并注入 arguments.server；禁止乱拼。
  - 系统提示根据“已知/未知” server 动态给出引导，避免模型在 server 未知时调用 MCP。
- GLM 兼容通过测试
  - 请求/响应映射在 Provider 兼容层显式启用；SSE 仍保持标准 OpenAI 协议实现。
  - 工具参数、用法统计、created/created_at 等字段映射稳定，流式与非流式路径一致。
## 0.70.1 - 2025-10-27
- MCP 暴露策略收紧（先读后用）：
  - 初始（无已知 server）仅注入 list_mcp_resources；不暴露 read_mcp_resource、list_mcp_resource_templates。
  - 仅当对话历史中出现有效 server_label 后，才注入其余 MCP 工具，并以枚举约束 parameters.server。
  - Chat 与 Responses SSE 路径统一：dotted-name 仅在“已知 server”前提下 canonicalize 为基础函数名并注入 arguments.server。
- 目的：避免模型在 server 未知时频繁猜测（filesystem/unknown 等）导致空转；严格落实“先读取后使用”的流程。
