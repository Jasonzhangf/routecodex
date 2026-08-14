# V4 Standard Nodes and Machine-Controlled Node Graph

状态：`design`（标准节点族和固定节点图继续有效；节点内部的 operator/hook/debug/snapshot/control 组合已由 [`v4-cordis-node-plugin-architecture.md`](v4-cordis-node-plugin-architecture.md) 修订为 Cordis NodeContainer 内的有序统一插件链；实现未落地）

## 目标

从 `BaseNode` 延伸出有限的标准节点族，让每条链的节点不是“自由发明”，而是实例化同一套标准节点。节点图本身必须是机器可读、机器可验证的合同：

- 节点清单（chains + nodes）；
- 数据流接线（data flow edges）；
- 控制流接线（MetadataCenter / Control Center 注册、消费、释放）；
- debug 订阅接线（只读订阅，禁止影响执行）。

任何代码级连接（struct 转换、builder/parser、订阅注册、Control Center 操作）必须能命中 node graph 中的已声明边；未声明即红灯。

## 标准节点族与角色子类

`BaseNode` 只定义横切能力（identity、control in/out、control record、debug/snapshot subscriptions、statistics）。节点不是“同一链族直接实例化”，而是四层：

```text
BaseNode（根，横切能力）
  -> ChainFamily（链族：request / response / error / config / lifecycle / control / diagnostic）
     -> RoleSubclass（角色子类：inbound / chat process / outbound / ...，每个角色子类有自己允许的算子集合与配置）
        -> NodeInstance（具体 node_id，绑定唯一角色子类 + 已注册算子）
```

关键修正：`RequestChainNode` 不能直接实例化出 inbound 和 outbound 两种不同职责的节点。它必须先派生角色子类：

- `RequestInboundNode`：允许 entry capture / protocol parse / normalize 类算子；
- `RequestContinuationNode`：允许 continuation classify / restore 类算子；
- `RequestChatProcessNode`：允许 request governance / tool governance 类算子；
- `RequestExecutionNode`：允许 execution plan / target resolve 类算子；
- `RequestOutboundNode`：允许 semantic projection / wire build / transport 类算子。

每个角色子类声明自己的 `allowed_operator_kinds` 和 `config_schema`。节点实例只能绑定一个角色子类，只能注册该子类允许的算子，只能消费该子类声明的配置。禁止把 inbound 算子注册到 outbound 节点，也禁止 outbound 节点使用 inbound 的配置。

### 链族

| 标准节点族 | 适用 chain | data 面 | 典型职责 | 禁止 |
| --- | --- | --- | --- | --- |
| `RequestChainNode` | `request` | 业务请求 payload | parse / normalize / chat process / outbound semantic | 控制字段进 payload、跨节点短路 |
| `ResponseChainNode` | `response` | 业务响应 payload | resp inbound / chat process / client semantic | 控制字段进 payload、provider raw 直连 client |
| `ErrorChainNode` | `error` | 无（只走 Error carrier） | source / classify / policy / decision / projection | 进入 provider/client payload、本地 retry 策略 |
| `ConfigChainNode` | `config` | 无（只走 information） | parse / validate / registry / manifest | runtime 写 authoring、manifest 入 payload |
| `LifecycleChainNode` | `lifecycle` | 无 | declare / lock / identity / controlled runtime | 拥有业务 payload、第二 lifecycle |
| `ControlCenterNode` | `control` | 无 | register / consume / release typed control resource | 数据面真源、payload 重建 |
| `DiagnosticChainNode` | `diagnostic` | 无 | trace / ledger / raw capture / snapshot / observability | 进入 live path、成为决策输入 |

### 角色子类（RoleSubclass）

| 角色子类 | 链族 | allowed_operator_kinds | data_in | data_out |
| --- | --- | --- | --- | --- |
| `RequestInboundNode` | request | `entry_capture` `protocol_parse` `normalize` | raw entry | normalized request |
| `RequestContinuationNode` | request | `continuation_classify` `continuation_restore` | normalized request | continuation facts |
| `RequestChatProcessNode` | request | `request_governance` `tool_governance` | normalized request | governed request |
| `RequestExecutionNode` | request | `execution_plan` `target_resolve` | governed request | resolved target/execution |
| `RequestOutboundNode` | request | `semantic_projection` `wire_build` `transport_build` | provider semantic | provider wire/transport |
| `ResponseInboundNode` | response | `raw_parse` `protocol_decode` | provider raw | parsed response |
| `ResponseChatProcessNode` | response | `response_governance` `tool_harvest` | parsed response | governed response |
| `ResponseContinuationNode` | response | `continuation_commit` `continuation_release` | governed response | continuation truth |
| `ResponseOutboundNode` | response | `client_semantic_projection` `frame_build` | client semantic | client frame |
| `ErrorSourceNode` | error | `error_source_capture` | error source | classified error |
| `ErrorClassifyNode` | error | `error_classify` | classified error | policy input |
| `ErrorPolicyNode` | error | `error_policy_apply` | policy input | decision input |
| `ErrorDecisionNode` | error | `execution_decision` | decision input | execution decision |
| `ErrorProjectionNode` | error | `client_projection` | execution decision | client error |
| `ConfigAuthoringNode` | config | `config_parse` `config_validate` | config source | validated contract |
| `ConfigRegistryNode` | config | `registry_build` | validated contract | resource registry |
| `ConfigManifestNode` | config | `manifest_publish` | resource registry | compiled manifest |
| `LifecycleDeclareNode` | lifecycle | `instance_declare` | lifecycle request | instance declaration |
| `LifecycleLockNode` | lifecycle | `operation_lock` | declaration | lock state |
| `LifecycleIdentityNode` | lifecycle | `identity_publish` | lock state | published identity |
| `LifecycleControlNode` | lifecycle | `controlled_runtime` | identity | runtime control |
| `DiagnosticTraceNode` | diagnostic | `trace_start` `trace_release` | execution scope | trace context |
| `DiagnosticLedgerNode` | diagnostic | `record_node_event` `query_ledger` | node event | ledger record |
| `DiagnosticCaptureNode` | diagnostic | `raw_capture` `payload_project` | raw payload | diagnostic artifact |
| `DiagnosticSnapshotNode` | diagnostic | `snapshot_start` `snapshot_record` `snapshot_release` | execution scope | snapshot session |
| `DiagnosticObservabilityNode` | diagnostic | `observe` `timing` | observation event | observability record |

角色子类的机器合同：

```json
{
  "role_id": "request_inbound",
  "family": "RequestChainNode",
  "data_plane": true,
  "allowed_operator_kinds": ["entry_capture", "protocol_parse", "normalize"],
  "config_schema": {
    "entry_protocols": ["responses", "anthropic", "gemini", "openai_chat"],
    "required": ["entry_protocols"]
  },
  "data_in_kind": "raw_entry",
  "data_out_kind": "normalized_request",
  "forbidden": ["wire_build", "client_projection", "control_into_payload"]
}
```

### NodeInstance 实例化模板

```text
<Chain><NN><SemanticName> : BaseNode + ChainFamily + RoleSubclass
```

实例必须继承：

- identity（chain、chain_version、position 不可变）；
- role（唯一角色子类；实例的 allowed operators 与配置受角色子类约束）；
- `control_in` / `control_out`（读写 typed control resource，接入/输出都有 ControlRecord）；
- `debug_subscriptions`（只读 debug topic）；
- `snapshot_subscriptions`（只读 entry/exit/error 快照）；
- `statistics`（可选观测）。

实例补充：

- `data_in` / `data_out`（仅 Request/Response 族有业务 payload；其他族为空）；
- `resources_read` / `resources_written`；
- 算子注册：实例可注册多个同角色算子（例如 `normalize.responses`、`normalize.anthropic`、`normalize.gemini`、`normalize.openai_chat`），但必须属于该角色子类的 `allowed_operator_kinds`；
- `config`：每个算子的配置实例必须通过该角色子类 `config_schema` 校验；
- `state_machine`（in/out events、transitions）。

### 不同协议的同一阶段

同一阶段 = 同一个 NodeInstance + 同一角色子类。不同协议只表现为该实例上注册的不同 operator：

| node 实例 | 角色子类 | 注册算子（同一 slot） |
| --- | --- | --- |
| `V4ReqInbound02Normalized` | `RequestInboundNode` | `normalize.responses.v1`、`normalize.anthropic.v1`、`normalize.gemini.v1`、`normalize.openai_chat.v1` |
| `V4ReqChatProcess03Governed` | `RequestChatProcessNode` | `request_governance.relay.v1`、`request_governance.direct.v1` |
| `V4ProviderReqOutbound06WirePayload` | `RequestOutboundNode` | `wire_build.responses.v1`、`wire_build.openai_chat.v1`、`wire_build.anthropic.v1`、`wire_build.gemini.v1` |

wiring manifest 为每个节点编译一条 ordered active plugin chain。协议 operator 属于显式互斥 `selection_group`，组内按 typed facts（entry protocol、provider wire protocol、continuation owner）恰好选择一个，不能按 provider id、model 前缀或 payload 猜测；组外的 control、governance、validator、debug、snapshot 等插件继续按节点自己的顺序执行。协议 operator 全部输出该角色子类声明的 `data_out_kind`，所以同一个节点实例可以被不同协议算子复用。

## 节点编号语义

节点编号同时表达两件事：

```text
node_id := <Chain><NN><SemanticName>
```

- `NN`：流程上的位置（order），表达该节点在链中的拓扑顺序；
- `<SemanticName>`：功能（function），表达该节点承担的角色语义；
- 位置和功能一起构成节点的身份 contract：发布后不可重排、不可复用、不可改语义；
- 新增语义 = 新 chain version，或已有节点 slot 上的新 operator；禁止 `03a` / `03_1` / `03.5` 临时编号。

每个流程上的节点至少是一个类：NodeInstance（继承 ChainFamily + RoleSubclass）加上 BaseNode 横切能力。节点类的实例化、算子注册、接线都受机器合同约束。

## V4 Hub 请求链标准流程

请求链语义按 Jason 锁定的流程固定为：

```text
Server (HTTP/server adapter)
  -> SSE In (client transport boundary; SSE -> JSON semantic)
  -> Inbound (protocol parse / normalize; JSON data plane)
  -> ChatProcess (超模块 / group supernode)
  -> Outbound (provider semantic projection)
  -> Compat (provider compat / wire adaptation)
  -> Provider SSE Out (provider transport boundary; JSON semantic -> SSE)
```

对应节点序列（chain version `v4-hub-1`）：

| position | node | 角色子类 | 数据面 | 说明 |
| --- | --- | --- | --- | --- |
| 01 | `V4ServerReqInbound01ClientRaw` | `RequestInboundNode` | raw entry | HTTP/server 入口捕获，只做 framing/context，不做语义 |
| 02 | `V4ServerSseIn02FrameBoundary` | `RequestInboundNode` | SSE frame -> JSON semantic | 客户端 SSE 传输边界；只把 SSE 解码为 JSON 语义帧，不解析业务语义 |
| 03 | `V4HubReqInbound03Normalized` | `RequestInboundNode` | JSON semantic | 协议解析、normalize，进入统一 JSON 数据面 |
| 04 | `V4HubReqChatProcess04Governed` | `RequestChatProcessNode`（group 超模块） | JSON semantic | 请求治理、工具治理、continuation restore、servertool hook；对外是一个超级节点 |
| 05 | `V4HubReqOutbound05ProviderSemantic` | `RequestOutboundNode` | JSON semantic | provider-neutral 出站语义定型 |
| 06 | `V4ProviderReqCompat06Compat` | `RequestOutboundNode` | JSON semantic | provider compat / wire adaptation，保持同一 JSON 语义面 |
| 07 | `V4ProviderSseOut07WireBoundary` | `RequestOutboundNode` | JSON semantic -> SSE frame | provider SSE 传输边界；只把 JSON 语义编码为 provider SSE，不做治理 |

### ChatProcess 超模块（group）

`V4HubReqChatProcess04Governed` 是请求链上的超模块：它是一个 group（超级节点），对外接口与单节点一致。内部按角色子类继续拆分子节点，例如：

```text
V4HubReqChatProcess04Governed (group)
  entry -> continuation restore -> request governance -> tool governance -> exit
```

内部子节点：

| 内部 position | node | 角色子类 | 职责 |
| --- | --- | --- | --- |
| 04.1 | `V4ChatProcess04ContinuationRestore` | `RequestContinuationNode` | 只读 continuation facts / restore |
| 04.2 | `V4ChatProcess04RequestGovernance` | `RequestChatProcessNode` | 请求侧治理（工具声明、顺序、规则） |
| 04.3 | `V4ChatProcess04ToolGovernance` | `RequestChatProcessNode` | 工具治理（servertool/MCP/apply_patch 规则） |

约束：

- group 对外只暴露 `V4HubReqChatProcess04Governed` 一个接口；
- 父链只能连接 group entry/exit；
- group 内部实现可替换，只要外部接口不变；
- servertool 等控制处理挂在 group entry/exit hook 上，不是独立流水线节点。

### Direct 路径的 SSE/JSON 边界

Direct 也走同一条请求链：SSE 只出现在两端传输边界，内部统一用 JSON 语义数据面：

```text
SSE In (client) -> JSON semantic (inbound/chatprocess/outbound/compat) -> SSE Out (provider)
```

这样做的原因：SSE 入口与 SSE 出口不直接耦合。SSE 只是传输边界，中间任何治理都在 JSON 语义面上发生；禁止 SSE frame 从入口直接 pipe 到出口，禁止在 SSE 层做业务/控制语义。

Direct/Relay 不改变这条链；它们只影响 operator 选择和 typed facts：

- Direct：同一协议直连，outbound/compat 选择 direct operator；
- Relay：RouteCodex 本地治理，chatprocess 选择 relay operator；
- 两端 SSE 边界永远由传输 adapter 独占，不拥有治理语义。

## V4 Hub 响应链标准流程（请求链镜像）

响应链是请求链的镜像，语义按 Jason 锁定的流程固定为：

```text
Provider SSE (provider transport boundary; SSE -> JSON semantic)
  -> Inbound (parse provider JSON semantic / normalize; JSON data plane)
  -> ChatProcess (超模块 / group supernode)
  -> Outbound (client semantic projection; JSON data plane)
  -> Client SSE (client transport boundary; JSON semantic -> SSE)
  -> Server (HTTP/server terminal frame)
```

对应节点序列（chain version `v4-hub-1`，响应侧与请求侧共用同一 chain version 的镜像语义）：

| position | node | 角色子类 | 数据面 | 说明 |
| --- | --- | --- | --- | --- |
| 01 | `V4ProviderSseIn01FrameBoundary` | `ResponseInboundNode` | provider SSE frame -> JSON semantic | provider SSE 传输边界；只把 SSE 解码为 JSON 语义帧，不解析业务语义 |
| 02 | `V4HubRespInbound02Parsed` | `ResponseInboundNode` | JSON semantic | 协议解析、raw/decode，进入统一 JSON 数据面 |
| 03 | `V4HubRespChatProcess03Governed` | `ResponseChatProcessNode`（group 超模块） | JSON semantic | 响应治理、工具收割、continuation save、servertool hook；对外是一个超级节点 |
| 04 | `V4HubRespOutbound04ClientSemantic` | `ResponseOutboundNode` | JSON semantic | client 协议语义定型；不做 provider 特例、不做 continuation 语义 |
| 05 | `V4ServerSseOut05FrameBoundary` | `ResponseOutboundNode` | JSON semantic -> SSE frame | 客户端 SSE 传输边界；只把 JSON 语义编码为 client SSE，不做治理 |
| 06 | `V4ServerRespOutbound06ClientFrame` | `ResponseOutboundNode` | client frame | HTTP/server 终止帧；唯一成功终止点 |

### RespChatProcess 超模块（group）

`V4HubRespChatProcess03Governed` 是响应链上的超模块：它是一个 group（超级节点），对外接口与单节点一致。内部按角色子类继续拆分子节点，例如：

```text
V4HubRespChatProcess03Governed (group)
  entry -> continuation commit -> response governance -> tool harvest -> exit
```

内部子节点：

| 内部 position | node | 角色子类 | 职责 |
| --- | --- | --- | --- |
| 03.1 | `V4ChatProcess03ContinuationCommit` | `ResponseContinuationNode` | continuation save（唯一 save 入口；进入不可变区前完成） |
| 03.2 | `V4ChatProcess03ResponseGovernance` | `ResponseChatProcessNode` | 响应侧治理（internal tool 剥离、provenance 处理） |
| 03.3 | `V4ChatProcess03ToolHarvest` | `ResponseChatProcessNode` | 工具收割（文本工具、servertool followup 判定） |

约束（与请求侧 group 一致）：

- group 对外只暴露 `V4HubRespChatProcess03Governed` 一个接口；
- 父链只能连接 group entry/exit；
- group 内部实现可替换，只要外部接口不变；
- servertool 等控制处理挂在 group entry/exit hook 上，不是独立流水线节点；
- continuation save 是响应链唯一允许的 save 点；`resp_chatprocess save -> req_chatprocess restore` 之间的不可变区禁止任何语义转换（沿用 V3 硬锁）。

### 响应链 SSE/JSON 边界

与请求链完全对称：SSE 只出现在两端传输边界，内部统一用 JSON 语义数据面：

```text
Provider SSE In -> JSON semantic (inbound/chatprocess/outbound) -> Client SSE Out -> Server frame
```

- provider SSE 入口与 client SSE 出口不直接耦合；禁止把 provider SSE frame 直接 pipe 到 client SSE；
- 所有响应治理（工具收割、internal tool 剥离、continuation save、servertool followup）都在 JSON 语义面上发生；
- Direct/Relay 不改变这条链；只影响 operator 选择（direct provider 解析/透传算子 vs relay 本地治理算子）；
- 两端 SSE 边界永远由传输 adapter 独占，不拥有治理语义；
- 错误路径显式进入 Error chain，禁止在 SSE 层吞错误或把错误 frame 当成功终态。

## 节点有序插件链

每个节点（普通节点和 group）都是 Cordis NodeContainer。operator、hook、debug、snapshot、control、validator 和 observer 使用统一 NodePlugin 合同；`phase` 和编译顺序表达入口、主体、出口和观测位置。以下旧式 entry/operator/exit 表达仍可作为 authoring 视图，但编译产物必须是一条统一有序插件链：

```text
entry hooks（进入节点 operator 之前执行）
  -> operator（节点主体）
  -> exit hooks（节点 operator 完成之后执行）
```

Hook 合同：

```json
{
  "hook_id": "hook.chatprocess04.entry.servertool",
  "node_id": "V4HubReqChatProcess04Governed",
  "kind": "entry",
  "position": 1,
  "owner": "routecodex-v4-servertool",
  "effect": "control_only",
  "resources_read": ["v4.control.side_channel", "v4.control.metadata_center"],
  "resources_written": ["v4.control.metadata_center"],
  "control_record_required": true,
  "debug_subscription": ["diagnostic"],
  "snapshot_subscription": ["node_entry"],
  "statistics_optional": true
}
```

规则：

1. hook 与 operator 都是 NodePlugin；`kind/effect/phase` 决定权限和位置，不能形成节点外的第二执行机制；
2. entry hooks 在 operator 前按 position 顺序执行；exit hooks 在 operator 后按 position 顺序执行；
3. hook 默认 `effect: read_only`（observability、debug、record）；需要写控制状态或业务语义的 hook 必须显式声明 `effect: control_only` 或 `effect: semantic` 并登记；
4. servertool 使用 `control_only` hook：在 chat process group 入口挂 Req04 注入、出口挂 Resp03 剥离（沿用 V3 已登记例外，禁止修改历史和 continuation 不可变区）；
5. hook 不得产生第二个 lifecycle、不得跨节点短路、不得改变节点编号；
6. 所有 hook 的 control in/out 都写 ControlRecord；debug/快照订阅只读；
7. hook 配置与注册必须机器声明；未声明 hook 不能执行；
8. hook 失败必须显式进入错误链，禁止 fallback/静默吞掉。

### 插件种类与执行位置

| 概念 | 拥有者 | 执行时机 | 作用 |
| --- | --- | --- | --- |
| operator plugin | NodeContainer（角色子类约束） | semantic phase | 完成该节点声明的局部语义转换，可有多个且有确定顺序 |
| control plugin | NodeContainer | admission/control phase | register/consume/release typed 控制资源，不写正常 payload |
| hook plugin | NodeContainer | entry/semantic/exit phase | 已登记横切处理和 servertool 当前轮投影 |
| debug/snapshot/observer plugin | NodeContainer | observation phase | 只读诊断、record、observability，不影响结果 |

同一个节点可以同时启用多个 operator 和其他插件，wiring manifest 编译节点自己的完整顺序。互斥协议/模式变体放入 selection group，组内恰好一个 active；其他插件不因该选择被排除。完整合同见 [`v4-cordis-node-plugin-architecture.md`](v4-cordis-node-plugin-architecture.md)。

## Group（聚合超级节点）

多个相邻节点可以组成一个 `group`。group 的对外接口与单节点接口完全一致：它实现同一个 NodeInstance 接口，父流水线把它当作一个普通节点来接线、调用、记录和测试。

```text
父流水线视角：
  group 是一个 NodeInstance（node_id / position / data_in / data_out / control_in / control_out /
  control_record / debug_subscriptions / snapshot_subscriptions / statistics）

group 内部视角：
  entry_node -> ... -> exit_node（相邻子节点子图）
```

### Group 机器合同

```json
{
  "group_id": "group.req.hub",
  "group_kind": "aggregate_supernode",
  "chain": "request",
  "chain_version": "v4-hub-1",
  "node_id": "V4HubReqGroup03",
  "position": 3,
  "external_interface": {
    "data_in": "v4.request.raw_entry",
    "data_out": "v4.request.normalized_request",
    "control_in": ["v4.control.side_channel", "v4.control.metadata_center"],
    "control_out": ["v4.control.metadata_center"],
    "control_record_required": true,
    "debug_subscriptions": ["node_event", "diagnostic"],
    "snapshot_subscriptions": ["node_entry", "node_exit", "node_error"],
    "statistics_optional": true
  },
  "entry_node": "V4ReqInbound01ClientRaw",
  "exit_node": "V4ReqInbound02Normalized",
  "nodes": [
    {"node_id": "V4ReqInbound01ClientRaw", "role_id": "request_inbound", "position": 1},
    {"node_id": "V4ReqInbound02Normalized", "role_id": "request_inbound", "position": 2}
  ],
  "edges": [
    {"from": "V4ReqInbound01ClientRaw", "to": "V4ReqInbound02Normalized", "adjacent": true}
  ]
}
```

### Group 合同规则

1. **接口等价**：group 的 `external_interface` 必须实现 NodeInstance 的同一接口；父链不区分普通节点与 group。这是“整体表现为一个节点”的机器含义。
2. **显式生命周期**：group 必须声明唯一 `entry_node` 和唯一 `exit_node`；外部只能从 entry 进入、从 exit 离开。
3. **聚合语义一致**：group 的 `data_in` 必须等于 entry 子节点的 `data_in`，`data_out` 必须等于 exit 子节点的 `data_out`；control 资源对外暴露必须显式声明。
4. **内部不可旁路**：父链禁止直接连接 group 内部子节点；内部子节点禁止直接连接 group 外部节点。
5. **不是第二流水线**：group 不拥有独立路由、独立错误出口或独立 lifecycle；错误仍进入父错误链。
6. **封装可替换**：group 内部实现可替换（子节点或算子变化），只要 `external_interface` 不变，父链不需要改变。
7. **展开等价**：编译期可以展开 group 为子节点序列用于 trace/测试，但展开前后外部语义必须等价（black-box equivalence）。

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

## 模块级 Debug 开关（动态 live 调试）

debug、snapshot、dry-run 与 route probe 都是**按模块/按节点动态可切换**的诊断控制面，不写死在代码里，也不要求重启。编译后的 manifest 只提供默认值；运行期通过控制面接口做 live 修改，每次修改必须落审计记录。

```json
{
  "switch_id": "switch.debug.v4_hub_req_chat_process04",
  "scope": {"module_id": "routecodex-v4-runtime", "node_id": "V4HubReqChatProcess04Governed", "chain_version": "v4-hub-1"},
  "kind": "debug",
  "level": "debug",
  "default_from_manifest": true,
  "dynamic_live_update": true,
  "audit_record_required": true
}
```

规则：

1. `kind` 只允许 `debug` / `snapshot` / `dry_run` / `route_probe`；`level` 只允许 `off` / `error` / `warn` / `info` / `debug` / `trace`。
2. 开关只影响诊断订阅的启停和采集范围，**禁止**影响业务结果、控制决策、payload 或路由事实。
3. 每次 live 修改必须写不可变审计记录（scope、kind、level、old/new 值、修改者、时间）。
4. 开关作用域按模块/节点 + 请求闭环 scope 隔离；禁止跨闭环泄漏。
5. 开关状态禁止进入 provider wire、client wire、正常 payload、MetadataCenter 和错误链。
6. 应用开关失败必须 fail-fast 并显式记录，禁止 silent strip / fallback。

## 错误中心（classify + audit）与路由控制出口

错误处理的职责分工固定为：

```text
任意节点 / operator / hook 出错
  -> error_intake（typed error facts + payload hash + typed context）
  -> V4ErrorCenter（只做 classify + audit，产出 classified error facts）
  -> V4Router（VR 基于 classified facts + payload cycle 做决策）
  -> v4.control.route_exit（typed 路由决策出口）
  -> switch / cooldown / reroute / terminal
```

错误中心只做两件事：

- **分类（classify）**：把 typed error facts 归一到统一 error class；
- **审计（audit）**：记录错误来源、stage、payload hash、scope，供可观测与复盘。

错误中心**不拥有**任何路由操作：

- 不选择 target、不切换 provider、不写 cooldown、不执行 retry/reroute；
- 不读取业务 payload 来补决策；只消费 error intake 的 typed facts + payload hash + typed context；
- 不写 provider wire / client wire / normal payload。

路由决策唯一 owner 是 VR。VR 拿到请求/响应错误后决定原始请求如何再次处理，决策从 `v4.control.route_exit` 出口发出，outbound 阶段只消费该出口的决策，不重新发明路由。

机器合同见 `v4/contracts/node-graph.contract.json` 的 `error_intake` / `error_center` / `route_exit`。

## Payload 生命周期（请求周期）

原始请求/响应 payload 的生命周期由 `v4.lifecycle.payload_cycle` 统一管理：

```text
周期开始：请求发出（request_sent）
  -> 成功终了：响应进入客户端；发出下一个请求 = 新周期开始
  -> 错误终了：只有错误终态（error terminal）才算周期结束
  -> switch / cooldown / reroute：全部合并到同一个周期，原始请求不变
```

规则：

1. 一个请求发出后，无论经过多少次 switch / cooldown / reroute，只要原始请求 payload 不变，都属于同一个 `payload_cycle`。
2. 成功路径的周期在“响应进入客户端”时终了；下一个请求发出即开启新周期。
3. 错误路径只有到达错误终态（terminal）才终了；错误处理中的切换/冷却/重路由不是新周期。
4. 周期内原始请求 payload 禁止修改；重试重放的是同一原始 payload，禁止从控制状态重建 payload。
5. 周期状态只走 typed control resource，禁止进入 provider/client wire 或正常 payload。

机器合同见 `v4/contracts/node-graph.contract.json` 的 `payload_cycle`。

## 模块级 Dry-run

每个模块都支持 dry-run；dry-run 定义**链的入口和出口**，输入是正确负载 fixture：

```text
显式定义 entry/exit：
  module A dry-run: entry = V4HubReqInbound03Normalized, exit = V4HubReqOutbound05ProviderSemantic
  -> 只跑这一段，输入 fixture 必须是 entry 声明 data_in 的正确负载

不定义 entry/exit：
  -> 默认跑完整请求链或完整响应链
  -> 请求链输入 = 原始请求正确负载；响应链输入 = provider 原始响应正确负载
```

规则：

1. dry-run 是诊断面，禁止作为 live runtime 输入，禁止真实 provider 调用（no-network）。
2. fixture 必须匹配链入口声明的 `data_in_kind`；入口不匹配即 fail-fast。
3. dry-run 产出 typed 证据（输入 hash、entry/exit、算子结果、终态），不写 provider wire / client wire。
4. dry-run 失败显式记录；禁止 fallback 到 live 执行。
5. dry-run 的启停由模块级 debug 开关（`kind: dry_run`）控制。

## 模块 Mock 先行（逐模块重建资源文件）

资源文件（`v4-resource-operation-map.yml`）不再一次性全量重写，而是按功能逐模块重建；每个模块**先出 contract-complete mock**，mock 验证通过后才允许实现。mock 是合同骨架与测试 harness，不是 runtime 路径，也不是 fallback。

### Mock 必须完整声明

```text
module mock
  ├─ module_id / owner_crate / chain / chain_version
  ├─ baseline_feature_ids / baseline_resources（V3 参考，逐条回链）
  ├─ nodes（node_id + position + role_id + allowed_operator_kinds + info/data I/O）
  ├─ edges（data_flow / information_flow / control_flow / debug_subscription / error_intake）
  ├─ resources_read / resources_written（全部命中资源注册表或显式新增回链 V3）
  ├─ control_in / control_out（BaseNode 能力，ControlRecord 必写）
  ├─ error_intake（每个节点必须有 typed facts + hash 错误入口）
  ├─ debug_switch（kinds / levels / dynamic live / audit）
  ├─ dry_run_chain（entry/exit 定义；不定义 = 完整请求/响应链）
  └─ test_semantics（标准测试面）
```

### 完整性 Gate（mock 通过门槛）

| gate | 规则 |
| --- | --- |
| `MOCK-GATE-01` | 边 from/to 全部命中本模块 nodes 与已发布 node graph |
| `MOCK-GATE-02` | resources_read/written 全部命中资源注册表或显式新增并回链 V3 baseline |
| `MOCK-GATE-03` | 节点 role_id 与 allowed_operator_kinds 命中角色子类合同 |
| `MOCK-GATE-04` | 同 chain 内信息/数据流只允许相邻节点 |
| `MOCK-GATE-05` | 每个节点必须声明 error_intake，未声明即红灯 |
| `MOCK-GATE-06` | 每个模块必须声明 debug_switch 与 dry_run_chain |
| `MOCK-GATE-07` | 控制资源不得出现在 data/information 边；信息/数据资源不得出现在 control 边 |
| `MOCK-GATE-08` | 模块 mock 通过标准测试语义 |
| `MOCK-GATE-09` | mock 禁止进入 runtime 消费路径 |
| `MOCK-GATE-10` | 新增 V4 资源必须回链 V3 baseline；无 baseline 必须显式标注理由 |

机器合同见 `v4/contracts/module-mock.contract.json`。

### 第一个模块：config（v4-config-1）

config 是第一个重建模块：无业务 payload 依赖、信息轴、V3 已有完整链参考。mock 见 `v4/contracts/mocks/config.module.mock.json`：

```text
V4Config01AuthoringFileSource
  -> V4Config02AuthoringParsed
  -> V4Config03SchemaValidated
  -> V4Config04ResourceRegistryBuilt
  -> V4Config05ManifestPublished（唯一终端）
```

关键点：

- config 链是 `data_plane=false`，节点之间用 **information_flow** 边传递信息轴资源，不走 data/control 边；
- 每个节点都有 error_intake 进错误中心（config 解析/校验失败显式暴露，无 fallback）；
- 模块级 debug 开关支持 live 修改；dry-run 定义 `entry=V4Config01AuthoringFileSource`、`exit=V4Config05ManifestPublished`，输入为 config authoring fixture；
- runtime 只消费 `V4Config05ManifestPublished` 的编译产物；authoring 目录扫描、manifest 写入、secret 入 manifest 全部禁止。

## 流水线显式生命周期与标准测试语义

每条链必须有显式的节点 + 边，从起始节点到终止节点构成完整生命周期：

```text
entry node -> ... -> terminal node（成功路径）
            + 错误路径 -> Error chain（显式，不隐藏出口）
```

### 链级标准测试语义

| 测试 | 语义 | 正例 | 反例（必红） |
| --- | --- | --- | --- |
| `chain_entry_contract` | 链只有一个显式入口 | 请求链从 `V4ReqInbound01ClientRaw` 进入 | 从中间节点进入、双入口 |
| `chain_terminal_contract` | 链只有一个成功终止点 | 响应链终止于 `V4ServerRespOutbound05ClientFrame` | 中途返回、多个成功出口 |
| `chain_edge_complete` | 从 entry 到 terminal 每条相邻边都声明 | 所有 data edge 存在 | 缺边、跨节点短路 |
| `chain_error_path` | 错误显式进入 Error chain | provider 错误进 `V4Error01SourceRaised` | 错误被吞、伪装成成功 |
| `chain_group_equivalence` | 展开 group 前后行为等价 | 展开后测试结果一致 | 展开改变语义 |

### 分层测试与冻结（BaseNode -> Edge -> 模块派生）

测试按派生层次分层，每一层有自己完整的测试链；**基础层测试通过后冻结，派生层在冻结基础上实现，测试通过后再冻结**。debug 面与测试分层完全一致。

```text
L0 BaseNode 基础层（横切能力，不绑定任何业务节点）
  -> 全部测试通过 -> BaseNode 冻结
L1 Edge 边层（data_flow / information_flow / control_flow / debug_subscription / error_intake）
  -> 全部测试通过 -> 边合同冻结
L2 模块派生层（NodeInstance / group / 模块链，绑定已冻结的 L0 + L1）
  -> 全部测试通过 -> 模块冻结
```

#### L0：BaseNode 测试链

| 测试 | 语义 |
| --- | --- |
| `base_node_control_in_out_record` | control_in/out 每次写不可变 ControlRecord；缺记录即红 |
| `base_node_debug_subscription_read_only` | debug 订阅只读；不改变业务结果或控制决策 |
| `base_node_snapshot_subscription_diagnostic` | snapshot 订阅只读诊断；不进 live path |
| `base_node_statistics_observability_only` | 统计只供观测；不进决策、不进 payload |
| `base_node_debug_switch_diagnostic_only` | BaseNode 级 debug 开关只影响诊断；live 修改必须落审计 |
| `base_node_dry_run_support` | BaseNode 声明 dry-run 能力；节点主体可被正确 fixture 驱动，no-network |
| `base_node_no_business_logic` | BaseNode 无业务逻辑；业务行为只来自注册算子 |

冻结条件：L0 全部通过。冻结后，BaseNode 横切能力只能在 Playground 中修改，派生模块不得绕过。

#### L1：Edge 测试链

| 测试 | 语义 |
| --- | --- |
| `edge_data_flow_adjacent_only` | data_flow 只允许相邻节点 |
| `edge_data_flow_resource_axis` | data_flow 只承载 data 轴资源 |
| `edge_information_flow_adjacent_only` | information_flow 只允许 data_plane=false 链相邻节点 |
| `edge_information_flow_resource_axis` | information_flow 只承载 information 轴资源 |
| `edge_control_flow_record_required` | control_flow 必须 record_required=true |
| `edge_control_flow_scope_isolation` | control_flow 按 scope 隔离；跨闭环复用即红 |
| `edge_debug_subscription_read_only` | debug_subscription 边 read_only=true |
| `edge_error_intake_typed` | error_intake 携带 error_stage + payload_hash + typed_context 并指向错误中心 |
| `edge_forbidden_edges` | 禁止边全量声明且不可覆盖；未登记新边即红 |

冻结条件：L1 全部通过。冻结后新增边只能走新 chain_version 或已声明边。

#### L2：模块派生测试链

L2 继承 L0 的横切能力测试与 L1 的边合同测试，再加模块自身的：

- `node_entry_contract` / `node_exit_contract` / `node_success_projection` / `node_error_projection` / `node_control_record`；
- `node_debug_switch_diagnostic_only` / `node_error_intake_typed`；
- `chain_entry_contract` / `chain_terminal_contract` / `chain_edge_complete` / `chain_error_path`；
- group 测试（有 group 的模块）：`group_external_contract` / `group_internal_wiring` / `group_no_shortcut` / `group_expansion_equivalence`。

冻结条件：L2 全部通过后模块冻结。冻结只锁合同与实现基线，不锁业务算子；新算子仍可注册到已冻结节点 slot。

#### 分层 debug

debug 与测试分层完全一致，每层有自己的开关面与观测面：

| debug 层 | 观测面 | 开关 |
| --- | --- | --- |
| `base_node_debug` | ControlRecord 流、订阅事件、开关状态、dry-run 能力 | `v4.debug.module_switch` scope=base_node |
| `edge_debug` | 接线命中、相邻性、资源轴校验、error intake 完整性 | `v4.debug.module_switch` scope=edge |
| `module_debug` | 模块内节点/算子执行、快照、dry-run、route probe | `v4.debug.module_switch` scope=module_id |

### BaseNode freeze regression

BaseNode freeze admission requires the `v4-base-node-l0-regression` report. Unit and focused tests may use whitebox-only checks; freeze regression and bug reproduction must include both whitebox internal-contract evidence and blackbox public-node behavior evidence. The report binds the exact source, contracts, public API, artifact, and dependency inputs.

After BaseNode is frozen, ordinary CI may disable repeated execution of this unchanged full suite. The suite and report remain present and verifiable. Any source, contract, public API, artifact, or dependency change invalidates the report and re-enables the regression gate before a new freeze.

规则：

1. 上层 debug 可以订阅下层 debug 事件（只读），下层不得依赖上层观测；
2. 所有 debug 层禁止进入 live path、payload、MetadataCenter、错误链决策面；
3. 每层 debug 开关 live 修改必须落不可变审计记录。

机器合同见 `v4/contracts/test-layers.contract.json`。

### 节点级标准测试语义

每个 NodeInstance（普通节点或 group 超级节点）必须通过：

| 测试 | 语义 |
| --- | --- |
| `node_entry_contract` | 输入必须是声明的前置节点输出 |
| `node_exit_contract` | 输出必须被声明后继节点消费 |
| `node_success_projection` | 成功路径产生声明 data_out + control_out + ControlRecord |
| `node_error_projection` | 错误路径产生显式错误，进入错误链 |
| `node_control_record` | 每次 control in/out 写 ControlRecord |
| `node_debug_subscription_read_only` | debug/快照订阅不改变执行 |
| `node_statistics_optional` | 统计不进决策、不进 payload |
| `node_debug_switch_diagnostic_only` | 模块级 debug/snapshot/dry-run/route_probe 开关只影响诊断；live 修改必须落审计 |
| `node_error_intake_typed` | 节点/operator/hook 出错以 typed error facts + payload hash 进入错误中心，禁止携带完整业务 payload 重建决策 |
| `node_route_exit_consumer` | 路由决策只消费 `v4.control.route_exit`；节点不得自行发明路由/切换/重试 |
| `node_payload_cycle_boundary` | 请求 payload 周期内原始 payload 不变；switch/cooldown/reroute 合并同一周期 |

### Group 级标准测试语义

group 作为超级节点，除继承节点测试外还必须通过：

| 测试 | 语义 |
| --- | --- |
| `group_external_contract` | 外部接口与 NodeInstance 接口一致；data/control 聚合语义正确 |
| `group_internal_wiring` | 内部子节点全部有相邻边，无孤立节点 |
| `group_no_shortcut` | 外部不能连内部，内部不能连外部，只能走 entry/exit |
| `group_no_second_lifecycle` | group 不拥有独立路由/错误出口/lifecycle |
| `group_encapsulation` | 内部实现替换后，只要外部接口不变，父链行为不变 |
| `group_expansion_equivalence` | 展开前后外部语义等价 |

这些测试是每个节点/group/chain 的标准测试面；实现必须为每个已发布节点和 group 生成对应测试，未生成的节点/group 不得标记为 anchored。

## 落地顺序

1. 冻结本文件的 node family / role subclass / group / edge kinds / debug 资源关系；
2. `node-graph.contract.json` 和 `debug-subscription.contract.json` 作为机器真源；
3. 冻结模块级 debug 开关、错误中心（classify + audit）、路由控制出口与 payload 生命周期合同；
4. 为每个模块落地 dry-run 链入口/出口定义（不定义 = 完整请求/响应链）；
5. V4 Rust 实现按 node graph 生成 builder/parser 与订阅注册；
6. 每个节点/group/chain 生成标准测试面；
7. 每个 edge 接一个红测（未声明边、非相邻 data edge、control 入 payload、debug 入 live path、error intake 不带 typed facts、group 短路必须红）；
8. `v4-resource-operation-map.yml` 的 debug 资源从 `design` 提升为 `anchored` 后再允许实现。
