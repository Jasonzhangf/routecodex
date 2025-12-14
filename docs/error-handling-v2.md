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
