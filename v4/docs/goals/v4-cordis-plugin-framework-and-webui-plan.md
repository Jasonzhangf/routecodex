# V4 Cordis Node 插件框架、插件库与 WebUI 改造计划

## 目标

在不修改冻结 BaseNode/Edge、不接入 V3 runtime、不放宽数据/控制边界的前提下，实现：

```text
fixed Skeleton
  -> actual Cordis NodeContainer
     -> deterministic ordered NodePluginPlan
        -> standard plugin library
           -> plugin management framework
              -> WebUI visual management
```

架构真源：[`v4-cordis-node-plugin-architecture.md`](../architecture/v4-cordis-node-plugin-architecture.md)。

## 验收标准

1. Skeleton 是唯一固定流程容器，所有业务行为都在所属 NodeContainer 的有序插件链内执行。
2. NodeContainer 必须由实际 Cordis Context/Fiber/Effect 承载；禁止以 Rust 自造 Cordis-like API 替代。Rust 只执行 Cordis graph 编译出的 typed plan。
3. 每个 NodeContainer 可启用多个 operator，并与 hook/control/debug/snapshot/validator/observer 统一使用 NodePlugin 生命周期。
4. 不同节点可编译不同插件集合和顺序；顺序、依赖、选择组和资源权限全部确定且机器可验证。
5. 标准插件库包含合同、控制、错误、诊断、协议、Chat Process、路由和 Provider 类别，并具有版本、owner、依赖、artifact/contract hash 与独立回归。
6. PluginManager 支持 candidate transaction、compile、validate、dry-run、显式 publish、drain/dispose 和不可变 audit；候选失败不改变 active，已发布失败不自动回旧版本。
7. WebUI 能可视化 Skeleton、节点插件链、插件库、候选 diff、验证、发布和运行状态；UI 不拥有排序、权限和业务语义。
8. 数据/控制/错误/诊断物理隔离，固定相邻链和 V3 行为基线不被插件化破坏。

## 范围

### In scope

- V4 NodeContainer、NodePlugin、PluginPlan、PluginCatalog、PluginManager、Skeleton Runtime、Admin API 和 WebUI。
- 标准插件库及插件准入、版本、依赖、配置、验证、生命周期和审计。
- keyless 基础元素、白盒/黑盒、正向/反向、性能和管理面验证。
- 后续逐节点迁移 V3 已验证行为到 V4 插件库。

### Out of scope

- 修改 V3 runtime、配置或已验证主线。
- 原地修改 frozen BaseNode/Edge Active/Protected artifact。
- 用通用 Cordis event bus 替代 MetadataCenter、VR decision 或 ErrorChain。
- 让 WebUI 直接修改 active runtime、读取业务 payload、保存 secret material。
- 一次性迁移完整 request/response/provider 链。

## 目标文件与模块

计划新增：

```text
v4/contracts/node-container.contract.json
v4/contracts/node-plugin.contract.json
v4/contracts/plugin-catalog.contract.json
v4/contracts/plugin-management.contract.json
v4/contracts/admin-api.contract.json
v4/cordis/routecodex-v4-cordis-host/
v4/cordis/routecodex-v4-cordis-plugins/
v4/crates/routecodex-v4-plugin-contract/
v4/crates/routecodex-v4-plugin-catalog/
v4/crates/routecodex-v4-plugin-plan/
v4/crates/routecodex-v4-node-container/
v4/crates/routecodex-v4-skeleton/
v4/crates/routecodex-v4-runtime/
v4/crates/routecodex-v4-plugin-manager/
v4/crates/routecodex-v4-runtime-inspector/
v4/crates/routecodex-v4-admin/
v4/crates/routecodex-v4-cordis-bridge/
v4/plugin-library/
v4/webui/
```

每个模块必须先进入 `.appsdk/project.json`、resource/function/mainline/verification maps 和 CI/build gate；路径只是计划目标，未注册前不得创建正式实现。

## 风险与规避

| 风险 | 规避 |
| --- | --- |
| NodeContainer 变成第二 Runtime Kernel | 不暴露任意 next-node API；Skeleton 独占跨节点执行 |
| “Cordis”退化成 Rust 仿制接口 | Host 直接依赖实际 Cordis；Node/Fiber/Effect 黑盒测试必须观察真实 Cordis 生命周期 |
| Cordis 与 Rust 各自维护插件图 | Cordis graph 编译单一 plan；graph/Manifest/loaded plan hash 三方不一致即失败 |
| 跨语言桥侵蚀热路径 | typed handles、每节点一次 dispatch 目标、真实 payload benchmark；禁止通用 JSON metadata bridge |
| 多插件顺序隐式漂移 | 编译 phase/DAG/order，拒绝 tie/cycle，Manifest hash 锁定 |
| Cordis event bus 变成控制决策面 | Control/VR/Error 只暴露专用 typed capability，事件仅观察或节点内 wrapper |
| debug/snapshot 影响业务 | diagnostic-only capability、只读投影、反向红测 |
| 插件携带控制字段进 payload | 资源权限 + writer boundary fail-fast；禁止 silent strip |
| 候选失败触发业务 fallback | candidate 从未发布；显式管理失败；active 不变不称为 fallback |
| 已发布失败自动回旧版本 | 禁止自动 rollback；进入 ErrorChain并等待新候选修复 |
| HMR 半更新 | isolated mount + full validation + atomic publish + drain |
| 插件供应链风险 | artifact hash、contract hash、来源、签名/信任、权限和版本准入 |
| UI 成为第二真源 | UI 只从 Admin API/Inspector 重建；服务端 Manifest/active hash 是真源 |
| 插件调度性能退化 | 每节点/每插件预算、disabled diagnostics fast path、copy/clone gate |
| 冻结合同被无意失效 | 新合同归新模块；BaseNode 只有 begin-version 后才能变更 |

## 当前基线

| 元素 | 当前状态 | 处理 |
| --- | --- | --- |
| BaseNode | `frozen active-v1`，L0 白盒+黑盒回归已绑定 | 不修改；NodeContainer 依赖它 |
| Edge | 已独立 crate，消费 frozen BaseNode | 保留相邻边/axis gate |
| Control/MetadataCenter | 已有 Rust owner 和测试 | 作为 control plugin capability，不改成事件总线 |
| ErrorChain/ErrorCenter | 已冻结，固定相邻错误链 | 插件错误统一接入它 |
| Config Compiler | 在途开发，已有 node/operator/plugin/hook/resource authoring | 等当前 owner 收口后扩展 NodePluginPlan；不并行改其代码/maps |
| Standard Node 文档 | 多 operator 注册，但每节点只选一个 active；hook 独立 | 由 NodeContainer 多 active 插件链替代 |
| Plugin library/manager | 不存在 | 新模块实施 |
| WebUI 管理面 | 不存在 | 在 runtime inspector 和管理 API 稳定后实施 |

## 模块计划

### M0：合同与 review 面

新增目标合同，不修改冻结 `node-graph.contract.json`：

```text
contracts/node-container.contract.json
contracts/node-plugin.contract.json
contracts/plugin-catalog.contract.json
contracts/plugin-management.contract.json
contracts/admin-api.contract.json
```

AppSDK 新模块：

```text
routecodex-v4-plugin-contract
```

合同必须定义 NodePlugin kind/effect、资源权限、依赖、顺序、selection group、错误入口、artifact identity 和生命周期。为旧 frozen BaseNode contract 保持独立输入，避免无意义触发 BaseNode 新版本。

验证基础元素：

- schema 正向样本可编译；
- unknown field、未知资源、未知 node、非法 effect、缺 owner、缺版本全部拒绝；
- diagnostic 写 payload、control 写 normal data、跨 node selector 全部拒绝；
- 合同 hash 和 canonical JSON byte-stable。

退出条件：合同、资源 owner、function/mainline/verification map、正反测试设计齐全；状态从 `design` 到 `contract_bound`。

### M1：NodePlugin Contract 与 Catalog

实现：

```text
routecodex-v4-plugin-contract
routecodex-v4-plugin-catalog
```

Catalog 只收录已验证插件 descriptor/artifact，不执行插件。插件 identity 至少绑定：

```text
plugin_id
version
owner
artifact_hash
contract_hash
supported_node_roles
services_provided/injected
resources_read/written
required_tests
```

验证基础元素：

- 同 ID/版本/hash 重复注册幂等；不同 hash 冲突失败；
- 版本依赖可解与不可解成对；
- owner 唯一；
- artifact/contract hash 不匹配失败；
- Catalog snapshot 只读，不能成为业务请求输入。

### M2：确定性排序与 NodePluginPlan Compiler

实现纯编译模块：

```text
routecodex-v4-plugin-plan
```

输入为 Node descriptor、候选 plugins、配置和信息资源；输出为确定性 `NodePluginPlan`。排序规则为 phase -> before/after DAG -> order -> stable identity。selection group 只选择互斥变体，不排除组外插件。

验证基础元素：

- 相同语义、不同 authoring 顺序生成相同 hash；
- 每个节点可有不同插件集合和顺序；
- 同节点多个 operator 同时 active；
- selection group 恰好一个 active；
- cycle、tie、missing dependency、version conflict 全部失败；
- 非相邻 node dependency 和私有 service 跨 node 注入失败。

黑盒样本：用两个 Node 的不同插件顺序编译完整 Manifest，读取公开计划确认顺序和 hash。

### M3：实际 Cordis Host、桥与 NodeContainer Runtime

实现：

```text
routecodex-v4-cordis-host
routecodex-v4-cordis-plugins
routecodex-v4-cordis-bridge
routecodex-v4-node-container
```

Host 必须直接使用实际 Cordis，并依赖 frozen BaseNode、Control、Error 和 PluginPlan 的 typed bridge。Cordis 提供真实的局部 Context、Service/inject、Fiber、Effect disposer、事务 mount、publish、drain 和 dispose；Rust 不实现第二套 Cordis 容器。

先在 `v4/playground/experiments/` 验证一条最小纵切：实际 Cordis Root/Pipeline/Node Context 装载三个插件，编译 plan，经 typed native bridge 每节点一次进入 Rust executor，再返回 typed output。实验必须记录 per-plugin 与 per-node bridge 的延迟、payload copy、生命周期和错误传播证据；正式实现默认采用每节点一次 dispatch。

首个最小容器只需要：

- 一个 immutable Node descriptor；
- 一个实际 Cordis NodeContext 和多个 Plugin Fiber；
- 一个 compiled NodePluginPlan；
- Service provide/inject；
- serial/waterfall/parallel 三种受限执行模式；
- entry/exit/error 诊断发布；
- typed error intake；
- reverse-order Effect disposal。

验证基础元素：

- mount -> execute -> drain -> dispose 正向生命周期；
- 缺依赖时不发布；
- 插件初始化失败整体回滚；
- dispose 逆序且只执行一次；
- ordinary operator 未调用 `next()` 失败；登记 terminal plugin 可短路；
- semantic plugins 串行；diagnostic-only plugins 并行但不能修改结果；
- Node A 插件不可访问 Node B 私有 service；
- 同一请求执行期间 plan 不变化。
- Cordis graph hash、Manifest plan hash、Rust loaded plan hash 一致；任一不一致拒绝 publish/execute。
- Cordis Effect dispose 能释放对应 Rust handle；泄漏或重复释放失败。
- typed bridge 不接受通用 metadata JSON，control/debug handle 不能序列化到业务 payload。

黑盒：通过 NodeContainer 公共 API 在实际 Cordis Context 装载三个插件，验证 Fiber、顺序、输出、记录、Rust handle 和卸载，不读取 Cordis/Rust 内部 Map/Vec。

### M4：Skeleton Runtime

实现：

```text
routecodex-v4-skeleton
routecodex-v4-runtime
```

Skeleton 持有固定 NodeSlot 和相邻 Edge，每个 slot 解析到一个 active NodeContainer。Runtime 只执行相邻节点并转发 typed output；NodePlugin 不能获得 `next_node()` 或全局任意 dispatch API。

验证基础元素：

- 两节点、三节点最小 Skeleton 正向执行；
- 跳节点、倒序、重复 position、unknown terminal 编译失败；
- Node 错误进入 ErrorChain，不继续正常 success chain；
- diagnostics failure 不改变业务结果，但必须记录自身失败；
- request/response/error 三条链不混接；
- control resource 不能出现在 data edge。

黑盒：启动无网络 Runtime，执行 fixture 穿过完整最小 Skeleton，验证公开输出和公开 audit，不依赖内部实现。

### M5：标准插件库

按最小依赖顺序实现，不先做全部 Provider：

1. Contract 插件：input/output/resource/scope validators。
2. Diagnostic 插件：debug、snapshot、timing、ledger。
3. Control 插件：scope consume、MetadataCenter access、payload-cycle record。
4. Error 插件：typed intake、ErrorCenter adapter、ErrorChain projection adapter。
5. Protocol 插件：先做一个 keyless mock protocol codec，再做真实协议。
6. Chat Process 插件：request/response governance，必须回链 V3 行为样本。
7. Routing 插件：只生产/消费 typed facts；VR 保持唯一决策 owner。
8. Provider 插件：capability、compat、wire、transport 分离。

每个插件独立包包含：

```text
plugin manifest
source
contract tests
whitebox tests
blackbox NodeContainer test
resource permission test
negative misuse test
README/model behavior
```

插件库准入：required tests、artifact hash、contract hash、owner 和 compatible Node roles 全部通过后才进入 Catalog。

### M6：插件管理框架

实现：

```text
routecodex-v4-plugin-manager
routecodex-v4-runtime-inspector
routecodex-v4-admin
```

管理事务：

```text
install artifact
  -> create authoring candidate
  -> resolve/compile
  -> validate
  -> isolated mount smoke
  -> review diff
  -> explicit publish
  -> drain/dispose previous container
```

管理操作：

- list/install/remove artifact；
- enable/disable/configure plugin；
- 调整 order/before/after；
- 选择 selection-group variant；
- compile/validate/dry-run candidate；
- inspect active/candidate/failed；
- publish/discard；
- audit history。

删除已安装 artifact 属破坏动作，需要显式授权并先证明无 active/candidate 依赖。Disable 只产生新 candidate，不直接拔除 active Fiber。

验证基础元素：

- candidate 修改不影响 active；
- stale base hash 发布失败；
- candidate mount 失败不改变 active；
- publish 后新请求使用新 plan，旧 in-flight 使用旧 plan直到 drain；
- 已发布运行失败不自动回旧 plan；
- audit 记录 actor/action/base/candidate/result/hash；
- 并发 publish 只有一个成功。

### M7：WebUI 可视化管理

前置：Admin API、Runtime Inspector、candidate transaction 和 audit 合同稳定。WebUI 只消费 API，不读取文件、Active artifact 或 Cordis 内部 Map。

页面顺序：

1. Skeleton Graph：节点、边、状态、错误入口。
2. Node Detail：ordered plugins、phase/order、依赖、资源、selection group。
3. Plugin Library：版本、来源、hash、能力、兼容节点、测试状态。
4. Candidate Editor：enable/disable/config/order/before/after。
5. Diff & Validation：active/candidate 图差异、gate、dry-run、review。
6. Publish Dialog：actor、base hash、candidate hash、影响节点、drain 状态。
7. Runtime Inspector：active plan、container lifecycle、in-flight、错误、诊断摘要。
8. Audit Timeline：不可变管理记录。

WebUI 黑盒验证：

- 从插件库创建 candidate；
- 在两个节点配置不同 operator 顺序；
- compile 后图形顺序与 Manifest 一致；
- 构造循环依赖时 UI 显示 typed validation error，不能发布；
- 发布后 active hash 和 Runtime Inspector 更新；
- candidate 失败时 active 保持；
- refresh/reconnect 后状态从服务端 truth 重建；
- UI 不包含任何业务 payload 或 secret material。

产品可见 GUI 进入 PR 时，按项目规则录制真实 WebUI + 真实管理 API 的 GIF；mock-only GIF 不算完成。

### M8：真实 Pipeline 迁移

先用 keyless fixture 和 mock transport，再逐节点对齐 V3：

```text
config/lifecycle
  -> diagnostics
  -> request inbound
  -> response inbound
  -> Chat Process
  -> routing/target
  -> provider compat/wire
  -> transport
  -> error/retry/continuation integration
```

每个节点迁移必须提供：V3 baseline、输入/输出合同、插件拆分、顺序、正反测试、黑盒对照、性能和 payload copy 证据。禁止一次性迁移整条链。

## 验证层级

| 层级 | 对象 | 白盒 | 黑盒 | 关键反例 |
| --- | --- | --- | --- | --- |
| L0 | frozen BaseNode | 现有 12 tests | 现有 public API regression | BaseNode 出现业务 operator |
| L1 | frozen Edge | 邻接/axis/scope | public edge validator | shortcut/axis mismatch |
| L2 | Plugin Contract/Catalog | schema/owner/hash | public catalog registration | 未知字段、hash 冲突 |
| L3 | PluginPlan | DAG/order/selection | compile full Node plans | cycle/tie/multi-select |
| L4 | NodeContainer | lifecycle/effect/scope | public mount/execute/dispose | partial publish/cross-node access |
| L5 | Skeleton Runtime | node/edge orchestration | keyless full-chain fixture | skip/reorder/error-to-success |
| L6 | Plugin Manager | transaction/concurrency | active/candidate publication | stale publish/auto rollback |
| L7 | Admin/WebUI | API/UI state | browser real flow | UI truth drift/direct active mutation |
| L8 | Product Runtime | protocol/provider semantics | installed live replay | payload leak/fallback/semantic drift |

每层冻结前的 RegressionReport 必须同时包含白盒和黑盒、非零通过数、精确 source/artifact/API/scope/input hash。状态机、生命周期、控制、错误和资源边界测试必须正反成对。

## 基础元素验证计划

在真实业务插件前，先用最小元素证明框架：

### Element A：Service 与 inject

- 正：在实际 Cordis Context 中，Provider plugin 发布 service，Consumer plugin 等待后激活。
- 反：缺 service、重复 exclusive service、循环 inject 均拒绝发布。

### Element B：Effect 与卸载

- 正：实际 Cordis Fiber dispose 使注册项和对应 Rust handle 逆序移除。
- 反：重复 dispose 不重复副作用；泄漏注册被 gate 捕获。

### Element B2：Cordis/Rust 单一计划

- 正：Cordis graph 编译的 plan hash 与 Manifest、Rust loaded plan 完全一致，每节点一次 typed dispatch 得到预期结果。
- 反：篡改任一插件顺序/hash、传入通用 metadata JSON、复用已 dispose handle 均 fail-fast。

### Element C：有序多 Operator

- 正：同节点 A -> B -> C，另一个节点 C -> A，输出和记录符合各自顺序。
- 反：同 order 歧义、before/after cycle、未声明 terminal short-circuit 失败。

### Element D：选择组

- 正：协议 typed fact 只激活一个 codec，同时执行组外 validator/control/debug 插件。
- 反：零选择、多选择、按 provider id/model prefix/payload 猜测选择均失败。

### Element E：数据/控制隔离

- 正：semantic plugin 只改 data，control plugin 只操作 capability。
- 反：control 序列化进 provider/client payload、payload 重建 control、debug 写 MetadataCenter 全部 fail-fast。

### Element F：错误链

- 正：任意插件错误产生 typed intake 并沿相邻 ErrorChain。
- 反：吞错、继续成功、直接 ClientProjected、message-only projection 失败。

### Element G：诊断

- 正：debug/snapshot/timing 并行观察且不改变业务输出。
- 反：诊断返回替换结果、被 live path 读取、影响 routing 失败。

### Element H：事务发布

- 正：candidate 全部验证后原子发布，旧 in-flight 排空。
- 反：部分 mount、stale base、并发 publish、候选失败均不改变 active。

### Element I：可视化真源

- 正：WebUI 图由 Admin API 的 compiled Manifest/Inspector 投影生成。
- 反：UI 本地缓存不能覆盖服务端 active，刷新后不得保留幽灵插件。

## 性能计划

NodeContainer 插件化必须有基线预算：

- 每 NodeContainer dispatch 固定开销；
- Cordis -> Rust 每节点 typed bridge 开销和跨语言次数；
- 每插件调用开销；
- Context/Scope 创建与复用；
- Service lookup；
- diagnostic disabled/enabled 开销；
- payload clone/copy 次数和字节；
- Node 级并发和 drain 延迟。

性能优化只能在语义等价后进行。禁止用裁剪真实 payload、跳过插件、禁用 gate 或旁路 Runtime Kernel换性能。

## AppSDK 实施合同

每个新模块按：

```text
goal clarification
  -> resource/function/mainline/verification map
  -> Playground experiment
  -> EvidenceRecord
  -> ReviewRecord PASS
  -> PromotionRecord
  -> compile Active artifact
  -> whitebox+blackbox RegressionReport
  -> FreezeRecord
  -> Protected archive
```

冻结模块若需变更，先 `appsdk begin-version`，禁止原地修改旧 Active/Protected。Generated/Active/Protected 不能手工编辑。

## 当前并发边界

`resource_id:v4.config.manifest` 当前由另一 worker 占用。此计划不修改 Config crate、AppSDK maps 或现有 config mock。NodePluginPlan 接入 Config Compiler 必须等待该 owner 收口或通过 handoff 协调，然后新建独立版本/扩展设计。

## 完成标准

- 架构合同明确 Skeleton、NodeContainer、NodePlugin、PluginManager、Admin/WebUI 的唯一 owner。
- 每节点支持多个 active、有序、可依赖的插件；不同节点可有不同插件集合和顺序。
- 每个节点由实际 Cordis Context/Fiber/Effect 承载；Rust executor 只消费同 hash 的编译计划，没有 Cordis-like 第二实现或双真源。
- Debug、snapshot、hook、control、operator 均使用统一插件生命周期。
- 标准插件库具备准入、版本、依赖、资源权限和独立回归。
- candidate transaction、事务发布、drain/dispose 和 audit 可验证。
- WebUI 可视化 Skeleton、节点插件链、候选 diff、验证、发布和运行状态。
- 数据/控制/错误/诊断边界与固定 Skeleton 未被插件化破坏。
- 真实运行时完成 build/install/restart/live replay 后再进行交付级 review；当前文档阶段不声称 runtime 完成。
