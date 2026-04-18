# RouteCodex Memory

## Skills 与调试工作流

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



- 2026-03-10: `~/.codex/skills/pipedebug/` 已按当前 RouteCodex V2 结构更新。默认调试主线改为：先看 `~/.routecodex/codex-samples/`，先判断问题属于 request path 还是 response path，再沿 `host bridge -> llmswitch-core Hub Pipeline -> Provider V2` 的真实边界定位。旧的“4 层流水线 / workflow-compatibility-provider README / routecodex-worktree/fix / ~/.claude/skills”表述已从 `SKILL.md` 与 references 中移除。
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
