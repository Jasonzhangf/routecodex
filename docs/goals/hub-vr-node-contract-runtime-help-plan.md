# Hub / VR Node Contract Runtime Help Plan

## 1. 目标与验收标准

### 目标

把 Hub Pipeline 与 Virtual Router 的节点流程标准化为“数据链 + 控制链 + 在线契约说明”三件套：

1. 请求/响应数据只走主链节点，不承载内部控制 metadata。
2. metadata 只走 `Meta*` carrier，不混入 provider body、SDK options、client response body。
3. 每个 runtime 节点都有在线 help / contract 入口，说明当前版本接口、职责、功能、允许读取/写入的 data/meta 字段、禁止项与验证方式。
4. 后续 agent 修改节点前必须先读 runtime help，再按 contract 修改和验证，形成标准 skill-like 流程。

### 验收标准

- `docs/design/pipeline-type-topology-and-module-boundaries.md` 中已有 `MetaReq01EntryCaptured -> MetaReq02RuntimeCarrier -> MetaRoute03RouteCarrier -> MetaResp04SameRequestCarrier -> MetaDone05Released` 被落实到 runtime contract。
- Hub / VR 关键节点至少有 machine-readable contract：`dataIn`、`dataOut`、`metaRead`、`metaWrite`、`effects`、`forbiddenPaths`、`ownerBuilder`、`version`。
- 提供 runtime help 入口，可查询所有节点 contract，也可按节点查询单个 contract。
- 节点执行前后有只读 validation 或 fail-fast guard，能发现 metadata/data 污染。
- provider 出站 body / SDK options / client response body 不出现内部 metadata。
- 不新增主链中间编号，不重排既有节点，不把 provider-specific 逻辑写入 Hub/VR。

## 2. 范围与边界

### In Scope

- Hub Pipeline request-side 节点 contract：
  - `HubReqInbound02Standardized`
  - `HubReqChatProcess03Governed`
  - `HubReqOutbound05ProviderSemantic`
- Virtual Router 节点 contract：
  - `VrRoute04SelectedTarget`
  - 后续可扩展 `VrRoute01Features` / `VrRoute02ClassifiedIntent` / `VrRoute03CandidatePool` / `VrRoute05DecisionRecord`
- Metadata carrier contract：
  - `MetaReq01EntryCaptured`
  - `MetaReq02RuntimeCarrier`
  - `MetaRoute03RouteCarrier`
  - `MetaResp04SameRequestCarrier`
  - `MetaDone05Released`
- runtime help / contract registry：Rust 真源优先，TS 只做薄壳展示或 HTTP/debug bridge。
- 红测：禁止 metadata 进入 provider body / SDK options / client response；禁止节点跨位读写；禁止 provider 特例进入 Hub/VR。

### Out of Scope

- 不改变 provider selection / quota / health / retry 语义。
- 不修改 provider wire payload 真实业务字段。
- 不把 contract help 做成 fallback sanitizer；发现污染必须显式报错。
- 不新增 `03a`、`03_1`、`03.5` 等中间节点。
- 不大规模重命名现有文件；先 registry / wrapper / validation，再物理清理旧散读路径。

## 3. 当前代码证据与缺口

### 已有设计基础

- Metadata 拓扑已写入 `docs/design/pipeline-type-topology-and-module-boundaries.md`。
- 文档明确 metadata 是内部控制语义 carrier，不是正常请求/响应 payload。
- 文档明确新增控制语义应进入 `Meta*` carrier，不新增 req/resp 主链编号。

### 当前缺口

1. **metadata 仍是泛型 bag**
   - Server handlers 把 request body metadata 与 runtime metadata merge 后传入 pipeline。
   - 风险：后续节点可随意读写 `Record<String, Value>`，缺少字段级 contract。

2. **VR 直接读 metadata Value**
   - `virtual_router_engine/instructions/state.rs` 直接从 `metadata` 读 `allowedProviders`、`__shadowCompareForcedProviderKey`、`disabledProviderKeyAliases`。
   - 风险：routing control 没有经过 `MetaRoute03RouteCarrier` builder，位置不锁。

3. **runtime metadata helper 直接 mutate 泛型对象**
   - `runtime_metadata.rs` 以 `Value` 输入输出，写入 `hasImageAttachment`、`sessionId`、`conversationId` 等。
   - 风险：meta 写入缺少节点权限声明。

4. **node observation 与 metadata 混放**
   - `nodes.rs` 把 `dataProcessed` 放入 node result 的 `metadata`。
   - 风险：观测数据与控制 metadata 容易混淆；应进入 `Snapshot*` / `NodeObservation`。

5. **在线 contract 入口缺失**
   - 目前开发者只能读文档/源码；runtime 无法说明“当前二进制实际支持的接口版本”。
   - 风险：文档和运行时代码漂移，agent 修改时仍可能按过期认知改串位置。

## 4. 总体设计

### 4.1 三条链分离

```text
Data chain:
ServerReqInbound01ClientRaw
  -> HubReqInbound02Standardized
  -> HubReqChatProcess03Governed
  -> VrRoute04SelectedTarget
  -> HubReqOutbound05ProviderSemantic
  -> ProviderReqOutbound06WirePayload

Meta chain:
MetaReq01EntryCaptured
  -> MetaReq02RuntimeCarrier
  -> MetaRoute03RouteCarrier
  -> MetaResp04SameRequestCarrier
  -> MetaDone05Released

Observation chain:
SnapshotObs01NodeStarted
  -> SnapshotObs02NodeCompleted
  -> SnapshotObs03DebugCaptured
```

规则：

- `Data chain` 只承载用户请求/响应语义。
- `Meta chain` 只承载当前闭环控制语义。
- `Observation chain` 只承载日志、计时、dataProcessed、snapshot/debug。
- 三条链只能通过显式 contract 交互，不允许任意 `metadata` object merge。

### 4.2 NodeContract schema

建议 Rust 真源定义：

```rust
pub struct NodeContract {
    pub node_id: &'static str,
    pub version: &'static str,
    pub phase: &'static str,
    pub owner_builder: &'static str,
    pub data_in: ContractShape,
    pub data_out: ContractShape,
    pub meta_read: &'static [&'static str],
    pub meta_write: &'static [&'static str],
    pub effects: &'static [&'static str],
    pub forbidden_paths: &'static [&'static str],
    pub help: &'static str,
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `node_id` | 全局唯一节点名，如 `HubReqChatProcess03Governed` |
| `version` | 当前 contract 版本，不代表节点编号 |
| `phase` | `req_inbound` / `req_chatprocess` / `vr_route` 等 |
| `owner_builder` | 唯一 owning builder/parser 函数或模块 |
| `data_in` | 允许的数据入口 shape |
| `data_out` | 允许的数据出口 shape |
| `meta_read` | 节点允许读取的 meta 字段白名单 |
| `meta_write` | 节点允许写入的 meta 字段白名单 |
| `effects` | 允许产生的 side effects，如 route decision / effect plan |
| `forbidden_paths` | 运行时和红测禁止路径 |
| `help` | 人类可读职责说明 |

### 4.3 MetaCarrier schema

建议 Rust 真源定义：

```rust
pub struct MetaCarrierContract {
    pub carrier_id: &'static str,
    pub version: &'static str,
    pub scope_fields: &'static [&'static str],
    pub allowed_fields: &'static [&'static str],
    pub forbidden_destinations: &'static [&'static str],
    pub release_rule: &'static str,
}
```

必须字段：

- `requestId`
- `pipelineId`
- `entryEndpoint`
- `providerProtocol`
- `port/serverId`
- `session/conversation scope`（存在时）

禁止目的地：

- provider HTTP body
- provider SDK options
- direct passthrough body
- client response body
- provider persistent state
- cross-request singleton/cache

### 4.4 Runtime help 入口

至少提供两个层级：

1. **Rust / NAPI 真源函数**
   - `describe_hub_pipeline_contracts()`：返回所有 Hub contracts。
   - `describe_virtual_router_contracts()`：返回所有 VR contracts。
   - `describe_pipeline_contract(node_id)`：返回单个节点 contract。
   - `validate_node_contract_boundary(node_id, before, after)`：执行边界校验。

2. **TS debug/help bridge**
   - CLI/debug script 或 HTTP debug endpoint 调用 NAPI。
   - 输出当前在线版本，不从 markdown 拼接。

推荐输出：

```json
{
  "contractVersion": "2026-06-03.meta-carrier.v1",
  "nodeId": "HubReqChatProcess03Governed",
  "ownerBuilder": "run_hub_req_chatprocess_03_governed_entrypoint",
  "dataIn": { "type": "HubReqInbound02Standardized" },
  "dataOut": { "type": "HubReqChatProcess03Governed" },
  "metaRead": ["routeHint", "serverToolRequired", "hasImageAttachment"],
  "metaWrite": ["serverToolRuntimeAction", "estimatedInputTokens"],
  "forbiddenPaths": ["provider.body.metadata", "client.body.metadata"],
  "help": "Request-side tool governance only; no routing/provider wire build."
}
```

### 4.5 Agent 修改流程

后续每次改 Hub/VR 节点必须执行：

1. 查询 runtime help：确认当前 node contract。
2. 定位 owning builder/parser：只改唯一入口。
3. 判断语义类型：data / meta / error / observation。
4. data 改 data node；control 改 Meta carrier；error 改 Error chain；debug 改 Snapshot/Observation。
5. 修改 contract 或实现时，必须同步红测。
6. 验证 provider body / SDK options / client response 无 metadata 泄漏。

## 5. 阶段实施计划

### Phase A：Contract Registry 只读落地

目标：先让 runtime 能说明自己，不改变 live 行为。

任务：

1. 在 Rust hotpath 新增 contract registry 模块。
2. 为 request-side Hub / VR 最小关键节点注册 `NodeContract`。
3. 新增 NAPI describe 函数。
4. TS 薄壳暴露 debug/help 查询入口。
5. 增加 snapshot test，确保 help 输出稳定。

验收：

- 可以查询所有节点 contract。
- 可以查询单个节点 contract。
- 不改变任何 provider wire / client response 行为。

### Phase B：MetaCarrier contract 落地

目标：把 metadata 字段从泛型 bag 升级为有阶段、有权限的 carrier contract。

任务：

1. 定义 `MetaReq01EntryCaptured` / `MetaReq02RuntimeCarrier` / `MetaRoute03RouteCarrier` / `MetaResp04SameRequestCarrier` / `MetaDone05Released` contract。
2. 建立 `build_meta_req_02_from_meta_req_01` 等相邻 builder 命名。
3. 将 VR routing controls 的读取入口收敛到 `MetaRoute03RouteCarrier` builder。
4. 保留旧 metadata bag 的读取桥接，但只允许 wrapper 内部读取；节点体不得散读。
5. 为每个 meta field 标注 owner：谁写、谁读、何时释放。

验收：

- VR 节点不直接消费泛型 metadata bag。
- routing control 字段只通过 `MetaRoute03RouteCarrier` 进入 VR。
- red test 能发现新增散读 `metadata.get("allowedProviders")` 之类路径。

### Phase C：Node boundary validation

目标：让 contract 不只是说明，而能在运行时或测试中拦截串位。

任务：

1. 增加 node pre/post validation：校验 data shape、meta read/write 权限、forbidden paths。
2. 初期在测试和 debug mode 中启用只读校验。
3. 对 provider outbound boundary 加 fail-fast guard：top-level internal metadata 禁止进入 body/options。
4. 对 client response projection 加 guard：internal metadata 禁止进入 client body。
5. 对 direct passthrough 加 guard：internal metadata 禁止进入 upstream direct body。

验收：

- contract violation 测试红灯。
- 合法现有请求绿灯。
- 发现污染时 fail-fast，不做静默删除/fallback。

### Phase D：Observation 与 metadata 分离

目标：把 node 计时、dataProcessed、debug/snapshot 从 metadata 中搬出。

任务：

1. 定义 `NodeObservation` / `SnapshotObs*` contract。
2. 调整 `nodes.rs` 的 node result shape：控制 metadata 与观测字段分离。
3. 保留兼容输出需明确为 debug-only，不允许回流到 runtime meta carrier。
4. 红测禁止 `dataProcessed` 作为控制 metadata 被节点读取。

验收：

- node timing / dataProcessed 走 observation。
- metadata carrier 只剩控制语义。
- snapshot/debug 不影响 provider/client normal payload。

### Phase E：Typed entrypoint 结合 contract

目标：把 contract 与已有 typed entrypoint migration 合并，形成唯一节点入口。

任务：

1. typed wrapper 调用 contract validation。
2. old direct stage import 加红测禁止。
3. live path 分 slice 切到 typed wrapper。
4. 确认不再被调用的旧散读 helper，列删除清单。
5. 经测试证明后物理删除死路径。

验收：

- 关键 live path 经过 typed wrapper + contract validation。
- 旧直连 import 红测锁住。
- 旧泛型 metadata 散读路径减少且可追踪删除。

### Phase F：Agent skill / docs 固化

目标：把 runtime help 变成后续修改标准流程。

任务：

1. 更新 `.agents/skills/rcc-dev-skills/SKILL.md`：加入“修改 Hub/VR 前先查 runtime contract help”。
2. 更新 topology 文档：记录 contract registry、help 入口、validation gate。
3. 增加 `/goal` 模板：所有 Hub/VR contract 改动必须引用本计划。
4. 将已验证经验提炼到 `MEMORY.md`。

验收：

- 后续 agent 能按 skill 流程先查 help、再改唯一 owner、再验证。
- 文档、runtime help、测试三者互相校验。

## 6. 文件清单

### 预计新增

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/mod.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/node_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/meta_carrier_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/registry.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/validation.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/contracts.rs`
- `src/server/runtime/http-server/debug/pipeline-contract-help.ts`（路径可按现有 debug 结构调整）
- `tests/red-tests/hub_vr_node_contract_boundary.test.ts`

### 预计修改

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/runtime_metadata.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/nodes.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/state.rs`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`

## 7. 风险与规避

| 风险 | 规避 |
|---|---|
| contract registry 变成文档副本 | runtime help 从 Rust registry 输出，不从 markdown 拼接 |
| validation 误伤 live path | Phase A/B 只读；Phase C 先测试/debug mode，再 fail-fast |
| metadata 旧 bag 无法一次删除 | wrapper 桥接，节点体禁止散读，逐步收敛 owner |
| provider/client 行为漂移 | 每 phase 跑 provider wire / client response focused tests |
| 插节点导致编号混乱 | 坚持 carrier/block 优先，不新增主链中间编号 |
| help endpoint 泄漏敏感数据 | 只输出 contract/schema，不输出 runtime secret/request content |

## 8. 验证矩阵

| 阶段 | 验证 |
|---|---|
| Phase A | Rust unit: contract registry serialization；TS help bridge smoke |
| Phase B | Rust unit: MetaCarrier builder；red test: VR 禁止直接散读 metadata controls |
| Phase C | red test: provider body / SDK options / client response 禁止 internal metadata |
| Phase D | Rust unit: NodeObservation shape；red test: dataProcessed 不在 control metadata |
| Phase E | topology red test: 禁止旧 direct import / 跨节点 shortcut |
| Phase F | skill/doc check: runtime help 流程写入 rcc-dev-skills |

基础验证命令按实际改动选择：

- `cargo test -p router-hotpath-napi <contract_related_test>`
- `pnpm test <red-test-or-focused-jest>`
- `pnpm build` 或项目现有 typecheck/build 命令
- provider wire snapshot / focused blackbox where touched

## 9. 完成定义

- runtime 可查询 Hub/VR 节点在线 contract。
- Meta carrier 字段读写有 owner、有阶段、有禁止出口。
- 节点数据链与 metadata 控制链机械隔离，不靠口头约定。
- contract violation 有红测或 fail-fast guard。
- 后续 agent 修改 Hub/VR 时，可按 runtime help + owner builder + validation 的标准流程执行。

## 10. 后续 `/goal` 拆分建议

1. `/goal` Phase A：只读 Contract Registry + runtime help。
2. `/goal` Phase B：MetaCarrier contract + VR control read 收敛。
3. `/goal` Phase C：boundary validation + metadata leak fail-fast guard。
4. `/goal` Phase D：NodeObservation 与 metadata 分离。
5. `/goal` Phase E/F：typed entrypoint 结合 contract + skill 固化。

## 11. 可直接执行的 `/goal` 提示词

```text
/goal
目标：把 Hub Pipeline 与 Virtual Router 的节点流程标准化为数据链、Meta 控制链、Observation 链和在线 runtime contract help，确保数据与控制分离且节点修改不会串位置。

实现文档：
docs/goals/hub-vr-node-contract-runtime-help-plan.md

执行规范：
- Rust runtime 是 contract 真源；TS 只做薄壳 bridge，不新增 Hub/VR TS 语义。
- 不新增或重排主链节点编号；新增控制语义进入 Meta* carrier，debug/观测进入 Observation/Snapshot carrier。
- 每个节点只允许相邻 builder/parser 转换；禁止跨节点 shortcut、散落 From/DTO、泛型 metadata bag 直读。
- provider body、provider SDK options、direct passthrough body、client response body 禁止携带内部 metadata；发现必须 fail-fast，不做 sanitizer/fallback。
- Hub Pipeline / Virtual Router 不写 provider-specific 特例，不改变 provider selection/quota/health/retry 语义。

验证：
- Rust targeted tests：contract registry、MetaCarrier builder、NodeObservation/boundary validation。
- Jest/red tests：metadata 出口泄漏、VR 散读 metadata controls、跨节点 shortcut、旧 direct import。
- Build/typecheck：只跑与改动相关的最小闭环；若全量 build 被既有无关问题阻塞，记录具体文件/行号证据。
- Diff gate：`git diff --check`，并审计 provider wire/client response 无内部 metadata。

完成标准：
- runtime help 可查询 Hub/VR 全部关键节点 contract 与单节点 contract。
- MetaReq01 -> MetaReq02 -> MetaRoute03 -> MetaResp04 -> MetaDone05 的读写权限和释放规则有 runtime contract 与红测锁定。
- 节点 data/meta/observation/error 机械隔离，违规路径 fail-fast 或红测必红。
- `.agents/skills/rcc-dev-skills/SKILL.md` 和拓扑文档记录“修改前先查 runtime help”的标准 agent skill 流程。
```
