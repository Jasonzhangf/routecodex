# 初始预规划恢复生命周期

## 目的与边界

本图声明新的请求路径契约：路由 owner 独立展开当前池可见 tier/provider，当前池不可见时立即选 default。请求执行消费一次选择后直接进入 transport，不等待 probe、健康恢复、业务 permit 或本地容量。成功、取消、原始 deadline 和真实不可恢复失败统一收口为内部处置回执。本条是目标设计，源码与真实入口验收仍需单独完成。

本图是静态生命周期设计，不是新的 SDK graph，也不改变 request/error 对象图。恢复轮次属于外层 Runtime 状态机；静态 DAG 不画回边。`bind_original_control`、`resolve_and_recover_preplan`、`dispatch_selected_plan` 和 `close_request_scope` 的 Operator 名称是静态绑定声明；当前没有证据表明它们已在 `v3.operation_runner.operator_registry` 注册并可由 `pipeline_runtime::compile` 执行。

## SESE

- 单入口 ARC：`accepted-request-context`
- 单出口 ARC：`request-disposition-receipt`
- 内部处置回执不发送给客户端，也不是客户端业务响应。

静态对象流：

```text
accepted-request-context
  -> 绑定原始请求控制
  -> 消费路由的即时可见候选或 default 选择
  -> 执行已选计划或保留终止处置
  -> 收口本请求资源与传输
  -> request-disposition-receipt
```

## 节点与现有绑定

| 节点 | 中文语义 | 现有 Owner 与绑定 | 静态输出 |
|---|---|---|---|
| `bind_original_control` | 绑定原始请求控制 | `routecodex-v3-runtime`；`V3RequestExecutionControl::from_manifest`，来源 `v3/crates/routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs` | 原始取消与 residence deadline |
| `resolve_and_recover_preplan` | 消费即时路由选择 | 既有 Target 负责展开、可见性、排序与 default；Runtime 仅消费计划，旧恢复等待 caller 退役 | 计划就绪、取消、deadline 或 typed 无目标处置 |
| `dispatch_selected_plan` | 执行已选计划或保留终止处置 | `routecodex-v3-runtime` 与现有 Direct/Relay execution entry；Server 仍只拥有传输与观测边界 | 真实业务结果或内部传输处置 |
| `close_request_scope` | 收口本请求资源与传输 | Runtime request closeout；Server 消费有资格的 typed 末候选终态，不重新选路 | 唯一内部处置与交付回执 |

`resolve_and_recover_preplan` 的 probe 生命周期独立属于既有 aggregate owner。启动或完成 probe 不等于健康成功，也不能替代正常候选资格判断；只有真实完成且通过 current permit/generation 校验的结果才能更新 health。请求完成或取消不取消 listener 级健康 probe；本图不新增 probe 转交执行要求，也不要求首 poll 后立即重查 captured target。

## 外层状态转换

| 当前条件或事件 | 动作 | 后继 |
|---|---|---|
| 原 captured target 有正常 eligible 候选 | 返回现有计划 | 正常执行 |
| 当前池无可见候选 | Target 立即选择 default，不等待前池 probe 或健康恢复 | default 计划就绪或 typed 无目标处置 |
| 精确身份健康变化 | 健康 owner 更新候选可见性，不向执行路径增加等待或队列 | 后续正常路由选择消费新状态 |
| 实际已选候选失败，原 Target 正常证明无未失败 eligible 替代 | 保留原 typed Error，本次不新增 health、观察、probe、等待或重发；typed 资格与本 attempt witness 一起交 Server | v27：未提交 head 的完整真实 HTTP 错误返回原 status、原 body 和合法 headers，不伪造成功；非 HTTP、不完整 body、post-head 与 postcommit 表示保持 OPEN |
| default 也无可见候选 | 保留真实 typed 耗尽事实；仍可恢复与确实无目标的终点必须独立证明，不合成成功或客户端错误 | 未闭合分支保持 OPEN，不伪造验收 |
| 客户端取消或断开 | 停止该请求后续 dispatch，释放本请求资源 | 取消处置；listener 级健康 probe 独立于本请求继续 |
| 原始 residence deadline 到期 | 保留原始 deadline 处置，不复查健康、不延长预算或新增发送 | deadline 处置 |
| 不可恢复本地内部失败 | 保留 typed Error，收口该请求 | 内部失败处置 |

`dispatch_selected_plan` 只消费已捕获的计划并进入 transport，不重新读取健康状态选路，也不做本地容量、attempt 次数、byte/frame/process 或 action-permit 准入。Chat Process 的 refill 业务续写连续最多额外一次，0 可关闭，配置不能放宽；错误切换不扣除也不重置 refill。失败完整身份集合跨 default 和 refill 保留，独立 probe 成功也不能解除本请求的失败排除；未失败身份上的合法业务 refill 不属于错误重试。取消后不再发送，原始 deadline 不续期；不伪造成功，不向客户端泄露中间候选错误。末候选错误按独立 typed terminal/Server 出口处理；请求执行不等待路由恢复。

单次错误处置仍由独立 Error 对象流承载：实际失败与完整身份 → 保留本 attempt 原 status/body/cause → 累加本请求失败集合 → 原 Target 一次取得替代或正常无替代事实 → 唯一 typed 处置。Selected 才应用普通精确身份健康动作并直接 dispatch。正常 Exhausted 且已有实际失败时，不新增 health/store、观察或 probe，不等待或重发；资格随现有 terminal 传给 Server。未提交客户端 head 且有完整真实 HTTP 错误时，Server 返回其原 status/body 和合法端到端 headers；内部处置回执不直接投影，不能用前一 attempt witness 补末次错误。解析/Operator fault 与初始无 eligible 结果不授予末候选资格。HTTP 429 共用普通错误路径，无专属 episode、minimum、required-probe 或降额。Provider 生命周期只更新可见性，不给请求生命周期 permit 或恢复等待。依据 canonical requirements 根 v27、last-provider v4 及 terminal-error-passthrough-20261106/plan.md；v26 计划只保留未被替代的控制路径。此为设计，未代表源码、客户端错误交付或线上验收。

局部对象流由同一入口与处置出口闭合：真实失败 → 原 Target 正常 Selected / Exhausted / Failed → 捕获替代、末候选 typed terminal 或选择故障 → 唯一本次处置与交付回执。成功、取消、原 deadline 和合法末候选错误都由既有请求 closeout 收口。无 HTTP、body 不完整、已提交 head 的错误表示与已交付业务 SSE 的保真恢复仍 OPEN，不能以断流、正常空完成或重发帧判 PASS。错误图仍以内部 outcome 为出口，不添加跨请求/响应图回边或第二路由 owner。

客户端维护对象流独立于请求准入：响应绑定 → 非阻塞登记保管责任 → body/SSE 保管 → EOF 后交接 Front 已排队字节 → flush、写失败或断开 → 唯一传输关闭回执。Server 不为此排队业务请求，正式 restart 不等待 Provider 完成。default 自身无可见但可恢复、explicit pin 跨 default、已提交业务 SSE 跨 Provider 保真均保持 OPEN。

## Map 与 Gate

- DAGPipe 登记：`docs/architecture/dagpipe/modules.json` 的 `initial-preplan-recovery` extension。
- 运行时资源语义：`docs/architecture/v3-resource-operation-map.yml` 的 request lifecycle、即时选择、独立 Provider 可见性和 typed Error 条目；图不读取 probe 状态或退役 attempt 额度。
- Owner/调用绑定：`docs/architecture/v3-function-map.yml` 与 `docs/architecture/v3-mainline-call-map.yml` 的 target recovery、provider probe 和 execution lifecycle 条目。
- 公开入口 suite：`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`，复用 `tests/support/pool_empty_recovery_blackbox.rs` 的 aggregate Server、健康控件、probe/business 到达通道与明确闩锁。当前请求独立锚点是 `invisible_pool_uses_default_while_probe_is_held_direct_public` 和 `invisible_pool_uses_default_while_probe_is_held_relay_public`；它们验证probe仍在执行时default和健康兄弟请求继续。旧的request等待probe、hard-attempt-cap和恢复backoff断言不再是本图验收标准。
- 真实失败后重选锚点：`issue44cc3af_untried_tier_attempt_` 覆盖Direct、Responses Relay、Anthropic Relay及新refill消费当前可见候选。Iris的 `request-gates-removal-20261105/result.md` 关联实际红测和公开入口退出；生产和完整终点验收仍独立。
- 本图与 gate 通过只证明静态声明和拓扑。公开入口红测、候选恢复与完整业务交付仍须分别验收。
