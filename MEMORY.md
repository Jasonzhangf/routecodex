# RouteCodex Memory

## Skills 与调试工作流

- 2026-03-10: `~/.codex/skills/pipedebug/` 已按当前 RouteCodex V2 结构更新。默认调试主线改为：先看 `~/.routecodex/codex-samples/`，先判断问题属于 request path 还是 response path，再沿 `host bridge -> llmswitch-core Hub Pipeline -> Provider V2` 的真实边界定位。旧的“4 层流水线 / workflow-compatibility-provider README / routecodex-worktree/fix / ~/.claude/skills”表述已从 `SKILL.md` 与 references 中移除。

Tags: pipedebug, skill, codex-samples, request-path, response-path, llmswitch-core, provider-v2, debug-workflow

## Web Search 相关

- 2026-03-06: Web search execution is now split by config in `virtualrouter.webSearch.engines[*]` using `executionMode` (`direct` vs `servertool`) instead of hardcoded DeepSeek checks. Direct route search backends skip canonical servertool injection; servertool-only backends still inject `web_search`.
- 2026-03-06: `websearch` and `web-search` must be normalized to canonical `web_search` before servertool handler lookup, otherwise identical search tool calls fragment across two names.
- 2026-03-06: Direct route engines can declare `directActivation`, currently used for `route`-activated native search backends such as `deepseek-web` and `builtin` for models with native search capability.
- 2026-03-06: Servertool injection now filters out direct engines, so canonical `web_search` function tools are only injected for true servertool backends.
- 2026-03-06: The previous hardcoded DeepSeek bypass in Rust request governance was removed; bypass is now driven by engine config instead of provider-key string matching.
- 2026-03-06: DeepSeek search aliases are no longer synthesized in bootstrap; provider model aliases now come from declarative `models.<name>.aliases` config.
- 2026-03-06: Volcengine Coding Plan (ark-coding-plan) models support Anthropic-compatible web search:
  - kimi-k2.5: supported with `web_search_20250305` built-in tool
  - doubao-seed-2.0-code: supported with `web_search_20250305` built-in tool
  - Endpoint: `POST https://ark.cn-beijing.volces.com/api/coding/v1/messages`
  - Required headers: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: web-search-2025-03-05`
- 2026-03-06: Mixed-tool testing succeeded for ark-coding-plan models: both `web_search_20250305` built-in and custom function tools can be used together without schema/runtime errors.
- 2026-03-07: Provider init v2 and catalog now support catalog-driven `webSearch` bindings; `routecodex provider inspect <id> --routing-hints` generates `web_search` routing plus `policyOptions.webSearch` when provider catalog exposes a web-search binding.
- 2026-03-07: `src/cli/commands/init/interactive.ts` now preserves non-core routes (for example `web_search`) when editing default/thinking/tools interactively.

Tags: web-search, direct-route, servertool, deepseek-web, websearch-alias, ark-coding-plan, kimi-k2.5, doubao-seed-2.0-code, tool-mix, provider-init, v2-config, routing-hints

## 重启与 Supervisor 相关

- 2026-03-06: Managed restart uses the currently running supervisor to respawn a fresh child from the latest on-disk build output. The first adoption of a new restart protocol still requires the old supervisor itself to be restarted once.
- 2026-03-06: `routecodex restart` targets the existing managed server; the supervised child process is respawned from the latest on-disk `dist/index.js` / CLI build artifacts.
- 2026-03-06: Added `POST /daemon/restart-process`, by existing server receiving restart request and sending `SIGUSR2` to itself after response.
- 2026-03-06: `routecodex restart` now prefers `restart-process` HTTP entry; only falls back to legacy signal in non-`ROUTECODEX_RESTART_HTTP_ONLY` mode.
- 2026-03-06: `routecodex start` non-daemon parent injects `ROUTECODEX_MANAGED_BY_START=1` to child and recognizes child `exit code 75` as "managed restart request", parent pulls new child and continues supervision.
- 2026-03-06: Server-side `restartSelf()` in `ROUTECODEX_MANAGED_BY_START=1` mode no longer spawns child itself, stops runtime and exits with `code=75` to hand restart control back to `routecodex start` parent.

Tags: restart, supervisor, restart-process, sigusr2, managed-restart

## 虚拟路由器与负载均衡相关

- 2026-03-06: Virtual Router now supports pool-scoped `routing.<route>[].loadBalancing` with per-pool `strategy`/`weights`; pool config overrides global `loadBalancing`, and weights are always recomputed from the currently available targets inside that pool, so cooldown/unhealthy removal and later recovery both immediately rebalance the pool.
- 2026-03-06: Virtual Router Rust hotpath now treats route-pool load balancing at the `provider.model` group level instead of raw runtime-key count. Equal pool weights no longer get amplified by multi-key providers, and `mode: priority` now stays inside the first available `provider.model` group before falling through to the next group.
- 2026-03-06: `sharedmodule/llmswitch-core` `engine-legacy.ts` no longer performs its own TS route selection; `route()/getStopMessageState()/getPreCommandState()/getStatus()` now delegate to the native-first `engine.ts`, and the old TS legacy route chain files `engine-legacy/{routing,route-selection,route-finalize,route-state,route-state-allowlist}.ts` were removed.
- 2026-03-06: Config now uses B shape for every routing pool: members declared by `loadBalancing.weights`, `targets` omitted, route semantics fields like `mode`, `force`, `backup`, and pool `priority` remain separate.
- 2026-03-06: Added `VirtualRouterEngine.route()` regressions covering both equal-weight grouped balancing and strict priority-group fallback.

Tags: virtual-router, rust-hotpath, load-balancing, provider-model, priority-routing, route-pool, engine-legacy, native-first, ts-removal

## 构建与全局安装相关

- 2026-03-06: `scripts/verify-install-e2e.mjs` now explicitly unsets `ROUTECODEX_BUILD_RESTART_ONLY` and `RCC_BUILD_RESTART_ONLY` when starting verification service to avoid inheriting restart-only and accidentally restarting user's managed service.
- 2026-03-06: Port detection in `verify-install-e2e.mjs` upgraded to `host + 0.0.0.0` dual check; if requested port occupied, automatically falls back to next available port and prints notice.
- 2026-03-06: `scripts/install-global.sh` in dev build restart-only scenario now calls `routecodex restart --port 5555` separately after health check completes, separating "refresh user's existing service" from "temporary install verification".
- 2026-03-06: Install-global in `ROUTECODEX_BUILD_RESTART_ONLY=1` scenario uses `ROUTECODEX_RESTART_HTTP_ONLY=1 routecodex restart --port ...`; if old service doesn't support server-managed restart, explicitly skips auto-restart instead of accidentally killing existing service.
- 2026-03-06: Sharedmodule llmswitch-core native loader must use real `import.meta.url` directly instead of `Function("return import.meta.url")` + `process.cwd()` fallback to correctly locate `rust-core/target/release/router_hotpath_napi.node` under symlinked dev installs.

Tags: build, global-install, verify-install-e2e, port-detection, restart-only, native-loader, import-meta, llmswitch-core

## 启动、预热与认证相关

- 2026-03-07: Startup path was slowed by two synchronous behaviors during `initializeProviderRuntimes()` / provider `initialize()`: Antigravity preload + warmup were awaited during server runtime init, and non-OAuth providers awaited `authProvider.validateCredentials()` during startup.
- 2026-03-07: Fixed provider auth startup path by extracting `src/providers/core/runtime/provider-startup-tasks.ts` and switching `HttpTransportProvider.onInitialize()` to schedule non-OAuth credential validation in the background via `runNonBlockingCredentialValidation(...)`.
- 2026-03-07: Fixed Antigravity startup path by extracting `src/server/runtime/http-server/antigravity-startup-tasks.ts` and making both preload and warmup fire-and-forget; startup now continues while warmup can still log and blacklist failing aliases asynchronously.
- 2026-03-07: `src/server/runtime/http-server/http-server-runtime-providers.ts` now only kicks off those tasks and continues runtime handle initialization instead of awaiting the warmup chain.
- 2026-03-07: Added focused regression coverage: `tests/providers/core/runtime/http-transport-provider.startup-nonblocking.spec.ts` and `tests/server/http-server/runtime-provider-warmup.nonblocking.spec.ts`.

Tags: startup, warmup, auth, nonblocking, antigravity, provider-init, build-verify

## Provider 初始化与 SDK 相关

- 2026-03-07: Reworked init/config generation to emit valid V2 single-source config with `virtualrouter.routingPolicyGroups.default.routing` instead of legacy `virtualrouter.routing`/`virtualrouter.webSearch`.
- 2026-03-07: Added `src/cli/config/init-v2-builder.ts` as shared builder for weighted route pools and V2 config envelopes.
- 2026-03-07: `src/cli/commands/init.ts` now creates minimal V2 config + provider directory layout on fresh no-arg init, rather than copying a V1 bundled config.
- 2026-03-07: `src/cli/config/init-config.ts` now writes sibling `provider/<id>/config.v2.json` files so helper path matches real V2 provider/config split.
- 2026-03-07: `src/cli/config/init-provider-catalog.ts` is now richer provider catalog with `sdkBinding`, `capabilities`, and catalog-driven `webSearch` bindings.
- 2026-03-07: Added Vercel AI SDK-based provider doctor entrypoint at `src/provider-sdk/vercel-ai-doctor.ts` and wired into `routecodex provider doctor <id>`.
- 2026-03-07: Added `routecodex provider inspect <id>` backed by `src/provider-sdk/provider-inspect.ts`, showing normalized config facts, catalog metadata, Vercel-AI doctor binding family, capabilities, web search binding, and suggested route targets from one place.
- 2026-03-07: Doctor currently supports direct probing for OpenAI-compatible and Anthropic-compatible providers using resolved Bearer credentials; runtime-only providers such as iFlow/DeepSeek web account/Gemini CLI are reported as unsupported for direct SDK probing.
- 2026-03-07: Added `--routing-hints` support to `routecodex provider inspect <id>`; generates weighted route pool snippets for `default`, `thinking`, `tools`, capability-driven snippets for `coding`, `longcontext`, `multimodal`, and `web_search` routing plus `policyOptions.webSearch` when provider catalog exposes web-search binding.
- 2026-03-07: `src/commands/provider-update.ts` now passes `includeRoutingHints` through inspect and prints routing hints in both JSON and human-readable modes.

Tags: provider-init, v2-config, routingPolicyGroups, vercel-ai-sdk, provider-doctor, init-command, provider-inspect, routing-hints, sdk-onboarding, weighted-routing

## Rust 迁移相关

- 2026-03-06: Refreshed BD epic `routecodex-267` based on remaining TS-only runtime modules under `sharedmodule/llmswitch-core/src/conversion/**`: compat/actions runtime transforms, codecs runtime layer, pipeline/codecs/v2 runtime layer, residual config/schema/hooks/meta runtime modules.
- 2026-03-06: Migration strategy: collapse TS files to thin wrappers around existing native entrypoints where possible, add Rust true source where needed, keep type-only files as TS wrappers when no runtime logic exists.
- 2026-03-06: Completed slices in `routecodex-267.5`:
  - `claude-thinking-tools.ts`: thin wrapper around `applyClaudeThinkingToolSchemaCompatWithNative`
  - `strip-orphan-function-calls-tag.ts`: thin wrapper around `stripOrphanFunctionCallsTagWithNative`
  - `lmstudio-responses-fc-ids.ts`: narrowed to native-backed id helper composition, collapsed to `enforceLmstudioResponsesFcToolCallIdsWithNative`
  - `response-normalize.ts`: switched to `normalizeResponsePayloadWithNative`
  - `response-validate.ts`: switched to `validateResponsePayloadWithNative`
  - `request-rules.ts`: switched to `applyRequestRulesWithNative`
  - `response-blacklist.ts`: switched to `applyResponseBlacklistWithNative`
  - `normalize-tool-call-ids.ts`: switched to `normalizeToolCallIdsWithNative`
  - `reasoning-tool-parser.ts`: collapsed to native-only wrapper with explicit assertion, preserved `<id>...</id>` when extracting tool calls from reasoning markup
  - `responses-tool-utils.ts`: moved `normalizeResponsesToolCallIds`/`resolveToolCallIdStyle`/`stripInternalToolingMetadata` onto new native wrappers
  - `tool-call-id-manager.ts`: removed remaining TS-side ID generation/preserve fallback branching, unified onto native transformer state
  - `streaming-text-extractor.ts`: moved extractor session state (`buffer`/`idCounter`/`idPrefix`) behind native state APIs
  - `responses-response-utils.ts`: moved `buildChatResponseFromResponses` core construction path to native
  - `output-content-normalizer.ts`: kept native-only implementation path with explicit module-level native availability assertion
  - `chat-output-normalizer.ts`: added explicit native-availability assertion to align with shared wrapper pattern
  - `responses-conversation-store.ts`: moved capture-time payload/input/tools preparation and resume-time tool output normalization into native
  - `responses-openai-bridge.ts`: multiple slices - normalized bridge history seed, prepared responses request envelope, local image path preprocessing, all moved to native
  - `anthropic-claude-code-system-prompt.ts`: collapsed to native thin wrapper around `runReqOutboundStage3CompatWithNative`
  - `universal-shape-filter.ts`: collapsed to native thin wrapper over new native exports `applyUniversalShapeRequestFilterWithNative` and `applyUniversalShapeResponseFilterWithNative`
  - `glm-tool-extraction.ts`: collapsed to native thin wrapper around `runRespInboundStage3CompatWithNative` for `chat:glm`
  - `anthropic-claude-code-user-id.ts`: added as native thin wrapper over new export `applyAnthropicClaudeCodeUserIdWithNative`
- 2026-03-06: Fixed `responses -> chat -> responses` exec-command tool-result roundtrip regression: in `responses` mode, `function_call` now prefers original `call_id` over item `id` when rebuilding chat `tool_calls`, and tool-role messages now serialize structured `content` back into `function_call_output.output` instead of flattening to text.
- 2026-03-06: Native loader compatibility fix: replaced direct `import.meta.url` reference with guarded runtime resolution so plain Jest CJS parsing no longer crashes on `native-router-hotpath-loader.ts`.
 rust-migration, llmswitch-core, conversion, compat-actions, lmstudio, tool-call-ids, native-wrapper, reasoning-tool-parser, responses-tool-utils, tool-call-id-manager, streaming-text-extractor, responses-response-utils, output-content-normalizer, chat-output-normalizer, responses-conversation-store, responses-openai-bridge, claude-code, universal-shape-filter, glm-tool-extraction, user-id, loader-compat, bd-task, routecodex-267.5
- 2026-03-07: Startup failure `native resolveHubProtocolAllowlistsJson is required but unavailable` was caused by `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-loader.ts` reading global `__filename` inside an ESM module. When llmswitch-core was imported from RouteCodex, `__filename` resolved to the host CJS entry (`dist/cli.js` or `[stdin]`) instead of the loader file, so native candidate probing searched the wrong repo paths. Fix: loader module URL is now sourced only from `import.meta.url`; do not use host-global `__filename`/`process.cwd()` to locate llms native bindings.

Tags: rust-migration, llmswitch-core, native-loader, import-meta-url, esm-cjs-boundary, startup-blocker, routecodex-start

Tags: rust-migration, llmswitch-core, conversion, compat-actions, lmstudio, tool-call-ids, native-wrapper, reasoning-tool-parser, responses-tool-utils, tool-call-id-manager, streaming-text-extractor, responses-response-utils, output-content-normalizer, chat-output-normalizer, responses-conversation-store, responses-openai-bridge, claude-code, universal-shape-filter, glm-tool-extraction, user-id, loader-compat, bd-task, routecodex-267.5

## Anthropic SSE 与 Responses 相关

- 2026-03-06: Anthropic SSE stream for kimi-k2.5 was truncated after valid `tool_use` block had streamed most `input_json_delta` chunks; `AnthropicSseToJsonConverter` did not salvage partial-but-usable state on `terminated`/upstream timeout errors.
- 2026-03-06: Added terminated-salvage logic in `sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts`: on `terminated`/upstream stream timeout messages, converter now calls `builder.getResult()` and returns partial Anthropic response when usable.
- 2026-03-06: Improved `anthropic-response-builder` default stop reason inference so incomplete tool-call streams default to `stop_reason: "tool_use"` instead of `end_turn` when a `tool_use` block is present.
- 2026-03-06: Previous seed usage loss was caused by Anthropic SSE builder replacing `message_start.usage` with `message_delta.usage`; after fix, usage is consumed correctly through RouteCodex 5555 chain and returned to client.
- 2026-03-06: OpenAI Responses upstream returned HTTP 400 on CRS gpt-5.4 longcontext requests with error: `Invalid 'input[565].name': string too long. Expected a string with maximum length 128, but got a string with length 316 instead.`
- 2026-03-06: Root causes: historical bridge input contained polluted `function_call.name` with long text-derived string; TS bridge side was passing JS function `sanitizeResponsesFunctionName` into `convertBridgeInputToChatMessages(...)` but native wrapper only honors string modes; chat_process fallback history was restoring `captured.input` back to raw preserved `input[]` bypassing normalized history; `normalize_responses_function_name(...)` sanitized characters but did not enforce OpenAI Responses max-name constraint.
- 2026-03-06: Fix: added hard length guard in Rust so `normalize_responses_function_name(...)` returns `None` when sanitized name exceeds 128 chars; `convert_bridge_input_to_chat_messages(...)` already skips calls whose normalized function name resolves to `None`, so polluted overlong `function_call` is now dropped from outbound history.
- 2026-03-06: GPT-5.4 reasoning findings: some provider responses contain reasoning items with only `encrypted_content` and no visible `summary_text`; RouteCodex preserves `encrypted_content` and `reasoning_tokens`, but no visible `summary_text` to show - this is upstream behavior, not a mapping bug.
- 2026-03-06: Model remap invariant: for responses outbound remap, final `model` must stay aligned with VirtualRouter hit / provider response, not with original request model; temporary patch that made snapshot `model` source-wins was reverted.
- 2026-03-06: HTTP logging update: `src/server/handlers/handler-utils.ts` now derives and prints `finish_reason` on request-complete logs; Chat payloads use `choices[0].finish_reason`; Anthropic payloads map `stop_reason` back to finish-reason equivalent; OpenAI Responses payloads derive `tool_calls` from `required_action`/function-call output and `stop` from `status=completed`.

Tags: anthropic-sse, terminated, salvage, ark-coding-plan, kimi-k2.5, tool_use, sse_decode, seed, usage, routecodex-5555, openai-responses, overlong-function-name, input-name-400, crs, gpt-5.4, reasoning, model-remap, virtual-router, logging, finish-reason, request-complete, regression-test

## Ark Coding Plan 相关

- 2026-03-06: Volcengine Coding Plan base URL rules: Anthropic-compatible tools use `https://ark.cn-beijing.volces.com/api/coding`, OpenAI-compatible tools use `https://ark.cn-beijing.volces.com/api/coding/v3`; do not use `https://ark.cn-beijing.volces.com/api/v3` because it bypasses Coding Plan quota and incurs extra cost.
- 2026-03-06: Local RouteCodex provider `ark-coding-plan` configured with: provider type `anthropic`, baseURL `https://ark.cn-beijing.volces.com/api/coding`, auth type `x-api-key`, compatibilityProfile `anthropic:claude-code`.
- 2026-03-06: Models available: doubao-seed-2.0-code, doubao-seed-2.0-pro, doubao-seed-2.0-lite, doubao-seed-code, minimax-m2.5, glm-4.7, deepseek-v3.2, kimi-k2.5.
- 2026-03-06: Context values set: Doubao/DeepSeek 256000, GLM-4.7 202752, MiniMax-M2.5 204800, Kimi-K2.5 262144.
- 2026-03-06: Real probe succeeded against `POST /api/coding/v1/messages` with `x-api-key` and `anthropic-version`.

Tags: ark-coding-plan, volcengine, anthropic, coding-plan, baseurl, provider-config, local-provider, routecodex-config

## 其他

- 2026-03-06: `apply_patch` must use workspace-relative paths only; absolute paths (leading '/' or drive letters) are rejected by sandbox and can yield Sandbox(Signal(9)) or "Failed to read file to update ... No such file or directory".
- 2026-03-06: Updated guidance in sharedmodule to explicitly require relative paths and warn absolute paths will be rejected; added apply_patch error hint for Sandbox(Signal(9)) and missing-path errors in hub_semantic_mapper_chat.rs.
- 2026-03-06: Updated `~/.codex/config.toml` so all `model_reasoning_effort` entries are `high`; last remaining non-high entry was `[model_providers.tab]` previously `medium`.

Tags: apply-patch, sandbox, relative-paths, codex, config, reasoning, high, tab-provider

## Provider 架构收敛

- 2026-03-07: Provider V2 的真实单一真源已经是 `~/.routecodex/provider/<id>/config.v2.json`；`src/config/provider-v2-loader.ts` 只按目录扫描并加载这些 provider 文件，`src/config/virtual-router-builder.ts` 负责把这些 provider 与 `config.json` 里的 routing 组装成 Virtual Router 输入。
- 2026-03-07: `config.json` 应只承载 server/global settings 与 routing policy groups；provider 定义不应再内嵌在主配置中。运行时 provider 的动态使用链路是：provider v2 file -> `buildProviderProfiles(...)` -> Virtual Router target runtime -> `applyProviderProfileOverrides(...)` -> ProviderFactory 按 protocol/moduleType 实例化。
- 2026-03-07: 对于标准 provider（如 crs、tab、kimi、GLM/Kimi/OpenAI-compatible 等），不应依赖内置 provider 实现模板；用户只需提供 `config.v2.json`，系统根据 `type/baseURL/auth/models/compatibilityProfile/transportBackend` 动态接入即可。
- 2026-03-07: 必须保留内置模板/内置辅助的只应是 OAuth/账号型 provider（如 qwen-oauth、iflow-oauth、gemini-cli-oauth、antigravity-oauth），因为这类 provider 需要 token-file lifecycle、browser launch、daemon refresh、header materialization 等宿主能力，不只是静态 HTTP 配置。
- 2026-03-07: `compatibilityProfile` 仍然是标准 provider 的必要扩展点；即使 provider 本身不内置，也允许 compat 在请求/响应阶段注入 header、参数、字段映射与协议修正。传输层只做 auth + HTTP，不做 provider-specific semantic patch。
- 2026-03-07: transport backend 也应配置驱动：`native-http` / `vercel-ai-sdk` / `openai-sdk` 由 provider config 声明，ProviderFactory/HttpTransportProvider 只按 runtime profile 选择，不再以 provider id 硬编码分支。
- 2026-03-07: Init/catalog 的目标应从“内置 provider 列表”收敛为“provider 模板与 OAuth 向导”；标准 provider 可以由 `routecodex provider add/inspect/doctor` 生成最小模板，但运行期不应要求 catalog 中存在该 provider 才能使用。

Tags: provider-architecture, provider-v2, config-driven, oauth, qwen, compat, dynamic-provider-loading, transport-backend, routing, config-json, provider-config-v2

## Provider Tooling Config-First 收敛

- 2026-03-07: Provider 运行时生效链路已经确认是配置驱动，不依赖 init catalog：`~/.routecodex/provider/<id>/config.v2.json` -> `src/config/provider-v2-loader.ts` -> `src/config/virtual-router-builder.ts` -> `src/config/routecodex-config-loader.ts` -> `applyProviderProfileOverrides()` -> `ProviderFactory`。
- 2026-03-07: `provider inspect` 与 `provider doctor` 已改为 config-first。优先从 provider 自身配置推断 `sdkBinding`、`capabilities`、`webSearch`，catalog 仅作为补充元数据，不再是标准 provider 可用性的前提。
- 2026-03-07: 新增 `src/provider-sdk/provider-runtime-inference.ts` 作为 provider tooling 的单一推断入口，避免在 inspect/doctor 中重复散落 provider 类型、auth 类型、webSearch 规则。
- 2026-03-07: 标准 provider（如 `openai` / `responses` / `anthropic` 协议）现在可以只靠配置工作于 inspect/doctor；只有 OAuth / account / 非标准运行时 provider（如 `qwen-oauth`、`iflow-oauth`、`gemini-cli-oauth`、`antigravity-oauth`、`deepseek-account`）仍需要宿主 runtime 能力。
- 2026-03-07: `transportBackend` 继续保持纯配置驱动，当前允许：`native-http`、`vercel-ai-sdk`、`openai-sdk`。不要把 transport 选择重新做成 provider 名称硬编码。

Tags: provider-tooling, config-first, config-driven, provider-inspect, provider-doctor, transportBackend, sdkBinding, webSearch, capabilities, runtime-inference
- 2026-03-07: Init/template 层已收敛为两类：
  - guided standard protocols: `openai`, `responses`, `anthropic`, `gemini`
  - managed-auth built-ins: `qwen`, `iflow`, `gemini-cli`, `antigravity`, `deepseek-web`
  标准 provider 不再需要内置目录项；只有宿主必须管理的 OAuth/account/runtime provider 保留内置模板。
- 2026-03-07: `src/cli/config/bootstrap-provider-templates.ts` 成为 init / config / provider-add / config-admin 共用的 bootstrap 模板入口；`init-provider-catalog.ts` 继续保留全量 metadata/catalog 职责，不再兼任所有模板入口。
- 2026-03-07: Web UI provider templates API 现在扫描 `~/.routecodex/provider/<id>/config.v2.json` 目录结构，而不是错误地扫描根目录平铺 json；`boundToConfig` 同时参考 config 中显式 providers 和 routing target 引用。

Tags: provider-bootstrap, init-template, managed-auth, oauth, account-runtime, config-admin, provider-directory, bootstrap-provider-templates

## Provider / Compat 配置收敛

- 2026-03-07: Provider 配置收敛方向确认：`transport`、`models.<model>.options`、`compat` 三层分离。`headers/baseUrl/auth/backend` 属于 transport；`vision/webSearch/contextWindow/reasoningEffort` 等能力声明属于 model options；字段修正、tool 处理、reasoning 映射等协议兼容逻辑属于 compat。
- 2026-03-07: Compat 采用“双轨”模式：保留内置 `compat.profile`，同时增加 `compat.options` 动态配置，但动态配置只能调用内置支持的原子操作，不能变成任意脚本或黑盒 DSL。
- 2026-03-07: 多模态与 web search 的能力声明要尽量前移到 provider model 配置，参考 opencode 的 `provider.<id>.models.<model>.options` 风格；Virtual Router 路由层只负责池子策略和显式覆盖。
- 2026-03-07: 推进顺序固定为：1) 先扩 schema/loader/runtime 透传；2) 再做 bootstrap 自动从 model options 推导 `multimodal/search`；3) 最后逐步把 compat 原子操作外露并从硬编码迁移。
- Tags: provider-schema, compat, dynamic-actions, multimodal, web-search, transport, model-options, architecture
- 2026-03-07: 用户要求对当前 Provider/Compat 配置收敛任务采用“每一个进度都更新记忆”的方式推进；后续每完成一个阶段性步骤，都要同步更新 `MEMORY.md` 或对应 `memory/` 任务记忆，而不是只在结束时补记。
- Tags: memory-discipline, progress-tracking, provider-schema, compat

## 语义单一真源收敛

- 2026-03-08: `chat_process` 的收敛原则确认：同一个业务语义只能有一个可变真源，其他表示必须是只读派生，不允许多条路径并行修补。
- 2026-03-08: 首轮确认的重复语义清单：
  - `messages` vs `semantics.responses.context.input`
  - `metadata.responsesResume` vs `semantics.responses.resume` vs `RouterMetadataInput.responsesResume`
  - `metadata.capturedChatRequest` vs `adapterContext.capturedChatRequest` vs `__rt.capturedChatRequest` vs `originalRequest`
  - router 内部 stop/pre-command 状态 vs `__rt.stopMessageState` / `__rt.preCommandState`
  - `normalized.processMode` / request metadata / `StandardizedRequest.processMode` / `RouterMetadataInput.processMode`
  - `routeHint` 在 normalized metadata / request metadata / router metadata 的重复承载
  - `applyPatchToolMode` 在 env / runtime metadata / request metadata / tool execution context 的重复承载
  - `tool_choice` / `parallel_tool_calls` 在 chat parameters / responses context / metadata extra fields / compat 的重复合并
  - `hasImageAttachment` 在消息内容推导与 metadata flag 的重复缓存
- 2026-03-08: 真实线上 `view_image -> 下一轮请求 -> doubao-seed-2.0-pro 400` 的根因不是历史 user image，而是历史 `view_image` tool output 中仍保留 inline base64。
- 2026-03-08: 已验证的修复方向是“canonical messages 为唯一真源”：先在 `chat_process` 入口清理历史 user media 与历史 visual tool outputs，再由 canonical messages 派生 responses / anthropic 等 provider 出站形状；同时不要再把 `responsesContext` legacy 快照重新注入 provider payload metadata。
- 2026-03-08: `continue_execution`/`stopMessage` 的单一真源继续收敛：native `req_process stage1 tool governance` 不再自行读取 `runtime_metadata.stopMessageState`，而是由 TS 在进入 native 前基于 sticky-store 计算 `hasActiveStopMessageForContinueExecution` 并显式传入；这避免了 native/TS 双方各自读取不同 stopMessage 视图。
- 2026-03-08: `capturedChatRequest/originalRequest` 收敛继续推进：`stop-message-auto/runtime-utils` 已停止从 `originalRequest` 兜底读取 tmux session / workdir 这类 servertool 运行上下文，避免 legacy request 副本继续给 stop-message / bd 注入路径打洞。
- 2026-03-08: `processMode/routeHint` 收敛继续推进：servertool followup/replay 不再写 `metadata.routeHint = ""` 这类 legacy 清路由字段；当前只通过 `__rt.preserveRouteHint = false` 和 `__rt.disableStickyRoutes = true` 控制 followup 路由重置。
- 2026-03-08: `routecodex-270.9` 已验证 AI SDK OpenAI transport 的真实出站仍可能把 system prompt 序列化成 `messages.role=developer`；仅删除旧显式设置不够，必须在 `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts` 强制 `providerOptions.openai.systemMessageMode = "system"`，这样 `ark-coding-plan` 这类只接受 `system|assistant|user|tool` 的兼容提供商才不会返回 400。

Tags: semantic-unification, single-source-of-truth, chat-process, responses-context, responses-resume, capturedChatRequest, stopMessageState, preCommandState, processMode, routeHint, applyPatchToolMode, hasImageAttachment, view_image, history-media

- 2026-03-07: `/v1/models` for Codex now preserves provider-prefixed aliases (for example `crs.gpt-5.4`) and adds bare model aliases (for example `gpt-5.4`) for enabled `responses` providers. Bare + prefixed aliases both carry Codex-required model metadata (`apply_patch_tool_type`, `shell_type`, `context_window`, reasoning fields, modalities, truncation policy). Upstream `crs` does not expose a usable `/models` catalog, so RouteCodex currently synthesizes this metadata from local provider config plus known Codex model presets.
  Tags: models, codex, metadata, responses, crs, v1-models
- 2026-03-07: For non-OAuth / non-ChatGPT Codex sessions, remote `/v1/models` refresh and `X-Models-Etag` are not sufficient because Codex `ModelsManager.refresh_available_models()` only fetches remote models when `auth_mode == Chatgpt`. The working config to restore `apply_patch` for `gpt-5.4` is: add `model_catalog_json = "/Users/fanzhang/.codex/model_catalog.routecodex.json"` to `~/.codex/config.toml`, keep `gpt-5.4`/`gpt-5.3-codex` in that catalog with `apply_patch_tool_type = "freeform"` plus correct shell/context metadata, then restart the Codex client.
  Tags: codex, model_catalog_json, apply-patch, gpt-5.4, non-oauth, models-etag, config
- 2026-03-07: Added explicit `/models` and `/v1/models` access logging in `src/server/runtime/http-server/routes.ts`; log format includes `path`, `count`, `remoteIp`, `host`, `auth`, `x-forwarded-for`, and `user-agent`. Use this to prove whether a client is actually traversing RouteCodex model discovery before debugging missing tool metadata. Existing older `rcc` builds (for example port `5520`) will not emit this log until rebuilt/repacked.
  Tags: routecodex, v1-models, logging, codex, rcc, observability
- 2026-03-08: 当前 Codex 上下文百分比与 RouteCodex `usage` 不是同一口径：`~/.routecodex/logs/server-5555.log` 中 CRS 长上下文请求真实 `request` token 已到 `576k+`，而 Codex 状态栏仍可能显示约 `75% left`。已确认本地 catalog 活跃窗口源是 `~/.codex/model_catalog.routecodex.json` 中 `gpt-5.4.context_window = 900000`；同时已把 `~/.codex/config.toml` 中各 `gpt-5.4` profile 的 `model_context_window` / `model_auto_compact_token_limit` 改到 `256000`，但若客户端仍显示偏高剩余比例，说明 Codex meter 没有统计 RouteCodex 实际转发的整段历史工具输出。
  Tags: codex, context-window, usage, routecodex-5555, gpt-5.4, longcontext
- 2026-03-08: `scripts/install-global.sh` 的 5555 自动重启提示已更新：不再把失败默认表述为“当前服务尚未具备 server-managed restart 能力 / 需要手动重启一次”。当前 CLI 已支持 HTTP restart + legacy signal restart；并且本机 `routecodex restart --port 5555`、`npm run build:dev` 内的自动刷新都已实测成功。
  Tags: routecodex, install-global, managed-restart, restart, 5555
- 2026-03-08: `virtual-router-hit` 彩色日志的真实生效路径不在 RouteCodex `src/modules/pipeline/utils/colored-logger.ts` / `debug-logger.ts`，而在 `sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts` 与 `engine-logging.ts`。之前“改了没效果”不是色表本身问题，而是改到了未参与真实路由命中日志输出的宿主包装层。当前 live 路径已改为按 `sessionId/tmuxSessionId/conversationId` 派生稳定颜色，并输出 `sid=...`；`routecodex restart --port 5555` 与 `tests/sharedmodule/virtual-router-hit-log.spec.ts` 已验证通过。
  Tags: virtual-router-hit, logging, session-color, sid, llmswitch-core, 5555

## Rust 化推进策略

- 2026-03-10: Rust 化的主优先级高于文件瘦身。当前阶段不要把“模块 Rust 化”和“按行数拆文件”混在一起做；先完成模块所有权收口，再做文件整理。
- 2026-03-10: 统一推进顺序固定为：1) 先做模块 Rust 化闭环；2) 确认 host/bridge 实际执行权切到 Rust；3) 收掉对应 TS 旧实现或降为薄壳，避免双真源；4) 最后再做文件拆分和尺寸治理。
- 2026-03-10: 后续工作必须按“一个模块一个模块搞干净”推进，不接受跨多个模块同时半迁移半拆分的混合做法。模块完成标准包括：Rust 覆盖主语义、执行链路真实走 Rust、通过 parity/shadow/replay 验证、TS 侧完成收口。
- 2026-03-10: 模块级固定顺序为：1) hub pipeline core；2) tool governance + route select；3) servertool / continue_execution / clock；4) virtual-router；5) compat / protocol codecs；6) shared semantics / normalizers；7) bridge actions / snapshot / hooks。后续任务拆分、评审和提交都以这组顺序为准。

Tags: rust-migration, module-ownership, single-source-of-truth, bridge, cleanup-order, llmswitch-core

## ServerTool Engine Rust 化进展

- 2026-03-11: 从 servertool/engine.ts 抽取第一批纯函数到 Rust（commit 8988204）：
  - `parse_timeout_ms_json` (TS:77-83)
  - `has_non_empty_text_json` (TS:282-296)
  - `is_empty_client_response_payload_json` (TS:298-361)
  - `stable_stringify_json` (TS:1844-1856)
  - `sanitize_loop_hash_value_json` (TS:1788-1819)
  - `build_followup_request_id_json` (TS:1857-1871)
  - `normalize_followup_request_id_json` (TS:1897-1912)
  - `resolve_stop_message_snapshot_json` (TS:1481-1527)
  - `coerce_followup_payload_stream_json` (TS:270-280)
- 2026-03-11: servertool/engine.ts 中仍待 Rust 化的较大函数块：
  - `runServerToolOrchestration` (432-1370) - 主编排循环，依赖异步调用
  - `disableStopMessageAfterFailedFollowup` (1370-1400) - 依赖文件 I/O
  - `decorateFinalChatWithServerToolContext` (1565-1616) - 可纯化
  - `resolveRouteHint` (1617-1630) - 可纯化
  - `buildServerToolLoopState` (1632-1690) - 可纯化
  - `hashPayload` / `hashStopMessageRequestResponsePair` (1768-1787) - 可纯化，已部分实现

Tags: rust-migration, servertool-engine, pure-functions, native-exports
