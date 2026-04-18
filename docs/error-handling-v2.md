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
- **stopless 静默停已加硬校验**
  - 若 `stopless=on/endless` 且响应完成时缺少 `reasoning.stop` finalized marker，直接抛 `STOPLESS_FINALIZATION_MISSING`（502、retryable）
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
   - `retry_same_provider`
   - `exclude_and_reroute`
   - `wait_for_cooldown`
   - `fail`
3. **RequestExecutor** 消费该 decision 并执行实际 retry / reroute / sleep / fail。
4. **servertool followup** 的 provider 类错误也走同一套 Router policy；只有 payload 缺失、reenter 不可用、client inject dispatcher 缺失等编排前/internal error 保留在 servertool 自身边界。

## 2. 分层职责

| 层 | 职责 | 不该做什么 |
| --- | --- | --- |
| HubPipeline | request/chat-process 编排、标准化、向上抛错 | 不定义最终 retry/reroute/backoff 策略 |
| Virtual Router policy | 错误分类、路由/冷却/健康/额度策略、统一 decision 输出 | 不负责具体 sleep/retry 执行循环 |
| RequestExecutor | 执行 Router decision、驱动 provider runtime/send/convert | 不再独立发明第二套 error policy |
| servertool engine | followup 编排前/internal error 边界、followup reenter orchestration | 不再包一层独立 provider retry/error 语义 |

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

## Historical Reference: V2 旧机制（待迁出/待删除）

以下内容保留为历史参考，帮助识别旧实现；如与上文冲突，以**上文 Router Policy SSOT** 为准。

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

ServerTool 与工具调用相关的后端错误统一通过 `ProviderProtocolError` 表达，类型定义位于
`sharedmodule/llmswitch-core/src/conversion/shared/errors.ts`。

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

1. 在 `errors.ts` 中补充新的 `ProviderProtocolErrorCode`（或复用已有 code）；
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
