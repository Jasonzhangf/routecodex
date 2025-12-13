# RouteCodex V2 错误处理流程（2025）

本页记录当前 V2 的错误中心、上报接口与 Provider 健康策略，方便各模块按照统一方式抛错/观测。

## 1. 核心组件

| 组件 | 作用 |
| --- | --- |
| `RouteErrorHub` (`src/error-handling/route-error-hub.ts`) | 唯一的错误上报入口。负责调用 `ErrorHandlerRegistry`、`ErrorHandlingCenter`、生成标准化 HTTP 响应，并在未初始化时回退到临时中心。 |
| `reportRouteError(payload, options)` | 供所有模块调用的 helper，会自动引导到 Hub；`options.includeHttpResult=true` 时返回 `HttpErrorPayload`。 |
| `ErrorHandlerRegistry` | 保持 hook 机制（429 回退、告警、统计等）；通过 `attachErrorHandlingCenter()` 复用 host 自己的 `ErrorHandlingCenter`。 |
| `ProviderHealthManager` (`src/core/provider-health-manager.ts`) | Host 侧的 Provider 健康状态：429 连续次数、拉黑列表等，供 RequestExecutor/HTTP Handler 在本地拦截。 |

> **注意**：任何模块都不应该直接 `errorHandling.handleError()`，统一使用 `reportRouteError()`。

## 2. Hub 报错流程

1. 构造 `RouteErrorPayload`，包含 `code`、`message`、`scope`、`requestId`、`endpoint`、`providerKey` 等上下文。
2. 调用 `reportRouteError()`：
   - Hub 自动确保 `ErrorHandlerRegistry.initialize()`，执行所有 hook（包括 429 handler）。
   - 将 payload 交给 `ErrorHandlingCenter`。在 release 模式下，`formatErrorForErrorCenter()` 会剥离 stack 等敏感字段，只保留 message/code/requestId。
   - 若 `includeHttpResult=true`，使用 `mapErrorToHttp()` 生成标准化响应（429/4xx/502 等）。
3. Handler 根据返回值写入 HTTP 响应；release 日志只输出简要行，dev 可以看到堆栈。

现有调用点：
- `respondWithPipelineError()`（所有 /v1 接口）
- Express 全局错误中间件
- Provider runtime (`emitProviderError`)
- CLI（`src/index.ts` 中的 `reportCliError`）
- Server runtime (`RouteCodexHttpServer.handleError`)

## 3. Provider 健康策略

Host 引入 `ProviderHealthManager` 以便即刻拦截问题 Provider：

| 触发条件 | 动作 |
| --- | --- |
| 上游返回 400（包含 message/code） | 仅记录，不拉黑。 |
| 上游返回 429：第一次退避 10s、再 30s、60s。若连续 4 次仍 429 | 通过 `block(providerKey, 'rate_limit_exhausted')` 拉黑，阻止继续派单。成功一次即 `resetRateLimit()`。 |
| 上游返回 5xx / 未知错误 | 立即 `block(providerKey, 'upstream_failure')`。 |
| Host 自己的流水线/HTTP handler 映射为 500，且能定位 `providerKey` | 标记为 `host_internal_error`，避免继续发送到可能有问题的 runtime。 |

被拉黑的 Provider 会在下一次 `provider.prepare` 前被检测到并抛出 `ERR_PROVIDER_BLOCKED`；解除的方法是手动调用 `ProviderHealthManager.clear()` 或重载 runtime（重启服务）。

> 上游 breaker（`sharedmodule/llmswitch-core` 中的 `providerErrorCenter`）仍旧存在，此处策略是 Host 侧的第一道拦截，核心熔断逻辑仍由 sharedmodule 统一执行。

## 4. 429 回退逻辑

- 错误被归类为 `rate_limit_error` 时，`ErrorHandlerRegistry` 内建 handler 会：
  1. 尝试切换 pipeline（依赖 llmswitch-core 提供的 hooks）。
  2. 若无可用 pipeline，则按照 schedule `[30000, 60000, 120000]` 退避并重试。
  3. Hub 在 release 模式下只记录一次性文案，dev 日志会输出详细 backoff 信息。
- Provider 健康策略会在第 4 次 429 之后拉黑，避免无限退避。

## 5. Release 与 Dev 日志

- Release 默认打印精简错误（单行 message / code / requestId），stack 等信息被 `formatErrorForErrorCenter()` 去除。
- Dev 模式（`NODE_ENV=development` 或 `ROUTECODEX_STAGE_LOG=1`）会看到 `logPipelineStage`、stack、metadata 等详细内容，便于调试。
- `ProviderHealthManager.block()` 会 `console.warn` 一条 `[ProviderHealth] Blocked providerKey: reason`，如需更安静可在 release 判定下禁用。

## 6. 新增/迁移指引

1. **抛错**：调用 `reportRouteError({ code: 'MY_MODULE_FAIL', scope: 'cli', ... })`。禁止直接 `ErrorHandlingCenter.handleError()`。
2. **HTTP 映射**：若需要具体 HTTP 响应，传 `includeHttpResult: true` 获取 `HttpErrorPayload`。
3. **Provider/Compat**：捕获上游异常后统一调用 `emitProviderError()`，它会代你调用 Hub + `providerErrorCenter`。
4. **文档/配置**：可在 `docs/error-handling-v2.md`（本文）基础上扩展错误矩阵，把 `code → HTTP/status/Severity` 形成 JSON/TS 配置，未来 Hub 可以直接按配置执行动作。
