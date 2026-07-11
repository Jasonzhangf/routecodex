# RouteCodex 错误策略收口（Router Policy SSOT）

> 2026-04-15 决策更新  
> **不再保留独立 `error-handling center` / event engine 作为中心。**  
> 当前实现里，独立 center 仅承担 `emit/subscribe/normalize`，不掌握 retry/reroute/backoff/fail/cooldown policy，继续保留只会制造第二中心。  
> **目标真源改为：`Virtual Router policy`。** 所有 provider/runtime/send/convert/followup 执行期错误，统一进入 Router policy 判定；`RequestExecutor` 与 `servertool engine` 只消费 Router 输出的 decision / policy state。

本页记录 RouteCodex 错误处理的**目标收口架构**与实现边界。历史 V2 机制中凡是“独立错误中心 / event bus”语义，均以本页的新决策为准，后续实现需同步删除旧中间层。

## 0a. 2026-04-16 当前已验证收口状态

- **provider 执行期错误主链已切到 `Virtual Router policy`**
  - Host `emitProviderError` 不再双上报 `RouteErrorHub`
  - 当前主路径：`provider/runtime/send/convert/followup error -> provider-error-reporter -> reportProviderErrorToRouterPolicy -> Virtual Router policy`
- **HubPipeline 已不再把 legacy center 当主订阅中心**
  - TS `HubPipeline` bridge wrapper 会先拆掉旧的 `providerErrorCenter/providerSuccessCenter.subscribe(...)`
  - 再把 runtime router hooks 直接挂到 `routerEngine.handleProviderError/Success`
- **legacy `providerErrorCenter/providerSuccessCenter` 现阶段只保留 compat adapter 角色**
  - 残留 `emit(...)` 会在 bridge 层被 patch 后继续 forward 到 runtime ingress
  - 即：它们仍物理存在，但**不再主导策略**
- **RouteErrorHub / ErrorHandlingCenter 现阶段只保留 Host 边界职责**
  - 适用：HTTP / server / CLI / 外层错误映射与统一返回
  - 不再承担 provider runtime retry/reroute/backoff 主决策
- **429 止血已落地**
  - `RequestExecutor` 不再因为“当前 tier 是 singleton”就抱着当前 provider 死重试
  - 当前 provider 出错会优先被排除并 reroute
- **provider error reporting 前置装配已收口到单点 helper**
  - `runtime_resolve` / `provider.send` 不再分支内手拼 `errorCode/upstreamCode/statusCode/stageHint`
  - 当前统一入口：`resolveRequestExecutorProviderErrorReportPlan(...) -> reportRequestExecutorProviderError(...)`
  - `resolveRequestExecutorProviderErrorReportPlan(...)` 现在会自己优先解析 `requestExecutorProviderErrorStage`（含 `details`）；外层只需要给默认 stage，不再先手动 resolve fallback
  - 已覆盖 `provider.runtime_resolve` / `provider.sse_decode` / `provider.followup` 的阶段判定
- **converted retryable HTTP status 不再双上报**
  - 之前 `converted 401/429/5xx` 会在 try 内先报一次 `provider.http`，外层 catch 再报一次
  - 现改为只给错误打 `provider.http` stage marker，统一由外层 `reportRequestExecutorProviderError(...)` 上报一次
- **provider.followup 不再污染 provider 健康**
  - servertool/client-inject/followup payload 这类 followup orchestration 错误统一视为 health-neutral
  - `RequestExecutor` 会按 `provider.followup` stage 直接给 `affectsHealth=false`
  - `emitProviderError(...)` 现在会显式尊重调用方传入的 `affectsHealth=false`，不再把所有 non-recoverable 一律强改为 `true`
- **followup stage marker 前移到 converter 源头**
  - `provider-response-converter` 对 `SERVERTOOL_*` followup 错误会直接打 `requestExecutorProviderErrorStage='provider.followup'`
  - request-executor 优先读 marker，再回退到 code/stage 推断
- **SSE decode stage marker 也开始前移**
  - SSE wrapper / bridge SSE remap 错误会直接打 `requestExecutorProviderErrorStage='provider.sse_decode'`
  - legacy `executor-response` 也已同步，减少新旧链路阶段口径漂移
  - request-executor 继续保留 fallback 推断，但优先使用显式 marker
- **client injection host 源头也已接入 followup marker**
  - `client-injection-flow` 创建的 strict tmux / inject 失败错误会直接打 `requestExecutorProviderErrorStage='provider.followup'`
  - 这样 host 内部已知的 followup/internal error 不必再等外层按 code/message 推断

## 0. 唯一真源与待删除项

### 唯一策略真源
- `Virtual Router policy`
  - classify error
  - decide retry / reroute / backoff / fail
  - manage cooldown / health / quota / exclusion
  - output unified error decision / policy state

### Consumer
- `RequestExecutor`
  - 只执行 Router 返回的 decision plan
- `servertool engine`
  - 只保留 followup 编排前 / internal error 边界
  - provider/runtime/send/convert 类错误不得再自定义第二套语义

### 待移除
- 独立 `error-handling center`
- 独立 event engine / event bus
- `RequestExecutor` 内部自带的第二套 retry/reroute/backoff 决策语义

## 1. 统一流程（目标态）

1. **HubPipeline** 做编排与向上抛错，不定义最终错误策略。
2. **Virtual Router policy** 接收执行期错误输入，产出统一 decision：
   - `exclude_and_reroute`
   - `fail`
3. **RequestExecutor** 消费该 decision 并执行实际 reroute / fail；禁止同请求内等待冷却或重打同 provider。
4. **servertool followup** 的 provider 类错误也走同一套 Router policy；只有 payload 缺失、reenter 不可用、client inject dispatcher 缺失等编排前/internal error 保留在 servertool 自身边界。

## 1.0 2026-06-14 设计校正：按 Jason 中心思想统一 direct/provider/provider-pool 错误语义

本节覆盖一个此前未完全收口的 gap：

- relay / request-executor 主路径已经基本满足“provider 错误进入统一策略中心 → 计数/冷却/切 provider → 候选耗尽才返客户端”；
- 但 `router-direct` / `provider-direct` 仍保留“passthrough + hooks only + fail-fast rethrow”语义，导致 provider send error 在仍有候选 provider 时也会过早投影给客户端；
- 这与 Jason 的中心原则冲突：**只要当前 route pool 或合法下一阶段 pool 里还有 provider，就不应该因单个 provider 错误中断对话。**

### 1.0.1 正确设计（唯一真源版本）

1. **唯一策略中心不变**：仍是 `Virtual Router policy + ProviderFailurePolicy + request-executor error action queue`，不是恢复旧 `ErrorHandlingCenter` 第二中心。
2. **direct 只允许 payload/response passthrough，不允许 error-policy passthrough**：
   - `router-direct` / `provider-direct` 可以保持同协议 request/response 不改写；
   - 但 provider `send/processIncomingDirect` 错误必须回到统一策略中心消费 decision，不能直接 rethrow 给 `ErrorErr06`。
3. **候选优先原则**：
   - 只要当前 route pool 还有未排除候选 provider，provider 执行期错误不得直接 client-visible；
   - 必须先进入统一错误动作队列等待，再由策略决定 same-provider retry 一次或 exclude-and-reroute；
   - 只有候选全部耗尽，才允许进入 `ErrorErr06ClientProjected`。
4. **default pool / secondary pool 不是 host fallback**：
   - 如果产品语义要求“主池空但 default 仍可接”，这必须成为 Virtual Router 的显式二阶段选路 contract；
   - Host / `http-server` / `RequestExecutor` 禁止在池空后本地偷切 default，这会制造第二路由中心。
5. **client_disconnect 永不算 provider failure**：
   - `CLIENT_DISCONNECTED`、`client_request_aborted`、`client_response_closed`、以及 upstream/nginx 风格 `HTTP_499` + `client abort request` / `client closed request` 都属于 transport cancel；
   - 它们必须 `affectsHealth=false`、不计 cooldown、不断言 provider 持续异常、也不投影成 provider-visible 4xx 给客户端。

### 1.0.2 provider 执行期错误的正确 contract

统一先分类，再执行动作：

1. `client_disconnect`
   - 不计 provider health / cooldown
   - 不参与 provider 切换计数
   - 不投影为 provider-visible upstream error
2. `special_400`
   - 请求/协议/contract 本身错误
   - 直接客户端可见
   - 不切 provider
3. `recoverable`
   - 进入统一错误动作队列阻塞等待（`1s -> 3s -> 5s -> repeat`）
   - 若当前 pool 仍有候选，优先 `exclude_and_reroute`
   - 仅在明确允许时才 `retry_same_provider_once`
4. `unrecoverable / periodic_recovery`
   - 由策略决定是否排除/冷却当前 provider
   - 若当前 route pool 或 default pool 仍有候选继续切；只有二者同时为空后才返客户端

### 1.0.2a 2026-06-20 provider error reroutable-until-default-empty contract

Jason 纠偏后的当前硬骨架：

1. 所有 provider 执行期错误默认可切，包括 `401` / `403` / `INVALID_API_KEY` / `INSUFFICIENT_QUOTA` / `ACCOUNT_DISABLED` / `429` / `5xx` / transport / SSE decode / protocol error。
2. 唯一允许进入 `ErrorErr06ClientProjected` 的停止条件是：
   `routePoolRemainingAfterExclusion.length === 0 && defaultPoolAvailable === false`。
3. `defaultPoolAvailable` 必须来自 VR/default-pool truth；Host / RequestExecutor / direct lane 只消费该 truth，不得本地合成 default provider 链。
4. 每个 routing group 必须有显式非空 `routing.default` skeleton；default 最后一个 provider 不得被移出成空池。
5. `router-direct` 必须消费 `ErrorErr05ExecutionDecision`。当当前池已空但 `defaultPoolAvailable=true` 且 `mayProject=false` 时，必须递归回 VR/default planner，禁止 rethrow。
6. `http-error-mapper` 的 ErrorErr06 投影只能接收完整 `ErrorErr05ExecutionDecision`；legacy `details.policyExhausted` / `candidateExhausted` 不再是投影真源。

验证基线：

- `tests/red-tests/error_chain_may_project_gate.test.ts`
- `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
- `tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts`
- `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
- `tests/config/routecodex-config-loader.v2-single-source.spec.ts`
- `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`
- `npm run verify:provider-failure-ban-blackbox`

### 1.0.3 direct path 的正确职责

`router-direct` / `provider-direct` 的正确边界应为：

- 保留：
  - request body 直通
  - response body 直通
  - snapshot / telemetry / provider-wire trace
- 删除：
  - provider send error 直接 rethrow 给客户端
  - “只 report 不消费 decision” 的半接入错误链行为

换言之：

- **可以直通 payload；不能直通错误策略。**

### 1.0.4 client projection 的正确边界

`ErrorErr06ClientProjected` 只能在以下条件成立后投影 provider 错误：

1. 统一策略中心已经完成 classification；
2. request-executor / direct consumer 已经完成当前 pool 的 candidate 消耗；
3. 若产品允许 secondary/default pool，则也已由 VR 真源完成合法扩池/二阶段选路尝试；
4. 最终确认为“无候选可继续”。

禁止 `http-error-mapper` 仅凭 `status in 4xx` 就把 provider error 立即投影给客户端。

### 1.0.5 已关闭 gap（2026-06-20 验证结论）

1. relay/request-executor 主路径已接入 `defaultTierAvailable -> ErrorErr05.defaultPoolAvailable`。
2. `router-direct` 已删除 auth/quota terminal early return，并在 current pool empty + default available 时 request reroute。
3. `provider-direct` 仍不合成 route pool，但 provider error 进入统一 ErrorErr05 plan 后再 rethrow 给 projection 边界；它不得拥有第二套路由策略。
4. `http-error-mapper` 的 ErrorErr06 projector 已要求完整 ErrorErr05 decision；`mayProject=false` 会抛 `EARLY_PROJECTION_BLOCKED`。
5. `HTTP_499` / `client abort request` 仍作为 `client_disconnect` health-neutral、non-projectable 边界保留。
6. `primary pool exhausted -> default pool` 已是 Rust/VR contract，并由配置 default skeleton gate 与 live/default-pool replay 共同锁定。

### 1.0.6 维护要求

1. direct path 必须保持 unified decision consumer，禁止恢复 report-only caller。
2. default pool 扩池只能改 VR/Rust 真源与 contract/tests，不得在 Host 层补 fallback。
3. `client_disconnect` 必须继续停在 health-neutral / non-projectable 边界。
4. `ErrorErr06ClientProjected` 只能处理 `mayProject=true` 的最终错误。
5. 新增 auth/quota/provider-error 场景时，必须同步覆盖正向“先切”与反向“池空才投影”测试。

## 1.1 三分类硬约束（2026-05-28）

Provider 执行期错误只允许归一到以下三类，禁止新增第四类语义分支：

- `recoverable`
- `unrecoverable`
- `special_400`

约束：

1. 所有具体错误（网络、502、2056、限流、协议异常等）只能先归一到三分类之一，不能在执行链路新增“某错误专用处理通道”。
2. 分类唯一入口：`resolveProviderFailureClassification(...)`（provider failure policy）。
3. 执行唯一出口：`resolveProviderFailureActionPlan(...)` / Router policy decision（retry/reroute/cooldown/fail）。
4. RequestExecutor / ServerTool / Converter 不得绕过分类直接按具体错误码各自发明重试/冷却策略。
5. followup / host contract 等非 provider 执行期错误可在边界层短路，但不得污染 provider health 处理主链。

## 1.2 统一错误动作队列（2026-06-09）

错误本身继续按 `ErrorErr01..06` 链路分类、路由和投影；错误后的防风暴等待统一由
`src/server/runtime/http-server/executor/request-executor-error-action-queue.ts` 管理。

固定规则：

1. backoff 只允许 `1s -> 3s -> 5s -> 1s...` 循环。
2. backoff 必须是 blocking wait，并通过同一 category/scope gate 排队。
3. 不允许调用点自带 env/base/max/jitter/Retry-After/exponential 配置。
4. 错误动作通过 queue hook 观测：`record` / `wait_start` / `wait_end`。
5. 支持 category 固定为：`global_error`、`session_storm`、`servertool_followup`。
6. waiter cap 固定在统一队列内；超过 cap 显式抛 `PROVIDER_TRAFFIC_SATURATED`，不得吞异常。

并发/RPM 饱和规则：

- `provider-traffic-governor` 发现当前 runtime 满并发或 RPM 饱和时，必须先释放文件锁，然后直接抛 `ProviderTrafficSaturatedError`，由上层错误链/Virtual Router 切 provider。priority mode 也不得死等当前 provider。
- 旧 `softWaitTimeoutMs`、traffic local waiter queue、动态并发 blockedBackoff、分散 acquire sleep 全部不再作为 backoff 真源。

统一修改点：

- 队列 owner：`request-executor-error-action-queue.ts`
- provider send/global-error wait projection：`request-executor-global-error-backoff.ts` 只消费统一错误动作队列，不再保留独立 provider-failure backoff owner
- traffic acquire：`provider-traffic-governor.ts` 只消费统一队列，不本地计算等待
- servertool followup retry：只消费 `servertool_followup` category，不自带指数 retry wait

## 2. 分层职责

| 层 | 职责 | 不该做什么 |
| --- | --- | --- |
| HubPipeline | request/chat-process 编排、标准化、向上抛错 | 不定义最终 retry/reroute/backoff 策略 |
| Virtual Router policy | 错误分类、路由/冷却/健康/额度策略、统一 decision 输出 | 不负责具体 sleep/retry 执行循环 |
| RequestExecutor | 执行 Router decision、驱动 provider runtime/send/convert、通过统一错误动作队列执行 blocking wait | 不再独立发明第二套 error policy 或本地 backoff 配置 |
| servertool engine | followup 编排前/internal error 边界、followup reenter orchestration、通过统一错误动作队列执行 followup wait | 不再包一层独立 provider retry/error/backoff 语义 |

## 3. 当前剩余遗留问题（继续收口项）

- legacy `providerErrorCenter/providerSuccessCenter` 仍是**物理残留模块**，虽然已降级为 compat adapter，但后续仍应继续物理去除中转角色
- followup 的编排前/internal error 与 provider 执行期错误边界还需继续压实，避免 `SERVERTOOL_*` 语义再次外溢
- provider-switch 日志仍需继续核对，确保不再出现误导性的“下一跳/回退”观感
- Host 边界的 `RouteErrorHub / ErrorHandlingCenter` 文档与调用面还需继续缩小到“外层映射”职责，避免再次被误当策略中心

## 4. 收口验收信号

- followup 与普通请求共用同一套 Router error policy
- 不再存在独立 event bus / error center 中转层
- `RequestExecutor` 只消费 Router decision
- `SERVERTOOL_FOLLOWUP_FAILED` 只保留编排失败语义
- provider-switch 不再出现 `7/6` 之类越界假下一跳

---

## Historical Reference: V2 旧机制（已废止）

> ⚠️ **已废止**：以下内容仅为历史参考，**不得作为当前设计依据**。如与上文冲突，以**上文 Router Policy SSOT** 为准。这些章节将在后续迭代中物理删除。

## H1. 统一流程

1. **HTTP Server / CLI / Pipeline** 捕获异常后调用 `reportRouteError(payload)`，由 `RouteErrorHub` 统筹。
2. `RouteErrorHub` 负责：
   - 归一化错误元数据（requestId、endpoint、providerKey、model 等）。
   - 根据构建模式自动裁剪堆栈：`release` 构建默认移除 stack（可通过 `ROUTECODEX_RELEASE_ERROR_VERBOSE=1` 恢复详细日志）。
   - 将错误交给 `ErrorHandlerRegistry`，触发挂载的处理 Hook（含 429 回退调度、快照写入等）。
   - 可选返回 HTTP 映射结果，确保客户端仅收到统一格式的错误体。
3. （旧）Provider 侧曾在 `emitProviderError` 同时上报 `providerErrorCenter` 与 `ErrorHandlingCenter`。
4. `llmswitch-core` 的 Virtual Router 根据 `ProviderErrorEvent` 执行健康状态变更（回退、降级、拉黑）。

## H2. 错误策略矩阵

| 错误来源 | 状态 / 错误码 | Error Center 处理 | Virtual Router / ProviderHealth 策略 | 说明 |
| --- | --- | --- | --- | --- |
| Provider 客户端错误 | 4xx（排除 429） | 记录并透传，`affectsHealth=false` | 不触发健康计数 | 用户参数错误，可重试但不熔断 |
| Provider 429 限流 | HTTP 429 / `retryable=true` | `rate_limit_error` Hook 启动回退：10s → 30s → 60s 共三次 | BaseProvider 内置 RateLimitTracker：**同一 providerKey（通常为 `provider.key` 或 `provider.key::model` 维度）连续 4 次 429** 会以 `affectsHealth=true` 向 Virtual Router 上报，触发熔断；任意一次成功即清零；不区分 route/routePool | 回退期间可切换同模型 pipeline，必要时返回 429 给客户端 |
| Provider 5xx / 不可恢复 | HTTP ≥ 500、`affectsHealth=true` | 立即触发 `emitProviderError`，带 `fatal=true` | `tripProvider`，按 `fatalCooldownMs` 冷却 | 兼容层错误（stage=compat）同样视为 fatal |
| Host/Server 内部错误 | pipeline/router 抛出的 500 | `RouteErrorHub` 归档并映射 HTTP 500；原始错误号写入 `code` 字段 | 同步 `providerErrorCenter`（若具备 provider 上下文） | 保证 release 输出简单错误号，dev 模式保留堆栈 |
| CLI/工具链错误 | CLI command / debug harness | `reportCliError`（同 `RouteErrorHub`） | 仅记录，不影响路由池 | CLI 运行期错误不触发 provider 熔断 |

> ⚠️ RateLimitTracker 只针对**相同 providerKey（provider.key / provider.key::model）**的连续 429 生效，中间出现成功或其他错误即会自动清零；冷却结束后会再次尝试，具体 TTL 由 `virtualrouter.health` 配置决定，且与使用的 route/routePool 无关。

## H3. 日志与可观测性

- **Release 输出最小化**：`error-center-payload` 会在 release 构建中移除 `stack`、`details.stack`，仅保留 message/code/requestId 等必要字段。若需排查，可在运行时设置 `ROUTECODEX_RELEASE_ERROR_VERBOSE=1`。
- **OAuth 噪音削减**：所有 `[OAuth] ...` 信息级日志默认通过 `ROUTECODEX_OAUTH_DEBUG=1` 才会打印，错误（`console.error`) 仍保持输出。
- **SSE 预览日志禁用**：Server 不再将 SSE chunk 内容写入 `stage-logger`，仅保留流开始/结束事件与统计，避免泄露响应片段。

## H4. 回调挂载点

- `ErrorHandlerRegistry` 默认挂载以下 Hook，可按需扩展：
  - `rate_limit_error`：提供回退调度（切换 pipeline 或延迟重放）。
  - `provider_error`：可注入通知/报警逻辑。
  - 自定义 Hook 通过 `ErrorHandlerRegistry.registerErrorHandler` 挂载，RouteErrorHub 会自动转发。

如需新增策略（例如特定 provider 的 4xx 也触发冷却），建议在 `docs/error-handling-v2.md` 补充矩阵，并在 `virtualrouter.health` 配置中增加自定义参数。

## H5. 工具协议错误（ProviderProtocolError）

ServerTool 与工具调用相关的后端错误统一通过 `ProviderProtocolError` 语义表达。当前 code/category 真源位于
Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_provider_errors.rs`，Host/TS 只允许把
native error plan 投影成客户端可见 `Error` carrier；已删除的
`sharedmodule/llmswitch-core/src/conversion/shared/errors.ts` 不得恢复。

- `ProviderProtocolErrorCode` 目前包含：
  - `TOOL_PROTOCOL_ERROR`：工具调用/结果与 upstream 协议不一致，例如：
    - provider 返回 `finishReason=UNEXPECTED_TOOL_CALL` 但响应中并无有效 tool calls；
    - 工具结果缺少与请求中 tool call 对应的 `tool_outputs`。
  - `SSE_DECODE_ERROR`：SSE → JSON 解码阶段发现非法事件序列或结构。
  - `MALFORMED_RESPONSE`：provider 返回的响应在语义或结构上与声明的协议不符。
  - `MALFORMED_REQUEST`：我们构造的请求违反了目标协议的约束（通常视为开发错误，需要修复代码）。

统一约定：

- **工具相关错误不得静默吞掉**：一旦判定为工具/协议层错误，必须：
  - 在 provider 侧通过 `emitProviderError({ ..., error })` 上报 `providerErrorCenter`；
  - 让错误沿着 `RouteErrorHub → ErrorHandlerRegistry` 流转，最终映射为 HTTP 错误返回客户端；
  - 禁止“返回 200 + 空回答/占位内容”来掩盖错误。
- 在 conversion/compat/codec 层，遇到协议违约时应抛出 `new ProviderProtocolError(message, { code, protocol, providerType, details })`，
  由上游统一捕获与分类，而不是直接 `throw new Error(...)`。

文档规则：若新增一种协议级错误（例如新的 SSE 解析场景或特定 provider 的工具约束），需要同时：

1. 在 Rust `shared_provider_errors.rs` / 对应 Rust owner 中补充新的 `ProviderProtocolErrorCode`（或复用已有 code）；
2. 在此文档补充该错误 code 的含义与触发条件；
3. 确保 provider runtime 捕获到该错误时仍通过 `emitProviderError` 上报，并映射为明确的 HTTP 错误响应。

### H5.1 粗粒度错误类别（EXTERNAL / TOOL / INTERNAL）

为方便统计与路由策略，`ProviderProtocolError` 还暴露一个粗粒度错误类别 `category`：

- `EXTERNAL_ERROR`：外部载荷/协议错误
  - 典型来源：SSE 解析失败（`SSE_DECODE_ERROR`）、上游返回的响应结构不合法（`MALFORMED_RESPONSE`）、
    请求体与协议约束不符（`MALFORMED_REQUEST` 且原因在 provider / 用户输入侧）。
- `TOOL_ERROR`：工具/ServerTool 协议错误
  - 典型来源：工具调用/结果与 contract 不匹配（`TOOL_PROTOCOL_ERROR`）、工具 result 缺失对应 tool_call 等。
- `INTERNAL_ERROR`：内部实现/配置错误
  - 不直接用 `ProviderProtocolErrorCode` 区分，通常由 Host / Hub 在捕获异常时显式设置，用于标记
    我们自己的实现/配置 bug（例如错误拼装 ChatEnvelope、必填字段缺失等）。

约定：

- `ProviderProtocolError.category` 默认会根据 `code` 自动推导：
  - `TOOL_PROTOCOL_ERROR` → `TOOL_ERROR`；
  - 其它（目前为 `SSE_DECODE_ERROR` / `MALFORMED_RESPONSE` / `MALFORMED_REQUEST`）→ 默认 `EXTERNAL_ERROR`。
- 当上层明确知道错误是“内部实现错误”时，可以在构造时显式传入 `category: 'INTERNAL_ERROR'` 覆盖默认推导。
- Host 在将错误映射为 `ProviderErrorEvent` 时，可将 `category` 映射到统一的 `event.code`（例如
  `TOOL_ERROR` / `EXTERNAL_ERROR` / `INTERNAL_ERROR`），而把细粒度 `ProviderProtocolErrorCode` 放入
  `event.details.reason`，从而同时兼顾统计与排障信息。
