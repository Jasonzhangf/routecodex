# V4 Pipeline Abstraction Model

状态：`design`（模型已定义，完整性证明见 coverage matrix，实现未落地）

## 目标

把 RouteCodex 的所有流水线行为抽象为六个语义方向：**request / response / operation / information / control / data**。每个已有和未来的操作都必须能表达为“固定 skeleton 节点上的注册算子，消费/生产这六轴上的资源”。只有当六轴模型能覆盖 V3 全部 103 个资源与 V3 已验证行为时，才继续做 module/function/mainline registry 和 Rust 实现。

这不是替换 V3，而是给 V3 建立可验证的抽象面：V4 的目标是让“旧算子 + 新算子”在同一 skeleton 上共存，流程不变，行为由已编译的 operator manifest 选择。

## 六轴定义

| 轴 | 定义 | 内容 | 禁止 |
| --- | --- | --- | --- |
| `request` (R) | 请求侧流程面：client → hub → provider 方向的节点与行为 | entry parse、normalize、request chat process 治理、route/select 输入、outbound semantic、provider wire build、transport request | 响应/错误语义不得反向流入 |
| `response` (S) | 响应侧流程面：provider → hub → client 方向的节点与行为 | provider raw parse、response inbound、response chat process 治理、client semantic projection、client frame | 请求/控制状态不得混入响应语义 |
| `operation` (O) | 行为算子面：所有可执行动作的统一注册单元 | parse / validate / classify / select / build / project / govern / record / restore / release / freeze / publish / transport / snapshot / error 等 | 未注册算子不得执行；算子不得越节点短路 |
| `information` (I) | 事实知识面：编译/生成后不可变、只读消费 | config manifest、catalog、registry、binding matrix、capability truth、parity contract、verification manifest、build/index artifact、secret handle | runtime 不得改写；不得扫描 authoring 目录；不得混入 payload |
| `control` (C) | 控制语义面：typed side-channel 承载的全部控制状态 | route facts、selection plan、opaque target、error chain、scope、availability、stopless state、continuation ownership、lifecycle lock、session admission、provider action gate | 不得进入正常 payload / provider wire / client wire；不得被 payload 重建 |
| `data` (D) | 数据语义面：业务语义本身 | normal request/response payload、provider wire、client wire、SSE chunk/frame、websocket frame、protocol context、transport raw | 不得携带控制字段；不得由 debug snapshot 重建 |

## 关系模型

```text
                skeleton（固定节点链）
  request 链 + response 链 + error 链 + config/lifecycle 链
        |                                      |
        v                                      v
   节点 slot  <--- 注册 ---  operator（O 轴）
        |                        |        |
        v                        v        v
   consume: information (I) + control (C)
   transform: data (D)
   produce: data (D) + control (C) + records/index (I)
```

规则：

1. skeleton 节点是 contract，固定不重排；节点编号即位置。
2. 每个节点 slot 只允许注册声明过的 operator kind；节点本身不做业务语义。
3. operator 的 `consumes` / `produces` 必须全部是已注册资源（落在六轴之一）。
4. 同一节点可以同时注册旧算子与对新算子，但由已编译的 operator manifest 选出一个 active 算子；未 active 的算子保留注册但不执行。
5. 任何操作无法表达为 `(node, operator, inputs, outputs)` 或任何输入输出不属于六轴资源，即抽象模型不完整，不得继续实现。

## Operator 注册模型

```json
{
  "operator_id": "v4.provider.wire.build.v1",
  "operator_kind": "wire_build",
  "chain": "request",
  "node_id": "V4ProviderReqOutbound06WirePayload",
  "version": "0.1.0",
  "consumes": [
    "v4.request.provider_semantic",
    "v4.config.manifest",
    "v4.secret.provider_auth_handle"
  ],
  "produces": [
    "v4.request.provider_wire_payload"
  ],
  "compat": {
    "baseline": "v3.provider.responses_wire_payload",
    "target": "routecodex-v4-provider",
    "status": "replacing",
    "evidence": [
      "v4/experiments/evidence-record-xxx.json"
    ]
  }
}
```

### 兼容状态机

```text
baseline（V3 现状，只读对照）
  -> replacing（V4 新算子已在 Playground 验证，等待 promotion）
  -> active（已编译进 operator manifest，当前消费面）
  -> retired（不再启用，注册保留作为历史）
```

旧算子 + 新算子共存的具体含义：

- 两者都注册在同一个 `node_id` 下；
- `status: active` 只有一个，由已编译 manifest 决定；
- 新算子 promotion 前，manifest 仍指向旧算子，V3 行为不变；
- 新算子 `active` 后，旧算子 `retired`，但注册和冻结记录保留；
- 流程（skeleton）不需要因算子替换而改变。

## 六轴与 V3 资源的映射

完整映射见 `v4-v3-abstraction-coverage.yml`（103 个 V3 资源全部归类）。分类规则：

- `config_authoring / config_manifest / config_truth / catalog / registry / binding / parity / verification / build artifact / secret handle` → `information`；
- `normal_payload / provider_wire / client_transport / sse chunk/frame / websocket frame / protocol_context / validated_http_input` → `data`；
- `side_channel / control_contract / metadata_center / error chain / scope / availability / lifecycle / admission / provider_action_gate / diagnostic side-channel` → `control`；
- `debug artifact / event ledger / raw capture / snapshot / dry-run / console / observability` → `control`（`sub_axis: diagnostic`），并受“诊断不得进 live path”不变量约束；
- 资源本身不是算子；资源对应的 `owner_node` / builder / parser / gate 行为在 `operation` 轴登记为算子。

## 完整性门槛（Gate）

继续往下做之前必须满足：

1. `v4-v3-abstraction-coverage.yml` 覆盖 V3 全部 103 个资源，每个资源有唯一 axis 分类与 operator_kind，且 `status` 不等于 `unclassified`。
2. 每个 V3 关键行为（function map 中的 feature）能映射为至少一个 operator 注册；无法映射的 feature 记为 `GAP`，GAP 为 0 才能进入实现。
3. 六轴不变量机器可检查（`v4_parity_gate_v3_resource_coverage` 对 V3 覆盖层逐条校验，
   `v4_parity_gate_plane_isolation` 对 V4 目标图校验）：
   - 控制轴：V3 资源 `may_enter_provider_body=false` 且 `may_enter_client_body=false`
     （V3 覆盖层所有控制资源均禁入 body；V4 目标图唯一已登记控制→客户端例外是
     `v4.error.client_projection` 的派生错误投影，由 `v4_parity_gate_plane_isolation`
     校验 `client_visible_fields` 白名单）；
   - 数据轴：V3 资源不得声明控制字段——机器锁为 `allowed_writers` 不得包含控制/诊断轴
     owner（控制状态不得写入数据资源，debug/snapshot 不得重建数据资源）；
   - 诊断轴：`may_enter_provider_body=false` 且 `may_enter_client_body=false`，且
     `allowed_readers` 不得包含 live path owner；已登记例外仅两个诊断投影：
     `v3.debug.dry_run_execution -> V3Server16HttpFrame`（dry-run 终态投影）与
     `v3.runtime.responses_timing_observability -> V3ResponsesProtocolRelayHandoff /
     V3ResponsesProtocolDirectHandoff`（时序观测，只供 handoff 控制决策读取）。
4. operator registry 的 `consumes` / `produces` 引用完整性通过验证：每个引用的 resource_id 必须存在于资源注册表。
5. 当前 V4 资源图（21 个 target 资源）只是六轴模型的子集，必须与 coverage matrix 一起评审，不能单独作为全项目真源。

## 当前 V4 资源图的评价

前一轮的 21 个 V4 资源是**局部目标态**：只覆盖 D/C/I 轴的 target 边界，缺少：

- `operation` 轴的 operator registry 资源；
- request/response 链对 V3 资源的显式覆盖；
- continuation、transport、lifecycle、diagnostic、build/install 等域的 design 条目。

它们本身作为 target 边界是合理的，但不能回答“全项目 operation 是否已被抽象覆盖”。本轮新增的六轴模型与 coverage matrix 补齐这一层。

## 评估结论（相对 V3 骨架）

### 1. Skeleton 合理且可扩展

V3 已经采用“固定 chain + 每个固定节点的静态 hook slot + Control/Data 双接口 + 唯一 runtime kernel”：

- 请求链、响应链、错误链、config 链都是编号节点；
- 每个节点有唯一 owner builder/parser；
- 每个节点声明 `ControlIn/ControlOut` 和 `DataIn/DataOut`；
- hook 声明 `hook_id / hook_point / input_node / output_node / resources read / resources written / forbidden resources`；
- MetadataCenter 已有 scope 隔离的 register/consume/release；
- V3 system definition 明确“Flow modules register compile-time static hooks, no dynamic hook discovery or runtime plugin loading”。

因此我们的“节点 + 插件 + 接线 + 控制中心 + 订阅”模型不是另起炉灶，而是把 V3 已验证的骨架形式化为通用合同。**可扩展性的精确边界是：**

```text
节点可扩展：
  - 已发布 chain version 的节点不可插入、重排、复用编号；
  - 新增语义 = 新 chain version，或在已声明节点 slot 上注册新 operator；
  - 节点编号是 contract，发布/消费后不可变。

插件可扩展：
  - 每个 slot 可以注册多个 operator（旧算子 + 新算子）；
  - 已编译 wiring manifest 为每个 slot 选择唯一 active operator；
  - 新算子 promotion 只改 manifest，不改流程。
```

V3 的 `V3HubReqChatProcess04Governed` / `V3HubRespChatProcess03Governed`、Stopless Req04 注入与 Resp03 剥离、continuation 不可变区等已发布合同，在本模型下仍不可改语义。

### 2. 六轴抽象可覆盖 V3 全部操作

对 `docs/architecture/v3-resource-operation-map.yml` 的 103 个资源做了逐 kind 归类：

| 轴 | 资源数 | 主要 resource_kind |
| --- | --- | --- |
| `information` (I) | 23 | config_authoring 2、config_contract 4、config_manifest/source_identity/truth/transport_interval、resource_registry、provider_error_policy_manifest、catalog 2、secret_handle、verification_manifest 2、compiled capability/binding、side_channel_config、build/install artifact 3 |
| `data` (D) | 22 | normal_payload 4、provider_wire 2、transport 2、client_transport_projection 3、client_transport_handle、transport chunk/frame 4、protocol_context、provider_response、server_dispatch_projection、projection_resource 2 |
| `control` (C) | 44 | side_channel 25、control_contract 3、typed_route_fact_carrier、metadata_center_control_signal、runtime_control_* 4、transient_runtime_* 2、error_projection_plan、internal_control_state、runtime_identity_counter、listener_scoped_concurrency_gate、process_local_control_side_channel、borrowed_view、runtime_handle 2 |
| `control`（诊断子轴） | 14 | diagnostic 8、diagnostic_side_channel 3、diagnostic_control、bounded_diagnostic_artifact、failure_scoped_diagnostic_artifact |
| **合计** | **103** | 无 unclassified |

V3 function map 的 12 个 feature 全部可以表达为对应节点 slot 上的 operator 注册：config/registry、route classifier、SSE transport、provider compat profile、console/observability、timing、sample retention 等。没有发现六轴无法承载的行为。

**结论：抽象模型符合 V3 行为，可以采用。**

### 3. 采用时必须锁住的三条约束

这些约束不是可选项，违反任何一条都会退化为“第二流水线 / 控制入 payload / 决策面分裂”：

1. **插件闭环 ≠ 独立流水线**。插件拥有节点内完整的 typed closure（控制信息、状态机消息、信息流入流出），但 runtime kernel 仍是唯一 orchestrator；禁止插件拥有第二个 lifecycle 或 response exit。
2. **总线是通知/观测平面，不是决策平面**。V3 已明确规定 event bus / center 只负责传输事件，retry/reroute/backoff/fail 语义归唯一 owner。广播订阅只能用于 observability、diagnostics、notification、record；控制决策仍走直接 typed contract（Control Center 注册/消费/释放 + 状态机）。
3. **Control Center 不是数据面第二真源**。payload 字段不得从 Control Center 重建；客户端协议 metadata 不得搬进 Control Center 当控制信号；Control Center 只承载 RouteCodex 自己生成的内部控制信号，且按 scope 闭环释放。

## V4 具体架构模型

### 1. Skeleton（chain）

```text
request chain:    entry -> inbound -> chatprocess -> route/target -> outbound semantic -> provider wire -> transport
response chain:   provider raw -> resp inbound -> resp chatprocess -> continuation -> client semantic -> client frame
error chain:      source -> host captured -> classified -> router policy -> execution decision -> client projection
config chain:     authoring -> parse -> validate -> registry -> manifest
lifecycle chain:  declare -> lock -> identity -> controlled runtime
diagnostic chain: capture -> ledger -> snapshot -> query/project
```

每个 chain 有一个 `chain_version` 和固定节点序列表。节点编号即位置 contract：

```text
node_id := <Module><Chain><NN><Node>
```

### 2. 节点统一定义

每个节点声明：

```json
{
  "node_id": "V4ReqChatProcess03Governed",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "position": 3,
  "owner": "routecodex-v4-runtime",
  "input_node": "V4ReqInbound02Normalized",
  "output_node": "V4ReqExecution04Planned",
  "control_in": "V4Control01ScopeBoundCarrier",
  "control_out": "V4Control01ScopeBoundCarrier",
  "data_in": "v4.request.normal_payload",
  "data_out": "v4.request.normal_payload",
  "resources_read": ["v4.config.manifest", "v4.control.metadata_center"],
  "resources_written": ["v4.control.metadata_center"],
  "state_machine": {"in_events": ["restore_context"], "out_events": ["governed"]},
  "allowed_operator_kinds": ["chat_process"],
  "forbidden": ["provider_branch", "payload_patch", "second_lifecycle"]
}
```

### 2.1 BaseNode（原始节点基类）

所有节点共享同一个原始基类 `BaseNode`。业务节点只在基类上绑定节点语义（chain、position、operator、state machine），四个横切能力由基类内置，不允许具体节点各自实现一份。节点语义不是“链族直接实例化”，而是四层：

```text
BaseNode（横切能力）
  -> ChainFamily（request / response / error / config / lifecycle / control / diagnostic）
     -> RoleSubclass（inbound / chat process / outbound / ...，每个角色子类有自己的 allowed operators 与 config schema）
        -> NodeInstance（唯一 node_id，绑定唯一角色子类）
```

```text
BaseNode
  ├─ identity: node_id / chain / chain_version / position（不可变 contract）
  ├─ control_in: 接入 typed 控制信息
  ├─ control_out: 输出 typed 控制信息
  ├─ control_record: 每次 control_in / control_out 都写入不可变记录
  ├─ debug_subscriptions: 订阅 debug/诊断事件（只读通知）
  ├─ snapshot_subscriptions: 订阅节点生命周期快照（entry/exit/error，只读诊断）
  └─ statistics(optional): 可选节点统计（计数/耗时/错误/算子命中）
```

基类合同：

| 能力 | 语义 | 禁止 |
| --- | --- | --- |
| `control_in` | 节点从 Control Center 接入 typed 控制信息；接入即记录 | 直接从 payload 重建控制状态 |
| `control_out` | 节点向 Control Center 输出 typed 控制信息；输出即记录 | 把控制信息写入 payload |
| `control_record` | 每次接入/输出产生一条不可变 `ControlRecord`（node_id、direction、control_key、scope、payload_hash、sequence、timestamp） | 无记录执行、静默覆盖、跨闭环复用 |
| `debug_subscriptions` | 订阅 debug/诊断 topic，观察节点运行事实 | 订阅事件改变业务结果或控制决策 |
| `snapshot_subscriptions` | 订阅节点生命周期快照（entry/exit/error），诊断回放 | 快照进入 live path、由快照重建请求/响应 |
| `statistics` | 可选统计（调用次数、耗时、错误次数、算子命中），供 observability | 统计进入决策、进入 payload、成为业务 truth |

BaseNode 不拥有业务逻辑。具体节点的业务行为由该节点 slot 上注册的 operator 提供；BaseNode 只保证“每个节点都有统一的控制接入/输出、记录、订阅、统计”能力，且这些能力全部走 typed side-channel / diagnostic 面。

### 2.2 BaseNode 机器合同

```json
{
  "node_id": "V4ReqChatProcess03Governed",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "position": 3,
  "owner": "routecodex-v4-runtime",
  "input_node": "V4ReqInbound02Normalized",
  "output_node": "V4ReqExecution04Planned",
  "control_in": ["v4.control.side_channel", "v4.control.metadata_center"],
  "control_out": ["v4.control.metadata_center", "v4.control.route_facts"],
  "control_record_required": true,
  "debug_subscriptions": ["node_event", "state_transition", "diagnostic"],
  "snapshot_subscriptions": ["node_entry", "node_exit", "node_error"],
  "statistics_optional": true,
  "allowed_operator_kinds": ["chat_process"]
}
```

规则：

1. `control_record_required=true` 表示该节点每次 `control_in` / `control_out` 都必须先写入 `v4.control.record_ledger`，没有记录的接入/输出视为泄漏，必须 fail-fast。
2. `debug_subscriptions` / `snapshot_subscriptions` 只能消费 `v4.debug.bus_subscription` 和 `v4.debug.snapshot_subscription` 的只读事件，不得反向影响执行。
3. `statistics_optional` 为 `false` 的节点必须接入统计；统计值只允许 observability/records 读取。
4. 具体节点语义（data_in/data_out、resources、state machine）在基类之上继续按第 2 节声明；BaseNode 不增加业务字段。

### 3. 插件（operator）合同

插件是绑定到唯一节点的完整响应闭环，注册时必须声明：

- `operator_id` / `operator_kind` / `version` / `compat`；
- `consumes` / `produces`（只能是已注册资源，六轴之一）；
- **控制信息**：读取哪些控制资源、写出哪些控制资源、携带哪些 typed side-channel 字段；
- **状态机消息**：接收哪些事件（in_events）、发出哪些事件（out_events）、状态转换表；
- **信息流入流出**：data 流入/流出节点类型、information 只读资源、control 资源操作；
- 禁止项：跨节点 shortcut、payload/control 混合、fallback、动态代码加载、第二 lifecycle。

```json
{
  "operator_id": "v4.chat_process.relay_local.v1",
  "operator_kind": "chat_process",
  "node_id": "V4ReqChatProcess03Governed",
  "version": "0.1.0",
  "control_info": {
    "reads": ["v4.control.side_channel", "v4.control.metadata_center"],
    "writes": ["v4.control.metadata_center"],
    "carrier_fields": ["requestId", "pipelineId", "port", "sessionScope"]
  },
  "state_machine": {
    "in_events": ["continuation_restore_requested"],
    "out_events": ["continuation_restored", "governance_completed"],
    "transitions": [
      {"from": "idle", "event": "continuation_restore_requested", "to": "restoring"},
      {"from": "restoring", "event": "continuation_restored", "to": "governing"},
      {"from": "governing", "event": "governance_completed", "to": "done"}
    ]
  },
  "flow": {
    "data_in": "v4.request.normal_payload",
    "data_out": "v4.request.normal_payload",
    "information_read": ["v4.config.manifest"],
    "control_write": ["v4.control.metadata_center"]
  },
  "compat": {
    "baseline": "v3.req_chat_process",
    "target": "routecodex-v4-runtime",
    "status": "replacing"
  }
}
```

### 4. 接线（wiring manifest）

流水线数据接线由已编译的 wiring manifest 表达：

```json
{
  "chain_version": "v4-hub-1",
  "nodes": [
    {"node_id": "V4ReqInbound01ClientRaw", "active_operator": "v4.req_inbound.responses.v1"},
    {"node_id": "V4ReqInbound02Normalized", "active_operator": "v4.req_inbound.normalize.v1"},
    {"node_id": "V4ReqChatProcess03Governed", "active_operator": "v4.chat_process.relay_local.v1"}
  ],
  "edges": [
    {"from": "V4ReqInbound01ClientRaw", "to": "V4ReqInbound02Normalized", "adjacent": true},
    {"from": "V4ReqInbound02Normalized", "to": "V4ReqChatProcess03Governed", "adjacent": true}
  ]
}
```

规则：

- 节点顺序由 `chain_version` 决定，wiring manifest 不得改变；
- 每个 slot 的 `active_operator` 只能有一个；
- 旧算子与新算子同时注册，未 active 的不执行；
- promotion 只替换 `active_operator`，流程和节点编号不变。

### 5. Control Center

控制信息独立于流水线数据接线，由统一 Control Center 注册和消费：

```text
Control Center
  register(scope, control_key, state)
    -> scope 隔离校验
    -> 写入 typed control resource
  consume(scope, control_key)
    -> 校验 scope 与闭环身份
    -> 返回 typed control resource
  release(scope)
    -> 闭环结束释放，禁止跨闭环复用
```

Control Center 承载的控制域：route、target、error chain、availability、scope、continuation ownership、stopless/servertool state、lifecycle、admission、provider action gate。

### 6. 消息 / 订阅总线

广播信息与消息通过订阅完成：

```text
publisher（节点 operator / Control Center 状态机）
  -> 发布事件（node entered/left、state transition、diagnostic、observability、record）
  -> bus（topic + scope）
  -> subscribers（debug、console、metrics、records、review/evidence）
```

合同：

- bus 只承载通知、诊断、观测、记录事件；
- bus 不承载 payload，不参与路由/重试/continuation 判定；
- 订阅者不得基于 bus 事件修改业务结果或控制决策；
- 控制状态机的状态变更由 Control Center 直接写 typed resource；bus 只广播“已发生”的事实供观察者消费；
- bus 故障不得改变业务路径；诊断错误必须显式记录，不得静默。

## 下一阶段落地条件

1. 把本模型的 node/plugin/wiring/control-center/bus schema 固化为机器合同（`v4/contracts/pipeline-abstraction.contract.json`）。
2. 建立 `v4-v3-abstraction-coverage.yml`，覆盖 103 个 V3 资源（本轮已完成分类汇总，文件级映射下一步落地）。
3. 为每个 chain 建立 V4 target node 列表，与 `v4-resource-operation-map.yml` 的 21 个 target 资源核对。
4. 只有 coverage = 103/103、GAP = 0、red gate 接线后，才进入 module/function/mainline registry 与 Rust 实现。

标准节点族、节点图机器接线（data flow / control flow / debug subscription）和 debug 订阅按 V3 锁定的资源关系见 `v4-standard-nodes-and-node-graph.md`、`v4/contracts/node-graph.contract.json` 和 `v4/contracts/debug-subscription.contract.json`。
