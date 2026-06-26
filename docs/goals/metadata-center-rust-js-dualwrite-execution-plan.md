# Metadata Center Rust/JS Dual-Write Execution Plan

## 1. 目标与验收标准

### 目标

把当前“JS `MetadataCenter` 已落地、TS host/mainline 仍做 merge/projection、Rust 仍主要读 metadata JSON”的过渡态，收敛成一个可验证、可分阶段推进的迁移计划。当前计划不假设 repo 里已经存在 Rust `MetadataCenter`，而是按真实代码状态拆成两个层级目标：

1. 近端目标：先把现有 JS center 的 owner、merge、projection、payload residue 收紧，避免继续扩散第二套写点和读点。
2. 中端目标：在不破坏现有 Hub/servertool 主线的前提下，确认 Rust side 要不要、以及如何引入真正的 Rust request-scoped center。
3. 终态目标：如果 Rust center 引入可行，再把 `runtime_control` / `__rt` / 顶层 runtime projection 从“逻辑真源”降为“stale residue”，并最终删除。

### 验收标准

- 现有 metadata center 子 feature 边界清晰，并与代码一致：
  - `hub.metadata_center_mainline`
  - `hub.metadata_center_request_capture`
  - `hub.metadata_center_attempt_merge`
  - `hub.metadata_center_servertool_context`
- `request_truth`、`continuation_context`、`provider_observation` 的现有 JS center 主线保持单真源，不再被新的 flat merge/backfill 破坏。
- `mtc-03` 对应的 `runtime_control` 残留被精确量化，并按字段分为：
  - 已进 JS center 且已有读侧
  - 已进 JS center 但仍需 payload projection 供 Rust/legacy TS 读
  - 仍未进入统一中心写点
- Hub request path 对以下字段完成“唯一 owner + 唯一迁移入口”收敛：
  - `routeHint`
  - `routeName`
  - `routeId`
  - `providerProtocol`
  - `retryProviderKey`
  - `preselectedRoute`
- servertool / stopless / followup 对以下字段完成“唯一 owner + 唯一迁移入口”收敛：
  - `serverToolFollowup`
  - `serverToolFollowupSource`
  - `stopless`
  - `stopMessageEnabled`
  - `stopMessageExcludeDirect`
- 若实施 Rust center，则 Rust 侧存在真实 request-scoped `MetadataCenter` registry，而不是继续只读 payload projection。
- 若未实施 Rust center，本轮也必须明确给出“不立即引入 Rust center”的代码级原因与 blocker，不允许含糊写成长期愿景。
- 旧样本 replay 或 live replay 证明：
  - provider request 仍正确注入 route/stopless/servertool 控制面
  - client response 不泄漏内部 metadata
  - continuation / followup / stopless 行为不回退

## 2. 范围与边界

### In Scope

- `src/server/runtime/http-server/metadata-center/**`
- `src/server/runtime/http-server/executor-metadata.ts`
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**`
- 与 metadata center / mainline / owner / verification 绑定的 docs 与 gates

### Out of Scope

- SSE transport 重构
- provider auth / retry / health / quota 逻辑
- 与 metadata 无关的 servertool CLI 语义重构
- 一次性删除全部 JS center 读侧
- 新增 fallback、双路径补偿、静默兼容

## 3. 现状基线

### 已有事实

1. JS `MetadataCenter` 已真实存在，并承载：
  - `request_truth`
  - `continuation_context`
  - `runtime_control`
  - `provider_observation`
  - `client_attachment_scope`
  - `debug_snapshot`
2. `metadata.center.mainline` 已存在，但 `mtc-03` 仍是 `partial`。
3. function-map / verification-map 已经把 metadata center 拆成 4 个 transitional sub-feature：
  - `hub.metadata_center_mainline`
  - `hub.metadata_center_request_capture`
  - `hub.metadata_center_attempt_merge`
  - `hub.metadata_center_servertool_context`
4. `request-executor-attempt-state.ts` 已经是现有 JS center merge owner，不只是“计划中的 mtc-03 owner”：
  - `prepareRequestExecutorAttemptState` 会写 `runtimeControl.retryProviderKey`
  - `finalizeRequestExecutorAttemptMetadata` 会合并 request/pipeline 两个 center 的 snapshot
5. Rust 当前没有独立 Rust `MetadataCenter` registry。
6. Rust / Hub / VR / servertool 当前仍主要读取：
  - `runtime_control`
  - `__rt`
  - 顶层 runtime control projection
7. 当前形态本质上仍是：
  - JS center 写入
  - TS host/projector/attempt-merge 拼 payload residue
  - Rust 从 payload residue 读

### 关键文件证据

- JS center owner:
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
- JS center readers/projections:
  - `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
- JS request / continuation / runtime write:
  - `src/server/runtime/http-server/executor-metadata.ts`
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`
  - `sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts`
- Rust / TS mainline 仍读 payload projection:
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs`

### 4 个 Sub-Feature 对照结果

| sub-feature | 代码 owner | 测试绑定 | 文档绑定 | 当前判断 |
| --- | --- | --- | --- | --- |
| `hub.metadata_center_mainline` | `src/server/runtime/http-server/metadata-center/metadata-center.ts` | `handler-response-utils.metadata-center-closeout.spec.ts`、`request-truth-readers.spec.ts`、`stop-message-runtime-utils.continuation.spec.ts` | `function-map`、`verification-map`、`metadata.center.mainline` call-map/manifest/wiki | 对齐，属于链级 registry core + release owner |
| `hub.metadata_center_request_capture` | `src/server/runtime/http-server/executor-metadata.ts` | `executor-metadata.spec.ts`、`executor-metadata.binding.spec.ts` | `function-map`、`verification-map`、源码 `feature_id` | 对齐，负责 request-entry capture / request truth bind / early runtime-control seed |
| `hub.metadata_center_attempt_merge` | `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` | `executor-metadata.spec.ts`、`request-executor-attempt-state.contract.spec.ts` | `function-map`、`verification-map`、源码 `feature_id` | 对齐，实际承担 `mtc-03` 后半段 merge / retry pin / pipeline-result center merge |
| `hub.metadata_center_servertool_context` | `src/server/runtime/http-server/executor/servertool-adapter-context.ts` | `servertool-adapter-context.spec.ts` | `function-map`、`verification-map`、源码 `feature_id` | 对齐，负责 servertool adapter projection，不拥有独立 session/continuation truth |

补充判断：

1. 4 个 sub-feature 的 `function-map` / `verification-map` / 源码 `feature_id` 当前是一致的。
2. `mainline-call-map.yml` 里的 `metadata.center.mainline` 仍使用链级 owner `hub.metadata_center_mainline` 描述 `mtc-01..07`，没有下钻到 4 个 sub-feature。
3. 这不是立即要“改错”的矛盾，而是当前 review surface 的抽象层差异：
  - chain / lifecycle 视角仍是 `hub.metadata_center_mainline`
  - code owner / test owner 视角已经拆成 4 个 sub-feature
4. 因此第一阶段应先补“链级 owner -> 子 owner”对照说明，禁止贸然把 chain owner 改成 4 行碎片，避免生命周期图失去总 owner。

### `mtc-03` Runtime-Control 字段量化

#### A. 已进入 JS center，且已有明确写点

| 字段 | 当前写点证据 | 备注 |
| --- | --- | --- |
| `routeHint` | `responses-request-bridge.ts`、`executor-metadata.ts` 读/投影、`index.ts` route-control 写 helper | 已入 center，但仍会被 materialize 回 payload 供下游使用 |
| `retryProviderKey` | `request-executor-attempt-state.ts`、`responses-request-bridge.ts`、`index.ts` | 已入 center，Rust route/read path 仍直接读 `runtime_control` / `__rt` |
| `serverToolFollowup` | `servertool-followup-dispatch.ts`、`servertool-adapter-context.ts`、`provider-response-converter.ts` 合并链 | 已入 center，Rust/servertool/VR 仍大量吃 payload residue |
| `serverToolFollowupSource` | `servertool-followup-dispatch.ts` | 已入 center，Rust 仍直接读 `runtime_control` / `__rt` |
| `stopless` | `stopless-metadata-carrier.ts`、`servertool-followup-dispatch.ts` | 已入 center，当前是最明确的“center 写 + payload 兼容读”字段 |
| `stoplessGoal` | `provider-response-converter.ts` | 已入 center，但不在原始 `/goal` 首批字段列表中；当前已是活字段，不能忽略 |
| `stopMessageEnabled` | `executor-metadata.ts`、`index.ts`、`servertool-adapter-context.ts` | 已入 center，但顶层 `stopMessageEnabled` / `routecodexPortStopMessageEnabled` 仍是 stale residue |
| `stopMessageExcludeDirect` | `index.ts`、`executor-metadata.ts` residue 链 | 已入 center，但 direct/request-stage/Rust 仍可能直接读残留 |
| `stopMessageClientInject` | `servertool-adapter-context.ts` | 已入 center，但属于 servertool projection family，暂不宜提前删兼容层 |
| `stopMessageState` | `sharedmodule/llmswitch-core/src/handlers/stop-message-auto.ts` | 未作为 `MetadataCenter.runtime_control` canonical slot 收口；当前仍是 Rust servertool-core 直接消费的 runtime/migration mirror |
| `serverToolLoopState` | `sharedmodule/llmswitch-core/src/handlers/stop-message-auto.ts` | 未作为 `MetadataCenter.runtime_control` canonical slot 收口；当前仍是 Rust servertool-core 直接消费的 runtime/migration mirror |
| `streamIntent` | `responses-request-bridge.ts` | 已入 center，当前主要由 host/bridge 读 |
| `clientAbort` | `responses-request-bridge.ts` | 已入 center，当前主要由 host/bridge 读 |

#### B. 已有读取/类型位，但当前未证明存在统一 center 写点

| 字段 | 现状 |
| --- | --- |
| `routeName` | `metadata-center.ts` / readers 有类型位；当前更多还是普通 metadata / routing decision 语义，不是稳定 center-first writer |
| `routeId` | 同上；更多是 route projection 字段，不是稳定 center-first writer |
| `providerProtocol` | 类型位已存在，但当前主真源仍偏 entry/runtime context 普通字段；未见稳定 `writeRuntimeControl('providerProtocol', ...)` 主写链 |
| `preselectedRoute` | 有 center release / host helper / request-stage projection，但当前主要依赖 `index.ts` + `hub-pipeline-execute-request-stage.ts` 组合，不是干净的 center-first owner |

#### C. 当前仍主要靠 payload residue 的读侧

| 字段 | 当前 residue 读侧证据 |
| --- | --- |
| `retryProviderKey` | `router_metadata_input.rs`（已 snapshot-first）、`hub_pipeline_lib/engine.rs`（已 snapshot-first）、`meta_error_carriers.rs`（仍从 `__rt` 读） |
| `preselectedRoute` | `hub-pipeline-execute-request-stage.ts`（仍 materialize）、`hub_pipeline_lib/engine.rs`（已 snapshot-first） |
| `serverToolFollowup` | `chat_servertool_orchestration.rs`（仍从 `runtime_control` 读）、`virtual_router_engine/routing/metadata.rs`（仍从 `runtime_control` 读）、`engine/route.rs` |
| `serverToolFollowupSource` | `chat_servertool_orchestration.rs`（仍从 `runtime_control` 读）、`chat_node_result_semantics.rs`（已忽略 `__rt`）、`engine/route.rs` |
| `stopMessageEnabled` | `hub_pipeline_blocks/napi_bindings.rs`（死代码）、`req_process_stage1_tool_governance_blocks/orchestrator.rs`（仍从顶层投影读）、`hub_pipeline_blocks/router_metadata_input.rs`（无此字段） |
| `nowMs` | `virtual_router_engine/routing/metadata.rs`（仍从 `__rt` 读） |
| `stopless` | `hub-pipeline-execute-request-stage.ts` 顶层 projection、后续 Rust/TS 主线混读 |

#### D. 第一阶段真实结论

1. `mtc-03` 已经不是“family 缺失”问题，而是“writer 已部分落地，reader 仍大量停在 payload residue”问题。
2. 第一阶段最窄且最值当的收口面不是再发明新 family，而是：
  - 收紧现有 writer owner
  - 量化 payload residue 白名单
  - 先挑 `retryProviderKey / preselectedRoute / serverToolFollowup / stopMessageEnabled` 这类跨 Hub/VR/servertool 的活字段做迁移顺序
3. `routeName / routeId / providerProtocol` 不能在本轮文档里直接宣称“已是 center-first”；当前证据不足，只能列为“有类型位/局部投影，但主写链未收口”。

### Rust-Center Feasibility 结论

当前结论已经从“纯设计假设”推进到“最小 snapshot adapter 已真实接通”，但仍不能把“完整 Rust request-scoped MetadataCenter registry”当成第一阶段立即实施项。

代码级依据：

1. 当前 native ingress 入口仍以 metadata JSON 作为主载体：
  - `hub-pipeline-execute-request-stage.ts` 仍会把 JS center projection 重新 materialize 为 `metadata.runtime_control` / `metadata.__rt` / 顶层投影，再喂给 native。
  - 但同一个入口现在也会额外构造 `metadataCenterSnapshot`，作为最小只读 adapter 送入 native。
2. Rust 侧现有消费者普遍以 `serde_json::Value` + metadata field 读取为前提：
  - `chat_servertool_orchestration.rs`
  - `router_metadata_input.rs`
  - `hub_pipeline_lib/engine.rs`
  - `virtual_router_engine/routing/metadata.rs`
  - `hub_pipeline_blocks/napi_bindings.rs`
3. request clone / retry clone / nested followup 当前复制的是 JSON metadata 和绑定的 JS center，不存在已验证的“request-scoped Rust state handle 透传链”。
4. 因此如果直接上完整 Rust center，很容易先长出第三套真源：
  - JS center
  - payload residue
  - Rust center

#### 第一阶段可行的最小 feasibility slice

这一层已经不再是纯设想，而是最小 spike 已完成、结论已可验证：

1. `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
  - 已在 `runHubPipelineLibWithNative(...)` 调用前构造 `metadataCenterSnapshot`
  - 当前集中来源仍只有：
    - `requestTruthPayload`
    - `continuationContextPayload`
    - `metadataCenterRuntimeControl`
2. snapshot 目前是 camelCase 只读 adapter，不是 Rust registry：
  - `requestTruth`
  - `continuationContext`
  - `runtimeControl`
3. 首批 Rust snapshot-first reader 已接通 3 个 request-route control 读点：
  - `router_metadata_input.rs` -> `retryProviderKey`
  - `hub_pipeline_lib/engine.rs` -> `preselectedRoute`
  - `router_metadata_input.rs` -> `routeHint`
4. 已证明的事：
  - 不需要在 handler / bridge / servertool shell 额外补一份 snapshot 同步
  - request-stage 单入口就能把 snapshot 送到 native
  - 可以在 reader 侧收紧 legacy `__rt` residue，而不必先引入完整 Rust center

当前已核实的 feasibility 细化结论：

1. native 协议层现在已有 `metadata: Record<string, unknown>` 加可选 `metadataCenterSnapshot` 双载体；`NativeHubPipelineOrchestrationInput` 已增加独立 snapshot 参数，但仍不是 Rust center handle。
2. TS request-stage 目前仍是 JS center 的集中 materialize 点：
  - request truth / continuation context / runtime control 都在这里被重新投影回普通 metadata，再喂给 native。
  - 但同时也会构造 `metadataCenterSnapshot` 作为只读 adapter 送入 native。
3. Rust request-path 的首批 reader 已部分改读 snapshot，但其余仍以 `serde_json::Value` 直接取字段：
  - 已迁移：`hub_pipeline_lib/engine.rs`（preselectedRoute）、`hub_pipeline_blocks/router_metadata_input.rs`（retryProviderKey、routeHint）
  - 未迁移：`virtual_router_engine/routing/metadata.rs`、`chat_servertool_orchestration.rs`、`req_process_stage1_tool_governance_blocks/orchestrator.rs`、`req_process_stage1_tool_governance_blocks/servertool_injection.rs`
4. clone / followup 链路当前复制的仍是 JSON metadata + JS center 绑定：
  - retry / attempt merge：`request-executor-attempt-state.ts`
  - nested followup merge：`servertool-followup-metadata.ts`
  - provider response sync-back：`provider-response-converter.ts`
5. 因此 phase 2 若直接落完整 Rust registry，当前最可能先形成三套真源：
  - JS center
  - payload residue
  - Rust registry

所以当前更精确的 feasibility 结论是：

- 已验证的最小接入点：`executeRequestStagePipeline -> runHubPipelineLibWithNative(...)` 前的 adapter 层。
- 已验证的最小范围：只读 snapshot，不写回；当前已接通 3 个 request-route reader，但仍未扩到 servertool / followup / direct-decision 大面。
- 当前仍不可直接宣称可上完整 Rust request-scoped MetadataCenter registry。

#### 若 feasibility 失败，第一阶段 blocker 应明确写成

1. native ingress 还没有稳定 request-scoped Rust state carrier；
2. Rust 读侧分布太散，先建 registry 只会增加第三真源；
3. 应先完成 JS-center owner/residue 收紧，再做 Rust center 第二阶段。

## 4. 设计原则

1. 单写入口。所有共享 metadata 写入只允许经过一个 dual-write owner。
2. 读写分离。JS 业务层只读 JS center；Rust 业务层只读 Rust center。
3. family 隔离。`request_truth`、`continuation_context`、`runtime_control`、`provider_observation` 不共享 flat namespace。
4. 无 fallback。迁移期允许镜像，不允许“读不到 Rust center 就回退去猜 payload”。
5. request-scoped only。center 生命周期严格限定在单个 request/response 闭环。
6. 先收紧现有 transitional owner，再决定是否引入 Rust center，再迁消费者，最后删 residue。禁止跳过现有 owner 直接从理想终态改 servertool 业务语义。
7. 物理删除。迁移完成的旧 `__rt` / `runtime_control` / top-level projection 真源路径必须删除，不得闲置保留。

## 5. 技术方案

### Phase 0: Current-Code Audit And Contract Freeze

目标：先按当前代码锁 contract，而不是按理想架构锁 contract。

动作：

1. 整理当前 JS center 已覆盖的 families / slots。
2. 为每个 slot 声明：
  - `shared_sync`
  - `js_only`
  - `rust_only`
3. 为 `mtc-03` 建立字段级迁移清单。
4. 明确 `runtime_control` 哪些字段：
  - 已通过 `MetadataCenter.writeRuntimeControl(...)` 进入 JS center
  - 仍在 `runtime_control` / `__rt` / top-level projection 中作为逻辑读源
  - 由哪个 transitional owner 负责
5. 把现有 4 个 metadata-center sub-feature 与真实代码落点对齐，必要时先修 function-map / verification-map / mainline 文档。

产物：

- 本文档
- `docs/architecture/wiki/metadata-center-mainline-source.md` 补字段级现状
- `docs/architecture/mainline-call-map.yml` / manifest 补 `mtc-03` 迁移清单

### Phase 1: Close Current JS-Center Residue First

目标：先把现有 JS center 周边的 merge/projection 收紧，避免 Rust center 设计建立在漂移地基上。

动作：

1. 固化 `hub.metadata_center_request_capture`、`hub.metadata_center_attempt_merge`、`hub.metadata_center_servertool_context` 的 contract tests。
2. 收敛以下现有主写点，不新增新写点：
  - `executor-metadata.ts`
  - `request-executor-attempt-state.ts`
  - `responses-request-bridge.ts`
  - `servertool-followup-dispatch.ts`
  - `provider-response-converter.ts`
3. 清点并限制当前仍需要的 payload projection：
  - `runtime_control`
  - `__rt`
  - top-level `stopMessageEnabled` / `stopMessageExcludeDirect`
4. 先删明显错误或重复的 flat backfill，不动还在被 Rust/legacy TS 消费的过渡镜像。

### Phase 1 Immediate Implementation Slices

这部分不是理想路线，而是按当前代码还活着的 residue 直接排序。

#### Slice 1: Request-Route Control Residue Tightening

目标：先锁最窄、最可验证的一组 request-route control 字段，避免继续把 `__rt` / `runtime_control` / top-level projection 同时当真源。

当前代码证据：

- TS request-stage 仍在重新 materialize route-control：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- Rust router 输入对 `retryProviderKey` 已不再接受 `metadata.__rt`，但仍通过 payload projection 消费 `runtime_control.retryProviderKey` 与 continuation/resume provider pin：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- Rust req route stage 对 `preselectedRoute` 已收紧为只读 `metadata.runtime_control.preselectedRoute`：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`

第一批只收这 2 个字段：

- `retryProviderKey`
- `preselectedRoute`

原因：

1. 它们已经有 JS center 写点；
2. 它们当前同时穿过 JS center、`runtime_control`、`__rt`；
3. 它们正好卡在 Hub request-stage -> Rust router input 这条最短主线上；
4. 它们已有 focused tests，适合先红后绿后删 residue。

本 slice 完成前不应宣称的事情：

- 不能宣称 route-control 已经 center-first；
- 不能宣称 Rust route stage 已经不依赖 payload projection；
- 不能宣称 Phase 1 已完成。

建议执行顺序：

1. 先确认 `retryProviderKey` 的 `__rt` fallback 是否仍被真实路径依赖；
2. 若测试与样本证明不依赖，则先删 `retryProviderKey` 的一层 `__rt` fallback；
3. 再对 `preselectedRoute` 重复同样动作；
4. 删除后立刻补白盒和黑盒，证明 request-stage / router input / retry path 不回退。

当前进度（2026-06-24）：

- 已完成第 1-2 步的第一半：
  - `router_metadata_input.rs` 已删除 `retryProviderKey <- metadata.__rt.retryProviderKey` 读路径
  - focused Rust + TS/native 包装测试已锁新真相
- 已完成第 3 步：
  - `hub_pipeline_lib/engine.rs` 已删除 Rust native route stage 对 `metadata.__rt.preselectedRoute` 的读取
  - native request-path 相关 Rust 夹具已迁到 `runtime_control.preselectedRoute`
  - request-stage 黑盒已锁“传给 native 的 metadata 不再保留 route-control __rt”
  - `hub-pipeline-execute-request-stage.ts` 已删除 host route 选择对 `legacyRuntimeProjection.preselectedRoute` 的 fallback
  - 当前 host route 选择真相为 `runtime_control.preselectedRoute ?? routerEngine.route(...)`
- 尚未完成：
  - TS request-stage 仍会 materialize `runtime_control` / top-level route projection
  - `preselectedRoute` 仍未达到 center-first；当前只是把 `__rt` 从 host route 选择和 Rust route stage 的逻辑真源中移除

#### Slice 2: Servertool / Stop-Message Runtime-Control Whitelist

目标：把 stopless / followup / stop-message 的“仍允许走 payload projection”的字段收紧成显式白名单，不再让新的 servertool 控制字段自由扩散。

当前代码证据：

- Rust servertool orchestration 仍直接读 `runtime_control`：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
- Rust same-protocol direct 决策仍直接读 stop-message 顶层投影与 `__rt`：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
- request-stage 仍把 stop-message / stopless 投影回 top-level：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`

本 slice 允许继续保留过渡镜像的字段，只限于：

- `serverToolFollowup`
- `serverToolFollowupSource`
- `stopless`
- `stopMessageEnabled`
- `stopMessageExcludeDirect`

本 slice 的硬边界：

1. 只允许沿现有 owner 写入，不新增 handler/bridge/servertool shell 独立写点；
2. 不把 SSE/transport 当 stopless/servertool 语义 owner；
3. 只收白名单，不在本 slice 里新发明 family 或新 top-level 字段。

当前进度（2026-06-24）：

- 已完成第一刀 host request-stage legacy `__rt` 白名单收口：
  - `hub-pipeline-execute-request-stage.ts` 不再把“除 route-control 外的全部 legacy __rt”继续带给 native
  - 当前仅保留以下 legacy `__rt` 过渡字段：
    - `serverToolFollowup`
    - `serverToolFollowupSource`
    - `stopless`
    - `stopMessageEnabled`
    - `stopMessageExcludeDirect`
- 已补 focused 黑盒锁定：
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
    - 新增用例锁“native request metadata.__rt 只保留 whitelist，不再泄漏 `providerFamily` / `servertoolResponseOrchestration` / 任意 legacy 杂项字段”
- 已完成 Rust 首批 residue 收口：
  - `chat_servertool_orchestration.rs` 的 followup/source gate 不再接受 `adapter_context.__rt`
  - `napi_bindings.rs` 的 stop-message direct 决策不再接受 `__rt.stopMessageEnabled` / `__rt.stopMessageExcludeDirect`
- 当前仍未完成：
  - Rust servertool orchestration 仍接受 `runtime_control` / `adapter_context.runtime_control`，这仍是当前显式过渡面
  - request-stage 仍会 materialize top-level `stopMessageEnabled` / `stopMessageExcludeDirect` / `stopless`
  - 因此本 slice 还不能宣称“servertool / stop-message payload projection 已完全收口”，只能宣称“host ingress projection 面 + 两条 Rust legacy `__rt` 读侧已先收紧一层”

#### Slice 3: Rust-Side Snapshot Adapter Feasibility

目标：在“最小 adapter 已打通”的前提下，继续判断它是否值得扩展到 stop-message / servertool / followup，而不是直接宣布要上完整 Rust registry。

当前代码 blocker 没变，但现在已经更具体：

1. `runHubPipelineLibWithNative(...)` 仍是 metadata JSON 主载体，snapshot 只是并行只读 adapter；
2. Rust 剩余活 reader 已经集中暴露在 stop-message direct 决策、servertool followup gate、VR metadata/classifier 这些更宽的读面上；
3. request clone / retry clone / nested followup 当前复制的仍是 metadata JSON + JS center 绑定，而不是稳定 Rust request handle。

因此这一 slice 现在不再回答“adapter 能不能存在”，而是回答 3 个更具体的问题：

1. stop-message / followup 这类更宽 reader，是否能像 route-control 一样做到 snapshot-first，而不新增共享写点；
2. 在 servertool / VR 链上，snapshot-first 能否让 `runtime_control` 从逻辑真源继续降级，而不是只新增第四种读取形态；
3. 若 reader 扩展后仍必须同步保留同一字段的 payload residue 真读源，是否应该暂停 phase 2 扩散，继续回头收 JS-center residue。

### Phase 1 Exit Criteria

只有同时满足以下条件，才可宣称 phase 1 完成：

1. 4 个 metadata-center sub-feature 的代码 owner、测试、文档已一致；
2. `mtc-03` 字段已按“center-first / payload residue / 未统一写点”三类锁定；
3. `retryProviderKey` / `preselectedRoute` 的 residue 范围已较当前基线收紧；
4. stopless / followup / stop-message 的 payload projection 已有显式白名单；
5. Rust feasibility 结论已落成可执行 blocker 或最小接入路径；
6. 没有新增散落 metadata 写点；
7. 以下验证至少一轮通过：
  - focused whitebox
  - focused blackbox / sample replay
  - `verify:function-map-compile-gate`
  - `verify:architecture-mainline-call-map`
  - `verify:architecture-mainline-manifest-sync`
  - `verify:architecture-metadata-center-manifest-code-sync`
  - `npm run build:min`

### Phase 1 Latest Verified Status (2026-06-24, 2026-06-25 truth correction)

当前已经确认的 phase-1 收口，不再是假设项：

1. `retryProviderKey`
  - Rust router 输入已不再从 `metadata.__rt.retryProviderKey` 复活。
2. `preselectedRoute`
  - Rust route stage 已不再读取 `metadata.__rt.preselectedRoute`。
  - host request-stage route 选择也已删除 `legacyRuntimeProjection.preselectedRoute` fallback。
3. servertool / stop-message legacy `__rt`
  - native ingress 只保留显式 whitelist：
    - `serverToolFollowup`
    - `serverToolFollowupSource`
    - `stopless`
    - `stopMessageEnabled`
    - `stopMessageExcludeDirect`
  - Rust followup/source gate 不再读取 `adapter_context.__rt`
  - Rust stop-message direct 决策不再读取 `__rt.stopMessageEnabled` / `__rt.stopMessageExcludeDirect`
4. dead semantic 删除
  - `runtime_control.providerFamily` 已从 JS MetadataCenter 类型、reader、adapter projection 中物理删除，不再作为 transitional owner 残留。
  - `runtime_control.servertoolResponseOrchestration` 已从 JS MetadataCenter 类型、reader、response-stage shell 写点中物理删除，不再作为 transitional owner 残留。
  - `runtime_control.serverToolFollowupMode` 已从 JS MetadataCenter 类型、reader、followup shell projection 中物理删除，Rust followup contract 现在只依赖 `routecodexPortMode` / `adapter_context.routecodexPortMode`。
5. 当前整链验证证据
  - focused Jest / cargo tests 已覆盖 route pin、legacy `__rt` whitelist、servertool adapter context。
  - `verify:function-map-compile-gate`、`verify:architecture-mainline-call-map`、`verify:architecture-mainline-manifest-sync`、`verify:architecture-metadata-center-manifest-code-sync` 已通过。
  - `npm run build:min` 之前曾通过；当前工作树里最新一次 rerun 没有指向 metadata-center 本身，而是被无关的 `verify:function-map-canonical-builder-definitions` 挡住，报的是 `hub.route_selection_bridge` 缺少 `run_vr_route_04_selected_target_entrypoint` 的 canonical builder definition。

因此 phase 1 的下一步顺序应固定为：

1. 继续审计剩余活 `runtime_control` residue，优先区分“仍有真实 consumer”与“可直接物理删除”。
2. 仅在剩余 residue 无法继续明显收紧后，再做 Rust-side snapshot adapter feasibility slice。
3. 在 native ingress 仍以 metadata JSON 为唯一载体之前，不把“Rust request-scoped MetadataCenter registry 已存在”写成前提或目标已达成。

### Phase 2: Rust-Center Feasibility Slice

目标：在最小 snapshot adapter 已落地的前提下，决定下一批 reader 是否继续扩到 stop-message / servertool / VR，还是在这里止损，不把 phase 2 误写成“Rust center 已就绪”。

要回答的代码级问题：

1. Rust center 生命周期挂在哪个 native ingress owner 上。
2. `runHubPipelineLibWithNative(...)` 当前是否需要接收：
  - center snapshot
  - center handle
  - family-specific payload
3. `router-hotpath-napi` 内哪些模块需要直接读 Rust center，而不是继续吃 metadata JSON。
4. 当前 NAPI / serde / request clone / retry clone 是否支持 request-scoped Rust state 透传。

产物：

- 一个最小 spike 设计，不要求当轮全量实现。
- 若可行，给出最小首批 family：`request_truth + continuation_context + runtime_control`。
- 若不可行，给出 blocker 和为什么本轮应先完成 JS-center closeout。

#### Phase 2 最小实验设计（当前代码真相版）

这不是“开 Rust registry”，而是“基于已存在的只读 adapter 继续挑窄 reader 扩展”的二段 spike。

##### A. 实验接入点

唯一建议接入点：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- 具体位置：
  - `executeRequestStagePipeline(...)`
  - `runHubPipelineLibWithNative(...)` 调用前

理由：

1. 这里是当前 JS center 集中读出点；
2. 这里已经同时掌握：
  - `requestTruthPayload`
  - `continuationContextPayload`
  - `metadataCenterRuntimeControl`
3. 这里也是当前 payload residue 被重新 materialize 回 native metadata 的唯一集中入口；
4. 若 adapter 不挂这里，就会逼着 handler / bridge / servertool shell 各补一次同步，违反本计划约束。

##### B. 实验输入契约

当前 native 输入已经有单一 snapshot 参数，且名称已固定为 `metadataCenterSnapshot`：

- `request.metadata` 继续保留
- `request.metadataCenterSnapshot` 已存在

最小内容当前实际为：

- `requestTruth`
- `continuationContext`
- `runtimeControl`

禁止：

- provider observation
- debug snapshot
- client attachment scope
- 任意 provider-specific shape

##### C. 当前已接通 reader 与下一批 reader

首批已完成的 reader：

1. `router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
   - `retryProviderKey`
   - `routeHint`
2. `router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
   - `preselectedRoute`

这些 reader 现在都已经验证：

1. snapshot-first
2. `runtime_control` 次级兼容读仍保留
3. legacy `__rt` 对应 route-control 读面已被忽略

下一批 reader 不应再泛泛写"servertool area"，而应按当前代码实际调用边分三步：

1. 先切 `req_process_stage1_tool_governance_blocks/orchestrator.rs`
   - 目标函数：`should_inject_stopless_system_instruction(metadata)`
   - 目标字段：
     - `stopMessageEnabled`
     - `routecodexPortStopMessageEnabled`
   - 当前读取方式：只读 `metadata` 顶层残留
   - 原因：
     - 这是当前唯一真正活着的 `stopMessageEnabled` 消费者
     - 读面窄（只决定是否注入 stopless system instruction + reasoningStop tool）
     - 改成 snapshot-first 后，顶层投影可以逐步降级
2. 再切 `req_process_stage1_tool_governance_blocks/servertool_injection.rs`
   - 目标函数：`read_runtime_metadata(metadata)`
   - 当前读取方式：`metadata.__rt`（仍读整个 `__rt` 对象，主要消费 `webSearch`）
   - 原因：
     - 这是 servertool injection 里仍然吃 `__rt` 的活读面
     - 当前消费的是 `webSearch`、`serverToolFollowup` 等
     - 比 stop-message 判定更宽，但仍属于 req_chatprocess 单一入口
3. 最后切 `chat_servertool_orchestration.rs` 与必要的 VR metadata readers
   - 目标字段：
     - `serverToolFollowup`
     - `serverToolFollowupSource`
   - 原因：
     - 已进入 servertool followup / response-governance / route planning 宽面
     - 更容易把一次改动扩散到 classifier / routing / outcome plan
     - 必须在前两步成功后再做

注意：`hub_pipeline_blocks/napi_bindings.rs` 的 `stop_message_excludes_direct(metadata)` 当前是死代码，没有调用方；TS wrapper `evaluateResponsesDirectRouteDecisionWithNative()` 也没有传 metadata 给 Rust。这两个都不是当前活 reader，不应被误写成"下一批"。

##### D. 实验成功标准

phase-2 下一步 reader 扩展只有同时满足以下条件才算可行：

1. JS 不新增第二个共享写点；
2. Rust 新 reader 能先读 snapshot adapter，再在同一变更里删除或冻结一小段 legacy residue 读路径；
3. retry / continuation / nested followup 不需要新增额外补同步；
4. 原有 focused whitebox / blackbox 不回退；
5. `metadata-center-manifest-code-sync` 与 mainline docs 不需要引入“Rust registry 已存在”的错误表述。

##### E. 实验失败条件

出现以下任一情况，就应判定 phase 2 仍 blocked，不能继续扩：

1. native 协议需要让每个 caller 手工构造第二份 snapshot payload；
2. request clone / retry clone / nested followup 任一链路无法无损携带 adapter snapshot；
3. 新 reader 改造后仍不得不继续依赖原 payload residue 作为唯一真读源才能工作；
4. 需要在 handler / bridge / servertool shell 各自补同步；
5. 为通过 spike 不得不引入 fallback。

##### F. 最小验证栈

若继续推进 phase-2 下一批 reader，最小验证必须包含：

1. focused Rust whitebox
  - `napi_bindings.rs` 或 `chat_servertool_orchestration.rs` 对新迁移字段的 snapshot-first 读取测试
  - legacy/top-level residue 被忽略或降级的反向测试
2. focused TS/native bridge test
  - `hub-pipeline-execute-request-stage.ts` 只在一个入口构造 snapshot adapter
  - native request metadata 不新增不必要的第二份共享真源
3. 架构 gate
  - `npm run verify:architecture-metadata-center-manifest-code-sync`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-mainline-manifest-sync`
4. build / sample
  - `npm run build:min`
  - 至少 1 条 route / retry / continuation 相关 focused sample replay

##### G. 已实现的输入协议真相

此处不再保留草案，直接记录当前代码真相：

1. 协议层类型已改动：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts`
2. 当前新增的可选字段已经是：

```ts
type MetadataCenterSnapshotInput = {
  requestTruth?: Record<string, unknown>;
  continuationContext?: Record<string, unknown>;
  runtimeControl?: Record<string, unknown>;
};
```

3. 当前约束不变：
  - 这是“只读 adapter”，不是 Rust center handle
  - `metadata` 仍保留
  - `metadataCenterSnapshot` 只允许从 `executeRequestStagePipeline(...)` 一个入口集中构造
  - snapshot 字段命名使用 camelCase family 名，不再另起 snake_case 草案

##### H. 当前 reader 顺序真相与下一步建议

已落地的读取顺序：

1. `retryProviderKey`
  - `metadataCenterSnapshot.runtimeControl.retryProviderKey`
  - `metadata.runtime_control.retryProviderKey`
  - 明确忽略 `metadata.__rt.retryProviderKey`
2. `preselectedRoute`
  - `metadataCenterSnapshot.runtimeControl.preselectedRoute`
  - `metadata.runtime_control.preselectedRoute`
  - 明确忽略 `metadata.__rt.preselectedRoute`
3. `routeHint`
  - `metadataCenterSnapshot.runtimeControl.routeHint`
  - 顶层 `routeHint`
  - continuation / `responsesResume` 路径

下一步建议白盒：

1. `stop_message_excludes_direct_prefers_snapshot_runtime_control`
2. `stop_message_excludes_direct_falls_back_to_top_level_projection_when_snapshot_absent`
3. `stop_message_excludes_direct_still_ignores_legacy_rt_toggle`

再下一步才是：

1. `serverToolFollowup`
2. `serverToolFollowupSource`
3. 必要时补 VR metadata / classifier / route followup 边上的配套白盒

##### I. TS bridge 白盒建议

首批 TS bridge 测试只锁一个事实：

1. `executeRequestStagePipeline(...)` 在 native 调用前构造 `metadataCenterSnapshot`
2. 构造内容仅来自：
  - `requestTruthPayload`
  - `continuationContextPayload`
  - `metadataCenterRuntimeControl`
3. 不额外从 flat metadata / `__rt` 再补一份 snapshot
4. `request.metadata` 仍保持当前 payload residue 行为，直到首批 Rust reader 迁完

### Phase 3-8: 远期方向记录（非当前可执行计划）

以下 Phase 3-8 仍保留原始方向描述，但当前代码事实表明它们不构成近期可执行计划：

- Phase 2 snapshot adapter 仍处于"窄 reader 逐步接通"阶段，尚未到达"可建完整 Rust registry"的前置条件。
- 当前真正的 bottleneck 是：Rust 侧仍有大量活 reader 在吃 `runtime_control` / 顶层投影 / `__rt`，而不是 snapshot。
- 在这些活 reader 没有逐个迁到 snapshot-first 之前，建 Rust registry 只会新增第三真源。

远期方向（Phase 3-8）简述：

- Phase 3: 在 Rust 建立真实 request-scoped center（当前 blocker：snapshot-first reader 覆盖不足）
- Phase 4: Single Dual-Write Sync Owner（当前 blocker：Phase 3 未完成）
- Phase 5: Hub Request Path Consumer Migration（部分已由 snapshot-first reader 替代，`routeHint/retryProviderKey/preselectedRoute` 已迁，其余仍需逐字段推进）
- Phase 6: Servertool / Stopless / Followup Consumer Migration（当前最活跃的未迁 reader：`orchestrator.rs` 的 `should_inject_stopless_system_instruction()`、`servertool_injection.rs` 的 `read_runtime_metadata()`、`chat_servertool_orchestration.rs` 的 followup/source gate）
- Phase 7: Delete Payload Residue（当前 blocker：Phase 5-6 未完成，`runtime_control` / `__rt` / 顶层投影仍有活 consumer）
- Phase 8: Shrink JS Center / Reclassify Owner（当前 blocker：Phase 7 未完成）

这些方向的有效性仍成立，但不应被当成当前可立即开工的任务。每一阶段进入前，必须先确认前置 snapshot-first reader 已按当前代码 truth 逐字段验证完毕。

### Phase 4: Single Dual-Write Sync Owner

目标：让现有 JS center 共享写入在一个地方同步 Rust center，而不是改每个调用点。

动作：

1. 在 JS center core 旁新增 sync owner。
2. 只让被列为 `shared_sync` 的 `MetadataCenter.write*` 进入统一 bus：
  - write JS center
  - validate schema / slot
  - write Rust center
3. 对非 `shared_sync` 字段拒绝同步。
4. 对写入失败 fail-fast，不吞异常。

建议位置：

- `src/server/runtime/http-server/metadata-center/`

禁止：

- handler 里单独写 Rust
- bridge 里单独写 Rust
- servertool shell 内部自补 sync
- 在 payload 中塞“为了 Rust 读方便”的临时字段

### Phase 5: Hub Request Path Consumer Migration

目标：在现有 request-stage TS shell + native ingress 结构下，先切 Hub / VR / req-process 的 route-control 读侧。

原因：

- 这是当前 `mtc-03` 最大残留面。
- `hub-pipeline-execute-request-stage.ts` 仍在拼 `__rt` + `runtime_control` + JS center projection。
- `routing/metadata.rs`、`router_metadata_input.rs`、`hub_pipeline_lib/engine.rs` 仍明确吃 payload metadata。

先迁字段：

- `routeHint`
- `routeName`
- `routeId`
- `providerProtocol`
- `retryProviderKey`
- `preselectedRoute`

动作：

1. TS request-stage 不再把这些字段重新 materialize 成 payload 真源。
2. native request entry 接收 Rust center handle / snapshot。
3. Rust req/chat-process/VR 只从 Rust center 读 route-control。
4. 保留只读镜像用于过渡验证，但不再作为逻辑判断真源。

### Phase 6: Servertool / Stopless / Followup Consumer Migration

目标：把 servertool 控制面从“adapterContext JS center + runtime_control/__rt residue 混读”收敛到单一路径；若 Rust center 已落地，则迁到 Rust center。

先迁字段：

- `serverToolFollowup`
- `serverToolFollowupSource`
- `stopless`
- `stopMessageEnabled`
- `stopMessageExcludeDirect`

动作：

1. Rust `chat_servertool_orchestration` / followup / stopless owner 改读 Rust center。
2. JS `servertool-adapter-context` 收缩成 thin projection shell。
3. `stopless-metadata-carrier` 继续只做 center-bound write helper，不再承担第二真源。

### Phase 7: Delete Payload Residue

目标：物理删除旧 runtime truth。

删除对象：

- `metadata.__rt` 承载的 runtime control 真源
- `metadata.runtime_control` 真源读路径
- 顶层 `stopMessageEnabled` / `routecodexPortStopMessageEnabled` 等逻辑真源残留
- Rust 各模块对这些字段的直接读取

重点文件：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/runtime_metadata.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**`

### Phase 8: Shrink JS Center / Reclassify Owner

前提：

- Rust 读侧已接管，或明确确认本阶段仍保留 JS center 为唯一 registry 真源
- payload residue 已删除
- servertool / Hub / VR 主线稳定

动作：

1. 若 Rust center 已接管，JS center 只保留 host adapter / bridge / IO 必需读法。
2. 若 Rust center 还未接管，也必须把 transitional owner 的责任边界重新分类，避免继续假装“快要 Rust SSOT”。
3. 更新 function-map / verification-map / mainline，把 owner 从 transitional 向 Rust SSOT 收敛，或明确保留 transitional 并写 blocker。

## 6. 文件清单

### 必改文档

- `docs/goals/metadata-center-rust-js-dualwrite-execution-plan.md`
- `docs/architecture/wiki/metadata-center-mainline-source.md`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/manifests/metadata.center.mainline.yml`
- `docs/architecture/mainline-manifests/metadata.center.mainline.yml`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`

### 必改 JS

- `src/server/runtime/http-server/metadata-center/metadata-center.ts`
- `src/server/runtime/http-server/metadata-center/metadata-center-types.ts`
- `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
- `src/server/runtime/http-server/executor-metadata.ts`
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts`

### 可选 / 条件性改 Rust

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**`
- 仅在 Phase 2 证明可行后新增 `metadata_center/**`
- `chat_servertool_orchestration.rs`
- `hub_pipeline_blocks/router_metadata_input.rs`
- `hub_pipeline_blocks/runtime_metadata.rs`
- `hub_pipeline_lib/engine.rs`
- `virtual_router_engine/routing/metadata.rs`

## 7. 风险与规避

### 风险 1：把“计划中的 Rust center”当成“代码里已经有的 Rust center”

表现：

- 文档按 Rust center 已存在写
- 实现却仍然全靠 payload projection

规避：

- 先做 feasibility slice
- 文档和 goal 禁止把条件性阶段写成既成事实

### 风险 2：变成双长期真源

表现：

- JS center 是一套
- Rust center 是一套
- payload projection 又是一套

规避：

- dual-write 只能通过一个 owner
- 每完成一个 consumer slice，立即删对应 payload 真源读路径

### 风险 3：servertool / stopless 行为回退

表现：

- provider request 丢 stopless guidance
- followup 错误终止
- continuation state 丢失

规避：

- 先迁 Hub route-control，再迁 servertool
- servertool 切换前补 provider-facing/client-facing 黑盒

### 风险 4：把 SSE/transport 当 owner 修

表现：

- 为了让 stopless/followup 过关去改 SSE 或 response transport

规避：

- 明确 SSE transport 不属于 metadata center / servertool 控制面 owner
- 所有修复回 owner：Hub governance / continuation / servertool orchestration

### 风险 5：旧样本 replay 失败却误判逻辑坏了

规避：

- 先做 focused 白盒 + 黑盒
- 再做 live replay/旧样本 replay
- 区分逻辑红、旧产物红、样本失活红

## 8. 测试计划

### 白盒

- JS/Rust shared schema registry 一致
- dual-write 对 `shared_sync` slot 两侧读值一致
- `request_truth` write-once
- `continuation_context` 不能覆盖 `request_truth`
- Rust center release / closeout 状态正确
- 若实施 Rust center：Rust req/chat-process/VR/servertool 只读 Rust center
- 若未实施 Rust center：必须证明现有 payload projection 读侧已被限定在明确白名单，且没有新增扩散

### Provider-facing 黑盒

- route pin 正确进入 provider request
- stopless guidance / `reasoningStop` 注入正确
- followup / servertool 控制面没有丢

### Client-facing 黑盒

- servertool CLI projection 不回退
- stopless continuation 不回退
- client body / SSE 不泄漏内部 metadata

### Continuation 黑盒

- save/restore 后 `routeHint` / `providerKey pin` / `stopless state` 持续正确
- continuation-only 情况不误 materialize 成 request truth

### 必跑 Gate

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-metadata-center-manifest-code-sync`
- `npm run verify:servertool-rust-only`
- `npm run build:min`

### 旧样本 / Live 验证

- 至少一组 responses continuation 样本
- 至少一组 stopless / servertool followup 样本
- 若样本不可 replay，必须说明缺口并做真实入口 live probe

## 9. 实施步骤

1. 补文档与 map，把当前 4 个 metadata-center sub-feature 与 `mtc-03` 字段级迁移清单写实。
2. 先收紧现有 JS-center write/merge/projection residue，禁止新增散落写点。
3. 做 Rust-center feasibility slice，决定是否进入真实 Rust center 实现。
4. 若可行，再建 Rust metadata center registry 与最小 family buckets。
5. 建 JS->Rust single dual-write sync owner。
6. 先迁 Hub request path 的 route-control 读侧。
7. 再迁 servertool / stopless / followup 读侧。
8. 删除 `runtime_control` / `__rt` / top-level runtime projection 真源读路径。
9. 跑 focused 白盒、focused 黑盒、build、旧样本/live replay。
10. 收缩 JS center 或重分类 transitional owner，更新 function-map / verification-map / mainline owner 状态。

## 10. 完成定义（DoD）

- 当前代码真实状态、计划状态、终态目标三者已分开，不再混写。
- dual-write owner 唯一；如果 Rust center 未落地，也必须明确写出 blocker，而不是暗示已存在。
- `mtc-03` 从 `partial` 收敛到 anchored，或剩余 partial 有明确字段级清单与 blocker。
- 若 Rust center 已落地：Hub / VR / servertool 主线真实消费 Rust center。
- 若 Rust center 未落地：现有 JS-center transitional owner 已收紧，`runtime_control` / `__rt` / 顶层 projection 的逻辑真源范围已被显式白名单化，且没有新扩散。
- 相关 focused tests、architecture gates、`build:min`、样本 replay / live probe 全部通过。
- 删除路径已物理删除，不留闲置旧实现。

## 11. 当前验证证据（2026-06-24）

### Focused Whitebox / Contract

- `tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts` PASS
- `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
- `tests/servertool/stop-message-runtime-utils.continuation.spec.ts` PASS
- `tests/server/http-server/executor-metadata.spec.ts` PASS
- `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` PASS
- `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts` PASS
- `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts` PASS

补充：

- `request-truth-readers.spec.ts` 中旧断言曾期待 `runtime_control.stopless.sessionId`。
- 当前代码真相是：stopless session truth 属于 `request_truth.sessionId`，不属于 `runtime_control.stopless` projection。
- 因此本轮已把该测试修正为当前 owner truth，而不是保留过时 runtime residue 预期。

### Architecture / Function Map Gates

- `npm run verify:function-map-compile-gate` PASS
- `npm run verify:architecture-mainline-call-map` PASS
- `npm run verify:architecture-mainline-manifest-sync` PASS
- `npm run verify:architecture-metadata-center-manifest-code-sync` PASS

### Build

- `npm run build:min` PASS

### Old Sample Replay

- `tests/servertool/stop-message-sample-replay.spec.ts` PASS

补充：

- 本轮同步修正了旧 replay 断言：
  - 原测试错误把 `provider-request.json` 当成 client-visible CLI projection，硬断言工具名为 `exec_command`
  - 当前样本真相是 provider-facing stopless tool shape，工具名为 `reasoningStop`
  - 已改成锁当前 sample truth，而不是维持过时断言
