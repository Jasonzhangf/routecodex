# V4 Cordis Shared Runtime / Event Control / Typed Control 计划

状态：`proposed_canonical`
文档 ID：`V4-CORDIS-SHARED-RUNTIME-EVENT-CONTROL-20260901`
范围：Arc shared carrier、诊断 Event Bus、typed Control command/state machine
基线：当前 V4 workspace；V3 源码、配置、发布路径只读

## 1. 目标与验收标准

将当前 V4 Cordis vertical slice 推进到设计文档要求的共享运行时与控制面闭环：

1. Arc 共享从局部 bytes/sink/registry 用法提升为 typed immutable carrier、node-scoped service registry 和 in-flight 生命周期 pin。
2. `V4Debug02BusSubscription` 从订阅登记表升级为 scope-filtered、typed envelope、单调序号、事件事实、只读订阅视图和显式 dispatch 的诊断 Event Bus。
3. `ControlView` 与 bridge control 输入从 `String`/`serde_json::Value` 控制承载收紧为 owner-specific typed command/resource API。
4. 控制命令由唯一 owner 状态机裁决；committed state transition 生成 immutable event fact；Event Bus 只通知、观测、记录，不参与业务决策。
5. Cordis Host 真正注入 node-scoped typed services，并在 dispose/drain 时释放；失效 service 不得继续执行。

完成验收：

- `cargo test --workspace --quiet` 通过。
- V4 resource/function/mainline/verification maps 与 contracts 同步，新增条目有真实 owner、symbol、caller/callee 和 gate。
- Event Bus、shared carrier、typed control 均有先红后绿的正反测试。
- data/control/information/diagnostic 物理隔离 gate 通过；控制面和诊断事件不进入 provider/client payload。
- Cordis Host 真实 `Context` / `Fiber` / `Effect` 生命周期测试通过。
- `appsdk verify v4` 与 `appsdk compile v4` 通过；若当前 SDK pin mismatch，先修唯一治理 owner，不手改 lock、不绕过 gate。
- 真实 V4 Host 生命周期和指定在线旧样本复测通过后，才允许 review；无运行时安装/重启授权时只能报告代码、构建和测试结果。

## 2. 范围与边界

### In scope

- `v4/crates/routecodex-v4-debug`
  - Event envelope、published event fact、scope-filtered subscription、read-only subscriber view、dispatch 和单调序列。
- `v4/crates/routecodex-v4-runtime`
  - immutable shared data/information/diagnostic carrier；
  - `ExecutionContext` typed view；
  - `ControlView` typed command facade；
  - active plan/epoch pin。
- `v4/crates/routecodex-v4-cordis-bridge`
  - typed execution carrier/handle；
  - typed control resource boundary；
  - 不再使用裸 `Value` 表达关键 control 语义。
- `v4/cordis/routecodex-v4-cordis-host`
  - node-scoped control/information/diagnostic service binding；
  - service readiness、失效检查和 dispose release。
- `v4` resource/function/mainline/verification maps、module registry、contracts、architecture gates、L2/L3 tests。

### Out of scope

- 不改 V3 源码、配置、发布 binary 或既有 V3 行为。
- 不改 provider、router、SSE、handler、client projection 或协议 wire shape。
- 不在 handler/SSE/outbound/runtime-bin 增加补偿、fallback、silent strip 或第二路径。
- 不重写 NodePluginPlan 编译顺序，不新增第二 orchestrator。
- 不把客户端 `metadata`、provider options、debug state 或 control state 搬入业务 payload。
- 不修改 frozen active artifact；必须扩展 frozen crate 时，先走显式 re-freeze 授权和生命周期。
- 不为未来扩展新增无实际调用方的 Manager/Service/Factory 层。

## 3. 权威文档与模块边界

执行前必须读取并核对：

- `v4/docs/architecture/v4-pipeline-abstraction-model.md`
- `v4/docs/architecture/v4-cordis-node-plugin-architecture.md`
- `v4/docs/architecture/v4-data-control-plane-boundary.md`
- `v4/docs/architecture/v4-resource-operation-map.yml`
- `v4/docs/architecture/maps/resource-map.json`
- `v4/docs/architecture/maps/function-map.json`
- `v4/docs/architecture/maps/mainline-call-map.json`
- `v4/docs/architecture/maps/verification-map.json`
- `v4/contracts/debug-subscription.contract.json`
- `v4/contracts/node-graph.contract.json`
- `v4/contracts/pipeline-abstraction.contract.json`
- `v4/contracts/data-control-boundary.contract.json`
- `v4/.appsdk/maps/module-registry.json`

唯一 owner 约束：

| 能力 | 唯一 owner | 禁止 owner |
| --- | --- | --- |
| Event Bus、事件事实、scope dispatch | `routecodex-v4-debug::V4Debug02BusSubscription` | Host、Bridge、runtime-bin、SSE、handler |
| immutable shared carrier | `routecodex-v4-runtime::ExecutionContext` | Host payload、provider runtime、handler |
| typed control command/state transition | `routecodex-v4-control::MetadataCenter` + runtime typed facade | subscriber、bus、handler、SSE |
| Cordis service binding | `routecodex-v4-cordis-host` | plugin payload、runtime-bin 重建 |

实现前后都必须检查 `owned_paths`、allowed/forbidden paths、相邻调用边、资源关系和实际 diff 越界。

## 4. 技术方案

### M1：Event Bus

在 `routecodex-v4-debug` 内新增最小 typed API：

```text
DiagnosticEventEnvelope
PublishedEventFact
ReadOnlySubscriberView
V4Debug02BusSubscription::publish
V4Debug02BusSubscription::dispatch
V4Debug02BusSubscription::published_facts
V4Debug02BusSubscription::subscriber_view
```

envelope 至少绑定 `topic`、`scope_key`、`sequence`、`source_node`、`payload_hash` 和单调时间事实。关键控制语义不得使用裸 `Value`。

规则：

- `publish` 只追加不可变诊断事实。
- `dispatch` 只投递同 topic、同 scope 的订阅者。
- scope 过滤必须在 bus owner 内完成，其他层不得二次过滤。
- 重复序号、未知 scope、已 dispose subscriber、非法 envelope 显式报错。
- subscriber 只能读取 view，不能写 bus、MetadataCenter、data 或 control。
- bus 故障必须显式记录；不得改变业务路径、改写业务结果或触发 fallback。

### M2：Shared Immutable Carrier

在 runtime/bridge 形成 typed carrier：

```text
ImmutableDataCarrier
ImmutableInformationCarrier
ImmutableDiagnosticCarrier
NodeServiceRegistry
```

规则：

- carrier 使用 `Arc` 共享所有权；下游只读，禁止 mutable API。
- 相邻节点/插件传递同一 carrier 时验证零拷贝和 `Arc::ptr_eq` 语义。
- `ExecutionContext` 提供 typed view，不暴露可任意修改的公共 data/control 字段。
- service registry 绑定 node、scope、plan hash、epoch 和生命周期状态。
- stale/disposed service、scope 或 plan epoch 不一致时 fail-fast。
- `try_unwrap` 等释放操作只能由 carrier owner 调用。

### M3：Typed Control

在 `routecodex-v4-control` 既有 MetadataCenter 语义上增加 typed command/state transition；runtime 只提供 typed facade，不能复制第二套状态机。

控制类型至少覆盖：

```text
ContinuationScope
ContinuationOwner
ExecutionMode
ExecutionPlan
RouteFact
TargetSelection
RouteExit
ControlCommand
ControlCommittedEvent
```

规则：

- command 只能经 MetadataCenter owner 校验 scope、状态和权限。
- 合法状态：`unregistered -> registered -> consume* -> released`。
- 非法 transition、跨 scope、跨 owner、重复 commit、已 release 使用都 fail-fast。
- commit 成功后生成 immutable committed event fact，再交给 debug bus 只读发布。
- bus subscriber 不得修改 control state，也不得成为 continuation/routing/retry 输入。
- bridge 的 `control: Value` 改为 typed control handle；不能通过字符串或 JSON 重建控制状态。

### M4：Cordis Host Service Binding

Host 负责真实服务注入和生命周期，不拥有控制语义：

- node control service：typed MetadataCenter handle；
- node information service：immutable information carrier；
- node diagnostics service：read-only event bus view；
- mount 前完成 service declaration；
- publish 前确认 service ready；
- drain/dispose 时按 owner release；
- 缺失、scope mismatch、plan mismatch、disposed service 直接抛显式 Host error。

`createNodePlugin` 继续保持冻结的 plugin identity/config/planEntry 语义；仅增加已登记 service capability 校验，不把 service 变成 payload 字段。

## 5. 文件清单

实现文件：

- `v4/crates/routecodex-v4-debug/src/lib.rs`
- `v4/crates/routecodex-v4-debug/tests/l2_debug.rs`
- `v4/crates/routecodex-v4-runtime/src/lib.rs`
- `v4/crates/routecodex-v4-runtime/tests/l2_runtime.rs`
- `v4/crates/routecodex-v4-cordis-bridge/src/lib.rs`
- `v4/crates/routecodex-v4-cordis-bridge/tests/l2_bridge.rs`
- `v4/cordis/routecodex-v4-cordis-host/src/index.mjs`
- `v4/cordis/routecodex-v4-cordis-host/tests/host.test.mjs`
- `v4/cordis/routecodex-v4-cordis-host/tests/host-binding.test.mjs`

合同和索引：

- `v4/docs/architecture/v4-resource-operation-map.yml`
- `v4/docs/architecture/maps/resource-map.json`
- `v4/docs/architecture/maps/function-map.json`
- `v4/docs/architecture/maps/mainline-call-map.json`
- `v4/docs/architecture/maps/verification-map.json`
- `v4/.appsdk/maps/module-registry.json`
- `v4/contracts/debug-subscription.contract.json`
- `v4/contracts/node-graph.contract.json`
- `v4/contracts/pipeline-abstraction.contract.json`
- `v4/contracts/data-control-boundary.contract.json`

Gate 接线：

- `v4/scripts/architecture/verify-v4-debug.mjs`
- `v4/scripts/architecture/verify-v4-runtime.mjs`
- `v4/scripts/architecture/verify-v4-cordis-bridge.mjs`
- `v4/scripts/architecture/verify-v4-cordis-host.mjs`
- `v4/scripts/architecture/verify-v4-capability-isolation.mjs`
- `v4/scripts/architecture/verify-v4-plane-isolation.mjs`
- `v4/scripts/_gate-matrix.mjs`
- `v4/scripts/verify.mjs`
- `v4/scripts/test.mjs`

文件清单不是授权清单。先按 maps 和 module registry 确认实际 owner，再决定是否需要改动。

## 6. 测试计划

### Event Bus 正反测试

- 同 scope 发布可被匹配 subscriber 收到；跨 scope 发布不可收到。
- topic 不匹配不可投递。
- sequence 单调递增；重复/倒退序号失败。
- dispatch 期间修改订阅集合不影响当前投递快照。
- dispose 后 subscriber 不再收到事件。
- read-only view 不能修改 bus、data、control 或下一次 dispatch。
- bus publish 故障显式返回；业务 data/control 与执行路径保持不变。
- bus event 不进入 payload、MetadataCenter、provider/client wire 或 Error decision。

### Shared Carrier 正反测试

- 相邻节点复用同一 immutable carrier，验证 `Arc::ptr_eq`。
- carrier view 可读；不存在 mutable byte/data API。
- stale/disposed service 和 epoch mismatch 执行失败。
- 非 owner 不可 unwrap/release。
- 不同 scope、node、plan 的 carrier/service 不可互用。
- diagnostic carrier 不能写 data/control，data carrier 不能承载 control state。

### Typed Control 正反测试

- 合法 command 经 MetadataCenter commit，生成 committed event fact。
- 重复 register、未注册 consume、已 release consume、跨 scope consume 均失败。
- command 不能由 `Value`、任意 String 或 payload 重建。
- owner-specific command 不能互相替代。
- subscriber 观察 commit 后不能修改 MetadataCenter。
- bus 故障不改变已经裁决的 control state，也不改变业务路径。

### Host L3 测试

- Context/Fiber ACTIVE 后才允许执行。
- service 缺失、未 ready、scope mismatch、plan mismatch 显式失败。
- mount、publish、drain、dispose 的 service acquire/release 顺序正确。
- disposed/stale service 不能继续执行。

## 7. 实施顺序

1. 建立当前 run notes、刷新 `.agent-collab`、声明 feature/resource/mainline owner 和独立 worktree。
2. 运行 AppSDK governance preflight；治理阻断先回唯一 owner 修复，禁止手改生成记录或绕过 gate。
3. 读取 maps、contracts、wiki、mainline source，完成模块边界和资源关系审查。
4. 先补 M1 资源/function/mainline/verification entries 和 machine contracts。
5. 写 M1 正反红测，确认当前实现确实失败。
6. 只修改 `routecodex-v4-debug` owner，实现 Event Bus；补 gate，跑定向测试。
7. M1 通过后补 M2 maps/contracts/red tests；只修改 runtime/bridge owner，实现 immutable carrier/service registry。
8. M2 通过后补 M3 maps/contracts/red tests；只修改 control/runtime/bridge owner，实现 typed command/state machine。
9. 接入 Host typed service binding 和 L3 lifecycle tests。
10. 做实际 diff 模块越界自检，再跑定向测试、workspace build、architecture gates、AppSDK verify/compile、fmt 和 diff check。
11. 按项目要求完成安装、聚合 restart、health、真实 Cordis Host 生命周期和同入口旧样本验证；未授权时不得执行运行时变更。
12. 写 `evidence.jsonl` 与 handoff；前置验证全部通过后才启动默认 `agy-review`，review 失败必须修复后重新验证、重新 review。

## 8. 风险与规避

| 风险 | 规避 |
| --- | --- |
| Bus 被误用作控制决策 | typed command 只进 MetadataCenter；bus 仅发布 committed fact；加反向测试和静态 gate |
| Arc 只变成包装器 | 测试跨节点 `Arc::ptr_eq`、service scope/epoch pin 和 dispose 失效 |
| String/Value 控制面继续存在 | compile-fail/静态扫描锁关键 control 类型，禁止 bridge/runtime-bin 补偿 |
| 诊断事件进入 payload | plane-isolation 和 capability-isolation 红测在 owning boundary fail-fast |
| Host 服务失效后仍执行 | service token、scope、plan hash、epoch、lifecycle 全部在 Host/bridge 边界校验 |
| 修改 frozen crate 造成治理漂移 | 先确认 owner 和 re-freeze 需要；未经授权不改 active artifact |
| 多 worker 语义冲突 | claim 绑定 feature/resource/mainline，不共享 worktree；冲突写 handoff，禁止覆盖他人 dirty |

## 9. 完成定义

- 三个缺口都有唯一 owner、typed API、机器合同、function/mainline/verification 绑定和正反红测。
- Event Bus 真正具备 envelope、scope filter、seq、dispatch、published fact、read-only view。
- Arc 共享具备跨相邻节点/插件的 immutable carrier、node-scoped service ownership、epoch pin 和释放语义。
- ControlView/Bridge 不再以裸 String/Value 表达关键控制状态；所有控制命令经唯一 MetadataCenter owner 裁决。
- committed state transition 与 diagnostic event fact 两段式闭环成立；subscriber 不影响业务和控制。
- 所有隔离、生命周期、构建、AppSDK、Host L3、真实入口验证通过。
- 无 fallback、silent strip、第二路径、handler/SSE/outbound 补偿或控制面 payload 泄漏。
- handoff/evidence 完整；review 取得明确 PASS 后，才可进入合并/提交流程。
