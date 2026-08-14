# V4 Data / Control Plane Boundary Contract

状态：`design`（合同已定，红测与实现未落地）

## 目标

V4 从第一行实现开始就锁定数据面与控制面的物理隔离，并把“泄漏不可能发生”变成可验证的门禁，而不是依赖约定。本文件定义边界不变量、资源到边界的映射，以及必须接进 `v4` 构建链的红测设计。

## 术语

- **数据面（data plane）**：业务请求/响应语义本身，包括客户端协议字段、hub 规范化 payload、provider wire payload。控制字段不得进入。
- **控制面（control plane）**：routing、switching、continuation、retry、provider selection、health、debug、snapshot、error、scope、stopless/servertool 等控制语义。只允许通过 typed side-channel、MetadataCenter 控制资源或 Error 链承载。
- **typed side-channel**：带类型、带 scope 的 carrier，例如 `v4.control.side_channel`。它既不是 payload 字段，也不是无类型 JSON。
- **MetadataCenter**：V4 内部控制信号注册/消费/释放的 scope 隔离资源；只承载 RouteCodex 自己生成的控制信号。

## 边界不变量

| 编号 | 不变量 | owner | gate |
| --- | --- | --- | --- |
| `INV-01` | 控制语义不得写入请求/响应/provider/client 正常 payload | `routecodex-v4-control` | `RED-02`, `RED-03` |
| `INV-02` | payload 不得重建控制状态；控制判定只能读 typed side-channel / 控制资源 | `routecodex-v4-runtime` | `RED-04` |
| `INV-03` | MetadataCenter 只承载内部控制信号；客户端协议 `metadata`/`client_metadata`/`x-*` 是数据面，按入口协议透传 | `routecodex-v4-control` | `RED-09` |
| `INV-04` | 泄漏必须在 owning boundary fail-fast；禁止 silent strip、请求侧 cleanup、handler/SSE/outbound/transport 补偿 | 各资源 owner | `RED-02`, `RED-03`, `RED-05` |
| `INV-05` | scope 按 request/pipeline/port/session/conversation 隔离；闭环结束后释放，禁止跨闭环复用 | `routecodex-v4-control` | `RED-06` |
| `INV-06` | continuation 保存到恢复之间的不可变区禁止任何语义转换、恢复、修补、重排 | `routecodex-v4-runtime` | `RED-07` |
| `INV-07` | debug/snapshot 是诊断侧信道，禁止成为 live runtime 输入 | `routecodex-v4-debug` | `RED-08` |
| `INV-08` | runtime 只消费编译后的 `v4.config.manifest`，禁止扫描 authoring 目录或把配置字段写入 payload | `routecodex-v4-config` | `RED-10` |
| `INV-09` | 同一闭环内协议字段与控制字段不得共用同一个 DTO/struct；关键语义必须用唯一类型承载 | `routecodex-v4-runtime` | `RED-11` |

## 资源到边界映射

完整资源注册表见 `v4-resource-operation-map.yml`。边界相关的关键结论：

- `v4.request.normal_payload` / `v4.response.normal_payload`：数据面；可进入 provider/client wire 语义投影，但绝不含控制字段。
- `v4.request.provider_wire_payload` / `v4.response.client_wire_payload`：wire 面；只由唯一 codec owner 写入。
- `v4.control.side_channel` / `v4.control.metadata_center` / `v4.control.error_chain` / `v4.scope.session` / `v4.control.stopless_state`：控制面；`may_enter_provider_body=false`、`may_enter_client_body=false`。
- `v4.control.error_center`：错误接收/分类/审计中心；只接受 `V4Error02HostCaptured` typed fact，且 `payload_hash` / `typed_context` 必须非空；输出不可构造、绑定 exact fact lineage、只能消费一次的 audit witness，`V4Error03RuntimeClassified` 必须消费该 witness。禁止读取业务 payload 决策，禁止路由操作；路由决策唯一 owner 是 VR，经 `v4.control.route_exit` 出口发出。
- `v4.lifecycle.payload_cycle`：原始请求 payload 生命周期；switch/cooldown/reroute 合并同一周期，原始请求不变；只有响应入客户端或错误终态才终了。
- `v4.debug.module_switch` / `v4.debug.dry_run_chain`：诊断控制面；动态 live 修改、可审计、禁止进入 live path / payload / MetadataCenter / 错误链。
- `v4.error.client_projection`：唯一例外，`may_enter_client_body=true`，但只允许 `code` 和 `message`。
- `v4.debug.snapshot_ledger`：诊断面；只读给开发者诊断，禁止进 live path。

## Red Test 设计

以下每个 gate 必须同时具备“红测必红”和“正向对照”：

### RED-01：非相邻转换不可编译/不可通过

断言：`V4ReqInbound02Normalized` 之外的类型不能直接构造 `V4ReqChatProcess03Governed`；任何非相邻 builder/parser 转换在编译期或静态扫描期失败。

正：相邻 `ReqInbound02 -> ReqChatProcess03` 的唯一 builder 编译并运行成功。

### RED-02：控制字段写入 provider body 必红

断言：把 `v4.control.side_channel` / MetadataCenter 字段序列化进 provider request body 时，`V4ProviderReqOutbound06WirePayload` 的 writer gate 必须 fail-fast（返回错误），并记录 owning boundary。

正：纯业务字段正常出站；typed carrier 字段在 wire builder 处被类型拒绝。

### RED-03：控制字段写入 client body 必红

断言：把控制状态（route、error stage、scope、snapshot 标签、stopless 状态）写入 client response body 时，`V4RespOutbound04ClientSemantic` gate 必须 fail-fast。

正：正常响应只含业务语义；`V4Error06ClientProjected` 只输出 `code`/`message`。

### RED-04：payload 重建控制状态必红

断言：仅凭 payload 字段推导 routing/continuation/retry/scope 判定时，判定入口必须拒绝（缺 typed side-channel 输入即失败）。

正：routing 只消费 `v4.control.route_facts`；continuation 只消费已注册 scope + typed carrier。

### RED-05：泄漏不补偿必红

断言：对已进入错误位置的控制字段执行 silent strip、请求侧 cleanup、handler/SSE/outbound 补偿时，静态 gate 或红测必须失败；唯一合法动作是回 owner 修复。

正：owner 边界 fail-fast 错误消息包含资源 id 和 owning node。

### RED-06：跨 session/闭环复用 scope 必红

断言：session A 的 scope key 在请求 B 中被消费时，`V4ScopeRegistry` 必须拒绝并 fail-fast。

正：同一闭环内 register -> consume -> release 成功；release 后再次 consume 失败。

### RED-07：continuation 不可变区语义操作必红

断言：在 `resp_chatprocess save -> req_chatprocess restore` 之间（resp_outbound、SSE、handler、store transport）出现任何语义转换、history/tool 修补、required_action 推断、stopless 注入时，gate 必须失败。

正：不可变区只做语义等价投影、传输、scope 校验和释放。

### RED-08：debug snapshot 进 live path 必红

断言：任何 runtime 节点把 `v4.debug.snapshot_ledger` 内容作为 live 输入时，编译/扫描 gate 失败。

正：snapshot 只可被诊断读取；请求/响应主线不依赖 snapshot。

### RED-09：客户端协议 metadata 被当作控制信号必红

断言：`metadata`/`client_metadata`/`x-*` 字段被搬进 MetadataCenter 作为控制信号时，gate 失败；MetadataCenter 不允许把数据面字段当内部控制。

正：协议 metadata 按入口语义透传；MetadataCenter 只写 RouteCodex 生成的信号。

### RED-10：runtime 扫描 authoring 目录或配置入 payload 必红

断言：runtime 直接读取 `v4.config.authoring`、绕过 manifest，或把配置字段写入 payload 时，gate 失败。

正：runtime 只从 `v4.config.manifest` 加载；manifest 字段只在 config 资源内被消费。

### RED-11：控制字段与协议字段共用一个 DTO 必红

断言：同一 struct 同时承载控制字段与业务字段（除了已登记的载体类型）时，命名/结构 gate 失败。

正：每个关键 pipeline 节点类型有唯一 owner；相邻转换函数名可反查来源和目标。

## 落地条件

本文件从 `design` 变为 `active` 的条件：

1. V4 Rust 基础框架至少包含 `routecodex-v4-control`、`routecodex-v4-runtime`、`routecodex-v4-error`、`routecodex-v4-config` 的最小 crate 骨架。
2. 以上 11 个红测以真实测试或静态扫描形式接进 `v4` 的构建/CI gate，且每个红测证明“当前实现确实会红”。
3. `v4-resource-operation-map.yml` 中相关资源的 `binding_status` 从 `design` 改为 `anchored`。
4. 新增或迁移模块在进入 Playground review 前先通过本边界合同的模块越界审查。

机器可读合同见 `v4/contracts/data-control-boundary.contract.json`。
