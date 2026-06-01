# Pipeline Type Topology and Module Boundaries

本文是 RouteCodex 本地项目的全局流水线类型拓扑真源。目标是让关键数据结构按方向和节点位置唯一命名，靠类型、builder/parser、运行时红测共同禁止 AI 或人工修改时绕过流水线。

## 1. 总原则

1. 关键链路只允许单向相邻转换：`NN -> NN+1`。
2. 节点类型命名必须表达模块、方向、序号、语义：`<Module><Direction><NN><Node>`。
3. 节点序号表达拓扑位置，不表达版本号。
4. 每个节点类型只能有一个 owning builder/parser 文件。
5. Metadata、Error、Debug、Snapshot、Provider runtime state 不能伪装成正常 req/resp payload。
6. 新增中间节点默认禁止；确需新增必须走本文第 8 节的拓扑变更流程。

## 2. 命名规范

### 2.1 类型命名模板

```text
<Module><Direction><NN><Node>
```

- `Module`：`Server` / `Hub` / `Vr` / `Provider` / `Error` / `Meta` / `Snapshot`。
- `Direction`：`ReqIn` / `ReqProc` / `ReqOut` / `Route` / `RespIn` / `RespProc` / `RespOut` / `Err` / `Meta`。
- `NN`：两位十进制拓扑序号，如 `01`、`02`、`03`。
- `Node`：稳定语义名，如 `ClientRaw`、`Standardized`、`Governed`、`SelectedTarget`、`WirePayload`。

示例：

```text
ServerReqIn01ClientRaw
HubReqIn02Standardized
HubReqProc03Governed
VrRoute04SelectedTarget
ProviderReqOut05WirePayload
ProviderRespIn06Raw
HubRespProc07Governed
ServerRespOut08ClientFrame
ErrorErr03RuntimeClassified
MetaReq02RuntimeCarrier
```

### 2.2 Builder / Parser 命名

转换函数必须写出相邻来源和目标：

```text
build_<target_module>_<target_direction>_<target_nn>_from_<source_module>_<source_direction>_<source_nn>
parse_<target_module>_<target_direction>_<target_nn>_from_<source_module>_<source_direction>_<source_nn>
project_<target_module>_<target_direction>_<target_nn>_from_<source_module>_<source_direction>_<source_nn>
```

允许：

```text
build_hub_req_in_02_from_server_req_in_01
build_hub_req_proc_03_from_hub_req_in_02
build_provider_req_out_05_from_vr_route_04
build_server_resp_out_08_from_hub_resp_proc_07
```

禁止：

```text
normalizeRequest
convertPayload
processMessages
buildProviderPayloadFromRawBody
metadataToProviderOptions
```

## 3. 请求链拓扑

请求链是唯一进入 provider 的正常数据链，必须单向：

```text
ServerReqIn01ClientRaw
  -> HubReqIn02Standardized
  -> HubReqProc03Governed
  -> VrRoute04SelectedTarget
  -> ProviderReqOut05WirePayload
  -> ProviderReqOut06TransportRequest
```

### 3.0 请求清洗连接矩阵

| 节点 | 输入 | 输出 | 唯一清洗/构建职责 | 禁止连接 |
|---|---|---|---|---|
| `ServerReqIn01ClientRaw` | HTTP request | captured raw envelope | 只捕获入口事实和当前闭环 metadata carrier | 直接连 provider runtime |
| `HubReqIn02Standardized` | `ServerReqIn01ClientRaw` | standardized Hub request | 协议解析、形状标准化、原始语义保留 | provider-specific 修补 |
| `HubReqProc03Governed` | `HubReqIn02Standardized` | governed Hub request | 工具治理、tool result 顺序、servertool/MCP/apply_patch 规则 | 协议转换、路由选择 |
| `VrRoute04SelectedTarget` | `HubReqProc03Governed` | selected target/decision | 路由分类、quota/health、provider target 选择 | payload 修补、工具治理 |
| `ProviderReqOut05WirePayload` | `VrRoute04SelectedTarget` + governed request | provider wire body | Hub 语义到 provider protocol 编码 | metadata/debug/error 泄漏 |
| `ProviderReqOut06TransportRequest` | `ProviderReqOut05WirePayload` | HTTP/SDK transport request | auth/header/timeout/transport | Hub 工具治理 |

请求链清洗标准：每一跳只能减少歧义、增加显式类型，不得靠删除真实 payload 语义提速；内部观测数据只能进入 `Meta*` / `Snapshot*` carrier。

### 3.1 ServerReqIn01ClientRaw

- 作用：HTTP body、headers、query、port context、client stream intent 的入口捕获。
- owning module：`src/server/handlers/*` 和 HTTP server entry glue。
- 禁止：工具治理、provider shape 修补、metadata 写入 provider payload。

### 3.2 HubReqIn02Standardized

- 作用：入口协议解析，保留原始语义，生成 Hub 标准请求。
- owning module：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`。
- 禁止：吞非法工具顺序、伪造工具结果、跨请求恢复上下文。

### 3.3 HubReqProc03Governed

- 作用：请求侧工具治理唯一入口，包括工具声明、tool result 顺序、servertool / MCP / apply_patch 治理。
- owning module：Rust Hub Pipeline req_process blocks。
- 禁止：协议转换、provider-specific shape 修复、直接选择 provider。

### 3.4 VrRoute04SelectedTarget

- 作用：路由分类、provider target 选择、quota/health gate。
- owning module：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`。
- 禁止：修补 payload、处理 tool result、读取其他端口或其他 session 状态。

### 3.5 ProviderReqOut05WirePayload

- 作用：把 Hub 规范语义编码成 provider wire body。
- owning module：`req_outbound` Rust blocks + provider runtime protocol encoder。
- 禁止：把 internal metadata、debug snapshot、error state 写入 provider body/options。

### 3.6 ProviderReqOut06TransportRequest

- 作用：auth、headers、timeout、transport request。
- owning module：`src/providers/core/runtime/*`。
- 禁止：承担 Hub 工具治理；provider-specific 差异只能留在对应 provider runtime。

## 4. 响应链拓扑

响应链必须从 provider raw response 单向回到 client：

```text
ProviderRespIn01Raw
  -> HubRespIn02Parsed
  -> HubRespProc03Governed
  -> HubRespOut04ClientSemantic
  -> ServerRespOut05ClientFrame
```

### 4.0 响应清洗连接矩阵

| 节点 | 输入 | 输出 | 唯一清洗/构建职责 | 禁止连接 |
|---|---|---|---|---|
| `ProviderRespIn01Raw` | upstream raw/SSE/JSON | provider raw response | 保留 provider 原始响应事实 | 直接写 client body |
| `HubRespIn02Parsed` | `ProviderRespIn01Raw` | parsed Hub response | SSE/JSON decode，provider raw 到 Hub 规范解析 | 吞解析错误 |
| `HubRespProc03Governed` | `HubRespIn02Parsed` | governed Hub response | 响应侧工具治理、文本工具收割、servertool followup 判定 | 修请求侧历史污染 |
| `HubRespOut04ClientSemantic` | `HubRespProc03Governed` | client protocol semantic | Hub 响应到入口协议语义投影 | provider 特例、吞上游错误 |
| `ServerRespOut05ClientFrame` | `HubRespOut04ClientSemantic` | Express JSON/SSE frame | client frame 写出、headers、SSE framing | metadata/runtime state 注入 client body |

响应链清洗标准：provider raw 先解析为 Hub 规范，再治理，再投影到 client；任何错误必须转入错误链，禁止在响应链中伪装成正常成功 payload。

## 4.6 请求/响应闭环连接关系

```text
ServerReqIn01ClientRaw
  -> HubReqIn02Standardized
  -> HubReqProc03Governed
  -> VrRoute04SelectedTarget
  -> ProviderReqOut05WirePayload
  -> ProviderReqOut06TransportRequest
  -> upstream
  -> ProviderRespIn01Raw
  -> HubRespIn02Parsed
  -> HubRespProc03Governed
  -> HubRespOut04ClientSemantic
  -> ServerRespOut05ClientFrame
```

闭环约束：

1. `requestId` / `pipelineId` / port / session scope 只能通过 `Meta*` carrier 串联，不得混入 provider wire payload。
2. `previous_response_id` 只能作为 continuation lookup key；lookup 成功后恢复本地 tool_call context，lookup 失败必须 fail-fast。
3. provider direct/passthrough 仍必须遵守出口不可见：internal metadata 不得进入 upstream，也不得进入 client response。
4. servertool followup 只能从 origin snapshot 重建，不得从当前污染 payload 猜测补齐。

### 4.1 ProviderRespIn01Raw

- 作用：provider HTTP/SSE/raw JSON 的原始响应承载。
- owning module：provider runtime transport。
- 禁止：提前改写成 client response；禁止吞 SSE/JSON 解析错误。

### 4.2 HubRespIn02Parsed

- 作用：provider 原始响应解析回 Hub 规范响应。
- owning module：Rust resp_inbound blocks。
- 禁止：provider 特例外溢到 Hub 通用逻辑。

### 4.3 HubRespProc03Governed

- 作用：响应侧工具治理唯一入口，包括文本工具收割、servertool followup、internal tool 剥离。
- owning module：Rust resp_process blocks。
- 禁止：补请求侧历史污染；禁止从当前污染 payload 猜测 followup。

### 4.4 HubRespOut04ClientSemantic

- 作用：把 Hub 响应投影为入口协议语义。
- owning module：Rust resp_outbound blocks。
- 禁止：吞上游错误；禁止 provider-specific client shape patch。

### 4.5 ServerRespOut05ClientFrame

- 作用：Express/SSE/JSON client frame 写出。
- owning module：`src/server/handlers/handler-response-utils.ts`。
- 禁止：把 internal metadata 或 runtime state 注入 client body。

## 5. 错误链拓扑

错误链与请求/响应链并列，不得伪装成正常 payload：

```text
ErrorErr01SourceRaised
  -> ErrorErr02CatalogNormalized
  -> ErrorErr03PolicyClassified
  -> ErrorErr04RetryOrFailPlanned
  -> ErrorErr05ClientProjected
```

### 5.0 错误链连接矩阵

| 节点 | 输入 | 输出 | 唯一职责 | 禁止连接 |
|---|---|---|---|---|
| `ErrorErr01SourceRaised` | throw/error result | source error fact | 记录发生点、stage、provider/runtime context | 直接 retry/fallback |
| `ErrorErr02CatalogNormalized` | source error | normalized code/status/retryable | provider/local error catalog 归一 | message-only 分叉 |
| `ErrorErr03PolicyClassified` | normalized error | classified failure | 策略分类、熔断/冷却语义 | provider payload patch |
| `ErrorErr04RetryOrFailPlanned` | classified failure | retry/fail plan | 单一路径 retry/fail 计划 | direct 失败重入 reroute |
| `ErrorErr05ClientProjected` | final failure | client error response | client-safe 错误投影 | secret/metadata/snapshot 泄漏 |

错误链连接标准：错误可以引用 request/response 节点 id，但不能回写 req/resp 正常 payload；错误进入 client 前必须经过 `ErrorErr05ClientProjected`。

### 5.1 ErrorErr01SourceRaised

- 来源：provider runtime、Hub Pipeline、Virtual Router、transport、client abort、timeout。
- 禁止：在来源处自行决定重试/降级/吞异常。

### 5.2 ErrorErr02CatalogNormalized

- owning module：`src/providers/core/runtime/provider-error-catalog.ts`。
- 作用：统一码、status、retryable、stage、provider detail。

### 5.3 ErrorErr03PolicyClassified

- owning module：`provider-failure-policy-impl.ts`。
- 作用：统一错误分类，不允许 message-only 分叉。

### 5.4 ErrorErr04RetryOrFailPlanned

- owning modules：`request-executor-retry-decision.ts`、`request-executor-provider-failure-plan.ts`。
- 禁止：direct 5xx 或转换错误绕回 executor/reroute；禁止 fallback。

### 5.5 ErrorErr05ClientProjected

- owning module：`src/server/utils/http-error-mapper.ts` + handler error response。
- 禁止：泄露 internal metadata、provider secret、snapshot body。

## 6. Metadata Carrier 拓扑

Metadata 是内部控制语义 carrier，不是正常请求/响应 payload：

```text
MetaReq01EntryCaptured
  -> MetaReq02RuntimeCarrier
  -> MetaReq03RouteCarrier
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

### 7.1 Hub Pipeline

- 目标目录：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`。
- 建议新增类型目录：`hub_pipeline_types/`。
- 文件模板：
  - `hub_req_in_01_raw.rs`
  - `hub_req_in_02_standardized.rs`
  - `hub_req_proc_03_governed.rs`
  - `hub_req_out_05_provider_wire.rs`
  - `hub_resp_in_02_parsed.rs`
  - `hub_resp_proc_03_governed.rs`
  - `hub_resp_out_04_client_semantic.rs`
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
  - `ProviderReqOut01WirePayload`
  - `ProviderReqOut02AuthApplied`
  - `ProviderReqOut03TransportRequest`
  - `ProviderRespIn01RawTransport`
  - `ProviderRespIn02DecodedProtocol`
- 禁止：Provider Runtime 重建 Hub 工具治理；provider-specific 差异只能在本 provider runtime 内完成。

### 7.4 Server Runtime

- 目标目录：`src/server/runtime/http-server/` 与 `src/server/handlers/`。
- 类型模板：
  - `ServerReqIn01ClientRaw`
  - `ServerReqIn02PipelineInput`
  - `ServerRespOut04DispatchPlan`
  - `ServerRespOut05ClientFrame`
- 禁止：Server handler 直接构造 provider wire body；禁止 server response 修复 Hub 历史污染。

### 7.5 Error Pipeline

- 目标目录：`src/providers/core/runtime/`、`src/server/runtime/http-server/executor/`、`src/server/utils/`。
- 类型模板：
  - `ErrorErr01SourceRaised`
  - `ErrorErr02CatalogNormalized`
  - `ErrorErr03PolicyClassified`
  - `ErrorErr04RetryOrFailPlanned`
  - `ErrorErr05ClientProjected`
- 禁止：错误对象回流成 request payload；禁止 message-only retry/failure branch。

## 8. 中间插节点规则

当前架构应尽量避免中间插节点。插节点会破坏全局命名、红测和开发者认知，因此默认不允许。

### 8.0 架构原则：避免插节点

新增中间节点通常说明当前节点职责边界没有定义清楚。优先做以下判断：

1. 如果只是清洗同一语义，放入当前节点内部 block，不新增拓扑节点。
2. 如果只是控制语义，放入 `Meta*` carrier，不新增 req/resp 节点。
3. 如果只是错误分类，放入 `Err*` chain，不新增 req/resp 节点。
4. 如果只是观测/debug/snapshot，放入 `Snapshot*` side-car，不新增主链节点。
5. 如果需要 provider-specific 兼容，放入对应 Provider Runtime，不新增 Hub/VR 节点。

### 8.1 优先处理方式

1. **不插节点**：优先把新语义归入当前节点 owning builder/parser 的内部 block。
2. **扩展节点字段**：若语义属于同一阶段，只扩展该节点类型字段，不改拓扑序号。
3. **新增 side-car carrier**：若是观测、debug、metadata、error 分类，不进入 req/resp 主链，使用 `Meta*` / `Err*` / `Snapshot*` carrier。
4. **拆 phase，不重编号**：若必须新增主链阶段，使用预留区间或 phase suffix，不重编号旧节点。

### 8.2 预留编号策略

为减少未来插节点，请求链与响应链各自采用链内编号；编号一旦发布不可重排、不可复用、不可改语义：

```text
Request chain:
01 Entry Raw
02 Inbound Standardized
03 Process Governed
04 Route Selected
05 Outbound Wire
06 Transport

Response chain:
01 Provider Raw
02 Parsed
03 Process Governed
04 Client Semantic
05 Client Frame

Error chain:
01 Source Raised
02 Catalog Normalized
03 Policy Classified
04 Retry Or Fail Planned
05 Client Projected
```

如果必须插入，例如在 `03` 与 `04` 之间加入验证阶段：

- 禁止把 `04 Route` 改成 `05 Route` 并全局重编号。
- 禁止新增 `HubReqProc03bValidated`、`HubReqProc03_1Validated`、`HubReqProc03p5Validated` 等临时编号。
- 默认新增 `HubReqProc03Governed.validation` 内部 block，而不是主链节点。
- 若语义已改变到必须成为主链阶段，只能链尾追加新 phase 或开启新 chain version，并写清旧链迁移与物理删除计划。


### 8.2.1 新增命名处理规则

新增节点不得污染全局命名：

1. **禁止重编号**：旧 `04` 永远还是 `04`，所有既有类型名不因插入而变化。
2. **内部 block 优先**：同一阶段的新语义必须进入既有节点内部 block / validator / parser，不新增主链编号。
3. **carrier 优先**：控制、错误、观测语义分别进入 `Meta*`、`Error*`、`Snapshot*` carrier，不进入 req/resp 主链编号。
4. **新版本次选**：必须改变中段语义时，开启新 chain version，例如 `HubReqV2Proc03Governed`，并写清旧链删除计划。
5. **文档先行**：未在本文登记的新编号视为非法类型，红测应失败。

### 8.3 插节点审批清单

任何插节点 PR/任务必须同时满足：

1. 文档先改：本文拓扑表更新。
2. 类型先改：新增唯一节点类型和相邻 builder/parser。
3. 红测先红：旧跨节点 shortcut 或旧拓扑假设必须红。
4. 实现后绿：HTTP 黑盒 + Rust 单元/集成 + architecture scan 变绿。
5. 物理删除旧路：旧 DTO、旧转换、旧 TS shell 不得闲置保留。

## 9. 禁止模式扫描清单

建议新增 `tests/red-tests/hub_pipeline_type_topology_contract.test.ts`，扫描：

1. `metadata` / `responsesResume` / `__raw_request_body` 出现在 provider payload builder 输出。
2. `ServerReqIn01` 直接构造 `ProviderReqOut05`。
3. `HubReqIn02` 直接跳到 `ProviderReqOut05`。
4. `ProviderRespIn01` 直接写 `ServerRespOut05`。
5. `ErrorErr*` 对象被 spread 到 request body 或 response body。
6. 关键目录新增泛名转换函数：`convertPayload`、`normalizeRequest`、`processMessages`。
7. 同一节点出现多个 owning builder/parser。
8. Hub Pipeline / Virtual Router 出现 provider-specific 分支。

## 10. 当前实施顺序建议

1. 先为 Hub Pipeline 建 `hub_pipeline_types/` 骨架和红测扫描。
2. 再把 Virtual Router 的 route decision 类型命名对齐。
3. 再收敛 Provider Runtime wire payload 类型。
4. 再补 Server Runtime request/response frame 类型。
5. 最后把 Error Pipeline 统一类型化，禁止错误回流成正常 payload。
