# V4 Standard Nodes and Machine-Controlled Node Graph

状态：`design`（标准节点族、节点图接线和 debug 订阅关系已按 V3 锁定为目标态合同；实现未落地）

## 目标

从 `BaseNode` 延伸出有限的标准节点族，让每条链的节点不是“自由发明”，而是实例化同一套标准节点。节点图本身必须是机器可读、机器可验证的合同：

- 节点清单（chains + nodes）；
- 数据流接线（data flow edges）；
- 控制流接线（MetadataCenter / Control Center 注册、消费、释放）；
- debug 订阅接线（只读订阅，禁止影响执行）。

任何代码级连接（struct 转换、builder/parser、订阅注册、Control Center 操作）必须能命中 node graph 中的已声明边；未声明即红灯。

## 标准节点族

`BaseNode` 只定义横切能力（identity、control in/out、control record、debug/snapshot subscriptions、statistics）。标准节点族在 BaseNode 上补充“链内角色”约束，每个标准节点实例再绑定唯一 `node_id`：

| 标准节点族 | 适用 chain | data 面 | 典型职责 | 禁止 |
| --- | --- | --- | --- | --- |
| `RequestChainNode` | `request` | 业务请求 payload | parse / normalize / chat process / outbound semantic | 控制字段进 payload、跨节点短路 |
| `ResponseChainNode` | `response` | 业务响应 payload | resp inbound / chat process / client semantic | 控制字段进 payload、provider raw 直连 client |
| `ErrorChainNode` | `error` | 无（只走 Error carrier） | source / classify / policy / decision / projection | 进入 provider/client payload、本地 retry 策略 |
| `ConfigChainNode` | `config` | 无（只走 information） | parse / validate / registry / manifest | runtime 写 authoring、manifest 入 payload |
| `LifecycleChainNode` | `lifecycle` | 无 | declare / lock / identity / controlled runtime | 拥有业务 payload、第二 lifecycle |
| `ControlCenterNode` | `control` | 无 | register / consume / release typed control resource | 数据面真源、payload 重建 |
| `DiagnosticChainNode` | `diagnostic` | 无 | trace / ledger / raw capture / snapshot / observability | 进入 live path、成为决策输入 |

### 标准节点实例化模板

```text
<Chain><NN><SemanticName> : BaseNode + <StandardNodeFamily>
```

实例必须继承：

- identity（chain、chain_version、position 不可变）；
- `control_in` / `control_out`（读写 typed control resource，接入/输出都有 ControlRecord）；
- `debug_subscriptions`（只读 debug topic）；
- `snapshot_subscriptions`（只读 entry/exit/error 快照）；
- `statistics`（可选观测）。

实例补充：

- `data_in` / `data_out`（仅 Request/Response 族有业务 payload；其他族为空）；
- `resources_read` / `resources_written`；
- `allowed_operator_kinds`；
- `state_machine`（in/out events、transitions）。

## 节点图接线（machine-controlled）

节点图是一个机器合同，包含三类边。每条边必须有 `edge_id`、`from`、`to`、`owner`、`kind`，并满足引用完整性。

### 1. Data flow edges

表达业务数据在相邻节点之间的流向：

```json
{
  "edge_id": "edge.req.inbound02-to-chatprocess03",
  "kind": "data_flow",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "from": "V4ReqInbound02Normalized",
  "to": "V4ReqChatProcess03Governed",
  "data_in": "v4.request.normal_payload",
  "data_out": "v4.request.normal_payload",
  "owner": "routecodex-v4-runtime",
  "adjacent_required": true
}
```

规则：

- 只有相邻节点可以存在 data edge；
- 非相邻转换（builder/parser/struct 转换）没有对应 data edge 即红灯；
- data edge 上的资源必须属于 `data` 轴；控制资源不得出现在 data edge；
- 每个节点最多一个 `data_in` 数据源和一个 `data_out` 数据出口。

### 2. Control flow edges（MetadataCenter / Control Center）

表达节点与 Control Center 之间的控制读写：

```json
{
  "edge_id": "edge.control.chatprocess03.consume.restore",
  "kind": "control_flow",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "from": "V4ReqChatProcess03Governed",
  "to": "v4.control.metadata_center",
  "operation": "consume",
  "control_key": "continuation.restore",
  "scope_keys": ["requestId", "pipelineId", "port", "sessionScope"],
  "owner": "routecodex-v4-runtime",
  "record_required": true
}
```

`operation` 只允许 `register` / `consume` / `release`。每条边都要求：

- 写入 `v4.control.record_ledger`（ControlRecord 必写）；
- scope 隔离：只能在声明 scope 内读写；
- 禁止把控制资源放进 `data` 轴或业务 payload；
- `release` 只能由拥有该 scope 注册权的节点执行；
- 客户端协议 `metadata` / `client_metadata` / `x-*` 不得通过 control edge 变成内部控制信号。

### 3. Debug subscription edges

表达节点对 debug 总线和快照订阅的只读连接：

```json
{
  "edge_id": "edge.debug.chatprocess03.subscribe.node_event",
  "kind": "debug_subscription",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "from": "V4ReqChatProcess03Governed",
  "to": "v4.debug.bus_subscription",
  "topic": "node_event",
  "direction": "subscribe",
  "read_only": true,
  "owner": "routecodex-v4-debug"
}
```

规则：

- 订阅只读：订阅者不得基于事件修改业务结果或控制决策；
- debug bus 不承载 payload；
- snapshot 订阅只允许 `node_entry` / `node_exit` / `node_error`，且只诊断；
- debug 资源禁止进入 provider wire、client wire、业务 payload 和 MetadataCenter；
- 统计只允许 observability/records 读取，禁止进入决策或 payload。

## Debug 订阅资源关系（按 V3 锁定）

以下关系以 V3 已 `anchored` 的 debug 资源关系为基线。V4 目标态必须保持相同语义；V4 实现不得放宽任何一条。

| V3 资源（基线） | V3 owner/reader 关系（已锁） | V4 目标资源 | V4 关系（必须保持） |
| --- | --- | --- | --- |
| `v3.debug.trace_context` | 写 `V3DebugRuntime::start_trace`；读 event_ledger / raw_capture / snapshot_session | `v4.debug.trace_context` | 写 `V4DebugRuntime::start_trace`；只读派生给 event ledger、raw capture、snapshot |
| `v3.debug.event_ledger` | 写 `record_node_event`；读 logs / developer_diagnostics | `v4.debug.event_ledger` | 写 `V4DebugRuntime::record_node_event`；只读给 logs/diagnostics |
| `v3.debug.raw_capture` | 写 `capture_raw_request` / `capture_raw_response`；verbatim 保真 | `v4.debug.raw_capture` | 只有 debug owner capture；禁止裁剪语义；禁止成为 payload truth |
| `v3.debug.snapshot_session` | 写 start / record / release | `v4.debug.snapshot_session` | start → record → release 生命周期；release 后不可 consume；禁止 live path |
| `v3.debug.dry_run_fixture` | 写 register；读 fixture / build plan | `v4.debug.dry_run_fixture` | 只 debug owner 注册；runtime 只读构建 dry-run plan |
| `v3.debug.dry_run_execution` | 写 runtime no-network terminal effect | `v4.debug.dry_run_execution` | 只有 runtime 执行 no-network effect；禁止真实 provider 调用 |
| `v3.debug.codex_sample_authorization` | 写 config manifest authorization；`may_enter_metadata_center=false` | `v4.debug.codex_sample_authorization` | 只有 config 编译期写；禁止进入 MetadataCenter |
| `v3.debug.payload_budget` | verbatim、error force-write、retention cap；`may_enter_metadata_center=false` | `v4.debug.payload_budget` | verbatim 保真；错误强制落样本；200/port retention；禁止 MetadataCenter |
| `v3.debug.codex_sample_filesystem` | 写 persist/enforce retention；读 developer_diagnostics / replay | `v4.debug.codex_sample_filesystem` | 只有 debug owner 持久化；replay 只读；禁止 MetadataCenter |
| `v3.runtime.responses_observability` | 写 runtime observability；读 console emitters | `v4.debug.observability` | 只有 runtime 写；console 只读；禁止 provider/client |
| `v3.runtime.responses_timing_observability` | 写 timing accumulator；读 console / handoff | `v4.debug.timing_observability` | 只有 runtime 写；observability 只读；禁止决策 |
| `v3.console.terminal_output` | 写 console emitters；读 developer_terminal | `v4.console.terminal_output` | 只有 console projection owner 写；terminal 只读 |
| `v3.server.request_identity` | 写 `V3RequestIdCounter::next_request_identity`；读 console counters | `v4.server.request_identity` | 只有 server 生成；console 只读；禁止 provider/client |
| `v3.error.raw_wire_evidence` | 写 failure-scoped evidence；release 于 client frame EOF/error/drop | `v4.error.raw_wire_evidence` | 只有 server 在失败终态落盘；只读给 incident replay |

### 禁止边（debug 全域）

以下边在 V3 中已锁定禁止，V4 保持禁止：

```text
debug.* -> provider wire payload        （禁止）
debug.* -> client wire payload          （禁止）
debug.* -> business request/response payload（禁止）
debug.* -> MetadataCenter               （禁止；V3 已显式 may_enter_metadata_center=false）
debug.* -> live runtime input           （禁止）
debug.* -> control decision             （禁止）
```

机器合同见 `v4/contracts/debug-subscription.contract.json` 和 `v4/contracts/node-graph.contract.json`。

## 落地顺序

1. 冻结本文件的 node family / edge kinds / debug 资源关系；
2. `node-graph.contract.json` 和 `debug-subscription.contract.json` 作为机器真源；
3. V4 Rust 实现按 node graph 生成 builder/parser 与订阅注册；
4. 每个 edge 接一个红测（未声明边、非相邻 data edge、control 入 payload、debug 入 live path 必须红）；
5. `v4-resource-operation-map.yml` 的 debug 资源从 `design` 提升为 `anchored` 后再允许实现。
