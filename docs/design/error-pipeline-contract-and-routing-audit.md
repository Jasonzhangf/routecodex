# Error Pipeline Contract and Routing Audit

本文定义 RouteCodex 错误处理链的唯一接口契约，并审计当前实现中违反“处理模块唯一、调用都路由到唯一模块”的位置。目标不是在各调用点补丁式修错，而是把所有 provider/runtime/direct/executor 错误强制进入同一条 `Error*` 链，禁止多处实现、旁路实现、同义决策实现。

## 1. 总原则

1. 错误处理必须按 `ErrorErrNNNode` 拓扑命名，与请求/响应链同级管理。
2. 每个错误节点只能有一个 owning module；其它模块只能调用 owning module，不得重新实现同义逻辑。
3. provider/runtime/send/convert/direct/followup 错误都必须进入统一错误链；`router-direct` 不是错误处理旁路。
4. `RequestExecutor`、`router-direct-pipeline`、provider runtime 只能做 error source/caller；不得自己定义 retry/reroute/cooldown/health 语义。
5. `ErrorHandlingCenter` 只负责 HTTP/server/client-facing projection；不得参与 provider policy，也不得承载 recoverable / cooldown / reroute 决策。
6. 错误不是 fallback：错误链可以产生 retry/reroute/cooldown decision，但不能吞错成成功 truth。

## 2. 标准错误链

```text
ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

| 节点 | 唯一职责 | 当前 owning module | 禁止事项 |
|---|---|---|---|
| `ErrorErr01SourceRaised` | 源头只产生原始 error + stage marker | provider runtime / direct / executor source | 源头自行判定 retry/cooldown |
| `ErrorErr02HostCaptured` | 组装 provider error event carrier | `src/providers/core/utils/provider-error-reporter.ts` | 各调用点手拼 event / 多套 marker |
| `ErrorErr03RuntimeClassified` | 归一 code/status/classification（`recoverable | unrecoverable | special_400`） | `src/providers/core/runtime/provider-error-catalog.ts` + `provider-failure-policy*` | message-only 分叉、局部分类器 |
| `ErrorErr04RouterPolicyApplied` | 写入 VR health/quota/cooldown/policy state | `sharedmodule/.../virtual_router_engine/engine/events.rs` + `health.rs` | executor/direct 自己维护 provider health |
| `ErrorErr05ExecutionDecision` | 消费 router policy 输出并执行 retry/reroute/fail | `RequestExecutor` / future direct consumer | 自己重新决策 provider 池切换 |
| `ErrorErr06ClientProjected` | 投影 HTTP/client 错误响应 | handler response utils / ErrorHandlingCenter | 回写 provider policy / 修补请求 payload / 反推分类 |

## 3. 当前已存在的错误入口

### 3.1 Provider runtime 主入口

```text
provider runtime error
  -> emitProviderError / emitProviderErrorAndWait
  -> reportProviderErrorToRouterPolicy
  -> routerEngine.handleProviderError
  -> Rust handle_provider_error
```

当前入口文件：

- `src/providers/core/utils/provider-error-reporter.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_runtime_ingress.rs`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/events.rs`

### 3.2 RequestExecutor 错误入口

```text
provider.runtime_resolve / provider.send / provider.http / provider.sse_decode
  -> resolveRequestExecutorProviderFailurePlan
  -> reportRequestExecutorProviderError
  -> emitProviderErrorAndWait
  -> reportProviderErrorToRouterPolicy
```

当前入口文件：

- `src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-resolve-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-response.ts`

### 3.3 Router Direct 当前旁路

现场 502 复现 stack：

```text
ResponsesProvider.sendDirectSsePassthroughRequest
  -> ResponsesProvider.processIncomingDirect
  -> executeRouterDirectPipeline
  -> executeRouterDirectPipelineForPort
  -> handleResponses
```

问题：`router-direct` 当前只负责 direct passthrough + snapshot/log，不进入 `ErrorErr02HostCaptured`。因此 direct 502 没有 provider error event、没有 VR health 记账、下一个 request 仍可命中同一 provider。

涉及文件：

- `src/server/runtime/http-server/router-direct-pipeline.ts`
- `src/server/runtime/http-server/index.ts`
- `src/providers/core/runtime/responses-provider.ts`

## 4. 当前违规点

### V1. `router-direct` 错误没有路由到唯一错误模块

- 现象：direct 502 连续命中同一 provider，日志无 `[provider-switch]`。
- 证据：diag stack 指向 `executeRouterDirectPipeline`，不是 `RequestExecutor.processProviderSendFailure`。
- 违规：direct path 绕过 `provider-error-reporter.ts`，没有进入 `ErrorErr02HostCaptured -> ErrorErr04RouterPolicyApplied`。
- 修复方向：`router-direct` catch 只能调用唯一错误入口，不能本地写 health/cooldown。

### V2. `handle_provider_failure` 与 `handle_provider_error` 形成双入口语义

- 现象：Rust native proxy 同时暴露 `handleProviderFailure` 与 `handleProviderError`。
- 风险：两个入口可能对 502/503/recoverable 使用不同状态机。
- 违规：`ErrorErr04RouterPolicyApplied` 不是单入口。
- 修复方向：保留一个 public policy entrypoint；旧入口只能薄壳转发，禁止自带状态机。

### V3. RequestExecutor 内仍有 retry/reroute policy 语义

- 现状：`request-executor-retry-decision.ts`、`request-executor-retry-execution-plan.ts` 仍在本地判断 exclude/reroute/backoff。
- 风险：与 Virtual Router policy 形成第二决策中心。
- 修复方向：中期把这些文件降级为 `ErrorErr05ExecutionDecision` consumer，只执行 Router policy decision，不再分类。

### V4. 错误 stage marker 分散

- 现状：`requestExecutorProviderErrorStage` 在 SSE、converter、followup、provider response 等多个源头写入。
- 风险：新增路径忘记 marker 后退回 message/status 推断。
- 修复方向：源头只能写 `ErrorErr01SourceRaised` 最小 marker；stage normalize 只能在 `ErrorErr02HostCaptured` owning module 做。

### V5. HTTP client / direct provider response 抛错未统一 capture

- 现状：direct provider transport 抛出的 HTTP 502 到 handler 前没有统一 capture。
- 风险：client projection 有错误日志，但 router policy 无状态。
- 修复方向：所有 provider transport caller 必须包一层 `capture_provider_error_for_router_policy(...)` 或等价唯一 wrapper。

## 5. 目标模块划分

### 5.1 新增/收口模块建议

| 目标模块 | 责任 | 迁移来源 |
|---|---|---|
| `provider-error-source.ts` | `ErrorErr01SourceRaised` marker helpers | scattered stage marker writes |
| `provider-error-capture.ts` | `ErrorErr02HostCaptured` event builder + report call | `provider-error-reporter.ts` |
| `provider-error-classify.ts` | `ErrorErr03RuntimeClassified` TS facade | `provider-error-catalog.ts` / `provider-failure-policy*` |
| Rust `virtual_router_engine/error_policy` | `ErrorErr04RouterPolicyApplied` | `events.rs` / `health.rs` |
| `provider-error-decision-consumer.ts` | `ErrorErr05ExecutionDecision` execution-only helpers | executor retry files |

现阶段不必一次迁移文件名；先建立 contract doc + red tests，再逐步把调用点迁入唯一 wrapper。

### 5.2 唯一调用规则

允许调用：

```text
capture_provider_error_for_router_policy(ErrorErr01SourceRaised) -> ErrorErr02HostCaptured
reportProviderErrorToRouterPolicy(ErrorErr02HostCaptured) -> ErrorErr04RouterPolicyApplied
consume_router_policy_decision(ErrorErr04RouterPolicyApplied) -> ErrorErr05ExecutionDecision
```

禁止调用：

```text
routerDirectCatch -> health_manager.record_*
requestExecutorCatch -> reportProviderErrorToRouterPolicy(raw ad-hoc object)
providerRuntime -> resolveProviderRetryExecutionPlan
handlerResponse -> cooldown_provider
```

## 6. 修复清单路径

### Phase E1：错误链文档和红测锁边界

1. 文档：本文。
2. 红测：扫描 direct path 中 provider error catch 必须调用唯一 capture wrapper。
3. 红测：扫描 `reportProviderErrorToRouterPolicy({ ... })` 只允许出现在 capture module / tests / bridge ingress。
4. 红测：扫描 `handleProviderFailure` public usage，要求只转发到 `handleProviderError` 或被物理删除。
5. 红测：扫描 executor retry files 不得新增 status/message 分类分支。

### Phase E2：direct path 接入唯一错误入口

1. 在 `router-direct` provider call 周围只接入 `ErrorErr02HostCaptured` wrapper。
2. direct 失败仍原样抛给 client；只增加 router policy event。
3. live 验证：一次 direct 502 后 provider health 计数变化；连续三次后下一 request 不再命中同 provider。

### Phase E3：Rust policy 单入口

1. `handle_provider_failure` 变为 deprecated thin shell 或删除。
2. `handle_provider_error` 成为唯一 `ErrorErr04RouterPolicyApplied` entrypoint。
3. 502/503/429/recoverable/unrecoverable tests 全部只打唯一入口。

### Phase E4：executor retry 降级为 consumer

1. `resolveProviderRetryExecutionPlan` 不再分类错误，只消费 Router policy decision。
2. `request-executor-retry-decision.ts` 中 status/code 分类逐步迁出。
3. `RequestExecutor` 只执行 `exclude current` / `retry same` / `fail` / `wait`。

### Phase E5：物理删除重复实现

1. 删除 legacy duplicate classifier / fallback 推断。
2. 删除非唯一 event builder。
3. 删除 direct/provider 特有 health mutation。
4. 更新 AGENTS 和 skill：错误链只能改 owning module。

## 7. 红测验收

必须有测试覆盖：

1. direct 502 进入 provider error reporter，不允许只落 client error diag。
2. direct 502 不改变 direct payload，不做 fallback 成功。
3. direct 502 三次后 VR health 使该 provider 不可选；池内/下级池/default 由 VR 选择。
4. `handleProviderFailure` 不可承载独立语义。
5. executor/direct/provider runtime 所有 provider error 上报调用都收口到同一 capture module。
6. `ErrorHandlingCenter` 不得出现在 provider policy decision 依赖链中。

## 8. 当前结论

当前错误链目标文档已有 `Virtual Router policy` 作为策略真源，但实现还没有被类型/模块边界锁死。`router-direct` 是这次 502 死打 provider 的关键旁路：它不是请求/响应 payload 问题，而是错误事件没有进入唯一 policy 链。下一步应先做 Phase E1 红测，再做 Phase E2 direct 接入唯一错误入口；不要在 direct path 本地写 cooldown，也不要在 executor 里继续扩展第二套 retry policy。
