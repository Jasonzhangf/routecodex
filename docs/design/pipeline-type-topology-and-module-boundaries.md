# Pipeline Type Topology and Module Boundaries

本文是 RouteCodex 本地项目的全局流水线类型拓扑真源。目标是把关键数据结构按模块、阶段、节点位置唯一命名，并用类型、builder/parser、运行时红测共同禁止 AI 或人工修改时绕过流水线。

## 1. 总原则

1. Hub Pipeline 主链只允许六段：`req_inbound -> req_chatprocess -> req_outbound -> resp_inbound -> resp_chatprocess -> resp_outbound`。
2. 节点类型命名必须表达模块、阶段、序号、语义：`<Module><Phase><NN><Node>`。
3. 节点序号表达拓扑位置，不表达版本号。
4. 每个节点类型只能有一个 owning builder/parser 文件。
5. Metadata、Error、Debug、Snapshot、Provider runtime state 不能伪装成正常 req/resp payload。
6. 新增中间节点默认禁止；确需改变中段语义时只能开启新 chain version 或链尾追加，并写清旧链物理删除计划。

## 1.1 Control / Data 双接口

每个标准节点必须同时声明两个接口：

- `ControlIn` / `ControlOut`：只允许承载 `metadata`、`route`、`error`、`policy`、`effect` 指令。禁止出现 `body`、`payload`、`messages`、`input`、`tools`、`tool_calls`、`providerPayload`、`wirePayload`、`clientPayload`、`responsePayload`。
- `DataIn` / `DataOut`：只允许承载业务 payload。禁止混入 `metadata`、`metaCarrier`、`runtimeMetadata`、`errorCarrier`、debug/snapshot carrier 或 provider runtime state。

Rust online contract help 是双接口真源：`describeHubPipelineContractsJson`、`describeVirtualRouterContractsJson`、`describePipelineContractJson(nodeId)` 必须返回 `controlIn`、`controlOut`、`dataIn`、`dataOut`。TS 只能读取这些 contract 结果做测试/诊断，不得重建 contract 语义。

## 2. 命名规范

### 2.1 类型命名模板

```text
<Module><Phase><NN><Node>
```

- `Module`：`Server` / `Hub` / `Vr` / `Provider` / `Error` / `Meta` / `Snapshot`。
- `Phase`：Hub 主链固定为 `ReqInbound` / `ReqChatProcess` / `ReqOutbound` / `RespInbound` / `RespChatProcess` / `RespOutbound`；其它模块使用 `Route` / `Err` / `Meta` / `Snapshot`。
- `NN`：两位十进制拓扑序号，如 `01`、`02`、`03`。
- `Node`：稳定语义名，如 `ClientRaw`、`Standardized`、`Governed`、`SelectedTarget`、`WirePayload`。

示例：

```text
ServerReqInbound01ClientRaw
HubReqInbound02Standardized
HubReqChatProcess03Governed
VrRoute04SelectedTarget
HubReqOutbound05ProviderSemantic
ProviderReqOutbound06WirePayload
ProviderRespInbound01Raw
HubRespChatProcess03Governed
ServerRespOutbound05ClientFrame
ErrorErr03RuntimeClassified
MetaReq02RuntimeCarrier
```

### 2.2 Builder / Parser 命名

转换函数必须写出相邻来源和目标：

```text
build_<target_module>_<target_phase>_<target_nn>_from_<source_module>_<source_phase>_<source_nn>
parse_<target_module>_<target_phase>_<target_nn>_from_<source_module>_<source_phase>_<source_nn>
project_<target_module>_<target_phase>_<target_nn>_from_<source_module>_<source_phase>_<source_nn>
```

允许：

```text
build_hub_req_inbound_02_from_server_req_inbound_01
build_hub_req_chatprocess_03_from_hub_req_inbound_02
build_hub_req_outbound_05_from_vr_route_04
build_server_resp_outbound_05_from_hub_resp_outbound_04
```

禁止：

```text
normalizeRequest
convertPayload
processMessages
buildProviderPayloadFromRawBody
metadataToProviderOptions
```

### 2.3 现有旧名迁移规则

当前代码里仍存在历史阶段名 `req_process` / `resp_process`。从本文生效后：

1. 新类型、新 builder/parser、新文档目标一律使用 `ReqChatProcess` / `RespChatProcess`。
2. 旧文件名可阶段性保留，但不得新增旧命名 API 或旧命名数据结构。
3. 迁移时先加新类型骨架和 red test，再逐步移动实现，最后物理删除旧壳。
4. 任何把 `ChatProcess` 简写回泛化 `Process` 的改动视为拓扑退化。

## 3. 请求链拓扑

请求链是唯一进入 provider 的正常数据链，必须单向：

```text
ServerReqInbound01ClientRaw
  -> HubReqInbound02Standardized
  -> HubReqChatProcess03Governed
  -> VrRoute04SelectedTarget
  -> HubReqOutbound05ProviderSemantic
  -> ProviderReqOutbound06WirePayload
  -> ProviderReqOutbound07TransportRequest
```

### 3.0 请求清洗连接矩阵

| 节点 | 输入 | 输出 | 唯一清洗/构建职责 | 禁止连接 |
|---|---|---|---|---|
| `ServerReqInbound01ClientRaw` | HTTP request | captured raw envelope | 只捕获入口事实和当前闭环 metadata carrier | 直接连 provider runtime |
| `HubReqInbound02Standardized` | `ServerReqInbound01ClientRaw` | standardized Hub request | 协议解析、形状标准化、原始语义保留 | provider-specific 修补 |
| `HubReqChatProcess03Governed` | `HubReqInbound02Standardized` | governed Hub request | 工具治理、tool result 顺序、servertool/MCP/apply_patch 规则 | 协议转换、路由选择 |
| `VrRoute04SelectedTarget` | `HubReqChatProcess03Governed` | selected target/decision | 路由分类、quota/health、provider target 选择 | payload 修补、工具治理 |
| `HubReqOutbound05ProviderSemantic` | `VrRoute04SelectedTarget` + governed request | provider-neutral outbound semantic | Hub 出站语义定型，隔离 metadata/debug/error | provider-specific auth/transport |
| `ProviderReqOutbound06WirePayload` | `HubReqOutbound05ProviderSemantic` | provider wire body | Hub 语义到 provider protocol 编码 | metadata/debug/error 泄漏 |
| `ProviderReqOutbound07TransportRequest` | `ProviderReqOutbound06WirePayload` | HTTP/SDK transport request | auth/header/timeout/transport | Hub 工具治理 |

请求链清洗标准：每一跳只能减少歧义、增加显式类型，不得靠删除真实 payload 语义提速；内部观测数据只能进入 `Meta*` / `Snapshot*` carrier。

### 3.1 ServerReqInbound01ClientRaw

- 作用：HTTP body、headers、query、port context、client stream intent 的入口捕获。
- owning module：`src/server/handlers/*` 和 HTTP server entry glue。
- 禁止：工具治理、provider shape 修补、metadata 写入 provider payload。

### 3.2 HubReqInbound02Standardized

- 作用：入口协议解析，保留原始语义，生成 Hub 标准请求。
- owning module：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`。
- 禁止：吞非法工具顺序、伪造工具结果、跨请求恢复上下文。

### 3.3 HubReqChatProcess03Governed

- 作用：请求侧工具治理唯一入口，包括工具声明、tool result 顺序、servertool / MCP / apply_patch 治理。
- owning module：Rust Hub Pipeline req chatprocess blocks。
- 禁止：协议转换、provider-specific shape 修复、直接选择 provider。

### 3.4 VrRoute04SelectedTarget

- 作用：路由分类、provider target 选择、quota/health gate。
- owning module：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`。
- 禁止：改写 payload、处理工具结果、读取别的 port/server route pool 状态。

### 3.5 HubReqOutbound05ProviderSemantic

- 作用：把 governed Hub request 定型为 provider-neutral outbound semantic。
- owning module：Rust Hub Pipeline req outbound blocks。
- Responses compat 约束：`responses:crs` 的字段删改与通用 `instructions -> input`、tool normalization 必须由 Rust `req_outbound_stage3_compat` 完成；TS 只允许桥接 `runReqOutboundStage3CompatJson`。
- 禁止：生成 provider SDK options；禁止 metadata/debug/error 进入出站语义。

### 3.6 ProviderReqOutbound06WirePayload

- 作用：把 Hub 出站语义编码为具体 provider wire body。
- owning module：provider runtime request builder。
- 禁止：从 raw body / metadata.context 补 provider payload。

### 3.7 ProviderReqOutbound07TransportRequest

<!-- topology-only: this is an internal transport detail, not a mainline call map node -->
- 作用：auth、headers、timeout、HTTP/SDK transport options。
- owning module：`src/providers/core/runtime/` 与 provider-specific runtime。
- 禁止：Hub 工具治理、route 重选、metadata 进入 SDK options。

### 3.8 Direct Semantic Classification Side Chain

Same-protocol direct 不新增 Hub 请求主链中间节点。它使用独立 control side chain，最终只在现有 provider wire/client frame 边界执行已解析投影：

```text
ConfigDirect01AuthoringPolicy
  -> ConfigDirect02ValidatedPolicy
  -> VrDirect03ResolvedSemantics
      -> DirectReq04ProjectionPlan
          -> ProviderReqOutbound06WirePayload
      -> DirectResp05ProjectionPlan
          -> ServerRespOutbound05ClientFrame
```

节点合同：

| 节点 | 唯一职责 | 禁止 |
|---|---|---|
| `ConfigDirect01AuthoringPolicy` | provider/model 显式声明 `direct.semantics` | 多布尔开关、route/forwarder 重复声明 |
| `ConfigDirect02ValidatedPolicy` | 编译闭合枚举；缺省 `routing`；未知值 fail-fast；写 provider profile projection | 创建 request-scoped policy、runtime 猜测、兼容 fallback |
| `VrDirect03ResolvedSemantics` | real target 选定后唯一创建 request-scoped class/provenance | 修改 payload、provider 特例、MetadataCenter 取策略 |
| `DirectReq04ProjectionPlan` | 生成 request preserve/set 计划 | 重新读配置、Host 本地分支 |
| `DirectResp05ProjectionPlan` | 基于同一 resolved contract 生成 response passthrough/restore 计划 | 依赖 request projector 输出；用 `originalClientModel`、`payloadChanged` 或 response shape 猜模式 |

分类只有：

- `routing`：canonical provider model + route thinking；响应恢复 client-visible model。
- `passthrough`：client request model/thinking 原样上游；provider response model/thinking 原样客户端。

`direct.semantic_policy` 是 control contract，不得进入 provider/client normal payload。forwarder 只选择 real provider；分类必须在 forwarder resolve 之后完成。

## 4. 响应链拓扑

响应链是模型/provider 端进入 Hub，再由 Hub 投影到客户端的唯一正常数据链，必须单向。这里的 `Inbound` / `Outbound` 均以 Hub 为参照：`RespInbound` 表示 provider response 进入 Hub；`RespOutbound` 表示 Hub response 出到客户端入口协议。

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
```

### 4.0 响应清洗连接矩阵

| 节点 | 输入 | 输出 | 唯一清洗/构建职责 | 禁止连接 |
|---|---|---|---|---|
| `ProviderRespInbound01Raw` | provider HTTP/SSE/raw JSON | raw provider response | 只捕获模型/provider 原始响应事实 | 直接写 client |
| `HubRespInbound02Parsed` | `ProviderRespInbound01Raw` | parsed Hub response | provider raw -> Hub canonical response | 吞解析错误 |
| `HubRespChatProcess03Governed` | `HubRespInbound02Parsed` | governed Hub response | 响应侧工具治理、文本工具收割、servertool followup 判定 | 修请求侧历史污染 |
| `HubRespOutbound04ClientSemantic` | `HubRespChatProcess03Governed` | client protocol semantic | Hub 响应投影到客户端入口协议；`/v1/chat/completions` 必须是 Chat Completion shape，`/v1/responses` 必须是 Responses shape | provider 特例、吞上游错误、手工包装 Responses |
| `ServerRespOutbound05ClientFrame` | `HubRespOutbound04ClientSemantic` | Express JSON/SSE frame | client frame 写出、headers、SSE framing | metadata/runtime state 注入 client body |

响应链清洗标准：provider raw 先解析为 Hub 规范，再治理，再按入口协议投影到 client；任何错误必须转入错误链，禁止在响应链中伪装成正常成功 payload。

### 4.1 请求/响应闭环连接关系

```text
ServerReqInbound01ClientRaw
  -> HubReqInbound02Standardized
  -> HubReqChatProcess03Governed
  -> VrRoute04SelectedTarget
  -> HubReqOutbound05ProviderSemantic
  -> ProviderReqOutbound06WirePayload
  -> ProviderReqOutbound07TransportRequest
  -> upstream
  -> ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
```

闭环约束：

1. `requestId` / `pipelineId` / port / session scope 只能通过 `Meta*` carrier 串联，不得混入 provider wire payload。
2. `previous_response_id` 只能作为 continuation lookup key；lookup 成功后恢复本地 tool_call context，lookup 失败必须 fail-fast。
3. provider direct/passthrough 仍必须遵守出口不可见：internal metadata 不得进入 upstream，也不得进入 client response。
4. servertool followup 只能从 origin snapshot 重建，不得从当前污染 payload 猜测补齐。
5. 响应链方向永远是 provider/model inbound -> chatprocess -> client outbound；servertool 只代客户端执行本地工具，不拥有独立响应出口。

### 4.1.1 Servertool followup 子链拓扑

servertool 是 `HubRespChatProcess03Governed` 内部的响应治理子链，不是独立 pipeline，也不是 direct/provider 旁路。它只代客户端执行本地工具或发起正常 followup 请求；followup 响应仍从 provider/model 侧进入响应链，再投影到客户端：

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
      -> ServertoolResp03RuntimeAction
      -> ServertoolReq04FollowupBuilt
      -> HubReqInbound02Standardized
      -> HubReqChatProcess03Governed
      -> VrRoute04SelectedTarget
      -> HubReqOutbound05ProviderSemantic
      -> ProviderReqOutbound06WirePayload
      -> ProviderRespInbound01Raw
      -> HubRespInbound02Parsed
      -> HubRespChatProcess03Governed
      -> ServertoolResp03FollowupResult
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
```

| 节点 | 输入 | 输出 | 唯一职责 | 禁止连接 |
|---|---|---|---|---|
| `ServertoolResp03RuntimeAction` | `HubRespChatProcess03Governed` | runtime action/effect + chat-process payload carrier | 在 chat-process 标准态判断是否需要 servertool runtime/followup；只产出动作与 governed payload | 用 provider raw / client outbound / SSE payload 判定；直接构造 client frame；provider 特例 |
| `ServertoolReq04FollowupBuilt` | origin snapshot + runtime action | followup request | 基于 origin snapshot 构造正常 followup 请求 | 从当前污染 payload 猜测补齐；清洗工具列表 |
| `ServertoolResp03FollowupResult` | nested `HubRespChatProcess03Governed` | governed followup response | 选择 followup 结果作为后续响应真相 | 用 pre-followup 响应覆盖 requires_action/tool_use |
| `buildHubRespOutbound04FromHubRespChatProcess03` | `HubRespChatProcess03Governed` | `HubRespOutbound04ClientSemantic` | 唯一允许的 `03 -> 04` 相邻转换；按入口协议投影客户端 shape | servertool 专用 response projection；手写 Responses wrapper；直接写 SSE/client frame |

约束：

1. `servertoolRuntimeAction` 只允许作为 Rust effect plan 的 runtime action carrier；判定输入必须是 `HubRespChatProcess03Governed` chat 标准态。TS shell 只能执行 IO/reenter，不能判断工具语义。
2. followup 返回后，`HubRespOutbound04ClientSemantic` 的唯一输入是 post-servertool governed payload；禁止继续使用原始 native `streamPipe.payload` 或 pre-followup `clientPayload` 投影 SSE。
3. `finalChatResponse` 只表示 pre-followup governed response；`followupBody` / `ServertoolResp03FollowupResult` 一旦存在且非空，就是响应链进入 `HubRespOutbound04ClientSemantic` 的真相。
4. direct/provider passthrough 不得进入 servertool followup orchestration；followup 只能 relay 复入完整 Hub Pipeline。
5. `servertoolRuntimeAction.payload` 是 Rust 提供给 TS shell 的 chat-process payload；缺失必须 fail-fast，禁止回退到 client payload。
6. `/v1/responses` followup 的最终 client payload 必须由 `buildHubRespOutbound04FromHubRespChatProcess03` 投影为 Responses shape；顶层 `object=response`，不得返回 chat completion shape。
7. Chat Completions followup 不得被 Responses builder 包装；入口协议由相邻 builder 根据 `entryEndpoint` 判断。

### 4.2 ProviderRespInbound01Raw

- 作用：provider HTTP/SSE/raw JSON 的原始响应承载。
- owning module：provider runtime transport。
- 禁止：提前改写成 client response；禁止吞 SSE/JSON 解析错误。

### 4.3 HubRespInbound02Parsed

- 作用：provider 原始响应解析回 Hub 规范响应。
- owning module：Rust resp inbound blocks。
- 禁止：provider 特例外溢到 Hub 通用逻辑。

### 4.4 HubRespChatProcess03Governed

- 作用：响应侧工具治理唯一入口，包括文本工具收割、servertool followup、internal tool 剥离。
- owning module：Rust resp chatprocess blocks。
- 禁止：补请求侧历史污染；禁止从当前污染 payload 猜测 followup。

### 4.5 HubRespOutbound04ClientSemantic

- 作用：把 Hub 响应投影为入口协议语义。
- owning module：Rust resp outbound blocks。
- 禁止：吞上游错误；禁止 provider-specific client shape patch。

### 4.6 ServerRespOutbound05ClientFrame

- 作用：Express/SSE/JSON client frame 写出。
- owning module：`src/server/handlers/handler-response-utils.ts`。
- 禁止：把 internal metadata 或 runtime state 注入 client body。

## 5. 错误链拓扑

错误链与请求/响应链并列，不得伪装成正常 payload：

```text
ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

### 5.0 错误链连接矩阵 <!-- topology-only: ErrorErr04RouterPolicyApplied is a Router internal policy node, not a mainline call map edge -->

| 节点 | 输入 | 输出 | 唯一职责 | 禁止连接 |
|---|---|---|---|---|
| `ErrorErr01SourceRaised` | throw/error result | source error fact | 记录发生点、stage、provider/runtime context | 直接 retry/fallback |
| `ErrorErr02HostCaptured` | source error | provider error event carrier | Host 侧唯一组装 provider error event | 调用点手拼 event |
| `ErrorErr03RuntimeClassified` | captured event | recoverable/unrecoverable/special_400 | runtime/catalog 唯一分类 | message-only 分叉 |
| `ErrorErr04RouterPolicyApplied` | classified event | Router policy state/event | VR/Rust 唯一写 health/cooldown/reroute policy | direct/executor 自写 health |
| `ErrorErr05ExecutionDecision` | router policy result | retry/reroute/fail execution decision | 执行层只消费 policy decision | 重新分类或本地 cooldown |
| `ErrorErr06ClientProjected` | final failure | client error response | client-safe 错误投影 | secret/metadata/snapshot 泄漏 |

`ErrorErr05ExecutionDecision` 的 provider-error client projection gate 字段固定为：
`routePoolRemainingAfterExclusion: string[]`、`defaultPoolAvailable: boolean`、`policyExhausted: boolean`、`mayProject: boolean`。
`mayProject` / `policyExhausted` 只能由
`routePoolRemainingAfterExclusion.length === 0 && defaultPoolAvailable === false` 派生。
当 `defaultPoolAvailable=true` 时，即使当前 route pool 已耗尽，也必须继续回到 VR/default-pool planner，禁止进入 `ErrorErr06ClientProjected`。

错误链连接标准：错误可以引用 request/response 节点 id，但不能回写 req/resp 正常 payload；错误进入 client 前必须经过 `ErrorErr06ClientProjected`。

## 6. Metadata Carrier 拓扑

Metadata 是内部控制语义 carrier，不是正常请求/响应 payload：

```text
MetaReq01EntryCaptured
  -> MetaReq02RuntimeCarrier
  -> MetaRoute03RouteCarrier
  -> MetaResp04SameRequestCarrier
  -> MetaDone05Released
```

规则：

1. 只能在当前 request/response 闭环内存在。
2. 必须绑定 `requestId`、`pipelineId`、port/serverId、session/conversation scope。
3. 不得进入 provider body、SDK options、client response body、provider persistent state。
4. `previous_response_id` 是恢复 key，不是 orphan tool_result 通行证。
5. 闭环完成必须释放；持久化 continuation 只能保存恢复所需的 response id、provider key、scope、tool_call context，不保存 live metadata 对象。

## 7. 模块落点

### 7.0 Runtime contract help

- Rust 真源模块：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/`。
- Native help 入口：`describeHubPipelineContractsJson`、`describeVirtualRouterContractsJson`、`describeMetaCarrierContractsJson`、`describePipelineContractJson(nodeId)`。
- Rust/NAPI 入口：`describeHubPipelineContractsJson`、`describeVirtualRouterContractsJson`、`describeMetaCarrierContractsJson`、`describePipelineContractJson(nodeId)`；Host TS 不再镜像这些 contract help wrapper。
- 节点修改前必须先读在线 contract；修改后必须用 `validatePipelineNodeContractBoundaryJson` 或对应红测证明 data / meta / observation / error 未串位。

### 7.1 Hub Pipeline

- 目标目录：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`。
- 建议新增类型目录：`hub_pipeline_types/`。
- 文件模板：
  - `hub_req_inbound_01_raw_envelope.rs`
  - `hub_req_inbound_02_standardized.rs`
  - `hub_req_chatprocess_03_governed.rs`
  - `hub_req_outbound_05_provider_semantic.rs`
  - `hub_resp_inbound_02_parsed.rs`
  - `hub_resp_chatprocess_03_governed.rs`
  - `hub_resp_outbound_04_client_semantic.rs`
- 红测：`tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 与新增 `tests/red-tests/hub_pipeline_type_topology_contract.test.ts`。

### 7.2 Virtual Router

- 目标目录：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`。
- 类型模板：
  - `VrRoute01Features`
  - `VrRoute02ClassifiedIntent`
  - `VrRoute03CandidatePool`
  - `VrRoute04SelectedTarget`
  - `VrRoute05DecisionRecord`
- 禁止：Virtual Router 写 provider payload patch、tool result handling、session cross-port state。

### 7.3 Provider Runtime

- 目标目录：`src/providers/core/runtime/`。
- 类型模板：
  - `ProviderReqOutbound06WirePayload`
  - `ProviderReqOutbound07AuthApplied`
  - `ProviderReqOutbound08TransportRequest`
  - `ProviderRespInbound01RawTransport`
  - `ProviderRespInbound02DecodedProtocol`
- 禁止：Provider Runtime 重建 Hub 工具治理；provider-specific 差异只能在本 provider runtime 内完成。

### 7.4 Server Runtime

- 目标目录：`src/server/runtime/http-server/` 与 `src/server/handlers/`。
- 类型模板：
  - `ServerReqInbound01ClientRaw`
  - `ServerReqInbound02PipelineInput`
  - `ServerRespOutbound04DispatchPlan`
  - `ServerRespOutbound05ClientFrame`
- 禁止：Server handler 直接构造 provider wire body；禁止 server response 修复 Hub 历史污染。

### 7.5 Error Pipeline

- 目标目录：`src/providers/core/runtime/`、`src/server/runtime/http-server/executor/`、`src/server/utils/`。
- 类型模板：
  - `ErrorErr01SourceRaised`
  - `ErrorErr02HostCaptured`
  - `ErrorErr03RuntimeClassified`
  - `ErrorErr04RouterPolicyApplied`
  - `ErrorErr05ExecutionDecision`
  - `ErrorErr06ClientProjected`
- 禁止：错误对象回流成 request payload；禁止 message-only retry/failure branch。

## 8. 中间插节点规则

当前架构应尽量避免中间插节点。插节点会破坏全局命名、红测和开发者认知，因此默认不允许。

### 8.1 架构原则：避免插节点

新增中间节点通常说明当前节点职责边界没有定义清楚。优先做以下判断：

1. 如果只是清洗同一语义，放入当前节点内部 block，不新增拓扑节点。
2. 如果只是控制语义，放入 `Meta*` carrier，不新增 req/resp 节点。
3. 如果只是错误分类，放入 `Error*` chain，不新增 req/resp 节点。
4. 如果只是观测/debug/snapshot，放入 `Snapshot*` side-car，不新增主链节点。
5. 如果需要 provider-specific 兼容，放入对应 Provider Runtime，不新增 Hub/VR 节点。

### 8.2 新增命名处理规则

新增节点不得污染全局命名：

1. **禁止重编号**：旧 `04` 永远还是 `04`，所有既有类型名不因插入而变化。
2. **内部 block 优先**：同一阶段的新语义必须进入既有节点内部 block / validator / parser，不新增主链编号。
3. **carrier 优先**：控制、错误、观测语义分别进入 `Meta*`、`Error*`、`Snapshot*` carrier，不进入 req/resp 主链编号。
4. **新版本次选**：必须改变中段语义时，开启新 chain version，例如 `HubReqV2ChatProcess03Governed`，并写清旧链删除计划。
5. **链尾追加末选**：新增能力确实是新阶段，只能链尾追加，例如 `ProviderReqOutbound08TransportSigned`，不得插入中间。
6. **禁止临时编号**：禁止 `03b` / `03_1` / `03.5` / `03p5`。
7. **文档先行**：未在本文登记的新编号视为非法类型，红测应失败。

### 8.3 插节点审批清单

任何插节点 PR/任务必须同时满足：

1. 文档先改：本文拓扑表更新。
2. 类型先改：新增唯一节点类型和相邻 builder/parser。
3. 红测先红：旧跨节点 shortcut 或旧拓扑假设必须红。
4. 实现后绿：HTTP 黑盒 + Rust 单元/集成 + architecture scan 变绿。
5. 物理删除旧路：旧 DTO、旧转换、旧 TS shell 不得闲置保留。

## 9. 数据结构重命名阶段性目标

### Phase 0：文档与红测锁边界

- 目标：只建立真源文档、AGENTS 规则、skill 规则和拓扑 red test，不迁移生产数据结构。
- 产出：`hub_pipeline_type_topology_contract.test.ts` 扫描禁止旧泛名新增、跨节点转换、metadata 泄漏。
- 验收：red test 能对人为新增 `normalizeRequest` / `HubReqInbound02 -> ProviderReqOutbound06` shortcut 失败。

### Phase 1：Hub Request 三段类型骨架

- 目标：先落 `HubReqInbound02Standardized`、`HubReqChatProcess03Governed`、`HubReqOutbound05ProviderSemantic`。
- 产出：`hub_pipeline_types/` 类型文件与相邻 builder/parser 壳。
- 验收：现有请求链入口只能通过相邻 builder 生成下一节点；旧 `req_process` 名称不得新增 API。

### Phase 2：Hub Response 三段类型骨架

- 目标：落 `HubRespInbound02Parsed`、`HubRespChatProcess03Governed`、`HubRespOutbound04ClientSemantic`。
- 产出：响应侧类型文件与相邻 parser/projector。
- 验收：provider raw 不得直达 server client frame；响应错误必须进入 `Error*` 链。

### Phase 3：Virtual Router 与 Provider 接口收口

- 目标：让 `VrRoute04SelectedTarget` 只消费 `HubReqChatProcess03Governed`，让 provider runtime 只消费 `HubReqOutbound05ProviderSemantic` / `ProviderReqOutbound06WirePayload`。
- 产出：route decision 类型、provider wire payload 类型、metadata leak red test。
- 验收：Virtual Router 无 payload patch，Provider Runtime 无 Hub 工具治理。

### Phase 4：Error / Metadata carrier 闭环

- 目标：落 `Meta*` 与 `Error*` carrier，彻底禁止正常 req/resp payload 承载内部控制语义。
- 产出：metadata lifecycle red test、error projection red test。
- 验收：闭环结束 metadata 释放；client body / provider body / SDK options 均无 internal metadata。

### Phase 5：旧结构物理删除

- 目标：删除旧 DTO、旧泛名转换、旧 TS 壳和同义结构。
- 产出：删除 PR/commit 与 residue audit。
- 验收：`rg` 不再命中已废弃类型/函数；构建、Rust test、HTTP 黑盒绿。

## 10. 禁止模式扫描清单

建议新增 `tests/red-tests/hub_pipeline_type_topology_contract.test.ts`，扫描：

1. `metadata` / `responsesResume` / `__raw_request_body` 出现在 provider payload builder 输出。
2. `ServerReqInbound01` 直接构造 `ProviderReqOutbound06`。
3. `HubReqInbound02` 直接跳到 `ProviderReqOutbound06`。
4. `ProviderRespInbound01` 直接写 `ServerRespOutbound05`。
5. `ErrorErr*` 对象被 spread 到 request body 或 response body。
6. 关键目录新增泛名转换函数：`convertPayload`、`normalizeRequest`、`processMessages`。
7. 同一节点出现多个 owning builder/parser。
8. Hub Pipeline / Virtual Router 出现 provider-specific 分支。
9. 新增旧命名 `ReqProc` / `RespProc` / `req_process` / `resp_process` 数据结构或 API。
10. 新增临时编号 `03b` / `03_1` / `03.5` / `03p5`。
### 4.0 Client Metadata Boundary

- `metadata` is a protocol field when it belongs to a client-visible provider response shape; it is not forbidden by name alone.
- Internal carriers are forbidden by shape and scope: `Meta*` carrier fields, `__rt*`, `__routecodex*`, route controls, provider/runtime controls, snapshots, and error carriers must never enter `ServerRespOutbound05ClientFrame`.
- `router-direct`/`provider-direct` may bypass Hub Pipeline conversion, but they still pass through the same client-frame no-leak guard before JSON/SSE leaves the server.
- Cross-protocol projections that cannot represent all source fields in the target protocol must keep a typed source-semantics block instead of silently dropping fields.
