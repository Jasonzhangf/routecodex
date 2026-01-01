# RouteCodex 错误中心机制（V2）

本页记录当前 RouteCodex V2 的统一错误处理与熔断策略，覆盖 HTTP Server、Hub Pipeline、Provider 以及 Virtual Router 健康管理。所有细节以此为准，后续规则变动需同步更新此文档并在 `AGENTS.md` 追加引用。

## 1. 统一流程

1. **HTTP Server / CLI / Pipeline** 捕获异常后调用 `reportRouteError(payload)`，由 `RouteErrorHub` 统筹。
2. `RouteErrorHub` 负责：
   - 归一化错误元数据（requestId、endpoint、providerKey、model 等）。
   - 根据构建模式自动裁剪堆栈：`release` 构建默认移除 stack（可通过 `ROUTECODEX_RELEASE_ERROR_VERBOSE=1` 恢复详细日志）。
   - 将错误交给 `ErrorHandlerRegistry`，触发挂载的处理 Hook（含 429 回退调度、快照写入等）。
   - 可选返回 HTTP 映射结果，确保客户端仅收到统一格式的错误体。
3. Provider 侧在 `emitProviderError` 同时上报 `providerErrorCenter`（供 Virtual Router 熔断）与 `ErrorHandlingCenter`。
4. `llmswitch-core` 的 Virtual Router 根据 `ProviderErrorEvent` 执行健康状态变更（回退、降级、拉黑）。

## 2. 错误策略矩阵

| 错误来源 | 状态 / 错误码 | Error Center 处理 | Virtual Router / ProviderHealth 策略 | 说明 |
| --- | --- | --- | --- | --- |
| Provider 客户端错误 | 4xx（排除 429） | 记录并透传，`affectsHealth=false` | 不触发健康计数 | 用户参数错误，可重试但不熔断 |
| Provider 429 限流 | HTTP 429 / `retryable=true` | `rate_limit_error` Hook 启动回退：10s → 30s → 60s 共三次 | BaseProvider 内置 RateLimitTracker：同一 provider 连续 4 次 429 会以 `affectsHealth=true` 向 Virtual Router 上报，触发熔断；任意一次成功即清零 | 回退期间可切换同模型 pipeline，必要时返回 429 给客户端 |
| Provider 5xx / 不可恢复 | HTTP ≥ 500、`affectsHealth=true` | 立即触发 `emitProviderError`，带 `fatal=true` | `tripProvider`，按 `fatalCooldownMs` 冷却 | 兼容层错误（stage=compat）同样视为 fatal |
| Host/Server 内部错误 | pipeline/router 抛出的 500 | `RouteErrorHub` 归档并映射 HTTP 500；原始错误号写入 `code` 字段 | 同步 `providerErrorCenter`（若具备 provider 上下文） | 保证 release 输出简单错误号，dev 模式保留堆栈 |
| CLI/工具链错误 | CLI command / debug harness | `reportCliError`（同 `RouteErrorHub`） | 仅记录，不影响路由池 | CLI 运行期错误不触发 provider 熔断 |

> ⚠️ RateLimitTracker 只针对相同 provider 的连续 429 生效，中间出现成功或其他错误即会自动清零；冷却结束后会再次尝试，具体 TTL 由 virtualrouter.health 配置决定。

## 3. 日志与可观测性

- **Release 输出最小化**：`error-center-payload` 会在 release 构建中移除 `stack`、`details.stack`，仅保留 message/code/requestId 等必要字段。若需排查，可在运行时设置 `ROUTECODEX_RELEASE_ERROR_VERBOSE=1`。
- **OAuth 噪音削减**：所有 `[OAuth] ...` 信息级日志默认通过 `ROUTECODEX_OAUTH_DEBUG=1` 才会打印，错误（`console.error`) 仍保持输出。
- **SSE 预览日志禁用**：Server 不再将 SSE chunk 内容写入 `stage-logger`，仅保留流开始/结束事件与统计，避免泄露响应片段。

## 4. 回调挂载点

- `ErrorHandlerRegistry` 默认挂载以下 Hook，可按需扩展：
  - `rate_limit_error`：提供回退调度（切换 pipeline 或延迟重放）。
  - `provider_error`：可注入通知/报警逻辑。
  - 自定义 Hook 通过 `ErrorHandlerRegistry.registerErrorHandler` 挂载，RouteErrorHub 会自动转发。

如需新增策略（例如特定 provider 的 4xx 也触发冷却），建议在 `docs/error-handling-v2.md` 补充矩阵，并在 `virtualrouter.health` 配置中增加自定义参数。

## 5. 工具协议错误（ProviderProtocolError）

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

### 5.1 粗粒度错误类别（EXTERNAL / TOOL / INTERNAL）

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
