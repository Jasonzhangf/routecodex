# RouteCodex Memory

- 2026-05-27: Windsurf 账号管理 Phase 1 完成：删除 `WindsurfQuotaHealthSnapshot`、`WindsurfManagedCredentialEntry` 类型；删除 `readManagedWindsurfAuthConfigDetailed`、`extractQuotaHealthFromUserStatusPayload`、`isWindsurfAccountModelSupported`、`rankManagedCredentialsByHealth`、`selectManagedCredentialForSession`、`fetchWindsurfUserStatusForHealth`、`markCurrentAliasQuotaExhausted`、`computeAccountConcurrencyCapacity`、`assertManagedAccountPoolSelectable`、`resolveManagedAccountPoolCooldownMs` 等 17+ 方法；`selectWindsurfAccount` 简化取消旧多账号健康管理逻辑。Phase 2 新建：`windsurf-account-store.ts`（持久化账号状态，JSON 原子写）、`windsurf-account-pool.ts`（候选过滤 + sticky session + 排序）、`windsurf-account-session-manager.ts`（refresh 去重锁）。Provider 接入选 `selectWindsurfAccount` 使用 pool，`markWindsurfSessionActive/Stopped` 恢复真实实现，`clearManagedWindsurfSessionCredential` 回写 `pool.markAuthInvalid`。Phase 1 删除 ~350 行，Phase 2 新建 3 文件共 ~290 行。5 个测试已删除 Phase 1 API 的 context-continuity RED 测试已清理（15→10 个测试，全绿）。47 个 provider RED 测试不涉及 Phase 1 API，保留为已知失败的预写测试（登录链、RCC 文本协议、Cascade 生命周期）。VR 编译通过（0 新增错误，仅 2 pre-existing Rust native binding 错误），123 VR 测试全绿。

Tags: windsurf, account-management, phase-1-cleanup, phase-2-pool, sticky-session, account-store, session-manager, red-test-cleanup, 2026-05-27

- 2026-05-27: Virtual Router Prefer 指令完全删除（7 文件）：`instructions/types.rs`、`state.rs`、`parse_instructions.rs`、`routing_state_store.rs`、`routing/selection.rs`、`process_mode.rs`、`engine/route.rs`、`engine/selection.rs`。Direct Mode 双路径合并（`route.rs`），Route Queue 二次重建消除（`selection.rs`），Feature Turn-State 合并（`features.rs`）。Provider 特判移除（6 文件）：`routing/direct_model.rs`（Qwen 媒体回退改为通用能力检测）、`engine/events.rs`（series 冷却改为配置 `profile.series`，auth 黑名单改为 `authFamily` 字段）、`routing/config.rs`（删除 `build_route_candidates` 死代码）、`provider_registry.rs`（添加 `series`/`authFamily` 字段、删除 `has_default_capability`、新增 `list_by_auth_family()`）。Red-test 新增验证：`no_provider_ids_are_hardcoded_in_virtual_router_or_hub_pipeline_code` 扫描 `~/.rcc/provider/` 目录检测硬编码。

Tags: virtual-router, prefer-removal, provider-hardcode-removal, direct-mode-merge, route-queue-cleanup, feature-state-merge, red-test, 2026-05-27

- 2026-05-27: Responses→Chat 格式转换修复 deepseek 400 问题：transport 层两处转换入口 — `openai-sdk-transport.ts`（VercelAiSdk 路径 `executePreparedRequest`）和 `chat-protocol-client.ts`（HTTP 路径 `buildRequestBody`）。Responses 请求路由到 Chat completions provider 时做 `input`→`messages` 转换，不在 VR 或 provider 层做，避免重复转换。

Tags: responses-to-chat, transport-layer, deepseek-400, format-conversion, vercel-ai-sdk, chat-protocol-client, no-duplicate-conversion, 2026-05-27

- 2026-05-27: Provider 测试 store 隔离引入：context-continuity 测试使用 temp dir + `afterEach` 清空，避免跨测试污染账号状态。通过环境变量 `ROUTECODEX_WINDSURF_ACCOUNT_STORE_PATH` 覆盖默认路径。

Tags: test-isolation, temp-dir, account-store, aftereach-cleanup, windsurf, 2026-05-27

- 2026-05-23: Windsurf hybrid tool protocol 的当前目标真源是：native-supported tools 默认透明转译到 Cascade structured protocol（`windsurf_native_mode=true` + `tool_allowlist`），unsupported tools 走 RCC text-tool protocol；禁止引入 native bridge 默认 off / env-gated 这类能力路由 gating。

Tags: windsurf, hybrid-tools, native-default-on, rcc-unsupported, no-gating, 2026-05-23


- 2026-05-23: Windsurf unsupported-tool fence 命名已统一为 RCC；Windsurf 相关文档、实现和测试中不得使用其他平台历史协议名作为当前协议名；其他平台的历史协议命名不得回写到 Windsurf 事实。

Tags: windsurf, RCC, protocol-naming, fact-hygiene, 2026-05-23

- 2026-05-22: Windsurf provider 当前唯一事实已重收敛：设计入口为 `docs/providers/windsurf-chat-provider-design.md`，工具协议细节为 `docs/design/windsurf-cascade-tool-protocol.md`。聊天主链唯一允许 `local managed LS gRPC -> StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/GetCascadeTrajectory poll`；工具调用唯一目标为 Cascade structured protocol：`planner_mode=DEFAULT(1)` + `CascadeToolConfig.tool_allowlist(field32)` + trajectory fields `45/47/49/50` + tool result `additional_steps(field9)`。`GetChatCompletions` / `GetChatMessage` cloud JSON、`tools_preamble` / `function_call` / `<tool_call>` 文本注入与 harvest 都是废弃事实，不能再作为实现或测试依据；unmapped arbitrary tool 在未证明 custom/MCP request-side 入口前必须 fail-fast。

Tags: windsurf, cascade-tool-protocol, tool-allowlist, additional-steps, no-text-harvest, no-getchatcompletions, 2026-05-22

- 2026-05-22: Windsurf 文档事实清理规则已固定：当前事实只允许落在 `docs/providers/windsurf-chat-provider-design.md` 与 `docs/design/windsurf-cascade-tool-protocol.md`；audit/goal/note 只能保留历史取证并必须标注 superseded。若发现 `GetChatCompletions`、cloud JSON baseurl、`tools_preamble`、文本 harvest、`~/.routecodex` 被写成当前事实，必须立即改为废弃事实或删除；后续实现前必须先补黑盒锚点，改完由 agent 自己测试/构建/安装/重启/smoke。

Tags: windsurf, docs-ssot, fact-hygiene, no-text-protocol, self-smoke-before-user, 2026-05-22

- 2026-05-21: Windsurf provider 真源边界已收口。固定参考只允许：`/Volumes/extension/code/WindsurfAPI`。已验证稳定真相：
  1. `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 已扩展到 108/108 全绿；
  2. auth/token persistence、PostAuth header-only empty proto body、auth-context headers、assistant/tool_result/history/responses parse 全部已由测试锚定；
  3. 已验证成功链：
     - 直接 `devin-session-token$...` 可作为最终认证真源；
     - 账号密码 -> `auth1` -> `WindsurfPostAuth` -> `devin-session-token$...`；
     - persisted stale token 命中 401 后，会清理旧 token、重新登录、持久化 refreshed token，并完成下一次推理；
     - 认证成功后可返回 assistant text；
     - 旧记录中“assistant tool_calls / tool_result / conversation 上游序列化已完成”的说法属于 2026-05-21 旧路径语境，已被 2026-05-22 Cascade structured tool protocol 事实覆盖；
  4. 认证最终真源统一收敛为 `devin-session-token$...`；测试样本、probe 样本都应优先使用该形状，不再把 generic `session-token-*` 当 Windsurf 最终凭证真相；
  5. 后续若再看到任何“旧 send 主线已恢复/真主链已接回”叙事，均视为错误旧叙事，应直接删除，不得据此恢复 send path。

Tags: windsurf, cascade, auth, postauth, token-persistence, historical-note, superseded-by-2026-05-22-tool-protocol, 2026-05-21

## Skills 与调试工作流

- 2026-05-21: Windsurf / responses 链路边界已校正：**provider -> inbound(very thin) -> chat_process -> outbound responses**。chat inbound 只做最薄的协议归一和字段透传，不承载 provider-specific 兼容逻辑；provider 也不应把 client surface 语义一路耦合进 pipeline。可复用规则：当 live `/v1/responses` 仍漏成 `chat.completion`，优先查 chat_process/outbound 的最终重建层，而不是把 provider inbound 当成兼容主战场。

- 2026-04-17: virtual router 的 routing bootstrap 真源继续前移到 Rust：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/bootstrap.rs` 新接管 `normalizeRouting + expandRoutingTable`，并通过 native `bootstrapVirtualRouterRoutingJson` 回给 TS 薄壳；`bootstrap.ts` 不再直接执行 TS `routing-config` 语义。验证链：`npm run build:ci --prefix sharedmodule/llmswitch-core`、`node sharedmodule/llmswitch-core/scripts/tests/virtual-router-pool-mode.mjs`、`npm run jest:run -- --runTestsByPath tests/sharedmodule/virtual-router-loadbalancing-targets.spec.ts tests/sharedmodule/virtual-router-routing-model-validation.spec.ts`、真实 `/Volumes/extension/.rcc/config.json` dry-run 命中 `crs/duck/wuzu/glm-5/kimi-k2.5`。

- 2026-04-16: 如果线上日志出现 `thinking/forced` / `tools/forced`，优先不要怀疑配置路径；先查 `~/.rcc/sessions/.../session-*.json` 是否被写入 `forcedTarget`。可复用规则：`servertool` 注入的 `__shadowCompareForcedProviderKey`、`disabledProviderKeyAliases`、`disableStickyRoutes` 都只能作用于**本次 selection**，不得持久化进 session routing state。

Tags: virtual-router, metadata-force, forcedTarget, session-state, thinking-forced, servertool-followup, no-persist, 2026-04-16

- 2026-04-16: Provider v2 新增独立 provider 时，`provider/<dir>/config.v2.<suffix>.json` 不能再默认为“被 loader 自动识别”。可复用规则：要么 loader 显式支持 suffixed v2 文件并把它们当 standalone provider，要么改成独立目录；否则“文件已加、路由不认识”会被误判成路径/缓存问题。

Tags: provider-v2-loader, suffixed-config, standalone-provider, config.v2, routing-miss, 2026-04-16

- 2026-04-16: servertool followup 最终错误出口不要一边 `console.warn([RequestExecutor] ServerTool followup failed...)`，一边再打 `convert.bridge.error`；可复用规则：`markServerToolFollowupError(...)` 只负责打 `provider.followup` stage marker 与默认状态，真正对外日志统一走 `convert.bridge.error`。

Tags: servertool, followup, final-error-exit, convert-bridge-error, provider-followup, single-visible-log, 2026-04-16

- 2026-04-16: executor 壳层的 non-blocking 日志（如 `request-retry`、`provider-response-converter`）要共用同一个 stackless + throttled helper，避免每个文件各自维护 `formatUnknownError + throttle Map` 再次分叉。

Tags: executor, non-blocking-log, shared-helper, request-retry, provider-response-converter, stackless, throttled, 2026-04-16

- 2026-04-16: qwen malformed remap 不能只依赖 `compatibilityProfile/providerId` 这类上下文元数据。可复用规则：像 hidden native tool、business rejection、incomplete RCC opener、partial RCC recover 这类 qwenchat 异常，必须同时允许 **payload 形状信号** 直接判定；否则线上缺 metadata 的样本会漏回 `MALFORMED_RESPONSE`。

Tags: qwenchat, malformed-response, payload-signals, hidden-native-tool, business-rejection, incomplete-rcc, provider-response-converter, 2026-04-16

- 2026-04-16: `request-retry` 的 non-blocking 日志若直接打 stack，会在 client-inject/session-binding 异常风暴里把控制台刷爆。可复用规则：这类观测日志必须至少做到 **stackless + 同 stage/同错误短窗口节流**，保留短原因即可，不要把整个 stack 作为默认输出。

Tags: request-retry, non-blocking-log, throttling, stackless, client-inject, session-binding, log-storm, 2026-04-16

- 2026-04-16: 静默失败治理闭环后，门禁要同时覆盖三类形态：`catch {}`、`catch { return null/false }`、`.catch(() => null/false)`。证据路径固定为 `scripts/ci/silent-failure-audit.mjs` + `tests/scripts/silent-failure-audit.spec.ts`，后续新增 runtime 热路径 catch 时必须先过这两个入口。

Tags: silent-failure, audit-gate, catch-return-null, catch-return-false, promise-catch-null, promise-catch-false, runtime-hotpath, 2026-04-16

- 2026-04-16: `reasoning_stop_guard/continue` 这类 servertool followup 要保原 provider/alias 时，**不要只从 `adapterContext.providerKey` 取 pin**；线上常只有 `adapterContext.target.providerKey`。可复用规则：followup provider pin helper 至少回落 `target.providerKey`，否则会掉回默认路由池并串到别的模型。

Tags: servertool, reasoning-stop, followup, provider-pin, adapter-context, target-provider-key, route-leak, 2026-04-16

- 2026-04-16: `provider.followup` 是 **inner followup orchestration stage**，不是 outer 主请求继续 reroute 的信号。可复用规则：inner followup 可以在自己的请求链内重试，但 outer `RequestExecutor` 一旦收到显式 `provider.followup` stage，就必须 fail-fast，避免把 followup 失败放大成主请求 provider 风暴。

Tags: provider-followup, outer-fail-fast, retry-amplification, request-executor, servertool, 2026-04-16

- 2026-04-16: servertool 的**请求标准化 / 响应标准化**要先在 Host 壳层做共享 helper，不能让 `executor-response.ts` 和 `provider-response-converter.ts` 各自维护一套 session/stopless backfill 与 SSE wrapper 拼装。可复用规则：先抽单点 `servertool-request-normalizer` / `servertool-response-normalizer`，再让后续骨架化从这两个 helper 继续往内收。

Tags: servertool, request-normalization, response-normalization, executor-response, provider-response-converter, shared-helper, host-shell, 2026-04-16

- 2026-04-16: stopless 对 **SSE wrapper** 也必须硬校验。可复用规则：只要 bridge 最终返回的是 `__sse_responses` 包装体，就必须同时携带 `__routecodex_finish_reason` 与 `__routecodex_reasoning_stop_finalized`；`RequestExecutor` 不得因为看见 `__sse_responses` 就直接跳过 stopless 检测，否则会把 `finish_reason=stop` + 无 finalized marker 的假成功 200 透传给客户端。

Tags: stopless, sse-wrapper, reasoning-stop, finalized-marker, request-executor, no-silent-success, 2026-04-16

- 2026-04-16: servertool 的 **SSE wrapper 组装** 也要单点化。可复用规则：`executor-response.ts`、`provider-response-converter.ts`、以及 recovered/tool-salvage 分支，都必须复用同一个 wrapper builder（当前 `buildServerToolSseWrapperBody(...)`），不要再各自手拼 `__sse_responses` / `finish_reason` / finalized flag。

Tags: servertool, sse-wrapper, response-normalization, single-builder, executor-response, provider-response-converter, recovered-flow, 2026-04-16

- 2026-04-16: quota/alias 归一也要守唯一真源。可复用规则：凡是 quota snapshot、provider-quota daemon、quota view 会读取 providerKey 的地方，都必须先走同一个 `canonicalizeProviderKey(...)`；对 antigravity legacy `N-alias` key 若不先归一，就会出现“快照恢复一套 key、运行时上报另一套 key”的双状态分裂。

- 2026-04-16: antigravity OAuth reauth-required 403 不应只冷却单模型。可复用规则：这类错误本质是 alias/token 失效，quota daemon 必须对同 alias 的 providerKey 做 **fanout cooldown**；否则 router 会立刻切到同 alias 其他模型继续撞坏 token，形成“看起来在切 provider，实际还在打同一坏凭证”的假切换。

- 2026-04-16: HubPipeline 自己也不能再直连 legacy center。可复用规则：如果 routerEngine 需要消费 provider success/error，优先直接注册到 `provider-runtime-ingress`；Host bridge 不要再包一层“构造后卸载旧订阅再重挂新订阅”的 wrapper。判断是否收口成功的最小证据：全仓 `providerErrorCenter/providerSuccessCenter.subscribe(...)` 只剩 ingress 一处。

- 2026-04-16: provider error reporting 的**装配口径**也要单点化。可复用规则：`runtime_resolve`、`provider.send` 不要各自手拼 `errorCode/upstreamCode/statusCode/stageHint`；统一先过单一 helper（当前 `resolveRequestExecutorProviderErrorReportPlan(...)`），再交给 `reportRequestExecutorProviderError(...)`，避免 `provider.sse_decode`、`provider.followup`、`provider.runtime_resolve` 的阶段判断再次分叉。

- 2026-04-16: `resolveRequestExecutorProviderErrorReportPlan(...)` 自己也要先读显式 stage marker。可复用规则：不要要求外层先手动 `resolve fallback stage` 再传进 reporter；helper 本身就应优先解析 `requestExecutorProviderErrorStage`（含 `details`），外层只提供默认 stage。这样 followup / SSE / HTTP / runtime-resolve 的阶段装配才能真正维持单点真源。

Tags: provider-error-reporting, stageHint, sse-decode, followup, runtime-resolve, request-executor, ssot, 2026-04-16

- 2026-04-16: `converted` 出来的 retryable HTTP 401/429/5xx 也不能在 try 内先 `emitProviderError('provider.http')`，再到外围 catch 再报一次；这会形成**同一次 provider 失败双上报**。可复用规则：这类错误只打一个 stage marker（当前 `requestExecutorProviderErrorStage='provider.http'`），统一让外层 `reportRequestExecutorProviderError(...)` 上报一次。

Tags: provider-http, double-report, single-report, converted-status, request-executor, provider-error-reporting, 2026-04-16

- 2026-04-16: `provider.followup` 必须整体视为 **health-neutral orchestration error**。可复用规则：servertool/client-inject/followup-payload 这类 followup 内部错误，虽然可能是 `recoverable=false`、`status=502`，但**不能污染 provider 健康**；`RequestExecutor` 要按 stage 直接判定 `affectsHealth=false`，`emitProviderError(...)` 也必须显式尊重调用方传入的 `affectsHealth=false`，不能再用“non-recoverable 一律 affectsHealth=true”覆盖。

Tags: provider-followup, affects-health, health-neutral, servertool, client-inject, provider-error-reporter, request-executor, 2026-04-16

- 2026-04-16: followup stage 不要只靠 `SERVERTOOL_*` code 猜。可复用规则：在 converter 源头就给 followup 错误打 `requestExecutorProviderErrorStage='provider.followup'`，让 request-executor 优先读 stage marker，而不是继续在外层用 code 前缀做弱推断。

Tags: provider-followup, stage-marker, converter, request-executor, no-code-prefix-guess, 2026-04-16

- 2026-04-16: `provider.sse_decode` 也不要只靠 `SSE_DECODE_ERROR/HTTP_502/message contains sse` 猜。可复用规则：SSE wrapper / bridge SSE remap 这种源头一旦确认是解码链路，就直接打 `requestExecutorProviderErrorStage='provider.sse_decode'`；legacy `executor-response` 也要同步，避免同一种 SSE 错误在新旧链路上阶段口径不一致。

Tags: provider-sse-decode, stage-marker, converter, executor-response, request-executor, no-string-guess, 2026-04-16

- 2026-04-16: `client-injection-flow` 自己产出的 strict tmux / inject 失败也必须在**源头**打 `requestExecutorProviderErrorStage='provider.followup'`。可复用规则：不要等 converter / request-executor 外层再靠 `SERVERTOOL_FOLLOWUP_FAILED` 或 `client_inject_failed` 猜 stage；能在 host 内部创建错误对象的地方，直接带 marker。

Tags: client-injection-flow, provider-followup, stage-marker, host-source, request-executor, no-late-guess, 2026-04-16

- 2026-04-16: 当 retry 已经有 execution orchestrator 后，**telemetry 也要继续单点化**。可复用规则：`provider-switch` 的 warn 字段与 `provider.retry` stage details 不要在 `runtime_resolve`、`provider.send` 各自手拼；统一交给单一 telemetry helper（当前 `buildProviderRetryTelemetryPlan(...)`），否则日志口径又会重新漂移。

Tags: provider-switch, retry-telemetry, logging, request-executor, ssot, telemetry-plan, 2026-04-16

- 2026-04-16: 当 retry 主链已经拆出 `eligibility / exclusion / switch / backoff` 四个 helper 后，下一步应继续压成**更高层 orchestrator**。可复用规则：`runtime_resolve`、`provider.send` 不要再各自手工串 `recordAttempt -> eligibility -> exclusion -> backoff -> switch`；统一收口到一个 async orchestrator（当前 `resolveProviderRetryExecutionPlan(...)`），把分支降成 thin shell，避免未来再出现“某一段 helper 已更新，但某个分支串接顺序还是旧的”。

Tags: provider-switch, retry-orchestrator, request-executor, thin-shell, ssot, execution-plan, 2026-04-16

- 2026-04-16: provider retry 的**资格判定**也要单点化。可复用规则：`runtime_resolve`、`provider.send` 不要各自手写 `attempt < maxAttempts`、blocking recoverable、`promptTooLong` budget、Antigravity `verify/reauth` 的 retry 条件；统一收口到单一 helper（当前 `resolveProviderRetryEligibilityPlan(...)`），避免一侧允许重试、另一侧提前 fail-fast。

Tags: provider-switch, retry-eligibility, ssot, prompt-too-long, antigravity, recoverable, request-executor, 2026-04-16

- 2026-04-16: provider retry 的**排除策略本身**也要单点化。可复用规则：`promptTooLong`、Antigravity `verify/429`、`reauth`、alias rotate 这些“是否排除当前 provider / 是否给 antigravity signal 打 `avoidAllOnRetry`”的判断，不要散落在 send/followup 分支里手写；统一收口到单一 helper（当前 `resolveProviderRetryExclusionPlan(...)`），否则 reroute 行为和日志原因会再次漂移。

Tags: provider-switch, exclusion-policy, antigravity, prompt-too-long, retry-ssot, request-executor, 2026-04-16

- 2026-04-16: provider retry 的 `switchAction/decisionLabel/runtime-scope exclude` 也要有**单一装配点**。可复用规则：`runtime_resolve`、`provider.send`、后续 followup 分支不要各自手拼 `exclude_and_reroute` / `retry_same_provider`、`decisionLabel`、`runtimeScopeExcludedCount`；统一走单点 helper（当前是 `resolveProviderRetrySwitchPlan(...)`），避免一边修了 backoffScope/日志口径，另一边还在沿用旧判断。

Tags: provider-switch, retry-switch-plan, ssot, runtime-scope-exclude, request-executor, no-duplicate-assembly, 2026-04-16

- 2026-04-16: provider-switch/backoff 再补一条调度规则：**如果当前 retry decision 已经是 `exclude_and_reroute`，backoff 必须按 provider 维度计数，不能继续沿用“全请求 attempt 指数退避”。** 否则会出现“A 失败 1s、切到 B 却变 2s、C 又 4s”的假全局抬升，用户体感像调度在无脑放大全局惩罚。可复用规则：同 provider 失败才累计；换 provider 后，generic reroute backoff 应从该 provider 自己的近期计数重新算。

Tags: provider-switch, backoff, exclude-and-reroute, provider-scoped, no-global-attempt-escalation, request-executor, 2026-04-16

- 2026-04-16: provider-switch 日志口径也要跟着调度收口。可复用规则：日志里至少显式区分 **`switchAction`、`decisionLabel`、`backoffScope`、`stage`**；否则用户看到的只是“又切了、又等了”，无法判断到底是“当前 provider 自己 backoff 后 reroute”，还是“recoverable 同 provider 重试”。推荐口径：`decision=provider_backoff_then_reroute|recoverable_backoff_same_provider|...`，并把 `backoffScope=provider|recoverable|attempt` 单独打出来。

Tags: provider-switch, logging, decision-label, backoff-scope, stage, request-executor, observability, 2026-04-16

- 2026-04-16: 错误处理收口继续验证后确认，**provider 执行期错误主链不能再双上报到 Host error hub**。可复用规则：provider/runtime/send/convert/followup 这类执行期错误，只能走 `provider-error-reporter -> reportProviderErrorToRouterPolicy -> Virtual Router policy`；`RouteErrorHub / ErrorHandlingCenter` 只保留 HTTP/server/CLI 外层映射。若又看到某层同时 `emit providerErrorCenter`、`reportRouteError`、`registry.handleError` 三路并存，优先判定为“第二中心回流”。

Tags: error-policy, virtual-router, provider-runtime, no-double-report, route-error-hub-edge-only, second-center-regression, 2026-04-16

- 2026-04-16: stopless 静默失败再补一条验收规则：**`stopless=on/endless` 只要响应结束，却没有 `reasoning.stop` finalized marker，就必须显式失败，不能把“完成但没 finalize”的响应当成功返回。** 可复用规则：在 Host `RequestExecutor` 末端对完成态 body 做 finalized-marker 校验，命中后统一抛 `STOPLESS_FINALIZATION_MISSING`（502、retryable）；这样才能拦住“客户端直接停住但服务端看起来 200”的假成功。

Tags: stopless, reasoning-stop, finalized-marker, no-silent-success, request-executor, retryable-502, 2026-04-16

- 2026-04-15: 全局错误处理收口决策确认：**不要保留独立 `error-handling center` / event engine**。可复用规则：如果某个“中心”只做 `emit/subscribe/normalize`，却不掌握 retry/reroute/backoff/fail/cooldown policy，它就不是策略真源，只会制造第二中心。RouteCodex 这类请求执行错误语义应直接收口到 **Virtual Router policy**；`RequestExecutor` 与 `servertool engine` 只消费同一套 Router decision，前者负责执行，后者只保留 followup 编排前/internal error 边界。

Tags: error-policy, virtual-router, no-second-center, no-event-bus, request-executor-consumer, servertool-boundary, 2026-04-15

- 2026-04-15: 排查“**路由池未耗尽却把 429 直接漏给客户端**”时，先检查 `request-executor` 是否把 `routingDecision.pool` 误当成“整条 route 已耗尽”的证据。真实语义：`routingDecision.pool` 只代表**本次命中的当前 tier/pool**；若它是单元素 `[currentProvider]`，**不能据此认定全路由只剩当前 provider**，因为后面仍可能有低优先级 fallback pool。可复用规则：429 下的“last available / single provider”判断，必须至少排除“当前只是 singleton tier”这种情况；否则会错误 `retry_same_provider`，把本应 reroute 的 429 漏给客户端。

- Tags: route-pool, 429-leak, singleton-tier, lower-priority-fallback, request-executor, retry_same_provider, 2026-04-15

- 2026-04-15: `provider-response-converter` 里的 **QwenChat malformed/business-rejection remap 必须有 provider 作用域门**。可复用规则：不能仅凭 `MALFORMED_RESPONSE + 401/error.message` 就把 generic provider 错误改写成 `QWENCHAT_*`；至少要有 `compatibilityProfile/providerId/providerKey/raw` 里的 qwenchat 信号，否则会把普通 401 failover 链误短路。

- Tags: qwenchat, malformed-remap, provider-scope, generic-401, failover-short-circuit, provider-response-converter, 2026-04-15

- 2026-04-15: `reasoning.stop` 对 **plan mode / audit / 其它有意只读任务** 需要保留显式停止原因。可复用规则：工具定义里提供 `stop_reason=plan_mode`，并在说明中明确“若只读交付物已完成，则 `is_completed=true + stop_reason=plan_mode + completion_evidence` 即可停止”；不要把这类任务硬逼成“必须继续写动作”或伪装成 blocked。

- Tags: reasoning-stop, stopless, plan-mode, audit, readonly-task, stop-reason, completion-evidence, 2026-04-15

- 2026-04-15: RouteCodex 长时内存/虚拟内存继续上涨时，除了 `ctxMap / requestMetaStore`，还要优先查 **Responses retention 链**：`responses-reasoning-registry` 是否只有 consume 没有 TTL/max/prune，`buildChatResponseFromResponses` 是否在 registry + inline `__responses_*` + `id/request_id` 多 key 上重复保留同一大 payload。可复用规则：registry 必须有 **TTL + max + 读写前 prune**，多 key 必须 **alias 一次性 consume/clear**，并让同一 payload 在 registry / inline / alias key 间尽量**共享同一引用**，不要重复 deep clone。

Tags: memory, vm-growth, responses-retention, registry-prune, alias-consume, payload-snapshot, no-duplicate-clone, 2026-04-15

- 2026-04-14: stopless / reasoning.stop 再补一条硬规则：**不能为了逼出 `reasoning.stop` 而缩减真实工具面，也不能额外加一层“工具缺失/只能停机自查”的提示约束。** 正确做法是保持请求真实工具集合不变，只在 `reasoning.stop` 工具定义/校验上明确“未调用不得停止”；如果模型仍直接 stop，应继续修 guard/finalize/validator，不要用 `replace_tools` / `force_tool_choice` 这类越界手段改写真实能力面。验证信号：一旦 followup 出现“exec_command 不存在/工具不可用”之类自造阻塞，优先回查是否有人为砍掉工具面。

Tags: stopless, reasoning-stop, tool-surface, no-tool-surface-shrinking, no-extra-followup-constraints, validator-first, guard-finalize, 2026-04-14

- 2026-04-13: client canonical 响应链又补一条闭环：**resp_process/filter 层不能把 `exec_command` 的 `command` 偷修成 `cmd`，host converter 也不能把 `CLIENT_TOOL_ARGS_INVALID` 静默吞回原始 payload**。可复用规则：响应侧 `exec_command` 只做字符串化/保形，不做 alias-repair；一旦桥接后校验命中 `missing_cmd` 这类客户端契约错误，必须直接上浮明确错误，不允许 fallback 成“看起来成功”的 chat/response body。

- 2026-04-13: 文本工具 harvest 本轮验证出一个高收益稳定策略：**wrapper/container 先行，正文永不猜工具**。可复用规则：先在 Rust chat-process 响应侧统一 mask 掉 `RCC_TOOL_CALLS(_JSON)` heredoc、XML 顶层壳、bullet/fence 等 wrapper，再只解析容器内的顶层 tool shell；`bash -lc`、patch body、解释性 prose 一律当字符串/正文处理，不允许从正文反推 tool。请求侧则反过来配合：要求模型把文本工具调用放在**输出末尾**、放进**单独容器**、参数保持**原始肌肉记忆形状**（shell 单字符串、patch 原文），这样半截时也容易“补边界 / 整段切掉 / 明确 retryable”，不污染上下文。这个策略对 qwenchat 已体现出明显成功率提升，且适合作为 deepseek / qwen 共享的**响应侧收割框架**；差异只保留在 provider 级 guidance 强弱，不要把 Qwen 的强覆盖整包灌给 DeepSeek。
- 2026-04-13: 文本 harvest 还要守住一个负样本边界：**空容器不算成功**。`{"tool_calls":[]}`、只有 heredoc opener/closer、或容器内没有有效 tool name / arguments 时，不能把它视为“已经完成一轮工具调用”；应回落为正文、invalid 或 retryable。否则最容易造成 finish_reason 假 stop、空回复、以及“看起来格式对了但实际上啥也没收割到”的假成功。
- 2026-04-13: qwenchat 5520 真样本再补一条：**隐藏原生工具要双层 fail-fast，且 helper 不能依赖 allowlist 非空**。真实 SSE `mode=sse/raw` 里会直接吐 `web_search` / `web_extractor` 之类内建工具；如果 helper 只在 declaredToolNames 非空时才拦截，就会把原始流交给 bridge，进一步掉成 `MALFORMED_RESPONSE + finish_reason=unknown`。修法：helper 与 `provider-response-converter` 两边都把已知隐藏原生工具直接抛成 `QWENCHAT_HIDDEN_NATIVE_TOOL`。
- 2026-04-13: 主链取舍确认：**真实工具调用是主链，文本 dry-run/harvest 是兼容补救链**。系统目标不是“彻底禁止模型原生工具”，而是 RouteCodex 自己不依赖它，并在模型偷跑到原生工具、半截 dry-run 容器、或 malformed wrapper 时给显式错误/恢复，不要吞成成功响应。

Tags: text-harvest, wrapper-first, container-first, mask-wrapper, no-body-guessing, shell-transparent, patch-transparent, retryable-malformed, qwenchat, deepseek, shared-resp-harvest, provider-specific-guidance

- 2026-04-12: text-harvest 收口规则补充：文本工具兼容必须 **只解析顶层工具壳，不解析 shell 正文**。可复用规则：`exec_command / apply_patch / execute_command` 只按外层 `name/tag/wrapper/field alias` 做恢复，`bash -lc '...'` 内的 body 一律字符串透传，不拆命令、不修空格、不猜 shell 子命令；只要最终 payload 存在非空 `tool_calls`，`finish_reason` 就必须强制为 `tool_calls`，不得再被 metadata/status 覆盖成 `stop`。另外 qwenchat 与 deepseek-web 的 text guidance / harvest 必须共用同一套 chat-process 框架，差异只允许停留在 provider 通信层与路由配置。验证：Rust 回归 `responses_response_utils_resolve_finish_reason_prefers_tool_calls_then_metadata_then_status`、`response_codec_harvests_stop_heredoc_tool_calls_into_requires_action` 通过；5520/5555 在线样本恢复为 `finish_reason=tool_calls`。

Tags: text-harvest, tool-wrapper-only, shell-body-transparent, finish-reason-tool-calls, qwenchat, deepseek-web, shared-framework, chat-process, rust-regression, online-verification

- 2026-04-10: metadata/session 对称性补充：当 provider-request 里能看到 `session_id / conversation_id`，但 response/servertool/sticky scope 仍读不到时，根因通常不是“tmux 缺失”，而是 **metadata/runtime mapping 真层没有先产出 session identifiers**。可复用规则：不要在 transport 末端把 provider header 倒灌回 metadata；正确修复是先在 `buildProviderRequestHeaders` 前的 runtime metadata mapping 层生成/归一 `sessionId / conversationId`，再让 header builder 纯映射。native fallback 还要保证 **JSON 字符串先 parse 再 regex**，且 `user_id` 派生的 session 不要抢占 `conversationId`，否则会把 `codex_cli_conversation_*` 截断或覆盖，导致 stopless / stopMessage / sticky-session 读取错 scope。验证：定向 Jest `tests/providers/core/runtime/session-header-utils.unit.test.ts` + `tests/servertool/hub-pipeline-session-headers.spec.ts` 共 8/8 通过；在线 5520/5555 已升级到 `0.90.1035`。

Tags: metadata-symmetry, session-id, conversation-id, stopless, sticky-session, runtime-mapping, provider-headers, codex-cli, json-parse-before-regex, 0.90.1035

- 2026-04-10: qwen 偶发“聊一句就 stop”本轮已验证的主因之一是 **reasoning_content 在 Chat/Responses 映射链路里被清洗丢失**，既可能发生在请求侧历史 turn（assistant `reasoning_content` 被过滤），也可能发生在响应侧语义清洗/SSE 聚合（cleaned reasoning 未优先回填客户端 payload）。可复用规则：凡是思考型模型出现异常 stop、只嘴炮不调工具、或 Chat Completions 明显比 Responses 更容易断，先逐跳对比 inbound/outbound/replay 的完整 payload，确认 `reasoning_content`、system、history、tool_calls 没有在 compat/filter/cleanup 阶段被删改，再看 header / UA / session id。修复后验证：`0.90.1014` 在线 qwen `/v1/responses` 样本可见 `tool_calls=16`、`stop=0`，主动停下来的频率明显下降。

Tags: qwen, reasoning-content, chat-completions, responses, stop, payload-transparency, sse-aggregation, cleanup, replay, online-verification, 0.90.1014

- 2026-04-10: qwen/provider 排障的高收益动作不是先改提示词，而是先做 **全量 payload/工具面对比**。可复用规则：当 provider 看起来“没开 thinking”“不调工具”或“莫名 stop”时，先抓原始样本并比较客户端入站 tools 与 provider 出站 tools、system、历史上下文、finish_reason、tool_calls；禁止只看摘要快照下结论。尤其要确认真实传输 payload 不被裁剪：允许裁 debug/snapshot，但不允许裁真实 request/response 语义。若问题只在某协议面（如 Chat Completions）出现，优先做同请求 dry-run/replay 对比该协议与 Responses 的字段差异，再决定修 compat。 

Tags: qwen, provider-debug, full-snapshot, tool-transparency, payload-audit, dry-run, replay, protocol-diff, no-semantic-trimming

- 2026-04-11: stopless / reasoning.stop 继续失效时，先检查 **servertool guard 触发条件是否错误地读了 response 而不是 request/session state**。这次根因是 `reasoning-stop-guard` 在 post-hook 里用 `ctx.base.tools` 判定 `reasoning.stop` 是否存在，但 `ctx.base` 实际上是模型响应，不是原始请求，导致 guard 被误判为 miss、stopless 形同关闭。可复用规则：post-phase auto hook 需要读请求工具或会话开关时，优先用 `capturedChatRequest` / session sticky state；不要从 response payload 反推 request tools。验证：`tests/servertool/reasoning-stop-guard.spec.ts` + `tests/servertool/reasoning-only-continue.spec.ts` 21/21 通过；5520/5555 热重载后均为 `0.90.1044`。

Tags: stopless, reasoning-stop, servertool, post-hook, request-vs-response, capturedChatRequest, sticky-state, qwen, 0.90.1044

- 2026-04-10: qwen `finish_reason=stop` 深挖补充：若 headers/UA 已和 Qwen CLI 对齐，但工具场景仍异常 stop，优先检查 `chat:qwen` 是否**改写了非 system messages/history**。Qwen CLI 真正只做 system envelope 注入/合并；对 assistant/tool 历史的空 turn 删除、tool_call_id 回填、tool_calls id 改写都会破坏 proxy 透明性，并可能触发 qwen 在长上下文下更容易 stop。最小正确修复是：除首条 system envelope、provider 模型映射、`reasoning.effort -> reasoning_effort`、必要 token clamp 外，不动非 system history。验证：Jest qwen profile 回归通过，build:min + install:global + SIGUSR2 后 5555 升级到 0.90.998；在线 `qwen.qwen3.6-plus` 普通请求返回 `OK`，强制工具请求返回 `requires_action` + function_call。

Tags: qwen, finish-reason-stop, proxy-transparency, message-history, system-envelope-only, qwen-cli-alignment, tool-calls, build-min, install-global, sigusr2, online-verification

- 2026-04-10: qwen OAuth 多账号实操沉淀：4 个别名 token（`geetasamoda / jasonqueque / antonsoltan / xfour8605`）全部通过各自**隔离 Camoufox profile**补齐成功。可复用动作：每个账号只用对应 `rc-auth.<alias>` / `rc-qwen.<alias>`，成功后立刻 `camo stop` 关闭；对未登录 alias，不要在 `rc-qwen.<alias>` 里硬等自动 selector，而是先在 `rc-auth.<alias>` 走 `chat.qwen.ai/auth?user_code=...` → Google account chooser → Qwen 已登录首页，再回到 `authorize?user_code=...` 点击 `.qwen-confirm-btn` 完成 device-code 授权。反模式：不同 alias 混用 profile、成功后不关浏览器、在 Google consent 页用宽泛 selector（如 `button:last-of-type`）误点到无关按钮。验证：`~/.rcc/auth/qwen-oauth-{3,4,5,6}-*.json` 全部为 `status=success`，`camo status` 最终 `count=0`。

Tags: qwen-oauth, multi-account, camoufox, isolated-profile, device-code, manual-confirm, account-leak-prevention, token-success, browser-cleanup

- 2026-04-07: 继续去重 session 清理路径中的 tmux 活性探针：`cleanupSessionStorageOnStartup` 与 `cleanupDeadTmuxSessionsFromRegistry` 引入单轮 memoized liveness cache，避免同一 tmuxSession 在一轮清理中被重复探测。与 tmux-probe TTL 缓存叠加后，进一步减少子进程探测开销。验证：session-storage-cleanup/session-client-registry/session-client-routes.stopmessage-cleanup 回归通过。

Tags: performance-budget, session-cleanup-memoization, tmux-liveness-dedup, process-spawn-reduction, registry-cleanup, startup-cleanup

- 2026-04-07: 继续 process 开销优化：`isTmuxSessionIdleForInject` 新增短 TTL 缓存（与 alive/workdir 共用 1200ms + 256 容量预算），仅缓存布尔结果，异常不缓存；并在注入前后清理/回写 cache，减少 heartbeat 周期中的 `tmux list-panes/capture-pane` 子进程开销。验证：`tmux-session-probe.spec` 新增 idle-cache 用例（list-panes/capture-pane 各 1 次）通过。

Tags: performance-budget, tmux-idle-cache, heartbeat-overhead, process-spawn-reduction, ttl-cache, cache-budget, runtime-stability

- 2026-04-06: 继续性能优化（process/thread 开销）：为 `tmux-session-probe` 增加短 TTL 探针缓存（默认 1200ms）与容量上限（默认 256），覆盖 `isTmuxSessionAlive`/`resolveTmuxSessionWorkingDirectory`，并在 tmux kill/注入路径更新缓存状态，减少高频 `spawnSync('tmux', ...)` 子进程创建。验证：新增 `tmux-session-probe.spec` 缓存用例（重复探针仅 1 次 has-session 调用）并通过。

Tags: performance-budget, tmux-probe-cache, spawnsync-reduction, process-overhead, ttl-cache, cache-budget, session-runtime

- 2026-04-06: 性能/预算审查沉淀：snap 模式下请求/响应历史大块禁止深拷贝，统一采用 `mmap-hint` 摘要（仅采样/限深/限键）后再落盘；并在 runtime setup 增加 `provider-traffic` 当前进程状态 reset，避免热重启后旧并发租约残留导致虚假饱和。验证链：`npx tsc --noEmit` + `provider-traffic-governor.spec` + `request-executor.single-attempt.spec` 通过。

Tags: performance-budget, mmap-hint, zero-copy-summary, snapshots, provider-traffic, runtime-reload, concurrency-reset, verification

- 2026-03-22: apply_patch 兼容修复第二轮收口（routecodex-273）：根因是 `compat_fix_apply_patch::fix_apply_patch_tool_calls_json` 在 payload 缺少 `messages` 时会提前返回，导致 `input.function_call` 路径根本未修复；同时 add-file 归一化对行末统一 `trim_end` 会放大空行/尾空白语义偏差。修复策略：仅在 Rust 真源改造——(1) messages/input 双路径独立处理，不再依赖 messages 存在；(2) arguments 支持 string/object/array wrapper 语义提取后统一归一；(3) add-file 归一化保留空行（`\n+\n`）与原始内容，不再对非 header 内容做 `trim_end`。验证闭环：replay original-shape + control、Jest apply-patch 三件套、Rust compat/blankline 单测、sharedmodule build:ci、根仓 build:dev、install:release 全部通过。  

Tags: apply-patch, compatibility, input-function-call, blank-line, wrapper-shape, rust-core, no-ts-feature, routecodex-273, replay, build-dev, install-release

- 2026-03-22: 修复 apply_patch 兼容性回归（避免多次重试）：在 Rust `compat_fix_apply_patch` 与 `resp_process_stage1_tool_governance` 中补齐两类参数形态——(1) `apply_patch *** Begin Patch...` 命令前缀；(2) 包裹对象 `{\"ok\":true,\"result\":{\"command\":\"apply_patch ...\"}}`。新增 `trim_to_patch_window`（从首个 patch marker 截取并裁掉尾随噪声）与 `command/cmd/script + nested result/payload/data/tool_input/arguments` 递归提取，统一产出 `{patch,input}`。回归验证：Rust `cargo test -p router-hotpath-napi apply_patch`（21 通过）；Jest `apply-patch-fixer.test.ts` + `apply-patch-errorsamples-regression.spec.ts`（全绿）；errorsamples triage 后 `verify-codex-error-samples` 变为无 shape regression。  

Tags: apply-patch, compatibility, semantic-map, command-wrapper, nested-result-command, no-retry-loop, errorsamples, rust-core, tool-governance

- 2026-03-21: 用户明确要求“不要中断汇报后停住”，执行层新增 drudge 周期续跑：`rust-continue-10m`（`*/10 * * * *`）用于在报告/切片后自动拉起下一轮推进。可复用结论：当任务是长链 Rust 化并且用户要求连续推进时，必须用 alarm 固化“报告后自动继续”，避免人工记忆导致停顿。

Tags: execution-rhythm, drudge-alarm, continuous-execution, rust-migration, user-preference, no-stop

- 2026-03-21: `routecodex-3.11.7` 完成 HubPipeline residual helper 收口：chat-process entry 删除 `coerceStandardizedRequestFromPayload` TS 转发壳并改为 direct-native `coerceStandardizedRequestFromPayloadWithNative(...)`，同时移除已无引用的 `hub-pipeline-orchestration-helpers.ts`。可复用结论：当 helper 仅负责 native 参数转发且调用点唯一时，应直接在调用点使用 native 能力并删除孤儿 helper 文件，避免“薄壳+孤儿”长期残留。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.633 / llms 0.6.4282）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, residual-helper, direct-native, orphan-helper-removal, thin-shell-cleanup, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.7` 继续 HubPipeline orchestration thin-shell 收口，删除 `prepareOutboundRoutingExecution` 并把 outbound 执行编排内联到 `hub-pipeline-route-and-outbound.ts`。可复用结论：当 helper 仅有单调用点且包含“可读的顺序编排逻辑”时，优先删壳并就地保留 guard/异常文案，可减少抽象层同时不损失可维护性。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.632 / llms 0.6.4278）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, orchestration, thin-shell, outbound-execution, inline-orchestration, passthrough-guard, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.7` 继续 HubPipeline orchestration thin-shell 收口，删除 `emitVirtualRouterHitLog` 转发壳并将日志调用内联到 route/outbound 调用点。可复用结论：对“单调用点日志转发 helper”应优先内联并保留 try/catch 隔离，避免 helper 层成为无意义抽象且降低调用链跳转成本。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.631 / llms 0.6.4276）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, orchestration, thin-shell, virtual-router-hit-log, inline-logging, try-catch-guard, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.7` 继续 HubPipeline orchestration thin-shell 收口，移除 `buildHubPipelineResultMetadata` TS 转发壳，`hub-pipeline-route-and-outbound.ts` 改为 direct-native `buildHubPipelineResultMetadataWithNative`。可复用结论：对“单一调用点的纯转发包装”应直接删壳并在调用点保留必要字段归一（如 policy mode 默认值），避免 helper 层继续成为语义漂移入口。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.630 / llms 0.6.4274）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, orchestration, thin-shell, direct-native, result-metadata, policy-mode-normalization, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.7` 继续 HubPipeline orchestration thin-shell 收口，完成 route/outbound metadata+snapshot 四个编排 helper 清理：删除 `syncSessionIdentifiersToMetadata` / `buildRouterMetadataInputFromContext` / `buildCapturedChatRequestSnapshot` / `applyHasImageAttachmentFlag`，调用点统一改为 direct-native（对应 `WithNative` 四项）。可复用结论：对于“native 结果需要保留调用方对象引用”的路径，不应保留额外 TS 转发层，应在调用点执行最小原地回写（metadata）与 clone 输入（snapshot）后直连 native，既保语义又减少编排漂移面。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.629 / llms 0.6.4272）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, orchestration, thin-shell, direct-native, metadata, captured-chat-request, in-place-rewrite, clone-semantics, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.7` 继续 HubPipeline residual helper native 化，完成 adapter-context `clientDisconnected` 判定下沉：新增 Rust NAPI `resolve_adapter_context_client_connection_state_json`，统一按 `clientConnectionState.disconnected` + `clientDisconnected(true/"true")` 覆盖规则输出标准化信号；TS 新增 `resolveAdapterContextClientConnectionStateWithNative`，`hub-pipeline-adapter-context.ts` 改为 direct-native 读取 `clientDisconnected`，同时保留 `clientConnectionState` 原对象透传语义。可复用结论：对“状态判定 + 覆盖优先级”这类纯语义分支，优先下沉 native 输出稳定信号，再由 TS 仅做赋值编排，可减少入口文件分支散落并避免后续规则漂移。验证链：`cargo test -p router-hotpath-napi resolve_adapter_context_client_connection_state` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.619 / llms 0.6.4250）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, client-disconnected, native-primary, shape-signal, precedence-rules, direct-native, required-export-gate, build-matrix, install-global, review-followup

- 2026-03-21: `routecodex-3.11.9` 继续 provider-response native-primary 收口，完成 clock reservation context 归一化 native 化：新增 Rust NAPI `resolve_clock_reservation_from_context_json`，将 `context.__clockReservation` 的字段校验与标准化（`reservationId/sessionId/taskIds/reservedAtMs`）下沉到 native 真源；TS 新增 `resolveClockReservationFromContextWithNative`，`maybeCommitClockReservationFromContext` 改为 direct-native 读取 reservation 后再 commit。可复用结论：对于“异步提交前的 payload 形状校验”逻辑，优先以 native 输出稳定对象或 null，再由 TS 编排执行副作用，能同时保证 fail-fast 和语义不漂移（本例保留 `reservedAtMs` 非法时回落当前时间）。验证链：`cargo test -p router-hotpath-napi resolve_clock_reservation_from_context` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global` + `npm run jest:run -- --runTestsByPath tests/servertool/review-followup.spec.ts`（routecodex 0.90.618 / llms 0.6.4248）。

Tags: rust-migration, routecodex-3.11.9, provider-response, clock-reservation, native-primary, shape-normalization, direct-native, required-export-gate, review-followup, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline residual helper native 化，完成 `req_inbound` nodeResult 组装下沉：新增 Rust NAPI `build_req_inbound_node_result_json` / `build_req_inbound_skipped_node_json`，并新增 TS wrapper `buildReqInboundNodeResultWithNative` / `buildReqInboundSkippedNodeWithNative`；`hub-pipeline-execute-request-stage-inbound.ts` 与 `hub-pipeline-execute-chat-process-entry.ts` 改为统一调用 `appendReqInboundNodeResult` / `appendReqInboundSkippedNode`，移除两处手拼 `req_inbound` 节点结构。可复用结论：对“同一 stage 节点在多入口重复组装”的路径，应抽到 native builder + TS 编排 helper，保证节点 shape 与默认字段（如 skipped reason/dataProcessed）全路径一致。验证链：`cargo test -p router-hotpath-napi req_inbound_node_result` + `cargo test -p router-hotpath-napi req_inbound_skipped_node` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.617 / llms 0.6.4246）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, req-inbound-node-result, skipped-node, native-primary, thin-shell, stage-shape-consistency, required-export-gate, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline residual helper native 化，完成 chat-process governance nodeResult 组装下沉：新增 Rust NAPI `build_tool_governance_node_result_json` / `build_passthrough_governance_skipped_node_json`，并新增 TS wrapper `buildToolGovernanceNodeResultWithNative` / `buildPassthroughGovernanceSkippedNodeWithNative`；`hub-pipeline-chat-process-governance-utils.ts` 的 `appendToolGovernanceNodeResult` / `appendPassthroughGovernanceSkippedNode` 改为 direct-native。可复用结论：对“双入口共用且形状固定”的 pipeline nodeResult 组装，应优先下沉 native 真源并在 TS 仅保留 push 编排，避免 chat-entry/request-stage 任一路径后续出现字段漂移。同时补齐上一切片 `merge_clock_reservation_into_metadata_json` 的验证闭环。验证链：`cargo test -p router-hotpath-napi tool_governance_node_result` + `cargo test -p router-hotpath-napi passthrough_governance_skipped_node` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.616 / llms 0.6.4244）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, governance-node-result, passthrough-skip-node, native-primary, thin-shell, required-export-gate, clock-reservation, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline residual helper native 化：新增 Rust NAPI `coerce_standardized_request_from_payload_json`，把 chat-process entry 的标准化请求组装（`model/messages/tools/parameters/metadata/semantics/rawPayload`）下沉到 native 真源；TS 新增 `coerceStandardizedRequestFromPayloadWithNative`，`hub-pipeline-request-normalization-utils.ts` 改为 direct-native 薄壳。补齐单测覆盖 metadata 覆盖顺序、`semantics.tools` 兜底与 `rawPayload.parameters` 非空保留规则，并加入 native required export gate。验证链：`cargo test -p router-hotpath-napi coerce_standardized_request_from_payload` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.614 / llms 0.6.4238）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, request-normalization, chat-process-entry, coerce-standardized-request, native-primary, thin-shell, required-export-gate, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.9` 在 provider-response context helper native 聚合后继续做薄壳收口：删除 `provider-response-helpers.ts` 中 5 个未使用导出（`resolveIsServerToolFollowup` / `resolveClientProtocolForResponse` / `resolveToolSurfaceShadowEnabledFromEnv` / `resolveDisplayModel` / `resolveClientFacingRequestId`），并移除冗余 `resolveHubClientProtocolWithNative` 依赖。可复用结论：当 native 聚合入口已成为唯一真源时，应立即清理同域“别名/转发”导出，避免后续调用点重新分叉语义。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.613 / llms 0.6.4236）。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell-cleanup, dead-export-removal, native-primary, ssot, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.9` 继续 provider-response native-primary 收口：新增 Rust NAPI `resolve_provider_response_context_helpers_json`，统一输出 `isServerToolFollowup / toolSurfaceShadowEnabled / displayModel / clientFacingRequestId`；TS 新增 `resolveProviderResponseContextHelpersWithNative` + `resolveProviderResponseContextSignals`，`provider-response.ts` 改为单次聚合读取 context helper，减少重复分支并保持原优先级语义。并将新能力加入 native required exports gate。验证链：`cargo test -p router-hotpath-napi resolve_provider_response_context_helpers` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.611 / llms 0.6.4230）。

Tags: rust-migration, routecodex-3.11.9, provider-response, context-helpers, followup, tool-surface-shadow, display-model, request-id, native-primary, required-export-gate, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline orchestration residual helper 收口：新增 Rust `apply_has_image_attachment_flag(_json)` 与 `sync_session_identifiers_to_metadata(_json)`，并将 TS `applyHasImageAttachmentFlag` / `syncSessionIdentifiersToMetadata` 收敛为 native thin adapter；为保持调用语义不变，adapter 采用“native 生成新 metadata 后原地回写”的方式，确保对象引用不变（避免调用点丢失同一 metadata 引用链）。同轮把上述能力与前序 metadata builder 能力一起纳入 native required exports gate，避免旧 binding 漏导出导致运行时才失败。验证链：`cargo test -p router-hotpath-napi test_apply_has_image_attachment_flag` + `cargo test -p router-hotpath-napi test_sync_session_identifiers_to_metadata` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.606 / llms 0.6.4224）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, metadata, hasImageAttachment, sessionId, conversationId, native-primary, thin-shell, in-place-rewrite, native-export-gate, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline route-select 收口：新增 Rust 能力 `build_router_metadata_input_json`（TS `buildRouterMetadataInputWithNative`），把 `RouterMetadataInput` 组装整体下沉到 native，一次性汇总基础路由字段 + stop-message metadata + runtime flags（`disableStickyRoutes`）+ estimated tokens gate（`includeEstimatedInputTokens`）+ session/responsesResume/serverToolRequired。`buildRouterMetadataInputFromContext` 收敛为 thin adapter，不再在 TS 层手拼 metadata 细节。验证链：`cargo test -p router-hotpath-napi test_build_router_metadata_input` + `cargo test -p router-hotpath-napi test_resolve_router_metadata_runtime_flags` + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.601 / llms 0.6.4213）。
- 2026-04-16: 5555 `reasoning_stop_guard/continue` followup 串到 qwen 池的真因，不在 host followup metadata，也不在 RequestExecutor；真丢失点在 Rust `build_router_metadata_input`。此前 native builder 只保留基础路由字段/stop-message/runtime flags，**会把 `__shadowCompareForcedProviderKey` 与 `disabledProviderKeyAliases` 从 metadata 根上裁掉**，导致 followup 进入 Virtual Router 前已经失去 provider pin / disable 指令。修复规则：`buildRouterMetadataInputWithNative` 必须透传这两个 routing directives；验证链至少包含 `cargo test -p router-hotpath-napi test_build_router_metadata_input_preserves_forced_provider_and_disabled_aliases`、`tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`、根仓 `npm run build:min`、`npm run install:global`、5555 `/health` 版本确认。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, router-metadata-input, native-primary, stop-message-metadata, disableStickyRoutes, estimatedInputTokens, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline 编排 native 收口：新增 Rust NAPI 能力 `resolve_router_metadata_runtime_flags_json`（TS 侧 `resolveRouterMetadataRuntimeFlagsWithNative`），将 route-select metadata 中 `disableStickyRoutes` 与 `estimatedInputTokens` 的读取从 TS helper 下沉到 native 真源；`buildRouterMetadataInputFromContext` 直接复用 native flags + stop-message metadata 合成 `RouterMetadataInput`，语义不变。补齐 Rust 单测覆盖提取/忽略分支。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（routecodex 0.90.600 / llms 0.6.4210，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, route-select, router-metadata, native-primary, disableStickyRoutes, estimatedInputTokens, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 一次性完成 HubPipeline route/outbound 编排统一：新增 `hub-pipeline-route-and-outbound.ts`，让 request-stage 与 chat-entry 共用 route select + outbound payload + metadata 汇总链路，并叠加此前 request-utils/governance-utils 共用模块，显著压缩主编排文件。可复用结论：当两条主路径共享“路由决策后到 provider payload 出站前”的流程时，优先提炼单一 orchestrator helper，再让入口文件回归“阶段串联壳”。验证链：semantic-mapper coverage + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.599，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, route-outbound-orchestration, thin-shell, dedup, request-stage, chat-entry, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 在 request 共享工具基础上继续提炼 governance 共享模块，新增 `hub-pipeline-chat-process-governance-utils.ts`，统一 clock reservation 透传、tool-governance nodeResult 映射、passthrough skip node 与 passthrough audit annotate；inbound/chat-entry 两条路径复用后减少重复治理分支。可复用结论：对于“相同错误对象映射 + 相同 skipped 分支”的双路径编排，应优先抽成 governance utils，避免一侧修复另一侧遗忘。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.598，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, governance-utils, node-result-mapping, passthrough-skip, dedup, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline chat-process 编排收口：新增 `hub-pipeline-chat-process-request-utils.ts`，统一 inbound/chat-entry 共享 request 处理逻辑（message sanitize、applyPatch mode 透传、processMode/passthrough 判定、input token 估算、responsesResume/附件/serverTool 标志提取），并在两条主路径复用。可复用结论：当两条入口链路共享“前置规范化 + 后置统计/标志”逻辑时，应提炼到 pipeline 共享模块，避免一次修复后另一条路径遗漏。验证链：semantic-mapper coverage + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.597，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, chat-process, shared-utils, dedup, request-normalization, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline 编排 helper 收口：将 request-normalization 纯逻辑再拆分为 `hub-pipeline-payload-materialization.ts`（SSE payload materialization）与 `hub-pipeline-max-tokens-policy.ts`（max token policy），并新增 `hub-pipeline-protocol-types.ts` 作为协议类型真源；`hub-pipeline-request-normalization-utils.ts` 收敛为标准化壳 + re-export。可复用结论：对于“标准化入口 + 多段纯函数”文件，优先抽离可测试纯逻辑模块，保留入口壳负责组合，避免工具函数反复堆叠回入口。验证链：semantic-mapper coverage + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.596，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, request-normalization, payload-materialization, max-tokens-policy, protocol-types, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.10` 继续 semantic-mapper 模块化：完成 Responses mapper 双向拆分，新增 `responses-mapper-config.ts` / `responses-mapper-helpers.ts` / `responses-mapper-to-chat.ts` / `responses-mapper-from-chat.ts`，`responses-mapper.ts` 收敛为 26 行薄壳并保持 helper 对外导出兼容。可复用结论：当 mapper 同时承担 endpoint 分支（如 submit_tool_outputs）与双向协议映射时，应把 endpoint 逻辑与 helper 拆到独立模块，主入口仅保留编排壳与兼容导出。验证链：semantic-mapper coverage + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.595，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.10, semantic-mapper, responses-mapper, inbound-outbound-split, helper-extraction, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.7` HubPipeline 编排薄壳继续收口：删除 `hub-pipeline.ts` 内两处私有转发方法（`executeRequestStagePipeline` / `executeChatProcessEntryPipeline`），`execute()` 直接调用文件级 orchestrator，保持 stage timing 与错误路径语义不变。可复用结论：类内“只转发不增语义”的私有方法应优先清理，避免入口编排层重复命名和无意义栈层。验证链：`sharedmodule npm run build`（matrix 全绿）+ `coverage-hub-semantic-mappers.mjs` + 根仓 `npm run build:min` + `npm run install:global`（0.90.594，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, orchestration-cleanup, direct-orchestrator, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.10` 继续 semantic-mapper 模块化：完成 Anthropic mapper 双向拆分，新增 `anthropic-mapper-config.ts` / `anthropic-mapper-to-chat.ts` / `anthropic-mapper-from-chat.ts`，`anthropic-mapper.ts` 收敛为 35 行薄壳并保留 stage timing 与 `sanitizeAnthropicPayload` 导出兼容。可复用结论：当 mapper 同时承载入站解码与出站编码时，应按 inbound/outbound 拆分并抽离共享 config，主入口只保留协议编排与观测，避免 protocol 细节持续回流。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.593，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.10, semantic-mapper, anthropic-mapper, inbound-outbound-split, config-extraction, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.10` 继续 semantic-mapper 模块化：新增 `gemini-mapper-from-chat.ts`，将 `buildGeminiRequestFromChat` 从 `gemini-mapper.ts` 主文件整体外提；`GeminiSemanticMapper` 现在由 `toChat`（`gemini-mapper-to-chat.ts`）+ `fromChat`（`gemini-mapper-from-chat.ts`）双模块编排，主文件降至 39 行并保持同名导出。可复用结论：当单个 mapper 同时承载 inbound/outbound 两条重路径时，应按方向拆分并让主文件只保留编排入口，避免“一个 mapper 文件即协议实现全集”的持续膨胀。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.592，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.10, semantic-mapper, gemini-mapper, fromChat, toChat, module-split, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.10` 继续 semantic-mapper 模块化：新增 `gemini-mapper-to-chat.ts`，将 `GeminiSemanticMapper.toChat` 的 inbound 编排整体外提为 `buildGeminiChatEnvelopeFromGeminiPayload`，保留原 missing/system/passthrough/providerMetadata/explicitEmptyTools 语义；`gemini-mapper.ts` 481→391。可复用结论：当 mapper 同时承担 inbound/outbound 两条长路径时，优先按方向拆分模块（toChat/fromChat），让主文件只保留入口编排与协议核心路径。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.590，全局 e2e 通过）。

Tags: rust-migration, routecodex-3.11.10, semantic-mapper, gemini-mapper, toChat, module-split, thin-shell, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.10` 继续 semantic-mapper 模块化：新增 `chat-mapper-fastpath.ts`，将 OpenAI chat fast-map 与 `apply_patch` 错误 hint 增强逻辑从 `chat-mapper.ts` 外提，主 mapper 文件收敛为编排壳并保持原导出；`chat-mapper.ts` 行数 442→48。可复用结论：对于“协议快路径 + 兜底 native mapper”的组合，应把快路径纯语义收敛到独立模块，主 mapper 只保留入口编排与 fallback 选择，避免后续扩展时把协议细节重新堆回入口文件。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.589，e2e 通过）。

Tags: rust-migration, routecodex-3.11.10, semantic-mapper, chat-mapper, fastpath, apply-patch-hint, thin-shell, file-split, build-matrix, install-global

- 2026-03-20: `routecodex-3.11.9` 继续 response-runtime 收口：新增 `response-runtime-anthropic-policy.ts`，将 Anthropic response inbound/outbound 两段 bridge-policy 模板（policy resolve + actionState + pipeline run + ignore failure）统一外提；`response-runtime-anthropic.ts` 删除重复 try/catch 分支并改为 direct helper 调用，行数 302→270。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min` + `npm run install:global`（0.90.588，全局 e2e check 通过）。

Tags: rust-migration, routecodex-3.11.9, response-runtime, anthropic, bridge-policy, orchestration, thin-shell, file-split, build-matrix, install-global

- 2026-03-20: 继续推进 3.11.7 HubPipeline 核心编排拆分：新增 `syncSessionIdentifiersToMetadata` / `buildRouterMetadataInputFromContext` / `emitVirtualRouterHitLog` / `resolveStageRecorderForPipeline`，并在 request-stage 与 chat-process-entry 两条主链复用，去除重复 routing metadata / recorder / log / session sync 片段，`hub-pipeline.ts` 行数 2329→2264。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, orchestration-split, routing-metadata, stage-recorder, build-matrix

- 2026-03-20: 继续 Rust 化收口 3.11.9：`provider-response.ts` 将通用辅助逻辑外提到 `provider-response-helpers.ts`（followup/clientProtocol/tool-surface-env/display-model/request-id/canonical-coercion/clock-reservation commit），主文件降到 484 行（<500），保持“主流程编排 + helper 下沉”模式。验证链：`sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.9, provider-response, file-split, thin-shell, helper-extraction, build-matrix

- 2026-03-20: 继续执行“不要小步停顿”的批量收口策略：`hub-pipeline.ts` 在保持语义不变前提下完成核心编排去重，新增 `prepareRuntimeMetadataForServertools` / `buildCapturedChatRequestSnapshot` / `applyHasImageAttachmentFlag` 三个文件级 helper，统一 `executeRequestStagePipeline` 与 `executeChatProcessEntryPipeline` 的重复片段；同时 `chat-process-servertool-orchestration` 去除 bundle 依赖中的 continueExecution 路径，改为 direct `planChatWebSearchOperationsWithNative` + `planChatClockOperationsWithNative`。验证链：定向回归 + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, hub-pipeline, thin-shell, dedup, orchestration, continue-execution, native-planning, build-matrix

- 2026-03-20: 按用户要求“移除 continue_execution 工具注入”后，补齐了主路径三处真源，避免只改一层导致回流注入：1) `chat-process-servertool-orchestration` 不再应用 continue_execution operations；2) `followup-request-builder` 标准工具列表移除 continue_execution；3) `req_process_stage1_tool_governance` 与 `chat-process-governance-orchestration` 强制 `hasActiveStopMessageForContinueExecution=true`，确保 native governance 不再自动追加该工具。保留能力仅限“模型显式调用 continue_execution 时可被 servertool handler 处理”，不再自动注入。验证链：定向 continue-injection 回归 + `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: routecodex, continue-execution, injection-removal, hub-pipeline, req-process-stage1, followup-tools, servertool, build-matrix

- 2026-03-20: 3.11.9 response-runtime 继续收口：删除顶层 helper `projectReasoningText` 与 `applyReasoningPayloadToMessage`，改为 `buildOpenAIChatFromAnthropicMessage` 内局部 `applyReasoningPayload` 实现，保持 reasoning 投影语义不变。该切片后 `response-runtime.ts` 行数降到 492，且顶层 helper 收敛为 4 个。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.556`。

Tags: rust-migration, routecodex-3.11.9, response-runtime, thin-shell, reasoning, helper-reduction, file-size, build-dev

- 2026-03-20: 3.11.9 response-runtime 收口中完成一轮死代码清理：删除未使用 helper `sanitizeAnthropicToolUseId` 与 `coerceNonNegativeNumber`，语义不变。该切片让 `response-runtime.ts` 从 523 行降至 495 行，重新满足“单文件 <500”约束。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.555`。

Tags: rust-migration, routecodex-3.11.9, response-runtime, dead-code-cleanup, thin-shell, file-size, build-dev

- 2026-03-20: 3.11.9 provider-response 完成“顶层 helper 清零”：删除最后一个 `stripInternalPolicyDebugFields` helper，改为 `convertProviderResponse` 内 direct native blacklist（`applyResponseBlacklistWithNative` + `INTERNAL_POLICY_DEBUG_BLACKLIST_PATHS` 常量）。当前 `provider-response.ts` 无顶层 function helper。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.554`。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell, native-primary, response-blacklist, build-dev

- 2026-03-20: 3.11.9 provider-response 继续薄壳收口：删除 `coerceClockReservation` / `isCanonicalChatCompletion` / `applyModelOverride` 三个 TS helper，分别在 `maybeCommitClockReservationFromContext`、`coerceClientPayloadToCanonicalChatCompletionOrThrow`、`convertProviderResponse` 内联实现（语义不变）。当前 `provider-response.ts` 顶层 helper 仅剩 `stripInternalPolicyDebugFields`。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.553`。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell, clock-reservation, canonical-chat-check, model-override, native-primary, build-dev

- 2026-03-19: 3.11.9 provider-response 薄壳继续收口：删除 `extractDisplayModel` 与 `extractClientFacingRequestId` 两个 TS helper，`convertProviderResponse` 内联候选扫描逻辑（保持原优先级与语义）。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.552`。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell, display-model, client-request-id, native-primary, build-dev

- 2026-03-19: 3.11.9 provider-response 薄壳继续收口：删除 `isServerToolFollowup` / `resolveClientProtocol` / `isToolSurfaceShadowEnabled` 三个 TS helper，`convertProviderResponse` 改为函数体内 direct-native/inline（runtime metadata followup 判定、`resolveHubClientProtocolWithNative` 直接判定 clientProtocol、tool-surface shadow mode 一次性计算）。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.551`。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell, native-primary, client-protocol, followup, tool-surface, build-dev

- 2026-03-19: 3.11.7 HubPipeline 再收口两项：删除 `liftResponsesResumeIntoSemantics` 与 `syncResponsesContextFromCanonicalMessages` 两个 TS helper，调用点直接使用 `liftResponsesResumeIntoSemanticsWithNative` / `syncResponsesContextFromCanonicalMessagesWithNative`；保留 `metaBase` metadata 原地替换语义。当前 `hub-pipeline.ts` 已无顶层 function helper。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.550`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, responses-resume-lift, canonical-context-sync, native-primary, build-dev

- 2026-03-19: 3.11.7 HubPipeline 继续薄壳化：删除 `applyChatProcessEntryMediaCleanup` 与 `maybeApplyDirectBuiltinWebSearchTool` 两个 TS helper；调用点改为 inline direct-native（media-cleanup 链路内联 + `applyDirectBuiltinWebSearchToolWithNative` 直调），仅去中转不改语义。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.549`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, media-cleanup, direct-web-search, native-primary, build-dev

- 2026-03-19: 3.11.7 HubPipeline 再收口 endpoint/protocol 薄壳：删除 `normalizeEndpoint` 与 `resolveProviderProtocol`，调用点直接使用 `normalizeHubEndpointWithNative` / `resolveHubProviderProtocolWithNative`，并在 `normalizeRequest` 内保留原 caller-facing providerProtocol 错误提示。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.548`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, endpoint-normalize, provider-protocol, native-primary, build-dev

- 2026-03-19: 3.11.7 HubPipeline 薄壳继续收口：删除 `readResponsesResumeFromMetadata` / `readResponsesResumeFromRequestSemantics` / `buildPassthroughAudit` / `annotatePassthroughGovernanceSkip` / `attachPassthroughProviderInputAudit` 五个 TS helper，调用点全部切换到 native wrappers（含 passthroughAudit 原地变更语义保留）。验证链：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:dev`（install:global + restart）+ `/health` 版本 `0.90.547`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, native-primary, responses-resume, passthrough-audit, build-dev



- 2026-03-10: `~/.codex/skills/pipedebug/` 已按当前 RouteCodex V2 结构更新。默认调试主线改为：先看 `~/.rcc/codex-samples/`，先判断问题属于 request path 还是 response path，再沿 `host bridge -> llmswitch-core Hub Pipeline -> Provider V2` 的真实边界定位。旧的“4 层流水线 / workflow-compatibility-provider README / routecodex-worktree/fix / ~/.claude/skills”表述已从 `SKILL.md` 与 references 中移除。
- 2026-03-16: Heartbeat 现定义为 tmux-client re-activation feature，唯一协议是 `<**hb:on**>` / `<**hb:off**>`，并且只绑定 `tmuxSessionId`。`hb:on` 立即生效，不支持输入 startAt；结束时间唯一来自目标工作目录 `HEARTBEAT.md` 头部 `Heartbeat-Until:` 标签。heartbeat 只在“无 in-flight request + 客户端已断开/心跳过期”时才允许注入；失败只能记日志/状态，不能影响主链路正确性，也不能 fallback 到 server cwd。注入文案必须要求读取 `HEARTBEAT.md`、检查上次交付、更新 `DELIVERY.md`、再调用 `review`，且 review 只能由模型通过现有 `review_flow` 主动调用，服务端不得自动串联。
- 2026-03-17: 修复 review/continue 回注入断裂的 request-path 根因：当请求只携带 `session scope`（如 API key `::rcc-session:*`）且没有显式 tmux header 时，`session-scope-resolution` 之前不会把该 scope 纳入 binding 候选，导致 `clientInjectReady=false` 并触发 `tmux_session_missing`。现已补齐 `api-key -> session scope -> registry_by_binding` 回查路径，并保持 tmux 存活校验；新增 `session-scope-resolution` 与 `executor-metadata` 回归用例覆盖该场景。

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

- 2026-03-20: 继续 3.11.7，新增 servertool runtime metadata 组装 native 真源：Rust `prepare_runtime_metadata_for_servertools(_json)` + TS `prepareRuntimeMetadataForServertoolsWithNative(...)`，并将 `prepareRuntimeMetadataForServertools(...)` 收敛为 thin adapter。该改动与同轮 `capturedChatRequest` / `req_outbound nodeResult` native 化构成同一批 HubPipeline 编排纯组装 helper 下沉，语义不变。验证通过：`cargo test -p router-hotpath-napi test_prepare_runtime_metadata_for_servertools`、`test_build_captured_chat_request_snapshot`、`sharedmodule npm run build`（含 matrix）、根仓 `npm run build:min`、`npm run install:global`。

Tags: rust-migration, hub-pipeline, servertool-runtime-metadata, captured-chat-request, req-outbound, native-primary, orchestration-helper, thin-shell, build-matrix, install-global

- 2026-03-20: 继续 3.11.7，新增 capturedChatRequest 快照组装 native 真源：Rust `build_captured_chat_request_snapshot(_json)` + TS `buildCapturedChatRequestSnapshotWithNative(...)`，并让 `buildCapturedChatRequestSnapshot(...)` 收敛为 thin adapter。该改动与同轮 `req_outbound` nodeResult native 化形成一组“编排纯组装 helper 下沉”收口，保持语义不变。验证通过：`cargo test -p router-hotpath-napi test_build_captured_chat_request_snapshot`、`test_build_req_outbound_node_result`、`sharedmodule npm run build`（含 matrix）、根仓 `npm run build:min`、`npm run install:global`。

Tags: rust-migration, hub-pipeline, captured-chat-request, req-outbound, native-primary, orchestration-helper, thin-shell, build-matrix, install-global

- 2026-03-20: 继续 3.11.7，将 HubPipeline `req_outbound` nodeResult 组装切到 native 真源：Rust 新增 `build_req_outbound_node_result(_json)`，TS 新增 `buildReqOutboundNodeResultWithNative(...)` 并让 `appendReqOutboundNodeResult(...)` 收敛为 thin adapter。该改动保持语义不变（node id/metadata 字段一致），仅迁移编排纯组装逻辑到 native。验证通过：`cargo test -p router-hotpath-napi test_build_req_outbound_node_result`、`test_build_router_metadata_input`、`test_build_hub_pipeline_result_metadata`、`sharedmodule npm run build`（含 matrix）、根仓 `npm run build:min`、`npm run install:global`。

Tags: rust-migration, hub-pipeline, req-outbound, node-result, native-primary, orchestration-helper, thin-shell, build-matrix, install-global

- 2026-03-20: 继续 3.11.10（semantic-mapper orchestration 收口）：新增 `gemini-mapper-config.ts`，把 Gemini mapper 内的 responses dropped 参数审计与 passthrough 常量外提（`recordGeminiResponsesDroppedParameters`、`GEMINI_PASSTHROUGH_*`），`gemini-mapper.ts` 行数 501→481（<500）。语义保持不变，仅做编排模块化与薄壳收口。验证通过：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, semantic-mapper, gemini-mapper, orchestration-modularization, thin-shell, policy-surface, build-matrix

- 2026-03-20: HubPipeline chat-process entry 编排去重：`hub-pipeline-execute-chat-process-entry.ts` 改为复用 `buildRequestStageProviderPayload(...)` 统一 req_outbound payload/policy/tool-surface 处理链，移除重复分支实现，文件行数 483→359。该改动保持语义不变并减少主编排重复。验证通过：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, hub-pipeline, chat-process-entry, orchestration-dedup, provider-payload-helper, thin-shell, build-matrix

- 2026-03-20: 继续 3.11.11，清理 chat-request-filter 的 fallback 命名噪音：`buildGovernedFilterPayloadWithNativeFallback` 重命名为 `buildGovernedFilterPayloadWithNative`，并同步 `chat-request-filters.ts`、legacy archive 与 `coverage-chat-request-filters.mjs` 调用点。该改动不改变语义，仅消除“名称暗示 fallback”与当前 native-required/fail-fast 实际行为的不一致。验证通过：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, native-default-gate, fallback-naming-cleanup, chat-request-filter, fail-fast, single-source-of-truth

- 2026-03-20: 继续 3.11.11 做 native-default gate/fallback 收口：`native-hub-pipeline-orchestration-semantics.ts` 的 `extractAdapterContextMetadataFieldsWithNative(...)` 删除 JS fallback 分支（`extractAdapterContextMetadataFieldsJs`），native 异常统一 fail-fast，消除“双实现兜底”路径，保持 HubPipeline orchestration 语义单一真源。验证通过：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, native-default-gate, fallback-cleanup, fail-fast, hub-pipeline, orchestration-semantics, single-source-of-truth

- 2026-03-20: HubPipeline request-stage 编排完成三段化拆分：新增 `hub-pipeline-execute-request-stage-inbound.ts`（inbound + process-stage1 + workingRequest 预处理）与 `hub-pipeline-execute-request-stage-provider-payload.ts`（outbound payload build + compat + policy/tool-surface），`hub-pipeline-execute-request-stage.ts` 收敛为 179 行 orchestrator；连同 `hub-pipeline.ts`（372 行）形成 HubPipeline 薄壳主路径，核心文件均 <500。验证通过：`sharedmodule/llmswitch-core npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, hub-pipeline, request-stage, orchestration-split, thin-shell, module-boundary, build-matrix

- 2026-03-19: HubPipeline 的 SSE + alias-map helper 继续收口到 Rust 真源：`router-hotpath-napi/hub_pipeline.rs` 新增 `extract_model_hint_from_metadata(_json)` 与 `resolve_sse_protocol_with_fallback(_json)`；`hub_resp_outbound_client_semantics.rs` 新增 `resolve_alias_map_from_sources(_json)`；TS 侧新增 `extractModelHintFromMetadataWithNative`、`resolveSseProtocolWithFallbackWithNative`、`resolveAliasMapFromSourcesWithNative`，并让 `hub-pipeline.ts` 的 `extractModelHint()` / `resolveSseProtocol()` / `resolveAliasMapFromSources()` 都只做 direct native wrapper；`native-router-hotpath-loader.ts` 的 `REQUIRED_NATIVE_EXPORTS` 补齐 `extractModelHintFromMetadataJson`、`resolveSseProtocolWithFallbackJson`、`resolveAliasMapFromSourcesJson`。同轮补做 thin-shell 清理：删除未使用的 `resolveSseProtocolFromMetadata()`、`readAliasMapFromSemantics()`，并把 `resolveProviderProtocol()`/`extractHubPolicyOverride()`/`extractHubShadowCompareConfig()` 收敛为 direct native wrapper（保留 caller-facing error shape）。验证通过：`cargo test -p router-hotpath-napi extract_model_hint_from_metadata -- --nocapture`（3/3）、`cargo test -p router-hotpath-napi resolve_sse_protocol_with_fallback -- --nocapture`（2/2）、`cargo test -p router-hotpath-napi resolve_alias_map_from_sources -- --nocapture`（2/2）、`sharedmodule npm run build`（含 matrix）、根仓 `npm run build:dev` + `:5555/health`。

Tags: rust-migration, hub-pipeline, sse, model-hint, protocol-fallback, alias-map, native-wrapper, router-hotpath-napi, required-native-exports, build-dev

- 2026-03-19: Hub pipeline 的 Responses resume 读取语义已切到 Rust 真源：`router-hotpath-napi` 新增 `read_responses_resume_from_metadata(_json)` 与 `read_responses_resume_from_request_semantics(_json)`，TS 侧 `hub-pipeline.ts` 的 `readResponsesResumeFromMetadata/RequestSemantics` 改为调用 native wrapper；并把 `readResponsesResumeFromMetadataJson`、`readResponsesResumeFromRequestSemanticsJson` 加入 `native-router-hotpath-loader.ts` 的 `REQUIRED_NATIVE_EXPORTS`。验证通过：`cargo test -p router-hotpath-napi read_responses_resume -- --nocapture`（4/4），`sharedmodule/llmswitch-core npm run build`（含 matrix/postbuild 全绿）。

Tags: rust-migration, hub-pipeline, responses-resume, native-wrapper, router-hotpath-napi, required-native-exports

- 2026-03-19: Hub pipeline 的 `applyPatchToolMode` 环境变量解析已切到 Rust 真源：`router-hotpath-napi` 新增 `resolve_apply_patch_tool_mode_from_env_json` 导出，TS `native-hub-pipeline-orchestration-semantics.ts` 新增 `resolveApplyPatchToolModeFromEnvWithNative`，`hub-pipeline.ts` 的 `resolveApplyPatchToolModeFromEnv()` 改为调用 native wrapper；同时把 `resolveApplyPatchToolModeFromEnvJson` 加入 `native-router-hotpath-loader.ts` 的 `REQUIRED_NATIVE_EXPORTS`。验证通过：`cargo test -p router-hotpath-napi resolve_apply_patch_tool_mode_from_tools -- --nocapture`，`sharedmodule/llmswitch-core npm run build`（matrix 全绿），根仓 `npm run build:dev`（含 install:global + e2e + 5555 restart）通过。

Tags: rust-migration, hub-pipeline, apply-patch, env-semantics, native-wrapper, required-native-exports, build-dev

- 2026-03-17: `virtual-router-routing-instructions.spec.ts` 与 `session-client-routes.spec.ts` 若使用固定 `sessionId` / tmux scope，必须为每个 test case 隔离 `ROUTECODEX_SESSION_DIR`。Rust `routing_state_store` 会持久化 `session:/conversation:/tmux:` scope；若测试复用本地默认 session dir，上一次 run 的 prefer/disable/allow 状态会被下一次 run 重新加载，表现成“路由选择回归”或“heartbeat/task 路由 500”的假阳性。最小正确修复是测试侧 per-test 临时 session dir，而不是改生产持久化语义。

Tags: rust-migration, virtual-router, routing-instructions, routing-state-store, session-dir, ROUTECODEX_SESSION_DIR, jest, test-isolation, heartbeat, session-client-routes

- 2026-03-17: Heartbeat 继续推进 P0 子任务 `routecodex-3.11.4`（snapshot hooks/utils/recorder）并完成收口：
  - 新增专项覆盖脚本 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-snapshot-hooks-utils-recorder.mjs`，覆盖 `snapshot-utils` + `snapshot-recorder` 主路径，并补充 `native-snapshot-hooks` 异常/边界断言（invalid payload、empty result、missing function、stringify failure、throw）。
  - 新增 npm scripts：`test:coverage:hub-snapshot-hooks-utils-recorder` 与 `verify:shadow-gate:hub-snapshot-hooks-utils-recorder`。
  - 新增 rust-migration manifest 模块 `hub.snapshot-hooks-utils-recorder`（95/95 gate）。
  - 验证：`verify:shadow-gate:hub-snapshot-hooks-utils-recorder` 通过（module lines 100 / branches 96.67）；`coverage-hub-native-batch` 通过；`coverage-bridge-protocol-blackbox` 24/24 通过；根仓 `npm run build:dev`（含 install:global + e2e + restart）通过。
  - BD：`routecodex-3.11.4` 已关闭，`routecodex-3.11` 更新为子任务完成 4/6。

Tags: rust-migration, routecodex-3.11.4, snapshot-utils, snapshot-recorder, snapshot-hooks, shadow-gate, heartbeat

- 2026-03-17: Heartbeat 继续推进 P0 子任务 `routecodex-3.11.2`（tool-governance engine+rules）并完成收口：
  - 新增专项覆盖脚本 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-tool-governance.mjs`，使用多场景 native mock 覆盖 rules 映射与 engine 分支（成功路径、no-rules、max-length 错误映射、非 max-length 错误透传）。
  - 新增 npm scripts：`test:coverage:hub-tool-governance` 与 `verify:shadow-gate:hub-tool-governance`。
  - 新增 rust-migration manifest 模块 `hub.tool-governance.engine-rules`（95/95 gate）。
  - 验证：`verify:shadow-gate:hub-tool-governance` 通过（module lines 100 / branches 97.06）；`tool-governance-native-compare` 通过；`coverage-bridge-protocol-blackbox` 24/24 通过；根仓 `npm run build:dev`（含 install:global + e2e + restart）通过。
  - BD：`routecodex-3.11.2` 已关闭，`routecodex-3.11` 更新为子任务完成 3/6。

Tags: rust-migration, routecodex-3.11.2, tool-governance, shadow-gate, coverage, native-primary, heartbeat

- 2026-03-16: P0 主线子任务 `routecodex-3.11.5`（protocol-field-allowlists rust source-of-truth）完成收口：
  - 新增专用黑盒/覆盖脚本 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-protocol-field-allowlists.mjs`，逐项比对 TS 导出 allowlists 与 native `resolveHubProtocolAllowlistsWithNative`，并验证 `resolveHubProtocolSpec` / `HUB_PROTOCOL_SPECS` 与 native `resolveHubProtocolSpecWithNative` 的逐协议 parity。
  - 新增 npm scripts：`test:coverage:hub-protocol-field-allowlists` 与 `verify:shadow-gate:hub-protocol-field-allowlists`。
  - 新增 rust-migration manifest 模块 `hub.shared.protocol-field-allowlists`（95/95 gate，src+dist 双路径）。
  - 验证结果：`verify:shadow-gate:hub-protocol-field-allowlists` lines/branches 均 100%，并自动 promote `preparedForShadow=true`；`coverage-bridge-protocol-blackbox` 24/24（100.0%）。
  - BD：`routecodex-3.11.5` 已更新并强制关闭（依赖阻塞下使用 `--force`，原因是依赖链未及时清理但验收已满足）。

Tags: rust-migration, routecodex-3.11.5, protocol-field-allowlists, protocol-spec, shadow-gate, blackbox, coverage-100, native-primary

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
- 2026-03-18: `/v1/responses` 客户端“提示消失/像断连”有一类根因不在 SSE 传输层，而在 host bridge 错误传播：当 Anthropic-compatible upstream 返回 `stop_reason=model_context_window_exceeded` 且 assistant output 为空时，llmswitch-core 会抛 `MALFORMED_RESPONSE`，但若 host `provider-response-converter` 只识别 `context_length_exceeded` 而未覆盖 `context_window_exceeded` / `model_context_window_exceeded`，catch 分支会只记 `convert.bridge.error` 然后回退 `return options.response`，SSE 客户端就可能看起来像静默断流。最小正确修复是在 `src/server/runtime/http-server/executor/provider-response-converter.ts` 把这两个 stop reason 也并入 context overflow 并冒泡成明确 400 / SSE error event。
- 2026-03-18: `/v1/responses` 巨大工具历史若主要膨胀在 `semantics.responses.context.input[]`（大量 `function_call_output` / reasoning / tool history），Virtual Router 若只按 canonical `messages` 估算 token，会把真实 200k 级请求低估到几十 k，导致本该走 `longcontext` 的请求先落到 `tools/tabglm`。最小正确修复是在 `sharedmodule/llmswitch-core/src/router/virtual-router/token-counter.ts` 与 Rust `virtual_router_engine/features.rs` 同步把 `responses.context.input[]` 纳入 token estimate，并保持 media payload 忽略逻辑。
- 2026-03-19: `/v1/responses` 出现 `200 + finish_reason=stop + assistant 为空` 时，默认先按 **request-path / 请求形状不合法** 排查（先看 request shape，再看 response path）。禁止通过“裁剪历史/压缩上下文”做语义修复；应优先做形状修复（tool-session 顺序修正、缺失 tool output 占位补齐、id 风格规范化），并通过失败样本 replay + control replay 验证“上下文未丢失”。

Tags: anthropic-sse, terminated, salvage, ark-coding-plan, kimi-k2.5, tool_use, sse_decode, seed, usage, routecodex-5555, openai-responses, overlong-function-name, input-name-400, crs, gpt-5.4, reasoning, model-remap, virtual-router, logging, finish-reason, request-complete, regression-test, request-shape, empty-response, shape-repair, no-semantic-trim

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

- 2026-03-18: `apply-patch` 的 GNU unified diff 兼容里，rename-only diff 必须允许“只有 move、没有 @@ hunk”的结构。若 `extract-patch` 仍把 `*** Update File` 强制要求成必须有 hunk，或 `normalizeApplyPatchText()` 在 Update File 区块里把 `*** Move to:` 误缩进成普通正文，就会把合法 rename-only patch 误判成 `unsupported_patch_format`，直接阻断 `sharedmodule/llmswitch-core npm run build` 的 postbuild matrix。最小正确修复是：validator/extractor 接受 move-only update section，normalize 期间保留原样的 `*** Move to:`.

Tags: apply-patch, gnu-diff, rename-only, move-to, normalize, extract-patch, llmswitch-core, matrix, unsupported-patch-format

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

## Codex managed tmux attach 的非 TTY 失败收敛（2026-03-17）

- 2026-03-17：`rcc codex ... resume` 在非交互终端（`stdin/stdout` 非 TTY）下会进入 managed tmux 分支并执行 `tmux attach-session`，导致报错 `open terminal failed: not a terminal`，退出码 1，错误信息不够直观。
- 根因：launcher 在 `spec.commandName === 'codex'` 时总会尝试 managed tmux attach，但之前没有对“当前是否可交互 TTY”做显式守卫。
- 修复：在 launcher context 增加 `isInteractiveTerminal` 真源（CLI 侧绑定 `process.stdin.isTTY && process.stdout.isTTY`），并在 managed tmux attach 前 fail-fast：
  - 非 TTY 时先停止刚创建的 managed tmux session（避免残留），
  - 抛出明确错误：`Codex managed tmux mode requires an interactive terminal (TTY)...`，
  - 不再走到 `tmux attach-session` 的低可读报错路径。
- 验证：
  - `npx tsc -p tsconfig.json --noEmit` 通过。
  - `npm run jest:run -- --runTestsByPath tests/cli/codex-command.spec.ts -t "fails fast with a clear error when managed tmux attach has no interactive TTY"` 通过。
  - 本地 `./rcc codex --dangerously-bypass-approvals-and-sandbox -p rcm resume`（非 TTY）复现后已变为 fail-fast 明确报错。

Tags: codex, tmux, launcher, tty, fail-fast, managed-session, cli

- 2026-03-18: Heartbeat/Virtual Router 联合巡检时确认两个可复用结论：
  1. `sharedmodule/llmswitch-core/src/servertool/heartbeat/history-store.ts` 读取 history 时不能只按 `atMs` 倒序；在 Jest/同毫秒写入场景下，`set_enabled` 与 `daemon.tick` 事件会同时间戳，若缺少“追加顺序”二级排序，最新事件会被旧事件覆盖到列表后面，导致巡检/断言误读。最小正确修复是读取时保留行序，并在 `atMs` 相同情况下按追加顺序倒序。
  2. `virtual-router-routing-instructions.spec.ts` 中 provider.model 的 alias retry 断言不能把可用 alias 写死成两项；`antigravity.<model>` 会按当前 provider registry 展开出全部同模型 key，测试应从 registry 动态计算剩余 alias，而不是假设只有 `sonnetkey/sonnetbackup`。
Tags: heartbeat, history-store, ordering, same-timestamp, jest, virtual-router, routing-instructions, alias-rotation, test-robustness, routecodex-3.11.6

- 2026-03-18: `servertool/pre-command-hooks` 相关巡检补充两条长期结论：
  1. `runServerSideToolEngine()` 在执行 pre-command hooks 时，runtime precommand 真源应优先读取 `adapterContext.__rt.preCommandState`，再回退到 `readRuntimeMetadata(...).preCommandState` 与 sticky-store；否则某些 servertool/test 注入路径下，runtime precommand 会被错误降级成 config fallback。
  2. 任何依赖 `resolveRccUserDir()` 的测试（包括 precommand 脚本白名单）如果要切换临时 user dir，不能只改 `ROUTECODEX_USER_DIR`；若环境里已有 `RCC_HOME`，它会优先级更高。最小正确修复是测试侧同步设置 `RCC_HOME` / `ROUTECODEX_HOME` / `ROUTECODEX_USER_DIR`，而不是放宽生产路径校验。
Tags: precommand, servertool, runtime-metadata, __rt, adapterContext, user-data-paths, RCC_HOME, ROUTECODEX_HOME, routecodex-3.11.6, test-isolation

- 2026-03-18: `routecodex-3.11.6` 的 native tmux/session-scope parity 再补一条长期结论：`ROUTECODEX_SESSION_DIR` 不能只停留在 JS sticky-store。若 Virtual Router native `route()/getStopMessageState()/getPreCommandState()` 仍靠进程环境隐式读取 session dir，测试与某些 runtime 下会出现“TS 写到 override 目录、Rust 读写到 ~/.rcc/sessions”的分裂。最小正确修复是在 TS `engine.ts` 把 `sessionDir + rccUserDir` 显式注入 `metadata.__rt`，Rust `napi_proxy.rs` 再用 `with_session_dir_override(...) + with_rcc_user_dir_override(...)` 包裹 native 真源调用，`routing_state_store.rs` 优先读取 thread-local session-dir override。

Tags: routecodex-3.11.6, virtual-router, stopmessage, precommand, tmux-scope, session-dir, ROUTECODEX_SESSION_DIR, metadata.__rt, napi-proxy, routing-state-store, native-parity

- 2026-03-18: 推进 `routecodex-3.11.1` 时，先补了 `sharedmodule/llmswitch-core/scripts/tests/semantic-mapper-public-replay.mjs` 作为四个 public semantic mapper 入口（chat / responses / anthropic / gemini）的统一代表性回放脚手架，对应命令是 `cd sharedmodule/llmswitch-core && npm run test:semantic-mapper-public-replay`。这轮回放确认：chat public mapper 已基本是 native-first，但 `responses / anthropic / gemini` 的 public wrapper 下面，核心 TS 语义仍主要留在 `src/conversion/hub/operation-table/semantic-mappers/*.ts`，因此 3.11.1 不能因为 wrapper 很薄就误判完成；下一步必须继续切 operation-table core，而不是只做 wrapper coverage。

Tags: routecodex-3.11.1, semantic-mappers, public-replay, native-first, operation-table, chat, responses, anthropic, gemini, rust-migration

- 2026-03-18: 继续推进 `routecodex-3.11.1` 时，新增 `sharedmodule/llmswitch-core/scripts/tests/semantic-mapper-core-replay.mjs`，专门直连 `dist/conversion/hub/operation-table/semantic-mappers/{responses,anthropic,gemini}-mapper.js` 做 core replay，而不是只测 public wrapper。这个脚手架目前覆盖三类可复用证据：
  1. `openai-responses` fixture request 的 `toChat/fromChat` 往返，确认 system/tool/tool_output/semantics.responses/context snapshot 仍走 core 真源；
  2. `anthropic-messages` fixture request 的 `toChat/fromChat` 往返，确认 tool_use/tool_result 与 max_tokens/model 仍由 core mapper 输出；
  3. `gemini` core outbound 的 provider-specific 语义（普通 roundtrip、`antigravity` 默认注入、`gemini-cli` tool declarations）可以在不经过 public wrapper 的情况下独立验证。
- 对应命令：`cd sharedmodule/llmswitch-core && npm run test:semantic-mapper-core-replay`，并与 `npm run test:semantic-mapper-public-replay` 组合使用：前者盯 operation-table core，后者盯 public 入口，避免 3.11.1 再次把“wrapper 很薄”误判成“core 已 native-primary”。

Tags: routecodex-3.11.1, semantic-mappers, core-replay, operation-table, responses, anthropic, gemini, antigravity, gemini-cli, rust-migration

- 2026-03-18: Heartbeat 两个真实缺口要一起看：
  1. server 侧 `dispatchSingleHeartbeat()` 原先只检查 `requestActivityTracker`（server in-flight request）和 `registry.hasAliveTmuxSession()`（高级 session client 仍连着），**没有**检查 tmux pane 本身是否还在 active 执行；因此当 session daemon 已断开、但 tmux pane 里的 Codex/Claude 仍在工作时，heartbeat 仍可能直接 `send-keys` 打扰正在执行的任务。最小修复是在 `src/server/runtime/http-server/tmux-session-probe.ts` 增加 pane readiness probe：shell pane 直接视为空闲；agent pane（codex/claude/routecodex/node）则用 `capture-pane` 尾部 prompt 特征判断是否 idle；若判定 active，则 heartbeat 返回 `tmux_session_active` 并 skip。
  2. `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts` 之前只从 camelCase 字段读取 tmux session（`tmuxSessionId/clientTmuxSessionId`），真实请求里若只带 snake_case（`client_tmux_session_id` / `tmux_session_id` / `stop_message_client_inject_session_scope`），`<**hb:15m**>` 虽然被解析了，但不会把 interval 覆盖到 heartbeat state。最小修复是扩展 directive 的 tmuxSessionId 提取字段集合；回归要验证同一 tmux 下 `<**hb:15m**>` 后再发 `<**hb:30s**>`，state.intervalMs 确实从 15m 覆盖成 30s。
- 验证命令：`node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/http-server/tmux-session-probe.spec.ts tests/server/runtime/http-server/heartbeat-runtime-hooks.spec.ts tests/servertool/servertool-heartbeat.spec.ts` 与 `npx tsc --noEmit`。

Tags: heartbeat, tmux, active-session, send-keys, inject-readiness, capture-pane, hb-marker, interval-override, snake-case, client_tmux_session_id, routecodex

- 2026-03-18: Heartbeat 后续设计已补文档：`docs/design/heartbeat-session-execution-state.md`。摘要：heartbeat 是否跳过，后续应由 **tmux-scoped execution-state tracker** 判定，而不是把 daemon alive 当成 busy；状态机主干为 `IDLE / WAITING_RESPONSE / STREAMING_OPEN / POST_RESPONSE_GRACE / STALED / UNKNOWN`，决策顺序优先看 **SSE 是否仍打开**，其次看最近 request/response 时间线与 `finish_reason`，状态不足时才回退到 tmux pane heuristic。详细状态定义、转移和落地点见该设计文档。

Tags: heartbeat, tmux, execution-state, sse, finish-reason, state-machine, design-doc, routecodex

- 2026-03-18: Heartbeat skip 已开始从“弱信号拼接”转向 **tmux-scoped execution-state 真源**：新增 `src/server/runtime/http-server/session-execution-state.ts`，由 request start、JSON response complete、SSE stream start/end、SSE client close 这些运行时事件持续写状态；heartbeat 决策改为先读 execution-state snapshot，再回退到 tmux pane heuristic。关键长期结论：`requestActivityTracker` 只能表示 executor 生命周期内的 inflight request，**不能**表示 SSE 仍在执行；`registry.hasAliveTmuxSession()` 只能表示 client 在线，**不能**表示 pane busy。已通过 `tests/server/runtime/http-server/session-execution-state.spec.ts`、`tests/server/runtime/http-server/heartbeat-runtime-hooks.spec.ts`、`tests/server/http-server/tmux-session-probe.spec.ts`、`tests/servertool/servertool-heartbeat.spec.ts` 与 `npx tsc --noEmit` 验证，并完成 `npm run build:dev` / 全局安装 / 5555 服务刷新。

Tags: heartbeat, execution-state, sse, tmux, request-activity-tracker, daemon-alive, busy-idle, session-state, routecodex

- 2026-03-18: apply_patch 近期高频错误主要不是执行器本身随机失效，而是**工具引导与模型心智不够收敛**：当前最近 200 条 `~/.rcc/errorsamples/client-tool-error/chat_process.req.stage2.semantic_map.apply_patch-*.json` 中，几乎全部都是 `apply_patch_verification_failed`，主模式集中在三类：1) 把 GNU diff 头（`--- a/...` / `+++ b/...`）混进 `*** Begin Patch` 块，触发 `invalid hunk header`；2) 输出冲突标记 `=======`，触发“Expected update hunk to start with @@”错误；3) 继续使用 `@@ -51,7 +51,9 @@` 这类 GNU 行号上下文，导致 `Failed to find context`。已确认一个明确误导源在 `src/config/system-prompts/codex-cli.txt`：原文允许“apply_patch 不好用就探索其他办法”，容易把模型推向 Node/Python 改写；另一个误导点是 guidance 虽写“支持 Begin Patch 或 GNU diff”，但未明确强调**不能混用**，也缺少最小合法模板。已修正文案于 `src/config/system-prompts/codex-cli.txt`、`sharedmodule/llmswitch-core/src/guidance/index.ts`、`sharedmodule/llmswitch-core/src/guidance/CCR_TOOL_GUIDE.md`、`sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-clock-tool-schemas.ts`，新增“不混用 + 最小模板 + 禁止冲突标记/裸 frontmatter 作为 Update File body”的说明；`npx tsc --noEmit` 与 `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit` 已通过。

Tags: apply_patch, tool-guidance, errorsamples, unsupported_patch_format, invalid-hunk-header, failed-to-find-context, conflict-markers, guidance-fix, routecodex

- 2026-03-18: 基于 `~/.rcc/errorsamples/client-tool-error/chat_process.req.stage2.semantic_map.apply_patch-*.json` 的近期主模式，host `snapshot-recorder` 现已把 `apply_patch verification failed` 细分为稳定子类型：`apply_patch_conflict_markers_or_merge_chunks`、`apply_patch_gnu_line_number_context_not_found`、`apply_patch_mixed_gnu_diff_inside_begin_patch`、`apply_patch_expected_lines_not_found`，不再全部落成泛化的 `apply_patch_verification_failed`。同时 llmswitch-core `maybeAugmentApplyPatchErrorContent()` 现在会对上述四类失败追加定向 retry hint（冲突标记、混用语法、猜测 GNU 行号、expected lines not found），帮助模型下一跳按正确方式重读文件和缩小上下文，而不是继续盲试。已验证：`tests/unified-hub/runtime-error-errorsample-write.spec.ts`、`tests/sharedmodule/apply-patch-error-hints.spec.ts`、根仓 `npx tsc --noEmit`、`sharedmodule/llmswitch-core npx tsc -p tsconfig.json --noEmit` 全通过。

Tags: apply_patch, errorsamples, subtype-classification, retry-hints, snapshot-recorder, chat-mapper, llmswitch-core, routecodex

- 2026-03-18: 推进 `routecodex-3.11.1` 时，对 `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.ts` 做了第一刀真实拆解：把 Antigravity / Gemini request-shaping 逻辑（系统指令常量、默认 safety settings、flash 默认 thinking budget、networking/image request config、googleSearch 注入/裁剪、deepCleanUndefined）抽到新文件 `gemini-antigravity-request.ts`。拆解后 `gemini-mapper.ts` 体量从 `1605` 行降到 `1343` 行，`semantic-mapper-core-replay` 与 `semantic-mapper-public-replay` 仍保持通过。长期结论：3.11.1 的正确推进方式是先按高内聚语义块持续拆 `gemini-mapper.ts`，再继续把 operation-table core 往 native-primary 收敛，不能因为 replay 通过或 wrapper 变薄就误判任务完成。

Tags: routecodex-3.11.1, gemini-mapper, semantic-mapper, antigravity, request-shaping, module-split, core-replay, public-replay, native-primary, rust-migration

- 2026-03-18: 继续推进 `routecodex-3.11.1` 时，对 `gemini-mapper.ts` 做了第二刀拆分：把 systemInstruction 相关语义抽到 `gemini-system-semantics.ts`，包括 `ensureSystemSemantics`、`readSystemTextBlocksFromSemantics`、`collectSystemSegments`、`applyGeminiRequestSystemInstruction`。拆分后 `gemini-mapper.ts` 进一步从 `1343` 降到 `1258` 行，且 `npx tsc --noEmit`、`sharedmodule/llmswitch-core npx tsc -p tsconfig.json --noEmit`、`semantic-mapper-core-replay`、`semantic-mapper-public-replay` 均保持通过。可复用结论：`gemini-mapper.ts` 适合按高内聚语义块持续拆成 request-shaping / system semantics / thinking / tool output / audit 等模块，每拆一刀都必须同时跑 core + public replay，防止只在 wrapper 层看绿误判为 3.11.1 已完成。

Tags: routecodex-3.11.1, gemini-mapper, semantic-mapper, system-semantics, module-split, core-replay, public-replay, native-primary, rust-migration

- 2026-03-18: 继续推进 `routecodex-3.11.1` 时，对 `gemini-mapper.ts` 做了第三刀拆分：把 generation/thinking config 相关逻辑抽到 `gemini-thinking-config.ts`，包括 `buildGenerationConfigFromParameters` 与 `applyAntigravityThinkingConfig`。拆分后 `gemini-mapper.ts` 从 `1258` 进一步降到 `1080` 行，且 `sharedmodule/llmswitch-core npx tsc -p tsconfig.json --noEmit`、`npx tsc --noEmit`、`semantic-mapper-core-replay`、`semantic-mapper-public-replay` 均继续通过。可复用结论：`gemini-mapper.ts` 的安全拆分路径是按 request-shaping -> system semantics -> thinking config -> tool output/audit 这类高内聚语义块逐刀下沉，每一刀后都要同时跑 core/public replay，避免只看局部编译成功就误判 semantic parity 无漂移。

Tags: routecodex-3.11.1, gemini-mapper, semantic-mapper, thinking-config, module-split, core-replay, public-replay, native-primary, rust-migration

- 2026-03-18: 继续推进 `routecodex-3.11.1` 时，对 `gemini-mapper.ts` 做了第四刀拆分：把 tool output / function response 协议逻辑抽到 `gemini-tool-output.ts`，把 dropped/lossy mapping audit 记录抽到 `gemini-mapping-audit.ts`。拆分后 `gemini-mapper.ts` 从 `1080` 进一步降到 `882` 行，且 `sharedmodule/llmswitch-core npx tsc -p tsconfig.json --noEmit`、`npx tsc --noEmit`、`semantic-mapper-core-replay`、`semantic-mapper-public-replay` 均继续通过。可复用结论：在 semantic mapper 巨型文件上，优先拆高内聚协议块（request-shaping / system semantics / thinking / tool output / audit）是可持续路径；每一刀都应在 sharedmodule 侧配套 core + public replay 做行为守护，避免把“更易读”误判成“语义仍完全一致”。

Tags: routecodex-3.11.1, gemini-mapper, semantic-mapper, tool-output, mapping-audit, module-split, core-replay, public-replay, native-primary, rust-migration

- 2026-03-18: `routecodex-3.11.1` 的 Gemini semantic-mapper 继续拆 residual helper：新增 `gemini-chat-request-helpers.ts` 与 `gemini-semantics-state.ts`，把 schema alignment / request content / protocol helper / semantics-state 从 `gemini-mapper.ts` 抽出，并清掉未再使用的本地 dead helper。结果：`gemini-mapper.ts` 从 882 行降到 499 行；验证保持 `sharedmodule tsc + root tsc + semantic-mapper core/public replay` 全通过。当前结论仍是 `routecodex-3.11.1` 只能继续保持 in_progress；Gemini 主文件已过第一轮体量收口，但整个 semantic-mapper family 尚未达到 native-primary 完成态。

Tags: rust-migration, routecodex-3.11.1, semantic-mapper, gemini-mapper, modularization, replay, tsc, heartbeat

- 2026-03-18: `routecodex-3.11.1` 继续拆 `anthropic-mapper.ts`：新增 `anthropic-thinking-config.ts` 与 `anthropic-semantics-audit.ts`，把 Anthropic thinking config 正规化/预算/输出配置合并，以及 tools semantics / system clone / responses-origin / mapping audit helper 抽出主文件。结果：`anthropic-mapper.ts` 从 748 行降到 385 行；验证保持 `sharedmodule tsc + root tsc + semantic-mapper core/public replay` 全通过。可复用结论：对 semantic-mapper 巨型文件，优先按 thinking-config 与 semantics/audit 这类高内聚协议块拆分，可以在不改 host/provider 语义边界的前提下快速压缩主文件并保持 replay 稳定。

Tags: rust-migration, routecodex-3.11.1, anthropic-mapper, semantic-mapper, thinking-config, mapping-audit, module-split, replay, tsc, heartbeat

- 2026-03-18: `routecodex-3.11.1` 继续拆 `responses-mapper.ts`：新增 `responses-submit-tool-outputs.ts`，把 submit-tool-outputs endpoint 的 response_id 解析、resume tool output 恢复、captured tool result 收集、payload 组装从主文件抽出。结果：`responses-mapper.ts` 从 558 行降到 319 行；验证保持 `sharedmodule tsc + root tsc + semantic-mapper core/public replay` 全通过。可复用结论：Responses mapper 适合优先把 submit-tool-outputs 这种与 create-request 主路径职责不同的次级协议分支独立成 helper，能显著降低主编排文件复杂度且不改变 public mapper 行为。

Tags: rust-migration, routecodex-3.11.1, responses-mapper, semantic-mapper, submit-tool-outputs, module-split, replay, tsc, heartbeat

- 2026-03-18: 在 `routecodex-3.11.1` 的 semantic-mapper closeout 阶段，单个 family aggregate gate 已被证实过粗：本轮把 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-semantic-mappers.mjs` 扩展为支持 `SEMANTIC_MAPPER_TARGET=responses|anthropic|gemini|family`，并新增 package scripts `test:coverage:hub-semantic-mappers-{responses,anthropic,gemini}` 与对应 `verify:shadow-gate:*`，同时在 `sharedmodule/llmswitch-core/config/rust-migration-modules.json` 新增 `hub.semantic-mappers.{responses,anthropic,gemini}-operation-table` 三个 module entry。这轮还补了 responses/anthropic/gemini 三条 mapper 的 direct main-path coverage，使 family aggregate 从 77.97/65.47 提升到 88.34/74.85；当前 per-mapper baseline 分别为 responses 84.08/68.78、anthropic 92.35/80.84、gemini 87.94/73.51。可复用结论：semantic-mapper family 不应再只靠一个 aggregate gate 判断 closeout，应该按 mapper 分治收口；另一个实践结论是这些 coverage scripts 目前内置 build:ci，不适合并行跑，否则会被 clean-dist 互相踩。

Tags: routecodex-3.11.1, semantic-mappers, coverage, shadow-gate, responses, anthropic, gemini, rust-migration, heartbeat

- 2026-03-18: semantic-mapper closeout 继续优先推进 anthropic：在 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-semantic-mappers.mjs` 中补了 anthropic helper 的多种边界输入（thinking config normalize / budget map / output config / existing semantics / invalid tools node / null metadata / empty system blocks），并补了 anthropic mapper 主路径的反向分支（default entryEndpoint fallback、bad-shape metadata + providerMetadata restore、stop -> stop_sequences、显式已有 thinking/output_config 保留、parameters.messages/tools 跳过、system/providerExtras getter 抛错时 fail-soft）。结果：`test:coverage:hub-semantic-mappers-anthropic` 从 92.35/80.84 提升到 96.25/89.58，family aggregate 也从 88.34/74.85 提升到 89.31/77.68。可复用结论：anthropic 这条线已经证明“先补 helper，再补 mapper 本体反向分支”是有效路径；当前最大剩余缺口已集中到 `anthropic-mapper` 主体 branch，而不再是 helper 覆盖。

Tags: routecodex-3.11.1, semantic-mappers, anthropic, coverage, branch-coverage, shadow-gate, rust-migration, heartbeat

- 2026-03-18: semantic-mapper closeout 继续聚焦 anthropic：在 `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-semantic-mappers.mjs` 中新增了两个关键 inbound case——一个命中 `extractMetadataPassthrough()` 的真实 passthrough 形状（`rcc_passthrough_tool_choice: '"auto"'`），一个命中 `mergeParameters(undefined)` 与空 `parameters` 删除路径；同时补了 budget-map 对象值忽略、`applyEffortBudget({})` 原样返回、非对象 truthy ctx、primitive metadata 建根、`message.content` 为普通对象等残余 helper 分支。结果：`test:coverage:hub-semantic-mappers-anthropic` 从 96.25/89.58 进一步提升到 98.75/93.58。当前结论：anthropic 已非常接近 95/95 gate，剩余主要卡在 `anthropic-mapper` 的 `sanitizeAnthropicPayload()` 删除未知 key 分支，以及 `anthropic-thinking-config` 的少量尾部分支。

Tags: routecodex-3.11.1, semantic-mappers, anthropic, coverage, branch-coverage, passthrough, shadow-gate, rust-migration, heartbeat

- 2026-03-18: `routecodex-3.11.1` semantic-mappers closeout 中，per-mapper anthropic 线已正式通过 shadow gate：`verify:shadow-gate:hub-semantic-mappers-anthropic` PASS，summary 为 lines 100 / branches 95.68，并自动 promote `hub.semantic-mappers.anthropic-operation-table` -> `preparedForShadow=true`。本轮为补 stubborn branch，新增 direct sanitize 覆盖与 thinking-config 的 boolean/object-invalid/invalid-budget-string case；下一步应转去补 `responses`，不要继续在 anthropic 上做非必要打磨。

Tags: rust-migration, routecodex-3.11.1, semantic-mappers, anthropic, shadow-gate, coverage, preparedForShadow

- 2026-03-18: `routecodex-3.11.1` 在 anthropic 过 gate 后已切到 `responses` closeout。先补了 `responses-submit-tool-outputs` 的 fail-soft / fallback / dedupe / missing-tool-outputs 分支，以及 `responses-mapper` 的 submit endpoint 主路径与 bad-shape semantics context 回退；`test:coverage:hub-semantic-mappers-responses` 从 84.08/68.78 提升到 89.24/77.77。当前建议继续优先打 `responses-mapper` 主路径，不要过早切回 gemini。

Tags: rust-migration, routecodex-3.11.1, semantic-mappers, responses, coverage, submit-tool-outputs, shadow-gate, heartbeat

- 2026-03-18: 用户再次明确工作偏好：当任务进入异步等待/后台构建/长时验证/未知完成时间阶段时，必须使用 clock 做定时唤醒回查；除危险、破坏性或高度不确定操作外，大多数情况下不需要停下来询问用户，应该直接执行并持续推进主线。

Tags: user-preference, clock, async-wait, proactive-execution, no-unnecessary-questions

- 2026-03-18: 已新增全局 skill `~/.codex/skills/clock-follow-up/`，用于 RouteCodex 异步等待后的定时回查执行流。该 skill 与已有 `clock` 的分工为：`clock` 偏通用“何时应该设提醒”，`clock-follow-up` 偏执行型“提醒文案怎么写、醒来后如何按 complete/still-running/failed 三态继续执行、如何避免 reminder spam、如何区分 heartbeat 与 clock”。后续遇到 build/test/server/log/replay/provider 等未知完成时间任务时，优先用该 skill 约束 follow-up 行为。

Tags: skill, clock, clock-follow-up, async-wait, reminder, wakeup-state-machine, heartbeat-boundary

- 2026-03-18: `routecodex-3.11.1` semantic-mappers closeout 继续推进，responses 线已正式通过 shadow gate：`test:coverage:hub-semantic-mappers-responses` 提升到 lines 100 / branches 96.06，`verify:shadow-gate:hub-semantic-mappers-responses` PASS，并自动 promote `hub.semantic-mappers.responses-operation-table` -> `preparedForShadow=true`。本轮做法是：先用 public path 补主路径/submit-tool-outputs 分支，再把少量 helper 提升为命名导出做最小可测化，避免用非法 payload 硬撞 coverage。下一步应切去补 `gemini`，而不是继续打磨已过 gate 的 responses。

Tags: rust-migration, routecodex-3.11.1, semantic-mappers, responses, shadow-gate, coverage, preparedForShadow

- 2026-03-18: Heartbeat 定时精度排查已补上 **cron-shadow 对照诊断**，真源在 `sharedmodule/llmswitch-core/src/servertool/heartbeat/schedule-diagnostics.ts`。现在 heartbeat daemon 每次进入 due dispatch 判定时，都会把 `observedAtMs / daemonScanMs / effectiveIntervalMs / anchorAtMs / dueAtMs / dueInMs / latenessMs` 与 `cronShadow`（可映射时给出如 `*/10 * * * *` / `0 */2 * * *` 的 cron 表达式、上一/下一边界、边界偏移）落到 `state.lastScheduleDiagnostic` 和 history `details.scheduleDiagnostic`。长期结论：heartbeat 的“定时不准”不能只看触发时间，至少要同时区分 1) daemon scan 粒度带来的 lateness；2) due 后被 skip、随后按 scan 重试造成的累积 lateness；3) interval 本身不能稳定映射到 cron（如 sub-minute）时的不可比场景。验证：`sharedmodule/llmswitch-core npm run build:ci`、`node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/servertool/servertool-heartbeat-cron-shadow.spec.ts tests/servertool/servertool-heartbeat.spec.ts`、`./node_modules/.bin/tsc -p tsconfig.json --noEmit` 全通过；`npm run build:dev` 受 repo-sanity 的顶层 `.drudge` 阻塞，非本轮改动引起。

Tags: heartbeat, cron-shadow, timer-precision, daemon-scan, lateness, schedule-diagnostic, history, state, routecodex

- 2026-03-19: 用户新增明确执行偏好：**所有等待都需要 drudge alarm 超时唤醒**。后续凡是进入等待态（构建、重启、后台任务、异步验证、长时巡检、定时回查），默认优先使用 drudge alarm 作为超时唤醒机制，而不是只依赖 clock/心跳/记忆回头看；clock 仍可用于业务提醒，但等待控制的超时真源改为 drudge alarm。

Tags: user-preference, drudge, alarm, timeout, async-wait, waiting, workflow

- 2026-03-19: `/Volumes/extension/.rcc/errorsamples` 巡检表明当前空间问题几乎全由 `client-tool-error` 引起：清理前总量 131MB / 1367 files，其中 `client-tool-error` 约 128MB，主要是 `chat_process.req.stage2.semantic_map.exec_command`（462 条，几乎全是 `exec_command_non_zero_exit`）和 `...apply_patch`（150 条，主为 mixed GNU diff / expected lines not found / conflict markers）。这些样本大多是低价值重复噪音，而非新的 host 根因。已收紧真源：`src/utils/errorsamples.ts` 现在对 `client-tool-error` 默认使用更小预算（24KB/sample, 120 files, 12MB/group）；`src/modules/llmswitch/bridge/snapshot-recorder.ts` 现在对 client-tool 样本只写精简 trace/observation，并新增默认 30 分钟的跨 request 去重窗口（按 endpoint + stage + toolName + errorType）。已有目录已按用户要求清空到 0B。

Tags: errorsamples, client-tool-error, snapshot-recorder, dedup-window, compact-trace, apply_patch, exec_command, disk-usage, routecodex

- 2026-03-19: 执行 `npm run build:dev` 后检查 `/Volumes/extension/.rcc/errorsamples`，发现目录仍迅速恢复到 129MB / 624 files，且最新样本仍是 `maxBytes=262144` 的旧形态。继续核查后确认：当时 5555 监听进程并不是本次刚装的 `routecodex`，而是旧的全局 `@jsonstudio/rcc`（其 `dist/utils/errorsamples.js` 仍保留旧预算，如 `client-tool-error` 800 files / 128MB，样本单文件仍走 256KB 默认截断）。补做 `npm run install:release` 并 `rcc restart --port 5555` 后，5555 进程已切到本地仓库 `dist/index.js`，全局 rcc 预算也已更新为 `client-tool-error` 24KB / 120 files / 12MB；随后清空 `/Volumes/extension/.rcc/errorsamples`，当前为 0B / 0 files。可复用结论：只跑 `build:dev` / `install:global` 不能证明 live 5555 server 已换到新 errorsamples writer；必须同时确认**实际监听进程路径**与**全局 rcc 包版本/阈值**，否则会被旧受管 rcc 进程的历史写盘误导。

Tags: errorsamples, build-install, release-install, rcc, routecodex, live-server, port-5555, sample-budget, routecodex

- 2026-03-19: `apply_patch` 新一轮 errorsamples 复盘后确认，当前高频 mixed GNU diff 问题里还有一类**被 validator 放行、但仍会在客户端 apply_patch 校验阶段失败**的漏网形状：模型把 `diff --git` / `index` / `similarity index` / `rename from` / `rename to` 等 Git metadata 混进 `*** Update File:` 区块时，旧逻辑只会跳过 `---/+++`，却把其余 metadata 当成普通正文前缀成 `' '`，从而生成“看起来合法、实际 client 端会炸”的 patch。最小正确修复已落在 `sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/normalize.ts`：Update File 区块内现在会跳过上述 Git metadata，并把 `rename to ...` 归一成 `*** Move to: ...`；同时保留此前“+/- 后续裸行继承前缀”的兼容修复。验证：`tests/sharedmodule/apply-patch-validator.spec.ts`、`tests/unified-hub/runtime-error-errorsample-write.spec.ts`、`tests/utils/errorsamples.spec.ts` 通过，`sharedmodule/llmswitch-core npm run build` 全 matrix 通过，根仓 `npm run build:dev` / `install:global` / 5555 restart 通过，live 版本更新到 `routecodex 0.90.506` / `@jsonstudio/llms 0.6.4036`。

Tags: apply_patch, errorsamples, git-metadata, diff-git, rename-to, move-to, normalize, validator-gap, live-deploy, routecodex

- 2026-03-19: 再次巡检当前 errorsamples 后确认，`~/.rcc/errorsamples` 与 `/Volumes/extension/.rcc/errorsamples` 现在是**同一份样本目录**（samefile），当前仅剩 8 个小样本；其中真正独立类型主要是 1) provider 外部错误（tabglm 429 并发限流、crs 502 upstream gateway）和 2) client-tool 误用（`apply_patch_verification_failed` 首行不是 `*** Begin Patch`、`apply_patch_mixed_gnu_diff_inside_begin_patch`、`apply_patch_expected_lines_not_found`、`exec_command_non_zero_exit/failed`）。这说明当前磁盘噪音已收敛，残留 `apply_patch` 问题更偏**模型遵循/提示词问题**而不是 errorsamples writer 或 host 新根因。已把“internal patch 第一行必须是 `*** Begin Patch`、Begin Patch 与 GNU diff 不能混用、命中 expected-lines/context 先重读文件再重建 patch”的规则同步强化到 `src/config/system-prompts/codex-cli.txt` 与 `sharedmodule/llmswitch-core/src/guidance/index.ts`；针对该 guidance 的回归测试 `tests/sharedmodule/tool-guidance-exec-command.spec.ts` 已通过。

Tags: errorsamples, apply_patch, guidance, prompt, samefile, provider-429, provider-502, exec_command, routecodex

- 2026-03-19: semantic-mapper gemini 收口补测时命中一个可复用稳定性问题：历史 `assistant.tool_calls` 数组可能含 `null` / 非对象条目，原逻辑在 `collectAssistantToolCallIds()` 与 `synthesizeToolOutputsFromMessages()` 直接读取 `id` 会抛 TypeError。修复方式是最小正确层 guard（先判定 `call && typeof call === 'object'` 再读字段），并通过 `test:coverage:hub-semantic-mappers-gemini` + `verify:shadow-gate:hub-semantic-mappers-gemini` + family gate 复验，最终 `hub.semantic-mappers.gemini-operation-table` 与 family 都 promoted 为 `preparedForShadow=true`。可复用结论：对历史消息回放路径，tool_calls 必须按“不可信数组元素”处理，任何 id 提取都要先做对象形状校验。

Tags: routecodex-3.11.1, gemini-mapper, tool_calls, null-guard, malformed-history, semantic-mappers, shadow-gate, rust-migration

- 2026-03-19: 继续推进 `routecodex-267.5`，完成 `lmstudio_responses_input_stringify` 的 native 化收口：
  - TS action `lmstudio-responses-input-stringify.ts` 改为 native thin wrapper（调用 `applyLmstudioResponsesInputStringifyWithNative`）；
  - Rust 新增专用导出 `applyLmstudioResponsesInputStringifyJson`（`req_outbound_stage3_compat/lmstudio/request.rs` + `req_outbound_stage3_compat.rs` + `lib.rs`）；
  - 为避免 test/runtime 场景中 env 可见性差异，在 adapter context 的 `__rt` 增加 `lmstudioStringifyInputEnabled` 覆盖开关；Rust `core_utils.rs` 读取该开关优先于环境变量；
  - 兼容语义保持不变：仅在 `LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT=1` / `ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT=1` 且 `providerProtocol=openai-responses` 时生效。
  - 验证通过：`sharedmodule npm run build:ci`、lmstudio/field-mapping/harvest 三个 action 测试、`verify:shadow-gate:hub-req-outbound-compat`（100/100）、根仓 `npm run build:dev`、`/health`=0.90.514。

Tags: rust-migration, routecodex-267.5, lmstudio, responses-input-stringify, native-wrapper, req-outbound-compat, shadow-gate

- 2026-03-19: `routecodex-267.5` 继续收口，完成 `field-mapping.ts` native 化：
  - 新增 Rust 模块 `compat_field_mapping.rs`，实现 `apply_field_mappings_json(payload_json, mappings_json)`；
  - `lib.rs` 导出 `applyFieldMappingsJson`，TS `native-compat-action-semantics.ts` 新增 `applyFieldMappingsWithNative(...)`；
  - `conversion/compat/actions/field-mapping.ts` 由本地 180+ 行映射逻辑收敛为 native thin wrapper，保留原 type/interface 入口。
  - 回归验证：field-mapping/harvest/lmstudio 三组 compat action 测试全通过（9/9），`verify:shadow-gate:hub-req-outbound-compat` 100/100，根仓 build:dev + global install + 5555 health 通过（0.90.515）。

Tags: rust-migration, routecodex-267.5, field-mapping, native-wrapper, compat-actions, req-outbound-compat, build-dev

- 2026-03-19: `routecodex-267.5` 继续推进 `harvest-tool-calls-from-text.ts`：已改为 native thin wrapper（`harvestToolCallsFromTextJson`），新增 Rust 模块 `compat_harvest_tool_calls_from_text.rs` 并接入 loader required exports。关键兼容点：对 `reasoning_content` 先做 transport-noise 清理，再对 `exec_command<arg_key>... </tool_call>` 这类 bare 前缀形状补 `<tool_call>` 开标签后再收割 tool_calls，保持“形状修复、不改语义上下文”。验证：`sharedmodule npm run build:ci` 通过，`jest src/conversion/compat/actions/__tests__/harvest-tool-calls-from-text.test.ts --runInBand` 5/5 通过，根仓 `npm run build:dev`（含 install:global + 5555 restart）通过，live 版本 `routecodex 0.90.517` / `@jsonstudio/llms 0.6.4042`。

Tags: rust-migration, routecodex-267.5, harvest-tool-calls-from-text, native-wrapper, reasoning-content, shape-repair, no-semantic-trim, compat-actions, build-dev

- 2026-03-19: `routecodex-267.5` 继续 Rust 化 `compat/actions`，完成 `tool-schema.ts` 收口：新增 Rust 模块 `compat_tool_schema.rs` 与导出 `sanitizeToolSchemaGlmShellJson`，TS `tool-schema.ts` 改为 native thin wrapper（`sanitizeToolSchemaGlmShellWithNative`），保持 `glm_shell` 语义（移除 `function.strict`、规范 shell `command` 参数 schema、补 `required.command`、默认 `type=object` 与 `additionalProperties=false`）。新增回归 `src/conversion/compat/actions/__tests__/tool-schema.test.ts`（3/3），并与 `field-mapping`、`harvest-tool-calls-from-text` 一起回归（合计 10/10）。验证：`sharedmodule npm run build:ci` 通过，根仓 `npm run build:dev`（含 install:global、5555 restart）通过，live 版本更新到 `routecodex 0.90.518` / `@jsonstudio/llms 0.6.4042`。

Tags: rust-migration, routecodex-267.5, tool-schema, glm-shell, native-wrapper, compat-actions, no-semantic-trim, build-dev, global-install

- 2026-03-19: `routecodex-267.5` 继续收口 `compat/actions`，完成 `apply-patch-fixer.ts` native 化：新增 Rust 模块 `compat_fix_apply_patch.rs` 与导出 `fixApplyPatchToolCallsJson`，TS action `apply-patch-fixer.ts` 改为 native thin wrapper（`fixApplyPatchToolCallsWithNative`）。新逻辑保持“仅形状修复、不裁剪语义上下文”：只处理 assistant/function/apply_patch 且 `arguments` 为 string 的条目；支持单行 `*** Begin Patch *** Add/Update/Delete File` 展开与 Add File 正文补 `+`；输出统一为 `{\"patch\":...,\"input\":...}`；对仍含 `diff --git/index/rename` 元数据的 payload 保守跳过，避免把潜在非法 patch 强改后放大风险。新增回归：`src/conversion/compat/actions/__tests__/apply-patch-fixer.test.ts`（2/2）+ Rust 模块单测（2/2）；并联合 `tool-schema/field-mapping/harvest` compat action 回归（12/12）。验证：`sharedmodule npm run build:ci`、`npx jest ...compat/actions/__tests__... --runInBand`、`tests/responses/responses-openai-bridge.spec.ts -t shape-repairs...`、根仓 `npm run build:dev`（含 install:global + 5555 restart）全部通过，live 版本 `routecodex 0.90.519`。

Tags: rust-migration, routecodex-267.5, apply-patch-fixer, apply_patch, native-wrapper, shape-repair, no-semantic-trim, compat-actions, build-dev, live-deploy

- 2026-03-19: Rust 化推进中顺手修复一个隐性断点：`sharedmodule/llmswitch-core/src/conversion/compat/actions/index.ts` 残留了不存在的 `./apply-patch-format-fixer.js` import，平时因入口路径未触发不明显，但在 action 索引加载场景会直接 module-not-found。已移除该幽灵 import，保持 `apply-patch-fixer` 单一真源；同时清理 `compat_fix_apply_patch.rs` 未使用导入。验证：`sharedmodule npm run build:ci`、4 个 compat action 回归（apply-patch-fixer/tool-schema/field-mapping/harvest）12/12、根仓 `npm run build:dev`（含 install:global + 5555 restart）通过，live 版本 `routecodex 0.90.520`。

Tags: rust-migration, compat-actions, apply-patch-fixer, module-not-found, dead-import, build-dev, live-deploy

- 2026-03-19: `routecodex-3.11.7` 首轮推进完成“HubPipeline normalize 编排元信息 native 前移”：Rust `run_hub_pipeline` 不再只回填 `providerProtocol`，而是统一产出 `entryEndpoint/providerProtocol/processMode/direction/stage/stream/routeHint`，并在同一层完成 stopMessage tmux 会话别名归一（`clientTmuxSessionId/client_tmux_session_id/tmuxSessionId/tmux_session_id`）与 `runtime.applyPatchToolMode` 推导（env 优先，再从 tools 形状识别）。TS `hub-pipeline.ts` 的 `normalizeRequest` 改为把完整 metadata 送入 native，并以 native 返回字段作为 `NormalizedRequest` 权威值，减少 TS 侧编排决策重复。关键约束保持不变：不裁剪上下文、不改请求语义，仅做形状与编排规范化。验证通过：`cargo test ... hub_pipeline`（49 passed，含新增 3 个用例）+ `sharedmodule npm run build:ci` + 根仓 `npm run build:dev`（install:global + 5555 restart）。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, orchestration, native-primary, normalize-request, stop-message, apply-patch-tool-mode, no-semantic-trim

- 2026-03-19: `routecodex-3.11.9` phase-1 已落地：将 Anthropic 响应侧 stop_reason 决策从 TS 下沉到 Rust（`hub_resp_outbound_client_semantics.rs` 新增 `resolveAnthropicStopReasonJson`），统一输出 `normalized / finishReason / isContextOverflow`，`response-runtime.ts` 改为消费 native 结果来做 context-overflow fail-fast 与 finish_reason 映射。可复用结论：响应侧 finish/status 归一属于高频 shape 语义，应放入 native 真源，TS 仅保留 transport 适配层。另一个测试层经验：responses reasoning 在 payload 中可能以 `content[].text` 或 `summary[].text` 表达同一语义，断言应基于“语义文本存在”而不是绑定单一字段形状，避免误报回归。

Tags: rust-migration, routecodex-3.11.9, response-runtime, provider-response, anthropic, stop-reason, finish-reason, native-primary, shape-semantics, tests

- 2026-03-19: `routecodex-3.11.9` 同轮补充收口：`provider-response.ts` 的 client protocol 解析从本地 endpoint 字符串判断迁移到 `resolveHubClientProtocolWithNative`，确保 request/response 两侧协议判定使用同一 native 真源，避免未来 `/v1/*` 入口规则漂移时两处逻辑分叉。

Tags: rust-migration, routecodex-3.11.9, provider-response, protocol-resolution, native-source-of-truth, hub-pipeline

- 2026-03-19: `routecodex-3.11.9` phase-2 继续收口 response 路径：把 `provider-response.ts` 里剩余两块高频语义分支前移 native 真源——(1) tool-surface shadow 诊断用的工具调用摘要（openai-chat / openai-responses / anthropic 三协议），(2) `ProviderProtocolError.details.providerType` 判定。实现为 Rust `hub_resp_outbound_client_semantics.rs` 新增 `summarizeToolCallsFromProviderResponseJson` + `resolveProviderTypeFromProtocolJson`，TS wrapper 新增 `summarizeToolCallsFromProviderResponseWithNative(...)` + `resolveProviderTypeFromProtocolWithNative(...)`，并在 `provider-response.ts` 删除本地 `summarizeToolCallsFromProviderResponse`/`inferProviderTypeFromProtocol` 分支。验证链通过：两个 Rust 单测 + response-runtime anthropic-hidden-reasoning jest + responses-openai-bridge shape-repairs + sharedmodule build:ci + root build:dev/install:global/restart + `/health` 0.90.524。另一个可复用经验：根仓某些旧测试入口仍受 `import.meta` 与 CJS transform 冲突影响（如 provider-response-single-entry-intercept），失败时应先判定为测试基建问题，不要误归因到本轮 response 语义变更。

Tags: rust-migration, routecodex-3.11.9, provider-response, response-runtime, tool-surface-shadow, provider-type, native-primary, no-semantic-trim, build-dev, test-infra

- 2026-03-19: `routecodex-3.11.9` 在 phase-2 后继续做了一轮 response thin-shell 收口：清理 `response-runtime.ts` 与 `provider-response.ts` 中已经不再参与主路径的 TS 旧分支（Anthropic alias/sanitize/tool-result 旧链路与 provider-response 的本地 helper）。这类“native 已接管后仍残留 TS helper”的代码不会立即坏，但会长期增加语义漂移与误修风险；在 Rust 化推进中应及时删除死分支而不是长期并存。验证通过：response-runtime anthropic hidden reasoning + anthropic text tool markup + stopmessage anthropic stop_sequence + sharedmodule build:ci + root build:dev/install/restart，live `/health` = 0.90.525。

Tags: rust-migration, routecodex-3.11.9, response-runtime, provider-response, thin-shell, dead-code-cleanup, native-primary, no-semantic-trim

- 2026-03-19: `routecodex-3.11.9` phase-3 新切片把 `provider-response.ts` 的 internal debug marker 清理从 TS 本地 delete 分支迁移到 native action（`applyResponseBlacklistWithNative`）。这类“字段黑名单清理”属于通用 response compat 语义，不应在 hub response runtime 再写一份本地删除逻辑；正确做法是 TS 只给出 policy paths，实际清理由 native 真源执行。验证通过：response-runtime anthropic tests + stopmessage anthropic stop_sequence + sharedmodule build:ci + root build:dev/install/restart，live `/health`=0.90.526。另：根仓 provider-response-converter.finish-reason 测试失败仍是既有 Jest ESM/CJS transform 基建问题，需单独处理。

Tags: rust-migration, routecodex-3.11.9, provider-response, applyResponseBlacklist, native-compat-action, response-shape, thin-shell, no-semantic-trim, test-infra

- 2026-03-19: `routecodex-3.11.9` 继续把 Anthropic completion outcome 决策前移 native：新增 `resolveAnthropicChatCompletionOutcomeJson`（Rust）与 `resolveAnthropicChatCompletionOutcomeWithNative`（TS wrapper），统一输出 `normalized/finishReason/isContextOverflow/shouldFailEmptyContextOverflow`。`response-runtime.ts` 不再本地推断 finish_reason/overflow-empty fail gate，而是直接消费 native outcome。可复用结论：当 stop_reason 派生出的多个判定（finish_reason + fail-fast gate）存在联动时，应该作为单一 native outcome 一次性产出，避免 TS 侧分散条件分叉导致语义漂移。验证链通过：cargo filter test + response-runtime/anthropic tests + stopmessage anthropic + sharedmodule build:ci + root build:dev/install/restart，live `/health`=0.90.527。

Tags: rust-migration, routecodex-3.11.9, anthropic, completion-outcome, finish-reason, fail-fast, native-primary, response-runtime, no-semantic-trim

- 2026-03-19: `routecodex-3.11.7` 继续收口 HubPipeline 编排残余 helper：已将 `maybeApplyDirectBuiltinWebSearchTool` 的核心语义（anthropic + search route gate、runtime `webSearch.engines` direct+builtin 匹配、`maxUses` 归一、canonical web_search tool 替换/插入）前移到 Rust `hub_pipeline.rs`，新增 NAPI `applyDirectBuiltinWebSearchToolJson` 与 TS wrapper `applyDirectBuiltinWebSearchToolWithNative`；`hub-pipeline.ts` 现为 thin wrapper，不再保留整段本地 TS 编排分支。可复用结论：这类“路由命中后对 provider payload 的工具编排注入”应收敛到 native 单一真源，避免同一策略在 TS/Rust 双份实现长期漂移。验证通过：`cargo test ... apply_direct_builtin_web_search_tool` + `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global/restart` + `/health`=0.90.530。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, web-search, direct-builtin, native-primary, tool-injection, thin-shell, no-semantic-trim

- 2026-03-19: `routecodex-3.11.7` 再收口一段 HubPipeline 编排 helper：`liftResponsesResumeIntoSemantics` 已前移 native 真源。Rust `hub_pipeline.rs` 新增 `lift_responses_resume_into_semantics`（NAPI `liftResponsesResumeIntoSemanticsJson`），统一处理 “从 metadata 注入 `semantics.responses.resume`（仅当缺失时）+ 清理 metadata.responsesResume” 的双侧编排；TS `hub-pipeline.ts` 仅保留 thin wrapper 并原地同步 metadata，避免 request/metadata 联动逻辑分散在 TS。可复用结论：对同一语义同时改写 request 与 metadata 的 helper，必须在 native 一次性输出结果，避免 TS 多处分支造成字段状态不一致。验证通过：`cargo test ... lift_responses_resume_into_semantics` + `sharedmodule npm run build`（matrix）+ 根仓 `npm run build:dev/install:global/restart` + `/health`=0.90.531。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, responses-resume, semantic-lift, metadata-cleanup, native-primary, thin-shell, no-semantic-trim

- 2026-03-19: `routecodex-3.11.7` 继续收口 HubPipeline helper：`syncResponsesContextFromCanonicalMessages` 已切 native。Rust `hub_pipeline.rs` 新增 `sync_responses_context_from_canonical_messages`（NAPI `syncResponsesContextFromCanonicalMessagesJson`），当 `semantics.responses.context` 存在时，统一在 native 基于 canonical `messages/tools` 重建 `input` 与 `originalSystemMessages` 并回填 context；TS helper 改为 thin wrapper。可复用结论：凡是“桥接历史重建 + context 回填”的编排逻辑应在 native 真源集中，避免 TS 侧重复桥接构建导致上下文字段漂移。验证通过：`cargo test ... sync_responses_context_from_canonical_messages` + `sharedmodule npm run build`（matrix）+ 根仓 `npm run build:dev/install:global/restart` + `/health`=0.90.532。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, responses-context, bridge-history, canonical-messages, native-primary, thin-shell, no-semantic-trim

- 2026-03-19: `routecodex-3.11.7` 再次推进 HubPipeline thin-shell：移除 `resolveSseProtocol` / `extractModelHint` / `resolveOutboundStreamIntent` / `applyOutboundStreamPreference` / `resolveActiveProcessMode` / `assertNoMappableSemanticsInMetadata` 六个 TS helper，并改为调用点 direct native wrapper（`resolveSseProtocolWithFallbackWithNative`、`extractModelHintFromMetadataWithNative`、`resolveOutboundStreamIntentWithNative`、`applyOutboundStreamPreferenceWithNative`、`resolveActiveProcessModeWithNative`、`findMappableSemanticsKeysWithNative`）。关键结论：对“一次调用即转发 native”的 TS helper 应优先删除，保持 hub-pipeline 只做编排而不保留重复语义壳。验证通过：`sharedmodule npm run build`（matrix）+ 根仓 `npm run build:dev/install:global/restart` + `/health`=0.90.545。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, direct-native, sse-protocol, model-hint, semantic-gate, outbound-stream, active-process-mode

- 2026-03-20: `routecodex-3.11.9` 再做一轮 response thin-shell 收口：`response-runtime.ts` 删除最后两个顶层 reasoning helper（`collapseReasoningSegments` / `normalizeMessageReasoningPayload`），改为 `buildOpenAIChatFromAnthropicMessage` 局部闭包，确保“只改形状组织、不改语义结果”。该切片完成后 `response-runtime.ts` 顶层 `function` helper 清零，文件行数 491（<500），并通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.557。可复用结论：当 helper 仅服务单一调用点且无跨模块复用价值时，优先局部闭包化以消除顶层漂移面；真正跨协议/跨路径语义再下沉 native 真源。

Tags: rust-migration, routecodex-3.11.9, response-runtime, thin-shell, top-level-helper-zero, reasoning-normalization, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.9` 在 response-runtime 顶层 helper 清零后，继续清理死状态 `aliasCollector`（tool_use 分支只写入从未读取）。这是零语义改动的薄壳收口：删除无效 state 写入可降低后续误判“alias map 生效来源”的调试噪声。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.558。

Tags: rust-migration, routecodex-3.11.9, response-runtime, dead-state-cleanup, aliasCollector, thin-shell, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.9` 收口补刀：在 response-runtime 清理 dead state 后，继续删掉未使用类型导入 `JsonValue`，保证文件仅保留真实依赖。该类“类型级 dead code”不会改变运行语义，但能降低后续 Rust 化时的认知噪声与误判依赖。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.559。

Tags: rust-migration, routecodex-3.11.9, response-runtime, dead-code-cleanup, unused-import, thin-shell, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.9` 继续 response thin-shell 收口：`provider-response.ts` 删除两个顶层 async helper（`maybeCommitClockReservationFromContext` / `coerceClientPayloadToCanonicalChatCompletionOrThrow`），改为 `convertProviderResponse` 局部闭包。语义保持不变：canonical coercion 失败仍抛 `MALFORMED_RESPONSE`，`providerType` 仍由 native 协议判定，clock reservation 仍在 outbound 成功路径后 best-effort 提交。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.560。

Tags: rust-migration, routecodex-3.11.9, provider-response, thin-shell, local-closure, canonical-coercion, clock-reservation, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.7` 小切片继续收口 HubPipeline：删除私有薄壳 helper `asJsonObject(...)`，并在两个调用点内联同等 object 断言（错误消息保持一致），属于“减少编排层壳函数、保留行为”的零语义改动。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.561。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, private-helper-cleanup, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.7` 继续 HubPipeline 私有 helper 收口：删除 `convertProcessNodeResult(...)`，并在两个 tool-governance nodeResult 入栈点内联同等映射（保持 `error.code/message/details` 形状不变）。这类“单用途 result 映射 helper”适合就地内联，能减少编排层壳函数而不改变行为。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.562。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, private-helper-cleanup, node-result-mapping, no-semantic-trim, build-dev

- 2026-03-20: `routecodex-3.11.7` 再收口 HubPipeline 私有 helper：删除 `unwrapReadable(...)`，并在 `normalizeRequest/materializePayload` 两处内联同等 Readable 提取逻辑。该切片属于“薄壳内联、不改行为”类型，目的在于压缩 orchestration 层 helper 面积。验证通过 `sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev/install:global` + `/health` 0.90.563。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, private-helper-cleanup, readable-extract, no-semantic-trim, build-dev
- 2026-03-20: `hub.response` 的 10s 尖峰并非 SSE decode 主因，而是 `continue_execution` 走 `clientInjectOnly` 时包含了 tmux 注入前置等待。根因链路：`session-client-registry.ts` 默认 `CLIENT_TMUX_INJECT_DELAY_MS=10000`，该等待发生在 `inject()` 内，并被整体计入 `hub.response` 计时。修复：新增 `client.inject_wait` 独立计时项并从 `hub.response` 中剔除，日志会显示 `client.inject_wait≈10s` + `hub.response` 回落到真实转换耗时。实现点：`provider-response-converter.ts` 回传 `timingBreakdown.hubResponseExcludedMs`，`request-executor.ts` 记录 `client.inject_wait` scope 且用净值写 `hub.response.completed`，`stage-logger.ts` 把 `client.inject_wait` 纳入 release usage timing breakdown。Tags: timing, hub.response, client-inject, continue-execution, stage-logger
- 2026-03-20: Rustify 3.11.7 薄壳继续收口：`hub-pipeline.ts` 删除私有 method `resolveProtocolHooks(...)`，改为文件级 `REQUEST_STAGE_HOOKS` 静态映射并在 `execute`/`executeChatProcessEntryPipeline`/两处 outbound protocol switch 调用点 direct 读取，协议行为保持不变。验证通过：`sharedmodule npm run build`（含 matrix）+ 根仓 `npm run build:dev`（install:global + 5555 restart）+ `/health`=`0.90.566`。Tags: rustify, hub-pipeline, thin-shell, protocol-hooks
- 2026-03-20: 按“批量清薄壳”策略继续 3.11.7：`hub-pipeline.ts` 一次性移除 4 个 class 私有 method（`coerceStandardizedRequestFromPayload`、`applyMaxTokensPolicy`、`materializePayload`、`convertSsePayload`），改为文件级函数真源并完成调用点切换；class 私有 method 现仅剩 3 个核心编排方法。验证通过：sharedmodule build+matrix、root build:dev/install:global/restart、`/health`=0.90.567。Tags: rustify, hub-pipeline, thin-shell, batch-cleanup
- 2026-03-20: `routecodex-3.11.7` 持续按“一次性清薄壳”推进 HubPipeline 文件级拆分：新增 `hub-pipeline-orchestration-helpers.ts`、`hub-pipeline-adapter-context.ts`、`hub-pipeline-request-normalization-utils.ts`，将 runtime/router metadata、stage recorder/outbound execution、adapter context 构建、payload 归一化与 `max_tokens` policy 从 `hub-pipeline.ts` 主文件外提。可复用结论：对“纯编排 helper + 单向数据变换”优先外提成文件级真源，并通过依赖注入（如 buildAdapterContext/applyMaxTokens callback）保持语义不变。结果：`hub-pipeline.ts` 2306→1625，验证通过 sharedmodule `npm run build`（matrix）+ root `npm run build:min`。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, file-split, orchestration-helpers, adapter-context, payload-normalization, no-semantic-trim
- 2026-03-20: `routecodex-3.11.7` 再做一轮 HubPipeline 主文件解耦：将 `normalizeHubPipelineRequest(...)` 从 `hub-pipeline.ts` 整体外提到 `hub-pipeline-normalize-request.ts`，并导出 `ProviderProtocol/NormalizedRequest/HubShadowCompareRequestConfig` 供外提模块复用。可复用结论：当某个函数已经是“单段编排流程 + 无需访问 class state”时，应整体外提为独立模块，而不是继续在主文件内拆细碎 helper；这样能更快压缩主文件并保持行为等价。验证通过：sharedmodule `npm run build`（matrix）+ root `npm run build:min`；`hub-pipeline.ts` 1625→1430。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, normalize-request, thin-shell, module-extraction, no-semantic-trim
- 2026-03-20: `routecodex-3.11.7` 再拆一层：把 `REQUEST_STAGE_HOOKS` 静态注册表与 `RequestStageHooks` 类型外提为 `hub-pipeline-stage-hooks.ts`，主文件只消费 registry，不再直接维护 protocol->adapter/mapper/context-capture 的装配细节。可复用结论：对“纯静态装配表”优先独立成 registry 模块，可显著降低主编排文件的 import 面和认知噪声。验证通过：sharedmodule `npm run build`（matrix）+ root `npm run build:min`；`hub-pipeline.ts` 1430→1377。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, stage-hooks, registry-extraction, thin-shell, no-semantic-trim

- 2026-03-20: `routecodex-3.11.10` 继续按“一次做完一块”推进 tool-surface 编排收口：将 `tool-surface-engine.ts`（650 行）拆分为 `tool-surface-diff.ts`（schema/history diff 真源）与 `tool-surface-convert.ts`（tool format detect/convert + candidate 构建 + expectedHistoryCarrier），主文件仅保留 sampling + stage record + enforce orchestration，行数降至 217（<500）。语义保持不变：observe/shadow/enforce 的 diff 记录、history carrier 纠偏、tool definitions 纠偏逻辑完全保留。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.10, tool-surface, orchestration, file-split, thin-shell, no-semantic-trim, build-min

- 2026-03-20: `routecodex-3.11.11` 继续做 fallback 噪音清理，完成 SSE native API 命名收口：`resolveSseProtocolWithFallbackWithNative` 重命名为 `resolveSseProtocolWithNative`，并同步 HubPipeline request normalization 调用点。该改动仅限命名层，不改 capability（仍为 `resolveSseProtocolWithFallbackJson`）与行为语义，目标是减少“native-required 语义已成立但名称仍携带 fallback 误导”的认知噪声。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.11, fallback-cleanup, naming-cleanup, sse-protocol, native-required, build-min

- 2026-03-20: `routecodex-3.11.9` 继续 provider-response 收口，新增 `provider-response-observation.ts` 作为 response 观测真源，统一封装 (1) tool-surface shadow mismatch 记录（provider_inbound/client_outbound），(2) policy observe 记录。`provider-response.ts` 删除重复 try/catch 观测分支并改为复用 helper，行数 484→451；行为保持不变（仅编排去重、无语义改写）。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.9, provider-response, observation, tool-surface-shadow, policy-observe, file-split, no-semantic-trim, build-min

- 2026-03-20: `routecodex-3.11.9` 继续 response thin-shell 收口：将 `response-runtime.ts` 拆分为 re-export 入口薄壳（5 行）与 `response-runtime-anthropic.ts`（486 行）语义实现文件，保持现有对外 import 路径不变（`response-runtime.js` 仍是统一入口）。该切片属于文件级模块化，不改运行语义，仅降低入口文件复杂度并为后续 response 语义继续拆分预留边界。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.9, response-runtime, file-split, thin-shell, re-export, no-semantic-trim, build-min

- 2026-03-20: `routecodex-3.11.11` 继续 fallback 命名收口，完成 SSE native capability 级别统一：`resolveSseProtocolWithFallbackJson` 改为 `resolveSseProtocolJson`（Rust NAPI 导出 + native loader required exports + TS semantics capability 常量同步）。结论：在 native-required 路径里，保留 fallback 字样会长期误导定位；应同时清理“函数名 + capability 名 + loader 导出名”三处，避免后续出现“接口名已改但 capability 仍旧”的半收口状态。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.11, fallback-cleanup, capability-rename, sse-protocol, native-loader, no-semantic-trim, build-min

- 2026-03-20: `routecodex-3.11.11` 在完成 SSE capability 重命名后继续做“内部命名闭环”：Rust `hub_pipeline.rs` 将 `resolve_sse_protocol_with_fallback` 收口为 `resolve_sse_protocol`，并同步对应单测命名/调用。结论：fallback 命名清理要做全链路（TS wrapper + capability + loader + Rust 内部函数 + tests），否则后续排查会出现“外层已改、内层仍旧”的术语漂移。验证通过 `sharedmodule npm run build`（matrix 全绿）+ 根仓 `npm run build:min`。

Tags: rust-migration, routecodex-3.11.11, fallback-cleanup, rust-internal-rename, sse-protocol, no-semantic-trim, build-min

- 2026-03-21: `routecodex-3.11.7` 继续收口 HubPipeline adapter-context 语义，新增 native 真源 `resolve_adapter_context_metadata_signals_json`（TS wrapper: `resolveAdapterContextMetadataSignalsWithNative`），将 `clientRequestId/groupRequestId/modelId/estimatedInputTokens/sessionId/conversationId` 的提取与归一从 `hub-pipeline-adapter-context.ts` 下沉到 Rust；TS 调用点改为 direct-native，保留 runtime/capturedChatRequest/clientConnectionState 透传语义不变。`estimatedInputTokens` 维持原行为：按 `estimatedInputTokens → estimated_tokens → estimatedTokens` 取值，Number-like 归一后 `round + max(1)`，仅在 `>0` 时输出。验证通过：targeted cargo test + llmswitch build(matrix) + root build:min + install:global + review-followup 测试。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, metadata-signals, native-primary, no-semantic-trim, build-min, install-global

- 2026-03-21: `routecodex-3.11.7` adapter-context 路径继续收口 object carriers：新增 native 真源 `resolve_adapter_context_object_carriers_json`（TS wrapper: `resolveAdapterContextObjectCarriersWithNative`），将 `runtime` 与 `capturedChatRequest` 的对象判定/提取从 `hub-pipeline-adapter-context.ts` 下沉到 Rust；TS 侧改为 direct-native 读取并透传，减少本地重复 shape 分支。语义保持：仅当字段为对象时输出，数组/标量保持忽略。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, object-carriers, native-primary, no-semantic-trim, build-min, install-global

- 2026-03-21: `routecodex-3.11.7` adapter-context object carriers 再收口一刀：在 `resolve_adapter_context_object_carriers_json` 中新增 `clientConnectionState` object carrier，并将 `hub-pipeline-adapter-context.ts` 的本地对象判定分支删除，统一走 direct-native carrier 读取。可复用结论：adapter-context 下“metadata 对象载荷透传”应合并在同一 native helper 里（runtime / capturedChatRequest / clientConnectionState），避免 TS 端散落多个 object-shape 分支。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, object-carriers, clientConnectionState, native-primary, no-semantic-trim

- 2026-03-21: `routecodex-3.11.7` adapter-context object carriers 再收口：`resolve_adapter_context_object_carriers` 现在在同一 native 输出里合并 `clientDisconnected` 信号（复用 `resolve_adapter_context_client_connection_state`），并把 `hub-pipeline-adapter-context.ts` 的重复 native 调用去掉，改为直接消费 object carriers 的 `clientDisconnected`。这样 adapter-context 的 object/connection 信号都走单次 direct-native 读取，减少并行 helper 漂移风险且保持原语义（state flag + metadata 显式 true 覆盖）不变。验证链：cargo test（object_carriers + client_connection_state）+ sharedmodule build(matrix) + root build:min + install:global + review-followup 回归。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, object-carriers, clientDisconnected, native-primary, thin-shell, no-semantic-trim, review-followup

- 2026-03-21: `routecodex-3.11.7` adapter-context 继续做“单入口真源”收口：在 object carriers 已承载 `clientDisconnected` 后，移除了专用 NAPI/TS wrapper 表面（`resolve_adapter_context_client_connection_state_json` 与 `resolveAdapterContextClientConnectionStateWithNative`），并从 loader required exports 删除对应 capability。可复用结论：当同一语义已经被更高层聚合输出覆盖时，应及时删除并行 capability，避免后续调用点重复 native round-trip 与接口漂移；内部语义函数可保留供聚合 helper 复用。验证链：cargo test（object_carriers + client_connection_state）+ sharedmodule build(matrix) + root build:min + install:global + review-followup。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, adapter-context, clientDisconnected, capability-cleanup, native-loader, thin-shell, single-source-of-truth

- 2026-03-21: `routecodex-3.11.7` 继续收口 HubPipeline orchestration thin-shell：删除 `hub-pipeline-orchestration-helpers.ts` 的三段 nodeResult 转发壳（`appendReqInboundNodeResult` / `appendReqInboundSkippedNode` / `appendReqOutboundNodeResult`），并在 request-stage/chat-entry/route-outbound 三处调用点改为 direct-native node builder。可复用结论：当 helper 只做“参数转发 + push nodeResults”且已存在 native builder 真源时，应优先删除中间壳，避免编排层残留无语义价值的转发函数。验证链通过：sharedmodule build(matrix) + root build:min + install:global + review-followup。

Tags: rust-migration, routecodex-3.11.7, hub-pipeline, thin-shell, node-result, direct-native, orchestration, no-semantic-trim

- 2026-03-22: opencode-zen 401/429 排查确认“可用性差异”核心在请求头对齐，而非 OAuth。Zen 鉴权继续使用 API Key（`Authorization: Bearer <key>`）；参考 `aiapi` 的 Zen 实现与本地 opencode 二进制行为，补齐 Zen 路径 `x-opencode-project/session/request/client` 头透传与 metadata 派生，并在 Zen 路径显式移除 `originator/session_id/conversation_id` 旧头，避免与 opencode 头部语义冲突。验证链：`tests/providers/core/runtime/http-transport-provider.headers.test.ts` 新增/通过（9/9）；`npm run build:dev` + `npm run install:release` 成功；`routecodex --version`/`rcc --version`=0.90.698；5520 `/v1/responses` 对 `mimo-v2-pro-free` 与 `minimax-m2.5-free` 返回 200（不再是 401）。

Tags: opencode-zen, auth-header-alignment, x-opencode-headers, bearer-apikey, no-oauth, provider-runtime, release-build

- 2026-04-10: qwen 多账号 provider 的配置真源是**单一** `~/.rcc/provider/qwen/config.v2.json` 的 `provider.auth.entries[]`；把账号拆成多份 `config.v2.<alias>.json` 不会替代主配置。`tokenFile: "default"` 只会钉住单 token，而 `auth.entries[]` 才会在 bootstrap 阶段展开成 `qwen.<alias>.<model>` 多 runtime（本次验证为 6 个：`1 / 2-135 / 3-geetasamoda / 4-jasonqueque / 5-antonsoltan / 6-xfour8605`）。验证链：bootstrap 产物出现 6 个 `qwen.*.qwen3.6-plus` runtime，5555 SIGUSR2 热重载成功，`qwen.qwen3.6-plus` 在线请求返回 200，日志命中多个 qwen alias。

Tags: qwen, multi-token, auth.entries, provider-config-v2, bootstrap-runtime, hot-reload

- 2026-04-12: 文本工具收割里，shell 兼容只能修**外层 wrapper 形状**，不能改 shell body 语义。本轮有效做法：仅把 `bash-lc` 归一成 `bash -lc`，并在 `bash -lc '...` 这类**简单缺失闭合单引号**、且 body 内无额外单引号时自动补尾引号；`cmd` 正文内容、空格、参数、内部 quoting 一律透传，不做“聪明解析”。验证链：`router-hotpath-napi` 定向单测通过，5520 live `/v1/responses` 已返回可执行的 `exec_command {"cmd":"bash -lc 'pwd'"}`，并确认最近 DeepSeek provider 样本里的 heredoc tool call 可被正常收割。

Tags: text-harvest, exec-command, shell-wrapper, bash-lc, compat, no-semantic-trim

- 2026-04-12: RouteCodex 系统内**所有时间相关口径都按本地时间**，不要默认按 UTC 推断；包括 reset 编号、quota/reset 窗口、以及同类的“今天/本轮/重置点”计算与展示。排查/实现这类逻辑时，先确认本地时区语义，再看日志与编号。

Tags: local-time, timezone, quota, reset, numbering, project-rule

- 2026-04-16: servertool unified skeleton 第二刀确认有效：Host 壳层里的 followup nested dispatch 与 followup 错误标记都要做**单点 helper 真源**，不要让 `executor-response.ts` / `provider-response-converter.ts` 各自维护一套。当前已落地：
  - `servertool-followup-dispatch.ts`：统一 nested metadata + clientInjectOnly 预处理 + nested execute
  - `servertool-followup-error.ts`：统一 `SERVERTOOL_* -> provider.followup` stage marker + compact logging + converter 默认 502
  可复用结论：followup 若要当普通请求回流，就必须先把 host 壳层的“重进请求”和“错误标记”两个入口压成单点，否则后续虚拟路由/错误中心再统一也会反复串台。

Tags: servertool, unified-skeleton, followup, host-shell, single-source-of-truth, provider-followup

- 2026-04-16: `request-executor` 外层错误出口也要做 host 壳层单点化：`runtime_resolve` / `provider.send` 不能各自手拼 `reportProviderError -> resolveProviderRetryExecutionPlan -> buildProviderRetryTelemetryPlan`。当前已抽出 `resolveRequestExecutorProviderFailurePlan(...)` 和 `emitRequestExecutorProviderRetryTelemetry(...)`；可复用结论：当 followup / http / sse 的 stage marker 已前移后，外层只保留一个 failure orchestrator，避免同一错误在不同 catch 里重新分叉。

Tags: request-executor, provider-failure, retry-telemetry, host-shell, single-source-of-truth, provider-followup, provider-http, provider-sse
- 2026-05-09: apply_patch shell-wrapper compatibility now follows a stricter “shape-repair-only if information is sufficient” rule. 可复用规则：exact `bash|zsh|sh -lc|-c apply_patch <<PATCH`、`cd rel && apply_patch <<PATCH`、以及显式 `cmd/command + workdir + patch body`/nested result-payload-data wrapper，应统一在 Rust `compat_fix_apply_patch.rs` 真源做回收并归一成 canonical apply_patch；但凡需要解释额外 shell 命令、猜工具名、补 hunk 或补文件语义，必须 fail-fast 为显式 invalid/unsupported。验证：Rust compat 32 tests 通过，direct sample check 命中 Codex shell/cd 与 provider broken wrapper 正样本，regression verifier `mismatches=0`。

Tags: apply-patch, shell-wrapper, shape-repair-only, workdir-relativization, rust-ssot, regression-verifier, 2026-05-09

- 2026-05-10: `responsesResume -> continuation` 这类 req_inbound / hub_pipeline 语义提升现在部分由 Rust native hotpath 执行。可复用规则：凡修改 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` 下影响 inbound/outbound semantics 的逻辑，**先执行** `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`，再跑对应 Jest/运行态验证；否则 Jest 可能继续加载旧的 `dist/native/router_hotpath_napi.node`，出现“源码已改但测试仍是旧行为”的假阴性。

Tags: native-hotpath, jest, router-hotpath-napi, build-gate, false-negative, 2026-05-10

- 2026-05-12: DeepSeek-Web `DEEPSEEK_FILE_UPLOAD_FAILED` 本轮已验证的一类真因不是 session 坏，也不是 file-id 递归漏解析，而是 **history context 上传文件名为无扩展名 `context`** 时，上游 `upload_file` 会返回 `{"code":0,"data":{"biz_code":9,"biz_msg":"unsupported file type"}}`。可复用规则：DeepSeek context file 必须用**显式 `.txt` 文件名**（当前收敛为 `context.txt`），且 upload success/failure 判断必须同时检查 **HTTP status + top-level `code` + `data.biz_code/biz_msg`**；不能把 `code=0 但 biz_code!=0` 误报成 “succeeded without file id”。运行态证据：`~/.rcc/logs/server-10000.log` 出现该 payload；修复后 build/install/restart 到 `/health`=`0.90.1543`。

Tags: deepseek-web, file-upload, context.txt, unsupported-file-type, biz-code, no-session-corruption, upload-contract, runtime-verification, 2026-05-12

- 2026-05-12: `Provider runtime deepseek-web.key1 not found` 的真源不是 quota 脏数据，而是 **native Rust provider bootstrap** 会把 V2 provider 配置里的空 `auth.entries` 物化成默认 alias `key1`。可复用规则：排查 Virtual Router bootstrap/runtime alias 问题时，先看 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs`，不要误改 TS `bootstrap/auth-utils.ts`（当前无调用点）；对 `auth.entries` 空记录必须在 Rust `push_auth_entry_from_record` 入口直接忽略，避免生成幽灵 runtime。

Tags: virtual-router, provider-bootstrap, deepseek-web, key1, empty-auth-entry, rust-ssot, no-ts-dead-fix, runtime-alias, 2026-05-12

- 2026-05-12: Mimo `thinking` 400（`reasoning_content in the thinking mode must be passed back`）的真因不是上游误判，也不是 provider transport 问题，而是 **Anthropic 出站历史 assistant message 缺 reasoning_content**。可复用规则：先抓 `provider-request.json` 看上游实际收到的 `messages`；若坏形状已在 provider-request 中存在，唯一修复点应落在 **Rust `req_outbound_stage3_compat` 真源**。对 `anthropic-messages` + thinking 模式，assistant `tool_use` 历史必须补 `reasoning_content`（无文本时可用 `.`），纯文本 assistant 历史也必须回传 reasoning_content，否则上游会直接 400。

Tags: mimo, anthropic-messages, thinking, reasoning_content, req-outbound-stage3-compat, rust-ssot, 2026-05-12

- 2026-06-07: Hub Pipeline Phase 8F-4 已物理删除 5 个 0-consumer Virtual Router TS bootstrap 残留：`bootstrap/auth-utils.ts`、`bootstrap/claude-code-helpers.ts`、`bootstrap/config-normalizers.ts`、`bootstrap/web-search-config.ts`、`token-file-scanner.ts`。当前真源是 Rust native bootstrap (`bootstrapVirtualRouterProvidersJson` / `bootstrapVirtualRouterProviderProfilesJson` / `bootstrapVirtualRouterConfigMetaJson`) 与 `virtual_router_engine/provider_bootstrap.rs`；auth token scanning 的活跃 owner 是 `src/providers/auth/token-scanner/`。禁止为修复 bootstrap/runtime alias 问题复活这些 TS helper。

Tags: hub-pipeline-phase8f4, virtual-router-bootstrap, rust-ssot, dead-ts-deletion, no-resurrection, 2026-06-07

- 2026-06-07: Hub Pipeline Phase 8F-5 已物理删除 2 个 0-consumer Virtual Router engine helper：`engine/route-analytics.ts`、`engine/routing-state/metadata.ts`。它们没有 live source/test import、没有同名生成物；routing-state / route selection 语义不得在这些 TS helper 路径复活，继续由 Rust Virtual Router/native routing owner 承担。

Tags: hub-pipeline-phase8f5, virtual-router-engine, rust-ssot, dead-ts-deletion, no-resurrection, 2026-06-07

- 2026-06-07: Hub Pipeline Phase 8F-6 已物理删除 6 个 0-consumer native wrapper：`native-chat-process-governed-filter-semantics.ts`、`native-chat-process-post-governed-normalization-semantics.ts`、`native-chat-process-web-search-intent-semantics.ts`、`native-hub-pipeline-governance-semantics.ts`、`native-hub-pipeline-target-semantics.ts`、`native-virtual-router-stop-message-actions-semantics.ts`。保留 `native-failure-policy.ts`，因为 `src/modules/llmswitch/bridge/native-exports.ts` 与 `src/providers/core/runtime/provider-failure-policy-native.ts` 动态加载它。native capability 本身仍由 `native-router-hotpath-required-exports.ts` 锁定。

Tags: hub-pipeline-phase8f6, native-wrapper, required-exports, dynamic-bridge, dead-ts-deletion, no-resurrection, 2026-06-07

- 2026-05-13: port-mode 收口确认两个 owner 边界。可复用规则：`/admin/ports` 的配置真值 owner 只能是 `RouteCodexHttpServer.getPortConfigs()`；若 live listener 已按 runtime bind port 启动，但 `/admin/ports` 仍回磁盘旧端口，先对照 `src`/`dist` 的 `getPortConfigs()` 顺序，确认是否把 `userConfig.httpserver.port` 错盖回 runtime port，禁止去 PortRegistry 或 handler 层补第二真源。另一个边界是 `provider-direct-pipeline.ts::convertProtocolForRelay()`：relay 只允许在**已显式实现的协议对**内工作（当前 `openai-chat ↔ anthropic-messages`），其余跨协议必须 fail-fast，不能把未实现 semantic map 静默透传给 provider。验证链：Jest `port-mode-routing/provider-direct-pipeline`、`build:min`、`install:global`、10000 live `/admin/ports`、临时 provider 端口 direct/auto/relay 回放全部通过。

Tags: port-mode, admin-ports, getPortConfigs, runtime-bind-port, dist-drift, provider-direct, relay-boundary, fail-fast, live-10000, 2026-05-13

- 2026-05-13: Mimo save/restore 自循环的真因不是 tools 定义丢失，而是 save/restore 历史混入了 **assistant mirror turns**。可复用规则：若 `provider-request.json` 里 tools 仍完整存在，但 live 行为反复自述“接下来调用工具/无需继续分析”却不真调工具，先查历史里是否有 `role=assistant`、纯文本 `content`、`reasoning_content === content`、且无 `tool_calls` 的重复镜像轮次。唯一修复点是 `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.ts`；必须做**shape-only** 清理，并按 **每个 tool boundary segment** 删除重复 mirror assistant cluster，而不是只看最后一个 boundary。

Tags: mimo, save-restore, mirror-assistant, chat-process-request-sanitizer, shape-only, tool-boundary-segment, no-semantic-parse, 2026-05-13

- 2026-05-13: Responses/Anthropic save-restore 清理还有两个边界。可复用规则：**(1)** Anthropic `assistant.content=[{type:"tool_use"}]` 不是 empty assistant，不能在 sanitizer/contract path 里误删；**(2)** message 形状归一即使在“本轮没删 assistant”时也必须返回更新后的 messages，不能只在发生删除时才回写。反模式：在 `request-executor-response-contract.ts` 或 save/restore 清理链里加“句子像计划/自言自语就删”的文案级规则；这会制造第二实现面，必须禁止。

Tags: anthropic, tool_use, empty-assistant, request-executor-response-contract, shape-normalization, no-sentence-matching, no-second-surface, 2026-05-13

- 2026-05-14: client tool validator 边界必须固定为 **shape-only**。可复用规则：`provider-response-tool-validation-blocks.ts` 只允许检查 JSON object、required fields、基础 primitive type；禁止做 tool declared 审计、禁止修 shell wrapper、禁止把 `input.input/input.patches` 猜成 `apply_patch.patch`、禁止审 evidence/summary 质量。runtime 治理（连续错误/无进展/forced stopped）必须放在 goal state owner，不准塞回 validator。

Tags: validator, shape-only, no-audit, no-compat-guess, goal-state-owner, 2026-05-14

## 2026-05-14 validator边界纠偏
- 用户再次明确：不要把 runtime/router/provider failure 收敛塞进 validator 或 converter 前置门。
- 本次修正：provider-response-converter 只做合法 tool shape 投影，不再在 converter 内累计 validation failure / no_progress / irrecoverable followup 并强制 stopped。

## 2026-05-21 longcontext 路由真源
- 现行虚拟路由分类器里，`longcontext` 必须在 `thinking` 之前判定；否则 fresh user input 即使超长，也会先命中 `thinking`，导致 longcontext 无法接管。
- 唯一正确修复点是 Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs` 的 evaluation 顺序与 thinking gate：`thinking_from_user && !reached_long_context`。
- 回归锚点：`tests/servertool/virtual-router-thinking-longcontext-context-switch.spec.ts` 与 Rust classifier 长文回归。

## 2026-05-21 apply_patch / hashline 引导边界
- `apply_patch` 的唯一正确引导是 **patch-first canonical body**；不要在通用引导里暗示 `filePath`/`file_path`，也不要把 hashline 当成 canonical patch 的别名。
- `hashline` 只允许在显式 `filePath/file_path` 的收割入口接管，并且必须 fail-fast；引导层不要让模型“试格式、猜格式”。
- 回归锚点：`req_outbound_stage3_compat/*tool_definitions.rs`、`tool_text_request_guidance.rs`、`req_profiles.rs`、`hub_req_inbound_tool_call_normalization.rs` 的 hashline 入口测试。

- 2026-05-21: `buildCascadeCompletionFromOutput` 需要保留 assistant 的 `reasoning_content`，对齐 Windsurf reference 的 `chatToResponse()` 输出语义：reasoning 不应在 parser 里被吞掉，哪怕最终仍是 `chat.completion`。已补测试锚点并转绿。验证：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 定向通过。

Tags: windsurf, responses-parse, reasoning_content, chatToResponse, parser-ssot, 2026-05-21
- 2026-05-22: Windsurf 真实无 mock 鉴权链已验证通过。唯一正确的 PostAuth 真源是 `https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`，请求必须发送 `application/proto` 空 body，并同时发送 `X-Devin-Auth1-Token`、`Origin: https://windsurf.com`、`Referer: https://windsurf.com/account/login`、`connect-protocol-version: 1`。3 个真实账号（ws-pro-1/ws-pro-2/ws-pro-3）已通过 `checkHealth()` + `ensureWindsurfSessionCredential()` 无 mock 实测，证明 auth 真链已经打通；之前超时的唯一根因是 PostAuth request shape 错，而不是账号失效或网络不可达。
Tags: windsurf, auth, postauth, web-backend, protobuf, no-mock, live-verified, 2026-05-22


- 2026-05-22: Windsurf `chat -> provider -> cascade` 的真实无 mock 鉴权链已再次以 live probe 固化进仓库测试。`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` 现包含真实账号密码登录 -> `WindsurfPostAuth` -> `devin-session-token$...` 持久化 -> `checkHealth()` 直打 `GetCascadeModelConfigsForSite` 的无 mock 测试，并已在本机通过。`scripts/windsurf-auth-probe.ts` 也已改成同一真链：`ensureWindsurfSessionCredential()` + `checkHealth()`；禁止再调用旧的 cloud/status 假接口。
Tags: windsurf, cascade, auth, no-mock, live-probe, checkHealth, postauth, 2026-05-22

- 2026-05-22: Windsurf 请求主链真相已用“最黑盒”方式再次钉死：对同一份带 tools/history 的输入，同时实跑 RouteCodex 当前链与 WindsurfAPI 参考链，结果显示 RouteCodex 当前最终出站仍是 `GetChatCompletions` JSON 族（`metadata/chatMessagePrompts/systemPrompt/completionsRequest`），而 WindsurfAPI 真源最终出站是 `StartCascade -> SendUserCascadeMessage` protobuf/gRPC 族（local managed LS gRPC + Cascade）。因此当前 Windsurf live 问题优先判定为**路径问题，不是字段小形状问题**；`GetChatCompletions` 旧主链已被证伪，后续必须从文档、记忆、测试与实现中物理移除，只保留 `chat -> provider -> local managed LS gRPC -> StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll` 单一路径。
Tags: windsurf, cascade, request-path, blackbox-verified, getchatcompletions-invalid, single-path, remove-wrong-mainline, 2026-05-22

- 2026-05-22: Windsurf 运行时唯一真相是 `chat -> provider -> local managed LS gRPC -> Cascade`；仓内不允许 cloud JSON chat path 或任何第二套本地实现回流。
- 2026-05-22: 做 Windsurf / request-shape / live sample 排查时，样本与 snapshot 的当前真源目录应先看 `~/.rcc/codex-samples/`；把它写成 `~/.routecodex/codex-samples/` 属于错误旧路径。注意：这条只约束当前运行时样本/快照真源；仓内仍有一部分 legacy 迁移文档需要保留 `~/.routecodex` 作为旧目录叙事，不能机械全量替换所有 `.routecodex` 字符串。

- 2026-05-23: Windsurf 多账号/回收当前真相：多账号必须表现为多 runtime（`windsurf.ws-pro-N`）+ 多 provider target（`windsurf.ws-pro-N.<model>`），token/session alias 以 runtime key 派生，禁止共享 default。启动时每个 Windsurf runtime 默认 `checkHealth()` probe 一次；失败 runtime 直接不入池。weekly quota 按 account alias family 黑名单回收到本地 00:00 自动恢复；`[[httpserver.ports]].stopMessage.enabled=false` 是端口级 stopMessage 关闭入口，用于 5520 smoke 避免 tmux followup 污染。
Tags: windsurf, multi-account, runtime, quota, stopMessage, startup-probe, 2026-05-23

## 2026-05-23 Windsurf truncation / legacy tool marker leak
- Verified sample evidence: `~/.rcc/codex-samples/openai-responses/windsurf.ws-pro-4.gpt-5.4-medium/openai-responses-windsurf.ws-pro-4-gpt-5.4-medium-20260522T222745991-221951-635/provider-response-contract.json` showed visible truncated legacy `<tool_call>{"name":"echo","arguments":{"text":"ping"` with `finish_reason=stop`.
- Root cause truth: Windsurf Cascade assistant visible content must never pass through legacy `<tool_call>` / `<function_call>` markers. The only accepted text-tool protocol is RCC; legacy markers indicate malformed/truncated protocol text and must fail-fast as `WINDSURF_TOOL_PROTOCOL_CONFLICT` instead of being returned to clients.
- Regression anchor: `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` direct malformed legacy marker rejection was verified red-without-fix then green-with-fix; poll tests are supporting coverage for unclosed marker / stable-tail behavior, not claimed as separate red regressions.

- 2026-05-23: Windsurf startup probe hardening: `checkHealth() === false` must fail runtime init with `WINDSURF_STARTUP_PROBE_FAILED`; false is not a soft pass. Expired weekly quota blacklists are reset on quota maintenance/reload after local 00:00, then startup probe can re-admit usable accounts. Verified with targeted tests + live 5520 smoke on `gpt-5.4-none`.
Tags: windsurf, startup-probe, weekly-quota, runtime-init, 2026-05-23

## 2026-05-23 Windsurf Cascade history projection
- WindsurfAPI native bridge strips `role=tool` turns and assistant tool-call-only turns before building Cascade conversation text; completed native tool results belong in `additional_steps`, not visible `<assistant>` history blocks. RouteCodex must skip blank rendered Cascade history turns in `buildCascadePromptText()` to avoid empty `<assistant>\n\n</assistant>` fragments that confuse history continuity.
Tags: windsurf, cascade, history, native-bridge, WindsurfAPI, 2026-05-23

## 2026-05-23 Responses continuation tool retention
- Scoped Responses continuation must retain tool definitions after request payload release. It is valid to drop bulky `input` / base payload for memory, but `entry.tools` is small semantic state required for `resumeLatestResponsesContinuationByScope()`; clearing it makes the next turn lose tool capability while still carrying `previous_response_id`.
Tags: responses, continuation, tools, memory-retention, windsurf, 2026-05-23
- 2026-05-23: Windsurf 5520 multi-account requires both code and config truth: code must reject unusable runtimes at startup probe (`checkHealth() === false` => no handle), and routing pools must use round-robin/weighted multi-target selection; `mode="priority"` intentionally sticks to first available account and is not a multi-account concurrency configuration. Current 5520 config uses ws-pro-1..ws-pro-5 `gpt-5.4-none`, per-runtime `maxInFlight=1`, and no duplicate auth aliases.
Tags: windsurf, multi-account, routing, round-robin, startup-probe, quota, 2026-05-23

- 2026-05-23: Responses streamed `/v1/responses` tool_calls 必须在 `streamResponsesJsonAsSse()` 转 SSE 前写入 Responses conversation store；否则日志会出现 `finish_reason=tool_calls` 但 `responseIndex=0 scopeIndex=0 pendingNoResponseId>0`，下一轮无法靠 response id / scope 恢复工具状态。回归锚点：`tests/server/handlers/handler-response-utils.responses-conversation.spec.ts` 的 streamed Windsurf 10:03 样本，必须断言 response id、router request id、provider timing id 都调用 `recordResponsesResponseForRequest`。
Tags: responses, sse, windsurf, tool_calls, continuation-store, previous_response_id, red-green, 2026-05-23

- 2026-05-23: Windsurf upstream payload error 的原始 `error.code` 不得被 `WINDSURF_UPSTREAM_TRANSIENT` 覆盖；HTTP `status=502` 只表示代理分类，真实 upstream identity 必须透传为 `upstreamCode`（字符串）和 numeric `upstreamStatus`，并在 provider-switch 日志中同时显示。回归锚点：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` numeric upstream error code；`tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts` upstreamStatus log。
Tags: windsurf, upstream-error, provider-switch, retry-telemetry, no-502-collapse, 2026-05-23

## 2026-05-23 apply_patch / Windsurf 工具协议当前真源
- `apply_patch` client-facing 只暴露标准 canonical tool call；direct/provider-direct 与 router-direct same-protocol 必须原样透传，不注入第二套 authoring。
- relay/chat-process 的唯一请求侧改写点是 Rust `req_process_stage1_tool_governance.rs`：上游内部 schema 为 `filePath + fileContent + patch(-/+ internal line-edit)`；response/outbound 唯一映射点是 Rust response governance，把 internal line-edit 转回 canonical `*** Begin Patch ... *** End Patch`。
- Windsurf provider 当前 native caller map 只允许已证明等同的 one-shot shell 子集：`exec_command` / `shell_command -> run_command`；`apply_patch` 不映射到 `propose_code/write_to_file`，走 RCC unsupported text protocol 或未来显式 servertool。
- 通用 system prompt、provider prompt、文档和测试不得再引入 `apply_patch` 第二套 authoring guidance 或 Windsurf native alias guidance。

- 2026-05-23: 已废弃旧结论：Windsurf `apply_patch` 三段 native bridge（`apply_patch -> write_to_file/propose_code -> apply_patch`）经 app bundle 与 WindsurfAPI 对照后判定为错误方向；不得再按该条实现或测试。
Tags: windsurf, apply-patch, deprecated-native-bridge, write-to-file, propose-code, 2026-05-23
- 2026-05-23 apply_patch 当前唯一事实：Hub/chat-process 使用三段透明桥接——请求给模型改成 internal line-edit `filePath/fileContent/patch(- old/+ new)`；模型响应回 client 前转成 canonical Codex `*** Begin Patch`；client 执行结果/错误进入下一轮请求前转成 `APPLY_PATCH_RESULT`/`APPLY_PATCH_ERROR` internal line-edit 指导。唯一实现层是 Rust Hub Pipeline，不在 provider/Windsurf/TS prompt 增加第二语义。

- 2026-05-23: Windsurf 工具真相最终结论：Windsurf.app 只确认 `write_to_file`/`propose_code` 为 Cascade trajectory/proto step，未确认可控本地 executor；`apply_patch` 的 multi-file patch 与失败/aborted 语义不能等价 native 映射。RouteCodex 必须撤回 `apply_patch -> write_to_file/propose_code` native 伪装，改回 RCC 文本引导收割；所有不完全兼容工具只能做显式配置打开的 servertool 或文本收割，禁止伪装 native。`exec_command`/`shell_command` 可继续桥接到 `run_command`，仅限 one-shot blocking shell 子集。

## 2026-05-23 build/install/restart/live smoke outcome
- `npm run build:min` and `npm run install:global` both pass after fixing two Rust compile blockers in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` (`req_process_stage1_tool_governance.rs` borrow-after-move, `chat_servertool_orchestration.rs` stale `v` reference).
- `routecodex restart --port 5520` succeeds and `/health` reports `status=ok`, `ready=true`, `pipelineReady=true`, `version=0.90.2224`.
- Live `/v1/responses` smoke on 5520 still times out under a 30s client timeout, so runtime validation is not fully green yet; the remaining issue is live request latency/flow, not compile/install.


## 2026-05-23 Windsurf LS fd leak stopgap
- 真正的句柄/进程泄露止血点是 `src/providers/core/runtime/windsurf-chat-provider.ts` 的 managed local grpc runtime pool，不是单个 RouteCodex server。
- 已补 `WindsurfChatProvider.releaseManagedLocalGrpcRuntimes()` + `cleanup()` 统一收口，清理 managed LS pool / pending map，并对活的子进程发送 `SIGTERM` / `SIGKILL`。
- 回归锚点：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 新增 cleanup 清理池测试，确保以后不会再把 managed LS 留成活尸。
- 这只是止血；如果 live 仍然 fd 饱和，下一步继续查是否有更多未关闭的 Windsurf LS 进程或外部守护进程重复拉起。


- 2026-05-23: Windsurf 5520 timeout / fd exhaustion 的当前真源是 RouteCodex-managed local LS 生命周期与端口探测。已确认同一 `~/.rcc/windsurf-ls/<key>` 曾产生多组 `language_server_macos_arm`，导致 `ENFILE`、`lsof can't open pipes`、随后 provider lock/open 失败。可复用规则：Windsurf managed LS 必须按 account key 复用唯一 live runtime；同 key 多端口是冲突必须 fail-fast；`lsof/ps` 探测失败不得当作“端口空闲”或“无 live runtime”。禁止 fallback，先修 LS 真源再谈 retry。

Tags: windsurf, local-ls, fd-exhaustion, no-fallback, fail-fast, port-probe, managed-runtime, 2026-05-23

- 2026-05-23: apply_patch/stopless servertool followup 事实更新：`apply_patch` 默认 client 模式透传，显式 `[servertool.apply_patch].mode=servertool` 才在 Hub/servertool 本地执行；servertool 模式使用标准 followup 骨架（captured origin + injection ops），不得走 tmux/client injection，不得改 provider/Windsurf。`stop_message_flow` 也从旧 clientInjectOnly 事实迁出，Rust skeleton 中仅保留 stickyProvider/seedLoopPayload/retryEmptyFollowupOnce。验证：cargo `servertool`/`apply_patch` 通过；Jest stopless/apply_patch targeted 19/19；build/install/restart 10000 health 0.90.2226。
Tags: apply-patch, servertool, stopless, followup, no-tmux-inject, hub-pipeline

- 2026-05-23: Windsurf routing config 规则：业务配置不得手写 `windsurf.ws-pro-N.<model>` targets；只写 provider+model（如 `windsurf.gpt-5.4-none`），账号/alias 真源在 `~/.rcc/provider/windsurf/config.v2.toml` 的 `provider.auth.entries[]`，由 Virtual Router bootstrap 展开为多 runtime/target。验证锚点：`tests/sharedmodule/provider-model-direct-access.spec.ts` 覆盖 `ws-pro-1..5` 展开，活体 loader 产物确认 `windsurf.ws-pro-5` runtime 与 target 均存在。
Tags: windsurf, routing-config, auth-entries-expansion, no-handwritten-key-alias, 2026-05-23

- 2026-05-23: Windsurf 502 false-positive root cause: `pollCascadeTrajectorySteps()` previously treated any parsed trajectory `errorText` as `WINDSURF_UPSTREAM_TRANSIENT` 502. WindsurfAPI caller only throws when `step.type === 17 && step.errorText`; other field24/31 metadata can coexist with valid final text. Unique fix point is the provider poll execution predicate, not retry policy. Regression anchors in `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`: non-error metadata must continue to final text; ERROR step still fail-fast.
Tags: windsurf, 502, trajectory, errorText, WindsurfAPI-parity, no-retry-fix, 2026-05-23

- 2026-05-23: `apply_patch_flow` servertool followup 的 `MISSING_REQUIRED_TOOL_CALL` 502 根因是 `/v1/responses` nested followup 仍带 messages-only shape / stale requestSemantics，host contract 把 tool-result followup 误判为 required tool-call turn。唯一修复点在 `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` 的 nested input 构造：responses followup 必须先 normalize 成 input shape，并基于 normalized `function_call_output` 同步 `toolOutputs` 到 body semantics 与 metadata requestSemantics；不是 provider/retry 问题。
Tags: apply-patch, servertool-followup, responses, MISSING_REQUIRED_TOOL_CALL, 502, requestSemantics, 2026-05-23

- 2026-05-27: Virtual Router unified quota/health closeout 审计新增两条可复用真相：
  1. `same-shape Rust-only vs TS-poisoned equivalence` 才是 quotaView/second-center closeout 的正确 invariant；不要把“固定选 providerA”或“health 必须看起来 healthy”写成回归真相。
  2. `QUOTA_DEPLETED + resetAt` 的 multi-key 场景下，当前 Rust 真相允许 `quota freeze + health.tripped` 并存；真正要锁的是 providerKey 隔离、quota snapshot 正确、route 改到 sibling，而不是把 providerA health 强写成 healthy。
  3. `build:dev` + install:global + CLI E2E 可以独立证明安装态通过；若 `routecodex restart` 返回 `No RouteCodex server found on localhost:5555`，则不能把“managed restart 成功”继续当当前态证据。
  4. 进入 Phase E residue 审计时，先以当前仓库为准：计划文档里历史提到的 `virtual-router/health-manager.ts`、`engine/cooldown-manager.ts` 若已不存在，就不能继续把它们当残余 owner；当前真实 second-state residue 已收缩到 `sharedmodule/llmswitch-core/src/quota/quota-manager.ts` 与 `src/manager/modules/quota/provider-quota-daemon*.ts` 这一组 quota family 文件。
  5. Phase E 删除应分两刀推进：先切断 host runtime 对 legacy quota backend 的运行时可达性（adapter/daemon-admin 不再注入 legacy backend），再物理删除 `provider-quota-daemon*.ts` 等残余文件；这样能先消除“双真源仍可被运行时命中”的风险，再做文件级清场。
  6. 当第二刀完成后，`provider-quota-daemon*.ts` 与对应 legacy tests 必须一起物理删除；删除后若定向 host/admin consistency tests + `build:dev/install:global/5555 restart` 仍全绿，说明 host 侧双真源已真正清场，后续唯一剩余 closeout 点就收敛到 `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`。

Tags: virtual-router, quota-health, second-center, same-shape-equivalence, quota-resetat, health-tripped, build-dev, runtime-smoke, 2026-05-27

- 2026-05-27: Virtual Router unified quota/health closeout 当前新增两条硬规则：
  1) `scripts/tests/virtual-router-quota-health-shadow-regression.mjs` 必须显式保障 native path（优先注入 `ROUTECODEX_LLMS_ROUTER_NATIVE_PATH=sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`，不存在则退回外部已给路径），否则会出现 native proxy missing 型伪失败；
  2) `virtual-router-quota-resetat-multikey-native` 的正确断言是“providerKey 隔离 + reroute 到 sibling + quota snapshot 正确”，而不是把 providerA health 固定写死为 `tripped`；当前 Rust 真相允许 `tripped|healthy`。
Tags: virtual-router, quota-health, shadow-gate, native-path, multikey-resetat, assertion-invariant, 2026-05-27

- 2026-05-27: focused native regression（10 suites / 56 tests）在当前仓库是 `native required` 形态，执行时必须显式提供 `ROUTECODEX_LLMS_ROUTER_NATIVE_PATH` 指向 `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`；否则会统一报 `missing native proxy constructor`，这属于执行入口环境缺失，不应误判为 quota/health 语义回归。
Tags: virtual-router, native-required, focused-regression, router-hotpath, env-contract, 2026-05-27

- 2026-05-28: sticky 语义废弃基线：RouteCodex 不再支持 provider/route sticky。`stickyTarget` / `stickyProvider` / 基于上一跳 provider 的 followup pin 都是错误语义；continuation 也不能 sticky provider，只能根据 continuation store 的 direct/local ownership 选择链路。修复必须同时清 Rust VR state/parse/selection、TS servertool flow policy/followup metadata、测试与 docs 旧事实；验证至少包含 routing-instructions 对 `sticky:` 被忽略的回归和 HTTP 黑盒非 sticky 路由验证。
Tags: routecodex, virtual-router, sticky-removed, continuation-store-routing, servertool-followup

- 2026-05-28: Windsurf managed-account 请求内重试必须复用同一次 `resolveCascadeApiKey()` 选择出的账号；健康/extra quota 探测结果一旦进入 `windsurfHealthCache`，请求选择阶段不得按 60s TTL 每次刷新。若账号真实 quota exhausted，应标记该 alias 并把错误交给外层 provider/VR 策略，禁止在同一上游请求内静默换账号重跑。回归锚点：`tests/providers/core/runtime/windsurf-account-health-routing.spec.ts` 的 account health probe cache 测试；`tests/providers/core/runtime/windsurf-chat-provider-regression.spec.ts` 的 transient cascade retry selected account 测试。
Tags: windsurf, managed-account, health-probe, extra-quota, no-request-account-switch, red-green, 2026-05-28

- 2026-05-28: Responses submit_tool_outputs 附件续轮规则已验证：当前轮 `tool_outputs` 中的附件必须原样进入本轮；store 中重放的历史 `input` 附件必须在 Rust Responses conversation resume 真源替换为 `[Image omitted]`。唯一修复点是 `router-hotpath-napi/src/shared_responses_conversation_utils.rs` 重建 `merged_input` 前调用 stored-context media strip；HTTP 黑盒在 `/v1/responses/:id/submit_tool_outputs` 断言历史 base64 消失、本轮 base64 保留。

## 2026-05-29 Windsurf model-aware health / MCP shape
- Verified live on installed `5520`: `gpt-5.5-low` must select a model-compatible account before quota sorting; `ws-pro-3` can show quota 100 but fail the model, while `ws-pro-4` succeeds and is selected after model-aware health parsing.
- Windsurf continuity for explicit `session_id` is proven by same `cascadeId/sessionId` across turns; provider-request outbound text should contain only the new turn delta, not replay prior assistant/user text.
- Windsurf MCP compatibility metadata may arrive as `function.mcp_compat` in OpenAI tool shape; the Cascade field-10 source must read both top-level `tool.mcp_compat` and nested `function.mcp_compat`.
- Caveat: preserving `previous_response_id` into providerPayload is necessary but not sufficient for Windsurf cascade reuse; live `store:true` previous-response continuation still needs a response-id-to-provider-session alias after final `resp_*` creation. Until that alias exists, explicit `session_id` is the proven continuity path.

## 2026-05-29 Stopless / Router Direct SSOT
- 2026-05-31 修正：router-direct/provider-direct 只允许 provider passthrough + hooks，响应禁止回到 `executor-response`/llmswitch bridge 运行 response-side servertool；旧“direct response 仍必须回 response conversion”的说法是错误语义，已废弃。
- direct 与 relay 的 servertool reenter 语义边界：非 direct 链路的 followup nested request 通过 `executePortAwarePipeline` 进入 HTTP inbound；direct path 不做 response-side orchestration。

- 2026-05-29: Windsurf provider is chat-protocol at Hub boundary. Standard chat `tools` enter provider unchanged, then Windsurf provider alone splits them into native Cascade allowlist/additionalSteps and MCP field-10 payloads; response tool calls must be rejoined to standard chat tool names/args before returning to Hub Pipeline. Regression anchor: `tests/providers/core/runtime/windsurf-mcp-only.spec.ts` native `run_command` -> standard `shell_command` rejoin test.

- 2026-05-29: Full Windsurf E2E validation must include a real forced tool_call, not only request-shape smoke. Verified after fix: `RCC_WS_TOOLCALL2_075039` final `/v1/responses` output preserves requested standard `shell_command`; `RCC_WS_E2E1_075108`/`RCC_WS_E2E2_075108` prove explicit `session_id` continuity with same cascade/session and delta-only text. Rust response governance must not canonicalize requested `shell_command` back to `exec_command` when client requested `shell_command`.

## 2026-05-29 Windsurf 5520 provider-health routing fix
- Verified root cause for 5520 Windsurf `PROVIDER_NOT_AVAILABLE`: `~/.rcc/sessions/127.0.0.1_5520/provider-health.json` kept `windsurf.managed.gpt-5.5-low` under `__http_503_daily_cooldown__`, so Rust VR health filtering removed the only 5520 target before provider send.
- Fix truth: Rust VR health manager clears sibling `windsurf.managed.*` persisted 503 cooldowns on managed family success, and `apply_standard_filters` allows singleton persisted-503 targets one passive reprobe selection while preserving multi-provider fallback semantics.
- Live evidence: after build/install/restart, marker `RCC_WS_GREEN_081854` on `http://127.0.0.1:5520/v1/responses` selected `windsurf.managed.gpt-5.5-low`, chose account `ws-pro-4`, and returned HTTP 200/output `ok`.

## 2026-05-29 Compat Profile Registry Baseline
- Generic OpenAI-compatible provider configs must use `compatibilityProfile: "compat:passthrough"` unless a concrete profile JSON exists in `sharedmodule/llmswitch-core/src/conversion/compat/profiles/`; `chat:openai` and `chat:deepseek` are invalid ids and fail-fast in Hub Pipeline profile lookup.
- Regression anchor: `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/provider-normalization.test.ts` normalizes every `configsamples/provider-default/*/config.v2.json` and fails on any unregistered compatibility profile.

## 2026-05-29 OpenAI-Compatible Chat Null Field Guard
- OpenAI-compatible `/chat/completions` provider payloads must not send top-level `reasoning: null`; opencode-zen-free returned HTTP_400 on this shape. The native `strip_private_fields` path removes this top-level null while preserving real values such as `parallel_tool_calls: false`.
- Regression anchor: `tests/sharedmodule/provider-payload-openai-chat-null-fields.spec.ts`; live evidence marker `RCC_OPENCODE_400_FIX_193713` returned HTTP 200 via `opencode-zen-free.key1.deepseek-v4-flash-free`.

## 2026-05-29 OpenAI Chat Protocol Field Contract
- For DeepSeek-family OpenAI-chat outbound, `reasoning_content` is allowed but Anthropic `content: [{type:"thinking"}]` blocks are not; 2089 opencode snapshot proved 87 assistant tool-call history messages had Anthropic thinking arrays, causing OpenAI-compatible upstream HTTP_400.
- Regression anchors: Rust `protocol_field_contract` covers inbound, chat process, and outbound protocol fields; `test_protocol_field_contract_outbound_openai_chat_strips_anthropic_thinking_blocks` must fail if OpenAI-chat outbound reintroduces Anthropic thinking blocks. 2089 replay after fix: `messages=201`, `assistantTool=87`, `thinkingArray=0`, `missingReasoning=0`.
- Stopless/servertool nested followup must check client abort before starting `executeNested`; otherwise disconnected clients can still trigger reenter/reroute provider sends. Regression anchor: `provider-response-converter.unified-semantics.spec.ts` test `does not start stopless reenter followup after client disconnect`.

- 2026-05-29: opencode-zen-free DeepSeek OpenAI-chat 2095 HTTP_400 的后续根因之一在历史 `view_image` tool result：`role=tool.content` 可含 inline `data:image` 数组，旧非多模态清理只处理 user 媒体，未把 tool 历史媒体替换为 placeholder；Rust `chat_process_media_semantics` 现在在 supportsMultimodal=false outbound 中把 tool result 媒体清为 `[Image omitted]`，DeepSeek-family OpenAI-chat 同时移除 top-level `parallel_tool_calls`，保留 `reasoning_content`。红测锚点：`test_protocol_field_contract_outbound_deepseek_openai_chat_sanitizes_2095_tool_media_shape`；整组 `protocol_field_contract` 4/4 通过。

- 2026-05-29: 历史图片清理的唯一规则修正为无条件 placeholder：outbound stage3 先清历史 user media 与 `role=tool` media，再按 `supportsMultimodal=false` 清当前 user media；不要把历史图片清理绑到 provider 多模态能力，也不要做 DeepSeek 专用重复路径。红测：`test_protocol_field_contract_outbound_openai_chat_always_strips_historical_media`。

- 2026-05-29: mimo Anthropic outbound 可把历史 `view_image` tool result 折成 `role=user.content[]` 的字符串化 JSON（字段名 `content`，内含 `image_url:data:image...`），不是 `role=tool`。历史图片 placeholder 判定必须检查 content part 的 `text/content` 字符串内联媒体；红测锚点：`test_protocol_field_contract_outbound_anthropic_messages_strips_stringified_historical_media`。

### 2026-05-29 opencode DeepSeek reasoning_content 回传规则
- DeepSeek thinking/OpenAI-chat 的 assistant tool-call history 不能用 `reasoning_content: "."` 长期占位；opencode DeepSeek 会 400 `reasoning_content ... must be passed back`。Responses output 中的 `reasoning` item 必须在 store/chat process 绑定到紧随 `function_call`，让后续 OpenAI-chat assistant tool-call message 带真实 `reasoning_content`。
- 回归入口：`test_protocol_field_contract_outbound_deepseek_openai_chat_trailing_tool_has_real_reasoning_text`、`converts_reasoning_item_before_function_call_attaches_reasoning_to_call`、`convert_bridge_input_function_call_preserves_reasoning_content`。

- 2026-05-29: opencode DeepSeek `reasoning_content` 400 根因已验证：错误不是缺一个可合成字段，而是 Chat→Responses remap 在 `reasoning` item 和后续 `function_call` 中间插入 reasoning-only `message`，导致 Responses store 不能把原始 reasoning 绑定到 tool call。正确契约：只保留上游原始 `reasoning_content`（包括显式空串/旧历史已有值），缺失时不得用工具名或 `"."` 合成；tool-call-only response 的 output 顺序必须是 `reasoning` 紧邻 `function_call`。
Tags: opencode, deepseek, reasoning_content, responses-store, no-synthesis, protocol-field-contract, 2026-05-29

- 2026-05-29: opencode DeepSeek `reasoning_content must be passed back` final rule: never synthesize missing `reasoning_content` (`"."` or `I need to call ...` both wrong). If outbound OpenAI-chat history contains assistant tool_calls without original non-empty `reasoning_content`, treat that opencode server session as tainted and remove only `x-opencode-session` before send; keep `x-opencode-request` and body semantics. Header suppression must happen after final outbound body is built and before/finalizing headers, not inside the SDK send path after headers already exist. Verified by `opencode-deepseek-outbound.blackbox.spec.ts`, targeted Jest 3 suites/9 tests, `npm run build:min`, installed `0.90.2506`, and live 5555 snapshot `req_1780070375793_7144e1d3` returning 200 without `x-opencode-session`.

- 2026-05-30: Responses store `missing_request_context` for provider request ids means the response recorder likely used provider `requestId` without scope. Core `provider-response.ts` must pass `sessionId` / `conversationId` / `matchedPort` / `routingPolicyGroup` / `providerKey` from `AdapterContext` into `recordResponsesResponse`; otherwise the store cannot use `scopeIndex` to bind provider response ids back to the captured inbound Responses context. Verified by `npm run build:min`, install/restart `0.90.2508`, and retained DeepSeek outbound regression tests.

- 2026-05-30: `/v1/chat/completions` router-direct must send the selected provider model, not the inbound client model. For OpenCode Zen DeepSeek, inbound `deepseek-v4-flash` must be overwritten to provider route id `deepseek-v4-flash-free` before `processIncomingDirect`; otherwise upstream returns `Model deepseek-v4-flash is not supported`. Keep this override scoped to `openai-chat` direct sends so Responses continuation payloads stay transparent. Verified by HTTP blackbox `router-direct-chat-model.blackbox.spec.ts`, targeted Jest 3 suites/20 tests, build/install/restart `0.90.2509`, and live provider snapshot `req_1780072632342_zil5182e6` showing `model=deepseek-v4-flash-free`.

- 2026-05-30: OpenAI-chat `stream_options` 400 根因不是 DeepSeek 特例，而是通用传输层丢协议字段：`OpenAIChatProtocolClient.buildRequestBody()` 删除 `stream`，且 `resolveProviderWantsUpstreamSse()` 未读取 request/data/metadata 的 stream intent。修复点在 `src/providers/core/runtime/provider-request-shaping-utils.ts`：通用读取 stream intent，并在最终 provider HTTP body 保留 `stream:true`；不得给 DeepSeek 写硬编码。红测必须打到最终 provider body，不能只 mock provider-direct payload。live 证据：0.90.2520 `/v1/chat/completions` SSE 200，快照 `req_1780102494281_f4d8f0e3/provider-request.json` 中 `model=deepseek-v4-flash-free`、`stream=true`、`stream_options.include_usage=true`。
Tags: openai-chat, stream-options, protocol-field-preservation, provider-http-body, no-hardcode, deepseek, 2026-05-30

## 2026-05-30 chat SSE protocol guard
- Verified: OpenAI/DeepSeek-compatible chat SSE wire must be data-only frames (`data: ...`), no named `event: chat_chunk`/`event: chat.done`; named response events belong only to Responses SSE.
- Fix point: `sharedmodule/llmswitch-core/src/sse/shared/chat-serializer.ts` emits data-only chat SSE; `resp_outbound_stage1_client_remap/client-remap-protocol-switch.ts` strips cross-protocol top-level fields at client outbound.
- Tests: `tests/sharedmodule/chat-sse-usage-roundtrip.spec.ts` locks data-only chat SSE + tool_call roundtrip; `tests/sharedmodule/client-remap-protocol-fields.spec.ts` locks chat/responses top-level field separation.

## 2026-05-30 Snapshot request 目录长度护栏
- 已验证：`hub_snapshot_hooks` 曾将完整 `group_request_id/request_id` 作为 snapshot request 目录名；`_stop_followup` 递归追加会在 macOS 上触发 `File name too long (os error 63)`。
- 修复基线：只对 snapshot/debug path token 做 bounded prefix + sha256 短 hash；`__runtime.json` 继续保留原始 `requestId`，真实传输 payload 不裁剪、不改写。

## 2026-05-30 retry priority order
- 已验证：retry/reroute 不应实现 “healthiest first / recoverToBestOnRetry”。`excludedProviderKeys` 只用于标准过滤，过滤后必须继续按配置 pool strategy/order 选路；`sdfv -> cc -> mimo` 排除 `sdfv` 后应命中 `cc`。
- 红测：`tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts` 覆盖 TS retry plan 不得清理既有 excluded provider；Rust 单测 `priority_pool_retry_exclusion_preserves_next_configured_target` 覆盖 VR priority 排除后取下一个配置目标。

- 2026-05-30: Windsurf Cascade 多轮调用对齐 Windsurf.app 行为定义与实测结论（术语真源）
  **多轮调用对齐（Cascade Continuation）**：RouteCodex 对齐 Windsurf.app 的行为：用户在同一 session 中发送多条消息时，复用同一个 `cascadeId`，在同一个 Cascade 会话中续杯，不每轮 `StartCascade` 重建。这是主目标。
  **Reentry（实现细节）**：对同一个 `cascadeId` 再次调用 `SendUserCascadeMessage`，向同一个 Cascade 会话追加消息。这是多轮调用对齐的底层实现动作，不是目标本身。
  **非续杯的替代路径**：每次用户消息都走 `StartCascade` 新建一个 cascade，不复用旧 cascadeId。这等价于 Windsurf.app 的"新建会话"。
  **实测数据**（真实 LS gRPC，ws-pro-1，gpt-5-4-medium）：
  1. `send1` → OK，poll 即见 `GetCascadeTrajectory.status=2`（IDLE），steps=2
  2. 此时立即 `SendUserCascadeMessage`（reentry）→ 返回 `CASCADE_RUN_STATUS_RUNNING`（executor busy）
  3. 继续 poll `GetCascadeTrajectory`：status 从 2→1 持续约 40 秒，表明 executor 在 trajectory IDLE 后仍在后台工作
  4. ~40 秒后 reentry 成功（`send2-reentry=ok`）
  **结论**：
  - Q1（单账号能否 reentry）：可以，但 executor settle 代价 ~40s
  - Q2（对 RUNNING cascade 发 Send 返回什么）：`CASCADE_RUN_STATUS_RUNNING`
  - Q3（同 session 续杯 vs 不同 session 重建）：新 cascade（`StartCascade`）瞬时完成，reentry 要等 ~40s executor settle
  - `GetCascadeTrajectory.status` 字段 ≠ executor idle 状态：status=2（IDLE）后 executor 仍在工作
  **架构影响**：当前 provider 的 sticky cascade（复用 cascadeId across rounds）会引入 ~40s 延迟。需评估是否改为每次都 `StartCascade` 新建。
  Tags: windsurf, cascade, reentry, executor-settle, trajectory-status, start-cascade, 40s-delay, 2026-05-30

- 2026-05-30: Windsurf Cascade reentry 测试方法真源
  **测试脚本**：`scripts/windsurf-provider-private-probe.ts`
  **测试方法**：直接调用 provider 私有方法（`provider['sendStartCascade']`、`provider['sendCascadeMessage']`、`provider['grpcUnaryLocal']`、`provider['buildGetTrajectoryStepsRequest']`、`provider['buildGetTrajectoryRequest']`、`provider['parseTrajectorySteps']`、`provider['parseTrajectoryStatus']`）绕过 provider 公共 API，直接验证 LS gRPC 行为。
  **关键 gRPC 调用链**：
  - `StartCascade` → field 1 metadata（含 apiKey/platform/version/sessionId）+ field 4=1
  - `SendUserCascadeMessage` → field 1 cascade_id + field 2 items(text) + field 3 metadata + field 5 cascade_config
  - `GetCascadeTrajectorySteps` → field 1 cascade_id + field 2 stepOffset
  - `GetCascadeTrajectory` → field 1 cascade_id，返回 field 2 status（0=unknown, 1=RUNNING, 2=IDLE）
  Tags: windsurf, cascade, grpc, test-harness, provider-private-methods, 2026-05-30

## 2026-05-30 minimonth / provider outbound sanitizer 真相
- `minimonth` 日志里的 `provider.traffic.acquire ... wait` 不是失败；本次失败真源是 route 到 `sdfv/cc` 后 bridge 调 `sanitizeProviderOutboundPayloadWithNative`，但 llmswitch-core native/wrapper 符号缺失。
- provider outbound sanitizer 必须同时具备：Rust NAPI `sanitizeProviderOutboundPayloadJson`、core TS wrapper `sanitizeProviderOutboundPayloadWithNative`、RouteCodex bridge `sanitizeProviderOutboundPayload`、`native-router-hotpath-required-exports.ts` required export。缺任一处会 fail-fast，不允许 fallback。

## 2026-05-30 VR excludedProviderKeys 空池规则
- 已验证：`excludedProviderKeys` 是 retry/避让信号，不是硬性删除路由池的真源；若 exclusion 覆盖当前 route pool 全部可用目标，Rust Virtual Router 必须保持 routing-state 后的候选池非空并继续按 priority/weighted 选择，禁止抛 `PROVIDER_NOT_AVAILABLE`。
- 回归锚点：HTTP 黑盒 `tests/server/handlers/responses-handler.routing-empty-pool.spec.ts` 必须先红后绿；Rust 锚点 `routing_exclusions_do_not_empty_pool_when_all_targets_excluded`。

## 2026-05-30 VR recoverable busy 统一错误路径
- 已验证：Virtual Router 全池 recoverable busy/cooldown 不是无 provider；必须分类为 `HTTP_429` recoverable，RequestExecutor 用现有 recoverable backoff 阻塞指数退避重试 3 次，仍 busy 才向客户端返回 429。禁止把该状态映射成 `PROVIDER_NOT_AVAILABLE` 或新增 fallback 分支。

## 2026-05-30 — MiniMax 2056 provider business error display
- Verified fix: Hub response canonicalization must parse `base_resp.status_code` business errors both when shape is unknown and when chat-like payload fails canonical validation (for example `choices: []`). MiniMax 2056 should surface as `HTTP_429_2056` with `upstreamCode=provider_status_2056` and `statusCode=429`, not generic `MALFORMED_RESPONSE`.
- Verified retry rule: `resolveAutoRetryErrorCode()` must map both `PROVIDER_STATUS_2056` and `HTTP_429_2056` to `0.8200` before catalog normalization, otherwise provider internal auto-retry misses MiniMax 2056.
- Verified display rule: request-executor provider failure report must read `ProviderProtocolError.details.upstreamCode` so `host.contract_failure.classified` can show `upstreamCode=PROVIDER_STATUS_2056`.

## 2026-05-30 SSE Responses 断流根因与修复
- **根因 1（包协议）**：`response.done` 事件发 `data: [DONE]`（Chat API 格式），Responses SDK 不认 → client 收不到 terminal event → 报 `upstream_stream_incomplete`。修复：改为发完整 `{ response: {...} }` 对象。
- **根因 2（decoder 过早 break）**：`responses-sse-to-json-converter` 在 `response.completed` 时 break，丢掉 `response.done`。OpenAI Responses API 中 `completed` ≠ terminal，`done` 才是真 terminal event。修复：decoder 只在 `response.done`/`response.error`/`response.cancelled` 时 break。
- **根因 3（abort 信号丢失）**：`trackClientConnectionState` 用 Symbol-keyed 存 AbortSignal，Rust bridge JSON 序列化丢失 → decoder 无法感知 client disconnect。修复：轮询 `clientConnectionState.disconnected` 布尔值（200ms interval）。
- **铁律**：Responses API 的 terminal event 是 `response.done`，不是 `response.completed`。`completed` 只表示回复构建完成，client SDK 仍需 `done` 判定 stream 结束。


## 2026-05-30 Windsurf cascade busy polling fix (verified)

- **真源**: cascade-continuation-block.ts executeWindsurfCascadeBusyRetry
- **修复**: 新增 pollIdle 回调轮询 GetCascadeTrajectory，totalWaitMs=120000
- **行为**: busy -> poll trajectory every 1s -> status===1 (IDLE) -> retry send
- **超时**: 2min 后才返回 429 WINDSURF_CASCADE_BUSY
- **日志**: cascade.busy.wait_idle / cascade.busy.final_timeout
- **回归测试**: 28/28 passed (5 new RED tests for polling behavior)
- **构建**: v0.90.2569, build:min passed, install:global passed
- **待验证**: 真实 Windsurf session 续杯 trajectory 保持（需 Jason 实测确认）

## 2026-05-31 Hub Pipeline Rust 化执行规则
- Rust 化按阶段推进：每一阶段完成验证后必须本地 `git commit`，但不 push；最终全量验证通过后再 push。
- 黑盒红测是关键门禁：每阶段先补/运行能证明边界的黑盒或 residue red test，再实现/收口，禁止只靠白盒改动声称完成。

## 2026-05-31 Hub Pipeline response native fail-fast rule
- 已验证：provider-response callbacks 存在时也不得回 TS path；Rust response path 必须先观测/校验 provider response shape，OpenAI chat response 至少需要 object + 非空 `choices` array，否则返回 `success:false + error` 并由 TS native shell fail-fast。
- 已删除规则：Rust resp inbound format parse 禁止 unknown protocol generic envelope fallback；未知 response protocol 必须 unsupported fail-fast，避免 raw payload 被误当完成响应透传。

## 2026-05-31 provider-response TS residue deletion
- 已验证：`sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 的最终角色是 native call shell + runtime effect glue；不得重新引入 TS resp inbound semantic map、resp_process governance/finalize/servertool orchestration、resp outbound remap 或 response mapper registry。
- 回归锚点：`tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 禁止 `runRespInboundStage2FormatParse`、`runRespInboundStage3SemanticMap`、`runRespProcessStage1ToolGovernance`、`runRespProcessStage2Finalize`、`runRespProcessStage3ServerToolOrchestration`、`runRespOutboundStage1ClientRemap` 等 provider-response residue。

## 2026-05-31 provider-response helper residue rule
- 已验证：`provider-response-helpers.ts` 只允许保留 native context signal 解析与 clock reservation side effect glue；禁止重新引入 `response-mappers`、`ProviderResponsePlan`、TS response canonicalization、TS provider business-error parsing。

## 2026-05-31 runtime response-mappers dependency rule
- 已验证：runtime `sharedmodule/llmswitch-core/src/**/*.ts` 除待删除的 `conversion/hub/response/response-mappers.ts` 自身外，不得再 import `response-mappers`; 运行时类型应使用 `JsonObject` 或局部 shell interface，语义真源在 Rust。

## 2026-05-31 HTTP blackbox redtest + client abort guard
- Verified: response-marker/SSE transport bugs must use real `RouteCodexHttpServer` listener + real HubPipeline/provider runtime; tests may fake only upstream HTTP responses and client socket behavior, not handler/executor/converter behavior.
- Verified: client abort must short-circuit provider failure handling before retry/reroute/followup; redtest must destroy the HTTP client socket and assert backup provider receives zero real POSTs.

## 2026-05-31 provider response conversion failover boundary
- Verified: provider transport/send failures may enter retry/reroute; provider response processing failures after `provider.send.completed` must fail fast and must not enter `processProviderSendFailure`, otherwise Rust canonicalization errors such as Anthropic `content array` or OpenAI `choices array` get hidden by provider-switch loops.
- Required redtest: real HTTP `/v1/responses` -> real HubPipeline/provider runtime -> local upstream HTTP 200 malformed provider response -> assert backup provider receives zero POSTs.

## 2026-05-31 router-direct / provider-direct 架构真相修正
- 已修正旧事实：router-direct/provider-direct 的标准职责是 **provider passthrough + hooks only**；direct path 不进入 HubPipeline response conversion，不跑 chat-process/servertool response orchestration，不包 `executor-response`/换壳。
- HubPipeline request/response 是三段式严格协议链路；每段只有唯一协议真源。SSE 也必须按当前 provider 配置协议在对应唯一链路处理，禁止在 direct path 里二次 materialize、remap、canonicalize 或补兼容。
- 禁止错误方式：为 direct response 增加 `executor-response` 专用壳、把 direct SSE 读成 bodyText 再送 Hub response conversion、用 `outboundProfile`/请求入口猜 provider 物理协议、添加 fallback/patch/shape 修补来掩盖配置或协议错误、用 `routecodexSameProtocolDirectDisabled`/`recoverable_direct_5xx_reenter_executor` 重入 executor/reroute。
- 回归测试要求：必须有真实 HTTP 黑盒覆盖 direct passthrough（真实 RouteCodexHttpServer + 真实 provider runtime；只允许 mock upstream 请求/响应），断言 upstream SSE/JSON 原样返回且不出现 `hub_pipeline_resp_client_remap_failed` / `missing choices`。

## 2026-05-31 Mimo/Anthropic SSE response inbound 真相
- mimo 是 Anthropic provider protocol；`/v1/responses` 命中 mimo 后，provider SSE 必须在 llmswitch-core response inbound 唯一边界 materialize 为 `{mode:"sse", bodyText}`，再由 Rust Anthropic response semantics 转 OpenAI Chat/Responses。Host `RequestExecutor` 不得提前二次 materialize/remap。
- 已验证：真实 5555 smoke 不再出现 `hub_pipeline_resp_anthropic_chat_canonicalize_failed` / `missing choices`；当前剩余 live failure 为上游 `HTTP_503`。

## 2026-05-31 stopless 唯一激发真相
- 已验证：stopless 默认不是 `:stop_followup` reenter；Rust Hub Pipeline 只产出 `requireRuntimeExecutor`，`stop_message_flow` 策略唯一执行 `clientInjectOnly`，由客户端/tmux 注入 `继续执行`。
- 禁止旧方式：`stop_message_flow` 不得 `requireReenterPipeline`、不得 `seedLoopPayload/retryEmptyFollowupOnce`、不得在 response-stage/followup hop 上形成二次 stopless 激发；黑盒锚点是真实 HTTP `/v1/responses` + fake upstream SSE + tmux pane 断言 provider 只打一次且 tmux 收到注入文本。

## 2026-05-31 Responses continuation materialize / store retention
- 已验证根因：route-aware Responses continuation materialize 将非纯 delta 的完整 incoming history 拼到 store prefix，会重放已完成 `call_id`，表现为 `orphan_tool_result ... already-consumed call_id: call_1`，并使 mem-observer `pendingNoResponseId/retainedInputItems` 增长。
- 修复基线：`shared_responses_conversation_utils.rs::materialize_responses_continuation_payload` 只允许纯 delta materialize；incoming 若重放 prefix 中已完成 tool call id，必须返回 Null 走原 payload；router-direct `hub_pipeline_failed` 后必须清理 responses conversation request store。

## 2026-05-31 Responses store startup cleanup
- Verified root for retained pending Responses entries: startup cleanup can hit a global responsesConversationStore instance whose module export lacks `clearUnresolvedResponsesConversationRequests`; `src/modules/llmswitch/bridge/runtime-integrations.ts` must clear unresolved entries against the same global store object (`requestMap` + `detachEntry`) before falling back to module export.
- Regression gate: `tests/server/http-server/router-direct-passthrough.blackbox.spec.ts` has HTTP `/v1/responses` blackbox for repeated sequential `call_1` history and asserts no `clearUnresolvedResponsesConversationRequests not available` startup warning.


## HubPipeline Rust 总控 API Closeout（2026-05-31）

### 审计结论
- 缺口不是缺 Rust 函数，是缺 Rust 总控 API：多个 native helpers 已存在，但调用顺序/错误边界/metadata merge/EffectPlan 仍由 TS 决定。
- `hub_pipeline.rs` 已收口到 282 行薄壳；`lib.rs` 已声明完整模块树。
- `rustification-audit-current.json`：非 native LOC 58012→56942，降 1070 行。

### 剩余 P0/P1 Closeout（2026-05-31 closeout plan）
| Slice | 模块 | 当前残留 TS |
|---|---|---|
| Slice 0 | 总控 API 基座 | `hub_pipeline_lib.rs` 缺失；TS `hub-pipeline.ts` 无总控入口 |
| Slice 1 | resp_process.stage3 servertool | `runServerToolOrchestration` / `runServerSideToolEngine` 在 TS |
| Slice 2 | req_process.stage1 governance | `maybeInjectNativeTool` 等判断在 TS |
| Slice 3 | resp_process.stage2 finalize | `buildProcessedRequestFromChatResponse` 在 TS |
| Slice 4 | hub-pipeline normalize-request | `entryEndpoint` / `providerProtocol` / `routeHint` 决策在 TS |
| Slice 5 | operation-table/mappers/adapters | 协议语义映射在 TS |

### 计划文档
- `docs/goals/hubpipeline-rust-closeout-master-plan.md`（详细 plan）
- `docs/goals/hubpipeline-rust-closeout-goal-prompt.md`（/goal 提示词）
- `docs/audit/hub-pipeline-rust-lib-analysis-2026-05-31.md`（审计分析）

### 执行顺序
Slice 0（总控 API）→ Slice 1-4（P0）→ Slice 5（P1）

### 验证
架构红测 + 黑盒红测 + Rust unit + Jest + build + restart smoke。

## 2026-05-31 stopless / stop_message followup truth
- stop_message_flow must use servertool reenter, never tmux/client injection. Rust skeleton profile for stop_message_flow must not set clientInjectOnly/clientInjectSource, and native handler output must not emit clientInjectOnly/clientInjectText/clientInjectSource metadata.
- stopless skip gate belongs in Rust stop-message-core decision. Plan mode and /goal active skip; serverToolFollowup hops skip to prevent recursion; ordinary finish_reason=stop with valid scoped state triggers reenter.

## 2026-05-31 HubPipeline Rust closeout Slice 0
- Slice 0 total-control API baseline: Rust exports `runHubPipelineLibJson` and `runHubPipelineStageJson`; TS wrapper exports `runHubPipelineLibWithNative` / `runHubPipelineStageWithNative` with `failNativeRequired` and no fallback. Verified with `tests/sharedmodule/hub-pipeline-rust-lib-api-contract.spec.ts`, `cargo test -p router-hotpath-napi hub_pipeline -- --nocapture`, and `node scripts/build-core.mjs`.
- Server lifecycle validation rule: do not use separate start/stop; if runtime validation needs server lifecycle, use `routecodex restart --port <port>` only.

## 2026-05-31 HubPipeline Rust closeout residue rule
- Verified: request-stage/chat-process mainline must use Rust total API via `runHubPipelineLibWithNative`; legacy TS route/outbound/inbound orchestrators (`hub-pipeline-route-and-outbound.ts`, `hub-pipeline-execute-request-stage-provider-payload.ts`, `hub-pipeline-execute-request-stage-inbound*.ts`, `hub-pipeline-stage-hooks.ts`, `hub-pipeline-shared-guards.ts`) are deleted truth, not dormant code.
- Regression gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` must fail if those files or request-stage mapper hook imports return.

## 2026-05-31 Rustification audit baseline rule
- Verified: after HubPipeline TS deletion work, refresh `sharedmodule/llmswitch-core/config/rustification-audit-baseline.json` only when current total non-native LOC is lower and no new prod TS files remain. Thin wrapper files like `native-hub-pipeline-lib.ts` are not allowed as new prod TS; import existing protocol wrappers directly.
2026-05-31 verified: MiniMax /v1/responses tools failure root cause was Rust req outbound format build responses-context -> openai-chat path only copied model/input, dropping tools/tool_choice/stream controls. Fixed in hub_req_outbound_format_build.rs, red in hub_pipeline_lib test, live sample rcc-redtools-mini27-1780235661 shows mini27 provider-request toolsLen=1/tool_choice=auto and no “OpenAI chat SSE response did not contain JSON data events”.

## 2026-05-31 empty SSE marker-only and Responses record ordering
- Provider response conversion 中，OpenAI chat SSE marker-only（无 materialized stream/bodyText）属于 provider SSE decode failure，必须归一为 `SSE_DECODE_ERROR`、`status=502`、`retryable=true`、`requestExecutorProviderErrorStage=provider.sse_decode`，并允许 response-processing phase 进入 provider retry plan；不能作为 HubPipeline fatal conversion 直接终止。
- Responses conversation 记录顺序：native response runtime effect 不得抢先 `recordResponsesResponse`；handler 在 request context capture 完成后统一 capture+record，避免 `missing_request_context` 与 retained input 泄漏。

## 2026-05-31 HubPipeline Slice5 public barrel cleanup
- Slice5 不只看 active registry；public barrel 也不能导出 legacy TS mapper/adapter implementations。`conversion/index.ts` 只允许保留 mapper/adapter type exports；`hub/format-adapters/index.ts` 只保留 `FormatAdapter` / `SemanticMapper` / `StageRecorder` interfaces，禁止导出 concrete `*FormatAdapter` classes。
- Architecture gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 的 `public conversion barrels must not export legacy mapper or adapter implementations`。

## 2026-05-31 HubPipeline Slice5 concrete format-adapter deletion
- Concrete TS `Chat/Anthropic/Responses/GeminiFormatAdapter` files are physically removed from `sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/`; only type interfaces remain in `index.ts` for thin glue. Residue gate: `legacy concrete TS format adapter implementations must be physically removed` in `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`.

## 2026-05-31 Responses SSE terminal repair id invariant
- Verified root for Codex reconnect error `failed to parse ResponseCompleted: missing field id`: `handler-response-utils.buildResponsesTerminalSseFramesFromProbe` synthesized `response.completed` / `response.done` from partial SSE probe without `response.id`.
- Fix invariant: any synthesized Responses terminal frame must include `response.id`; if upstream never provided one, derive deterministic `resp_<requestLabel-sanitized>`. Do not synthesize completed/done from merely `in_progress` probe without completed output or required_action.
- Regression: `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts` blackbox uses real Express `/v1/responses` handler + upstream SSE that emits `response.output_item.done` then closes, asserting synthesized `response.completed` and `response.done` both include string id.

## 2026-05-31 HubPipeline request stage shell removal
- Verified closeout residue: `req_outbound_stage2_format_build`, `req_outbound_stage3_compat`, and `req_process_stage2_route_select` TS stage shells had no production/test import while Rust HubPipeline engine covers `build_format_request`, `run_req_outbound_stage3_compat`, and `apply_route_selection`.
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` requires these legacy request stage shells to be physically absent.

## 2026-05-31 HubPipeline response stage shell removal
- Verified closeout: old TS stage shell directories under `req_inbound/req_inbound_stage1_format_parse`, `resp_inbound/*`, `resp_outbound/*`, and `resp_process/*` are physically removed. Provider response mainline is Rust total API; explicit stage3 reentry regression now targets `servertool/response-stage-orchestration-shell` directly.
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` requires these directories absent and provider response mainline not importing/calling old `runResp*Stage*` wrappers.

## 2026-05-31 HubPipeline normalize-request block removal
- Verified closeout: legacy TS normalize-request block files are physically removed. Active normalize request shell only performs Node/SSE materialization and calls Rust `runHubPipelineStageWithNative({ stage: 'normalizeRequest' })` for semantics.
- Gate: `hub-pipeline-stage-residue-audit` requires `hub-pipeline-normalize-request-*blocks.ts`, `hub-pipeline-request-normalization-utils.ts`, and `hub-pipeline-governance-blocks.ts` absent.

## 2026-06-01 VR routing split validation
- VR routing split cleanup must wire extracted helpers through `routing/mod.rs` and remove same helper bodies from `bootstrap.rs`; otherwise `utils.rs` is dead code despite existing in tree.
- Current validated gate for VR routing split: `cargo test -p router-hotpath-napi virtual_router_engine::routing --lib` (37 passed) plus `node scripts/build-core.mjs && npx tsc --noEmit` (exit 0). Full `router-hotpath-napi --lib` has unrelated non-VR failures and is not a clean project gate yet.

## 2026-06-01 VR/Hub no-fallback correction
- In VR/Hub rustification, do not add fallback/兜底 semantics or fallback naming. Tool declaration must not be treated as route activity; only real current-turn tool execution/continuation signals may drive `tools`/`coding`/`search` routing.

## 2026-06-01 multi-port isolation truth
- Multi-port v2 config must not implicitly merge `virtualrouter.routingPolicyGroups`; callers must select one `routingPolicyGroup` unless explicitly running audit-only `includeAllRoutingPolicyGroups`.
- Port-scoped runtime state boundary is `__rt.sessionDir = sessions/<serverId>/ports/<routingPolicyGroup>`; provider health/error events must carry this through request metadata to avoid cross-port health spread.

## 2026-06-01 tt and MiniMax provider truth
- `tt` must stay aligned to `~/.codex/config.toml`: `base_url=https://api2.codewhisper.cc/v1`, `wire_api=responses`; never "fix" it by changing to OpenAI chat.
- Standard MiniMax RCC provider for 5520 uses Anthropic compatibility: `type="anthropic"`, `baseURL="https://api.minimaxi.com/anthropic"`; verified `/v1/messages` with `MiniMax-M3` returns 200.

## 2026-06-01 ProviderForwarder 实现完成

### 实施内容
- **Rust 真源** (forwarder.rs, 27KB):
  - `ForwarderEntry` / `ForwarderTarget` / `ForwarderRegistry` / `StickyKey` / `ResolutionMode` / `ForwarderStrategy`
  - `bootstrap` 在 `VirtualRouterEngineCore::initialize` 中调用
  - `select()` 在 `engine/selection.rs::select_provider` 末尾 hook（替换 selected → real provider_key）
  - sticky map 在 Rust 内部持有: `HashMap<(session_id, forwarder_id), real_provider_key>`
  - 闭包借用冲突解决：预 clone targets → drop borrow → `is_provider_available` → 再调 `forwarder_registry.select`
- **TS Profile** (forwarder-types.ts + provider-profile-loader.ts + adapter.ts):
  - `ProviderForwarderProfile` / `ProviderForwarderTarget` / `ProviderForwarderStrategy`
  - `validateForwarderId` 仅做前缀校验，禁止 split(".") 推算 model
  - `buildForwarderProfiles(config, knownProviderIds)` 解析 forwarders 节点，校验：fwd 前缀、显式 model/protocol、target 引用、duplicate (protocol,model)、拒绝 transportOverride
- **Host** (forwarder-sticky-hint.ts):
  - 仅 `extractForwarderStickyHint(runtime)` 从 metadata/extensions 抽 sessionId，不持状态
- **配置** (configsamples/forwarder-example.json): 4 个 openai provider + 1 个 weighted fwd

### 验证结果
- cargo test forwarder:: 15/15 绿
- cargo test virtual_router_engine::routing 50/50 绿（基线 37 维持）
- jest tests/providers/forwarder-selection 10/10 绿
- jest tests/red-tests/no_provider_specific_in_hub_pipeline 2/2 绿
- tsc --noEmit: 0 forwarder 错（仅 2 个 pre-existing native-router-hotpath 错误）
- jest tests/providers/profile/provider-profile-loader.entries 8/8 绿（loader 改动不破坏现有）

### 关键决策点（可复用规则）
1. **forwarder id opaque**: 配置 schema 显式 model/protocol；loader 仅做 `fwd.` 前缀 namespace 校验；禁止 `split(".")` 推算语义（model 可能含点号）
2. **availability 闭包借用冲突**: Rust 借用规则下，预 clone targets 到本地、计算可用集、再调 `forwarder_registry.select`；闭包内部不能再用 `self`
3. **sticky 闭包不能直接调 mutating 方法**: 同上，需要预计算 available_real_keys: HashSet，再传给 select 闭包
4. **build_target 维持原样**: 解析完全在 selection 阶段；forwarder 解析后 `SelectionResult.provider_key` 是 real key，`build_target(real_key)` 走原路径
5. **priority → weight 转换**: `RouteLoadBalancer` 不支持 priority strategy；priority 模式转 weight = `max_priority - p + 1`
6. **测试目录约定**: 通用 provider 测试在 `tests/providers/`，红测试门禁在 `tests/red-tests/`（新目录）
- 2026-06-01: ProviderForwarder §3.6 字面契约补全：`routing/selection.rs` 新增 `select_with_forwarder_resolution(candidates, &mut ForwarderRegistry, &mut RouteLoadBalancer, availability_check, session_id) -> (Vec<String>, Vec<String>)`，签名接收 &mut forwarder_registry（因 `select` 内部 sticky map 需要 &mut self）。2 个新单元测试覆盖：fwd 展开为 real、全 disabled → errors 含 `ERR_FORWARDER_NO_AVAILABLE_TARGET`。Wrapper 是 §3.6 公开 API；实际 hot-path hook 仍在 `engine/selection::select_provider` 末尾。

Tags: provider-forwarder, routing-selection, select_with_forwarder_resolution, sticky-mut, availability, fail-fast, §3.6-contract

## 2026-06-01 Responses tool history / MCP namespace 真源
- Responses→OpenAI-chat/Anthropic 的工具历史规范化必须由 Rust Hub Pipeline 的 context capture / chat process 生成 `chatMessages` 与 `toolsNormalized`，不得在 provider codec 或 TS handler raw metadata 中补丁式过滤。
- `responses-handler.ts` 不得把 raw `responsesRequestContext` 注入 pipeline input metadata 覆盖 Rust result；响应后只能保留 Rust metadata 优先，raw context 只可作为缺失时兜底。

- 2026-06-01: metadata 生命周期审计结论已确认：metadata 只应停留在入口到 provider 发出前的内部流水线 carrier；当前高风险泄露点在 Anthropic/OpenAI SDK transport 与 Rust outbound format build 的 `metadata.context` 回填路径，后续修复必须收紧为 provider body 不携带 metadata。

- 2026-06-01: metadata 最终目标补充：它必须是无状态短生命周期 carrier，只在单个 request/response 闭环内存在；闭环结束释放；端口、session、requestId 互相隔离，不得污染 provider body、SDK options、client response 或持久 runtime state。

- 2026-06-01: metadata 隔离实现已分批本地提交（未 push）：`971d7c3e5`、`710acff93`、`62f11f32f`、`2e693ad81`。核心规则：provider/request/response body 不读写内部 metadata；direct/route/entryEndpoint/control flags 必须走 runtime/context carrier；违规 body.metadata 在 provider outbound 边界 fail-fast。

- 2026-06-01: metadata 隔离补充收口：mock provider 也不得读 body metadata；shadow compare 不得忽略 `providerPayload.metadata.*` drift；新增静态红线 `tests/red-tests/no_provider_body_metadata_control.test.ts` 防止 provider runtime/SDK/Rust outbound 再从 body/rawBody/payload.metadata.context 消费控制语义。

## 2026-06-01 Metadata 入口隔离已验证

- Metadata 是 request/response 闭环内的 internal carrier；HTTP handler 可从当前请求读取 metadata，但传给 Hub Pipeline 的 body 必须剥离 top-level `metadata`，控制语义只能进 `input.metadata` carrier。
- 已验证入口：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/images/generations`；测试命令：`npm run jest:run -- --runTestsByPath tests/red-tests/no_provider_body_metadata_control.test.ts tests/server/handlers/handler-utils.metadata.spec.ts tests/server/handlers/handler-metadata-boundary.spec.ts --runInBand --forceExit`，结果 3 suites / 7 tests passed；扩展 metadata 回归 12 suites / 67 tests passed。

## 2026-06-01 Metadata 响应与 replay 隔离已验证

- Responses JSON->SSE、SSE->JSON、direct passthrough raw replay、provider-request snapshot、Responses persisted request context 均已验证不把 internal/provider metadata 投射到 client response body、provider wire body 或持久 payload；snapshot root metadata 只作观测数据。
- 已验证：metadata Jest 回归 15 suites / 76 tests passed；Rust `cargo test -p router-hotpath-napi hub_req_outbound_format_build --lib` 13 tests passed。

## 2026-06-01 Responses previous_response_id continuation persistence
- Verified: pending Responses tool calls must persist by response id until consumed; process restart/reset must reload the continuation before accepting /v1/responses previous_response_id + function_call_output. Missing response id must fail before provider, not forward orphan tool results.
- Packaging baseline: routecodex global package must include sharedmodule/llmswitch-core/dist and package.json because runtime importCoreDist loads core modules from installed package.

## 2026-06-01 Pipeline topology naming rule
- Local topology truth: `docs/design/pipeline-type-topology-and-module-boundaries.md`. Request chain, response chain, error chain, metadata carrier, module naming, and mid-node insertion rules must be updated before changing critical pipeline data structures.
- Mid-node insertion is architecturally discouraged; prefer current-node internal block, `Meta*`, `Error*`, or `Snapshot*` side-car. If unavoidable, never renumber existing nodes and never use `03b` / `03_1` / `03.5`; open a new chain version or append a new phase with red tests and deletion plan.

## 2026-06-02 Hub Pipeline phase naming rule
- Hub Pipeline topology names use `<Module><Phase><NN><Node>`; canonical phases are `ReqInbound` / `ReqChatProcess` / `ReqOutbound` / `RespInbound` / `RespChatProcess` / `RespOutbound`.
- Data-structure migration starts with docs/red tests, then Hub request three-phase skeleton, Hub response three-phase skeleton, VR/provider interface closure, Error/Metadata carriers, and finally physical deletion of old DTO/shell names.

## 2026-06-02 Hub Pipeline Phase 1 type skeleton
- Verified request-side topology skeleton exists in Rust `hub_pipeline_types/`: `HubReqInbound02Standardized -> HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`. It is transparent and not wired into runtime flow, preserving existing stage order/provider wire behavior.
- Red-test truth: `tests/red-tests/hub_pipeline_type_topology_contract.test.ts` locks phase naming, adjacent builders, no new `ReqProc`/`req_process` type skeleton names, no provider wire shortcut, and metadata via `Meta*` carrier only.

## 2026-06-02 Hub Pipeline Phase 2 response type skeleton
- Verified response-side topology skeleton exists in Rust `hub_pipeline_types/`: `HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`. It is transparent and not wired into runtime flow, preserving existing native stage order and client response behavior.
- Red-test truth: `tests/red-tests/hub_pipeline_response_type_topology_contract.test.ts` locks response phase naming, adjacent parser/projector, no new `RespProc`/`resp_process` type skeleton names, no provider raw -> server client frame shortcut, and metadata/error via `Meta*`/`Error*` boundaries only.

## 2026-06-02 Hub Pipeline Phase 3/4/5 topology contracts
- Verified transparent contract wrappers exist for `VrRoute04SelectedTarget`, `ProviderReqOutbound06WirePayload`, `MetaReq02RuntimeCarrier`, and `ErrorErr03RuntimeClassified` in Rust `hub_pipeline_types/`; they are not wired into runtime flow and preserve route selection/provider wire/client response behavior.
- Red-test truth: `hub_pipeline_vr_provider_boundary_contract`, `hub_pipeline_meta_error_carrier_contract`, and `hub_pipeline_type_residue_contract` lock VR no-payload-patch, provider no-Hub-tool-governance/no-metadata-wire, Meta/Error carrier isolation, and no unsafe deletion pretending.
- Phase5 deletion result: no safe live-path deletion yet; current `req_process_*` / `resp_process_*` Rust stage files remain live until a later migration proves typed `ReqChatProcess` / `RespChatProcess` entrypoints own the path.

## 2026-06-02 Hub Pipeline Phase 6A-1 request typed wrappers
- Verified request typed wrappers exist in `hub_pipeline_types/request_typed_entrypoints.rs` and only delegate to existing transparent type builders. They are deliberately not wired into `hub_pipeline.rs`, `hub_pipeline_lib/engine.rs`, or NAPI `lib.rs`, so live request flow/provider wire behavior is unchanged.
- Red-test truth: `tests/red-tests/hub_pipeline_request_typed_entrypoint_contract.test.ts` locks wrapper names, forbids runtime-stage logic inside wrappers, and forbids live runtime path wiring in Phase 6A-1.

## 2026-06-02 MiniMax Anthropic tool_use -> Responses 结构化投影
- 证据：`--snap` raw provider response 落盘在 `~/.rcc/codex-samples/openai-responses/minimax.key1.MiniMax-M3/req_1780361351618_3e08ea1c/provider-response.json`，原始 `content` 包含 `tool_use`，不是文本工具调用。
- 修复真源：`hub_resp_outbound_client_semantics_blocks/responses_payload.rs` 在 OpenAI Responses client remap 中直接支持 Anthropic `type=message/content[].tool_use`，转为 Responses `output[].function_call` + `required_action.submit_tool_outputs.tool_calls`；禁止通过文本收割修这类结构化工具调用。
- 红测：`build_responses_payload_from_anthropic_tool_use_preserves_structured_calls` 锁住 `output_text` 不含 `minimax:tool_call`，并断言 raw `tool_use` 保持为结构化 function_call。

## 2026-06-02 Responses required_action SSE 不得伪 completed
- 证据：MiniMax raw `content[].tool_use` 与 native Anthropic->Responses 投影均保持结构化；UI 仍有 `minimax` 碎片时，问题在 server SSE terminal repair。
- 修复：`buildResponsesTerminalSseFramesFromProbe` 对 `required_action` 只发 `response.required_action`、`response.done`、`[DONE]`，不得再追加 `response.completed`，避免客户端把 tool-call 等待态误当完成态。
- 红测：`tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` 断言 split required_action 不含 `event: response.completed`。

## 2026-06-02 config.toml multi-port isolation
- Verified fix: config.toml ports 5520/10000/5555 run under global `routecodex 0.90.2695` with per-port `serverId`, session dir, logs, snapshots, stats `entryPort`, and non-primary admin mutate guard. 10000 returns real HTTP JSON through RouteCodex (`/health` 200, `/admin/ports` 404 JSON, chat 200 JSON) when using LAN IP because `127.0.0.1:10000` is occupied by `netdisk_s` and is not RouteCodex.
  Tags: routecodex, multi-port, isolation, live-smoke, config-toml
- Reusable rule: when debugging port 10000 Empty reply, first run `lsof -nP -iTCP:10000 -sTCP:LISTEN`; if another process owns `127.0.0.1:10000`, smoke RouteCodex via its wildcard/LAN listener before concluding server failure. Empty reply on loopback can be external port shadowing, not HTTP handler failure.
  Tags: routecodex, port-10000, smoke-test, troubleshooting

## 2026-06-02 config.toml multi-port traffic isolation closeout
- Verified closeout on global `routecodex 0.90.2704`: 10000 via LAN IP returns HTTP JSON (502 upstream JSON, not Empty reply), 10000/5555 `/admin/ports` return 404 JSON with port tag, 5520 admin returns 401 JSON, and per-port log path `/Volumes/extension/.rcc/log/config.toml/ports/10000/server-10000.log` exists.
- Traffic governor scope truth: provider traffic files must include `server:<serverId>::<runtimeKey>` in encoded state keys, e.g. `server%3A127.0.0.1%3A10000%3A%3A...json`; bare runtimeKey files are legacy/shared and cannot prove per-port isolation.
- Red-test gate: `tests/red-tests/multi_port_server_isolation.test.ts` locks PortRegistry serverId/session dirs, async error JSON wrapping, admin guard, errorsample/snapshot/stats port paths, and ProviderTrafficGovernor per-server concurrency scope.

## 2026-06-03 Responses tool-call continuation contract
- Verified on 5555 after deploying routecodex 0.90.2750: Responses `status:"requires_action"` tool-call SSE must emit `response.required_action` and `response.done`, but must not emit `response.completed`; emitting `response.completed` can make Codex UI stop without executing/submitting tool output.
- Live evidence: `/Volumes/extension/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-minimax.key1-MiniMax-M3-20260603T150245058-252518-355/client-response_server.json` has `completed=0 required_action=1 done=1`; followup provider requests after 15:02 contain `function_call_output`.

## 2026-06-03 stop_message followup continuation contract
- `stop_message_flow` followup hops are normal tool-capable reenter requests and must remain eligible for bounded stopless continuation; do not set `stopMessageEnabled=false` / `routecodexPortStopMessageEnabled=false` on them, including nested `__rt` flags.
- Rust `stop-message-core` must not skip `followup_flow_id=stop_message_flow`; counters (`used/max_repeats`) are the loop guard. Non-stop-message followup flows may still use `skip_servertool_followup_hop` to prevent generic recursion.
- 2026-06-03: stopless `stop_message_flow` followup eligibility is now a structural skeleton/profile/runtime-carrier contract, not a text rule: `stopMessageFollowupPolicy=preserve_eligibility` is emitted by Rust skeleton, normalized by TS config/runtime plan, carried in `__rt`, and consumed by Rust `stop-message-core` as `stop_message_followup_policy`. Missing policy defaults to `disable`; TS dispatch must not infer preserve from `flowId=stop_message_flow` or `servertool.stop_message` source strings. Verified by `cargo test -p stop-message-core`, `cargo test -p router-hotpath-napi servertool_skeleton_config --lib`, targeted Jest followup/stop tests, and `npm run build:min`.
- 2026-06-03: stopless schema now carries `learned` for “what was learned in past turns”; write to project `note.md` only on true final stop (`schemaGate.action=allow_stop`) and non-empty learned. Followup / invalid schema / missing schema / budget exhausted do not write memory. Verified by stop-message-core tests, cache-writer Jest, stop-message followup Jest, build/install/restart 5555, and manual dist black-box.
- 2026-06-04: stopless/servertool gateway must inspect `HubRespChatProcess03Governed` chat payload. A regression used client outbound/SSE payload after `RespOutboundSseStream`, causing Anthropic `end_turn` text stops to bypass schema questioning. Fixed by planning servertoolRuntimeAction from chat-process payload and fail-fasting TS shell when effect payload is absent. Verified by router-hotpath Anthropic end_turn test, focused Jest, build/install/restart 5555, and 5555 log showing `source=chat reason=finish_reason_stop eligible=true`.

## 2026-06-03 Hub/VR node contract runtime help closeout
- Verified contract truth: `router-hotpath-napi/src/hub_pipeline_contracts/mod.rs` is the Rust runtime source for Hub/VR online contract help. It exposes Hub request node contracts, `VrRoute04SelectedTarget`, five `Meta*` carrier contracts, single-node describe, and boundary validation; TS only bridges these via native help wrappers.
- Verified metadata boundary: VR routing controls now enter through `MetaRoute03RouteCarrier` before instruction build/selection; provider body, direct passthrough body, OpenAI SDK options, OpenAI chat/Responses, Gemini, Anthropic, and Qwen web_search exits fail fast on internal `metadata` instead of silently stripping it.
- Verified observation split: node `dataProcessed` belongs to `observation`, not control `metadata`; Rust and TS node result types/tests lock this separation.
- Verification gates passed locally: Rust targeted contract/MetaRoute03/observation tests, red topology/meta/VR/provider-specific/residue tests, focused provider/client/direct metadata tests, esbuild syntax checks for touched TS bridge/provider/client files, and `git diff --check`.

## 2026-06-04 HubPipeline/VR 8 节点 contract 化 closeout
- 验证 8 节点 contract (HubReqInbound02Standardized, HubReqChatProcess03Governed, HubReqOutbound05ProviderSemantic, ProviderReqOutbound06WirePayload, HubRespInbound02Parsed, HubRespChatProcess03Governed, HubRespOutbound04ClientSemantic, VrRoute04SelectedTarget) 全部注册到 `hub_pipeline_contracts/mod.rs` 并通过 native wrapper `describeHubPipelineContractsWithNative/describeVirtualRouterContractsWithNative/describePipelineContractWithNative/describeMetaCarrierContractsWithNative` 在线返回。5 个 Meta* carrier 完整: `MetaReq01EntryCaptured/MetaReq02RuntimeCarrier/MetaRoute03RouteCarrier/MetaResp04SameRequestCarrier/MetaDone05Released`。`describe_hub_pipeline_contracts` 默认只返 4 节点;要返 7 hub 节点必须用 `all_hub_pipeline_contracts()` 单点函数,不能改 describe 函数本身(单点真源,不能 patch helper)。
  Tags: hub-pipeline, virtual-router, contract, online-help, native-wrapper, 2026-06-04
- 验证 live runtime engine.rs 6 typed entrypoints 真实命中 (line 235/278/333/460/498/551: `run_hub_req_inbound_02_standardized_entrypoint` / `run_hub_req_chatprocess_03_governed_entrypoint` / `run_hub_req_outbound_05_provider_semantic_entrypoint` / `run_hub_resp_inbound_02_parsed_entrypoint` / `run_hub_resp_chatprocess_03_governed_entrypoint` / `run_hub_resp_outbound_04_client_semantic_entrypoint`),types/2 builder 命中 (`build_vr_route_04_from_hub_req_chatprocess_03` / `build_provider_req_outbound_06_from_hub_req_outbound_05`)。engine.rs 无任何非相邻 shortcut (`build_*_from_*` 越级 builder = 0)。TS wrapper (executor-pipeline.ts/request-executor.ts 等) 收缩为薄壳转发。
  Tags: hub-pipeline, typed-entrypoint, live-runtime, engine-rs, 2026-06-04
- 验证 SSE/JSON 出口 fail-fast 硬约束:`assertClientResponseHasNoInternalCarriers` 必须在 `stripInternalKeysDeep` 之前调用。旧顺序是先 strip 再 guard,`__rt/__internal` 字段被静默删除后 guard 找不到,破坏 fail-fast 契约(silent strip 反模式)。修后任何 `__*` internal carrier 都先 fail-fast,永不静默 strip。`tests/red-tests/server_sse_guard_e2e.test.ts` 18/18 绿(14 forbidden field direct unit + 2 dispatch detection + 2 JSON 出口 e2e)。`tests/red-tests/server_sse_metadata_guard_e2e.test.ts` 同样锁出口 fail-fast。
  Tags: fail-fast, sse-guard, json-guard, silent-strip, anti-pattern, internal-carrier, 2026-06-04
- 验证 14 red test file green(收口期): `hub_pipeline_live_runtime_typed_entrypoints_e2e` 6/6(合同 + engine.rs + types 锁)+ `server_sse_guard_e2e` 18/18 + `hub_pipeline_contract_node_completeness` 3/3 + `error_chain_singleton_truth` 7/7 + `hub_pipeline_type_topology_contract` 7/7 + `hub_pipeline_response_type_topology_contract` + `hub_pipeline_vr_provider_boundary_contract` + `hub_pipeline_request_typed_entrypoint_contract` + `hub_pipeline_meta_error_carrier_contract` + `hub_pipeline_type_residue_contract` + `no_provider_body_metadata_control` + `no_provider_specific_in_hub_pipeline` + `server_module_help_contract` + `server_req_adapter_metadata_whitelist` + `server_response_projection_metadata_guard` + `server_error_projection_metadata_guard` + `handler-utils.metadata-contract` + `handler-utils.metadata` + `server-module-help.live`。Rust `cargo test -p router-hotpath-napi hub_pipeline_contracts` 10/10 + `hub_pipeline_types` 22/22 全绿。tsc 0 error。`git diff --check` 0 conflict。
  Tags: red-test, contract, e2e, jest, cargo, tsc, git-diff-check, 2026-06-04
- 旧 active `req_process/resp_process` 壳审计 = 0: TS src 中 grep 字符串描述仅 2 处 red test 文件,无活跃代码;cargo 符号表无对应导出;`tests/red-tests/error_chain_singleton_truth.test.ts` 7/7 锁 `isProviderFailureNetworkTransportLike` + `isBlockingRecoverableProviderFailure` 单点源真源(provider-failure-policy-impl.ts)。所有错误实现已物理删除,无"以防万一"死代码,无重复设计。
  Tags: legacy-shell, req-process, resp-process, physical-removal, no-dead-code, 2026-06-04
- Reusable rule: HubPipeline/VR 节点 contract 化要完整,必须双层验证(cargo test rlib + Jest e2e),且改 `hub_pipeline_contracts` 后 native binary 必须重 build,否则 Jest focus 子集 13 file green 不等于 binary 反映最新 contract。`sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node` mtime 是 contract 改动后 binary 重建的硬信号。
  Tags: native-binary, cargo-build, contract-change, mtime-check, hard-signal, 2026-06-04
- Reusable rule: `assertClientResponseHasNoInternalCarriers` 类 fail-fast guard 必须在任何 silent strip 之前调用。一旦顺序错(guard 在 strip 后),`__*` internal carrier 会被静默删除后 guard 找不到,反 fail-fast 契约成为 silent sanitizer。这是 fail-fast 反模式,违反 AGENTS.md"禁止 silent strip / 禁止 fallback"硬护栏。
  Tags: guard-order, fail-fast, silent-strip, anti-pattern, hard-guardrail, 2026-06-04
- Reusable rule: Jest 直接 import router-hotpath-napi (.node) 会出现 `ERR_REQUIRE_ESM` 或 `ERR_UNSUPPORTED_DIR_IMPORT`。最小解法是 spawn 独立 node 进程跑 CLI 二进制,或写 native callability 测试通过 `dist/native/*.node` + `lib/llmswitch-core.js`。不可强行 mock,否则会绕过 native ABI 验证。
  Tags: jest, napi, ERR_REQUIRE_ESM, native-binding, import-error, 2026-06-04

## 2026-06-04 Request field equivalence / followup no-backfill truth
- Servertool followup is a normal nested request reentry, not a request-field patch DSL. Followup must not inject `requestSemantics` into nested body/metadata and must not restore `tools/tool_choice` from `rawBody`, `__raw_request_body`, `requestMetadata`, `contextSnapshot`, `responsesContext`, `toolsRaw`, or `clientToolsRaw`.
- Superseded on 2026-06-04 by the clone-delta truth below: `servertool_followup_delta` must not support request-field patch/backfill ops such as `preserve_tools`, `ensure_standard_tools`, `replace_tools`, `force_tool_choice`, `drop_tool_by_name`, or `append_tool_if_missing`; however origin standard request fields such as `tools`, `tool_choice`, and params must be preserved by cloning `capturedChatRequest`.
- Provider wire guard truth: `ProviderReqOutbound06WirePayload` must fail-fast if provider body contains request-context carriers (`toolsRaw`, `clientToolsRaw`, `responsesContext`, `contextSnapshot`, `requestMetadata`, `__raw_request_body`, `rawBody`) or Codex namespace aggregate tools (`type:"namespace"` / `{name, tools:[...]}`).

## 2026-06-04 Full architecture audit closeout
- Server/client metadata separation truth: `assertClientResponseHasNoInternalCarriers` may allow `metadata` only on true client-visible Responses objects (`object="response"` with string `id`); SSE frames, generic client frames, and nested non-Responses objects carrying `metadata` must fail-fast. Internal metadata keys inside Responses protocol metadata also fail-fast.
- Current topology naming truth: active docs, red tests, and live telemetry labels must use canonical nodes such as `HubReqChatProcess03Governed` / `HubRespChatProcess03Governed`; old `req_process_*` / `resp_process_*` names are migration legacy/search keywords only, not current design truth.
- Architecture red-test gate: full `tests/red-tests/*` passed after closeout (22 suites / 122 tests), and `npm run build:min` passed with build version 0.90.2822.
  Tags: routecodex, architecture-audit, metadata-isolation, topology-naming, red-tests, 2026-06-04

## 2026-06-04 Snapshot requestMetadata no raw tool carriers
- Provider snapshot `meta.requestMetadata` is debug data and must not persist raw request-field carriers. Snapshot writer must sanitize `__raw_request_body`, `rawBody`, `requestMetadata`, `responsesRequestContext`, `responsesContext`, `contextSnapshot`, `toolsRaw`, `clientToolsRaw`, and `toolsNormalized` before writing provider/client snapshots.
- This sanitizer is snapshot-only; live metadata side-channel remains separate from provider body, and provider body is guarded by `ProviderReqOutbound06WirePayload`.

## 2026-06-04 Request field equivalence closeout truth
- Request live fields must come from ChatProcess/Chat source semantics only. Responses bridge must not use `ctx.parameters`, `ctx.metadata.parameters`, `ctx.metadata`, `ctx.toolsRaw`, or context tool controls to project live request fields.
- `PrepareResponsesRequestEnvelopeInput` is now single-source for request fields: Chat parameters only, plus explicit instruction/stream/strip flags. Context/metadata request-field entries were physically removed to prevent future raw/context backfill.
- Verified gates: TS targeted 10 suites/82 tests, Rust `prepare_responses_request_envelope`/`servertool_followup_delta`/`provider_req_outbound_06_wire_payload`, `npm run build:min`, global install/restart 5555 `0.90.2826`, and live provider-request namespace/internal-carrier scan `hits=[]`.

## 2026-06-04 stopless schema 连续 stop 预算真相
- stopless / stop schema 终止规则：missing schema、invalid schema、`stopreason=2` 都共享同一个连续 `finish_reason=stop` 预算；第三次连续 stop 走 budget-exhausted final summary。中间只要出现 tool call / 非 stop / 真实进展，必须 reset `stopMessageUsed`。
- `stop_message_flow` followup hop 是 bounded continuation，仍可重新触发 stopless；只有非 `stop_message_flow` 的 generic servertool followup 才 `skip_servertool_followup_hop`。
- 真实样本锚点：`~/.rcc/codex-samples/openai-responses/port-5555/req_1780562260281_0ffba4a1/provider-response.json` 与同端口 `*_stop_followup/provider-request.json`。
- 验证基线：改 Rust stop-message-core 后必须先重建 NAPI（`node scripts/build-core.mjs && node scripts/vendor-core.mjs`），再跑 `cargo test -p stop-message-core --lib` 和 stop-message 三文件 Jest。

## 2026-06-04 usage lifecycle truth
- Usage has two separate projections: internal/log accounting keeps `prompt_tokens`/`completion_tokens` as canonical aggregate fields, while `/v1/responses` client payload must project only Responses usage fields (`input_tokens`, `output_tokens`, `total_tokens`, details). Do not leak chat usage aliases to Responses clients.
- Cache accounting is protocol-sensitive: OpenAI Responses `input_tokens` already includes cached tokens, while Anthropic-style `input_tokens` may exclude `cache_read_input_tokens`; always pass `providerProtocol` into usage extraction before computing cache hit/total metrics.

## 2026-06-04 servertool followup clone-delta truth
- Supersedes earlier same-day wording that implied followup should rebuild or prune request fields. Servertool followup must clone the captured `HubReqInbound02Standardized` standard request and apply only followup delta; it must not reconstruct from raw payload/context or selectively rebuild `model/messages/tools/parameters`.
- Origin semantic fields such as `tools`, `tool_choice`, `parameters`, `parallel_tool_calls`, and protocol controls are preserved in the cloned standard request. Internal metadata remains side-channel and must not become provider/client payload.
- Verified after native rebuild and global install: Rust `servertool_followup_delta` 11/11, focused Jest 4 suites/12 tests, `npm run build:min`, `routecodex restart --port 5555`, health `0.90.2842`.

- 2026-06-04: servertool followup origin 真源收敛：followup capture 必须发生在请求 entry，保存 `entryOriginRequest/capturedEntryRequest`，followup 只能 clone 入口协议原请求并加 delta；`/v1/responses` 必须保持 `input` shape，不能从 chat `messages`、raw metadata、responses context 或当前污染 payload 重建。旧 `backfillServertoolAdapterContextTools*` 是错误实现，已从活路径/生成导出物理删除。验证：Rust `servertool_followup_delta` 11/11、focused Jest 4 suites/16 tests、`npm run build:min` 通过，版本 `0.90.2847`。
Tags: servertool, stopless, followup, entryOriginRequest, capturedEntryRequest, responses-input, no-raw-backfill, no-tool-list-backfill, rust-only

## 2026-06-04 ProviderForwarder sticky / 10000 MiniMax route truth
- Verified forwarder fix: `engine::selection::select_provider` must pass metadata `sessionId/session_id/routecodexSessionId/routecodexSessionID` into `ForwarderRegistry::select`; registry-only sticky tests are insufficient because live selection can otherwise pass `None` and silently disable session sticky.
- Current 10000 MiniMax policy: `tools` routes to `fwd.minimax.MiniMax-M2.7`; `coding/thinking/longcontext/multimodal` route to `fwd.minimax.MiniMax-M3`. Red-test truth: `tests/red-tests/forwarder_bootstrap_must_surface.test.ts` exact route-target assertions.
Tags: provider-forwarder, sticky-session, port-10000, minimax-family, red-test

## 2026-06-04 stopless followup schema gate
- Verified root cause for schema-missing stopless premature stop: followup metadata lacked `__rt.serverToolLoopState.flowId=stop_message_flow`, so nested stop followup became generic `__servertool_followup__` and skipped schema gate via `skip_servertool_followup_hop`.
- Stopless followup metadata must carry `serverToolLoopState.flowId=stop_message_flow`; skip/tool_call stop_message summary logs should remain file/stage events only, console only for `decision=trigger`.

## 2026-06-04 direct passthrough provider-wire contract
- direct passthrough 不属于 Hub Pipeline 主链：router-direct 只允许调用 VirtualRouter 选目标，禁止执行 HubPipeline request/response conversion；direct 只按入口协议与 providerProtocol 一致进入。
- `/v1/responses` direct payload 必须是 Responses wire；ResponsesProvider 在 transport 前 fail-fast 拒绝 chat `messages` 与 chat-style function tool `{type:"function", function:{name}}`，防止上游 400 `tools[n].name`。

## 2026-06-04 stopless live validation
- Live 5555 validation after install/restart: version `0.90.2852`, request `openai-responses-router-gpt-5.5-20260604T232109287-257121-764` returned 200; logs show nested `:stop_followup` no longer hits `skip_servertool_followup_hop`, instead continues `flow=stop_message_flow` and advances `used=1 -> used=2` until `stop_schema_finished`.

## 2026-06-04 Responses historical tool input content guard
- Responses provider input 中 `function_call` / `function_call_output` 工具历史项不得携带 `content`；工具调用参数在 `arguments`，工具结果在 `output`。历史不规范项携带 `content` 会触发上游 400 `array_above_max_length`。
- 唯一清理点是 Rust `hub_bridge_actions::filter_bridge_input_for_upstream`；Provider runtime `ResponsesProvider.assertResponsesWireShape` 只做最后 fail-fast 防线，禁止把污染 payload 发上游。

## 2026-06-04 ErrorPolicyCenter unified policy truth
- Provider/runtime/direct/executor error strategy truth is `src/providers/core/runtime/provider-failure-policy-impl.ts`; `ErrorHandlingCenter` is client/server projection only and must not enter provider retry/reroute/cooldown policy.
- Active categories are exactly `recoverable | unrecoverable | special_400 | periodic_recovery`; classifier/executor/direct code may expose or consume policy outcomes but must not locally derive `classification/recoverable/affectsHealth/shouldRetry/reroute` branches.
- Verified closeout gates: classifier/policy/error-chain/retry-execution/reselection focused Jest suites passed 62/62 and `npx tsc --noEmit --pretty false` passed; executor/direct classification comparison scan returned no matches outside provider policy.
Tags: error-policy-center, ErrorErr-chain, provider-failure-policy, no-fallback, 2026-06-04

## 2026-06-05 ErrorPolicyCenter final verification
- ErrorPolicyCenter closeout final gate passed after direct passthrough cleanup: 22 Jest suites / 155 tests covered error-chain red tests, provider policy/classifier/reporter, executor retry/reselection, router/provider direct, direct payload, and client projection metadata guards.
- Build gate passed: `npx tsc --noEmit --pretty false` and `npm run build:min` completed successfully; build auto-bumped package/build-info to `0.90.2858`.
- Static closeout scan returned no executor/direct `classification ===/!==`, no `ErrorHandlingCenter` in provider/executor/direct/VR policy paths, and no provider-direct bound-model rewrite helper.
Tags: error-policy-center, final-verification, direct-passthrough, build-min, 2026-06-05

## 2026-06-05 硬编码 + Fallback 架构风险收口 (Phase 1-3 已 commit, Phase 4-6 未开始)
- SSOT 唯一真源: `src/constants/index.ts` (`API_BASE_URLS` / `PROVIDER_TIMEOUTS` / `PROVIDER_DEFAULT_MODELS` / `SSE_DEFAULT_CAPS`); 错误码 → `src/providers/core/runtime/provider-error-catalog.ts`; provider key 抽象 → `isWindsurfRuntimeIdentity` + `isWindsurfManagedProviderIdentity` (in `src/providers/core/contracts/windsurf-provider-contract.ts`).
- Phase 1 commit `2395b253a` — constants SSOT 化 + 5 tests/api-base-urls+provider-defaults+windsurf-provider-contract.codes (红→绿, 31/31 jest).
- Phase 2 commit `2eac128ef` — `provider-error-catalog.ts` 暴露 `PROVIDER_UNRECOVERABLE_CODES` / `PROVIDER_NETWORK_CODES` / `PROVIDER_BLOCKING_RECOVERABLE_CODES`; `provider-failure-policy-impl.ts` 删除 3 个本地 Set, 替换为 catalog import.
- Phase 3 (TS) commit `72a884092` — `http-server-runtime-providers.ts` 4 处 + `request-executor.ts` 2 处 + `request-executor-pipeline-attempt.ts` 2 处 `windsurf.managed.` / `windsurf.` `startsWith` 全部替换为 `isWindsurfRuntimeIdentity` / `isWindsurfManagedProviderIdentity`. 红测 `tests/server/runtime/http-server/phase3-provider-family-abstraction.red.spec.ts` (5 passed). 诊断日志 key `[windsurf.runtime.init.fail]` 在白名单.
- Phase 3 (Rust) commit `7295f0e4` — `clear_windsurf_managed_persisted_503_family` 改名 `clear_persisted_503_family_for_provider`, 按 canonical provider key 匹配, 删除 `windsurf.managed.` 前缀特判. 双向 fixture: `record_success_clears_persisted_503_family_for_non_windsurf_provider` (deepseek.chat 验证) + `record_success_does_not_clear_other_providers_persisted_503_family` (deepseek + qwen 验证不串台). `cargo test -p router-hotpath-napi health::tests` 28 passed; 0 failed.
- 0 push. 4 commit 全部本地.
- 红测先行契约: 每个 Phase 必须先红后绿, `silent-failure-audit` 命中数 < 基线, 命中后物理删除, 不得用 "不接入" / "不调用" / 注释掉 替代.
- 物理删除铁律: 迁出后旧 Set / 旧 `if` 块 / 旧常量字符串必须删除, 保留必须经 `silent-failure-audit.mjs` + `hardcode-audit.mjs` 报警并写理由. Provider 特例只能在 Provider runtime; Hub Pipeline / Virtual Router / RequestExecutor 禁 `windsurf.managed.` / `windsurf.` / `deepseek` / `qwen` 字符串特判.
- 阻塞: `cargo test` 副作用每次跑会触碰 6-12 个 timestamp/auto-gen 文件 (`docs/agent-routing/10-runtime-ssot-routing.md` / `package.json` / `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/{chat_servertool_orchestration,req_process_stage2_route_select,shared_metadata_semantics,virtual_router_engine/forwarder,virtual_router_engine/routing/direct_model,servertool/handlers/stop-message-auto}.{rs,ts}` / `src/server/runtime/http-server/{index,port-config-types,port-config-validator}.ts` / `tests/servertool/stop-message-auto.spec.ts` / `tests/server/runtime/http-server/port-config-validator-sameprotocol.spec.ts` / `src/providers/core/runtime/provider-failure-policy-impl.ts`), commit 前需逐个 `git restore -- <path>` 排除. 旧工作区 `stash@{0}` 仍有 30 个无关文件, 已确认是另一台模型过期工作, 不在本 plan 范围.
- Phase 4 静默 catch 清理 (5 文件) / Phase 5 `verify:hardcode` 新建 / Step 6 AGENTS.md + rcc-dev-skills 同步 / live smoke / 黑盒 curl: **未开始**. 接手执行时先 `git status --porcelain` 看 13 M + 3 untracked 残留, 逐个 restore 非 plan 文件; 唯一真实改动 `health.rs` 已在 `7295f0e4` commit. 红测先行 → 改 5 文件 → silent-failure-audit 命中数 < 488 (基线) → 新建 `scripts/ci/hardcode-audit.mjs` → package.json 加 `verify:hardcode` → 落 AGENTS.md §10/§12/§17 引用 plan + rcc-dev-skills "2026-06-05 硬编码 / fallback 收口" 精华段.
Tags: hardcode-fallback-arch-audit, ssot, provider-family-abstraction, persisted-503-family, no-fallback, 2026-06-05

## 2026-06-07 servertool Rust binary Phase 1 closeout

- servertool 的最终执行形态是独立 Rust binary（`routecodex-servertool`），不是 TS command handler。
- crate 拓扑：`servertool-core`（lib: decision/contract/builder/gate/prompt/budget/projection）→ `servertool-cli`（bin: `routecodex-servertool`）→ `router-hotpath-napi`（napi bridge）。
- CLI contract 入口：`routecodex-servertool run <toolName> --input-json <json> [--flow <flowId>] [--repeat-count N --max-repeats N]`。
- stopless schema 闭环 Rust owner：`stopless_schema_guidance()` 返回 `schemaGuidance`（required_fields + stopreason_values）；TS 不得发明字段。
- projection schema Rust owner：`build_client_exec_cli_projection_output()` 构建 `execCommand` / `schemaGuidance` / `repeatCount` / `maxRepeats`；旧 `--ticket` / `stcli_` / `rcc_cli_` 标记在 Rust 测试中被显式拒绝。
- exec result validation Rust guard：`validate_client_exec_command_result()` 在 exec result 进入 req_chatprocess 前做 tool_name + flow_id 校验。
- TS 红线：TS 不得写 servertool 业务逻辑，不得 fallback 默认 summary，不得从 exec_command stdout 恢复 model tool identity；TS 只允许 spawn/parse/write。旧 TS CLI handler 在 Rust binary parity 后物理删除。
- Phase 1 验证命令：`cargo build -p servertool-cli` / `cargo test -p servertool-core`（32/32）/ `cargo test -p servertool-cli`（3/3）/ `node servertool-cli-binary-blackbox.mjs`（5/5）/ `node verify-servertool-rust-only.mjs`（全 PASS）。
- 整链路边界：Phase 1 覆盖 binary contract + projection schema + result validation；完整 HTTP pipeline 串联（拦截→exec→exec result→req_chatprocess 改名→schema 注入）是 Phase 2 目标。
Tags: servertool-rust-binary, servertool-cli, cli-contract, stopless-schema, projection-schema, no-ts-fallback, 2026-06-07

## 2026-06-07 servertool stopless CLI Phase B-E closeout

- Phase B（outcome classification）：`servertool-core/src/outcome_contract.rs` 实现三类 outcome 分类，stop_message_auto→ClientExecCliProjection，web_search→BackendRouteReenter，memory_cache_auto→ServerIoInternal；fake_exec/--ticket/stcli_/rcc_cli_ 在 Rust 层被拒绝。
- Phase C（tool name projection）：`servertool-core/src/tool_name_projection.rs` 实现 exec_command result → model-side original tool name 转换；验证 tool_name/flow_id/denied markers；web_search 不得投影为 ClientExecCliProjection。
- Phase D（schema closed loop + needs_user_input）：`needs_user_input` gate 已在 stop-message-core 实现，模型输出 needs_user_input=true + next_step 填问题内容 → Rust AllowStop 不计预算；next_step 为空 → Followup 要求补问题。
- Phase E（TS fallback deletion）：`stop-message-counter.ts` 的 resolveDefaultSnapshot / fallback branch 已物理删除；tryNativeBudget catch 改为 throw SERVERTOOL_NATIVE_BUDGET_FAILED；verify-servertool-rust-only ALL PASS。
- Rust 测试总数：servertool-core 54 + servertool-cli 3 + stop-message-core 42 = 99 tests ALL PASS。
- 覆盖边界：Phase B/C/D 的 Rust unit test 已覆盖分类/projection/gate/schema；HTTP blackbox 整链路（拦截→exec→exec result→改名→schema 注入）需要完整 server 启动，当前未覆盖。
Tags: servertool-rust-binary, outcome-contract, tool-name-projection, needs-user-input, no-ts-fallback, 2026-06-07

## 2026-06-07 ErrorPolicyCenter Rust-first 3-gap closeout
- 3a/3c (pool alternative → no health mutation): Rust `event_affects_health` checks `routePool`/`excludedProviderKeys` from error event. TS passes data only. TS health-impact test 2/2 PASS.
- 3d (429 ladder): `next_ladder_cooldown_ms` alternates 30m→3h via `rem_euclid(2)`. `http_429_cooldown_cycles %= 3` removed. 25/25 Rust health tests PASS.
- 3e (reprobe → 3h): `consume_persisted_503_reprobe_if_available` pre-arms `threshold-1` + `cycle=1`.
- Dead const deleted: `LADDER_COOLDOWN_10M_MS` / `LADDER_COOLDOWN_5H_MS`.
- Build: `npm run build:min` PASS (0.90.2971).
- Pre-existing failures: `provider-failure-plan.spec.ts` 3/3, `recoverable_non_429...events test` 1/1 (both on clean main).

## 2026-06-07 direct passthrough corrected contract
- direct/router-direct/provider-direct is same-protocol provider passthrough + hooks only: use the current request body object, do not clone, do not rebuild from `metadata.__raw_request_body`/snapshot/context, do not call direct body builders/provider outbound sanitizers/runtime tool validators/history repair/protocol conversion.
- router-direct must not use `providerPayload` or selected runtime model to overwrite current request body. If a provider rejects the client model, fix the route/entry contract, not direct payload construction.
- Responses tool/history legality belongs to Rust Hub/Responses conversation store owner. Direct live requests do not clean chat-style tools; client-invalid body should fail at provider, while RouteCodex-generated history must be persisted/restored as legal Responses shape.
- Verified gates: focused direct Jest 5 suites / 42 tests PASS; `npm run verify:responses-direct-tool-shape-contract` PASS; `cargo test -p router-hotpath-napi hub_pipeline_session_identifiers` 6/6 PASS; `npm run build:min` PASS and installed/restarted 5520 at 0.90.2978.
Tags: direct-passthrough, router-direct, provider-direct, responses-history, no-raw-metadata, no-clone, 2026-06-07

## 2026-06-07 429 retry stale preselected route fix
- Live sample `openai-responses-router-gpt-5.5-20260607T190937966-313995-1768` proved `provider-switch exclude_and_reroute` can still terminally return MiniMax 429 when retry metadata preserves `__routecodexPreselectedRoute`; the second Hub route then reuses the failed MiniMax target despite `excludedProviderKeys`.
- Owner fix: `src/server/runtime/http-server/executor-metadata.ts::decorateMetadataForAttempt()` must delete `__routecodexPreselectedRoute` whenever `excludedProviderKeys.size > 0` or `attempt > 1`. Do not fix this in `ErrorHandlingCenter`; it is only `ErrorErr06ClientProjected`.
- Verification: targeted metadata red test and request-executor 429 failover test PASS; retry execution plan suite PASS.
Tags: error-policy-center, request-executor, preselected-route, 429-reroute, ErrorErr05, 2026-06-07

## 2026-06-07 Responses SSE terminal native-owner closeout
- Responses SSE terminal repair/dedupe truth is Rust native `shared_responses_response_utils.rs`: probe records `__seen_response_required_action`, `__seen_response_completed`, `__seen_response_done`, and `__seen_done_chunk`; terminal frame builder dedupes from those flags.
- TS `handler-response-utils.ts` may buffer/write native-returned frames and manage stream lifecycle, but must not infer `tool_calls` from `response.required_action`, inspect `required_action/submit_tool_outputs/tool_calls` for terminal repair, or filter native repair frames by required_action semantics.
- Required_action terminal contract remains: emit `response.required_action` only if missing, never emit `response.completed`, and emit `response.done` / `[DONE]` only if missing.
- After Rust native terminal repair changes, run `node scripts/build-core.mjs` before blackbox/Jest suites that load `dist/native/router_hotpath_napi.node`; source-only Rust changes are not enough for Node tests.
- Verified: residue + affected SSE Jest set PASS 98/98; `npx tsc --noEmit --pretty false` PASS; Rust targeted `terminal_frames_for_required_action_must_not_emit_completed` PASS.
Tags: responses-sse, terminal-repair, rust-owner, required-action, no-ts-semantics, 2026-06-07

## 2026-06-07 direct Responses conversation store bridge invariant
- `src/modules/llmswitch/bridge/runtime-integrations.ts` must operate on the active global Responses conversation store; if a store method is missing, falling back to core dist can overwrite `globalThis.__rccResponsesConversationStore` and split runtime/test state.
- `ResponsesConversationStore` therefore exposes class-level `finalizeResponsesConversationRequestRetention()`, and the exported helper delegates to the same singleton. Do not reintroduce requestMap introspection from bridge or dist fallback for this method.
- Router-direct successful Responses results must record response scope (`sessionId`/`conversationId`/routing group/provider) and explicitly opt into scope continuation; failed HTTP status and SSE wrapper results must clear the captured request.
- Verified: direct passthrough route/minimum/direct-result suites PASS 21/21; 429/ErrorHandlingCenter focused gate PASS; `npx tsc --noEmit --pretty false` PASS.
Tags: direct-passthrough, responses-conversation-store, bridge-singleton, scope-continuation, 2026-06-07

## 2026-06-07 Hub Pipeline Phase 0 generated artifact cleanup
- `sharedmodule/llmswitch-core/src/**/*.js`, `.d.ts`, and `.js.map` are generated TS emit artifacts and are ignored by `.gitignore`; source truth under that tree is `.ts`, not side-by-side JS.
- All tracked `sharedmodule/llmswitch-core/src/**/*.js.map` artifacts were physically removed and locked by `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`; the gate fails if an existing src-side `.js.map` becomes tracked again.
- Verification: residue audit 81/81 PASS, `npx tsc --noEmit --pretty false` PASS, `git diff --check` PASS.
Tags: hub-pipeline-rust-closeout, generated-artifacts, residue-gate, physical-delete, 2026-06-07

## 2026-06-07 Hub Pipeline active closeout docs no longer target stage wrapper
- `runHubPipelineStageJson` / `runHubPipelineStageWithNative` are retired APIs and must not be presented as active Rust closeout targets. Active closeout docs now point to total entries `executeHubPipelineJson` / `runHubPipelineLibJson` and `docs/goals/hubpipeline-full-rust-closeout-plan.md`.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` now gates the active closeout docs against retired stage wrapper API mentions.
- Verification: residue audit 82/82 PASS, `npx tsc --noEmit --pretty false` PASS, `git diff --check` PASS.
Tags: hub-pipeline-rust-closeout, docs-contract, retired-stage-wrapper, residue-gate, 2026-06-07

## 2026-06-07 Hub Pipeline zero-consumer TS wrapper deletion
- Zero-consumer TS native wrappers/helpers under Hub Pipeline should be physically deleted rather than kept as "thin shells" when they have no live import, no public barrel export, no same-name JS shadow artifact, and the native capability remains available from Rust/native wrapper truth.
- Deleted files: `hub-pipeline-mutable-record-utils.ts`, `target-utils.ts`, `chat-process-governance-finalize.ts`, `chat-process-web-search-intent.ts`, `chat-process-web-search.ts`, `chat-process-web-search-tool-schema.ts`, `client-inject-readiness.ts`, `chat-response-utils.ts`, `provider-response-observation.ts`.
- Verification: residue audit 83/83 PASS, `npx tsc --noEmit --pretty false` PASS, `git diff --check` PASS.
Tags: hub-pipeline-rust-closeout, zero-consumer, physical-delete, ts-thin-shell, 2026-06-07

## 2026-06-07 Hub Pipeline timing measure owner cleanup
- `hub-stage-timing-measure-blocks.ts` duplicated timing measure logic that is already owned by `hub-stage-timing.ts`; with 0 live consumer it should stay deleted, including side-by-side generated `.js`, `.d.ts`, and `.js.map` artifacts.
- Residue audit now guards the TS source and generated artifacts from reappearing.
Tags: hub-pipeline-rust-closeout, timing, generated-artifacts, physical-delete, 2026-06-07

## 2026-06-07 Hub/VR source-side emit artifacts are not source truth
- `sharedmodule/llmswitch-core/tsconfig.json` emits to `dist`; side-by-side `.js`, `.d.ts`, and `.js.map` under `sharedmodule/llmswitch-core/src/conversion/hub` or `src/router/virtual-router` are stale generated artifacts, not runtime source truth.
- Phase 8F-7 deleted 193 git-ignored side-by-side emit artifacts under those Hub/VR source truth dirs and added a residue gate that fails if they reappear.
- Deletion rule: only delete candidates after confirming they are git-ignored; never treat source-side JS shadows as semantic fixes for Hub Pipeline or Virtual Router.
Tags: hub-pipeline-rust-closeout, virtual-router, generated-artifacts, source-truth, 2026-06-07
