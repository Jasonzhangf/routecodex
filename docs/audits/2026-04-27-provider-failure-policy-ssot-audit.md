# 2026-04-27 Provider Failure Policy SSOT 审计

## 索引概要
- L1-L8 `purpose`：审计目标与范围。
- L10-L28 `live-evidence`：线上证据与已确认现象。
- L30-L72 `duplicate-policy-centers`：重复实现清单。
- L74-L103 `active-path-conflicts`：当前 active path 冲突点。
- L105-L126 `migration-target`：每个重复点的迁移去向。
- L128-L139 `next-step`：下一步执行顺序。

## 目的
审计 RouteCodex 当前 provider 执行期错误处理链中所有“第二中心”，确认：
- recoverability
- affectsHealth
- retry/reroute
- backoff

这些事实目前分别由谁定义、哪些属于 active path、哪些会造成线上风暴。

## 线上证据
已确认线上日志同时存在以下现象：

1. **当前请求主链已部分修正**
- `switch=exclude_and_reroute`
- `decision=provider_backoff_then_reroute`
- `backoffScope=provider`

说明 `request-executor` 对 `provider.send` 上的 provider error 必须排除当前 provider 后 reroute；不得再同 provider retry。

2. **并发 sibling 请求仍被毒化**
- 在 recoverable same-provider backoff 之后，仍立即出现多个：
  - `openai-responses-unknown-unknown-*`
  - `PROVIDER_NOT_AVAILABLE`

这证明 storm 的剩余来源不是“当前请求 retry plan”本身，而是**其他 active path 仍在把 provider health/cooldown 打坏**。

## 重复实现清单

### A. request-executor（active path）
文件：`src/server/runtime/http-server/request-executor.ts`

当前承载：
- `resolveRequestExecutorProviderErrorClassification(...)`
- `isHealthNeutralProviderError(...)`
- `resolveProviderRetryEligibilityPlan(...)`
- `resolveProviderRetryExclusionPlan(...)`
- `resolveProviderRetryBackoffPlan(...)`
- `resolveProviderRetryExecutionPlan(...)`

性质：**active path，当前 host 主策略中心**

问题：
- 它已经形成一套完整 policy，但仓内还有别处也在定义同一事实。

### B. provider runtime classifier（active path）
文件：`src/providers/core/runtime/provider-error-classifier.ts`

当前承载：
- `recoverable`
- `affectsHealth`
- `forceFatalRateLimit`

性质：**active path，第二中心**

已确认冲突：
- generic `500`：`recoverable=false`、`affectsHealth=true`
- 短期 `429`：`recoverable=true`、但 `affectsHealth=true`

这与当前全局规则冲突（2026-06-09 修正）：
- recoverable => blocking wait through unified error action queue (`1s -> 2s -> 3s -> repeat`)
- recoverable => health-neutral
- unrecoverable => direct return

### C. provider base-provider emit path（active path）
文件：`src/providers/core/runtime/base-provider.ts`

当前承载：
- 直接消费 `classifyProviderError(...)`
- 直接把 `recoverable/affectsHealth` 写入 `emitProviderError(... stage='provider.http')`

性质：**active path，第二中心的下游发射器**

风险：
- 即使 `request-executor` 已在 `provider.send` 把错误当 recoverable + health-neutral 处理，
  provider runtime 仍可能通过 `provider.http` 路径把 router health 毒化。

### D. provider-error-reporter（active path）
文件：`src/providers/core/utils/provider-error-reporter.ts`

当前承载：
- 当调用方未显式给 `affectsHealth` 时，默认落到 `true`
- 当调用方未显式给 `recoverable` 时，回退到 `err.retryable === true`

性质：**active path，policy fallback 第二中心**

问题：
- reporter 不应再脑补 policy。
- 它应该只透传已决策好的语义，而不是“帮忙猜”。

### E. executor-provider / retry-engine（compat/残留策略点）
文件：
- `src/server/runtime/http-server/executor-provider.ts`
- `src/server/runtime/http-server/executor/retry-engine.ts`

当前承载：
- `shouldRetryProviderError(...)`
- `computeRetryDelayMs(...)`
- `waitBeforeRetry(...)`

性质：**半 active，仍参与 host 决策**

问题：
- “要不要重试”与“退避时间”不应散落为另一套半独立规则。

## 当前 active path 冲突点

### 冲突 1：host 认为 recoverable，provider runtime 认为 fatal/poison
- host `request-executor`：`SQLITE_BUSY / 500 new_api_error` 已改成 recoverable same-provider backoff
- provider runtime classifier：generic 500 仍当 `recoverable=false + affectsHealth=true`

结果：
- 当前请求本身不再 storm
- sibling/fresh 请求仍因 provider health 被旧路径毒化而掉进 `PROVIDER_NOT_AVAILABLE`

### 冲突 2：429 仍有 health 污染
- host 新规则：recoverable 应 health-neutral
- provider runtime 旧规则：短期 429 仍 `affectsHealth=true`

结果：
- 即使局部 backoff 正常，健康状态仍会被 router 看成 provider 不可用，继续制造风暴式旁路失败。

### 冲突 3：reporter 仍有默认脑补
- 若 caller 少传 policy 字段，reporter 仍会回退为 `affectsHealth=true`

结果：
- 即使上游开始收口，也可能被 reporter 再次改坏语义。

## 迁移去向

| 现有点 | 性质 | 迁移去向 |
| --- | --- | --- |
| `request-executor` classification/backoff/exclusion helpers | active | 收进单一 `ProviderFailurePolicy`，executor 只执行 decision |
| `provider-error-classifier.ts` | active second center | 降为 thin adapter 或删除 |
| `base-provider.ts` 的 `recoverable/affectsHealth` 自产逻辑 | active second center consumer | 改成只上报 transport/context 原始事实 |
| `provider-error-reporter.ts` 默认 `affectsHealth/recoverable` fallback | active second center | 改成 fail-closed：缺字段即调用方 bug |
| `executor-provider.ts` retry/backoff helpers | compat/半 active | 仅保留 sleep primitive，不再定义 policy |

## 下一步
1. 完成 `286.1`：以本审计为基础补充 owner / active / migration map。
2. 进入 `286.2`：抽单一 `ProviderFailurePolicy`。
3. 进入 `286.3`：`request-executor` 去脑化。
4. 进入 `286.4`：收掉 provider runtime classifier + reporter fallback。
5. 最后 `286.5`：build/install/restart/live verify。
