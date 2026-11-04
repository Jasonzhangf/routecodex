# 初始预规划恢复生命周期

## 目的与边界

本图补足一个现有 Runtime 生命周期缺口：请求已被 Server 接受后，初始 non-admitting preplan 在等待恢复probe时，如何继续使用同一 captured target，如何只在计划就绪后 dispatch，以及如何把成功、取消、原始 deadline 和不可恢复内部失败统一收口为一个内部处置回执。

本图是静态生命周期设计，不是新的 SDK graph，也不改变 request/error 对象图。恢复轮次属于外层 Runtime 状态机；静态 DAG 不画回边。`bind_original_control`、`resolve_and_recover_preplan`、`dispatch_selected_plan` 和 `close_request_scope` 的 Operator 名称是静态绑定声明；当前没有证据表明它们已在 `v3.operation_runner.operator_registry` 注册并可由 `pipeline_runtime::compile` 执行。

## SESE

- 单入口 ARC：`accepted-request-context`
- 单出口 ARC：`request-disposition-receipt`
- 内部处置回执不发送给客户端，也不是客户端业务响应。

静态对象流：

```text
accepted-request-context
  -> 绑定原始请求控制
  -> 解析目标并等待合格候选
  -> 执行已选计划或保留终止处置
  -> 收口本请求资源与传输
  -> request-disposition-receipt
```

## 节点与现有绑定

| 节点 | 中文语义 | 现有 Owner 与绑定 | 静态输出 |
|---|---|---|---|
| `bind_original_control` | 绑定原始请求控制 | `routecodex-v3-runtime`；`V3RequestExecutionControl::from_manifest`，来源 `v3/crates/routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs` | 原始 deadline 与 attempt budget |
| `resolve_and_recover_preplan` | 解析目标并等待合格候选 | `routecodex-v3-runtime`；外层 `plan_v3_responses_protocol_execution_with_recovery`，内层 `plan_v3_responses_protocol_execution_recovery_inner`，captured-target planner，既有 aggregate probe owner，以及 `wait_for_target_recovery` | 计划就绪、取消、deadline 或不可恢复内部失败 |
| `dispatch_selected_plan` | 执行已选计划或保留终止处置 | `routecodex-v3-runtime` 与现有 Direct/Relay execution entry；Server 仍只拥有传输与观测边界 | 真实业务结果或内部传输处置 |
| `close_request_scope` | 收口本请求资源与传输 | Runtime request closeout；Server provider-terminal transport break 只属于传输边界 | 唯一内部处置回执 |

`resolve_and_recover_preplan` 的 probe 生命周期独立属于既有 aggregate owner。启动或完成 probe 不等于健康成功，也不能替代正常候选资格判断；只有真实完成且通过 current permit/generation 校验的结果才能更新 health。请求完成或取消不取消 listener 级健康 probe；本图不新增 probe 转交执行要求，也不要求首 poll 后立即重查 captured target。

## 外层状态转换

| 当前条件或事件 | 动作 | 后继 |
|---|---|---|
| 原 captured target 有正常 eligible 候选 | 返回现有计划 | 正常执行 |
| 初始 preplan 无候选，但有可探测恢复身份 | probe 的启动与调度由既有 aggregate owner 负责；本图不新增 probe 转交或首 poll 后立即重查的执行要求 | 计划就绪或恢复等待 |
| 精确身份恢复、容量变化或既有等待阶梯到期 | 重读 typed health/capacity，重选同一 captured target | 计划就绪或继续等待 |
| 仍无替代 | 不持有业务容量地等待 | 保持 pending |
| 客户端取消或断开 | 停止该请求后续 dispatch，释放本请求资源 | 取消处置；listener 级健康 probe 独立于本请求继续 |
| 原始 residence deadline 到期 | 做最终 health/eligibility 复核，不延长物理发送预算 | deadline 处置 |
| 不可恢复本地内部失败 | 保留 typed Error，收口该请求 | 内部失败处置 |

`dispatch_selected_plan` 只在“计划就绪”分支调用现有 executor。发送前准入只受真实资格限制：captured target 中尚未真实发送的正常合法后 tier/default 不得因 attempt 预算耗尽而被阻止；已试身份继续受最后失败身份、shape、健康、容量和 action gate 限制；无合法替代时才进入同一 captured target 的合法等待。等待不持有业务容量，取消后不再新增 dispatch，原始 residence deadline 不续期且处置前保留最终 health/eligibility 复核。取消、deadline 和不可恢复内部失败分支只传递原 typed 处置，不构造成功，不发送 Provider 业务请求，也不发送客户端 provider-error payload。

## Map 与 Gate

- DAGPipe 登记：`docs/architecture/dagpipe/modules.json` 的 `initial-preplan-recovery` extension。
- 运行时资源语义：`docs/architecture/v3-resource-operation-map.yml` 的 request lifecycle、attempt budget、recovery wait、cooldown probe 和 typed Error 条目。
- Owner/调用绑定：`docs/architecture/v3-function-map.yml` 与 `docs/architecture/v3-mainline-call-map.yml` 的 target recovery、provider probe 和 execution lifecycle 条目。
- 现有公开入口 suite：`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`，复用 `tests/support/pool_empty_recovery_blackbox.rs` 的 aggregate Server、健康控件、probe/business 到达通道与明确闩锁；已有行为锚点包括 `initial_all_cooled_waits_for_active_probe`、`probe_success_wakes_long_pool_backoff_immediately`、`capacity_release_wakes_long_pool_backoff_immediately`、`cancelled_wait_does_not_send_after_capacity_returns`、`pool_wait_outlives_single_candidate_acquire_timeout`、`all_tried_transport_failure`、`hard_attempt_cap_waits`（各含 Direct/Relay 臂）。
- 计划稳定前缀（当前待新增，不能宣称 PASS）：`issue44cc3af_preplan_bounded_` 与 `issue44cc3af_untried_tier_attempt_`，由 Runtime/测试 owner 在同一 suite 新增并绑定到本图 gate；实际收集并通过前，该依赖为 open，移交 Iris。
- 本图与 gate 通过只证明静态声明和拓扑。公开入口红测、候选恢复与完整业务交付仍须分别验收。
