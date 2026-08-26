# RouteCodex V4 功能完成总计划

状态：`proposed_canonical`
执行状态：`ready_for_review_and_execution`
文档 ID：`V4-FEATURE-COMPLETION-20260822`
审计基线：当前 V4 worktree 基准 tree（启动时从 HEAD 与 tree hash 解析并固定；历史 `main@2fda3f049190620511f2d2c6069a7bec0dd2871f` 仅作封存记录）
行为基线：V3 当前生产实现；V4 日常构建只读取经审核冻结的 V3 baseline
目标版本：`V4.0 feature-complete / production-admissible`
配套执行提示词：[`v4-feature-completion-goal-prompt.md`](v4-feature-completion-goal-prompt.md)

当前执行续篇：以当前 V4 分支声明的基准 tree 为唯一开发基线，执行顺序、批次边界和 review 解耦规则见 [第 28 章](#28-runtime-007-后的分层批量开发与接线计划)。第 28 章覆盖本文件第 4.1 节中旧本地快照判断、第 23/24 节逐任务串行 review 的旧执行顺序，并细化第 7 节的 M1/M2 依赖：只解除 M2 P0 插件的 source-development dependency，M2 production integration/status promotion 仍依赖 M1；未被第 28 章覆盖的产品范围和最终完成定义继续有效。

## 0. 文档定位与真源关系

本文件是 V4 从当前 canary/foundation 状态推进到“功能对齐 V3、生产执行路径完全采用新架构、可灰度接管”的总执行计划。它不替代已经冻结的底层合同，也不授权修改 V3。

真源优先级如下：

1. 本文件：产品功能完成范围、里程碑、依赖顺序和完成定义；
2. `v4/docs/architecture/v4-cordis-node-plugin-architecture.md`：Skeleton、Cordis Host、NodeContainer、NodePluginPlan 的运行模型；
3. `v4/docs/architecture/v4-standard-nodes-and-node-graph.md` 与 `v4/contracts/node-graph.contract.json`：固定拓扑、节点位置、相邻边和终态；
4. `v4/docs/architecture/v4-data-control-plane-boundary.md` 与对应合同：data/control/information/diagnostic 物理隔离；
5. `v4/docs/architecture/v3-v4-semantic-parity-map.yml`：V3 semantic stage 到 V4 container/plugin/checkpoint 的映射；
6. 各 slice plan、compatibility slice 和现有 L2/red tests：局部实现证据；
7. `v4/contracts/v3-baseline/manifest.json`：V4-owned、reviewed、frozen 的 V3 对照基线。

`v4-long-horizon-goal-prompt.md` 保留为历史长线目标记录；本文件和配套 goal 提示词作为新的产品完成总闸。若历史文档与本文件冲突，以本文件的范围、依赖顺序和完成定义为准，但任何冻结合同变更仍必须走 AppSDK re-freeze 流程。

## 1. 核心结论

V4 不推倒重做。保留并继续强化以下方向：

- 固定 Skeleton 是唯一跨节点执行 owner；
- 每个固定节点位置由真实 Cordis NodeContainer 承载；
- 节点行为由不可变、确定性编译的 NodePluginPlan 组成；
- Rust 是业务语义和热路径的唯一 owner，Cordis 是插件组合与生命周期的唯一 owner；
- Active artifact、Manifest、plan、graph 和 loaded hash 必须一致；
- data、control、information、diagnostic、error 继续物理隔离；
- V3 只作为只读行为基线和 fixture 来源，不成为 V4 runtime 依赖。

当前最关键的架构断点不是缺少更多文档，而是生产 `rccv4` 仍存在直连业务 helper 的路径。最终生产二进制必须从：

```text
HTTP Handler
  -> direct protocol helper
  -> direct router helper
  -> direct provider transport
  -> direct response helper
```

收敛为：

```text
HTTP Admission
  -> immutable ExecutionBinding
  -> SkeletonRuntime
  -> adjacent NodeContainer
  -> immutable NodePluginPlan
  -> typed plugin handles/services
  -> ErrorChain or success terminal
```

在这个断点关闭之前，不扩展新的 provider 特例、动态 WebUI 变更、HMR、第三方插件或新的临时 fallback。

## 2. V4.0 产品完成定义

V4.0 只有同时满足以下条件才算“功能完成”：

1. 当前选定 V3 baseline 中的全部 feature 均进入 `differential_pass` 或更高状态；
2. 所有生产入口都经过真实 `Skeleton -> NodeContainer -> NodePluginPlan`；
3. `runtime-bin` 不直接拥有协议转换、路由选择、provider 传输、tool governance 或 client projection 业务；
4. OpenAI Responses、OpenAI Chat、Anthropic、Gemini 及基线确认保留的 WebSocket 能力完整；
5. Router、Target、Provider Health、probe、retry/reroute/fail action 与 V3 等价；
6. session admission、SSE 生命周期和客户端断开完整；V4 不实现 Responses continuation；
7. Tool Governance、Servertool、Stopless、Web Search 多轮完整；
8. Debug、Snapshot、Timing、Console、Admin、WebUI、配置迁移和正式发布可用；
9. 性能预算、并发、长期流、restart/drain、rollback 达标；
10. Canary 和回滚演练通过，但默认不自动替换或停止 V3。

## 3. 功能状态模型

现有 `mapped` 只表示“V3 语义有 V4 抽象位置”，不能表示产品完成。每个 feature 使用统一状态机：

```text
mapped
  -> contracted
  -> implemented
  -> pluginized
  -> production_integrated
  -> differential_pass
  -> live_pass
  -> frozen
```

| 状态 | 定义 | 可否计入功能完成 |
| --- | --- | --- |
| `mapped` | 有 V4 container/plugin/checkpoint 映射 | 否 |
| `contracted` | 输入、输出、owner、资源、错误和 gate 已锁定 | 否 |
| `implemented` | 代码和局部测试存在 | 否 |
| `pluginized` | 行为位于真实 NodePlugin 或唯一 typed service | 否 |
| `production_integrated` | 真实 `rccv4` 请求确实执行该实现 | 否 |
| `differential_pass` | V3/V4 同 fixture `unexplained_diff=0` | 是，静态/离线完成 |
| `live_pass` | 真实 provider、并发、错误、断线验证通过 | 是，生产准入 |
| `frozen` | Active artifact、升级、drain、rollback 证据齐全 | 是，发布完成 |

禁止通过以下方式提升状态：

- 仅更新 YAML/JSON map；
- 仅有 descriptor 而没有生产 handle；
- 仅有 mock/keyless 成功路径；
- 测试没有经过 production entrypoint；
- 忽略未解释字段或整个对象；
- 保留旧直连路径作为 fallback；
- 用 handler/SSE/outbound 补偿掩盖节点缺失。

## 4. 当前基线判断

### 4.1 2026-08-23 本地历史快照（已被第 28 章覆盖）

- 本地主 tree 和全部本地 worktree 的 `v4/` 均无未提交改动；`origin/main..main` 的 9 个领先提交都是 V3 SSE/transport 修复，对 `v4/` 的 diff 为空。
- `V4-RUNTIME-001` 已有 typed `ExecutionBinding` 实现和正向/binding-drift 测试；它只能证明 immutable binding slice，不能证明 M1 完成。
- 该本地快照采集时，`ActiveExecutionEpoch` / `V4-RUNTIME-002` 及其 publish、in-flight pin、drain、dispose 生命周期尚未落地；当前 runtime 只有 `ExecutionBinding.plan_epoch` 字段。
- 该本地快照采集时曾依赖不可达的云端 commit；该外部锚点现已作废，后续以当前 V4 基准 tree 的真实源码、合同和测试作为唯一判断依据。
- 当前调度从当前 V4 基准 tree 开始：先审计现有 runtime 对 R002 合同的覆盖；缺口由当前 tree 的唯一 owner 实现，不依赖不可达的外部 commit，也不建立重复 epoch owner。

| 领域 | 当前基线 | V4.0 目标 |
| --- | --- | --- |
| Architecture contracts | 基础成熟，门禁较完整 | 作为稳定边界继续使用 |
| Config Compiler | Config01–05、digest、Active artifact 基础存在 | 扩展完整产品配置、V3 import、迁移与冻结 |
| Cordis/NodeContainer | 框架、生命周期、typed bridge 存在 | 接入所有生产请求 |
| Standard Plugins | descriptor/catalog/keyless 最小行为 | 迁移真实产品语义并发布 artifact |
| `rccv4` | 独立 canary，可提供首条 Responses/Chat 链路 | 完整生产 runtime |
| Provider transport | 外部 `curl` 进程 canary | Rust async HTTP/TLS、连接池、取消、backpressure |
| HTTP server | 同步 TCP 简化实现 | 生产级 admission/streaming/cancellation |
| Router | priority 排序后首选 | route group/pool/priority/SWRR/health/capability |
| Error/Health | typed ErrorChain 基础存在 | 完整 provider action、probe、cooldown、quota |
| Continuation | not implemented by design | V3 `previous_response_id` remains closed |
| SSE | 基本 frame/terminal 校验 | 完整 first-frame/EOF/drop/backpressure/keepalive |
| Tool/Servertool | 最小 governance/投影 | 多协议工具治理、真实执行、状态机、多轮 |
| Diagnostics | 合同和部分 owner | 生产接入、预算、只读证据 |
| Admin/WebUI | typed command/query 基础 | 认证授权、持久化、发布/回滚、可视化 |
| Release | 本地安装脚本 | 多平台、签名、SBOM、正式发布和回滚 |
| Parity | semantic map 64/64、resource 103 | 产品状态账本、fixture 差分、live evidence |

## 5. 最终目标架构

```text
rccv4
  ├─ CLI intent parsing
  ├─ Config authoring/compiled Manifest loading
  ├─ Managed lifecycle
  ├─ Listener bootstrap
  └─ ActiveExecutionEpoch loading

ActiveExecutionEpoch
  ├─ skeleton_version
  ├─ manifest_hash
  ├─ plan_epoch
  ├─ execution_plan_hash
  ├─ plugin_artifact_set_hash
  └─ NodeContainerRegistry

Request Admission
  -> bind immutable ExecutionBinding
  -> request-local ExecutionContext
  -> SkeletonRuntime
     -> adjacent NodeContainer
        -> immutable NodePluginPlan
           -> typed plugin/service handles
  -> success terminal
     or
  -> PluginFailure -> NodeFailure -> ErrorIntake -> ErrorChain
     -> retry/reroute/fail decision
     -> client projection
```

### 5.1 `runtime-bin` 允许拥有

- CLI dispatch；
- Manifest 加载与 digest 校验；
- lifecycle wiring；
- listener/bootstrap；
- ActiveExecutionEpoch 装载；
- 将 HTTP admission 转成 typed entry；
- 将 typed terminal 交给 server owner 发出。

### 5.2 `runtime-bin` 禁止拥有

最终必须移除或只保留为插件内部实现细节：

```rust
project_chat_request_to_responses(...)
select_target(...)
send_responses(...)
send_responses_streaming(...)
parse_responses_provider_payload(...)
```

同类禁令也适用于后续新增的 Anthropic/Gemini/tool helper。二进制不得按 provider id、model prefix 或 payload shape 猜测业务路径。

## 6. 全局不可协商不变量

### INV-FC-01：唯一生产执行路径

所有生产 request/response/error 都必须经过 Skeleton 和 NodeContainer。不存在“新插件路径失败后回旧 helper”的 fallback。

### INV-FC-02：单请求 immutable binding

一次请求从 entry 到 success/error terminal 使用同一组：

```text
skeleton_version
manifest_hash
plan_epoch
execution_plan_hash
plugin_artifact_set_hash
```

节点间不重新读取 active pointer，不重排插件，不切换版本。

### INV-FC-03：唯一 owner

- Skeleton：跨节点拓扑；
- Cordis Host：Context/Fiber/Effect 和插件生命周期；
- NodeContainer：节点内 plan 绑定、执行、in-flight、drain；
- Runtime：相邻节点 orchestrate；
- Router：route/target decision；
- Provider：transport/auth/provider-local evidence；
- Health/Error：失败记录和 action；
- Chat Process：tool/governance；
- Server：listener/admission/client framing；
- Diagnostics：只读投影；
- Admin/WebUI：管理请求和投影，不拥有业务语义。

### INV-FC-04：typed capability，而非字符串自律

插件只能获得被 plan 编译允许的窄能力：

```text
DataRead<Input>
DataWrite<Output>
ControlCapability<AllowedFacts>
InformationView<AllowedResources>
DiagnosticPublisher
ErrorIntake
```

禁止通用全局 Context、任意 JSON metadata 或跨节点 dispatcher。

### INV-FC-05：统一失败路径

除明确声明 `diagnostic_only + record_and_isolate` 的插件外，所有失败进入：

```text
PluginFailure -> NodeFailure -> ErrorIntake -> ErrorChain
```

selection group 中一个实现失败后不得尝试同组其他实现伪装成功。

### INV-FC-06：数据与控制物理隔离

route、target、health、retry、scope、stopless、secret、debug、manifest digest 不能进入正常 provider/client payload。payload 也不能重建这些控制事实。

### INV-FC-07：V3 只读且构建隔离

普通 V4 build/test/verify 只读取 reviewed frozen baseline。最新 V3 差异通过独立 parity-sync/supersession 流程进入，不允许 canonical build 动态读取 V3 HEAD。

### INV-FC-08：先静态闭环，再动态管理

PluginManager、Admin 可变更、WebUI 发布、HMR、第三方供应链必须在生产 NodeContainer 路径和差分门禁成立后开放。

### INV-FC-09：先红后绿

每个不变量先提供可证明失败的 red fixture，再实现唯一真源转绿。禁止先实现后补一个永远不会失败的测试。

### INV-FC-10：冻结资产不静默修改

base-node、edge、control、error、config 等已冻结 artifact 若需公共合同变更，必须：

```text
begin-version
  -> evidence
  -> review
  -> promotion
  -> regression
  -> compile
  -> publish
  -> protected/active update
```

## 7. 执行里程碑总览

| 里程碑 | 目标 | 优先级 | 主要依赖 |
| --- | --- | --- | --- |
| M0 | 产品真值、parity ledger、V3 baseline supersession | P0 | 当前基线 |
| M1 | 关闭生产执行平面断点 | P0 | M0 合同最小闭环 |
| M2 | 真实 Standard Plugin 迁移与 runtime 拆解 | P0 | M1（production integration/status promotion）；source development 可按第 28 章在 M1 wiring 前独立完成 |
| M3 | V3/V4 产品差分 harness | P0/P1，可与 M1/M2 部分并行 | M0 |
| M4 | 生产 transport、协议和 Provider 完整迁移 | P1 | M1/M2/M3 |
| M5 | Router、Target、Health、Error Action | P1 | M1/M3/M4 基础 |
| M6 | Session Admission、SSE 生命周期 | P1 | M4/M5 |
| M7 | Tool Governance、Servertool、Stopless、Web Search | P1/P2 | M4/M6 |
| M8 | Diagnostics、Admin、WebUI、配置迁移、Release | P2 | M1–M7 |
| M9 | 性能、Canary、灰度、回滚与切换准备 | P2/P3 | M8 |
| M10 | 全量 freeze、文档收口、V3 维护/退役准备 | P3 | M9，且需人工授权 |

---

# 8. M0：建立产品真值与持续对齐机制

## 8.1 目标

把“架构映射”与“产品完成”分开，建立后续所有任务的唯一状态真源，并解决 frozen V3 baseline 与最新 V3 行为持续演进之间的关系。

## 8.2 工作包

### `V4-PARITY-001`：产品 parity ledger

新增：

```text
v4/docs/architecture/v3-v4-product-parity-ledger.yml
v4/contracts/v3-product-parity-ledger.schema.json
v4/scripts/architecture/verify-v4-product-parity-ledger.mjs
```

每条 feature 必须包含：

```yaml
feature_id:
v3_baseline_id:
v3_baseline_commit:
v3_owner:
v3_entrypoints:
v3_fixture_ids:
v4_container:
v4_plugin_owner:
contract_status:
implementation_status:
production_path_status:
differential_status:
live_status:
artifact_status:
intentional_differences:
blocking_dependencies:
evidence_paths:
```

### `V4-PARITY-002`：baseline delta/supersession

新增独立命令：

```text
verify-v4-v3-baseline-delta.mjs
compile-v4-v3-baseline-supersession.mjs
```

规则：

- 不进入普通 `verify:ci` 的 live V3 读取路径；
- 从明确选定的 V3 commit/release 生成 feature/resource/fixture delta；
- 更新 baseline 必须同时更新 source commit、digest、identity count 和 supersession record；
- 删除、重命名、合并 feature 必须显式审核；
- 最近 V3 的 provider probe、dynamic backoff、SSE EOF、tool schema、empty content、Responses input text parts 等行为必须进入 delta。

### `V4-PARITY-003`：状态提升门禁

新增 gate：

```text
verify-v4-product-parity-status.mjs
```

至少验证：

- `production_integrated` 必须绑定 production entrypoint 测试；
- `differential_pass` 必须绑定 fixture/report；
- `live_pass` 必须绑定 live evidence；
- `frozen` 必须绑定 artifact/promotion/rollback evidence；
- `mapped` 不得计入完成率。

### `V4-PLAN-001`：文档状态收口

统一文档措辞：

```text
semantic parity = mapped
real runtime admission = first production canary slice
product parity = ledger status
reuse audit = historical decision source
```

## 8.3 验证

- ledger schema 正反测试；
- 缺 feature、重复 feature、非法状态倒退、无证据提升、baseline digest 漂移均为红；
- 64 个现有 feature 完整登记；
- `npm --prefix v4 run verify:ci`；
- AppSDK verify/admission；
- DSH review。

## 8.4 退出条件

- 64/64 feature 有产品状态；
- 103 个资源仍保持双源一致；
- baseline delta 可重复生成；
- 任何 feature 完成率均由机器从 ledger 计算；
- 不再出现“semantic mapped=产品完成”的表述。

---

# 9. M1：关闭生产执行平面断点

## 9.1 目标

让真实 `/v1/responses` 和 `/v1/chat/completions` 第一次完整经过：

```text
HTTP Admission
  -> ExecutionBinding
  -> Skeleton
  -> NodeContainer
  -> NodePluginPlan
  -> typed handle
```

## 9.2 工作包

### `V4-RUNTIME-001`：ExecutionBinding

定义不可伪造的 typed binding：

```rust
struct ExecutionBinding {
    skeleton_version: SkeletonVersion,
    manifest_hash: ManifestHash,
    plan_epoch: PlanEpoch,
    execution_plan_hash: ExecutionPlanHash,
    plugin_artifact_set_hash: ArtifactSetHash,
}
```

要求：

- admission 时一次生成；
- request/response/error 全链携带；
- 只能进入 diagnostic/typed context；
- 禁止序列化进 provider/client normal payload。

### `V4-RUNTIME-002`：ActiveExecutionEpoch

```rust
struct ActiveExecutionEpoch {
    binding_template: ExecutionBindingTemplate,
    containers: NodeContainerRegistry,
    graph_hash: GraphHash,
    manifest: Arc<CompiledManifest>,
}
```

要求：

- 原子发布；
- 新请求读取新 epoch；
- 在途请求继续使用旧 epoch；
- 旧 epoch in-flight=0 后 drain/dispose；
- 不自动 rollback 隐藏失败。

### `V4-RUNTIME-003`：Config/Manifest 输出 NodePluginPlan

Config Compiler 必须为所有 active node 输出：

- node identity；
- exact plugin entries；
- resolved dependency/order；
- exact selection group decision；
- resource capabilities；
- plan hash；
- artifact set hash。

### `V4-RUNTIME-004`：Cordis mount 与 Rust publication

启动路径：

```text
compiled Manifest
  -> real Cordis Root/Pipeline/Node Context
  -> Plugin Fiber mount
  -> dependency/order/permission compile
  -> plan/hash validation
  -> Rust NodeContainer declare/publish
  -> ActiveExecutionEpoch publish
```

### `V4-RUNTIME-005`：生产 request path 接入

改造 `PipelineHandler`：

```text
Arc<Mutex<SkeletonRuntime>>
```

替换为：

```text
Arc<ActiveEpochStore>
+ request-local ExecutionContext
+ session/conversation scoped control handles
```

禁止单一全局 mutex 串行所有请求。

### `V4-RUNTIME-006`：生产 response/error path 接入

- Provider raw 进入 response chain NodeContainer；
- 插件失败进入 NodeFailure/ErrorIntake；
- ErrorChain decision 由 executor 消费；
- client projection 只在合法 terminal；
- SSE 部分提交后的错误有明确投影。

### `V4-GATE-001`：production NodeContainer path gate

新增：

```text
verify-v4-production-nodecontainer-path.mjs
```

红测至少覆盖：

- runtime-bin 直接调用协议转换；
- runtime-bin 直接调用 Router；
- runtime-bin 直接调用 Provider transport；
- runtime-bin 直接 parse/project client response；
- production endpoint 未记录 visited node/plugin；
- 插件请求跨节点 dispatcher；
- 旧 helper path 作为 fallback 保留。

### `V4-RUNTIME-007`：epoch 并发和生命周期

覆盖：

- publish 时在途请求；
- drain 非零拒绝；
- dispose 顺序；
- candidate 失败不影响 active；
- published execution failure 记录但不自动改 active；
- restart 后 epoch identity 和 manifest digest 一致。

## 9.3 诊断证据

每个请求在诊断通道产生：

```json
{
  "manifest_hash": "...",
  "plan_epoch": "...",
  "execution_plan_hash": "...",
  "plugin_artifact_set_hash": "...",
  "visited_nodes": [],
  "executed_plugins": [],
  "terminal": "success|error|client_drop"
}
```

## 9.4 退出条件

- 两个 POST endpoint 的 JSON/SSE 都经过真实 NodeContainer；
- 生产 binary 不再依赖 direct helper 成功路径；
- plan/hash 漂移启动失败；
- in-flight epoch 安全 drain；
- production path gate 正反全绿；
- 当前 canary 行为 fixture 不回退。

---

# 10. M2：拆解 Runtime，迁移真实 Standard Plugins

## 10.1 模块策略

不要为每个微小插件建立 crate。按稳定业务域拆分：

```text
routecodex-v4-plugin-protocol-openai
routecodex-v4-plugin-protocol-anthropic
routecodex-v4-plugin-protocol-gemini
routecodex-v4-plugin-chat-process
routecodex-v4-plugin-routing
routecodex-v4-plugin-provider
routecodex-v4-plugin-provider-health
routecodex-v4-plugin-tool-governance
routecodex-v4-plugin-servertool-stopless
routecodex-v4-plugin-sse-lifecycle
routecodex-v4-plugin-diagnostics
```

`routecodex-v4-standard-plugins` 只负责：

- 默认标准 bundle；
- descriptor/catalog；
- 默认 plan authoring；
- artifact identity；
-版本兼容声明；
- bundle L2。

## 10.2 第一批 P0 插件

### `V4-PLUGIN-001`
Responses request parse/normalize/input validation。

### `V4-PLUGIN-002`
OpenAI Chat→Responses semantic projection。

### `V4-PLUGIN-003`
request governance 和基础 tool governance。

### `V4-PLUGIN-004`
provider-neutral semantic projection。

### `V4-PLUGIN-005`
Responses wire codec/build。

### `V4-PLUGIN-006`
Responses raw JSON/SSE decode。

### `V4-PLUGIN-007`
response governance/tool harvest/client projection。

### `V4-PLUGIN-008`
frame build、terminal validation、typed fault intake。

## 10.3 Plugin ABI 与供应链

新增或冻结：

```text
plugin_abi_version
contract_schema_hash
descriptor_hash
artifact_hash
capability_set_hash
selection_group
failure_mode
upgrade_compatibility
required_fixtures
```

要求：

- 生产 plugin id 必须有真实 handle；
- keyless/mock handle 不进入 production bundle；
- plugin artifact 和 contract artifact 可独立验证；
- selection group 在执行前由 typed facts exactly-one；
- 插件不能自行选择下一节点；
- 默认每个 NodeContainer 一次 native dispatch。

## 10.4 退出条件

- Runtime 只保留 orchestrator 和 typed context；
- 协议、provider、route、tool 业务不再散落；
- 每个生产插件有唯一 owner/artifact/fixture；
- 未注册 handle、资源越权、effect 越权、依赖 cycle、tie、版本冲突均红；
- Standard bundle 可以从 Manifest 确定性重建。

---

# 11. M3：建立产品级 V3/V4 差分 Harness

## 11.1 目标

从“文档宣称 equivalent”升级为“同输入、同场景、同观察面机器验证”。

## 11.2 产物

```text
v4/crates/routecodex-v4-parity-harness
v4/tests/parity-corpus/
v4/contracts/parity-normalization.contract.json
v4/docs/evidence/feature-completion/parity/
v4/scripts/architecture/verify-v4-product-differential.mjs
```

## 11.3 对比面

- Client JSON；
- SSE event type/order/terminal；
- Provider semantic；
- Provider wire；
- route facts；
- route plan；
- selected provider/model/auth；
- health/action；
- tool identity/schema；
- Error01–06 分类/决策/投影；
- session admission；
- diagnostic/lifecycle 副作用；
- payload copy/serialize/native dispatch 计数。

## 11.4 归一化

允许归一化：

- request ID；
-时间戳；
-随机 nonce；
-真实 Provider usage 的明确不稳定字段；
-无语义影响的对象 key 顺序。

禁止：

- 忽略整个 object/array；
- 忽略所有 unknown fields；
- 把不同 event 顺序排序后比较；
- 丢弃 tool/reasoning；
- 仅比较 HTTP status。

每个差异只允许：

```text
equivalent
intentional_v4_difference
unexplained
```

`unexplained > 0` 阻止状态提升。

## 11.5 第一批 fixture

1. Responses JSON；
2. Responses SSE；
3. Chat JSON relay；
4. Chat SSE relay；
5. Provider 400/401/429/500；
6. malformed SSE；
7. EOF before terminal；
8. EOF after partial client commit；
9. client disconnect；
10. route unavailable；
11. tool call/tool result；
12. session admission overlap。

## 11.6 退出条件

- 每个 `differential_pass` feature 都绑定 fixture/report；
- report 可作为 CI artifact；
- normalization 合同有红测；
- M1 生产路径和旧 V3 入口都可由同一 runner 驱动；
- 不允许 mock-only 结果升级为 live_pass。

---

# 12. M4：生产 Transport、协议和 Provider 完整迁移

## 12.1 生产 Transport

### `V4-TRANSPORT-001`

替换外部 `curl` canary：

- Rust async HTTP/TLS；
-连接池和 keep-alive；
- DNS/TLS/proxy 配置；
- connect/request/first-byte/first-frame/idle deadline；
- cancellation；
- client drop 向上游传播；
- backpressure；
- streaming body；
- body/frame/header size limit；
- retry-after 读取；
-连接复用统计；
- secret redaction；
-失败时受预算 raw evidence；
-健康中性 client drop。

canary `curl` 路径在新 transport 通过后物理删除，不保留 fallback。

## 12.2 协议顺序

### `V4-PROTOCOL-OPENAI-RESPONSES`
OpenAI Responses Direct：JSON/SSE、tools、reasoning、images、usage、errors。

### `V4-PROTOCOL-OPENAI-CHAT`
OpenAI Chat Relay：messages、tools、tool choice、stream chunks、finish reason、usage。

### `V4-PROTOCOL-ANTHROPIC`
Anthropic Messages Relay：content blocks、thinking、tool use/result、stream events。

### `V4-PROTOCOL-GEMINI`
Gemini Relay：contents/parts、function calls/responses、thinking、images、stream events。

### `V4-PROTOCOL-PROVIDER-CHAT`
基线中仍由 Provider-side OpenAI Chat 承载的目标。

### `V4-PROTOCOL-RESPONSES-WS`
只有 baseline supersession 复核确认 V4.0 必需时进入；否则记录 intentional deferral，不能静默丢失。

## 12.3 Provider 配置

完整支持：

- 多 provider；
- 多 model 和 wire name；
- capability profile；
- auth aliases、多 key；
- env/token-file/secret-file handle；
- endpoint；
- transport options；
- protocol adaptor；
- compatibility quirks；
- error mapping policy；
- health/probe policy；
- route group/pool 引用。

## 12.4 退出条件

- 全协议 characterization corpus 差分通过；
- provider id/model name 不参与协议猜测；
- selection group exactly-one；
-无 shell 子进程 transport；
- secret 不进入 Manifest、payload、diagnostic、snapshot、日志；
- transport 断线/取消/限流通过 live fixture。

---

# 13. M5：Router、Target、Provider Health 和 Error Action

## 13.1 Route Facts

唯一 typed owner 输出：

```text
server_id
route_group
entry_protocol
endpoint
client_model
hard_capabilities
soft_route_signals
required_provider_protocol
tool/image/reasoning flags
session/conversation scope
input token estimate
```

硬能力与软信号分离，软信号不能被误作 target capability mismatch。

## 13.2 Route/Pool/Target

实现：

- route group；
- pool match；
-默认 pool；
- priority tier；
-同 tier SWRR；
- per server/route-group/pool/priority 状态；
- deterministic candidate plan；
- opaque target；
- concrete provider/model/auth binding；
- availability 读取；
- route exit decision。

## 13.3 Health

至少支持以下 key scope：

```text
provider
provider + auth_alias
provider + model
provider + auth_alias + model
provider + session
global_subscription
```

状态和动作：

- consecutive failures；
- cooldown；
- quota；
- invalid subscription；
- retry-after；
- probe lease；
- single-flight probe；
- dynamic/exponential backoff；
- success recovery；
- restart reset；
- session isolation；
- model isolation；
- rescue sampling。

## 13.4 Error Action Gate

唯一输出：

```text
retry_same_target
retry_next_auth
reroute_next_candidate
wait_probe
fail_client
```

Router 只能读取 availability，不能写 health；Provider/Error owner 记录成功与失败；Executor 是唯一 action consumer。

## 13.5 退出条件

- 对齐 baseline supersession 后的最新 V3 probe/cooldown 行为；
- priority/SWRR/health/capability 均有确定性差分；
- retry/reroute 不修改原始 normal payload；
- session/model/auth 不互相污染；
-并发 probe/race 测试通过；
-所有 provider/transport/protocol 错误进入 Error01–06。

---

# 14. M6：Session Admission 和 SSE 生命周期

V4 不实现 Responses continuation；`previous_response_id` 保持关闭。

## 14.1 Session Admission

- 同 session overlap 策略；
- admission lease；
- client drop 释放；
- timeout/provider failure 释放；
- terminal 释放；
-不同 conversation 隔离；
-长流不持全局 mutex；
-重复/迟到 release 幂等。

## 14.2 SSE 生命周期

- first-frame timeout；
- heartbeat/keepalive；
- partial frame buffering；
- malformed frame；
- duplicate terminal；
- missing terminal；
- EOF before commit；
- EOF after client partial commit；
- upstream/downstream disconnect；
- write backpressure；
- cancellation propagation；
- post-commit error event；
- client drop health-neutral；
- raw evidence 仅 terminal failure flush。

## 14.3 退出条件

- session admission 全释放路径有测试；
- SSE event 顺序、终态和错误投影等价；
- client drop 不错误处罚 provider；
-无 handler/SSE/outbound 控制补偿。

---

# 15. M7：Tool Governance、Servertool、Stopless 和 Web Search

## 15.1 Tool Governance

覆盖：

- tool schema 保真；
- integer/enum/object 等 JSON Schema；
- tool/function identity；
- duplicate identity；
- empty assistant content；
- parallel tool calls；
- tool choice；
- tool result history；
-跨协议 tool 映射；
- reasoning/thinking 与 tool event 顺序；
- response tool harvest；
- invalid tool policy；
- tool state 与 normal payload/control 分离。

## 15.2 Servertool

从当前投影升级为真实执行中心：

- Tool registry；
- typed input/output schema；
- backend binding；
- timeout/cancellation；
- state machine；
- hook lifecycle；
- request/session/flow scope；
- result projection；
- multi-turn；
- dry-run；
- ErrorChain；
- audit；
- capability isolation。

## 15.3 Stopless

- current-turn typed state；
- terminal/tool_pending；
- MetadataCenter 生命周期；
-唯一允许的当前轮例外；
-禁止进入 provider/client normal payload；
-多轮恢复不依赖 payload 猜测。

## 15.4 Web Search

- backend binding；
- execution mode；
-请求和结果 schema；
-超时/错误；
-状态机；
-多轮；
-无 provider 特例；
-与普通 tool governance 共用中心。

## 15.5 退出条件

- Servertool 不再是 echo/projection；
- OpenAI/Anthropic/Gemini tool fixture 全通过；
- duplicate identity、empty content、schema preservation 回归；
- Servertool 产品语义保持 Rust-only；
- tool/stopless/web-search 多轮差分通过。

---

# 16. M8：Diagnostics、Admin、WebUI、配置迁移与正式发布

## 16.1 Diagnostics

实现并接入生产路径：

- trace context；
- raw capture；
- event ledger；
- snapshot session；
- dry-run fixture/execution；
- timing；
- request/in-flight count；
- payload budget；
- SSE dump；
- error raw wire evidence；
- console human-readable layering；
- retention/authorization/cleanup。

诊断永远只读，不能成为 route/health/error 决策 owner。

## 16.2 Admin API

补齐：

- HTTP/BFF；
- authentication；
- authorization；
- actor/audit；
- idempotency key；
- optimistic concurrency；
- candidate persistence；
- compile/validate/smoke；
- publish；
- drain；
- discard；
- rollback；
- RuntimeInspector 真值；
- secret-safe DTO；
- active epoch/hash 投影。

## 16.3 WebUI

阶段 A，只读：

- Skeleton；
- node/plugin chain；
- active epoch；
- Manifest/hash；
- Provider health；
- route policy；
- request/error/timing；
- candidate 状态。

阶段 B，可变更：

- create candidate；
- plugin config；
- compile/validate/smoke；
- publish；
- rollback。

UI 不拥有排序、权限、业务语义或 active pointer。

## 16.4 配置迁移

- V3 config import；
- semantic diff；
- V4 authoring 生成；
- secret handle 引用迁移，不复制 secret；
- provider/profile 验证；
- dry-run compile；
- manifest preview；
- rollback manifest；
- unknown/unsupported 显式报告。

## 16.5 Release

新增 V4 release pipeline：

- macOS arm64；
- macOS x64；
- Linux x64；
- Linux arm64（若正式支持）；
- reproducible build；
- binary/package/artifact hash；
-签名；
- SBOM；
- GitHub Release；
- install/upgrade/uninstall；
-旧版本 rollback；
- Active artifact/Manifest/ABI compatibility check。

## 16.6 退出条件

- Admin 不影响在途 ExecutionBinding；
-所有变更有 actor/audit；
- rollback 恢复旧 epoch；
- diagnostics/control/secret 无 payload 泄漏；
- V4 有正式、可复现、可安装、可回滚产物；
- WebUI 黑盒投影与 server hash 一致。

---

# 17. M9：性能、Canary、灰度与切换准备

## 17.1 性能指标

V3/V4 同环境测量：

- requests/s；
- p50/p95/p99；
- TTFT；
- SSE frame latency；
-内存；
-每请求 allocation；
- payload copy；
- JSON parse/serialize；
- native dispatch；
-连接池命中；
-长流并发；
-断线回收；
- restart/drain；
- publish/rollback。

## 17.2 架构预算

- 每 NodeContainer 默认一次 native dispatch；
- normal payload 不复制进 control/diagnostic；
- streaming 不整流缓存；
-不持全局 runtime mutex；
- debug/snapshot 有严格预算；
- payload copy/serialize 超预算 gate 红；
-性能退化必须有显式批准和证据。

## 17.3 Canary

1. 独立 identity 和端口；
2. 不启动、停止、覆盖、修改 V3；
3. shadow replay；
4. 比较 route facts、target、provider wire、client output；
5. route-group 灰度；
6.成功、限流、认证、错误、断线矩阵；
7. restart/drain/rollback 演练；
8. 记录 manifest/binary/epoch/artifact hash。

## 17.4 切换条件

- 所有 baseline feature 至少 `differential_pass`；
- live-required feature 为 `live_pass`；
-所有 endpoint 走 NodeContainer；
-无第二 runtime/fallback；
-协议、health、tool、SSE 通过；
-正式发布和 rollback 可用；
-性能预算达标；
- Canary 稳定；
-切换动作必须由 Jason 单独授权，本计划不自动执行。

---

# 18. M10：冻结、收口和 V3 维护/退役准备

## 18.1 工作

- 所有 V4 product crates 完成 freeze/promotion；
- Active index、artifact、contract、source、ABI、scope hash 对齐；
- parity ledger 全量锁定；
-删除 canary-only `curl`、mock production path、stale gates；
-文档只保留一个 active 架构和产品计划；
-生成 V4 operations/runbook；
-生成 V3/V4 并行期维护政策；
-制定 V3 feature freeze 和 retirement checklist。

## 18.2 禁止

- 未授权停止 V3；
- 未授权覆盖 `routecodex/rcc/rccv3`；
-自动迁移用户配置或 secret；
-把未完成 feature 标记 intentional difference；
-为通过收口门禁删除 baseline feature。

## 18.3 退出条件

- 全部 P0/P1/P2 清零；
-无 unexplained diff；
-所有 live-required feature 有 evidence；
-所有 artifact 可复现；
-rollback 演练通过；
-DSH review PASS；
-切换待单独授权。

---

# 19. 64 个 V3 baseline feature 的产品闭环分配

下表给出主责任里程碑。实际执行状态由 `v3-v4-product-parity-ledger.yml` 维护，不以本表手工状态为准。

| V3 feature | 主责任里程碑 | 必须获得的产品证据 | 初始状态 |
| --- | --- | --- | --- |
| `v3.anthropic_relay_local_continuation_integration` | closed-by-decision | V4 不实现 Responses continuation；仅保留 V3 基线覆盖审计 | `closed_by_decision` |
| `v3.anthropic_relay_runtime_integration` | M4 | Anthropic Messages JSON/SSE 全链路与错误投影差分通过 | `mapped`，待产品闭环 |
| `v3.build_test_artifact_budget` | M0/M9 | 构建、测试、artifact 与性能预算进入统一门禁 | `mapped`，待产品闭环 |
| `v3.codex_sample_retention_snap_scope` | M8 | 样本留存授权、snap scope、payload budget 与清理策略 | `mapped`，待产品闭环 |
| `v3.config_interpreter_contract` | M0/M8 | V4 authoring→manifest 真源、V3 import、unknown-field/secret 红测 | `mapped`，待产品闭环 |
| `v3.config_server_full_function` | M4/M8 | 完整 listener/provider/route/transport 配置编译与迁移 | `mapped`，待产品闭环 |
| `v3.console_human_readable_layering` | M8 | 结构化诊断与人类可读 console 分层，禁止成为控制真源 | `mapped`，待产品闭环 |
| `v3.console_request_count_visibility` | M8 | 请求计数、并发/in-flight、终态和错误可观测性 | `mapped`，待产品闭环 |
| `v3.debug_error_foundation` | M5/M8 | Error01–06、debug side-channel、raw evidence 与诊断闭环 | `mapped`，待产品闭环 |
| `v3.direct_runtime_kernel_core` | M1/M2 | 真实 Direct 请求必须经过 Skeleton→NodeContainer→NodePluginPlan | `mapped`，待产品闭环 |
| `v3.direct_stopless_metadata_center` | M7 | Stopless current-turn typed 状态与 MetadataCenter 生命周期 | `mapped`，待产品闭环 |
| `v3.entry_protocol_endpoint_binding` | M4 | endpoint→entry protocol 的编译绑定与错误入口 | `mapped`，待产品闭环 |
| `v3.entry_protocol_registry_contract` | M4 | 协议 registry、selection_group、typed protocol fact | `mapped`，待产品闭环 |
| `v3.error.raw_wire_evidence` | M5/M8 | 仅终态失败写入、预算限制、secret redaction | `mapped`，待产品闭环 |
| `v3.foundation_p0_p2` | M0/M1 | 基础资源/owner/边界收口并绑定生产执行路径 | `mapped`，待产品闭环 |
| `v3.gemini_relay_runtime_integration` | M4 | Gemini JSON/SSE、tool/thinking/image 字段差分 | `mapped`，待产品闭环 |
| `v3.global_binary_install` | M8/M9 | V4 多平台 release、签名、安装、升级、卸载与回滚 | `mapped`，待产品闭环 |
| `v3.history_image_cleanup` | M7 | 多轮 history/image 规范化的唯一 owner 与协议差分 | `mapped`，待产品闭环 |
| `v3.hub_pipeline_static_skeleton` | M1 | 唯一跨节点 orchestrator、相邻边、终态和 error intake | `mapped`，待产品闭环 |
| `v3.hub_relay_gate_review_surface` | M3 | 产品级 parity report、证据和 review surface | `mapped`，待产品闭环 |
| `v3.hub_relay_hook_resource_contract` | M1/M2 | 插件 hook/resource capability 进入真实生产路径 | `mapped`，待产品闭环 |
| `v3.hub_relay_payload_copy_runtime_probes` | M3/M9 | payload copy/serialize/native dispatch 可测量预算 | `mapped`，待产品闭环 |
| `v3.hub_relay_request_semantics` | M2/M4 | Relay 请求 normalize/governance/projection 插件化 | `mapped`，待产品闭环 |
| `v3.hub_relay_response_semantics` | M2/M4 | Relay 响应 decode/governance/projection 插件化 | `mapped`，待产品闭环 |
| `v3.hub_relay_runtime_closeout` | M1/M3 | 真实 runtime 路径关闭直连 helper，端到端差分通过 | `mapped`，待产品闭环 |
| `v3.hub_relay_runtime_resources_hooks` | M1/M2 | 运行时资源与 hook 由 immutable plan 和 capability 驱动 | `mapped`，待产品闭环 |
| `v3.live_provider_compat_parity_closeout` | M3/M4 | 真实 Provider compatibility matrix unexplained_diff=0 | `mapped`，待产品闭环 |
| `v3.managed_server_lifecycle` | M8/M9 | start/status/restart/stop、drain、stale repair、rollback | `mapped`，待产品闭环 |
| `v3.models_capability_catalog` | M4/M5 | 编译能力目录、route-group 可见模型和 /v1/models 投影 | `mapped`，待产品闭环 |
| `v3.module_decomposition` | M1/M2 | runtime-bin 薄化、稳定业务域插件 crate 与唯一 owner | `mapped`，待产品闭环 |
| `v3.openai_chat_relay_runtime_integration` | M2/M4 | OpenAI Chat JSON/SSE Relay 全链差分 | `mapped`，待产品闭环 |
| `v3.protocol_anthropic_codec_characterization` | M3/M4 | Anthropic characterization corpus 与 codec 插件 | `mapped`，待产品闭环 |
| `v3.protocol_conversion_field_parity` | M3/M4 | 跨协议字段保真、明确 intentional difference | `mapped`，待产品闭环 |
| `v3.protocol_gemini_codec_characterization` | M3/M4 | Gemini characterization corpus 与 codec 插件 | `mapped`，待产品闭环 |
| `v3.protocol_normalization_tool_governance_boundary` | M4/M7 | 协议 normalize 与工具治理 owner 分离 | `mapped`，待产品闭环 |
| `v3.protocol_openai_chat_codec_characterization` | M3/M4 | OpenAI Chat characterization corpus 与 codec 插件 | `mapped`，待产品闭环 |
| `v3.protocol_stage_shape_lock` | M0/M4 | 协议 stage 输入输出 shape、未知字段和相邻转换红测 | `mapped`，待产品闭环 |
| `v3.protocol_tables` | M0/M4 | 协议能力/字段/事件表成为 fixture 与插件合同输入 | `mapped`，待产品闭环 |
| `v3.provider_action_gate` | M5 | retry/reroute/fail typed action 的唯一裁决入口 | `mapped`，待产品闭环 |
| `v3.provider_global_subscription_probe` | M5 | 全局订阅错误、single-flight probe、动态 backoff | `mapped`，待产品闭环 |
| `v3.relay_runtime_core` | M1/M2 | Relay 与 Direct 共用 Skeleton，仅由 typed facts 选插件 | `mapped`，待产品闭环 |
| `v3.relay_runtime_shared` | M1/M2 | 共享 execution context、error intake、diagnostic，不建第二 runtime | `mapped`，待产品闭环 |
| `v3.relay_tool_servertool_multiturn_parity_closeout` | M7 | Tool/Servertool 多轮差分 | `mapped`，待产品闭环 |
| `v3.remote_continuation_contract_store` | closed-by-decision | V4 不实现 Responses continuation；仅保留 V3 基线覆盖审计 | `closed_by_decision` |
| `v3.resource_relation_edge_lock` | M0/M1 | 资源 axis、owner、相邻边和禁止边持续机器锁 | `mapped`，待产品闭环 |
| `v3.resp03_tool_governance_gap_closeout` | M7 | 响应侧 tool harvest/governance 唯一真源 | `mapped`，待产品闭环 |
| `v3.responses_direct_mvp_architecture` | M1/M2/M4 | Responses Direct 生产插件路径与真实 transport | `mapped`，待产品闭环 |
| `v3.responses_direct_remote_continuation_integration` | closed-by-decision | V4 不实现 Responses continuation；仅保留 V3 基线覆盖审计 | `closed_by_decision` |
| `v3.responses_inbound_websocket_proxy` | M4/M6 | 若冻结基线确认必需，补齐 inbound WebSocket admission | `mapped`，待产品闭环 |
| `v3.responses_provider_runtime` | M4/M5 | 生产 async transport、provider config/auth/capability/health | `mapped`，待产品闭环 |
| `v3.responses_session_inflight_admission` | M6 | session lease、overlap、drop/timeout/terminal 释放 | `mapped`，待产品闭环 |
| `v3.responses_websocket_v2_transport_hardening` | M4/M6 | WebSocket 生命周期、backpressure、错误与取消 | `mapped`，待产品闭环 |
| `v3.route_classifier_local_owner` | M5 | typed route facts 唯一 owner，禁止 payload patch | `mapped`，待产品闭环 |
| `v3.route_selected_provider_model_binding` | M5 | provider/model/auth/route 绑定不可变且可审计 | `mapped`，待产品闭环 |
| `v3.runtime_timing_observability` | M8/M9 | 节点、插件、transport、TTFT、终态 timing | `mapped`，待产品闭环 |
| `v3.servertool_center_skeleton` | M7 | 真实 Tool registry、typed execution 和 ErrorChain | `mapped`，待产品闭环 |
| `v3.servertool_hook_skeleton_lifecycle` | M7 | Servertool hook、flow/session/request scope 生命周期 | `mapped`，待产品闭环 |
| `v3.sse_http_keepalive_boundary` | M4/M6 | keepalive、first-frame timeout、客户端断开语义 | `mapped`，待产品闭环 |
| `v3.sse_protocol_codec_projection_boundary` | M4/M6 | provider event→semantic→client event 的边界 | `mapped`，待产品闭环 |
| `v3.sse_transport_core_independent` | M4/M6 | streaming transport、partial frame、backpressure、cancel | `mapped`，待产品闭环 |
| `v3.virtual_router_full_function` | M5 | route group/pool/priority/SWRR/availability 完整实现 | `mapped`，待产品闭环 |
| `v3.virtual_router_target_interpreter` | M5 | opaque target→concrete provider/model/auth typed 解释 | `mapped`，待产品闭环 |
| `v3.web_search_servertool_state_machine` | M7 | Web Search backend binding、状态机、超时和多轮 | `mapped`，待产品闭环 |
| `vr.current_turn_typed_route_facts` | M5/M7 | 当前轮 route facts/stopless/tool 状态保持 typed side-channel | `mapped`，待产品闭环 |

---

# 20. 资源域完成矩阵

103 个 V3 resource 不在本文件逐条复制，避免形成第二真源；产品 ledger 必须引用冻结 resource baseline，并按以下域完成：

| 资源域 | 关键资源 | 完成条件 |
| --- | --- | --- |
| Config/Information | authoring、validated、registry、manifest、secret handle | deterministic、unknown reject、secret-safe、runtime 不扫描 |
| Request data | protocol context、normal payload、provider semantic/wire |相邻转换、字段保真、无 control 泄漏 |
| Response data | provider raw、normal semantic、client wire/frame | JSON/SSE 完整、终态严格、无 provider event 泄漏 |
| Route/Target control | route facts、selection plan、opaque/concrete target | priority/SWRR/capability/health 等价 |
| Error/Health control | Error01–06、action、availability、probe/cooldown |唯一 owner、typed action、并发安全 |
| Session admission | scope、admission lease | exact keys、完整释放 |
| Tool/Stopless | tool truth、servertool state、current-turn state |多协议、多轮、Rust owner、payload 隔离 |
| Lifecycle | instance、control socket、operation lock、restart plan | start/status/restart/stop/drain/rollback |
| Diagnostic | trace/raw/event/snapshot/timing/count/budget |只读、受预算、授权留存、secret redaction |
| Build/Artifact | cache、test artifact、Active index、ABI/hash |可复现、签名、promotion/rollback |

---

# 21. Gate 与验证总矩阵

每个任务至少运行其定向测试；每个 milestone 退出必须运行完整矩阵。

## 21.1 定向层

```text
cargo test -p <affected-crate> --manifest-path v4/Cargo.toml --locked
build-link test-consumer <affected-consumer>
node v4/scripts/architecture/<affected-gate>.mjs
node v4/scripts/architecture/<affected-gate>.mjs --red-self-test
```

## 21.2 V4 canonical 层

```text
npm ci --prefix v4 --ignore-scripts
npm --prefix v4 run test
npm --prefix v4 run verify
npm --prefix v4 run verify:red
npm --prefix v4 run verify:ci
```

## 21.3 AppSDK/Active 层

```text
appsdk verify v4
appsdk verify --admission v4
cargo run --manifest-path v4/Cargo.toml -p routecodex-v4-build-link -- gen-index --root v4
cargo run --manifest-path v4/Cargo.toml -p routecodex-v4-build-link -- verify-index --root v4
```

具体参数以仓库当前 canonical script 为准；禁止绕过 `v4/scripts/verify*.mjs` 自造简化成功路径。

## 21.4 产品差分层

```text
V3 fixture -> V3 observed report
same fixture -> V4 production entry -> V4 observed report
normalize by contract
compare all required surfaces
unexplained_diff must equal 0
```

## 21.5 Live 层

涉及 transport/provider/session/SSE/lifecycle 的 milestone 必须增加：

- real provider success；
-认证失败；
- 429/retry-after；
- provider 5xx；
- malformed/partial stream；
- client disconnect；
- timeout/cancellation；
-并发；
- restart/drain；
- V3 zero-call/zero-restart/zero-modify evidence。

## 21.6 Review 层

- 每个 milestone 独立 DSH review；
- reviewer 不得只审文档 map；
-需要检查 production entrypoint 和 fixture evidence；
- P0/P1、ambiguous、fix-then-review 均不算 PASS。

---

# 22. Evidence 目录规范

每个任务提交以下结构：

```text
v4/docs/evidence/feature-completion/<milestone>/<task-id>/
  plan-deviation.md
  red-evidence.json
  positive-evidence.json
  differential-report.json
  live-report.json              # 仅需要时
  performance-report.json       # 仅需要时
  artifact-record.json
  review-record.md
  verification-summary.md
```

规则：

- 不提交 secret、token、完整敏感 payload；
-大样本保存摘要、digest、授权引用；
- evidence 必须记录 commit、binary hash、manifest hash、plan epoch；
-失败证据保留，不覆盖成成功结果；
- intentional difference 必须有 owner、理由和批准。

---

# 23. 第一轮执行任务

第一轮只做 P0，不扩协议矩阵：

1. `V4-PARITY-001` 产品 parity ledger；
2. `V4-PARITY-002` frozen baseline delta/supersession；
3. `V4-RUNTIME-001` immutable ExecutionBinding；
4. `V4-RUNTIME-002` ActiveExecutionEpoch；
5. `V4-RUNTIME-003` Config 输出 NodePluginPlan；
6. `V4-RUNTIME-004` Cordis plan 发布 NodeContainer；
7. `V4-RUNTIME-005` production request path 接入；
8. `V4-RUNTIME-006` production response/error path 接入；
9. `V4-RUNTIME-007` epoch 并发和生命周期；
10. `V4-GATE-001` 禁止 runtime-bin 直连业务 helper；
11. `V4-PLUGIN-001/002` request normalize + Chat→Responses 插件化；
12. `V4-PLUGIN-005/006/007/008` wire/decode/projection/terminal 插件化；
13. `V4-PARITY-HARNESS-001` 第一版 12 类 fixture 差分。

完成这批后，V4 才进入“可持续迁移 V3 产品功能”的状态。

---

# 24. 任务执行模板

每个任务必须按以下顺序：

```text
1. 读取本计划、相关 architecture/contract/map/source；
2. 确认唯一 owner、允许路径、禁止路径和依赖；
3. 创建独立 worktree/branch；
4. 写 plan deviation（无偏差也记录 none）；
5. 先写 red fixture 并证明红；
6. 修改唯一真源；
7. 定向测试转绿；
8. 更新 contract/map/ledger/evidence；
9. 运行 consumer、architecture gate、red suites；
10. 运行 verify:ci、AppSDK admission；
11. 涉及 runtime 时做 install/live/V3 isolation；
12. DSH review；
13. review PASS 后提交；
14. 更新 ledger 状态，不跨级提升；
15. 合并后从干净 main 复验。
```

一个任务可以包含多个小 commit，但最终必须是可审查的单一语义闭环。禁止把多个无关 milestone 打包进一个提交。

---

# 25. 统一 Definition of Done

每个 V3 feature 关闭必须具备：

1. V3 baseline、owner、入口和资源记录；
2. V3 characterization fixture；
3. V4 typed contract；
4.越权、非法输入、非法状态 red fixture；
5. 实现位于真实插件或唯一 typed service；
6. production request 经过 NodeContainer 执行；
7. `unexplained_diff=0`；
8.需要真实 provider 的功能有 live test；
9. copy/serialize/native dispatch 性能证据；
10. artifact 进入 Active epoch；
11. upgrade/drain/rollback 证据；
12. ledger、map、docs、evidence 同步；
13. DSH review PASS；
14. clean-main 复验。

---

# 26. 风险与防偏差

| 风险 | 结果 | 强制规避 |
| --- | --- | --- |
| 在 runtime monolith 继续加功能 | 插件框架与生产 runtime 双 owner | production path gate + helper denylist |
| 把 mapped 当完成 | 形式完整、行为缺失 | 产品状态机 + evidence gate |
| canonical build 直接读 V3 HEAD | 不可重复、隔离失效 | frozen baseline +独立 supersession |
| 过早做动态 WebUI/HMR | 管理非生产真值 | M1/M2 前禁止可变更管理面 |
| 固化同步 server/`curl` | 并发、取消、连接池、流生命周期不足 | M4 生产 transport 后物理删除 canary |
| 通过 fallback 保成功率 | 隐藏语义缺失 | no fallback red gate |
| 使用通用 JSON metadata | control/data 混合 | typed capability + plane isolation |
| 全局 mutex | 所有请求串行、长流阻塞 | request-local context + epoch immutable |
| 差分忽略太多字段 | 假等价 | normalization contract red tests |
| 自动 rollback | 隐藏发布/执行失败 | 显式 candidate/epoch/rollback command |
| 静默改 frozen crate | Active artifact 失真 | AppSDK re-freeze |
| 未授权切换 V3 | 生产风险 | M9/M10 明确人工授权闸 |

---

# 27. 总体完成闸

V4 功能完成只在以下全部成立时宣布：

```text
product_parity.features.completed == baseline.features.total
product_parity.unexplained_diff == 0
production_entrypoints.nodecontainer_coverage == 100%
mock_or_direct_fallback_paths == 0
live_required_features.live_pass == 100%
active_artifacts.reproducible == true
release.rollback_verified == true
performance_budget.pass == true
canary.pass == true
dsh_review.p0 == 0
dsh_review.p1 == 0
```

切换 V3、覆盖默认命令、停止 V3 服务、迁移真实用户配置和 secret 均不属于本计划自动动作，必须由 Jason 单独授权。

---

# 28. `RUNTIME-007` 后的分层批量开发与接线计划

状态：`current_execution_plan`

调度基线：以 manifest 声明的当前 V4 基准 tree 为唯一可复验输入；所有 source lane 直接基于该 tree 创建 candidate。若后续基准变更，必须更新 baseline commit、tree identity 和对应 evidence，不得引用不可达外部 commit 作为完成前置。

## 28.1 目标与验收标准

主目标：从 `V4-RUNTIME-007` 已完成的 epoch 基线继续，一次性完成当前生产执行层的全部独立组件，再由一个 integration owner 做唯一一次主线接线，关闭 `M1 + M2 P0` 的生产 NodeContainer 断点。

验收标准：

1. `V4-RUNTIME-007` 不重复实现；其 gate、48 个 runtime L2 测试和 evidence 在同步后的基线上可重放。
2. `V4-RUNTIME-002` 不另起重复 epoch 实现；先审计 `RUNTIME-007` 是否已覆盖其 ActiveExecutionEpoch、publish、pin、drain、dispose 合同，缺口只回 epoch owner 补齐。
3. 同层独立任务全部达到 `source_green` 后才允许 production wiring；任一任务未完成，integration gate 必红。
4. `V4-RUNTIME-003A/004A`、`V4-PLUGIN-001..008`、request/response typed ports、parity ledger/harness、production-path gate 均能在未接生产 mainline 时独立编译、独立红绿测试、独立产出 evidence；`RUNTIME-003B` exact artifact binding 留到单一 integration owner。
5. 接线只由一个 integration owner 执行：`Config Manifest -> Cordis mount -> ActiveExecutionEpoch -> request -> provider -> response/error terminal`。
6. 接线完成后 `/v1/responses` 与 `/v1/chat/completions` 的 JSON/SSE 均只走 `Skeleton -> NodeContainer -> NodePluginPlan`；`runtime-bin` direct business helper 数量为零、mock/fallback production path 数量为零。合法 Direct 同协议路径保留，唯一 canary transport 留到 Layer 4 替换。
7. 同 fixture 产品差分 `unexplained_diff=0`；epoch publish/drain/restart identity、并发 admission、错误和 client-drop 路径通过。
8. Review 不成为同层开发串行依赖；最终 integration 的 promotion/freeze/交付仍需完整验证后的 DSH PASS。

## 28.2 范围与边界

### In scope

- 云端基线同步与完成状态对账；
- M0 最小产品 ledger、baseline delta 和状态提升 gate；
- `V4-RUNTIME-002` 合同覆盖审计；
- `V4-RUNTIME-003A` Config/Manifest compiler candidate，以及集成期 `V4-RUNTIME-003B` exact artifact binding；
- `V4-RUNTIME-004A` Cordis mount、plan/hash 校验和 Rust publication candidate；
- `V4-PLUGIN-001..008` 全组真实 P0 插件语义；
- `V4-RUNTIME-005A/006A` 未接线 typed request/response/error ports；
- product differential harness 第一版；
- layer barrier 与 production-path 正反 gate；
- 所有独立组件完成后的单次 `RUNTIME-003B/004B/005B/006B` 集成接线；
- V4 build/install/canary/live/differential/review 闭环。

### Out of scope

- Anthropic/Gemini/WebSocket 的完整产品迁移；
- Router/Health/Tool/Admin/WebUI 的后续层接线；
- 修改、安装、重启、停止或替换 V3；
- 修改真实用户配置、provider secret 或默认 `routecodex`/`rccv3` 入口；
- HMR、第三方插件市场、正式生产切流；
- 为 review、环境或 provider 不可用添加 fallback、跳过验证或伪造 PASS。

## 28.3 核心执行原则

### LAYER-01：先完成同层独立开发

每个独立 lane 只拥有自己的 module、contract、tests 和 evidence，不得编辑 production wiring、`runtime-bin` 业务 dispatch、Active pointer 或其他 lane 的 source owner。允许使用 contract fixture 和 typed fake port，禁止用第二业务实现或 production mock success path。

本章中的 `003A/003B`、`004A/004B`、`005A/005B`、`006A/006B` 只是原 feature 内的 source/integration 执行切片标签，不是新 `feature_id`，也不是 pipeline 节点编号；machine registry 仍以 `V4-RUNTIME-003..006` 为唯一功能身份，禁止生成 `03a` 一类拓扑节点。

独立层开放接线的唯一条件：

```text
all(layer.tasks[].implementation_status == source_green)
&& all(layer.tasks[].red_gate == pass)
&& all(layer.tasks[].boundary_audit == pass)
&& all(layer.tasks[].evidence_complete == true)
&& duplicate_semantic_owner_count == 0
```

### LAYER-02：接线只有一个 owner

同层全部完成后，创建一个新的 clean integration worktree。integration owner 只消费已验证 candidate，不在接线阶段重新实现业务语义。冲突返回原 lane 修；禁止在 integration worktree 临时补第二实现。

### LAYER-03：Review 后置但不绕过

- 不对每个独立 lane 启动交付级 DSH review；lane 结束条件是 exact candidate 的 red/green、边界、自测和 evidence 完整。
- 所有同层 lane 可持续推进，不等待 sibling review，也不因 review 服务不可用停止独立开发。
- 只在 batch 接线、build/install/live/differential 全部完成后，进入一个 batch-scoped DSH review loop；每个 unchanged candidate 只 review 一次，修复后必须复验并以新 candidate 重新进入该 loop。
- Review FAIL 只回 finding 的唯一 owner 修复；无关独立 lane 继续。Review unavailable 时记录 `review_pending`，可继续不依赖该候选的独立开发，也可保留已经进入主 tree 的 exact validation change set，但不得 final commit/push/promote/freeze/宣布 batch 完成。
- Review PASS 后若改任何代码、测试、构建或运行配置，旧 PASS 失效，重跑受影响验证和 review。

### LAYER-04：数据、控制和错误继续物理隔离

epoch、manifest、route、health、retry、scope、debug、secret、failure count 和 execution identity 只走 typed carrier/resource/ErrorChain；不得写入或由业务 payload 重建。泄漏在 owner boundary fail-fast，禁止 silent strip、请求侧 cleanup、handler/SSE/outbound/transport 补偿。

## 28.4 基线完成度与剩余任务

| Task | 调度状态 | 下一动作 |
| --- | --- | --- |
| `V4-RUNTIME-001` | `implemented` | 保留 immutable binding 证据；纳入 integration 回归 |
| `V4-RUNTIME-007` | `current_tree_baseline` | 按当前 tree 现状审计；不得假设外部 cloud completion |
| `V4-RUNTIME-002` | `closure_audit` | 证明其合同已被 R007 epoch owner 覆盖；只补确证缺口 |
| `V4-RUNTIME-003` | `remaining_split` | 独立完成 003A compiler candidate；集成时执行 003B exact artifact binding |
| `V4-RUNTIME-004` | `remaining_split` | 先完成 004A mount/publication candidate；集成时执行 004B epoch publish wiring |
| `V4-RUNTIME-005` | `remaining_split` | 先完成 005A request typed port；集成时执行 005B production request wiring |
| `V4-RUNTIME-006` | `remaining_split` | 先完成 006A response/error typed port；集成时执行 006B production terminal wiring |
| `V4-PLUGIN-001..008` | `remaining_product_semantics` | 八项作为一个完整同层集合全部完成；禁止只做部分后接线 |
| `V4-GATE-001` | `remaining` | 先完成 gate 与 red self-test；接线后目标源码从预期红转绿 |
| `V4-PARITY-001..003` | `remaining` | 建 ledger、baseline delta、状态提升 gate |
| `V4-PARITY-HARNESS-001` | `remaining` | 建首批 12 类 fixture runner；接线前可独立完成 runner/contract |

现有 keyless descriptor、mock handle、局部 request/response plugin 和 canary helper 只能作为迁移输入，不能自动计为上述任务完成。必须按唯一 owner、真实产品语义、production handle 和差分 evidence 重新判定。

## 28.5 Layer 0：同步、真值和 owner 冻结

此层先完成，随后所有 Layer 1 lane 可并行/连续独立开发。

1. 锁定当前 V4 基准 tree：核对 commit、tree、现有 contract/gate/evidence 和 L2 测试；后续所有 candidate 必须从该 tree 派生。
2. 在接口冻结前完成 `V4-RUNTIME-002` closure audit：逐项核对 active containers、plan epoch、graph/manifest hash、immutable execution identity、publish、in-flight pin、drain/dispose、passive failure record 和 restart rebuild。当前 tree 缺口由当前 tree 的唯一 owner 登记并实现；禁止引用不可达外部完成事实，也禁止建立重复 epoch owner。
3. 更新产品 ledger：`RUNTIME-007=implemented/live_not_required`；`RUNTIME-002=closure_audit_pass|closure_gap_registered`；不得把 R007 重列为 backlog。
4. 冻结本批 typed interfaces：ExecutionEpochSnapshot、immutable execution identity、NodePluginPlan input/output、request admission port、provider handoff、response/error terminal port；若 R002 有缺口，先把确证缺口纳入同一 epoch contract。同步冻结 P0 plugin ABI、immutable plugin IDs、descriptor/capability schema、selection group/order、contract/artifact identity 规则，使 compiler 与 plugin lanes 可分别 source-green。
5. 建立 machine-readable batch manifest 与 barrier gate：

```text
v4/contracts/feature-completion-layer-batches.manifest.json
v4/scripts/architecture/verify-v4-feature-layer-batches.mjs
v4/scripts/tests/v4-feature-layer-batches-red-fixtures.mjs
```

6. 在 function/module/mainline/verification/resource maps 中登记每个 lane 的唯一 owner、owned/allowed/forbidden paths、相邻边和 required gates。
7. 完成 AppSDK 0.1.5 governance preflight：从 Protected/Active 真源解决 index/dependency lifecycle，不手改 generated/Active/Protected。该问题只阻止 compile/publish/freeze，不阻止 owner 已锁定的独立 source lane。
8. 若多个 lane 仍会修改同一语义文件，先做 owner decomposition；拆成稳定业务域 module 后再开放并行，禁止多个 worker 共同编辑一个 registry/monolith。
9. 按 `.agent-collab/PROTOCOL.md` 为每个 lane 建独立 semantic claim、clean worktree 和 evidence/handoff；shared maps、batch manifest、npm gate matrix 只由 batch registry owner 写入，lane 只提交自身可验证的符号/路径/evidence 变更请求。

Layer 0 退出：R002 closure audit 已完成，基线、接口、owners、batch manifest、gate、AppSDK publish 前置条件均可查；尚无 production wiring。

## 28.6 Layer 1：一次性完成全部独立组件

### Lane A：产品真值与差分框架

- 完成 `V4-PARITY-001/002/003`；
- 完成 differential runner、normalization contract 和首批 12 类 fixtures；
- runner 可分别驱动 V3 frozen observation 与未接线 V4 component entry；接线前不宣称 product diff PASS。

### Lane B：Config/Manifest compiler candidate

- 完成 `V4-RUNTIME-003A`；
- 基于 Layer 0 冻结的 P0 descriptor/ABI contract 与 contract fixtures，输出每个 active node 的 plugin entries、顺序、selection decision、capabilities、plan hash 和 artifact set hash；
- 本 lane 证明 compiler/validator/hash owner 正确；真实 Layer 1 artifact 的 exact identity 绑定属于 `V4-RUNTIME-003B`，只能由 integration owner 完成；
- 无 runtime loader、无 Active pointer write、无 provider/control/payload 语义；
- unknown、tie、cycle、hash drift、secret material 全部 fail-fast。

### Lane C：Cordis mount/publication candidate

- 完成 `V4-RUNTIME-004A`；
- 用 Layer 0 冻结的 Manifest contract fixture 独立驱动真实 Cordis Context/Fiber/Effect mount；Layer 1 barrier 再验证其与 `RUNTIME-003A` exact compiler candidate 的合同兼容，不建立跨 lane source dependency；
- Cordis graph、Manifest、loaded plan hash 全等；
- Rust NodeContainer declaration/publication candidate 独立黑盒通过；
- 此阶段不修改 ActiveEpochStore，不接 production handler。

### Lane D：全部 request-side P0 plugins

- 一次性完成 `V4-PLUGIN-001/002/003/004/005`；
- Responses parse/normalize、Chat→Responses、request/tool governance、provider-neutral semantic projection、Responses request wire codec/build 各有唯一 owner；`PLUGIN-005` 固定属于 `RequestOutboundNode`，不得进入 response chain；
- 真实语义进入稳定 domain module；`routecodex-v4-standard-plugins` 只保留 catalog/bundle/descriptor owner，不复制业务实现；
- 每项具备白盒、NodeContainer 黑盒、非法 shape/资源越权/控制泄漏红测。

### Lane E：全部 response-side P0 plugins

- 一次性完成 `V4-PLUGIN-006/007/008`；
- raw JSON/SSE decode、response governance/tool harvest/client projection、frame/terminal/typed fault intake 全部独立闭环；
- JSON/SSE 共享相邻语义 owner，SSE 只负责 framing/lifecycle；
- provider error、malformed frame、duplicate/missing terminal、partial commit 均进入 typed path，不补偿成成功；`PLUGIN-008` 只拥有 typed fault intake，不拥有 Error Skeleton 的 classify/policy/decision。

### Lane F：未接线 request/response/error ports

- 完成 `V4-RUNTIME-005A` 与 `V4-RUNTIME-006A`；
- request port 一次获取 epoch lease 和 immutable ExecutionBinding；
- response/error port 必须消费同一 binding/lease，不能重新读取 active epoch；
- ports 用 contract fixtures 独立测试，不注册进 production listener/runtime-bin。

### Lane G：门禁

- 完成 `V4-GATE-001` 与 `V4-LAYER-GATE-001` 正向/红测；
- `V4-GATE-001` 在未接线源码上允许报告“target still red”，但 gate 自身 mutation self-test 必须全绿；
- layer gate 必须拒绝“一个插件完成就提前接线”、缺 evidence、重复 owner、跨 lane import 和 review 状态被误作 source completion 条件。

### Lane H（条件启用）：Epoch closure

- 仅当 Layer 0 的 `V4-RUNTIME-002` closure audit 找到确证缺口时启用；只由 R007 的同一 epoch owner 补齐 exact contract/test/gate/evidence，不得另建 ActiveEpochStore 或重复 lifecycle owner；
- audit 已证明完整覆盖时，不写代码，machine status 固定为 `not_needed_by_evidence`；
- barrier 要求 `runtime_002.closure_audit=pass` 且 `epoch_closure_lane in {source_green, not_needed_by_evidence}`。

Layer 1 退出：A–G 全部 `source_green`，且 conditional H 为 `source_green` 或 `not_needed_by_evidence`。任何必需 lane 未绿，禁止进入 Layer 2；review 状态不参与 `source_green` 判定。

## 28.7 Layer 2：单一 integration owner 接线

严格顺序：

```text
RUNTIME-003B exact manifest/artifact binding
  -> RUNTIME-004B Cordis mount + epoch candidate validation/publish
  -> RUNTIME-005B request admission obtains one epoch lease/binding
  -> request plugins 001..003
  -> existing Execution/Target NodeContainers
  -> request-outbound plugins 004..005
  -> existing provider transport
  -> success response plugins 006..008
  -> RUNTIME-006B success terminal

orthogonal exits from any admission/request/execution/target/transport/response stage:
  source failure at owning boundary
    -> Error Skeleton SourceRaised -> HostCaptured -> RuntimeClassified
    -> RouterPolicyApplied -> ExecutionDecision -> ClientProjected
    -> RUNTIME-006B error terminal

client disconnect/cancel at admission/transport/SSE emission
  -> registered lifecycle/client-drop path
  -> RUNTIME-006B client-drop terminal

PLUGIN-008 owns typed fault intake only at its response/frame boundary;
it never classifies or decides failures from other stages.

each legal terminal after lease acquisition -> release the same epoch lease exactly once
pre-admission client drop -> no epoch lease exists and no release is synthesized
```

接线动作：

1. 从 Layer 1 全部 exact candidates 构建一个 integration candidate，并由 `RUNTIME-003B` 把真实 plugin artifact identities 绑定进 exact Manifest；不从聊天摘要或未验证 worktree 复制代码。
2. `runtime-bin` 只装载 Manifest/epoch、监听和 typed dispatch；业务 helper 移出 binary owner。
3. `/v1/responses`、`/v1/chat/completions` JSON/SSE 四条 production entry 全部切到同一 NodeContainer 主线。
4. request/response/error 共享同一 ExecutionBinding；跨阶段 identity/hash 漂移 fail-fast。
5. `runtime-bin` 旧 direct business helper、mock/fallback production path 和重复 plugin implementation 经依赖证明后物理删除；不得误删合法 Direct 同协议路径，也不在本批提前删除 Layer 4 才替换的唯一 canary transport。
6. `V4-GATE-001` 从 target-red 转绿；layer gate 仅在 A–G 全绿且 conditional H 为 `source_green` 或 `not_needed_by_evidence` 后记录 wiring opened。
7. 对 actual integration diff 做 module/resource/edge 越界自检，先于功能验证。

## 28.8 Layer 3：验证、review、合并

验证顺序：

1. 定向 crate/L2/compile-fail/NodeContainer blackbox；
2. 所有新增 architecture gates 与 red fixtures；
3. R007 epoch concurrency/lifecycle gate 与 48-test baseline；
4. `npm --prefix v4 run test`、`verify`、`verify:red`、`verify:ci`；
5. `appsdk verify v4`、admission、Active gen/verify index；
6. build + 只安装 `rccv4` canary；不触达 V3；
7. `/health`、`/v1/models`、Responses/Chat JSON/SSE；
8. publish 时 in-flight pin、candidate reject、drain/dispose、restart identity、execution failure 不切 active；
9. provider success/4xx/429/5xx、malformed SSE、EOF、client disconnect、timeout/cancel；
10. 12 类 differential fixtures，要求 `unexplained_diff=0`；
11. clean integration worktree 全绿后写 handoff/merge-queue，把 exact change set 精确合入主 tree；
12. 在主 tree 重跑受影响验证、build、只安装 `rccv4`、在线真实样本和 differential；
13. 对该 unchanged main-tree candidate 进入 batch-scoped DSH review loop；FAIL 修复后先重跑受影响的主树验证，再以新 unchanged candidate 复审；
14. PASS 后定向 commit/push，并证明待推送 commit、本地 HEAD、已验证 candidate 三者一致；最后做 clean-main 复验。

Rustfmt 旧债不能用来批量改写无关大文件，也不能被忽略为永久缺口：本批只要求 changed hunks 符合格式、`git diff --check` 通过，并单独记录 repository-wide canonicalization debt；不得把数百行无关 formatter diff 混入语义批次。

## 28.9 后续剩余层次

每层重复“全部独立完成 -> 单一接线 -> 全量验证/review”，禁止逐 feature 边写边接：

| 后续层 | 独立开发集合 | 接线闸 |
| --- | --- | --- |
| Layer 4：Protocol/Provider | Rust async transport；沿用本批唯一 codec owners 增加 Anthropic/Gemini/必要 WS 变体；补齐 provider config/auth/capability，不重做 Responses/Chat 已完成语义 | 全部新增协议/transport 组件 source-green 后一次接 provider/server mainline；删除 `curl` canary |
| Layer 5：Routing/Control | route facts、pool/priority/SWRR、target、health/probe、Error action、session admission、SSE lifecycle | 全部 typed state machines source-green 后接 executor；Router 只读 availability |
| Layer 6：Tool Runtime | 沿用 `PLUGIN-003/007` 唯一 tool-governance owners，增加 servertool、stopless、web search backend/registry/state machine，不复制本批 request/response governance | 全部新增 registry/state machine/backend contracts source-green 后接 Chat Process；多轮差分收口 |
| Layer 7：Management/Release | diagnostics、admin、WebUI read/write phases、config migration、managed lifecycle、release | 只读面先完整，变更面全部独立验证后一次接 publish/rollback；UI 永不成为真源 |
| Layer 8：Production Closeout | performance budget、canary、rollback、artifact freeze、runbook | 全 feature differential/live pass 后 freeze；切换 V3 仍需 Jason 独立授权 |

M3 parity harness 是所有层的横向验证基础，不作为最后补测阶段；每层新增 feature 时同步扩 fixture/report，但只有接线后的 production entry 结果可提升为 `differential_pass`/`live_pass`。

## 28.10 文件清单

现有真源：

```text
v4/docs/goals/v4-feature-completion-plan.md
v4/docs/goals/v4-feature-completion-goal-prompt.md
v4/docs/architecture/v4-cordis-node-plugin-architecture.md
v4/docs/architecture/v4-standard-nodes-and-node-graph.md
v4/docs/architecture/v4-data-control-plane-boundary.md
v4/docs/architecture/v4-resource-operation-map.yml
v4/docs/architecture/maps/{resource-map,function-map,mainline-call-map,module-registry,verification-map}.json
v4/crates/routecodex-v4-{config,cordis-bridge,node-container,runtime,standard-plugins,runtime-bin,server,provider,router}/**
v4/cordis/routecodex-v4-cordis-host/**
```

计划新增/扩展：

```text
v4/contracts/feature-completion-layer-batches.manifest.json
v4/contracts/v3-product-parity-ledger.schema.json
v4/docs/architecture/v3-v4-product-parity-ledger.yml
v4/scripts/architecture/verify-v4-feature-layer-batches.mjs
v4/scripts/tests/v4-feature-layer-batches-red-fixtures.mjs
v4/scripts/architecture/verify-v4-product-parity-ledger.mjs
v4/scripts/architecture/verify-v4-product-parity-status.mjs
v4/crates/routecodex-v4-parity-harness/**
v4/tests/parity-corpus/**
v4/docs/evidence/feature-completion/M1/**
```

具体 plugin domain crate 在 Layer 0 owner decomposition 中登记；名称沿第 10.1 节稳定业务域，不为每个微插件建 crate，也不把真实业务长期留在 `runtime-bin` 或 catalog bundle。

## 28.11 风险与规避

| 风险 | 规避 |
| --- | --- |
| 外部 epoch commit 不可达 | current-tree baseline identity gate；直接审计并实现当前 tree 的唯一 owner |
| 现有文档状态互相冲突 | 产品 ledger + newer snapshot；源码/contract/evidence 决定状态，不靠标题 |
| 多 lane 共同改 monolith/registry | Layer 0 先拆 owner；每 lane 独占语义和 worktree |
| keyless/mock 被当真实插件 | production handle + entrypoint + differential evidence 才能提升状态 |
| 一个插件完成就提前接线 | machine layer barrier；A–G 与 conditional H 未满足时 wiring 必红 |
| review unavailable 停止全部开发 | review 后置；只阻止 final commit/push/promotion/freeze，不阻止无依赖独立 lane 或 exact candidate 的主树验证 |
| review finding 迫使集成层补丁 | finding 回唯一 owner；integration 不新增业务修补 |
| AppSDK index/dependency drift | Protected/Active 真源恢复；禁止手改 immutable/generated |
| runtime-bin 再长业务 | production path deny gate + direct helper physical removal |
| control/error/debug 泄漏 payload | typed carrier + paired positive/negative leak tests |
| formatter 产生巨大无关 diff | 只格式化/修正本批 changed hunks；旧债单独任务 |

## 28.12 Definition of Done

当前 batch 只有全部成立才完成：

```text
baseline.commit_is_declared_current_v4_tree == true
runtime_007.replayed == pass
runtime_002.closure_audit == pass
epoch_closure_lane.status in {source_green, not_needed_by_evidence}
layer1.independent_tasks.source_green == 100%
layer1.duplicate_semantic_owners == 0
layer2.wiring_started_after_layer1_complete == true
runtime_003.exact_artifact_binding == pass
production_entrypoints.nodecontainer_coverage == 100%
runtime_bin.direct_business_helper_paths == 0
mock_or_fallback_production_paths == 0
execution_binding.request_response_error_identity_drift == 0
error_skeleton.all_stage_source_coverage == pass
acquired_epoch_lease.release_exactly_once == pass
epoch.concurrent_publish_drain_restart == pass
product_differential.unexplained_diff == 0
v4.verify_ci == pass
appsdk.admission == pass
rccv4.live_matrix == pass
v3.calls_restarts_modifications == 0
dsh_review == PASS
clean_main_replay == pass
```

Review 未完成时状态只能是 `integration_verified_review_pending`，不是失败，也不是完成；继续推进不依赖该 integration contract 的独立候选，但不得发布、冻结或宣称本批闭环。

## 28.13 当前收敛状态

状态：`alignment_required`

2026-08-23 本地存在两条必须按序收敛的 V4 治理候选：

1. Product-map cutover 候选先把 resource/function/mainline-call/module-registry/verification 产品真源放入 `v4/docs/architecture/maps/`，并保留 `.appsdk/maps/` 作为 AppSDK skeleton。该候选已通过 foundation、isolation 和 contract admission；合并前还必须刷新已过期 lifecycle evidence，并在最终提交上重绑 governance candidate identity。
2. Feature-layer batch gate 候选必须基于 Product-map cutover 重放。禁止把 `V4-LAYER-GATE-001` 的 owner/resource/gate 绑定写回 `.appsdk/maps/` skeleton；对应绑定只能进入产品 maps。其 definition/admission/build-guard 在 `guard_commit` 与 guarded surface scope hashes 绑定前都必须保持红。
3. `V4-RUNTIME-007` 不再绑定不可达外部 commit；调度锚点是 manifest 声明的当前 V4 baseline tree，所有实现和证据必须从该 tree 派生。

只有 Product-map cutover 合入主 tree、active 与 lifecycle evidence 全部同步、并修复 governance 收窄与 plugin-contract pre-review head 后，batch gate 候选才允许重新绑定 `guard_commit` / guarded surface scope hashes 并打开接线闸。
