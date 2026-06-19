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
- 这次 backoff 的 **category / scope key**；duration 只能来自统一错误动作队列

如果这些事实分别由 `request-executor`、`provider runtime`、`error reporter`、`router` 各自推一次，系统就一定漂移。

新增边界：
- provider `availability/quota/upstream transport` 错误属于 **provider/server truth**；
- session/local deterministic bad state 属于 **session truth**；
- 两者禁止混写同一 ledger，禁止一份 provider 错误同时推进 provider cooldown/exclusion 与 session storm backoff。

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
- recoverable → 阻塞 + 统一错误动作队列 backoff
- periodic_recovery → 进入 quota/cooldown/VR health 周期恢复链

禁止先做“切 provider 试试”，再回头补 recoverable 判定。

此前文档默认把 `router-direct` / `provider-direct` 视为“passthrough + hooks only”边界；这对 payload/response 是成立的，但对 provider 执行期错误不成立。

Jason 当前确认的产品中心原则：

- 只要当前 route pool（以及产品允许的下一阶段 secondary/default pool）仍有候选 provider，provider 执行期错误就不应直接中断对话；
- 应先进入统一策略中心，完成计数、冷却投影、排除当前 provider、切换下一候选；
- 只有候选全部耗尽时，才允许错误投影到客户端。

据此新增硬规则：

1. `router-direct` / `provider-direct` 可以保留 request/response payload passthrough；
2. 但 provider `send/processIncomingDirect` 错误不得再 `report-only then rethrow`；
3. direct consumer 也必须消费 `ErrorErr05ExecutionDecision`，直到候选耗尽；
4. Host 不得把“主池空时切 default”做成本地 fallback；若产品需要该能力，必须在 VR policy / route contract 中显式建模。

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

其中流量并发闸门可独立存在，但“错误后的阻塞等待策略”必须统一进入 error action queue，而不是多个调用点各自算。

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
   - `reroute_explicit_alternative`
4. `backoff`:
   - `none`
   - `attempt`
   - `recoverable`
   - `provider`
   - 带 `category/scopeKey`；真实等待固定由 error action queue 执行 `1s -> 2s -> 3s -> repeat`

### 各层改造后职责

| 层 | 允许做什么 | 禁止做什么 |
| --- | --- | --- |
| `ProviderFailurePolicy` | classify / decide / backoff category/scope / health-impact | 执行真实 sleep / 发请求 / 计算 env/exponential backoff |
| `RequestExecutor` | 调 policy，通过统一 error action queue 执行 blocking wait/retry loop，打日志 | 另写一份 classification / exclusion / health/backoff 配置 |
| `provider-error-classifier` | 删除或降为 thin adapter | 自己独立决定 recoverable/health |
| `provider-error-reporter` | 只转发已决定的 recoverable/affectsHealth/details | 自己补默认 policy |
| `Virtual Router policy consumer` | 消费统一事件，更新健康/冷却投影 | 反向猜 host/provider 本应如何 retry |

## 执行期硬规则

### Rule 1: 不可恢复错误
- 直接返回 HTTP 错误
- 不 retry
- 不 reroute
- 不高频重放

补充边界：只有在当前合法候选集合已经耗尽时，才允许 direct return。若仍有 route-pool / VR 明确允许的 secondary pool 候选，则必须继续走统一策略，不得直接 client-visible。

### Rule 2: 可恢复错误
- 必须先进入统一错误动作队列做 blocking wait，等待序列固定 `1s -> 2s -> 3s -> repeat`
- 等待后按 Router policy / executor decision 执行：容量类错误显式 reroute 到未排除候选；普通 recoverable transport/5xx 可 same-provider retry 一次，重复后 reroute
- 如果没有未排除候选，必须 fail-fast 返回最后一个 provider error
- 禁止同请求内等待 provider 冷却、无限重打同 provider，或恢复 env/exponential/Retry-After 分散 backoff

### Rule 3: reroute 是唯一恢复执行动作
容量类错误只允许 `reroute_explicit_alternative`；普通 recoverable transport/5xx 只允许一次 same-provider blocking retry，重复失败必须 reroute 或 fail-fast。无候选时不能通过等待 provider 冷却或 `PROVIDER_NOT_AVAILABLE` 循环伪造恢复。防风暴等待只属于统一 error action queue，不是 provider 成功兜底。

补充边界：`router-direct` / `provider-direct` 不得因为“是 direct path”就绕过这条规则。direct path 可以直通 payload，但错误恢复动作仍必须遵守同一条 reroute/exhaustion contract。

### Rule 4: recoverable 默认 health-neutral
只要是 recoverable provider 执行期错误，默认不毒化 provider health。

补充边界：`client_disconnect`（包括 upstream `HTTP_499` + `client abort request` / `client closed request`）比 recoverable 更弱，必须视为非 provider failure：不计 health、不计 cooldown、不进入 provider-visible client projection。

### Rule 5: reporter 不得二次脑补
`emitProviderError(...)` 的输入必须已经带上明确的：
- `recoverable`
- `affectsHealth`
- `classification`
- `stage`

reporter 只能透传，不得 fallback 成另一套语义。

### Rule 6: backoff 动作唯一队列
- 统一 owner：`src/server/runtime/http-server/executor/request-executor-error-action-queue.ts`
- category 固定：`global_error` / `session_storm` / `provider_recoverable` / `provider_transport` / `provider_traffic_saturated` / `servertool_followup`
- delay 固定：`1s -> 2s -> 3s` 循环
- 等待固定：blocking wait + category/scope gate
- hooks 固定：`record` / `wait_start` / `wait_end`
- 禁止：`softWaitTimeoutMs`、本地 waiter queue、jitter、Retry-After、指数退避、env backoff 常量

### Rule 6.1: provider availability 错误不得进入 session_storm
以下错误默认属于 provider/server truth，只能推进 provider/router policy，不得写 `session_storm`：
- `429 / 502 / 503 / 504`
- `fetch failed` / upstream timeout / network transport errors
- `PROVIDER_NOT_AVAILABLE` / `ERR_NO_PROVIDER_TARGET`
- upstream busy/cooldown/quota/provider unavailable 及其等价归一错误

这些错误允许进入的 action category 仅限：
- `provider_recoverable`
- `provider_transport`
- `provider_traffic_saturated`
- 或 Router/VR health/cooldown 侧的 provider/server truth

禁止行为：
- 因 provider availability 错误对 `sessionId/conversationId/workdir/daemon/clientType/anonymous` 建 session storm cooldown
- 让不同 session 因同一 provider availability 事实产生分裂真相
- 在 provider pool 尚有候选时，先被 session storm gate 阻塞，覆盖 provider failover/default pool mainline

### Rule 6.2: session_storm 只允许 session-local deterministic bad state
`session_storm` 只允许承载当前 session/conversation 自身的 deterministic bad state，例如：
- invalid client tool args
- broken continuation / malformed session-local replay payload
- fixed malformed followup/bootstrap state
- 明确证明“换 provider 也不会好”的当前会话污染

判定规则：
- 若错误本质是 provider availability / upstream capacity / provider transport，不得进入 `session_storm`
- 若错误本质是当前 session 自己的 deterministic invalid state，才允许进入 `session_storm`
- `session_storm` 不得承担 provider health、provider cooldown、provider exclusion、default-pool fallback 的任何语义

### Rule 7: provider traffic saturation
- 并发/RPM 满时，先释放 traffic state lock，再通过 `provider_traffic_saturated` 队列 blocking wait 一次。
- 醒后重查；仍满则抛 `ProviderTrafficSaturatedError`，由上层错误链/Virtual Router 切 provider。
- priority mode 不允许因为当前 provider 优先级最高就绕过切换或无限等待。

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

### Phase C.1：session_storm 语义去污染
- `request-executor-session-storm-backoff.ts` 只保留 session-local deterministic error contract
- 物理删除 provider availability / transport / busy / pool exhaustion 进入 `session_storm` 的判定
- `request-executor-provider-send-failure.ts` 不得再把 provider recoverable error 写进 session scope
- 先锁红测再删除旧判定

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

新增验收：
1. 同端口同 provider 池下，一个 session 连续 provider availability 错误，不得单独污染另一个 session 的 provider truth，也不得把本 session 错误会话化成 `session_storm`。
2. `429 / 503 / fetch failed / PROVIDER_NOT_AVAILABLE` 黑盒验证不得命中 `session_storm` 记录。
3. provider pool mainline 必须先执行 provider failover / pool exhaustion / default-pool decision，再决定是否 client-visible；`session_storm` 不得抢先拦截这条主线。
1. 仓内只剩一个地方能定义 recoverability。
2. 仓内只剩一个地方能定义 affectsHealth。
3. `request-executor` 不再保留独立 exclusion/backoff/health 判定 helper。
4. `provider-error-reporter` 不再含 policy fallback 语义。
5. 429 / `fetch failed` / `SQLITE_BUSY` / 5xx 不再触发 storm / `PROVIDER_NOT_AVAILABLE` 连锁。
6. 在线日志里 recoverable 错误统一表现为：
   - `switch=exclude_and_reroute`
   - `decision=provider_backoff_then_reroute`
   - 无匿名风暴式 sibling 冲击。
