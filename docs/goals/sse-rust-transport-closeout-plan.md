# SSE Rust Transport Closeout Plan

## 1. 目标与验收标准

### 目标

把 RouteCodex 的 SSE 收口为纯传输独立模块，并把 SSE transport codec / frame IO 主体迁到 Rust 唯一真源；所有 continuation、terminal、tool、required_action、payload normalize 语义都必须先在 JSON 阶段完成：跨协议通用语义归 `chat process`，Responses 私有语义归 `resp_outbound`，SSE 只承载 `json -> sse`。

### 验收标准

1. `handler-response-sse.ts` 与 `responses-sse-bridge.ts` 只保留传输职责：
   - frame write
   - backpressure / timeout / abort / keepalive
   - opaque native state handoff
   - metadata leak guard
   - 独立模块边界，不复用/混入 continuation、tool、terminal、required_action、payload normalize 等语义 owner
2. SSE surface 不得承载以下语义：
   - continuation probe
   - terminal state 判定
   - stream-end repair
   - `required_action` / tool projection
   - apply_patch/custom tool 语义
   - nested response payload normalize
3. Responses SSE transport decode/encode 主 owner 切到 Rust，可从 function-map / source anchor / gate 三处查到。
4. 黑盒对比测试先锁“进入 SSE 之前的语义输出”和“最终 SSE 线级输出”，再在 Rust transport 实现上复现同一外部行为。
5. 接线后通过定向 gate、build、focused tests；若可在线验证，再补旧样本重放。

## 2. 范围与边界

### In Scope

- `/v1/responses` SSE response path
- provider SSE marker/bodyText materialization
- Responses SSE transport decode
- Responses JSON -> SSE transport encode
- client-visible SSE 线级输出
- SSE/continuation/terminal 边界相关 function-map / verification-map / mainline docs

### Out of Scope

- Chat 非 responses 主路径的大规模语义重构
- provider routing / retry / health policy
- 与 SSE 无关的 stopless 语义新增
- 新增 fallback / dual path / compatibility shim

## 3. 设计原则

1. SSE 只做 transport，不做业务语义。
2. SSE 必须是独立模块，不与 continuation lifecycle、response persistence、tool governance owner 混层。
3. continuation / terminal / tool governance / apply_patch / required_action / payload normalize 只允许在 SSE 之前的 JSON owner：
   - 跨协议通用语义 -> `chat process`
   - Responses 私有字段/私有语义 -> `resp_outbound`
   - SSE 不参与这些语义判定，只做 `json -> sse`
4. 黑盒先于实现；没有黑盒对比，不迁 owner。
5. no fallback：迁移期间不保留第二套长期等价逻辑。
6. 物理删除：迁出后旧 TS 语义函数、重复 façade、死 helper 必须删。

## 4. 当前状态摘要

### 已有基础

- provider SSE materialization 已有 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_format_parse.rs`
- 部分 client projection 已有 Rust native export：
  - `projectResponsesClientPayloadForClientNative`
  - `projectResponsesSseFrameForClientNative`
- 静态 gate 已存在：
  - `verify:sse-architecture-boundary`
  - `verify:responses-handler-single-bridge-surface`
  - `verify:responses-sse-business-module`

### 当前 gap

1. `responses-sse-bridge.ts` 已经收窄为 transport facade；不再保留 `normalizeClientVisibleResponsesSseFrameForHttp(...)` 或 `response.required_action` 之类业务语义。
2. `responses-sse-semantics.ts` 当前只剩 transport 规则：keepalive、`response.*` direct passthrough event allowlist、metadata leak sanitize；旧的 terminal/probe/repair/required_action 语义已迁出。
3. `responses-client-projection.ts` 已承接 thin TS client projection shell；真正投影语义走 `projectResponsesSseFrameForClientNative(...)`，owner 仍是 `hub.response_responses_client_projection`。
4. 当前主阻塞收敛到 **SSE closeout 残留**：
   - `handler-response-utils.ts` 仍解析并下发 `sseCloseoutFinishReason`
   - `handler-response-sse.ts` 仍本地维护 stream-end complete log
   - `handler-response-sse.ts` 的 JSON->SSE bridge `end` closeout 仍把 `finishReason` 回传给 `logResponseCompleted(...)`
5. 这说明 SSE 虽然已不再拥有 continuation / required_action / terminal repair 语义，但仍然**感知 closeout 语义**，还没到最终 pure transport 终态。
6. `sharedmodule/llmswitch-core/src/sse/**` 仍是 TS 主实现，不是 Rust transport 真源。
7. function-map / verification-map / static gates 目前锁住的是“不要把旧业务逻辑塞回 SSE”，还没锁到“finish_reason / closeout accounting 必须完全脱离 SSE”。

### 2026-06-23 审计补充结论

已验证：

- `verify:responses-handler-single-bridge-surface` PASS
- `verify:responses-sse-business-module` PASS
- `verify:sse-architecture-boundary` PASS
- `verify:function-map-compile-gate` PASS

但这只能证明“当前 gate 认可现状”，不能证明 “SSE 已经纯 transport 完成”。

当前 closeout 阻塞不是某个 gate 失败，而是 gate 还未覆盖以下残留：

1. `handler-response-utils.ts` 中 `sseCloseoutFinishReason` 的 SSE 专用 closeout 派发。
2. `handler-response-sse.ts` 中 stream-end complete log 仍显式消费 `finishReason`。
3. `handler-response-sse.ts` 中 JSON->SSE bridge `end` closeout 仍向 `logResponseCompleted(...)` 传递 `finishReason`。

因此在这些残留被迁出且由更严格 gate 锁红前，不能按“SSE 已完成”口径提交。

## 5. 技术方案

### Phase A. 锁定功能边界

输出一个明确的功能表，按“transport-only”与“JSON semantic”硬切：

同时锁定阶段边界：SSE surface 必须是单独 owner，不得借 `responses-response-bridge.ts` 或其他 lifecycle facade 继续承载 SSE 语义；所有语义必须先落到 JSON 阶段。

#### A0. 独立模块目标形态

目标形态必须满足：

1. SSE 有单独 owner surface。
2. response lifecycle / continuation lifecycle 与 SSE transport 分层。
3. TS 若保留文件，只允许以下两类：
   - transport shell
   - native binding / opaque adapter

禁止目标形态：

1. 在 `responses-response-bridge.ts` 内继续保留 SSE terminal/probe/repair/projector helper。
2. 在 `handler-response-sse.ts` 内继续保留任何协议语义判断。
3. 在 `responses-sse-semantics.ts` 内继续保留 apply_patch / required_action / nested response normalize / protocol hint 等长期语义 owner。
4. 在 TS `sharedmodule/llmswitch-core/src/sse/**` 内继续保留 decode/encode 主实现但同时宣称 Rust owner。

#### A1. 允许留在 TS transport 的能力

- HTTP header / status / stream writer
- Readable / Transform / PassThrough plumbing
- keepalive comment frame
- client disconnect / abort signal wiring
- metadata leak guard
- opaque native converter / projector 调用

#### A2. 必须迁出 TS 的语义能力

- 旧 `updateResponsesContractProbeFromSseChunkForHttp`（已从 SSE bridge/transport 退役）
- `inspectResponsesTerminalStateFromSseChunkForHttp`
- `planResponsesStreamEndRepairForHttp`
- `required_action` / tool visibility projection
- apply_patch/custom_tool_call projection 与去重状态机
- nested response payload normalize
- 应用强相关 summary / hint / stopless 辅助语义
- Responses SSE native materializer / decode projection 状态机
- TS `responses-json-to-sse-converter.ts` 事件序列化主逻辑

这些能力迁移时必须先判断阶段归属：
- 跨协议通用语义 -> `chat process`
- Responses 私有字段/私有语义 -> `resp_outbound`
- stopless / summary / next-turn hint 这类应用强相关语义 -> 对应应用 owner（例如 stop list / stopless owner），不要塞进 generic bridge
- 只有纯线级转换/写出才允许留在 SSE

当前已确认的真 owner 证据：
- `projectResponsesClientPayloadForClientNative` 已在 `docs/architecture/function-map.yml` / `mainline-call-map.yml` 挂到
  - `feature_id: hub.response_responses_client_projection`
  - `HubRespOutbound04ClientSemantic`
- 因此 `projectResponsesSseFrameForClientForHttp` / `normalizeResponsesSseFrameForClientForHttp` 若仍停在 generic bridge，只能视为晚执行残留，不是缺少 owner。

#### A2.1 当前残留在错误 owner 的函数

当前已确认的残留与错位 owner：

- `src/modules/llmswitch/bridge/responses-stream-semantics.ts` 已退役并物理删除。
  - 旧 `updateResponsesContractProbeFromSseChunkForHttp`
  - 旧 `inspectResponsesTerminalStateFromSseChunkForHttp`
  - 旧 `planResponsesStreamEndRepairForHttp`
- `src/modules/llmswitch/bridge/responses-sse-semantics.ts`
  - `projectResponsesSseFrameForClientForHttp`
  - `normalizeResponsesSseFrameForClientForHttp`
  - apply_patch duplicate suppression state
  - nested response normalize
  - protocol hint / log summary

这说明当前虽然已经把 terminal/probe/repair 从 SSE owner 迁出，但 SSE owner 仍未收口到纯 transport。

#### A2.2 当前残留在 TS SSE codec 的主实现

当前已确认仍在 TS 的主实现：

- `sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts`

这些文件在迁移完成前不能继续被表述为“薄壳”。

#### A3. 功能定位真源

- provider inbound SSE materialization:
  - `hub.response_provider_sse_materialization`
- response-side continuation / terminal truth:
  - `hub.chat_process_responses_continuation`
  - `hub.response_responses_client_projection`
- stage ownership rule:
  - 通用 JSON 语义 -> `chat process`
  - Responses 私有 JSON 语义 -> `resp_outbound`
- SSE transport facade:
  - `server.responses_sse_bridge_surface`

#### A4. 模块边界表

| 模块 | 允许职责 | 禁止职责 | 迁移去向 |
| --- | --- | --- | --- |
| `handler-response-sse.ts` | stream write, flush, keepalive comment, abort/timeout wiring, metadata guard | terminal scan, probe update, continuation close decision, payload/frame semantic normalize | `chat process` / `resp_outbound` / Rust transport owner |
| `responses-sse-bridge.ts` | 单一 facade / binding shell | 协议判定、frame repair、tool projection、JSON/SSE shape 语义 | Rust SSE owner |
| `responses-sse-semantics.ts` | 迁移中短期 SSE 壳层 | apply_patch、required_action、tool projection、nested response normalize、summary/hint/stopless 等应用语义的长期 owner | `chat process` / `resp_outbound` / 应用 owner / Rust response projection owner |
| `responses-stream-semantics.ts` | 已退役并物理删除 | 恢复 TS probe/terminal/repair 真源 | `chat process` / `resp_outbound` / Rust response semantics owner |
| `responses-response-bridge.ts` | response persistence facade, request-context persistence facade | 任何 SSE decode/encode/projection/probe/repair helper | 分拆到独立 SSE module / Rust owner |
| `sharedmodule/.../src/sse/**` | 迁移前短期对照基线；迁移后只允许薄壳或删除 | SSE decode/encode 主实现继续常驻 TS | Rust SSE module |
| Rust SSE owner | SSE parse/materialize/decode/encode/frame write helper 主实现 | lifecycle persistence / route policy / provider retry / terminal decision / tool projection | 保持 Rust 唯一真源 |

### Phase B. 黑盒对比测试

先不改实现，先补黑盒/对比夹具，锁“输入 SSE / 输入 JSON -> 输出客户端可见行为”。

#### B1. 建立对比 fixture 组

至少覆盖 4 类：

1. 正常 transport：
   - `response.output_item.*`
   - `response.completed`
   - `response.done`
2. 语义先成型再进 SSE：
   - `response.required_action`
   - function_call args delta/done
3. apply_patch / custom_tool_call 语义输出：
   - done 去重
   - delta 聚合
4. stream incomplete / missing terminal：
   - provider 提前断流
   - close before completed

#### B2. 对比维度

- client-visible SSE frames
- client-visible JSON payload
- persisted continuation payload
- finish_reason
- required_action / tool call 可见形态
- metadata 不泄漏

#### B2.1 黑盒判定口径

每个 fixture 至少同时锁：

1. 线级输出：
   - event 顺序
   - terminal event 是否存在
   - 是否出现非法业务事件
2. 语义输出：
   - final JSON / final SSE 等价
   - required_action/tool_calls 等价
   - finish_reason 等价
3. 隔离输出：
   - metadata / runtime carrier 不泄漏
   - continuation / terminal / repair truth 不由 SSE surface 决策
   - 通用语义必须能回链到 `chat process`
   - Responses 私有语义必须能回链到 `resp_outbound`
   - stopless / summary / next-turn hint 必须能回链到对应应用 owner，而不是 bridge/SSE

#### B3. 黑盒策略

- “旧 TS 实现当前输出”作为基线 fixture
- Rust 新实现必须 byte-shape / semantic-shape 等价
- 对同一输入同时断言：
  - success path
  - non-terminal path
  - missing-terminal path
  - malformed path

### Phase C. Rust 实现

目标不是继续补 TS wrapper，而是建立独立 Rust SSE transport module 作为唯一主实现；同时把 JSON 语义前移到正确阶段 owner。

#### C1. Rust 模块边界

建议新增或收口到独立 Rust surface，至少包含：

- SSE parse
- Responses SSE -> transport-level frame decode
- Responses canonical JSON -> transport-level SSE encode
- opaque frame IO helper
- metadata-safe frame sanitation

Rust 模块形态要求：

1. 有单独可查询 owner feature。
2. 有 source anchor。
3. 有独立测试入口，不依赖 handler TS 语义 helper 才能验证。
4. TS 接线只调用该模块，不再自己组合第二套 SSE 语义。

#### C2. TS 壳层原则

- TS 只负责把 stream bytes / payload / request context 送入 native
- TS 不解析 `response.*` 事件语义
- TS 不再维护 apply_patch projection state
- TS 不再组装 nested response normalization
- TS 不做 terminal/continuation/incomplete repair 决策
- TS 不做 JSON 语义归属判断；该判断必须在 `chat process` / `resp_outbound` 已完成

#### C3. owner map 收口

实现完成后同步改：

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- 必要的 wiki / manifest

### Phase D. 接线

#### D1. handler 接线

- `handler-response-sse.ts` 只保留 stream transport
- direct passthrough 与 relay reproject 统一走单一 native/opaque facade

#### D2. bridge 接线

- `responses-sse-bridge.ts` 只做 façade/re-export 或直接删并并回唯一 surface
- `responses-response-bridge.ts` 删除 SSE 语义 helper，只保留 continuation persistence facade
- SSE surface 若保留 TS 文件，只允许独立模块壳层；不得继续把 SSE helper 散落到 response lifecycle bridge

#### D2.1 map / gate 同步目标

接线完成后，以下真相必须同步：

1. `server.responses_sse_bridge_surface`
   - summary 改为“独立 SSE transport facade only”
   - required tests/gates 不再把 SSE 语义 helper 合法化
2. `server.responses_response_handler_bridge_surface`
   - 明确 forbidden SSE semantic helpers
3. `sse.responses_decode_projection`
   - owner_module 改到 Rust
4. `sse.responses_encode_projection`
   - owner_module 改到 Rust
5. `sse.codec_registry_surface`
   - 若仍保留 TS registry，只能是 dispatch-only 壳层

#### D3. 物理删除

删除已迁出的 TS 语义函数、重复 façade、死测试 helper、旧 map 声明。

## 6. 文件清单

### 必改

- `src/server/handlers/handler-response-sse.ts`
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_format_parse.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_sse_stream.rs`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`

### 测试 / gate 相关

- `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
- `tests/red-tests/server_responses_sse_business_module_contract.test.ts`
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`
- `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`
- `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`
- `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
- 新增 blackbox fixture suites

## 7. 风险与规避

### 风险 1

TS 和 Rust 行为不一致，造成 client-visible SSE frame 回归。

规避：
- 先固化黑盒 fixture
- 做 old-vs-new 对比测试
- 不允许“看起来差不多”

### 风险 2

迁移时把 continuation/persistence 语义误塞回 SSE handler。

规避：
- 在 function-map 明确禁止路径
- 增 red-test 扫 `handler-response-sse.ts` / `responses-sse-bridge.ts`

### 风险 3

保留双路径，后续继续漂移。

规避：
- 接线后立即删旧 TS 语义函数
- gate 改成 Rust owner 强约束

## 8. 测试计划

### 合同 / 黑盒

1. SSE terminal 正向 / 反向成对测试
2. requires_action continuation 正向 / 反向成对测试
3. apply_patch 投影正向 / 反向成对测试
4. stream incomplete / close-before-terminal 正向 / 反向成对测试
5. metadata boundary / no internal carrier 泄漏测试

### Gate

- `npm run verify:sse-architecture-boundary`
- `npm run verify:responses-handler-single-bridge-surface`
- `npm run verify:responses-sse-business-module`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`

### Build

- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `npm run build:base`

### Live / Replay

如环境允许：

- 重放旧 SSE 问题样本
- 重放 `/v1/responses` requires_action + submit_tool_outputs 样本
- 验证 handler 不再承担 terminal repair / continuation save 决策

## 9.1 下一步红测入口

先从现有测试面扩展，不新造大而空的总集成：

1. `tests/red-tests/server_responses_sse_business_module_contract.test.ts`
   - 当前只锁 `handler-response-sse.ts` 不本地定义若干函数。
   - 下一步必须加断言：
     - `responses-response-bridge.ts` 不再拥有 `inspectResponsesTerminalStateFromSseChunkForHttp`
     - `responses-response-bridge.ts` 不再拥有 `planResponsesStreamEndRepairForHttp`
     - `responses-response-bridge.ts` 不再拥有 `normalizeResponsesSseFrameForClientForHttp`
     - `responses-response-bridge.ts` 不再拥有 `projectResponsesSseFrameForClientForHttp`
     - `responses-response-bridge.ts` 不再拥有 `createResponsesJsonToSseConverterForHttp`
2. `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`
   - 保留为 stream incomplete 黑盒基线。
   - Rust 化后必须证明：终态 repair 决策来自 Rust/semantic owner，不是 SSE handler/bridge 本地 patch。
3. `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`
   - 保留为 `required_action` / tool-call SSE 等价黑盒基线。
4. `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts`
   - 保留为 apply_patch 客户端可见投影黑盒基线。
5. `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
   - 保留为 metadata leak / internal carrier 隔离基线。

## 9.2 下一步 gate 收口入口

1. 扩 `verify-responses-sse-business-module.mjs`
   - 不只检查 `handler-response-sse.ts`。
   - 还要检查 `responses-response-bridge.ts` 不能继续持有 SSE semantic helpers。
2. 更新 `server-responses-sse-bridge-map.md`
   - 把当前 “responses-sse-bridge owns terminal semantics” 改成新目标：
     - SSE 独立模块 owns transport only
     - terminal / continuation / projection semantics 归 Rust owner
3. 收口 function-map / verification-map 文案
   - 不能再把 “responses-sse-bridge owns terminal semantics” 当作合法中间态写进长期文档。

## 9. 实施步骤

1. 先补功能清单与 owner/map 调整草案，明确哪些函数必须迁、哪些只保留 transport。
2. 为 4 类 SSE 行为补黑盒 fixture 与 old-vs-new 对比测试，先红后锁基线。
3. 在 Rust 建立单一 SSE decode/encode/projection surface，并接入现有 native exports。
4. 将 handler / bridge 改为纯 transport façade，只保留 IO 与 guard。
5. 删除旧 TS 语义 helper、重复 façade、死代码。
6. 同步 function-map / verification-map / mainline-call-map / wiki。
7. 跑定向 gates + build + focused tests。
8. 条件允许时重放旧样本，补在线证据。

## 10. 完成定义

1. SSE 所有语义判断都不再位于 `handler-response-sse.ts`、`responses-sse-bridge.ts`、TS `src/sse/**` 主实现。
2. SSE 成为独立模块；不得再借 response lifecycle / continuation bridge 挂载任何 SSE 语义。
3. Rust 成为 SSE decode/encode/projection 唯一 owner；TS 仅 transport wrapper。
4. 黑盒对比测试覆盖 terminal / continuation / apply_patch / incomplete 四类行为。
5. 架构 gate 与 function-map gate 通过。
6. 旧 TS 语义函数已物理删除，无 fallback / dual path 残留。

## 11. 2026-06-23 当前状态校正

### 11.1 已锁住的边界

基于当前仓库与当轮验证，以下状态已经成立：

1. `responses-sse-bridge.ts` 已经是独立 SSE facade。
   - `normalizeClientVisibleResponsesSseFrameForHttp(...)` 只做：
     - frame 解析
     - requestContext tools 读取
     - 调用 Rust `projectResponsesSseFrameForClientNative(...)`
2. `responses-client-projection.ts` 已被物理清空，不再承载 SSE projection owner。
3. `responses-response-bridge.ts` 已不再持有旧的 SSE projector/normalizer helper；它当前仍是 response lifecycle / JSON dispatch owner，不是 SSE semantic owner。
4. 最新边界 gate 现状：
   - `npm run verify:responses-sse-business-module` PASS
   - `npm run verify:responses-handler-single-bridge-surface` PASS

这意味着本计划不应再以“把旧语义补回 SSE”作为任何步骤。

### 11.2 当前真实 gap

当前 gap 已缩到 3 类，而且都不应该通过向 SSE 补逻辑解决：

1. force-SSE JSON -> SSE dispatch plan 不完整
   - 证据：`tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts`
   - 当前失败：返回 `event:error`，`code="sse_bridge_error"`，`message="SSE stream missing from pipeline result"`
   - 当前代码真相：`ensureResponsesJsonToSseRequiredFieldsForHttp(...)` 目前只补 `model`，不足以保证 JSON->SSE converter 所需 canonical Responses shape。
   - owner 判定：这是 JSON->SSE transport input completeness 问题，不是 SSE 业务语义问题。

2. Rust 对 nested `response.required_action` 的 Responses 私有投影还不完整
   - 证据：同一 apply_patch blackbox 仍泄漏 `response.required_action` 和 `{\"patch\":...}` 包装。
   - 当前代码真相：`build_standard_tool_call_sse_frames_from_required_action_payload(...)` 只读取 top-level `required_action`，没覆盖 `response.required_action` nested case。
   - owner 判定：这是 `resp_outbound` / Rust client projection owner 的缺口，不是 SSE owner。

3. terminal repair / closeout owner 还未完全前移到非-SSE 语义层
   - 证据：`tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts` 仍红。
   - 当前失败：
     - upstream 缺 `response.done` 时，没有补出 `response.done`
     - upstream 只给 required_action 时，没有补出 `response.completed` / `response.done`
   - owner 判定：
     - `response.completed / response.done / required_action` 这类客户端可见响应语义，更像 `hub.response_responses_client_projection` 与 `responses.continuation.mainline` 的 `ChatProcRespContinuation06ResponseGoverned -> ChatProcRespContinuation07CanonicalSaved` 边，必须在 `HubRespOutbound04ClientSemantic` 之前完成。
     - `finish_reason / release / closeout logging` 更像 `hub.metadata_center_mainline` 的 `MetaResp06ResponseObserved -> MetaResp08CloseoutReleased` closeout 边。
     - 这两类都不是 SSE owner，不能把 repair 逻辑塞回 `handler-response-sse.ts` 或 SSE bridge。

### 11.3 更新后的执行顺序

严格按 Jason 锁定的顺序执行：

1. 锁边界
   - 保持当前 transport-only gate 为绿
   - 扩 gate，防止 `responses-response-bridge.ts`、`responses-sse-bridge.ts`、`handler-response-sse.ts` 再长出业务语义
2. 黑盒对比
   - 先锁 `force-SSE JSON->SSE`
   - 再锁 nested `response.required_action`
   - 再锁 terminal repair
3. Rust 实现
   - 在 Rust `hub.response_responses_client_projection` / 相邻 owner 里完成 nested required_action 与 terminal truth 收口
   - JSON->SSE 输入完整性若需 builder 收口，优先收口到 JSON dispatch owner，不进 SSE
4. 接线
   - TS 只保留 transport facade / native binding
   - 删除迁移后重复 helper 与过时文案

### 11.4 本轮建议的最小落点

按最小风险顺序：

1. 先修 `prepareResponsesJsonSseDispatchPlanForHttp(...)` 的 canonical input completeness，让 force-SSE JSON blackbox 先回绿。
2. 再修 Rust `project_responses_sse_frame_for_client(...)` 对 nested `response.required_action` 的标准 tool SSE normalize。
3. 最后把两类非-SSE owner 分开锁死：
   - 响应语义收口：`response.completed / response.done / required_action`
   - closeout 派生收口：`finish_reason / release / logging`
