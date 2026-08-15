# V4 Skeleton / NodeContainer 插件化整改计划

状态：`confirmed`  
执行状态：`ready_for_contract_remediation`  
基线：`main@e99f7efa4cb22af7d4a2ff2eaf8c487ca76c3ec4`  
行为基线：V3 当前已验证主线，只读、只对照、不修改  
目标架构：[`v4-cordis-node-plugin-architecture.md`](../architecture/v4-cordis-node-plugin-architecture.md)

## 1. 整改结论

V4 不回退到“每个节点一个固定算子”的模型。整改后的目标仍然是：

```text
SkeletonContainer（唯一整体路径与连接容器）
  -> NodeSlot / adjacent Edge
     -> NodeContainer（每个固定位置的局部 Cordis 容器）
        -> immutable ordered NodePluginPlan
           -> 多个可组合插件 + 显式互斥选择组
```

本次整改解决的是现有设计和实现之间的以下偏差：

1. Cordis 多插件架构与旧 `one operator + entry/exit hooks` 合同并存，架构真源不唯一。
2. V3 的 continuation、execution、route、target、provider 等语义阶段在 V4 物理容器图中缺少完整、机器可验证的检查点映射。
3. NodeContainer、Config Manifest、Cordis graph 和 Rust executor 之间尚未形成单一不可变执行计划。
4. 插件资源权限主要停留在字符串声明，缺少不可伪造的 typed capability 边界。
5. 当前基础模块测试可以证明局部合同，但不能证明 V4 与 V3 的端到端行为等价。
6. PluginManager、Admin、WebUI 和动态发布能力的实施顺序早于核心静态执行闭环的完整验证。

整改原则不是减少插件化，而是让插件化具备明确的容器边界、语义检查点、确定性计划、唯一 owner 和 V3 等价证据。

## 2. V4.0 范围定义

### 2.1 允许新增的结构能力

V4.0 允许新增以下内部结构和管理能力：

- SkeletonContainer、NodeContainer、NodePlugin、NodePluginPlan；
- Cordis Context / Fiber / Effect 生命周期；
- 插件合同、Catalog、依赖、排序、选择组、权限和 artifact identity；
- deterministic Config / Manifest / Plan 编译；
- typed bridge、runtime inspector、审计和诊断投影；
- candidate compile / validate / dry-run / publish / drain / dispose 的管理合同。

### 2.2 不允许新增的业务行为

V4.0 不新增客户端可见的数据面、协议面和业务语义：

- 不新增 endpoint、协议字段、响应事件或错误语义；
- 不改变 route、target、retry、reroute、cooldown、continuation 的既有业务规则；
- 不新增 provider 特例或 model-name 分支；
- 不改变 V3 已验证的工具、Chat Process、SSE、JSON、servertool、stopless 行为；
- 不允许插件失败后尝试另一个语义实现并伪装成功；
- 不允许管理面直接修改正在执行的请求。

### 2.3 暂缓实施但保留设计的能力

以下能力保留在目标架构中，但必须在静态执行闭环和 V3 差分门禁通过后实施：

- PluginManager 的运行时 install / enable / disable / upgrade；
- Admin API；
- WebUI；
- live route policy；
- HMR 或运行时插件替换；
- 第三方插件供应链接入。

它们属于后续管理面里程碑，不得成为 V4.0 主线实现的前置依赖。

## 3. 不可协商的架构不变量

### INV-R01：唯一跨节点执行 owner

只有 `routecodex-v4-skeleton` / `routecodex-v4-runtime` 可以选择并调用下一个 NodeContainer。

NodePlugin 和 NodeContainer 不得获得：

- `next_node()`；
- 全局 dispatcher；
- 任意 node lookup 后执行能力；
- 独立 success terminal；
- 第二 request/response lifecycle。

### INV-R02：节点内容完全插件化

NodeContainer 不承载协议、路由、工具、provider 或 Chat Process 业务实现。节点内行为统一由 NodePlugin 表达：

```text
admission
control
operator
validator
projection
hook
observer/debug/snapshot
```

BaseNode 只保留底层身份和横切能力；Skeleton 只保留跨节点拓扑和执行。

### INV-R03：可组合插件与互斥实现分离

普通插件可在同一节点同时 active，例如：

```text
input_validate
scope_consume
continuation_restore
request_governance
tool_governance
output_validate
timing
snapshot
```

只有显式 `selection_group` 内的同源变体互斥，例如：

```text
selection_group = entry_protocol_decoder
  - decode.responses
  - decode.anthropic
  - decode.gemini
  - decode.openai_chat
```

选择组必须在执行前由 typed fact 决定，且 `exactly_one`。不得根据 provider id、model 前缀、payload 猜测或前一个插件执行失败进行 fallback。

### INV-R04：物理容器图与语义兼容图同时存在

V4 可以把多个 V3 语义阶段聚合进一个 NodeContainer，但不得让这些阶段从机器合同中消失。

必须维护两个视图：

```text
Physical Container Graph
  Skeleton -> NodeContainer -> NodePluginPlan

Semantic Parity Graph
  V3 semantic stage -> V4 container -> V4 plugin -> checkpoint
```

每个 V3 语义阶段必须映射到恰好一个 V4 checkpoint，并绑定输入资源、输出资源、owner、错误入口和验证证据。

### INV-R05：单请求绑定不可变执行计划

请求进入 Skeleton 时必须绑定不可变 `ExecutionBinding`：

```text
skeleton_version
manifest_hash
plan_epoch
execution_plan_hash
plugin_artifact_set_hash
```

一次请求从 entry 到 success/error terminal 全程使用同一 binding：

- 节点间不得重新读取 active pointer；
- 不得重新解析依赖或排序；
- 不得切换 plugin version；
- 新 plan publish 只影响后续请求；
- 旧 plan 完成 drain 后才能 dispose。

### INV-R06：权限通过 typed capability 落实

插件不得获得通用全局 Context 或任意 JSON metadata 通道。NodeContainer 只注入窄能力：

```text
DataRead<Input>
DataWrite<Output>
ControlCapability<AllowedFacts>
InformationView<AllowedResources>
DiagnosticPublisher
ErrorIntake
```

`effect` 决定 capability 集合：

| effect | 允许能力 |
| --- | --- |
| `read_only` | 当前节点 data read + information read |
| `control_only` | typed control read/write，不可写 normal payload |
| `semantic` | 当前节点 data read/write + 显式 control capability |
| `projection` | 指定 projection writer |
| `diagnostic_only` | 诊断投影读取和事件发布 |
| `error_adapter` | typed error intake / projection adapter |

### INV-R07：统一失败路径

业务、控制、验证和投影插件失败统一进入：

```text
PluginFailure
  -> NodeFailure
  -> typed ErrorIntake
  -> ErrorChain
```

只有声明为 `diagnostic_only + record_and_isolate` 的插件可以在自身失败后不改变业务结果，但必须记录诊断失败。

互斥实现的一个插件失败后不得尝试同组其他插件。

### INV-R08：数据、控制、信息、诊断继续物理隔离

插件化不放宽既有边界：

- control 不得进入 provider/client normal payload；
- payload 不得重建 route、continuation、retry 或 scope；
- event bus 不得成为决策 owner；
- snapshot/debug 不得成为 live path 输入；
- Config authoring 不得在 runtime 扫描；
- secret 只以 handle 进入 compiled information view。

### INV-R09：动态管理不改变在途请求

未来 PluginManager 可以发布新 epoch，但不能修改已经绑定的 ExecutionBinding。不存在请求执行中途 HMR、半更新或自动 rollback。

## 4. 目标容器划分

整改后的推荐物理容器图：

```text
Request chain
  ServerIngressContainer
  -> RequestInboundContainer
  -> RequestProcessContainer
  -> ExecutionContainer
  -> ProviderOutboundContainer

Response chain
  ProviderInboundContainer
  -> ResponseProcessContainer
  -> ClientOutboundContainer

Error chain
  ErrorSourceContainer
  -> ErrorClassifyContainer
  -> ErrorPolicyContainer
  -> ErrorDecisionContainer
  -> ErrorProjectionContainer
```

### 4.1 RequestProcessContainer

应承载：

- continuation classify / restore；
- request governance；
- tool governance；
- servertool / stopless 当前轮处理；
- 输入输出合同验证。

### 4.2 ExecutionContainer

应承载：

- execution mode planning；
- route facts；
- route plan；
- opaque target resolution；
- concrete provider/model/auth binding；
- availability 读取；
- execution output validation。

VR、Target、Availability 仍分别拥有自己的语义和资源，但它们作为插件/typed service 在同一个 ExecutionContainer 闭环内执行，不形成第二条主线。

### 4.3 ProviderOutboundContainer

应承载：

- provider-neutral semantic projection；
- provider capability / compat；
- protocol wire codec selection；
- auth handle resolution；
- transport request build；
- control-payload leak gate。

### 4.4 容器内部微型骨架

NodeContainer 的插件计划不是任意数组。统一 phase：

```text
010 admission
100 control_acquire
200 restore/classify
300 semantic
400 governance
500 projection
800 validation
900 diagnostics
```

排序规则固定为：

```text
phase
  -> before/after dependency DAG
  -> explicit order
  -> stable plugin identity（仅用于确定性，不表达业务优先级）
```

以下情况必须编译失败：

- cycle；
- 同 phase / order 且没有显式关系；
- missing dependency；
- version conflict；
- selection group 零个或多个 active；
- unauthorized resource read/write；
- diagnostic plugin 声明 semantic write；
- control plugin 声明 normal payload write；
- 跨 NodeContainer 私有 service 注入；
- plugin 请求跨节点 dispatcher。

## 5. 整改工作流

## R0：锁定架构真源与范围

### 目标

消除 Cordis 多插件架构、旧 node graph、Config v1 和旧 hook/operator 模型之间的冲突。

### 工作项

1. 新增 canonical ADR，明确以下优先级：
   - `v4-cordis-node-plugin-architecture.md` 是节点内部组合真源；
   - Skeleton/Edge 合同只拥有跨节点拓扑；
   - 旧 `one active operator + entry/exit hooks` 模型标记为 superseded；
   - hook/control/debug/snapshot/validator/observer 统一为 NodePlugin kind/effect。
2. 更新 `v4-standard-nodes-and-node-graph.md`，保留节点族、角色、物理拓扑，删除其对旧内部组合模型的权威性。
3. 定义 V4.0 与后续管理面的边界，禁止 WebUI/动态管理成为核心执行前置依赖。
4. 在 R0 完成前暂停新的 Runtime/Plugin 公共 API freeze。

### 产物

```text
v4/docs/architecture/v4-canonical-runtime-composition.md
v4/docs/architecture/v4-standard-nodes-and-node-graph.md（状态与引用修订）
v4/docs/README.md（canonical 文档关系）
```

### 退出门槛

- 文档中不再同时存在两个 active 的节点内部执行模型；
- 每个概念只有一个唯一 owner；
- superseded 文档/章节可被机器索引识别；
- architecture review 通过。

## R1：建立 V3 -> V4 语义等价图

### 目标

允许物理节点聚合，但保证 V3 语义阶段没有丢失、重排或隐式化。

### 工作项

1. 从 V3 mainline/function/resource/verification maps 提取：
   - request；
   - response；
   - error；
   - continuation；
   - route/target；
   - provider wire/transport；
   - config；
   - lifecycle。
2. 为每个 V3 语义阶段登记：

```yaml
v3_stage:
v4_container:
v4_plugin:
checkpoint_id:
input_resources:
output_resources:
control_resources:
owner:
error_intake:
required_evidence:
status:
```

3. 允许多个 V3 stage 映射到同一个 V4 container，但不允许多个 stage 共用一个不可区分 checkpoint。
4. 建立 `GAP=0` gate；任何未映射 stage 阻止 Skeleton Runtime 实现。

### 产物

```text
v4/docs/architecture/v3-v4-semantic-parity-map.yml
v4/contracts/semantic-parity.contract.json
v4/.appsdk/maps/semantic-parity-map.json
```

### 退出门槛

- V3 已登记主线阶段覆盖率 100%；
- 每个 stage 恰好一个 V4 checkpoint；
- 每个 checkpoint 有唯一 plugin owner；
- 不存在第二 route/target/provider lifecycle；
- `GAP=0`。

## R2：发布 Skeleton / NodePlugin 合同 v2

### 目标

把两级容器、多插件计划、选择组、权限和请求绑定变成机器合同。

### 工作项

新增合同：

```text
v4/contracts/skeleton-container.contract.json
v4/contracts/node-container.contract.json
v4/contracts/node-plugin.contract.json
v4/contracts/node-plugin-plan.contract.json
v4/contracts/execution-binding.contract.json
v4/contracts/plugin-capability.contract.json
```

合同至少定义：

- Skeleton entry、terminal、adjacent edge 和 error intake；
- Node role、ports、allowed plugin kinds、allowed resources；
- plugin identity、owner、artifact/contract hash；
- phase/order/before/after；
- selection group typed selector 和 cardinality；
- effect -> capability 集合；
- failure policy；
- plan epoch/hash；
- publish/drain/dispose；
- semantic checkpoint；
- V3 baseline evidence binding。

旧 `node-graph.contract.json` 保留为历史 v1，不原地改变 frozen 语义。新模块只消费 v2 合同。

### 退出门槛

- 合同 canonical JSON byte-stable；
- unknown field、unknown node/resource/plugin 全部失败；
- cycle、tie、missing dependency、version conflict 全部失败；
- unauthorized capability 全部失败；
- selection group `exactly_one` 可机器验证；
- semantic checkpoint 引用完整。

## R3：基础模块合同加固与版本决策

### 目标

修复会破坏容器不变量的公共 API，不直接修改 frozen Active/Protected artifact。

### 原则

- 先做 gap audit，再决定 wrapper 还是 `begin-version`；
- 只要现有公共 API 能构造违反新合同的状态，就必须开新版本；
- v1 保留为历史证据，不强制删除；
- 新 Runtime 只能依赖已通过 v2 gate 的版本。

### 模块整改项

#### BaseNode

审计并处理：

- stateful `Clone` 是否造成分叉状态机或重复 record identity；
- NodeIdentity/Scope 是否需要 validated newtype；
- control in/out 是否需要一次性 permit 配对；
- Clock / ID generator 是否需要注入；
- ErrorIntake 是否应强制完整 typed context；
- dry-run 是否可证明无网络、无副作用。

只有上层 NodeContainer 无法安全封装这些问题时，才 `begin-version` BaseNode。

#### Edge

必须解决：

- 只允许 `to.position == from.position + 1`，禁止反向相邻边；
- `EdgeSpec` 改为按 kind 分型的 ADT，禁止 public Optional 字段构造混合非法状态；
- ControlEdge 必须验证 Control axis；
- 静态 graph validation 与运行时 MetadataCenter 状态机分离；
- scope key 使用 typed identity，不做字符串拼接。

预计需要 `routecodex-v4-edge` 新版本。

#### Control

必须解决：

- `ControlSignalKind + String key + value_hash` 不再作为运行时语义真源；
- route、selection、continuation、retry、scope 使用具体 typed facts；
- hash 仅用于审计；
- payload writer 在类型上不能接受 Control capability；
- plugin 只能获得允许事实的窄 ControlCapability。

预计需要 `routecodex-v4-control` 新版本。

#### Error

必须解决：

- Retry/Cooldown/Reroute 返回执行循环，不可直接进入 client projection；
- 只有不可伪造的 TerminalDecisionToken 可进入 ClientProjected；
- policy/verdict 由唯一 owner 产生；
- stateful chain/witness 不允许产生可分叉副本；
- 每次 transition 写独立、单调的 record timestamp。

预计需要 `routecodex-v4-error` 新版本。

#### Config

必须升级为多插件 schema：

```text
node_id
plugin_bindings[]
selection_groups[]
phase/order/before/after
resource_permissions
capability_bindings
semantic_checkpoints
```

移除“一个 node 一个 operator_id/plugin_id + 独立 hooks”作为目标 schema 的限制。Manifest canonicalization 使用正式 canonical JSON/CBOR 方案，不继续依赖手工 delimiter 字符串。

### 退出门槛

- 新合同不能通过 public API 构造已登记非法状态；
- 所有新版本均有正向/反向、白盒/黑盒测试；
- Active/Protected v1 未被原地改写；
- dependency graph 明确标出 v1/v2 消费关系。

## R4：实现确定性 NodePluginPlan Compiler

### 目标

让 runtime 只消费已编译、已验证、不可变的节点执行计划。

### 模块顺序

```text
routecodex-v4-plugin-contract
  -> routecodex-v4-plugin-catalog
     -> routecodex-v4-plugin-plan
        -> routecodex-v4-config v2
```

### 编译输入

- Skeleton/Node descriptor；
- PluginCatalog snapshot；
- plugin bindings；
- typed selector declarations；
- resource/capability registry；
- Config information resources；
- semantic parity checkpoints。

### 编译输出

每个 NodeContainer 生成：

```text
node_id
node_role
plan_epoch
ordered_plugin_entries
selection_group_resolutions
resource_permissions
capability_tokens
semantic_checkpoints
plan_hash
artifact_set_hash
```

### 运行时禁止

- 扫描 plugin 目录；
- 重新排序；
- 推断依赖；
- 根据 payload 猜选择组；
- 缺 plugin 时使用默认 fallback；
- 自动加载未进入 Catalog 的 artifact。

### 退出门槛

- authoring 顺序变化不改变语义 plan hash；
- 同一输入多次编译 byte-identical；
- graph hash、Manifest hash、Plan hash 可建立确定性 lineage；
- 两个不同节点可拥有不同插件集合和顺序；
- 同节点多个普通 operator 可同时 active；
- 选择组恰好一个 active。

## R5：实际 Cordis NodeContainer 最小纵切

### 目标

证明 Cordis 是真实容器和生命周期 owner，Rust 是 typed 热路径执行后端，不形成两套插件图。

### Playground 实验

在 `v4/playground/experiments/` 建立一个最小 NodeContainer：

```text
actual Cordis Root/Pipeline/Node Context
  -> 3 个 Plugin Fiber
  -> compiled NodePluginPlan
  -> typed native bridge
  -> Rust node executor
  -> typed output
```

至少包含：

- admission plugin；
- semantic plugin；
- diagnostic-only plugin；
- Service provide/inject；
- serial/waterfall/parallel 受限模式；
- entry/exit/error records；
- reverse-order Effect disposal。

### 必测行为

- mount -> validate -> publish -> execute -> drain -> dispose；
- 缺依赖不发布；
- 初始化失败事务回滚；
- dispose 逆序且只执行一次；
- semantic plugin 失败进入 ErrorIntake；
- diagnostic failure 隔离并记录；
- Node A plugin 无法访问 Node B 私有 service；
- plugin 无法获取 next-node capability；
- graph/Manifest/Rust loaded plan hash 不一致时拒绝执行；
- 同一请求执行期间 plan 不变化。

### 性能证据

记录：

- per-node native dispatch 次数；
- payload copy/clone 次数；
- bridge 延迟；
- plugin 数量增长曲线；
- diagnostics disabled fast path。

正式目标是每节点最多一次 native dispatch，不允许每插件一次跨语言往返成为默认实现。

## R6：实现唯一 Skeleton Runtime

### 目标

建立真正的固定跨节点执行容器，并把所有业务行为留在 NodeContainer 内。

### 工作项

1. Skeleton 加载一个已验证的 immutable ExecutionPlan。
2. 请求进入时绑定 ExecutionBinding。
3. 只执行相邻 NodeSlot。
4. Node output 只能进入登记的下一 Edge 或 ErrorIntake。
5. Retry/Reroute/Cooldown 通过 typed decision edge 回到合法执行位置。
6. 每个 semantic checkpoint 产生可审计记录，但不暴露业务 payload。
7. request、response、error 三条链不混接。

### 退出门槛

- 两节点、三节点、完整最小链正向通过；
- 跳节点、倒序、重复 position、unknown terminal 编译失败；
- plugin 无法改变下一节点；
- NodeFailure 不继续 success chain；
- 请求全程 plan epoch/hash 不变；
- route/target/provider 不形成第二 Runtime Kernel。

## R7：Responses Direct 纵向兼容切片

### 目标

在迁移完整系统前，用一条真实 V3 行为链验证容器和插件模型。

### 首个切片

```text
ServerIngressContainer
  -> RequestInboundContainer
  -> RequestProcessContainer
  -> ExecutionContainer
  -> ProviderOutboundContainer
  -> mock transport
  -> ProviderInboundContainer
  -> ResponseProcessContainer
  -> ClientOutboundContainer
```

插件至少覆盖：

- Responses entry parse/normalize；
- continuation=new；
- direct Chat Process pass contract；
- route facts / route plan；
- target resolve；
- provider semantic；
- Responses wire build；
- mock transport；
- response parse；
- client projection；
- error intake；
- diagnostics disabled/enabled。

### 逐步验证

1. keyless fixture，无网络；
2. controlled mock upstream；
3. non-streaming；
4. SSE streaming；
5. provider error；
6. timeout/cancel/disconnect；
7. scope release 和 audit 完整性。

### 退出门槛

- 完整请求经过唯一 Skeleton；
- 所有业务行为都可反查到 NodePlugin；
- V3 semantic parity map 全部产生对应 checkpoint；
- 无未登记 shortcut；
- 与 V3 的外部行为差异为零或有显式批准的 allowlist。

## R8：建立 V3/V4 差分与性能冻结门禁

### Baseline Manifest

固定：

```text
v3_release_tag
v3_commit
v3_tree_hash
config_fixture_hash
behavior_corpus_hash
semantic_parity_map_hash
```

### 差分范围

| 领域 | 比较内容 |
| --- | --- |
| Config | 默认值、校验、错误、manifest 语义 |
| Entry | endpoint、header、body、stream intent |
| Route | route group、priority、SWRR、fallback 条件 |
| Target | provider/model/auth pin、availability scope |
| Provider request | URL、headers、body、tools、reasoning 字段 |
| Streaming | event 类型、顺序、终止、usage、错误事件 |
| Continuation | owner、scope、save/restore、pin、expiry |
| Tools | declaration、call/result、servertool followup |
| Error | status、code、message、retry/reroute 结果 |
| Lifecycle | cancel、disconnect、timeout、partial stream |
| Side effects | health、cooldown、scope release、audit |

### 验收规则

```text
unexplained_diff = 0
```

允许差异必须登记：

```text
difference_id
v3_behavior
v4_behavior
reason
externally_observable
approved_by
expiry
```

### 初始性能 guardrail

除非 architecture review 明确调整：

```text
p95 latency regression <= 5%
throughput regression <= 3%
allocations/request regression <= 10%
hot-path cross-language dispatch <= 1 / node
```

### Freeze Record 新增绑定

```text
v3_baseline_commit
semantic_parity_map_hash
differential_report_hash
performance_report_hash
execution_plan_contract_hash
```

没有差分报告的模块只能标记为局部合同稳定，不能宣称 V3 兼容稳定。

## R9：扩展迁移与管理面

只有 R7/R8 通过后，按以下顺序扩展：

```text
local/remote continuation
  -> Relay
  -> 其他 entry/provider 协议
  -> provider variants
  -> lifecycle/CLI
  -> PluginManager dynamic publish
  -> Admin API
  -> WebUI
```

PluginManager 发布规则：

- candidate 在隔离 Context 中 mount/validate；
- publish 原子切换 active epoch；
- 旧请求继续使用旧 binding；
- 新请求使用新 epoch；
- 旧 epoch drain 完成后 dispose；
- 已发布失败不自动回滚或 fallback；
- 修复通过新 candidate 显式发布。

## 6. AppSDK 落地规则

1. 新合同、模块、资源、函数和主线边必须先进入 `.appsdk/project.json` 和四张 map。
2. frozen Active/Protected artifact 不原地修改。
3. 公共合同变化使用 `begin-version`，保留 v1 历史。
4. 每个整改模块必须具备：

```text
goal clarification
contract/map lock
red test design
Playground experiment
evidence
implementation
compile
Active artifact
Protected freeze
V3 compatibility verification
```

5. R0/R1/R2 未完成前，不冻结新的 Runtime/Plugin 公共 API。
6. Management plane 模块不得成为 Skeleton Runtime 的必需依赖。

## 7. 必须新增的反向测试

### Skeleton / Edge

- `04 -> 03` 反向边失败；
- non-adjacent edge 失败；
- plugin 请求 `next_node()` 失败；
- NodeContainer 直连非相邻节点失败；
- 第二 success terminal 失败；
- request/response/error 混接失败。

### Plan / Plugin

- selection group 零个 active 失败；
- selection group 多个 active 失败；
- plugin failure 后尝试同组 fallback 失败；
- cycle/tie/missing dependency/version conflict 失败；
- 同一请求跨节点 plan epoch 变化失败；
- graph/Manifest/loaded plan hash 不一致失败。

### Capability / Plane

- control plugin 获取 DataWrite 失败；
- diagnostic plugin 获取 ControlWrite 失败；
- provider codec 获取 RouteDecision capability 失败；
- snapshot 进入 live path 失败；
- protocol metadata 进入 MetadataCenter 失败；
- control fact 序列化进 normal payload 失败；
- payload 重建 route/continuation/retry 失败。

### Error

- Retry/Cooldown/Reroute 直接进入 ClientProjection 失败；
- 非唯一 owner 构造 verdict 失败；
- semantic plugin 吞错继续成功失败；
- witness/decision token 重复消费失败。

### Config / Canonicalization

- authoring 目录 runtime scan 失败；
- unknown plugin/resource/capability/checkpoint 失败；
- delimiter/Unicode/字段重排不产生 hash 碰撞；
- secret material 进入 Manifest 失败；
- 一个 node 只能有一个 plugin 的旧约束不再作为 v2 合法性规则。

## 8. 实施依赖顺序

```text
R0 canonical truth
  -> R1 semantic parity map
     -> R2 contracts v2
        -> R3 foundation version decisions
           -> R4 PluginPlan compiler
              -> R5 Cordis NodeContainer vertical experiment
                 -> R6 Skeleton Runtime
                    -> R7 Responses Direct vertical slice
                       -> R8 differential/performance gates
                          -> R9 migration + management plane
```

禁止并行穿透的依赖：

- 未完成 R1 不得实现正式 Skeleton Runtime；
- 未完成 R2 不得冻结 Plugin/Container API；
- 未完成 R4 不得让 Runtime 动态排序插件；
- 未完成 R7 不得大规模迁移 provider/continuation；
- 未完成 R8 不得宣称 V4 行为兼容；
- 未完成 R8 不得实施动态 live policy 或 WebUI 发布。

## 9. 里程碑与 Go/No-Go

| Gate | 条件 | Go 后允许 |
| --- | --- | --- |
| `G0 Truth Locked` | canonical ADR + 无冲突真源 | 合同 v2 设计 |
| `G1 Parity Complete` | V3 stage coverage 100%，GAP=0 | Skeleton/Plugin contract bind |
| `G2 Contracts Bound` | v2 schemas + red tests | 基础模块 begin-version / compiler |
| `G3 Plan Deterministic` | byte-stable plan + capability/selection gates | NodeContainer 实验 |
| `G4 Container Proven` | actual Cordis lifecycle + typed bridge + performance evidence | Skeleton Runtime |
| `G5 Vertical Slice` | Responses Direct 完整闭环 | 扩展行为迁移 |
| `G6 Compatibility` | unexplained diff=0 + performance pass | V4.0 compatibility freeze |
| `G7 Management Ready` | request epoch/drain/dispose 稳定 | PluginManager/Admin/WebUI |

## 10. 完成定义

本整改计划完成时必须同时满足：

1. Skeleton 是唯一整体路径和跨节点连接 owner。
2. NodeContainer 内所有行为均由统一 NodePlugin 合同表达。
3. 同一节点支持多个可组合插件；互斥只存在于显式 selection group。
4. V3 每个已验证语义阶段都有唯一 V4 plugin checkpoint。
5. 一次请求全程绑定同一 immutable ExecutionBinding。
6. plugin 权限由 typed capability 强制，而不是仅由文档或字符串声明。
7. plugin 失败统一进入 ErrorChain，不存在语义 fallback。
8. 数据、控制、信息、诊断物理隔离继续成立。
9. Config v2 可编译 deterministic multi-plugin NodePluginPlan。
10. actual Cordis graph、Manifest plan 和 Rust loaded plan hash 一致。
11. Responses Direct 首个纵向切片与 V3 `unexplained_diff=0`。
12. 差分和性能报告进入 AppSDK promotion/freeze gate。
13. 动态管理面不改变在途请求，也不成为核心 Runtime 前置依赖。

## 11. 第一批实际任务

第一批只做架构与合同整改，不迁移业务代码：

- [ ] 新增 canonical runtime composition ADR；
- [ ] 标记旧 one-operator/hook 组合模型为 superseded；
- [ ] 建立 V3 -> V4 semantic parity map；
- [ ] 新增 Skeleton/NodeContainer/NodePlugin/Plan/ExecutionBinding/Capability 合同；
- [ ] 设计 Config v2 multi-plugin authoring 和 canonical Manifest；
- [ ] 为 Edge/Control/Error/BaseNode 建立 public API gap audit；
- [ ] 把本计划和 required gates 登记进 AppSDK maps；
- [ ] 完成 G0/G1/G2 review 后再进入正式实现。

本计划是整改的执行编排真源；它不替代目标架构文档，而是规定目标架构在现有 V4 基础上的纠偏顺序、版本策略和验收门槛。
