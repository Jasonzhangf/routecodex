# Provider Failure Policy SSOT 设计

## 索引概要
- L1-L8 `purpose`：本设计文档的目标与适用范围。
- L10-L31 `single-cognition`：唯一认知理念（什么是唯一真源、什么是第二中心）。
- L33-L58 `current-audit`：当前已确认的分裂实现与风险。
- L60-L101 `target-architecture`：目标架构与唯一职责分配。
- L103-L131 `execution-rules`：执行期硬规则（retry/backoff/health/direct return）。
- L133-L170 `migration-plan`：分阶段迁移计划。
- L172-L189 `acceptance`：验收信号。

## 目的
本设计用于收口 **provider 执行期错误处理 / retry / reroute / backoff / health 影响** 的唯一真源。

适用范围：
- `request-executor`
- `provider-error-classifier`
- `provider-error-reporter`
- `provider-traffic-governor`
- `Virtual Router policy` 消费链

不适用范围：
- 业务 payload 语义转换
- tool harvest / chat-process 语义
- 非 provider 执行期的 CLI / HTTP 外层错误映射

## 唯一认知理念

### 1. 一份事实只能有一个 owner
对于 provider 执行期错误，以下事实只能各有一个真源：
- 这是不是 **recoverable**
- 这是否 **affectsHealth**
- 这次应该 **direct return / same-provider backoff / explicit reroute**
- 这次 backoff 的 **scope / key / duration**

如果这些事实分别由 `request-executor`、`provider runtime`、`error reporter`、`router` 各自推一次，系统就一定漂移。

### 2. emit 不是 policy
`emitProviderError(...)`、event bus、registry、center 这类模块只负责 **传输事件**，不负责定义 retry/reroute/backoff/fail 语义。

谁负责做 policy，谁才是真源；
只做 `emit/forward/normalize` 的层，不能再偷偷夹带第二份判断。

### 3. orchestrator 不能自带第二大脑
`RequestExecutor` 允许负责：
- 执行 sleep / wait / retry loop
- 调 provider
- 记录 telemetry

但不允许再独立决定：
- recoverable / unrecoverable / special_400 / periodic_recovery
- affectsHealth
- should exclude current provider
- should reroute

否则它就不是 orchestration shell，而是第二个 policy center。

### 4. classification 是第一分叉，不是附属字段
全局先问：**错误属于哪一类**。

然后再决定：
- unrecoverable → 直接返回
- special_400 → 直接投影 4xx，不进入 provider retry/reroute
- recoverable → 阻塞 + 指数 backoff
- periodic_recovery → 进入 quota/cooldown/VR health 周期恢复链

禁止先做“切 provider 试试”，再回头补 recoverable 判定。

### 5. health 是 policy 投影，不是 transport 猜测
provider health 只能来源于统一 policy 计算结果。
provider transport / converter / reporter 不得再根据自己看到的局部信息直接推导 health 影响。

## 当前审计结论
已确认当前仍存在多处第二中心：

1. **错误分类双真源**
- `src/server/runtime/http-server/request-executor.ts`
- `src/providers/core/runtime/provider-error-classifier.ts`

2. **retry/backoff 决策双真源**
- `src/server/runtime/http-server/executor-provider.ts`
- `src/server/runtime/http-server/request-executor.ts`

3. **health 影响双真源**
- `request-executor.ts -> isHealthNeutralProviderError(...)`
- `provider-error-classifier.ts -> affectsHealth`
- `provider-error-reporter.ts` 还有默认兜底口径

4. **等待/阻塞分裂**
- recoverable backoff gate
- provider transport backoff gate
- provider traffic governor concurrency wait

其中流量并发闸门可独立存在，但“错误后的阻塞等待策略”必须统一由 failure policy 产出，而不是多个调用点各自算。

## 目标架构

```text
provider/runtime/send/convert/direct error
  -> ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

`ProviderFailurePolicy` 只允许挂在 `ErrorErr03RuntimeClassified` 分类与 `ErrorErr04RouterPolicyApplied` policy projection 之间；`RequestExecutor` 只能消费 `ErrorErr05ExecutionDecision` 执行 wait / retry / direct return；`ProviderErrorReporter` 只能组装/转发 `ErrorErr02HostCaptured`。

### 单一模块职责
新增唯一策略块：`ProviderFailurePolicy`

它是唯一允许回答以下问题的地方：
1. `classification`: `special_400 | recoverable | unrecoverable | periodic_recovery`
2. `affectsHealth`: `true | false`
3. `action`:
   - `direct_return`
   - `retry_same_provider`
   - `reroute_explicit_alternative`
4. `backoff`:
   - `none`
   - `attempt`
   - `recoverable`
   - `provider`
   - 带 `key/base/max/ms`

### 各层改造后职责

| 层 | 允许做什么 | 禁止做什么 |
| --- | --- | --- |
| `ProviderFailurePolicy` | classify / decide / backoff-plan / health-impact | 执行真实 sleep / 发请求 |
| `RequestExecutor` | 调 policy，执行 wait/retry loop，打日志 | 另写一份 classification / exclusion / health 逻辑 |
| `provider-error-classifier` | 删除或降为 thin adapter | 自己独立决定 recoverable/health |
| `provider-error-reporter` | 只转发已决定的 recoverable/affectsHealth/details | 自己补默认 policy |
| `Virtual Router policy consumer` | 消费统一事件，更新健康/冷却投影 | 反向猜 host/provider 本应如何 retry |

## 执行期硬规则

### Rule 1: 不可恢复错误
- 直接返回 HTTP 错误
- 不 retry
- 不 reroute
- 不高频重放

### Rule 2: 可恢复错误
- 只能 **block + 指数 backoff**
- 默认 `retry_same_provider`
- 不能先 exclude 当前 provider 再制造 `PROVIDER_NOT_AVAILABLE`

### Rule 3: reroute 不是默认恢复手段
只有在 **policy 明确证明存在显式替代候选** 且属于允许 reroute 的语义时，才允许 `reroute_explicit_alternative`。

没有证据，就不能把 reroute 当“试试看”。

### Rule 4: recoverable 默认 health-neutral
只要是 recoverable provider 执行期错误，默认不毒化 provider health。

### Rule 5: reporter 不得二次脑补
`emitProviderError(...)` 的输入必须已经带上明确的：
- `recoverable`
- `affectsHealth`
- `classification`
- `stage`

reporter 只能透传，不得 fallback 成另一套语义。

## 迁移计划

### Phase A：审计定稿
- 盘点所有 recoverable / affectsHealth / shouldRetry / exclude / backoff 实现点
- 标记 active path / compat shell / dead residue
- 文档化迁移边界

### Phase B：抽单一策略块
- 新建 `ProviderFailurePolicy`
- 收入口：
  - classification
  - health impact
  - retry action
  - backoff plan
- 为策略块补单测

### Phase C：Host 执行器去脑化
- `request-executor.ts` 改成只：
  - 调 policy
  - 执行 decision
  - 记录 telemetry
- 删除本地重复 helper

### Phase D：Provider runtime 去脑化
- `provider-error-classifier.ts` 降级或删除
- `base-provider.ts` / `responses-provider.ts` 不再自产 recoverable/health 语义
- provider 层仅上报 transport/context 原始事实

### Phase E：Reporter 去默认语义
- `provider-error-reporter.ts` 不再自己推断 `affectsHealth=true`
- 缺少明确 policy 字段时直接视为调用方 bug，而不是帮忙兜底

### Phase F：回归与在线验证
- TypeScript 编译
- request-executor / error-reporting / traffic governor 定向回归
- 构建、安装、重启、真实请求验证

## 验收信号
1. 仓内只剩一个地方能定义 recoverability。
2. 仓内只剩一个地方能定义 affectsHealth。
3. `request-executor` 不再保留独立 exclusion/backoff/health 判定 helper。
4. `provider-error-reporter` 不再含 policy fallback 语义。
5. 429 / `fetch failed` / `SQLITE_BUSY` / 5xx 不再触发 storm / `PROVIDER_NOT_AVAILABLE` 连锁。
6. 在线日志里 recoverable 错误统一表现为：
   - `switch=retry_same_provider`
   - `decision=recoverable_backoff_same_provider` 或 `provider_backoff_same_provider`
   - 无匿名风暴式 sibling 冲击。
