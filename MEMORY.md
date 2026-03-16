# RouteCodex Memory

## Skills 与调试工作流

- 2026-03-10: `~/.codex/skills/pipedebug/` 已按当前 RouteCodex V2 结构更新。默认调试主线改为：先看 `~/.routecodex/codex-samples/`，先判断问题属于 request path 还是 response path，再沿 `host bridge -> llmswitch-core Hub Pipeline -> Provider V2` 的真实边界定位。旧的“4 层流水线 / workflow-compatibility-provider README / routecodex-worktree/fix / ~/.claude/skills”表述已从 `SKILL.md` 与 references 中移除。
- 2026-03-16: Heartbeat 现定义为 tmux-client re-activation feature，唯一协议是 `<**hb:on**>` / `<**hb:off**>`，并且只绑定 `tmuxSessionId`。`hb:on` 立即生效，不支持输入 startAt；结束时间唯一来自目标工作目录 `HEARTBEAT.md` 头部 `Heartbeat-Until:` 标签。heartbeat 只在“无 in-flight request + 客户端已断开/心跳过期”时才允许注入；失败只能记日志/状态，不能影响主链路正确性，也不能 fallback 到 server cwd。注入文案必须要求读取 `HEARTBEAT.md`、检查上次交付、更新 `DELIVERY.md`、再调用 `review`，且 review 只能由模型通过现有 `review_flow` 主动调用，服务端不得自动串联。

Tags: pipedebug, skill, codex-samples, request-path, response-path, llmswitch-core, provider-v2, debug-workflow, heartbeat, tmux, ssot, heartbeat-until, heartbeat-marker, delivery-md, review-flow, no-fallback, client-reactivation

- 2026-03-16: 已建立全局 `~/.codex/AGENTS.md` 作为唯一全局 agent 说明真源；内容包括：全局编码规则（单文件 <= 500 行、公共函数库 + 模块化 + 应用层编排、模块唯一真源、UI 只消费应用层数据）、debug 规则（先查记忆/历史、避免重复错误、解决或失败后记忆落盘、明确目标主动实现、危险操作谨慎、最小改动、从正确层根因修复）、以及 `CACHE.md` / `HEARTBEAT.md` / `DELIVERY.md` / clock / bd / lsp 的全局使用说明。并明确 `~/.codex/AGENTS.md` 为唯一全局文件，不再使用 `~/.codex/agents.md`。

Tags: global-agents, codex-home, agents-md, cache-md, heartbeat-md, delivery-md, clock, bd, lsp, coding-rules, debug-rules, ssot

- 2026-03-16: 全局规则已加强：对任何**完成时间未知的异步等待任务**（尤其后台 terminal / daemon / 长时测试 / 构建 / 发布 / 轮询）都应设计 `clock` reminder，而不是只靠记忆回头检查。该约束已写入 `~/.codex/AGENTS.md` 与 `docs/CLOCK.md`；推荐模式是“启动后台任务后立刻设一个短 reminder，回来检查日志/退出码/产物，若未完成再续设下一次 reminder”。

Tags: clock, async-wait, background-terminal, reminder, agents-md, clock-md, workflow, recovery

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
- 2026-03-12: 当仓库内存在 `sharedmodule/llmswitch-core` 时，`BUILD_MODE=dev` 和 `BUILD_MODE=release` 都以本地 sharedmodule 为 llms 真源；只有本地 sharedmodule 缺失时，release 才回退到 npm-installed `@jsonstudio/llms`。`rcc` 打包/发布脚本也必须优先读取本地 `sharedmodule/llmswitch-core/package.json` 的版本，把该版本写入 tarball 的 `@jsonstudio/llms` 依赖，而不是直接沿用根仓库 `package.json` 的依赖声明。

Tags: build, global-install, verify-install-e2e, port-detection, restart-only, native-loader, import-meta, llmswitch-core, release, rcc, packaging, local-source-of-truth

## 用户目录迁移相关

- 2026-03-12: `~/.routecodex -> ~/.rcc` 的迁移边界已按用户要求收窄，只迁移用户自维护配置：`config.json`、`config/`、`provider/`。不要迁移任何运行期/生成物，包括 `auth/`、`tokens/`、`logs/`、`sessions/`、`pid`、`hooks` 等。
- 2026-03-12: `provider/` 迁移也要继续遵守“只搬配置、不搬生成物”的边界；像 `provider/*/samples/**` 这种嵌套在 provider 目录中的 mock/sample/archive 数据同样视为生成物，必须排除，不要整段原样复制。
- 2026-03-12: `src/config/user-data-paths.ts` 已成为用户目录布局的单一真源。默认写入根为 `~/.rcc`，读取允许回退到 legacy `~/.routecodex`，并优先尊重 `HOME` 与 `RCC_HOME` / `ROUTECODEX_USER_DIR` / `ROUTECODEX_HOME`。
- 2026-03-12: 新增显式迁移命令 `routecodex migrate-user-config`，仅针对 `config.json/config/provider` 生成 dry-run/apply 计划；默认不自动搬家，不做静默迁移，冲突文件默认保留，只有 `--overwrite` 才覆盖。
- 2026-03-12: 配置迁移回归已验证通过：新增 `tests/config/user-config-migration.spec.ts`、`tests/commands/migrate-user-config.spec.ts`，并补跑 `user-data-paths/provider-v2-loader/config/start/stop/restart/env/deepseek-http` 相关回归，全绿。

Tags: rcc, routecodex-home, migration, user-config, provider, config-json, explicit-migration, no-runtime-migration

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

## Rust 静默失败修复 (2026-03-11)

### 问题背景
Rust 化后发现静默失败现象，主要集中在状态持久化和快照文件操作路径。

### 修复范围

**1. routing_state_store.rs** - 路由状态持久化关键路径
- `load_routing_instruction_state`: 文件读取和 JSON 解析失败现在打印错误日志
- `persist_routing_instruction_state`: 目录创建、序列化、文件写入失败现在打印错误日志
- NotFound 错误静默处理（符合预期）

**2. hub_snapshot_hooks.rs** - 快照文件操作
- `cleanup_zero_byte_json_files`: 文件删除失败打印警告
- `write_unique_errorsample_file`: 临时目录创建和文件重命名失败打印警告
- `merge_dirs`: 目录创建、文件重命名、目录删除失败打印警告
- `promote_pending_dir`: 目录创建失败打印警告并提前返回
- `write_snapshot_file`: 目录创建失败返回错误（关键路径），元数据写入失败打印警告
- `write_snapshot_via_hooks`: 快照写入失败打印警告

### 修复原则
1. 关键路径返回错误，非关键路径打印警告
2. NotFound 类错误静默处理（符合预期行为）
3. 保留 best-effort 清理操作

### 标签
Tags: rust, silent-failure, error-handling, routing-state, snapshot

## Session 色链路对齐 (2026-03-11)

- `virtual-router-hit` 与 host 侧 `[usage]` / `✅ completed` 的颜色目标必须统一为“按 sessionId 上色”，不能让 host 在拿不到 session 时退化成按 requestId 哈希生成伪 session 色。
- `src/utils/session-log-color.ts` 是 host 侧 session 颜色单一真源；sharedmodule `src/router/virtual-router/engine-logging.ts` 需要保持同一套扩展 palette + hash 逻辑，否则会出现 sharedmodule/host 颜色错位。
- `src/server/utils/request-log-color.ts` 现在只在显式或已注册的 `sessionId` / `conversationId` 可用时才给 host 请求日志上色；没有 session 映射时宁可保持默认色，也不要按 requestId 乱染色。
- RouteCodex 运行时日志颜色不再被继承的全局 `NO_COLOR=1` 静默关闭；只有 `ROUTECODEX_FORCE_LOG_COLOR=0` / `RCC_FORCE_LOG_COLOR=0` 才应作为显式关闭开关。
- 调试边界：如果 `virtual-router-hit` 有颜色而 host `usage/completed` 仍是白色，问题已经收缩到 host runtime 没有拿到/保留同一 session 标识，而不是颜色算法分叉。

Tags: session-color, virtual-router-hit, usage-log, http-log, single-source-of-truth, host, sharedmodule, no-color

## Codex Reasoning Display 排查 (2026-03-11 18:04:58 +08:00)

### 结论
- `~/.codex/config.toml` 中的 `model_reasoning_summary` 和 `model_verbosity` 确实会被 Codex 读取。
- 优先级是 `config.toml/profile` 覆盖 `model_catalog.routecodex.json` 默认值。
- `model_reasoning_summary = "detailed"` 不等于 UI 一定显示很多内容；它只是请求模型返回更详细 summary。
- 如果界面仍然显示很少，常见原因是客户端没有打开 raw reasoning 展示，需额外设置 `show_raw_agent_reasoning = true`。
- 当前 `gpt-5.4` 在 `~/.codex/model_catalog.routecodex.json` 中声明：
  - `supports_reasoning_summaries = true`
  - `default_reasoning_summary = "none"`
  但该默认值会被 `config.toml` 覆盖，不是本次无变化的根因。

### 代码证据
- `codex-rs/core/src/config/mod.rs`
  - 读取 `model_reasoning_summary` / `model_verbosity`
  - profile 优先于全局：`config_profile.xxx.or(cfg.xxx)`
- `codex-rs/core/src/codex.rs`
  - session/per-turn 会继续携带 `model_reasoning_summary`
  - 最终用 `config` 值，否则回退 `model_info.default_reasoning_summary`
- `codex-rs/core/src/client.rs`
  - 若模型支持 reasoning summaries，会把 summary 传给 Responses API
- `codex-rs/core/src/config/mod.rs` + `codex-rs/core/src/codex.rs`
  - raw reasoning 展示还受 `show_raw_agent_reasoning` 控制

### 建议
- 若用户反馈“重启后 reasoning 还是很少”，优先检查并建议：
  - `show_raw_agent_reasoning = true`
- 不要先怀疑 `model_reasoning_summary` 未读取，除非本地代码版本明显落后或配置路径未生效。

Tags: codex, reasoning-summary, show-raw-agent-reasoning, config, model-catalog, display-debug

## 用户目录迁移决策 (2026-03-12)

- 用户目录后续统一迁到 `~/.rcc`，`~/.routecodex` 仅作为迁移期 legacy 回读来源，不再作为新的默认写入根目录。
- 迁移顺序先做“根目录真源”收口，再按域分批迁写入；本轮不做全量目录重构，也不做一次性大爆炸迁移。
- 迁移范围要排除已经废弃不用的路径与逻辑，避免把历史包袱原样搬到 `~/.rcc`。
- `hooks` 目录与相关能力不纳入新的目录架构规划，后续不作为迁移目标。
- 实施原则：Host、sharedmodule、native 不能各自拼 `~/.routecodex` / `~/.rcc`；用户目录根路径必须有统一解析真源，并优先通过环境或公共路径模块向下游传播。
- 当前 `bd --no-db` 受 `.beads/issues.jsonl` 第 332 行超长记录阻塞，现象是 `bufio.Scanner: token too long`；在修复该 issue 数据前无法正常 `search/create/claim`。

Tags: rcc-home, routecodex-home, migration, user-data, legacy-read, deprecated-paths, hooks, bd-blocked

## ~/.rcc 迁移 Batch 1 落地 (2026-03-12)

- `src/config/user-data-paths.ts` 已成为 Host 侧用户目录根路径单一真源：
  - 默认根目录是 `~/.rcc`
  - 兼容环境变量：`RCC_HOME` / `ROUTECODEX_USER_DIR` / `ROUTECODEX_HOME`
  - 读路径允许回退到 legacy `~/.routecodex`
- `src/cli.ts` 与 `src/index.ts` 会在进程启动时调用 `ensureRccUserDirEnvironment()`，确保下游仍读旧环境名的模块也会落到 `~/.rcc`。
- Batch 1 已迁移的 Host 活跃路径主要覆盖：
  - `auth` / `tokens`
  - `quota` / `state`
  - `sessions`
  - `logs`
  - `codex-samples`
  - `errorsamples`
  - `statics`
  - `login`
  - `token-daemon.pid`、`server-<port>.pid`、`daemon-stop-<port>.json`、runtime lifecycle 状态文件
- 一个关键修复点：统一路径真源必须优先尊重 `process.env.HOME`，不能只依赖 `os.homedir()`，否则测试沙盒和临时 home 场景会错误落到真实用户目录。
- Batch 1 的定向验证已经通过：
  - `tests/config/user-data-paths.spec.ts`
  - `tests/config/provider-v2-loader.spec.ts`
  - `tests/server/http-server/session-dir.spec.ts`
  - `tests/providers/auth/oauth-lifecycle/path-resolver.unit.test.ts`
  - `tests/providers/auth/tokenfile-auth.qwen-alias.spec.ts`
  - `tests/token-daemon/history-store.auto-suspend-immediate.spec.ts`
  - `tests/providers/auth/oauth-auth.bootstrap-tokenfile.spec.ts`
- 全量 `tsc --noEmit` 仍有仓库内既有错误，集中在：
  - `src/cli/commands/claude.ts`
  - `src/cli/commands/codex.ts`
  - `src/cli/commands/launcher-kernel.ts`
  这些不属于本轮 `~/.rcc` 迁移引入的问题。
- 后续继续做 Batch 2 时，优先处理剩余 host/admin/config 层仍直接拼接 `~/.routecodex` 的实现，再进入 sharedmodule/native。

Tags: rcc-home, batch1, migration, user-data, host-runtime, tests, home-env, legacy-read

## ~/.rcc 迁移 Batch 2 落地 (2026-03-12)

- Batch 2 已完成 host/admin/config 余下活跃路径收口，重点包括：
  - `src/cli/config/init-config.ts` 不再按 `configPath` 同级写 `provider/`，统一改为写入 `~/.rcc/provider`
  - `src/cli/commands/launcher-kernel.ts` 的默认配置读取与 server log 写入切到 `~/.rcc`
  - `src/providers/auth/deepseek-account-auth.ts` 的默认 token 路径切到 `~/.rcc/auth`
- 这轮顺手统一了面向用户的 CLI 文案与模板示例路径，包括：
  - `init` / `provider-update` / `port` / `camoufox` 等帮助文本
  - `init-provider-catalog.ts` 里的示例 `tokenFile` / `cookieFile`
- Batch 2 明确保留未迁移项：
  - `hooks` 相关路径继续不动，遵循“hooks 不迁移”
  - 纯注释、legacy 兼容说明、测试用 legacy 文本不作为本轮迁移目标
- 一个额外落地点：`deepseek-account-auth` 不能只依赖 `os.homedir()`；默认 token 路径与 `~` 展开都要兼容 `process.env.HOME`，否则测试沙盒和临时 home 会误落真实用户目录。
- Batch 2 的定向验证已经通过：
  - `tests/cli/config-command.spec.ts`
  - `tests/cli/env-command.spec.ts`
  - `tests/cli/port-command.spec.ts`
  - `tests/cli/start-command.spec.ts`
  - `tests/cli/stop-command.spec.ts`
  - `tests/cli/restart-command.spec.ts`
  - `tests/cli/clean-command.spec.ts`
  - `tests/cli/guardian-client.spec.ts`
  - `tests/providers/auth/deepseek-account-auth.unit.test.ts`
  - `tests/providers/core/runtime/deepseek-http-provider.unit.test.ts`
- 2026-03-12 当天 `bd --no-db` 已恢复可用，`routecodex-271.2` 已关闭；后续若继续迁移，只需围绕剩余注释/示例清理或 sharedmodule/native 侧新批次单独开子任务。

Tags: rcc-home, batch2, migration, user-data, config-init, launcher-kernel, deepseek-auth, home-env, tests, bd

## ~/.rcc 迁移 Batch 3 进行中：目录布局真源收敛 (2026-03-12)

- `src/config/user-data-paths.ts` 已从“根目录 helper 集合”提升为“目录布局 registry”：
  - 新增 `RCC_SUBDIRS`
  - 新增 `resolveRccSubdir(...)` / `resolveRccSubdirForRead(...)`
  - 新增专用 helper：`resolveRccConfigFile`、`resolveRccProviderDir`、`resolveRccGuardianDir`、`resolveRccPrecommandDir`、`resolveRccCamoufoxFingerprintDir`、`resolveRccCamoufoxProfilesDir` 等
- Batch 3 当前目标不是继续替换 `~/.routecodex -> ~/.rcc` 字符串，而是收敛“谁负责定义子目录布局”。后续代码应优先依赖这些 helper，不再手拼 `join(resolveRccUserDir(), '<subdir>')`。
- 已完成的第一批高频入口收口：
  - `config/start/stop/restart/env/init/launcher-kernel` 的默认 `config.json` / `sessions` / `logs` 路径
  - `provider-update`、`provider-v2-loader`、`config-admin-handler`、`daemon-admin/providers-handler-routing-utils` 的 provider root
  - `guardian`、`precommand`、`antigravity quota persistence`、`camoufox fingerprint` 相关目录
- Batch 3 当前验证通过：
  - `tests/config/user-data-paths.spec.ts`
  - `tests/config/provider-v2-loader.spec.ts`
  - `tests/cli/env-command.spec.ts`
  - `tests/cli/start-command.spec.ts`
  - `tests/cli/stop-command.spec.ts`
  - `tests/cli/restart-command.spec.ts`
  - `tests/cli/clean-command.spec.ts`
  - `tests/cli/config-command.spec.ts`
  - `tests/cli/guardian-client.spec.ts`
  - `tests/providers/auth/deepseek-account-auth.unit.test.ts`
  - `tests/providers/core/runtime/deepseek-http-provider.unit.test.ts`
- 当前 `tsc --noEmit` 仍停在 `src/cli/commands/launcher-kernel.ts` 的既有错误 `resolveExitGracePeriodMs` 未定义；本轮 Batch 3 没有新增其它路径相关 TS 错误。
- 截至本轮第二批收口后，`src/` 内残留的 `.routecodex` 命中基本只剩：
  - legacy 兼容常量与兼容注释（例如 `LEGACY_DIR_NAME = '.routecodex'`）
  - quota 命令里的“legacy compatible”用户文案
  - `token-storage` 的 legacy 搜索注释
  - `hooks` 里的 `codex-samples` 路径（按要求不迁移）
  - provider profile loader 的测试文本
  说明活跃源码路径已经基本完成从“手拼目录”到“布局 helper”收敛。
- Batch 3 运行时验证补充：
  - `src/manager/modules/quota/antigravity-quota-persistence.ts` 已确认采用“读可回退 legacy、写只落 `.rcc`”语义；`tests/manager/quota/antigravity-quota-persistence.spec.ts` 与 `tests/manager/quota/quota-manager-refresh.spec.ts` 已回归通过。
  - 重建 `dist` 到 `0.90.328` 后，真实 smoke 已验证 `~/.rcc/state/quota/antigravity.json` 会生成并更新，而 `~/.routecodex/state/quota/antigravity.json` 不再被新进程回写。
  - 迁移收尾阶段看到的 `~/.routecodex/guardian/guardian-state.json` 更新不是源码双写，而是旧 guardian daemon 残留；已通过内置 guardian stop flow 退掉 legacy guardian，现仅保留 `~/.rcc/guardian/guardian-state.json` 对应的新 guardian。
  - 文档/脚本层面的 `config/provider` 默认路径也已收口到 `~/.rcc`：针对 `README/src/README/src/config/README` 与活跃脚本（provider-v2-smoke、verify-sse-loop、responses-sse-*、virtual-router-*、verify-e2e-*、run-bg/run-fg、install-release、config-core-compare、verify-health 等）完成替换；重新扫描后，活跃默认值中 `'.routecodex/config*'` 与 `'.routecodex/provider*'` 命中已为 0。

Tags: rcc-home, batch3, layout-registry, user-data, single-source-of-truth, config-file, provider-root, camoufox, guardian, precommand

## execCommandGuard 默认启用 (2026-03-15)

- `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/config-normalizers.ts` 已修改为默认启用 `execCommandGuard`：
  - 未配置 `execCommandGuard` 时，自动返回 `{ enabled: true }`
  - 只有明确设置 `enabled: false` 才会禁用
- 内置拦截规则（硬编码，无需 policy 文件）：
  - `git reset --hard`：破坏性操作，建议用 `git reset --mixed` 或 `git restore`
  - `git checkout`（非单文件）：只允许 `git checkout -- <file>` 单文件恢复
- 可选：通过 `policyFile` 指定 JSON 规则文件，添加自定义拦截规则
- 配置示例（禁用）：
  ```json
  {
    "virtualrouter": {
      "execCommandGuard": {
        "enabled": false
      }
    }
  }
  ```
- 类型文档已更新：`VirtualRouterExecCommandGuardConfig` 注释说明默认启用行为
- 相关测试全部通过：`tool-governor-exec-command-guard.spec.ts`、`tool-registry-tools.spec.ts`、`exec-command-guard.spec.ts`

Tags: execCommandGuard, git-reset, destructive-command, default-enabled, security, llmswitch-core, config-normalizers

## llmswitch-core 启动失败与 sessions 生命周期修复（2026-03-15）

- 本轮真实启动失败不是 provider / runtime 问题，而是 `sharedmodule/llmswitch-core` 处于“半删状态”：
  - `dist` 引用了不存在的 `tools/apply-patch/execution-capturer.js`
  - `src` 中存在“import 被删或注释，但调用仍保留”的失配（如 `tool-registry.ts` 与 regression capturer 相关）
- 正确修法不是打 stub 洞，也不是跳过构建，而是恢复 source/dist 一致性：
  - 删除无真实 source 的死引用
  - 补回 `apply-patch` / `exec-command` regression capturer 的真实 source 文件
  - 恢复 `tool-registry` 中被注释掉的 import
- 修复后已用同形回放验证：
  - `sharedmodule/llmswitch-core npm run build` + matrix ✅
  - `hub-pipeline` 真实 import ✅
  - root `npm run build:dev` ✅，并成功完成全局安装与受管服务重启
- `continue_execution` 的当前唯一真意：
  - 缺少 `summary` 时不再进入 `continue_execution_error`
  - 统一继续走 `continue_execution_flow`
  - `clientInjectText` 默认回退为 `继续执行`
  - `visibleSummary` 保持空字符串
  - 已用 matrix 样本 `servertool-handler-error-followup.mjs` 回放确认
- `~/.rcc/sessions` 的唯一真意进一步落地：
  - `sessions` 目录只保留 tmux / registry 生命周期管理所需内容
  - session/conversation 路由态不再在这里扩散
  - 启动时执行 cleanup，清理遗留 scope 文件、dead tmux state、无效 registry 映射
  - 真实重启后 `~/.rcc/sessions` 顶层从此前 141 项收敛到 3 项，已证明清理生效
- `scripts/install-verify.mjs` 需要兼容真实用户环境：
  - 必须支持 v2 `routingPolicyGroups` 解析默认模型
  - 验证端口被占用时不能直接失败，应切换临时端口
  - CLI launcher 走临时端口时必须透传 `ROUTECODEX_PORT/RCC_PORT`
  - 当前剩余问题在 `rcc start --exclusive` 后的健康检查链路，后续继续查 CLI 启动骨架

Tags: llmswitch-core, startup-failure, half-deleted-code, continue_execution, sessions, startup-cleanup, release-verify, routingPolicyGroups, cli-launcher

## 2026-03-16 CACHE.md / tmux cwd / reasoning 映射收敛

- 2026-03-16: CACHE.md 请求侧写入的唯一真源收敛到 `sharedmodule/llmswitch-core/src/servertool/handlers/memory/cache-writer.ts`。请求写入只能使用 `adapterContext.cwd`（来自客户端 tmux cwd），禁止回退到 server cwd / process.cwd / 环境变量；拿不到 tmux cwd 就跳过写入，不能污染错误目录。
- 2026-03-16: `openai-responses` 请求路径中，`req_inbound.stage3_context_capture` 如果直接复用 `responsesContext`，仍然必须执行请求侧 CACHE 写入；否则会出现 assistant 记录存在、但 user 请求缺失的断裂对话。
- 2026-03-16: CACHE.md 请求去重规则确认：不能只看 `role=user`，因为同一轮请求会因重试/多 provider/多次进入 request path 而重复命中；当前规则是“仅当上一条可见对话也是 User 且正文完全相同”时跳过写入。若中间已有 assistant 回复，则相同 user 文本允许再次记录。
- 2026-03-16: CACHE.md 的可见格式必须保持顶级只有 `### User` / `### Assistant` 标签，正文紧跟其后；`requestId/sessionId/model/provider/finishReason` 等元数据下沉到正文后的 `<!-- cache-meta -->` 注释块，避免污染模型读取到的顶级对话内容。
- 2026-03-16: Anthropics/Responses reasoning 映射调试原则继续确认：先检查出站请求形状是否符合协议要求，再看入站 SSE / chat-process / responses 回填；如果请求都没带 thinking/reasoning 字段，检查响应没有意义。

Tags: cache-md, tmux-cwd, request-cache, adapterContext.cwd, openai-responses, responsesContext, dedupe, cache-meta, reasoning-mapping, ssot

## Reasoning 标签缺失排查（Anthropic → Responses → Codex）

- 2026-03-16: 对 `~/.rcc/codex-samples` 进行了 openai-responses 全链路核查，确认 **Anthropic reasoning 配置已生效**：
  - Provider 配置源：`~/.rcc/provider/ali-coding-plan/config.v2.json` 的 model-level `thinking: "high"`。
  - 路由选路快照：`chat_process.req.stage5.route_select.json` 的 `target.anthropicThinking = "high"` 且 `target.anthropicThinkingConfig.effort = "high"`。
  - 实际上游请求：`provider-request.json` 出现 `thinking` 与 `output_config`（如 `thinking.type="adaptive"` + `output_config.effort`）。
- 2026-03-16: 已确认 chat process 扩展字段链路存在：`chat_process.resp.stage4.semantic_map_to_chat.json` 中 `__responses_reasoning` 与 `choices[0].message.reasoning` 都可见（多数是 `content`）。
- 2026-03-16: Codex UI 不显示 thinking 标签的核心兼容性问题定位为 **Responses reasoning item 缺少 `summary`**：
  - Codex `ResponseItem::Reasoning` 结构中 `summary` 为必需字段（`~/code/codex/codex-rs/protocol/src/models.rs`）。
  - Codex SSE 解析对 `response.output_item.added/done` 使用整项反序列化，失败时丢弃该 item（`~/code/codex/codex-rs/codex-api/src/sse/responses.rs`）。
- 2026-03-16: 在 RouteCodex Rust 侧新增回填：当 reasoning 仅有 `content` 无 `summary` 时，自动将 `content` 中 `reasoning_text/text` 转为 `summary_text`。
  - 修改文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`。
  - 新增测试：`build_responses_payload_from_chat_backfills_reasoning_summary_from_content`。
- 2026-03-16: `~/.rcc` 样本验证显示修复生效：
  - 全量历史 `stage10` reasoning：`1208` 条，`with_summary=190`。
  - `14:35` 前：`1082` 条，`with_summary=69`。
  - `14:36` 后：`122` 条，`with_summary=122`（无缺失）。
  - 典型对比：
    - 旧样本 `req_1773640079317_ed4612ce`：reasoning 仅 `content`。
    - 新样本 `req_1773643623915_0c422b9f`：reasoning 同时有 `summary` + `content`。

Tags: reasoning, anthropic, output_config, thinking, responses, sse, codex-ui, summary-backfill, chat-process, __responses_reasoning, sample-replay

## Heartbeat 实施落地（tmux-only）

- 2026-03-16: heartbeat 已按 tmux-only 方案落地到主代码路径：
  - request path：`chat-process-heartbeat-directives.ts` 只解析最新 user 消息中的 `<**hb:on**>` / `<**hb:off**>`，剥离 marker，并仅在拿到 `tmuxSessionId` 时落盘状态。
  - persistence / daemon：`sharedmodule/llmswitch-core/src/servertool/heartbeat/` 负责状态文件、固定注入文案、15 分钟 tick 与运行态 hook。
  - host runtime：新增 `request-activity-tracker.ts` 与 `heartbeat-runtime-hooks.ts`，heartbeat 触发前必须满足：
    1. tmux 仍存活；
    2. 该 tmux 无 in-flight request；
    3. session-client registry 判定客户端已断开/心跳过期；
    4. tmux 当前目录可解析；
    5. 当前目录存在 `HEARTBEAT.md`；
    6. 若 `Heartbeat-Until:` 过期则自动 disable。
  - workdir 真源已固定为 `resolveTmuxSessionWorkingDirectory(tmuxSessionId)`，不允许 fallback 到 server cwd 或 registry workdir。
  - heartbeat 注入失败只记录状态/skip/error，不影响主链路。
- 2026-03-16: 运维/CLI 面也已补齐：
  - HTTP routes：`/daemon/heartbeat/list`、`/daemon/heartbeat`（status/on/off/trigger）。
  - CLI：新增 `routecodex heartbeat` / `rcc heartbeat` 子命令。
  - startup cleanup：`session-storage-cleanup.ts` 以 `~/.rcc/sessions/heartbeat/*.json` 为 tmux-global heartbeat 真源；如果 `ROUTECODEX_SESSION_DIR` 是 `~/.rcc/sessions/<host_port>` 这类端口桶，heartbeat 状态也必须提升到父级 sessions root，而不是继续按端口分桶。
  - 清理风险复核：当前 stale-heartbeat / startup cleanup 不会直接杀 tmux；真实风险是如果 dead/stale 判断误判，会移除 heartbeat state、registry record、conversation binding、tmux-tools-state 这类元数据，导致“状态失忆”，而不是 tmux 进程被误杀。
  - 回归补强：`tests/servertool/servertool-heartbeat.spec.ts` 新增两条样本——(1) 端口桶 `ROUTECODEX_SESSION_DIR` 下 heartbeat 必须写入父级 `sessions/heartbeat/*.json`；(2) 历史 per-port heartbeat 文件在读取时自动迁移到 tmux-global store，并删除 legacy 文件。这样可以防止 heartbeat 因 server port 变化而“丢状态”。
  - 2026-03-16 进一步收紧 cleanup：`cleanupStaleHeartbeatsFromRegistry()` 与 startup `sanitizeSessionBindingsDir()` 现在都遵守同一规则——**stale daemon != dead tmux**。如果 tmux 仍存活，只删除 stale daemon record，不再把 `removedTmuxSessionIds`、conversation mapping、tmux tool-state 一并清掉；只有 tmux probe 确认 dead 时，才清理 tmux scope 元数据。新增回归：`tests/server/http-server/session-client-registry.spec.ts`、`tests/server/http-server/session-storage-cleanup.spec.ts`。
  - Host 侧 tmux-scope cleanup 判定已抽到单一真源 `src/server/runtime/http-server/tmux-scope-cleanup-policy.ts`，并接入 `session-storage-cleanup`、`session-client-registry-utils`、`clock-runtime-hooks`、`executor-metadata`、`executor/client-injection-flow`。规则统一为：**只有 confirmed dead tmux 才允许清 tmux scope metadata**；stale heartbeat、workdir mismatch、inject failed、send failed 在 tmux 仍活时都不能再触发 scope 清理。
- 2026-03-16: 回归覆盖新增：
  - `tests/servertool/servertool-heartbeat.spec.ts`
  - `tests/servertool/review-followup.spec.ts` 新增 heartbeat handoff review 不变式
  - `tests/server/http-server/http-server-session-daemon.bootstrap.spec.ts`
  - `tests/server/http-server/session-storage-cleanup.spec.ts`
  - `tests/server/http-server/session-client-routes.stopmessage-cleanup.spec.ts`
  - 后续补充：
    - `tests/cli/heartbeat-command.spec.ts`
    - `tests/server/http-server/session-client-routes.spec.ts` 新增 heartbeat admin list/trigger dry-run
- 2026-03-16: 真实链路 dry-run 已确认：
  - `routecodex heartbeat list --port 5555 --json` 返回 `{"ok":true,"states":[]}`
  - `routecodex heartbeat trigger --port 5555 --tmux-session-id __hb_missing__ --dry-run --json` 返回 `tmux_session_not_found`
  - 说明 dev 端口 5555 的新 heartbeat route 已生效；若默认 CLI 命中 5520 返回 404，通常是老 release 服务尚未刷新，不是新代码路径缺失。
- 2026-03-16: clock “定时到了没触发、下次几个一起触发” 的根因定位到 **Host daemon bootstrap 与 llmswitch 默认配置不一致**：
  - request path：`resolveClockConfig(undefined)` 会默认启用 clock；
  - host 旧逻辑：只有 host config 显式存在 `clock` 节点才启动 clock daemon；
  - 后果：如果用户没写 `clock` 配置，`clock` tool 仍能 schedule，但后台定时 daemon 根本没启动，只会在后续请求里把多个 overdue task 一起补出来。
- 2026-03-16: 已修复 `http-server-session-daemon.ts`，改为即使 host config 缺失 `clock` 也调用 `resolveClockConfigSnapshot(undefined)`，按 llmswitch 默认配置启动 daemon；并新增回归：
  - `tests/server/http-server/http-server-session-daemon.bootstrap.spec.ts` 覆盖“无 host clock 配置也会启动 daemon”。
- 2026-03-16: Heartbeat marker 语法已扩展并明确覆盖语义：`<**hb:15m**>` / `<**hb:30s**>` / `<**hb:2h**>` / `<**hb:1d**>` 都表示**开启 heartbeat 并写入该 tmux state 的 interval override**；同一条最新 user 消息里按出现顺序解析，**最后一个 directive 生效**。`<**hb:on**>` 会开启 heartbeat 并**清除旧 interval override**，回到全局默认 interval；`<**hb:off**>` 会关闭 heartbeat 并清除 override。daemon 触发判定也改为 `state.intervalMs ?? config.tickMs`，扫描 cadence 则保持短周期（最多 60s）以避免默认 15m tick 吃掉更短 override。回归已补到 `tests/servertool/servertool-heartbeat.spec.ts`，覆盖 override 生效、`hb:on` 清除 override，以及 state interval 优先于全局 tick。
- 2026-03-16: Heartbeat request marker 现在先做**无条件剥离**再做语义解析：任何形如 `<**hb:...**>` 的完整 marker，甚至未闭合的 `<**hb:broken`，都不会继续带入下游 request/context。只有合法 body（`on` / `off` / `\d+[smhd]`）才会落成 directive；非法 body 只剥离、不生效。回归：`tests/servertool/servertool-heartbeat.spec.ts` 新增 invalid/unterminated marker strip case。
- 2026-03-16: 规则进一步收敛为**所有 `<**...**>` / `<**...` marker 语法都必须在 chat request path 统一剥离**，不能依赖各子模块各自清理。新增统一真源 `chat-process-generic-marker-strip.ts`，挂到 `chat-process-clock-reminders.ts` 的统一出口；因此无论是 heartbeat / clock / unknown marker / invalid marker / unterminated marker，只要还残留在 request messages 里，最终都会在出站前被去掉，不允许污染 provider 请求。回归：`tests/servertool/servertool-heartbeat.spec.ts` 新增 generic marker strip case。
- 2026-03-16: provider snapshot hook 的“非阻塞但可观测”真源已修正：`src/modules/llmswitch/bridge/runtime-integrations.ts` 真实可用模块应为 `conversion/snapshot-utils`，不是不存在的 `conversion/shared/snapshot-hooks`。这修复了运行时 `[provider-snapshot] writeSnapshotViaHooks not available` 的错误导入根因，并保留“失败不阻塞主流程、但必须 `console.warn` 暴露”的原则。回归：`tests/modules/llmswitch/bridge/runtime-integrations.snapshot.spec.ts`、`tests/snapshot/entry-endpoint-bucket.spec.ts`。

Tags: heartbeat, hb-marker, interval-override, hb-on, hb-off, tmux, daemon-scan, ssot, snapshot-hooks, provider-snapshot, non-blocking, observable

- 2026-03-16: 修复后再次通过 dev 运行态 dry-run：
  - `routecodex heartbeat list --port 5555 --json`
  - `routecodex heartbeat trigger --port 5555 --tmux-session-id __clock_fix_probe__ --dry-run --json`
  - 均命中新服务路径，说明 build/install/restart 后的服务已加载最新 heartbeat/daemon 代码。

Tags: heartbeat, tmux, request-activity-tracker, heartbeat-runtime-hooks, heartbeat-marker, heartbeat-until, delivery-md, review-flow, session-cleanup, cli


- 2026-03-16: Heartbeat / clock 注入真源已收敛到 llmswitch-core servertool 层。heartbeat 启动链路曾因 `startHeartbeatDaemonIfNeeded()` 使用 `void tickOnce()`，再叠加 host bootstrap 立即 `runHeartbeatDaemonTickSnapshot()`，导致同一 heartbeat 注入可能双发；修复为 startup tick 改成 `await tickOnce()`，并加回归覆盖“startup tick + immediate tick only once”。
- 2026-03-16: Clock 提醒的当前正确策略更新为：到期任务不是逐条同时刷屏，而是先按 due task 排序，以最早到期任务为锚点，把 **5 分钟窗口内** 的任务合并成一个 `[Clock Reminder]` 批次发送；超过 5 分钟的任务留到下一批。该聚合逻辑已下沉到 `sharedmodule/llmswitch-core/src/servertool/clock/tasks.ts`，由 request-path `reserveDueTasksForRequest(...)` 与 daemon 注入共用，避免双真源。

Tags: heartbeat, clock, servertool, llmswitch-core, ssot, tmux-injection, duplicate-injection, startup-tick, merge-window, clock-reminder, request-path, daemon

- 2026-03-16: 已新增全局 skill `~/.codex/skills/clock/`，用于 RouteCodex `clock` 的标准使用方式。skill 真源强调：对任何完成时间未知的异步等待任务（尤其后台 terminal / daemon / 构建 / 测试 / 发布）都应立即设计 clock reminder，而不是只靠记忆；并提供 reminder 文案模式、clock vs heartbeat 的区分、以及回调后必须检查真实证据再继续/续设 reminder 的工作流。

Tags: clock-skill, codex-skills, async-wait, background-terminal, reminder, heartbeat-vs-clock, workflow

## Tmux 渲染与 Codex Reasoning 显示（2026-03-16）

- 2026-03-16: 已通过对照确认 `codex --profile ...`（非 tmux）正常、`routecodex codex`（managed tmux）出现 reasoning 区域白底反显；因此根因定位到 **tmux/终端渲染层**，不是 provider reasoning 映射链路，也不是 apikey 认证分支。
- 2026-03-16: `routecodex codex` 现已固化 managed tmux 渲染兜底：默认开启 `ROUTECODEX_CODEX_TMUX_TUNE_RENDERING=1`、`ROUTECODEX_CODEX_TMUX_DISABLE_ITALIC=1`、`ROUTECODEX_CODEX_TMUX_DISABLE_STANDOUT=1`（含 `RCC_` 同义变量），用于降低 dim/italic/standout 在 tmux 中触发反显白底的概率，同时保持现有 tmux injection 与 scoped apikey 机制不变。
- 2026-03-16: 保留环境变量可回退（设置为 `0`），便于后续做终端兼容 A/B。

Tags: tmux, codex, reasoning, reverse-video, standout, italic, tune-rendering, launcher, scoped-apikey, stability

## 静默失败治理（2026-03-16）

- 2026-03-16: 本次针对“高优先级静默失败”做了最小根因修复：保留 non-blocking 语义，但不再吞掉异常。
  - Session Reaper 启动首次 cleanup 失败：从静默改为 `logProcessLifecycle(event=session_reaper_error, phase=initial_cleanup)`。
  - Snapshot 链路（host bridge/provider snapshot）：`writeErrorsample` / `writeSnapshotViaHooks` / fallback 写盘失败从静默改为带 operation 上下文的 `console.warn`。
  - Quota 链路（adapter + antigravity manager/runtime + llmswitch-core quota-manager）：`hydrate/persist/subscribe/refresh` 等吞异常点改为显式 warn，避免“配额状态未落盘/未订阅但无感知”。
  - Tool filter hooks（llmswitch-core）：单个 hook 同步异常、异步 rejection、外层 apply 失败均记录 warning，仍保持 passthrough，不阻断请求主链路。
- 2026-03-16: 验证结果：
  - `sharedmodule/llmswitch-core/` 执行 `npm run build` 通过（含 matrix/postbuild）。
  - 仓库根目录执行 `npm run build:dev` 通过（含 install:global 与健康检查）。
- 经验：对 best-effort 分支应采用“non-blocking but observable”模式：不影响主流程，但必须留下可检索信号（operation + error message）。

Tags: silent-failure, non-blocking, observability, quota, snapshot, session-reaper, tool-filter-hooks, fail-fast
- 2026-03-16 (补充): 第二批补强覆盖 HTTP handler 错误响应路径：
  - `src/server/handlers/handler-response-utils.ts`：client-response snapshot 写入/stream unpipe 的吞异常改为 operation 级 warning。
  - `src/server/handlers/handler-utils.ts`：`reportRouteError` 失败、SSE error 写入/结束失败、error snapshot 写入失败不再静默。
  - `src/server/runtime/http-server/daemon-admin/status-handler.ts`：provider-quota reset fallback 的 `persistNow/refreshNow` 吞异常改为 warning。
- 2026-03-16 (继续补强): 清理了剩余一批 `.catch(() => {})` 静默点（index restart path / oauth lifecycle / oauth auth-code flow / validate / CLI start）。策略统一为：不改变 non-blocking 行为，但增加上下文日志；同时把 `index.ts` 中对 `reportCliError(...).catch(() => {})` 的冗余吞错改为直接 `await reportCliError(...)`，并在 `reportCliError` 内部记录 hub 上报失败原因。
- 2026-03-16 (验证补充): `npm run build:dev` 被 `verify:repo-sanity` 阻断（仓库存在未跟踪文件 `src/server/runtime/http-server/tmux-scope-cleanup-policy.ts`、`tests/server/http-server/tmux-scope-cleanup-policy.spec.ts`，与本次改动无关）；改用 `npx tsc -p tsconfig.json --noEmit` 完成类型验证并通过。

Tags: silent-failure, non-blocking, cli-restart, oauth, validate-command, start-command, observability
- 2026-03-16 (验证最终): 后续 `verify:repo-sanity` 已恢复通过，随后完整 `npm run build:dev` 再次通过（含 install:global + health check + restart 5555）。

Tags: silent-failure, verification, build-dev, repo-sanity
- 2026-03-16 (继续推进): 新增收敛了一批 high-risk 静默失败点：
  - `src/utils/snapshot-writer.ts`：hook 加载失败、hook 写入失败、本地写盘失败、mkdir 失败均改为 non-blocking warning（server-snapshot）。
  - `src/providers/auth/oauth-auth.ts`：token 持久化失败不再静默，改为 OAuth debug 日志。
  - `src/providers/auth/tokenfile-auth.ts`：qwen token 路径探测/回退路径扫描的吞异常改为 OAuth debug 日志，避免 token 源探测失效无信号。
  - `src/server-lifecycle/port-utils.ts`：端口快速探测关键 catch 分支改为 lifecycle 事件 `port_utils_non_blocking_error`，保留流程不阻断。
  - `src/commands/validate.ts`：server 启停阶段 SIGTERM/SIGKILL 失败与 cleanup 失败改为 warning（verbose 或显式 cleanup 场景），不再静默。
- 2026-03-16 (验证): `npx tsc -p tsconfig.json --noEmit` 通过；`npm run verify:repo-sanity` 通过；`npm run build:dev` 通过（含 install:global + health check + restart 5555）。

Tags: silent-failure, snapshot-writer, tokenfile-auth, oauth-auth, port-utils, validate, non-blocking, observability
- 2026-03-16 (继续推进): 修复 `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts` 的断链问题并补齐可观测性：
  - 修正 `directives/actions` 类型与返回形状不一致、被破坏的正则文本替换语句，恢复编译。
  - 新增 heartbeat 指令持久化非阻断日志：`setHeartbeatEnabled`/`startHeartbeatDaemonIfNeeded` 失败改为带 tmuxSessionId/action/intervalMs 的 warning（仍不阻断主请求）。
  - `src/providers/auth/oauth-lifecycle.ts` 新增统一 `logOAuthLifecycleNonBlockingError(...)`，把 camoufox verify open、interactive lock 读写/回收、iflow auto-failure state 读写、Gemini service 响应 JSON 解析等吞异常点改为上下文 debug/warn。
- 2026-03-16 (验证): `npx tsc -p tsconfig.json --noEmit` 通过；`npm run verify:repo-sanity` 通过；`npm run build:dev` 通过；`npx jest tests/servertool/servertool-heartbeat.spec.ts --runInBand` 11/11 通过。

Tags: silent-failure, heartbeat-directives, oauth-lifecycle, non-blocking, observability, build-dev, heartbeat-spec

## Marker 生命周期收敛（2026-03-16）

- 2026-03-16: marker 语法剥离与生命周期入口进一步收敛到唯一真源 `sharedmodule/llmswitch-core/src/conversion/shared/marker-lifecycle.ts`。
  - 统一负责：
    - 扫描任意 `<**...**>` 完整 marker；
    - 扫描未闭合 `<**...` 到行尾；
    - 剥离消息正文中的 marker 语法；
    - 清理 `request.messages` 与 `semantics.responses.context.input` 两条请求链路。
  - 规则明确为：**不论 marker 是否合法，语法都必须被剥离，绝不允许污染 provider request。**
- 2026-03-16: `chat-process-heartbeat-directives.ts` 已改为复用统一 marker 模块做最新 user 消息剥离，只在 `hb:on` / `hb:off` / `hb:<number>[smhd]` 时产生命令语义；非法 heartbeat marker 仅剥离、不生效。
- 2026-03-16: `router/virtual-router/stop-message-markers.ts` 已改为复用统一 marker 模块：
  - marker 检测不再自己维护正则；
  - stopMessage 清理直接走统一 in-place cleaner；
  - ANSI 日志颜色字面量改回 `\\x1b` 转义，避免文件中混入裸 escape 字符。
- 2026-03-16: `req_process_stage2_route_select` 也改为走统一 marker cleaner，避免 route select 后仍依赖另一套 native-only marker 清理逻辑，保证 request path 的 marker 剥离真源唯一。
- 2026-03-16: 兼容层 `routing-stop-message-parser.ts` 现在仅作为统一模块 re-export，旧入口不再承载独立实现。
- 2026-03-16: 回归验证：
  - `npm run jest:run -- --runInBand --runTestsByPath tests/servertool/stopmessage-marker-module.spec.ts tests/servertool/chat-request-marker-strip.spec.ts tests/servertool/servertool-heartbeat.spec.ts`
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
  - `cd sharedmodule/llmswitch-core && npm run build`
  - `npm run build:dev`
  - 其中首次 `build:dev` 被 `verify:repo-sanity` 阻断，根因是新建 marker 文件/测试尚未 git add；补 `git add` 后再次构建通过。

Tags: marker, stopmessage, heartbeat, clock, request-sanitizer, route-select, ssot, syntax-strip, lifecycle, build-dev
