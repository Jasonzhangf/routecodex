# HubPipeline Module-by-Module Rust Closeout Plan

## 1. 目标

把 Hub Pipeline 从“Rust 语义真源 + TS 宿主边界/薄壳”按模块逐块收口。执行目标不是一次性删光 TS，而是：

1. 先把每个 Hub 关键模块收成 `Rust-only semantic owner`；
2. 每收完一个模块，就补齐 owner map、mainline binding、verification map、红绿验证；
3. 最终只剩可解释、可验证、不可承载业务语义的 host adapter TS；
4. 若后续仍要求“零 TS”，再单开宿主边界迁移，不与本轮语义 Rust closeout 混做。

## 2. 验收标准

### 2.1 总体验收

- Hub Pipeline 拆成明确模块，每个模块都有唯一 `feature_id`、唯一 owner、唯一验证栈。
- 每个完成模块都满足：
  - Rust 持有模块业务语义真源；
  - TS 不再改写该模块的 payload / messages / tools / route / metadata 语义；
  - `function-map.yml`、`verification-map.yml`、`mainline-call-map.yml` 对应该模块可查询；
  - 至少一条红测先红后绿；
  - 模块定向 gate + build + 必要 live replay 有证据。
- 已被 Rust 接管的旧 TS 语义实现物理删除，不能只是不接入。

### 2.2 本计划不宣称的目标

- 本计划不等于“Node host / HTTP / stream / N-API bridge 全部 Rust 化”。
- 本计划不以“TS 文件归零”作为完成信号。
- 本计划不接受 fallback / dual-path / shadow business logic 长期共存。

## 3. 范围与边界

### In Scope

- `sharedmodule/llmswitch-core/src/conversion/hub/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/**`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/**`
- `src/modules/llmswitch/bridge/**`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`

### Out of Scope

- provider transport/auth/retry 重新设计
- HTTP server 全量 Rust 重写
- SSE writer/Express frame writer 重写
- 与当前模块 closeout 无关的 provider 特例清理
- 以“删 TS”为名引入不可验证的 N-API 大改

## 4. 设计原则

1. 先模块化，再 closeout；禁止继续以“大 HubPipeline family”汇报进度。
2. 一次只收一个 closeout 单元；每单元必须能独立查 owner、查 gate、查主线边。
3. 主线优先于目录；拆分粒度按 pipeline stage / bridge family / effect family，不按文件夹粗切。
4. TS 可保留宿主边界，不可保留业务语义。
5. 所有“已迁 Rust”的旧 TS 语义必须物理删除。
6. 无先红证据、无定向 gate、无旧样本复测，不得宣称模块闭环完成。

## 5. 当前真相与关键阻塞

### 5.1 已知真相

- 项目规则要求：Hub Pipeline 业务语义 Rust-only；TS 允许薄壳/编排。
- request 主线仍有未收口 binding：
  - `HubReqChatProcess03Governed -> VrRoute04SelectedTarget`
  - `VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic`
- 当前 function map 大量覆盖 servertool family，但未形成“整个 Hub Pipeline 每模块一个 owner/gate”的任务面。
- TS 当前仍承担三类宿主边界：
  - metadata/runtime control 解包与对象桥接
  - Node `Readable` / SSE codec / HTTP frame 适配
  - native binding loader / Error 对象塑形 / runtime effect 执行

### 5.2 关键判断

- 现在直接推动“零 TS”会把“Hub 语义 closeout”和“Node host 重构”混成一件事，风险过大。
- 正确路径是先把 Hub 语义模块化 closeout 到 Rust，再决定最后是否继续压缩 host adapter。

### 5.3 2026-06-24 重新审计修正（servertool 已恢复 Rust 后）

- 旧判断“`servertool-core` 编译面阻塞 M2 验证”已失效。
- 当前真相变为：
  - `cargo test -p router-hotpath-napi req_process_stage1_tool_governance --lib -- --nocapture` 当前为绿；
  - `npm run verify:function-map-compile-gate` 当前为绿；
  - 根 `package.json` 已存在 `build:native-hotpath`，此前“缺脚本导致 compile-gate 假阻塞”的判断已过期；
  - `npm run verify:servertool-rust-only`、`npm run verify:architecture-mainline-call-map`、`npm run build:base` 当前均已实跑转绿；
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts`、`tests/responses/responses-openai-bridge.spec.ts` 当前均已转绿；
  - `tests/servertool/stop-message-sample-replay.spec.ts` 当前已提供 codex-samples replay 旧样本复测证据。
- 当前修正后的关键判断：
  1. M2 当前不再被 compile-gate / focused Rust test 阻塞；
  2. `responses-request-bridge.ts` 当前已不再持有 stopless instruction 文本真源，stopless contract 文本真源已回到 Rust `req_process_stage1_tool_governance_blocks/orchestrator.rs`；
  3. 本轮实际需要修的不是 M2 owner 语义，而是 residue audit 对已删除 backend-route / handler 文件和已迁移 SSE owner 的过期断言。
- 当前剩余 gap：
  - M2 owner/gate 已有强证据，但 `request.mainline` 的 `req-03` / `req-04` 仍是后续模块 M3/M4 的 `binding pending` / `partial` 债务；
  - 因此本轮最多只能宣称 “M2 closeout evidence refreshed and stabilized”，不能冒充整个 request path 已收完。

## 6. 模块拆分总表

| 模块 ID | 模块名 | 主线位置 | 优先级 | 当前状态 | 完成目标 |
| --- | --- | --- | --- | --- | --- |
| M1 | `hub.req_inbound_standardization` | `req-01 -> req-02` | P1 | 半收口 | req 标准化/entry capture 语义 Rust-only |
| M2 | `hub.req_chatprocess_governance` | `req-02 -> req-03` 前 | P0 | 高价值 | request tool governance Rust-only |
| M3 | `hub.route_selection_bridge` | `req-03` | P0 | anchored | route selection caller/callee/typed contract 锁定 |
| M4 | `hub.req_outbound_provider_semantic` | `req-04 -> req-05` | P0 | partial | req outbound semantic + compat Rust-only |
| M5 | `hub.resp_inbound_parsing` | `resp-01` | P1 | 部分 Rust | provider raw/parse/materialize Rust-only |
| M6 | `hub.resp_chatprocess_governance` | `resp-02 -> resp-03` 前 | P0 | 高价值 | response governance/servertool/stopless Rust-only |
| M7 | `hub.resp_outbound_client_projection` | `resp-03 -> resp-04` | P1 | partial | client semantic projection Rust-only |
| M8 | `hub.host_adapter_boundary` | 主线外宿主边界 | P2 | 未拆 | 仅保留非语义 host adapter |

## 7. 推荐执行顺序

1. `M2 hub.req_chatprocess_governance`
2. `M6 hub.resp_chatprocess_governance`
3. `M3 hub.route_selection_bridge`
4. `M4 hub.req_outbound_provider_semantic`
5. `M1 hub.req_inbound_standardization`
6. `M5 hub.resp_inbound_parsing`
7. `M7 hub.resp_outbound_client_projection`
8. `M8 hub.host_adapter_boundary`

原因：

- `M2/M6` 最接近项目硬规则“Hub ChatProcess Rust-only”，收益最大。
- `M3/M4` 是 request 主线尚未锁死的核心缺口。
- `M1/M5/M7` 可在主线中后段补齐 contract，但不是当前最危险的灰区。
- `M8` 不是业务语义 closeout，最后做。

## 8. 模块详细设计

### M1 `hub.req_inbound_standardization`

#### 目标

收口 `ServerReqInbound01ClientRaw -> HubReqInbound02Standardized` 与 request-side responses context capture，确保入口协议解析、标准化、context capture 真源在 Rust。

#### Owner 目标

- Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/**`
- TS 允许：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts` 中纯 request ingress glue
  - native export 壳

#### 必收内容

- endpoint/providerProtocol/processMode/stream truth capture
- responses context snapshot capture
- entry request 标准化
- metadata carrier 绑定与隔离

#### 必删/必退化内容

- TS 侧任何对标准化字段的二次修正
- TS 侧任何把 metadata 写回 payload 的逻辑

#### 关键文件

- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `src/modules/llmswitch/bridge/native-exports.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.ts`
- Rust req inbound typed entrypoints / builders

#### 必补文档/Map

- function map 新增 `hub.req_inbound_standardization`
- verification map 新增对应 gate
- mainline call map 锁 `req-01` / `req-02` owner

#### 验证

- focused Rust tests for req inbound capture/standardize
- TS blackbox for `/v1/chat/completions` and `/v1/responses`
- metadata leak boundary gate
- old sample replay for responses resume context

### M2 `hub.req_chatprocess_governance`

#### 目标

收口 `HubReqInbound02Standardized -> HubReqChatProcess03Governed` 的工具治理、history/tool_result 顺序、servertool/MCP/apply_patch/request-side rewrite。

#### Owner 目标

- Rust owner：
  - `req_process_stage1_tool_governance.rs`
  - request-side chat process typed builders
- TS 允许：
  - native wrapper
  - 无语义 orchestration shell

#### 必收内容

- tool declaration injection/cropping
- text tool harvest governance
- tool result ordering legality
- stopless/request-side contract rebound
- web_search/servertool builtin governance

#### 必删/必退化内容

- TS 任何 `messages/tools/tool_calls` 的治理性遍历/过滤/重写
- TS 任何 coding/web_search/servertool 激活条件判定

#### 关键文件

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-process-semantics.ts`
- Rust req chatprocess blocks/tests

#### 必补文档/Map

- function map 新增 `hub.req_chatprocess_governance`
- verification map 绑定 focused Rust + blackbox + architecture gate
- mainline `req-02 -> req-03` owner 显式化

#### 验证

- red test: tool injection / tool order / no unintended coding
- Rust unit tests for governance branches
- `npm run verify:servertool-rust-only`
- old stopless/search/tool samples replay

### M3 `hub.route_selection_bridge`

#### 目标

消除 `req-03` 的 `binding pending`。锁定 `HubReqChatProcess03Governed -> VrRoute04SelectedTarget` 的 runtime caller/callee、typed contract、owner feature。

#### 2026-06-25 当前状态

- `req-03` 已从 `binding pending` 收口为 anchored：
  - caller: `execute`
  - callee: `run_vr_route_04_selected_target_entrypoint`
  - owner feature: `hub.route_selection_bridge`
- Rust typed contract 已显式落盘：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/request_typed_entrypoints.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/vr_route_04_selected_target.rs`
- route-control 真源收紧证据：
  - `runtime_control.preselectedRoute` 优先于 legacy `__rt.preselectedRoute`
  - legacy `__rt.retryProviderKey` 在无 `runtime_control` 时不再复活
  - relay continuation scope 的 `routeHint/providerKey/sessionId/conversationId` 仍可在进入 Hub 前保持 queryable
- 已实跑验证：
  - `cargo test -p router-hotpath-napi request_typed_entrypoints_preserve_payload_for_live_path_wiring --lib -- --nocapture`
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
  - `tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`
  - `tests/server/runtime/http-server/request-executor-preselected-route.blackbox.spec.ts`
  - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts`
  - `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-mainline-binding-pending-gate`
  - `npm run verify:servertool-rust-only`
  - `npm run build:base`
- 等价 request-path 证据说明：
  - handler 层 `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts` 当前仍因 `.js` 运行面 native export 不一致失败，
    不是 M3 route bridge 语义红点；
  - 本轮改用更贴近 request executor 真路径的等价 blackbox/contract 组合补齐尾证据：
    - resumed relay 的 `routeHint/providerKey/sessionId/conversationId` 在 `req-03` 前保持 queryable；
    - `runtime_control.preselectedRoute` 在 request executor / Hub 边界生效；
    - legacy `__rt` / flat retry-preselected residue 不复活；
    - provider failure reroute 前会清掉 relay `preselectedRoute`，让 Hub 重选目标。
- 当前剩余 debt：
  - `req-04` 仍是 `binding pending`，属于 M4，不得把本轮 M3 绿灯外推成整个 request path 已闭环。

#### Owner 目标

- Rust owner：
  - `virtual_router_engine/**`
  - typed route builders
- TS 允许：
  - 将 governed request 和 router metadata 送入 Rust route runtime
  - 不允许 route policy 判定

#### 必收内容

- route selection runtime input build
- routeHint/retryProviderKey/responsesResume route metadata ownership
- route decision typed contract

#### 必删/必退化内容

- TS route preselection semantics
- TS route metadata guess/repair

#### 关键文件

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts`
- Rust virtual router engine files

#### 必补文档/Map

- mainline call map：`req-03` 从 `binding pending` 变 anchored
- function map：新增 `hub.route_selection_bridge`
- verification map：route bridge gates

#### 验证

- red test: routeHint / retryProviderKey / continuationOwner isolation
- VR focused Rust tests
- architecture mainline call map gate

### M4 `hub.req_outbound_provider_semantic`

#### 目标

消除 `req-04` 的 `binding pending`，收口 `VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload` 的 provider-neutral outbound semantic 与 request compat。

#### Owner 目标

- Rust owner：
  - req outbound typed builders
  - `req_outbound_stage3_compat.rs`
- TS 允许：
  - `runReqOutboundStage3CompatJson` bridge
  - profile id / wrapper dispatch

#### 必收内容

- provider semantic outbound payload
- `responses:crs` compat
- tool normalization / parameters normalization
- `instructions -> input` normalization

#### 必删/必退化内容

- TS/provider/server 侧第二份 request compat
- TS 侧 `instructions`、`tools`、`temperature/max_tokens` 等删改补偿

#### 关键文件

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts`
- Rust req_outbound stage3 compat modules

#### 必补文档/Map

- mainline call map：`req-04` anchored
- function map：新增 `hub.req_outbound_provider_semantic`
- 复用并更新 `docs/architecture/responses-request-compat-rustification-plan.md`

#### 验证

- `npm run verify:responses-request-compat-rust-only`
- focused request compat tests
- provider-request snapshot replay

### M5 `hub.resp_inbound_parsing`

#### 目标

收口 `ProviderRespInbound01Raw -> HubRespInbound02Parsed` 的 raw/SSE materialize、parse、provider raw -> hub canonical inbound 真源。

#### Owner 目标

- Rust owner：
  - response typed parse entrypoints
  - resp inbound parsers/materializers
- TS 允许：
  - 读 Node stream
  - 调 codec
  - 不得改语义 parse 结果

#### 必收内容

- provider raw response parse
- SSE payload materialization
- parse error classification input

#### 必删/必退化内容

- TS 任何 provider-specific response parse 修补
- TS 任何“先凑 shape 再丢给 Rust”的二次转换

#### 关键文件

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.ts`
- Rust response typed entrypoints/parsers

#### 验证

- resp inbound focused Rust tests
- SSE materialize tests
- malformed provider payload red/green tests

### M6 `hub.resp_chatprocess_governance`

#### 目标

收口 `HubRespInbound02Parsed -> HubRespChatProcess03Governed` 的响应侧工具治理、文本工具收割、servertool/stopless/followup judgment。

#### Owner 目标

- Rust owner：
  - `resp_process_stage1_tool_governance.rs`
  - `chat_servertool_orchestration.rs`
  - `servertool-core/**`
- TS 允许：
  - 执行 Rust 产出的 runtime effect
  - 不得决定 servertool/stopless 语义

#### 必收内容

- text tool harvest
- internal tool stripping
- servertool CLI projection / followup judgment
- stopless continuation judgment

#### 必删/必退化内容

- TS response governance branch
- TS followup/stopless judgment
- TS executed-tool semantic repair

#### 关键文件

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/servertool/**`
- Rust servertool-core / chat servertool orchestration modules

#### 验证

- `npm run verify:servertool-rust-only`
- stopless blackbox + focused Rust tests
- old failing samples replay

### M7 `hub.resp_outbound_client_projection`

#### 目标

收口 `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic` 的 client payload projection。

#### Owner 目标

- Rust owner：
  - client projection builders
  - responses/chat projection contracts
- TS 允许：
  - JSON/SSE frame send
  - 不得改 client semantic payload

#### 必收内容

- responses payload projection
- chat client payload projection
- client-visible tool/result payload shaping

#### 必删/必退化内容

- TS 对 projected payload 的语义补丁
- TS 把 response semantic repair 放在 SSE writer

#### 关键文件

- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `src/server/handlers/handler-response-utils.ts`
- Rust client projection functions

#### 验证

- responses/chat projection tests
- architecture gate: SSE transport-only
- live client payload comparison

### M8 `hub.host_adapter_boundary`

#### 目标

把剩余 TS 明确收敛成“非语义宿主边界”，并冻结禁止回长。

#### 宿主边界允许内容

- native binding loader
- JSON stringify/parse wrapper
- N-API required export checks
- Node `Readable` / HTTP / Express / filesystem / child-process IO glue
- 纯 effect executor

#### 禁止内容

- route/tool/servertool/stopless/payload/projection 语义
- 第二份 provider/request/response compat
- metadata/payload 相互污染

#### 关键文件

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts`
- remaining host shells in `src/server/**` / `src/modules/**`

#### 验证

- thin-wrapper-only gate
- forbidden path growth gate
- residue audit

## 9. 每个模块交付任务必须包含的设计字段

后续丢给单任务时，每个任务描述必须完整包含以下字段：

1. `模块 ID`
2. `唯一 owner feature_id`
3. `主线边 / lifecycle 节点`
4. `允许修改路径`
5. `禁止修改路径`
6. `红测目标`
7. `最小验证栈`
8. `旧实现删除清单`
9. `live replay 样本或在线验证入口`
10. `完成标准`

## 10. 任务模板

### 10.1 模块任务模板

```text
任务：收口 <模块 ID>

目标：
- 把 <主线边/语义责任> 收成 Rust-only owner

唯一 owner：
- feature_id: <...>
- owner module: <...>

允许修改路径：
- <path>

禁止修改路径：
- <path>

必须先红：
- <red test / failing sample>

实施要求：
- 只改唯一 owner 与必要桥接
- 不加 fallback / dual-path
- 已迁出的 TS 语义必须物理删除
- function-map / verification-map / mainline-call-map 同步更新

验证：
- <focused rust tests>
- <focused jest/blackbox>
- <architecture gates>
- <live replay>

完成标准：
- Rust 持有该模块业务语义真源
- TS 仅剩 host adapter / native wrapper
- 对应 mainline edge 不再 pending
- 旧 TS 语义已物理删除
```

## 11. 建议的任务拆分批次

### Batch A：主链语义核心

- Task A1: `M2 hub.req_chatprocess_governance`
- Task A2: `M6 hub.resp_chatprocess_governance`

### Batch B：request 主线绑定收口

- Task B1: `M3 hub.route_selection_bridge`
- Task B2: `M4 hub.req_outbound_provider_semantic`

### Batch C：entry/projection 边界补齐

- Task C1: `M1 hub.req_inbound_standardization`
- Task C2: `M5 hub.resp_inbound_parsing`
- Task C3: `M7 hub.resp_outbound_client_projection`

### Batch D：宿主边界冻结

- Task D1: `M8 hub.host_adapter_boundary`

## 12. 最小验证矩阵

每个模块至少跑：

1. 模块 focused Rust tests
2. 模块 focused TS/Jest/blackbox
3. `npm run verify:function-map-compile-gate`
4. `npm run verify:architecture-mainline-call-map`
5. 与模块相关的 architecture gate
6. 旧样本 replay 或 live probe

若改动 request/response 主线强相关模块，再加：

1. `npm run build:min`
2. `npm run verify:architecture-ci`

## 13. 风险与反模式

### 风险

- 只写 Rust helper，不收主线 owner/gate
- 只补测试，不删旧 TS 语义
- 把 host adapter 问题误当成 Hub 语义问题
- 在 SSE/HTTP writer 做语义修补

### 反模式

- “先全量改，最后补 map”
- “这个 TS 先留着以防万一”
- “红测太难，先直接改实现”
- “主线 edge 先 binding pending，后面再说”

## 14. 完成定义（DoD）

当且仅当以下全部成立，才可宣称“HubPipeline 模块化 Rust closeout 完成”：

- 8 个模块全部有唯一 owner/gate/mainline binding
- request/response 主线不再有该范围内 `binding pending`
- Hub 业务语义不再在 TS 内生长
- TS 只剩宿主边界与纯 thin wrapper
- 旧 TS 语义实现已物理删除
- 定向测试、architecture gate、build、必要 live replay 全部有证据
