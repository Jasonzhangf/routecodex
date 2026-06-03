# Servertool Flow / Skeleton 重构设计（functions + blocks + config-only orchestration）

## 目标

把当前 servertool 收敛为：

```text
functions -> blocks -> orchestration
```

并满足三个硬要求：

1. **flow 先梳清楚**：所有 flow 的触发、命运分支、状态约束有单表真源。
2. **每个 flow 的执行方式配置化**：client inject / reenter / skip 等 outcome 必须来自 skeleton/profile，不允许在编排层写死。
3. **编排层不做业务逻辑**：orchestration 只串 block，不再做 flow-specific if/else。

---

## 当前已确认的 flow 真相

### A. flowId 来源（handler 真相）

当前 flowId 主要由 handler 产出：

- `stop_message_flow`
- `continue_execution_flow`
- `web_search_flow`
- `vision_flow`
- `apply_patch_read_before_retry_guard`
- `exec_command_guard`
- `recursive_detection_guard`
- 另外测试中还出现：
  - `review_flow`
  - `reasoning_stop_guard_flow`
  - `reasoning_stop_finalize_flow`

这些是**业务 flow 真名**，应被视为 skeleton/profile 的 key，而不是 TS 编排层随手分支的条件。

### B. flow policy 真源

当前 followup policy 的单点真源已经基本存在：

- TS 壳：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/followup-flow-policy.ts`
- Rust 真源：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`

Rust `plan_servertool_followup_runtime_json(flow_id)` 已能输出：

- `outcomeMode`
- `noFollowup`
- `autoLimit`
- `flowOnlyLoopLimit`
- `providerPinRemoved`
- `clientInjectOnly`
- `seedLoopPayload`
- `retryEmptyFollowupOnce`
- `clientInjectSource`
- `transparentReplayRequestSuffix`
- `ignoreRequiresActionFollowup`
- `contextDecorationMode`

这说明：**flow -> outcome plan 的配置化基础已经有了**。

---

## 当前 flow map（按已验证配置）

| flowId | trigger 来源 | 当前配置真源 | 期望 outcome 真相 | 当前是否仍被 TS 硬编码污染 |
|---|---|---|---|---|
| `stop_message_flow` | auto hook | Rust skeleton profile | servertool `reenter`；bounded by `used/max_repeats` | 否（2026-06-03 修正） |
| `continue_execution_flow` | tool call | Rust skeleton profile | `reenter` | 否 |
| `web_search_flow` | tool call / auto inject | Rust skeleton profile | `reenter` + summary decorate | 否 |
| `vision_flow` | tool/backend | Rust skeleton profile 缺显式 outcome，仅 context mode | 依实现而定 | 轻微 |
| `apply_patch_guard` | guard | Rust skeleton profile | `reenter` + autoLimit | 否 |
| `apply_patch_read_before_retry_guard` | guard | Rust skeleton profile | `reenter` | 否 |
| `exec_command_guard` | guard | Rust skeleton profile | `reenter` + autoLimit | 否 |
| `recursive_detection_guard` | auto hook | Rust skeleton profile 不完整 | 需要统一定义 | 轻微 |
| `review_flow` | tool call | 目前更多靠 handler 结果 | 应补进 skeleton profile | **缺口** |
| `reasoning_stop_guard_flow` | auto/tool | 目前更多靠 handler 结果 | 应补进 skeleton profile | **缺口** |
| `reasoning_stop_finalize_flow` | finalize 路径 | 目前更多靠 handler 结果 | 应补进 skeleton profile | **缺口** |

结论：

1. **flow profile 真源已经有 70%**，但还没全量覆盖。
2. 缺口不是“没有配置能力”，而是**部分 flow 还没搬进 skeleton**。
3. 更严重的问题是：**TS orchestration 仍然保留第二语义面**。

---

## 当前违反“config-only orchestration”的点

### 1. `followup-runtime-block.ts` 仍有 flow-specific 真相硬编码

文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.ts`

已确认越界点：

```ts
if (injectSource === 'servertool.stopless_goal_continue') {
  return 'reenter';
}
if (args.flowId === 'stop_message_flow') {
  return 'client_inject_only';
}
```

问题：
- `stop_message_flow -> reenter` 不该在 TS block 里硬编码。
- 这本质是 **flow profile 决策**，必须来自 skeleton config。
- 当前相当于 profile 里一份，TS block 又写一份，形成**双真源**。

### 2. `applyClientInjectOnlyMetadata(...)` 仍把 stop_message 作为特殊流内建

文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.ts`

已确认越界点：

```ts
if ((args.flowId !== 'stop_message_flow' && !decision.clientInjectOnly) || ...)
```

问题：
- 是否强制 client inject 应由 `decision.clientInjectOnly` 决定。
- 编排 block 不应再知道 `stop_message_flow` 这个业务名。

### 3. `followup-mainline-block.ts` 仍混有 flow-specific 行为编排

文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/followup-mainline-block.ts`

当前仍有以下越界：
- `const isStopMessageFlow = args.execution.flowId === 'stop_message_flow'`
- stop loop warning 注入、stop-only disable state、requires_action 例外等逻辑直接写在 orchestration 主线

问题：
- 这些不是“编排”，而是 **flow policy + state transition + payload transform**。
- 应拆成独立 block，由 decision/config 驱动是否执行。

### 4. `engine.ts` 仍承担 flow-level 叙事与控制分支

文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/engine.ts`

表现：
- stop gateway 观察、tool_flow / passthrough、pending injection、followup mainline 调度都混在一个壳
- 还带有 stop_message_flow 专属日志语义

问题：
- `engine.ts` 应只做：
  1. detect block
  2. dispatch block
  3. outcome block
  4. finalize block
- 不应继续拥有业务流知识。

### 5. `execution-shell.ts` 仍承担“半规划 + 半执行 + 半 outcome”混合职责

文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`

问题：
- dispatch plan input、执行循环、backend 执行、outcome 规划收口仍挤在一起。
- 虽然比过去薄，但仍未达到 functions + blocks 的边界要求。

---

## 目标结构

## 一、Functions 层（纯函数）

这些函数只做解析、归一、决策，不直接做 transport / I/O：

### 1. flow/profile functions
- `resolveFlowProfile(flowId)`
- `resolveFlowOutcome(profile, runtimeContext)`
- `resolveFlowStatePolicy(profile)`
- `resolveFlowPayloadPolicy(profile)`

### 2. request/response shape functions
- `normalizeToolCalls(payload)`
- `normalizeFollowupPlan(execution)`
- `normalizeExecutionContext(adapterContext, metadata)`
- `normalizeLoopState(raw)`

### 3. state transform functions
- `planStopMessageLoopGuard(...)`
- `planStopMessageStateMutation(...)`
- `planPendingInjectionMutation(...)`
- `planStickyProviderBinding(...)`

### 4. outcome planning functions
- `planClientInjectOutcome(...)`
- `planReenterOutcome(...)`
- `planSkipOutcome(...)`
- `planMixedToolsOutcome(...)`

> 规则：Functions 只能产出 block / plan，不能直接调 tmux、不能直接 reenter、不能直接写持久化。

---

## 二、Blocks 层（稳定数据块）

建议收敛成以下 block：

### 1. `ServertoolRequestContextBlock`
包含：
- requestId
- entryEndpoint
- providerProtocol
- sessionId / conversationId
- adapterContext scope
- origin snapshot handle

### 2. `ServertoolResponseContextBlock`
包含：
- canonical chat payload
- normalized tool calls
- stop gateway observed signal
- empty payload contract signal

### 3. `ServertoolFlowProfileBlock`
包含：
- flowId
- outcomeMode
- providerPinRemoved
- clientInjectOnly
- autoLimit
- loopLimit mode
- payload decoration mode
- retry policy
- state mutation policy

### 4. `ServertoolExecutionPlanBlock`
包含：
- handler execution result
- flowId
- followup plan raw
- backend plan raw
- state reservation
- execution context

### 5. `ServertoolFollowupPlanBlock`
包含：
- executionMode
- entryEndpoint
- requestIdSuffix
- payload source mode
- payload mutation plan
- metadata mutation plan
- retry count

### 6. `ServertoolOutcomeBlock`
包含：
- `skip`
- `client_inject_only`
- `reenter`
- `pending_injection`
- diagnostics

### 7. `ServertoolStateMutationBlock`
包含：
- clear / set / merge stopMessage state
- sticky routing update
- pending injection persist
- failure cleanup plan

### 8. `ServertoolDiagnosticsBlock`
包含：
- event reason
- failure category
- flowId
- request shape summary
- response shape summary
- chosen outcome summary

> 规则：Block 是稳定 I/O 契约，orchestrator 只传 block，不自己拼散字段。

---

## 三、Orchestration 层（只编排，不做逻辑）

目标总线：

```text
request_context
  -> response_context
  -> dispatch_plan
  -> flow_profile
  -> followup_plan
  -> outcome_dispatch
  -> finalize
```

### 编排层允许做的事
1. 调 block builder
2. 调纯函数 planner
3. 根据 `outcome.kind` 调 transport adapter：
   - `clientInjectDispatch(...)`
   - `reenterPipeline(...)`
4. 汇总 diagnostics / progress log

### 编排层禁止做的事
1. `if flowId === 'stop_message_flow'`
2. `if goal then ... else ...` 这类业务决策直接写在主线
3. 手工拼 metadata 业务语义
4. 手工决定某 flow 是否 clientInjectOnly

---

## 配置契约应该如何扩充

当前 skeleton profile 已经有：
- `noFollowup`
- `autoLimit`
- `flowOnlyLoopLimit`
- `providerPinRemoved`
- `clientInjectOnly`
- `seedLoopPayload`
- `retryEmptyFollowupOnce`
- `clientInjectSource`
- `transparentReplayRequestSuffix`
- `ignoreRequiresActionFollowup`
- `contextDecorationMode`

还缺的配置维度建议补成 profile，而不是写在 TS if/else：

### 建议新增字段
- `outcomeModeOverride?: 'skip' | 'client_inject_only' | 'reenter'`
- `goalAwareOutcomeMode?: 'inherit' | 'force_reenter' | 'disable_followup'`
- `requiresActionPolicy?: 'inherit' | 'ignore' | 'fail_fast'`
- `loopWarningPolicy?: 'none' | 'inject_system_warning'`
- `failureCleanupPolicy?: 'none' | 'clear_stop_message_state'`
- `stateScopePolicy?: 'session' | 'conversation' | 'tmux' | 'resolved_default'`
- `metadataDecorationPolicy?: 'none' | 'sticky_provider' | 'route_hint' | 'both'`

这样：
- plain `stop_message_flow` 的 servertool reenter
- goal continue 的 reenter
- inject fail 时清 stopMessage state
- requires_action 是否短路

都能下沉到 skeleton/profile，而不必写在 orchestration 中。

---

## 最小重构顺序（唯一正确推进顺序）

### Phase 1：先消灭 outcome 双真源

唯一修改点：
- Rust skeleton profile
- TS `followup-runtime-block.ts`

目标：
1. 确保 `stop_message_flow -> reenter` 的 outcome 只来自 Rust skeleton/profile。
2. 删除/禁止 TS 中把 `stop_message_flow` 改成 client injection 或 metadata disable 的硬编码。
3. 保留现有测试，新增红测：**只有 skeleton/profile/runtime carrier 的 `stopMessageFollowupPolicy=preserve_eligibility` 能保留 stopMessage eligibility；单靠 `flowId=stop_message_flow` 或 `servertool.stop_message` source 必须红**。

这是第一刀的唯一性：
- 因为现在最致命的问题不是 block 数量，而是 **outcome 双真源**。
- 不先消灭双真源，后续所有拆分都会建立在错骨架上。

### Phase 2：把 flow-specific state mutation 从 mainline 抽成 block

唯一修改点：
- `followup-mainline-block.ts`
- 新增 `flow-state-policy-block.ts` / `followup-plan-block.ts`

目标：
1. 把 stop loop warning / clear state / requires_action policy 抽成计划块。
2. mainline 只消费 `FollowupPlanBlock` 与 `StateMutationBlock`。

### Phase 3：补齐 skeleton 对所有已知 flow 的 coverage

唯一修改点：
- Rust `servertool_skeleton_config.rs`

目标：
1. 把 `review_flow`
2. `reasoning_stop_guard_flow`
3. `reasoning_stop_finalize_flow`
4. `vision_flow`
5. `recursive_detection_guard`

统一补到 profile。

### Phase 4：压薄 `engine.ts`

目标：
- `engine.ts` 只剩：
  - detect response context
  - run servertool execution shell
  - persist pending injection
  - dispatch followup outcome

### Phase 5：Rust-only closeout

目标：
- 把真正的 flow planning / state policy / outcome planning 进一步收回 Rust
- TS 最终只保留 transport adapter shell

---

## 回归门禁

### 必补红测
1. **outcome 来源红测**
   - `stop_message_flow` 的 `reenter` 来自 skeleton profile，而不是 TS `flowId` 判断。
   - `stop_message_flow.stopMessageFollowupPolicy` 是 skeleton profile 必填契约，缺失时 TS config 层 fail-fast。
2. **goal mode 红测**
   - goal active 时 outcome 行为由 profile/runtime policy 决定，而不是 mainline 特判。
3. **state cleanup 红测**
   - inject failure / followup failure 的状态清理来自 state mutation plan，而不是 inline if/else。
4. **requires_action policy 红测**
   - ignore/fail-fast 行为来自 profile。
5. **full flow contract 红测**
   - mixed tools / client inject / reenter 三种命运只由 outcome block 产出。

### 验证原则
- 不能只看最终结果；必须断言：
  - request shape
  - followup payload source
  - metadata decoration
  - outcome kind
  - state mutation side effect

---

## 当前结论

### 已确认的真源
1. **flow policy 真源已经有 Rust skeleton/profile 雏形**。
2. **当前最大问题不是“没有 skeleton”，而是 orchestration 仍偷写业务逻辑**。
3. **stop_message_flow 的执行方式现在仍是双真源**：
   - 一份在 Rust profile
   - 一份在 TS runtime block

### 唯一正确的下一刀
先做：

> **把 followup outcome 的 flow-specific TS 硬编码彻底移到 skeleton/profile，让 orchestration 只消费 decision。**

这是唯一正确的第一步，因为：
- 它命中了当前最核心的结构性错误：**双真源**。
- 它不扩大范围，不会提前碰 handler 业务。
- 它为后续 functions + blocks 拆分建立正确骨架。

如果这一步不先做，后面继续拆 block 只是把错误语义拆得更分散。
