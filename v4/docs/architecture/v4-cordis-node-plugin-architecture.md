# V4 Cordis Skeleton、Node Container 与插件架构

状态：`design_reviewed`（目标架构已完成设计审查；合同、实现、机器 gate 与运行时接线尚未落地）

## 决策

V4 采用三层运行模型：

```text
Skeleton（固定流程容器）
  -> NodeContainer（每个固定位置一个 Cordis 容器）
     -> ordered plugins（节点内按编译顺序执行的插件链）
```

- Skeleton 定义基本流程、固定节点位置、相邻边、节点输入输出和终止边界。
- NodeContainer 是由实际 Cordis Context/Fiber/Effect 承载的局部容器，不是 Rust 自造的 Cordis-like 容器。它拥有插件注册、依赖解析、排序、发布、排空和卸载；Rust 执行器只消费它编译出的不可变执行计划。
- operator、hook、control、debug、snapshot、validator、observer 都是 NodePlugin，不再分成节点主体与旁挂能力两套机制。
- 同一个节点可以启用多个 operator 插件；插件顺序由编译后的 NodePluginPlan 唯一确定。
- 不同节点可以装载不同插件集合，也可以对同类插件使用不同顺序。
- Rust Runtime Kernel 仍是唯一跨节点 orchestrator。插件只能在当前 NodeContainer 内执行，不能绕过 Skeleton、直连非相邻节点或创建第二生命周期。
- 数据面、控制面、信息面和诊断面继续物理隔离。插件化不放宽 payload/control 边界。

## 现有设计审查

### 保留

1. 已冻结的 `routecodex-v4-base-node active-v1` 保留。它继续提供 NodeIdentity、Scope、ControlRecord、ErrorIntake、基础诊断记录和“BaseNode 无业务 operator”的底层不变量。
2. 已冻结 Edge 的相邻连接、资源 axis 与禁止边检查继续作为 Skeleton 接线基础。
3. request、response、error、config、lifecycle、control、diagnostic 链保持分离。
4. 固定节点编号、相邻转换、唯一 Runtime Kernel、编译 Manifest、V3 只读行为基线继续有效。
5. ControlSignal、MetadataCenter、ErrorChain 等专用 Rust owner 继续拥有对应状态机和裁决，不被通用事件总线替代。

### 替换

现有目标态文档中的以下模型被本设计替换：

```text
entry hooks -> one active operator -> exit hooks
```

替换为：

```text
ordered NodePluginPlan
  -> admission plugins
  -> control plugins
  -> semantic operator plugins
  -> validation plugins
  -> projection plugins
  -> observation plugins
```

“每节点唯一 active operator”不再是通用规则。唯一性只适用于显式声明的互斥选择组，例如同一个 `protocol_decode` 选择组只能按 typed protocol fact 激活一个协议 codec；该节点仍可在此 codec 前后执行其他 active 插件。

### 不直接修改冻结 BaseNode

BaseNode 的 Protected/Active 版本已经冻结。NodeContainer 是新的上层模块：

```text
routecodex-v4-base-node (frozen active-v1)
  -> routecodex-v4-node-container (new)
     -> routecodex-v4-skeleton-runtime (new)
```

只有未来证明 BaseNode 公共合同缺少不可替代的底层能力时，才通过 AppSDK `begin-version` 创建 BaseNode 新版本；本设计默认不需要该动作。

## 所有权

| 概念 | 唯一 owner | 责任 | 禁止 |
| --- | --- | --- | --- |
| SkeletonDefinition | `routecodex-v4-skeleton` | 链、节点位置、相邻边、入口、出口 | 承载业务插件实现 |
| Cordis Host | `routecodex-v4-cordis-host` | 实际 Cordis Root/Pipeline/Node Context、Fiber、Effect 与插件生命周期 | 承载跨节点业务编排、复制 Rust 语义 owner |
| NodeContainer | `routecodex-v4-node-container` | 绑定 Cordis NodeContext、发布不可变计划、调用节点执行器 | 选择下一节点、跨节点短路、自造第二套插件容器 |
| NodePluginContract | `routecodex-v4-plugin-contract` | 插件身份、类型、资源权限、依赖、排序 | 执行业务请求 |
| PluginCatalog | `routecodex-v4-plugin-catalog` | 可安装插件、版本、能力、合同索引 | 决定单请求路由 |
| PluginManager | `routecodex-v4-plugin-manager` | install/enable/disable/configure/upgrade/inspect | 直接修改 live payload |
| ConfigCompiler | `routecodex-v4-config` | authoring -> validated compiled Manifest | runtime 动态扫描 authoring |
| Runtime Kernel | `routecodex-v4-runtime` | 按 Skeleton 相邻执行 NodeContainer | 重建插件依赖或排序 |
| MetadataCenter | `routecodex-v4-control` | scope-bound 控制信号状态机 | 数据面真源、payload writer |
| ErrorChain/ErrorCenter | `routecodex-v4-error` | typed 错误链、分类审计、客户端错误投影 | 通用路由 owner、正常 payload writer |
| WebUI/BFF | `routecodex-v4-admin` / `routecodex-v4-webui` | 管理投影、变更请求、可视化 | 承载插件业务语义 |

## Skeleton：基本流程容器

Skeleton 是不可自由变形的流程合同：

```text
chain_id + chain_version
  -> ordered node slots
  -> adjacent edges
  -> entry node
  -> success terminal
  -> error intake edge
```

Skeleton 只调用相邻 NodeContainer：

```text
Node01.execute
  -> typed Node01Output
Node02.execute
  -> typed Node02Output
Node03.execute
```

Skeleton 不读取插件内部状态，不按插件名字决定控制流。Retry、reroute、continuation 等变化必须先形成专用 typed control/decision，再由登记的 Skeleton 边进入合法节点。

## NodeContainer：基于 Cordis 的节点容器

每个节点是一个实际 Cordis 子 Context：

```text
RootContext
  -> PipelineContext
     -> NodeContext(node_id)
        -> PluginFiber(plugin_id@version)
```

NodeContainer 至少提供以下服务：

```text
ctx.nodeDescriptor       immutable node identity/role/ports
ctx.nodePlugins          registrations for this node only
ctx.nodeExecution        compiled plugin-chain executor
ctx.nodeControl          typed control resource access
ctx.nodeInformation      immutable compiled information view
ctx.nodeDiagnostics      read-only event/record publication
ctx.nodeErrors           typed error intake
ctx.nodeLifecycle        mount/publish/drain/dispose
```

### 实际 Cordis 与 Rust 热路径

Cordis 是插件组合和生命周期的唯一 owner，Rust 是业务语义和热路径执行的唯一 owner。二者不是两套平行运行时：

```text
Cordis authoring/plugins
  -> actual NodeContext + PluginFibers
  -> validated NodePluginPlan + plan_hash
  -> typed native bridge
  -> Rust node executor
  -> typed node output
```

- Cordis Host 必须直接依赖并运行实际 Cordis；禁止只复刻 Context/Fiber/Effect API 后称为 Cordis。
- 每个 NodePlugin 都以 Cordis plugin/Fiber 安装，使用 Cordis Service/inject/effect/dispose 管理依赖和生命周期。
- 业务 operator 可以由 Rust 实现，但必须由对应 Cordis plugin 注册 typed native handle；插件身份、权限、依赖和顺序仍由 NodeContext 编译。
- Rust executor 只接受编译后的 `NodePluginPlan` 和 typed handles，不扫描插件目录、不重新排序、不推断依赖。
- `NodePluginPlan` 是 active Cordis graph 的确定性 artifact，不是第二真源。Cordis graph hash、Manifest plan hash 与 Rust loaded hash 不一致时启动或发布失败。
- 跨语言桥禁止通用 JSON metadata。data、control、information、diagnostics 使用独立 typed handles；业务 payload 不被复制进 control/debug 通道。
- 默认性能目标是每个节点一次 native dispatch，而不是每个插件一次跨语言往返。是否满足该目标必须在基础实验中以真实 payload 和多插件链验证，不能仅凭设计宣称。

因此，“节点基于 Cordis”是运行时事实；“Rust 热路径”只是 Cordis NodeContainer 编译计划的执行后端，不替代 Cordis 容器和插件生命周期。

NodeContainer 生命周期：

```text
declared
  -> context_created
  -> plugins_mounted
  -> dependencies_resolved
  -> order_compiled
  -> permissions_validated
  -> published
  -> accepting
  -> draining
  -> disposed
```

发布必须事务化。任一插件导入、依赖、排序、权限或初始化失败时，候选容器整体拒绝，已安装 Effect 逆序释放，旧 active 容器保持不变；禁止部分发布。

## NodePlugin 统一合同

所有节点行为使用同一插件合同，通过 `kind` 和 `effect` 区分权限：

```json
{
  "plugin_id": "v4.request.tool_governance",
  "version": "0.1.0",
  "kind": "operator",
  "effect": "semantic",
  "node_selector": {"role_id": "request_chat_process"},
  "phase": "semantic",
  "order": 300,
  "before": ["v4.request.output_validate"],
  "after": ["v4.request.continuation_restore"],
  "inject": ["nodeControl", "nodeInformation"],
  "reads": ["v4.request.normal_payload", "v4.control.metadata_center"],
  "writes": ["v4.request.normal_payload", "v4.control.metadata_center"],
  "selection_group": null,
  "failure": "typed_error_intake"
}
```

必填语义：

- `plugin_id`、`version`、owner 和 artifact identity 唯一。
- `node_selector` 只能命中已声明 Node/role，不能运行时遍历未知节点。
- `phase`、`order`、`before`、`after` 编译为确定顺序。
- `inject` 是 Service 依赖，不是 payload 字段。
- `reads/writes` 必须命中资源注册表和节点允许权限。
- `effect` 决定插件是否只读、只写控制面或可改当前节点业务数据。
- `selection_group` 仅用于互斥变体，组内恰好一个 active；组外插件继续按序执行。
- 失败必须进入 typed error intake；不得吞错、fallback、跳过后继续成功。

### 插件种类

| kind | 用途 | 默认 effect | 执行语义 |
| --- | --- | --- | --- |
| `admission` | 输入、scope、依赖准入 | `read_only` | serial |
| `control` | register/consume/release typed 控制资源 | `control_only` | serial |
| `operator` | parse/normalize/govern/select/build/project | `semantic` 或 `control_only` | waterfall/serial |
| `validator` | 节点输入、输出、资源不变量 | `read_only` | serial，失败即错误链 |
| `hook` | 已登记的节点边界横切行为 | 显式声明 | waterfall/serial |
| `debug` | 调试事件观察 | `diagnostic_only` | parallel/read-only |
| `snapshot` | entry/exit/error 诊断快照 | `diagnostic_only` | parallel/read-only |
| `observer` | timing/metrics/ledger | `diagnostic_only` | parallel/read-only |

Debug、snapshot 和 observer 也是普通可管理插件，但其 capability token 只允许读取诊断投影。它们不能读取快照作为 live 输入、不能返回业务结果、不能写 MetadataCenter、不能改变插件链控制流。

## 插件顺序

每个节点有自己的有序插件计划。编译顺序：

1. 按 `phase` 的固定偏序排列。
2. 解 `before/after` 依赖图。
3. 使用 `order` 作为同层显式位置。
4. 最后以 `plugin_id + version` 仅作确定性稳定排序，不作为语义优先级。

以下情况编译失败：

- 依赖环；
- 同一 phase/order 且无 before/after 关系；
- 依赖不存在或版本不满足；
- selection group 零个或多个 active；
- 插件写未授权资源；
- diagnostic 插件声明语义写；
- control 插件声明 normal payload 写；
- operator 跨节点读取另一个 NodeContainer 私有服务。

示例：

```text
V4HubReqChatProcess04Governed
  010 input_contract_validate
  100 scope_consume
  200 continuation_restore
  300 request_governance
  400 tool_governance
  500 stopless_current_turn_projection
  800 output_contract_validate
  900 debug_observe + snapshot_record + timing (parallel read-only)
```

另一个节点可以使用完全不同的插件和顺序：

```text
V4ProviderReqOutbound08WirePayload
  010 input_contract_validate
  200 protocol_codec(selection_group=provider_wire_codec)
  300 auth_handle_resolve
  800 control_payload_leak_gate
  900 transport_snapshot + timing (parallel read-only)
```

## 执行语义

NodeContainer 收到 typed input 后执行：

```text
create NodeExecutionScope
  -> publish node.entry diagnostic fact
  -> serial/waterfall active semantic plan
  -> validate output resource and control records
  -> publish node.exit diagnostic fact
  -> return typed output to Skeleton
```

业务插件默认串行。只有显式声明为 diagnostic-only 的插件可并行。`waterfall` 允许插件包装后续插件，但不调用 `next()` 只在合同声明的 `terminal_effect` 下合法；普通 operator 不调用 `next()` 视为错误，避免意外短路。

节点执行输入必须分面：

```text
NodeExecutionInput
  data: typed current-node data
  control: scoped control capabilities
  information: immutable manifest/catalog views
  diagnostics: write-only diagnostic publisher
```

禁止把四个面合成通用 JSON metadata。业务 payload 不得重建 control，control 不得被序列化进 provider/client body。

## Request、Response 与 Error 主线

请求和响应保留 V3 已验证顺序，V4 节点只是把每个阶段内部改为插件容器：

```text
Request Skeleton
  ClientRaw NodeContainer
  -> Normalized NodeContainer
  -> Continuation NodeContainer
  -> ChatProcess NodeContainer
  -> Execution NodeContainer
  -> Target NodeContainer
  -> ProviderSemantic NodeContainer
  -> ProviderCompat NodeContainer
  -> ProviderWire NodeContainer
  -> Transport NodeContainer
```

```text
Response Skeleton
  ProviderRaw NodeContainer
  -> ProviderCompat NodeContainer
  -> Normalized NodeContainer
  -> ChatProcess NodeContainer
  -> ContinuationCommit NodeContainer
  -> ClientSemantic NodeContainer
  -> ClientFrame NodeContainer
```

```text
Error Skeleton
  SourceRaised NodeContainer
  -> HostCaptured NodeContainer
  -> RuntimeClassified NodeContainer
  -> RouterPolicyApplied NodeContainer
  -> ExecutionDecision NodeContainer
  -> ClientProjected NodeContainer
```

插件不能改变这三个 Skeleton 的相邻关系。Direct/Relay、协议、provider 和 execution mode 通过 selection group 选择局部变体，不生成第二条隐式流程。

## 插件库

V4 必须提供标准插件库，而不是只提供框架。首批插件按包和权限分类：

```text
plugin-library/
  contracts/       input/output/scope/error validators
  control/         scope, MetadataCenter, lifecycle, continuation capabilities
  protocol/        inbound/outbound/compat codecs
  chat-process/    request/response governance and tool operators
  routing/         route facts, selection-plan and decision consumers
  provider/        capability, auth-handle, wire and transport operators
  error/           typed error intake/classification/policy/projection adapters
  diagnostic/      debug, snapshot, timing, ledger, dry-run observers
  admin/           inspect and management projections only
```

每个标准插件独立声明 owner、支持节点、依赖、资源权限、测试、版本和兼容范围。共享语义只能有一个插件 owner；协议/provider 变体通过 selection group 并列，不复制通用治理。

## 插件管理框架

管理框架包含：

1. `PluginCatalog`：可发现插件及版本、来源、签名/hash、capabilities、合同和依赖。
2. `PluginInstaller`：把 artifact 安装到 authoring/plugin store；不直接激活 live runtime。
3. `PluginResolver`：解析版本与 Service 依赖，生成候选插件图。
4. `PluginValidator`：校验 owner、node selector、资源权限、effect、selection group、顺序和兼容性。
5. `PluginPlanCompiler`：生成 deterministic `NodePluginPlan` 和完整 Skeleton Manifest。
6. `PluginLifecycleManager`：候选 mount、健康检查、事务发布、drain、dispose、回收 Effect。
7. `PluginInspector`：只读输出 active/candidate/failed 状态、依赖图、节点顺序和诊断摘要。
8. `PluginAuditLedger`：记录 install/enable/disable/configure/upgrade/publish/dispose，不承载业务 payload。

runtime 只能消费已编译 Manifest。WebUI 或 CLI 的修改先写 authoring transaction，编译和验证通过后才生成 candidate；发布是显式动作，不允许 UI 直接改 active NodeContext。

## 重载和版本切换

节点级变更流程：

```text
authoring change
  -> compile candidate NodePluginPlan
  -> mount isolated candidate NodeContainer
  -> contract smoke
  -> stop accepting on old container
  -> drain old in-flight executions
  -> atomic active pointer switch
  -> dispose old effects
```

候选失败时旧容器继续服务，但这不是业务 fallback：候选从未发布，管理操作显式失败。已发布容器执行失败仍按 ErrorChain 处理，禁止回到旧插件链重试。

## WebUI 管理面

WebUI 是 PluginManager 和 Runtime Inspector 的投影与命令面，不承载插件排序、权限判定或业务算法。

主要页面：

- Skeleton 图：request/response/error 节点和相邻边。
- Node 详情：当前 ordered plugin chain、phase、order、依赖、资源读写、selection group。
- 插件库：已安装/可用版本、来源、hash、capabilities、合同、依赖和测试状态。
- 配置编辑：启用、禁用、排序、配置、版本选择；变更进入 candidate transaction。
- Diff/Review：active 与 candidate 的节点、插件、顺序、权限和 Manifest hash 差异。
- 验证面：compile、contract、whitebox、blackbox、dry-run、review、promotion 状态。
- 运行面：active version、NodeContainer 生命周期、in-flight/draining、错误和诊断摘要。
- Audit：操作者、动作、候选、验证、发布与失败原因。

WebUI BFF 只暴露 typed 管理 API：

```text
GET  /v4/admin/skeleton
GET  /v4/admin/nodes/:nodeId
GET  /v4/admin/plugins
POST /v4/admin/candidates
POST /v4/admin/candidates/:id/compile
POST /v4/admin/candidates/:id/validate
POST /v4/admin/candidates/:id/publish
POST /v4/admin/candidates/:id/discard
GET  /v4/admin/audit
```

发布 API 必须验证 candidate hash、actor、权限、最新 active base hash 和 required gates。WebUI 不得提供“忽略错误继续”“自动 fallback”“直接改 active JSON”等入口。

## 安全不变量

1. Skeleton 只有一个 Runtime Kernel；NodePlugin 不拥有第二 orchestrator。
2. NodePlugin 只能作为实际 Cordis NodeContext 的 Fiber 在所属 NodeContainer 内注册；跨节点通信走相邻 typed output 或登记控制资源。
3. control/debug/snapshot/error state 不进入正常 request/response/provider/client payload。
4. payload 不重建 routing、retry、continuation、scope、health、debug 或错误状态。
5. debug/snapshot/observer 插件只读，不进入 live 决策。
6. 插件失败进入唯一 ErrorChain；禁止 silent strip、fallback 或 handler/outbound 补偿。
7. runtime 不扫描 plugin authoring 目录，只消费确定性 compiled Manifest 和已验证 artifact。
8. 插件顺序、依赖和 selection group 在发布前完成编译；单请求期间不可改变。
9. frozen BaseNode/Edge 只通过版本化 AppSDK 流程变化；NodeContainer 不修改其 Active/Protected artifact。
10. Cordis active graph、compiled Manifest 与 Rust loaded plan 的 hash 必须一致；禁止 Cordis Host 与 Rust executor 各自维护插件顺序真源。

## 当前缺口

- `contracts/node-graph.contract.json` 仍表达“每节点唯一 active operator”和 hook 独立队列；它属于冻结 BaseNode 的 contract inputs，不能直接原地修改。
- 尚无实际 Cordis Host、NodeContainer、typed native bridge、NodePluginContract、PluginCatalog、PluginManager、Skeleton Runtime 或 Admin/WebUI 模块。
- 当前 Config Compiler 正在独立开发；NodePluginPlan schema 必须作为后续版本/扩展接入，不能与在途 `v4.config.manifest` owner 并行改同一真源。
- 当前 V4 只有基础 crate 和合同，没有真实 request/response runtime，因此本设计只能标为 `design_reviewed`。

实施和验证顺序见 [`v4-cordis-plugin-framework-and-webui-plan.md`](../goals/v4-cordis-plugin-framework-and-webui-plan.md)。
