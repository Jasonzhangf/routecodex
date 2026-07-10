# Apply Patch Direct/Relay Full Audit Plan

Last updated: 2026-06-15

## 0. 当前结论快照

- `5520` 当前仍是 same-protocol direct。live 证据持续显示 `route=router-direct:*` 与 `router-direct.send`/`[usage] route=router-direct:*` 成对出现；因此 `5520` 上的 `apply_patch` 问题必须优先归到 Rust request contract、Rust response outbound replay-safe sanitize、或 direct SSE 协议边界，不能先怀疑 relay。
- `5555` 当前不是“纯 relay”也不是“纯 direct”。更准确的真相是：前段经过 relay handler/bridge/store 语义，最终 provider transport 可能仍以 `router-direct.send` 发出；所以 `5555` 的历史污染完全可能在 relay 前段形成，再由 direct final send 原样送上游。
- `apply_patch` 当前已重新通过 broad Rust 回归：`cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture` => `95 passed, 1 ignored`。这验证了两条本轮最关键收口：
  - request-side 顶层治理不再把 client-visible `apply_patch` contract 改写成自定义 grammar；
  - response-side legacy `@@ -n +m @@` hunk 只有在 inline context trailer 存在或真实 live-context 重建成功时才会收敛成可执行 `@@` 头。
- `4444` 当前最新 live 问题不要再混进 apply_patch 审计。`~/.rcc/logs/server-4444.log` 最新失败 `openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101` 已是 `MALFORMED_RESPONSE`：`[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`。这应归到 provider malformed Anthropic payload 解析/投影链，不再等同于早前的 `hub_pipeline_resp_anthropic_chat_canonicalize_failed`。
- `4444` 还要再细分成两类，不可混写：
  - `openai-responses-halphen.key1-glm-5.2-20260615T222217502-349516-2793`：`[convert.bridge] Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`
  - `openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101`：`MALFORMED_RESPONSE`
  结论：`4444` 当前是 provider/Anthropic-response 投影问题簇，不属于本轮 `apply_patch direct/relay` 主审计面。
- `4444` 的前一类现在还能精确绑定到 Rust owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)` 在 `provider_format=anthropic-messages` 且 `clientProtocol=openai-chat|openai-responses` 时会调用 `hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs::build_openai_chat_response_from_anthropic_message(...)`；真正抛出 `Anthropic SSE response did not contain materializable content blocks` 的是同文件 `materialize_anthropic_message_payload(...)`。因此这条 live 错误当前应归类为 `hub.response_anthropic_client_projection` / provider malformed stream 证据，而不是 apply_patch 审计的旁证。
- 当前审计已足以指导下一轮实现的唯一 owner 顺序：
  1. `hub.response_responses_client_projection`
  2. `responses-continuation-store` + `shared_responses_conversation_utils.rs`
  3. `hub.req_inbound_responses_context_capture`
  4. `hub_bridge_actions/history.rs` / `bridge_input.rs`
- 2026-06-16 focused gate bundle 复跑：
  - PASS:
    - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
    - `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`
    - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts`
    - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - FAIL:
    - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`
    - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
  - 结论：
    - `apply_patch` 基础 request contract、direct provider passthrough、direct SSE metadata allowlist、relay anthropic tool-history 基线都已在 focused gate 转绿
    - 当前剩余主红面集中在 handler-level SSE terminal/error 投影与 route-level direct 合同总黑盒，不是 `apply_patch` 自身 freeform contract 再次失守

## 1. 目标与验收标准

目标：
- 完整审计 `apply_patch` 在 `5520 direct` 与 `5555 relay` 两条链路中的请求、存储、恢复、续接、提示与错误投影行为，找出唯一 owner、真实改形点、样本对应代码落点、以及测试/gate 缺口。

验收标准：
- 明确区分 `5520 direct` 与 `5555 relay` 的实际运行链路。
- 明确列出 `apply_patch` 与 `exec_command` 在每条链路上是否被触碰、由谁触碰、如何触碰。
- 明确列出“请求参数形状、tool output 存储、resume/history 恢复、canonical guidance、SSE/response 投影”各自 owner。
- 给出真实样本 -> 代码文件 -> 风险 -> 缺口 gate/test 的一一映射。
- 给出后续修复顺序，但本轮默认以审计为主，不混入无证据修复。

## 2. 范围与边界

In Scope:
- `5555` `/v1/responses` 实际 relay 通路。
- `5520` `/v1/responses` 实际 direct 通路。
- `apply_patch` 请求参数、tool output、conversation store、continuation/resume、response projection、SSE。
- 与 `apply_patch` 强耦合的 `exec_command` / `function_call_output` / `tool_result` 邻接语义。
- live 日志、真实样本、现有 red/green tests、function map / verification map。

Out of Scope:
- 本轮不做大面积修复，不做无证据架构迁移。
- 不顺手修改无关 provider/runtime 行为。
- 不把 direct 与 relay 重新设计成新流程；只审当前真相。

## 3. 设计原则

- 单一路径真源：`HTTP -> bridge / hub pipeline -> provider/runtime -> upstream`。
- direct 与 relay 分开审，不混推理。
- 不接受“可能是这里”；每条结论必须有文件/日志/样本证据。
- 不做 fallback 分析，不以 fallback 解释现象。
- 审计先于修复；没有 owner 与边界图，不进入实现。

## 4. 技术方案（文件清单）

### A. 5520 direct 审计

目标：
- 确认 same-protocol direct 下，`apply_patch/exec_command` 是否仍被 request/response bridge、conversation restore、tool cleanup、history normalization 触碰。

关键文件：
- `src/server/runtime/http-server/index.ts`
- `src/server/runtime/http-server/router-direct-pipeline.ts`
- `src/server/runtime/http-server/provider-direct-pipeline.ts`
- `src/server/runtime/http-server/direct-passthrough-payload.ts`
- `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
- `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`

输出：
- direct 路径触碰矩阵：入口、请求改写、响应改写、resume、tool history、错误投影。

### B. 5555 relay 审计

目标：
- 审计 relay `responses` handler 到 request/response bridge 的完整处理链，确认 `apply_patch` 在哪里被标准化、存储、恢复、重投影。

关键文件：
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- `src/modules/llmswitch/bridge/runtime-integrations.ts`
- `sharedmodule/llmswitch-core/src/shared/responses-conversation-store.ts`
- `tests/modules/llmswitch/bridge/*.spec.ts`
- `tests/server/handlers/*.responses*.spec.ts`

输出：
- relay 路径的 request-side / response-side / continuation owner 图。

### C. Rust inbound / apply_patch owner 审计

目标：
- 明确 Rust 请求侧 owner 是否对 `apply_patch` 做了参数保留、output transcript 去壳、canonical compare、duplicate rewrite、tool history filter 等动作。

关键文件：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_output_snapshot.rs`

输出：
- Rust owner 行为表：保留、清洗、标准化、比较、重写、报错。

### D. 样本与 gate 审计

目标：
- 将真实样本、现有 red test、existing gate 一一对齐，找出缺口。

关键文件：
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/goals/apply-patch-failure-guidance-and-history-retention-plan.md`
- `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
- `sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs`
- `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
- `tests/server/handlers/responses-handler*.spec.ts`

输出：
- “已有 gate 能锁什么 / 锁不住什么”表。

## 5. 风险与规避

风险：
- direct / relay 混看导致错误归因。
- 看到 `apply_patch` 失败就误判为参数包装问题，忽略 store/resume/history 污染。
- 只看单测，不重放 live 日志样本。
- 把模型 commentary 当成真实 tool transport。

规避：
- 每条样本先判 `port + route + direct/relay`。
- 每条结论必须附文件路径和日志/样本。
- 审计结果单列“transport 问题 / shape 问题 / persistence 问题 / projection 问题”。

## 6. 测试计划

读证据：
- `~/.rcc/logs/server-5520.log`
- `~/.rcc/logs/server-5555.log`
- `~/.codex/sessions/2026/06/14/*.jsonl`

定向 gates：
- `pnpm jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`
- `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs`
- `pnpm jest tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand`
- `pnpm jest tests/server/handlers/responses-handler*.spec.ts --runInBand`

live 证据：
- 5520 与 5555 各抽一条 `apply_patch` 或 tool-heavy `/v1/responses` 样本。
- 从日志确认其 route、finish_reason、是否 direct/relay。

证据等级说明：
- `5520` 的 S1 / S1b 当前仍可直接从 `~/.rcc/logs/server-5520.log` 读取 live log 片段。
- `5555` 的 S2 / S3 / S4 / S5 等经典历史 requestId，当前已经不在现行 `~/.rcc/logs/server-5555.log` 中。
- 因此这些 `5555` 历史失败样本的 authoritative 证据当前应以 `~/.rcc/diag/error-*.json` 为主；现行日志只用于证明“5555 仍是 relay 前段 + final direct send 的混合结构”，不能再拿来冒充旧 requestId 本人的 live log 证据。

## 7. 实施步骤

1. 先从 live 日志确认 `5520` 与 `5555` 各自实际 direct/relay 真相。
2. 审 `5520 direct` owner 链，标出任何会触碰 `apply_patch/exec_command` 的点。
3. 审 `5555 relay` request bridge。
4. 审 `5555 relay` response bridge / SSE / continuation。
5. 审 Rust inbound owner 对 `apply_patch` 的保留/清洗/比较。
6. 整理真实样本 -> 文件落点 -> 风险。
7. 对照 function map / verification map，列缺口。
8. 输出审计结论与修复顺序，不混入未验证实现。

## 8. 完成定义（DoD）

- 有一份清晰的 direct/relay 分链审计结论。
- 有 owner 清单、样本映射、风险列表、gate 缺口列表。
- 能回答以下问题且每个回答都有证据：
  - 5555 为什么是 relay？
  - 5520 为什么仍可能出 `apply_patch` 问题？
  - `apply_patch` 参数、输出、恢复分别在哪里被改动？
  - 哪些问题是 transport，哪些是 history/store/projection？
  - 下一步修复该先改哪个唯一 owner？

## 9. 已确认样本映射

### 9.1 Owner 清单：参数 / 输出 / 恢复 / 存储 / SSE 各归谁

| 语义面 | `5520 direct` owner | `5555 relay` owner | 备注 / 边界 |
| --- | --- | --- | --- |
| `apply_patch` 请求工具声明 / 参数合同 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs` | 同 owner；relay request bridge 只能调用 native，不得本地重写 | 当前已证实 prod request 路径必须产出 `custom + grammar + lark` |
| `apply_patch` 文本参数/壳层提取、tool output canonical guidance | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs` | 同 owner | 这里负责从 shell-wrapped canonical patch / raw tool output 中做形状规范化，不负责 provider send |
| request-side tool history 捕获、重复 batch / orphan 判定 | direct 正常不该命中 relay capture；若命中则属设计越界 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs` | `5555` 的 S2/S3 主责都在这里及其桥接 action，而不在 handler |
| relay request history -> provider chat/responses 投影 | N/A | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs` + `hub_bridge_actions/bridge_input.rs` | 这是 `5555` 2013/tool-order 问题的主 owner |
| client-visible `/v1/responses` JSON/SSE replay-safe 输出 | direct 也必须经过同一 Rust owner；TS 不得 short-circuit | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs` + `client_tool_args.rs` | 负责剥离 `reasoning.content`、item-level `status`、internal stopless/servertool CLI artifacts |
| relay 本地 continuation store / scope materialize | direct remote continuation 不应本地恢复 | `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` | 只允许 relay 本地 store；direct 只能 remote continuation |
| persisted history item 合法化 / response->input 归一化 | direct replay incoming 也会消费它 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs` | 负责 `output_text/commentary -> input_text`、剥离 response-only `status`、裁掉非法 replay 字段 |
| direct SSE 事件 allowlist / metadata boundary | `src/modules/llmswitch/bridge/responses-response-bridge.ts` + `src/server/handlers/handler-response-sse.ts` | relay 仍经同一 handler 出口，但 `event: response.metadata` 这类 live 样本只在 direct passthrough 语义下成立 | `responses-sse-bridge.ts` 只是 facade，不是第二语义 owner |
| handler / bridge facade | `src/server/runtime/http-server/*direct*` / `src/providers/core/runtime/responses-provider.ts` | `src/modules/llmswitch/bridge/responses-request-bridge.ts` + `responses-response-bridge.ts` + `runtime-integrations.ts` | 这些层都不是 `apply_patch` 语义 owner；只能调用 native / lifecycle glue |

### 9.1a source-level 函数链证据：`5520 direct` vs `5555 relay`

- `5520 direct` request 入口
  - `src/server/runtime/http-server/index.ts`
    - 先取 `rawDirectPayload = requireDirectPassthroughPayloadObject(input.body)`
    - 再直接令 `requestPayload = rawDirectPayload`
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
    - `executeRouterDirectPipeline(...)` 真正发的是 `requestPayload`
    - `recordPayloadAudit(...)` 只记录 `model/reasoning/thinking/max_tokens`
    - `payloadToSend = recordPayloadAudit(input.requestPayload, auditContext)` 后原样进 `providerHandle.instance.processIncomingDirect(...)`
  - 结论：
    - direct route owner 只做 passthrough + audit
    - 不读取 `providerPayload` 重新组装，不修 `input/history/tools`

- `5520 direct` provider 侧 responses passthrough
  - `src/providers/core/runtime/responses-provider.ts`
    - `processIncomingDirect(...)` 是 direct send 入口
    - request-side direct contract 依赖 `responses.direct_tool_shape_contract`
    - 本文件当前保留的是 transport/SSE 处理与 upstream error 归一，不承担历史/tool 语义修补
  - 结论：
    - direct provider runtime 不是 `apply_patch`/history 的 owner
    - 它只证明“最后一跳确实是 same-protocol send”

- `5555 relay` request 入口
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `prepareResponsesHandlerRuntimeForHttp(...)`
      - 先 `prepareResponsesHandlerEntryForHttp(...)`
      - 再 `buildResponsesRequestContextForHttp(...)`
    - `buildResponsesRequestContextForHttp(...)`
      - 直接调用 `captureReqInboundResponsesContextSnapshot(...)`
    - `prepareResponsesHandlerEntryForHttp(...)`
      - `submit_tool_outputs` 走 `lookupResponsesContinuationByResponseId(...)` / `resumeResponsesConversation(...)`
      - scope materialize 走 `materializeLatestResponsesContinuationByScope(...)`
  - 结论：
    - `5555` 入口并不是“直接把 client body 发 provider”
    - 它先过 relay request bridge + native capture + continuation owner 判断

- `5555 relay` response/store 入口
  - `src/server/handlers/handler-response-utils.ts`
    - JSON path 先 `prepareResponsesJsonClientDispatchPlanForHttp(...)`
    - 再 `normalizeResponsesClientPayloadForHttp(...)`
    - 然后把 `sanitized` 传给 `persistResponsesConversationLifecycleForHttp(...)`
  - `src/server/handlers/handler-response-sse.ts`
    - SSE path 聚合 `contractProbe.probe`
    - `persistNativeSseConversationState()` 把 `stripInternalKeysDeep(contractProbe.probe)` 传给 `persistResponsesConversationLifecycleForHttp(...)`
    - 若 `isDirectPassthrough`，这里显式 `sse.persist.skip.direct_passthrough`
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `persistResponsesConversationLifecycleForHttp(...)`
      - tool-continuation / `finish_reason=tool_calls` 才 record
      - 实际落库通过 `recordResponsesResponseForHttpProjection(...) -> recordResponsesResponseForRequest(...)`
      - `continuationOwner` 来自参数，默认由 `metadata.__routecodexDirectPassthrough === true ? 'direct' : 'relay'` 推导
  - 结论：
    - `5555` 的 replay/history 污染闭环是“client projection 后的 body/probe -> persist facade -> store”
    - 不是 provider raw response 直接落库

- relay store 隔离与 direct 不落本地
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - `shouldPersistLocally(entry) { return normalizeContinuationOwner(entry.continuationOwner) !== 'direct'; }`
    - `recordResponse(...)` 内部 `entry.continuationOwner = ... ?? 'relay'`
    - `flushPersistence()` / `ensurePersistenceLoaded()` 都受 `shouldPersistLocally(entry)` 约束
  - 结论：
    - direct continuation 明确不进本地 persisted store
    - relay 才能形成本地 history 污染并在后续重放

- S6 native capture 壳层真实导出面
  - `src/modules/llmswitch/bridge/native-exports.ts`
    - sync facade: `captureReqInboundResponsesContextSnapshotJson(...)`
    - async facade: `captureReqInboundResponsesContextSnapshot(...)`
    - 两者最终都调用同一个 native binding：
      - `mod.captureReqInboundResponsesContextSnapshotWithNative`
  - 结论：
    - S6 历史“required but unavailable”不能粗暴归类成“JS facade 没导出”
    - 更符合当前源码真相的是：binding 可见，但 live 某条请求在 native owner 内部 fail-fast 后被外层包装成 unavailable

### 9.4 `5555` 为什么是 relay：不是一句话，而是一条 owner 链

- request-side handler bridge 入口：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - handler-facing canonical builder：
    - `buildResponsesRequestContextForHttp(...)`
    - `prepareResponsesHandlerRuntimeForHttp(...)`
    - `buildResponsesPipelineMetadataForHttp(...)`
  - 这里会把 `/v1/responses` 请求送入：
    - `captureReqInboundResponsesContextSnapshot(...)`
    - `resumeResponsesConversation(...)`
    - `materializeLatestResponsesContinuationByScope(...)`
- relay local continuation/store owner：
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - 当前本地持久化/恢复真入口：
    - `recordResponse(...)`
    - `resumeConversationPayload(...)`
    - `materializeContinuationPayload(...)`
    - `restoreContinuationPayload(...)`
  - 关键隔离真相：
    - `shouldPersistLocally(entry)` 明确 `continuationOwner=direct` 不落本地
    - 只有 relay/local continuation 才进入本地 store
- response-side handler bridge 入口：
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - handler-facing canonical builder：
    - `recordResponsesResponseForHttpProjection(...)`
    - `persistResponsesConversationLifecycleForHttp(...)`
    - `createResponsesJsonToSseConverterForHttp()`
- 当前 live 结构证据：
  - 现行 `~/.rcc/logs/server-5555.log` 仍可直接看到：
    - `[port:5555 ...] ▶ [/v1/responses] ...`
    - `[port:5555 ...] [virtual-router-hit] ...`
  - 这说明 `5555` 入口仍然先经过 router/handler/bridge 语义层，而不是 provider port 的裸 direct passthrough
  - 与此同时，历史样本和现有设计都允许最终 provider send 仍显示 `router-direct.send`
- 审计结论：
  - `5555` 之所以必须归类为 relay，不是因为“最后没有 direct send”
  - 而是因为：
    - request-side context capture / continuation restore / local store / response-side persistence 这些 owner 明确先发生了
    - final provider transport 是否 same-protocol direct，只是 relay 之后的最后一跳实现方式
  - 因此 `5555` 的历史污染、duplicate batch、response replay-safe 问题，都必须优先归到 relay 前段 owner，而不是把末跳 `router-direct.send` 当成主责

### 9.5 重复 SSE facade 的当前 gate 真相

- 当前文件事实：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
    - 几乎整面 re-export `responses-response-bridge.ts` 的 SSE/projector/guard symbols
    - 当前是 facade-only public surface，不是第二套独立语义实现
  - `src/modules/llmswitch/bridge/index.ts`
    - 仍分别 re-export
      - `responses-sse-bridge.ts`
      - `responses-response-bridge.ts`
- 当前 gate 事实：
  - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
    - 不是在锁“唯一 SSE 语义 owner”
    - 它实际锁的是：
      - `handler-response-sse.ts` 必须继续同时 import `responses-sse-bridge.js` 与 `responses-response-bridge.js`
      - `handler-response-utils.ts` 也必须继续保持 split import
      - `index.ts` 不要把 SSE symbols 混进 lifecycle bridge export 段
  - `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
    - 也明确要求
      - `responses-handler.ts` 只能走 request facade
      - `handler-response-utils.ts` 只能走 response facade
      - 但同时又要求 SSE facade 相关 imports 继续存在
- 审计结论：
  - 当前仓库里的 gate 保护的是“split facade 结构不继续失控”，不是“出口已经唯一化”
  - 因而 `responses-sse-bridge.ts` 虽然是 duplicate facade / delete candidate，但现在不能直接删
  - 若后续要物理删除：
    1. 先改 function-map / verification-map 对 `server.responses_sse_bridge_surface` 的定义
    2. 再改 `server_responses_sse_surface_single_owner` 红测与 `verify-responses-handler-single-bridge-surface.mjs`
    3. 最后才能删 facade 本体
  - 2026-06-16 代码级补强：
    - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
      - 当前是整面 `...Impl` re-export facade，几乎所有 SSE/projector/guard symbol 都直接从 `responses-response-bridge.ts` 转发
      - 它不是第二套 SSE 语义 owner，而是 public surface duplicate
    - `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
      - 当前 verify 不是在锁“唯一 owner”
      - 它实际锁的是：
        - `responses-handler.ts` 继续只走 request facade
        - `handler-response-utils.ts` 继续只走 response facade
        - 同时 `handler-response-sse.ts` / `handler-response-utils.ts` 必须保留 split imports
      - 这再次证明当前 gate 真相是“保护 split facade 结构”，不是“已经唯一出口”

### 9.2 当前 gate 状态校正

- `tool.apply_patch_freeform_contract`
  - 2026-06-16 当前已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:apply-patch-freeform-contract`
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:apply-patch-regressions`
  - 新证据表明这里不再只是“文档说应为 freeform”，而是 prod request path 已被红测锁到实际 `custom/lark`。

- `responses-continuation-store`
  - 2026-06-16 当前已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
    - 结果：`33 passed, 33 total`
  - 这轮把它从“有 4 条失败、不能直接当可信 gate”推进成“现在可直接作为 replay-safe persistence / owner ambiguity gate”。
  - 真实业务修复只有一条：
    - `materializeLatestContinuationByScope()` 在未显式指定 owner 时，若同 scope 同时命中 direct/relay，必须 fail-fast 返回 `null`
  - 另外 3 条失败都已证实只是旧 fixture 漂移，并已对齐当前 replay-safe 合同：
    - assistant 历史消息落库后为 `input_text`
    - standalone reasoning 只保留合法 `summary/encrypted_content`
    - reopen 后的 assistant 历史消息不再期待 `output_text`

- direct SSE `response.metadata`
  - 2026-06-16 bridge-level gate 已按 live 行为更新并转绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand`
    - 结果：`4/4 PASS`
  - 结论更新：
    - bridge-level allowlist 允许 live `event: response.metadata` 普通 provider metadata 样本
    - 同名事件或其他 Responses SSE frame 只要携带 `providerKey` / `__rt` / `__routecodex*` 内部字段，仍必须 fail-fast
    - 仍未补 handler-level 黑盒总 gate；而且当前黑盒总 gate 真实仍红，不是“毫无覆盖”，而是“窄 gate 绿、总 contract 仍坏”

- handler-level SSE blackbox 总 gate
  - 2026-06-16 当前仍红：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts --runInBand`
    - 结果：`2 failed / 7 passed / 9 total`
  - 红点 1：
    - `captures required_action -> completed -> done for tool-call continuation without hanging the client`
    - 当前仍是 5s test timeout，没有完成 terminal closeout
  - 红点 2：
    - `turns early upstream close into explicit error instead of client hang`
    - 实际 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event: error`
  - 代码级证据：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts::planResponsesStreamEndRepairForHttp(...)` 明确区分：
      - tool continuation -> `shouldRepairContinuationTerminal`
      - 非 continuation 提前关流 -> `shouldProjectIncompleteError`
    - `src/server/handlers/handler-response-sse.ts` 当前在 `finalStreamEndRepairPlan.shouldProjectIncompleteError` 分支里只记内部日志与 snapshot：
      - `logPipelineStage('response.sse.stream.incomplete_internal_error', ...)`
      - `clientErrorSuppressed: true`
      - 然后 `res.end()`
    - 这解释了为什么黑盒看到“内部识别 incomplete，但客户端拿不到 `event:error`”

- stopless NoSchema / no-reenter / route-hint focused gates
  - 2026-06-16 当前已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stopless-vr-route-hint.spec.ts tests/servertool/stop-message-auto-no-reenter.red.spec.ts --runInBand`
    - 结果：`3 suites / 9 tests PASS`
  - 当前能直接锁住的事实：
    - `NoSchema` 不是“无 schema stop 合同”；CLI stdout 必须带 `schemaGuidance.requiredFields=["stopreason","next_step"]`
    - same-session progression 当前真实经过 CLI wrapper 持久化路径，实跑 console 证据已出现 `used=0 -> 1 -> 2`，测试同时锁 `repeatCount 1 -> 2 -> 3`
    - `stop_message_auto` CLI projection 不得调用 `reenterPipeline`
    - stopless followup 归一后不得再带 `route_hint:tools`
  - 代码 / map 锚点：
    - `docs/architecture/function-map.yml` `feature_id: hub.servertool_stopless_cli_continuation`
    - `docs/architecture/verification-map.yml` 同名 feature
    - `tests/servertool/stopless-cli-continuation.spec.ts`
    - `tests/servertool/stopless-vr-route-hint.spec.ts`
    - `tests/servertool/stop-message-auto-no-reenter.red.spec.ts`
  - 审计结论：
    - 这组 focused gate 现在足以证明 stopless core 合同已经收口到 CLI continuation，而不是旧 reenter 流
    - 因而后续 live 若再出现 “NoSchema 不计数 / followup 仍走 tools/search / reenter” 一类现象，应优先排查 handler/transport/install-state，而不是先怀疑 stopless core owner

- direct provider passthrough contract
  - 2026-06-16 当前已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/providers/runtime/responses-provider.direct-passthrough.spec.ts --runInBand`
    - 结果：`12/12 PASS`
  - 当前能直接证明：
    - direct provider path 发送的是当前 request body 本身，不读取 `metadata.__raw_request_body`
    - reasoning item 在 direct provider path 上不会被 provider runtime 本地清洗
    - `previous_response_id` / `tools` / `instructions` / `prompt_cache_key` 会原样跟随 direct payload 发往上游
    - direct `submit_tool_outputs` 会命中 upstream `/responses/{id}/submit_tool_outputs`
  - 这条证据强化了 `responses.direct_tool_shape_contract` 的核心结论：
    - direct/provider runtime 自身不是 `5520` apply_patch 问题的“修补 owner”
    - `5520` 上看到的 apply_patch 400 更可能来自：
      - Rust request contract
      - upstream 真实拒绝
      - 或 direct response/SSE 协议边界

- direct route-level blackbox
  - 2026-06-16 当前实跑仍红：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand`
    - 结果：`18 total / 13 pass / 5 fail`
  - 与本审计直接相关的红点：
    - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
      - 预期 `model: gpt-5.3-codex`
      - 实际发出 `model: mutated-model`
      - 这说明 route-level suite 对 “transparent” 的定义，当前仍和真实 direct 行为存在差异
      - 代码级证据：
        - `src/server/runtime/http-server/index.ts`
          - `const rawDirectPayload = requireDirectPassthroughPayloadObject(input.body);`
          - `const requestPayload = rawDirectPayload;`
        - `src/server/runtime/http-server/router-direct-pipeline.ts`
          - `recordPayloadAudit(...)` 只记录 `model/reasoning/thinking/max_tokens` 到 auditContext，不改 payload
        - `docs/architecture/function-map.yml`
          - `feature_id: responses.direct_tool_shape_contract`
          - 明确写的是 “keep the current request body as provider wire”
      - 因而这条红点当前更像：
        - route-level 测试仍期待 model 被改写成 `target.modelId`
        - 但当前 direct contract / 代码真相是保留 ingress body 的 `model`
      - 这应先记为“测试预期与当前 contract 的差异”，不能直接当成 direct 主链回归
  - 与本审计弱相关或旁支的红点：
    - `provider-mode chat direct does not synthesize stream=true when stream_options is present`
    - `router same-protocol direct relays stop_message followup through Hub before direct send`
    - `router-direct switches provider request-locally on recoverable 429 without entering relay`
    - `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
  - 审计解释：
    - 这组失败不能直接说明 `5520` apply_patch 合同坏了。
    - 但它能证明：
      - direct route-level 总黑盒当前不是“全绿可直接背书”
      - 其中至少有一条与 ingress payload transparency 的定义差异直接相关，后续若用这组集成黑盒给 `5520 direct` 背书，必须显式写清哪些 case 是旁支、哪些 case 是主线

### 9.3 Codex session 原始样本真相

- 已直接读取：
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl`
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`
- 原始 tool transport 形状结论：
  - Codex session 原始 JSONL 内就是标准 `response_item(function_call)` / `response_item(function_call_output)`。
  - 没有额外 Anthropic `tool_use` / `tool_result` 包装层。
- 与 S2 直接对齐的索引级证据：
  - `rollout-2026-06-14T15-20-20-...073a.jsonl`
  - `IDX 41`: `function_call call_itUphzwyXqmB1L3pGk03AQHh`
  - `IDX 42`: 同一 `call_id` 的第二次 `function_call`
  - `IDX 43`: `function_call_output call_itUphzwyXqmB1L3pGk03AQHh`
  - `IDX 44`: 同一 `call_id` 的第二次 `function_call_output`
- 审计结论：
  - duplicate same-call batch 并不是 RouteCodex handler/server 凭空造出来的。
  - 它在 Codex session 原始 JSONL 中就存在。
  - 因而 `5555 relay` 的 owner 责任应定义为：
    - Rust req_inbound capture / history projection 如何对 duplicate same-call batch、duplicate batch、already-consumed queue 做 collapse / preserve / fail-fast。
  - 不是“TS handler 先把一条正常单轮 tool call 改坏”。

### 9.0 快速总表：真实样本 -> 代码文件 -> 风险 -> gate 缺口

| Sample | Port / route / final send truth | terminal truth | 真实问题阶段 | 唯一 owner | 风险 | 当前 gate 缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 `...230414428-345124-2702` | `5520` / `thinking` / final send=`router-direct.send` | upstream HTTP 400，本地 pre-terminal fail，无 client `finish_reason` | direct request tool contract | `req_process_stage1_tool_governance_blocks/orchestrator.rs` | `apply_patch` grammar 非法，upstream 直接 400 | 已基本锁住；当前不是主要缺口 |
| S1b `...193814122-348189-1466` | `5520` / `coding` / final send=`router-direct` SSE | stream error before `response.completed` / `response.done` | direct SSE event boundary | `src/modules/llmswitch/bridge/responses-response-bridge.ts` + `src/server/handlers/handler-response-sse.ts` | upstream 非法 `event: response.metadata` 直接打断 SSE | 缺精确 live 红测锁 `event: response.metadata` |
| S2 `...223253714-340912-698` | `5555` / `tools` / no `router-direct.send` evidence | upstream HTTP 400，本地 pre-terminal fail，无 client `finish_reason` | relay request history -> upstream chat projection | `hub_bridge_actions/history.rs` + `hub_bridge_actions/bridge_input.rs` | Anthropic/MiniMax 2013，tool call/result 顺序被投影坏 | 缺直接绑定 live 样本的 fixture；现有黑盒只锁近似形状 |
| S3 `...231359101-341020-806` | `5555` / `search` / provider send 前本地失败 | local fail-fast，无 provider terminal，无 client `finish_reason` | relay req_inbound capture | `hub_req_inbound_context_capture.rs` | `orphan_tool_result` 本地 fail-fast，工具历史无法进入上游 | 缺 live search continuation 级 fixture |
| S4 `...180749445-347851-1128` | `5555` / relay 前段 + final send=`router-direct.send` | upstream HTTP 400，本地 pre-terminal fail，无 client `finish_reason` | response outbound / replayed history preserve | `client_tool_args.rs` + `shared_responses_conversation_utils.rs` | internal stopless CLI / `status` 进入下一轮 `/v1/responses` history，upstream 400 | 之前缺 replay-safe response outbound gate；本轮已补 Rust owner 清理与 gate，但 relay store 闭环总 gate 仍有缺口 |
| S5 `...173500530-347752-1029` / `...202830407-348488-1765` | `5555` / relay 前段 + final send may be `router-direct.send` | upstream HTTP 400，本地 pre-terminal fail，无 client `finish_reason` | old polluted response history re-emitted later | `responses_payload.rs` + `responses-conversation-store.ts` + `shared_responses_conversation_utils.rs` | 非法 `reasoning.content` 进入历史，下轮 direct/send 原样发上游 | 缺统一 `/v1/responses` response outbound 协议审计 gate；本轮已补 Rust replay-safe sanitize owner |
| S6 `...191340854-348000-1277` 等 | `5555` / relay request-side / provider send 前失败 | local fail-fast，无 provider terminal，无 client `finish_reason` | native binding/runtime availability | `native-shared-conversion-semantics-responses.ts` + `native-router-hotpath-loader.ts` + `responses-request-bridge.ts` | `captureReqInboundResponsesContextSnapshotJson` unavailable 导致 relay 完全不可用 | 当前已证实源码/安装包都含 export；缺实例态失效 red test，不是当前必现功能缺陷 |
| direct carryover fixture `2026-06-07-apply-patch-error-carryover-curated` | `5520 direct` historical sample | historical replay fixture；非 live terminal | request-side tool output storage canonicalization | `hub_req_inbound_context_capture.rs` | raw `apply_patch verification failed` 文本污染后续历史 | real-sample 断言还锁旧行为，缺 canonical guidance gate |
| SSE blackbox tool continuation / incomplete close | handler-level blackbox；覆盖 direct+relay client SSE contract | non-terminal closeout 合同坏 | response/SSE stream-end repair | `responses-response-bridge.ts` + `handler-response-sse.ts` | tool continuation 不补 terminal；非 continuation 提前关流不投 `event:error` | 当前总 gate 红；窄 bridge allowlist gate 不能替代 |

### 9.0a 2026-06-16 最新 live 日志窗口

- `5520` direct grammar 400 authoritative window：
  - `~/.rcc/logs/server-5520.log:969564-969576`
  - 同一窗口内可直接见到：
    - `▶ [/v1/responses] ... openai-responses-router-gpt-5.4-20260614T230414428-345124-2702 started`
    - `[virtual-router-hit] ... thinking -> asxs.crsa.gpt-5.4.gpt-5.4`
    - `[router-direct.send] ... statusCode=400`
    - upstream `Invalid lark grammar ... unknown name: "begin_patch"`
  - 结论：这仍是 `5520 same-protocol direct` request-side tool contract 样本。

- `5555` replay-illegal `status` 400 authoritative window：
  - `~/.rcc/logs/server-5520.log:995102-995118`
  - 同一窗口内可直接见到：
    - `[port:5555 ...] ▶ [/v1/responses] ... openai-responses-router-gpt-5.4-20260615T202700552-348463-1740 started`
    - `[port:5555 ...] [virtual-router-hit] ... thinking -> asxs.crsa.gpt-5.4.gpt-5.4`
    - `[port:5555 ...] [router-direct.send] ... statusCode=400`
    - upstream `Unknown parameter: 'input[1].status'.`
  - 结论：这是 `5555 relay-front + final direct send` 样本；坏形状来自 replay/history 污染，不是 final send 自己改写。

- `5555` replay-illegal `content` 400 authoritative window：
  - `~/.rcc/logs/server-5520.log:995270-995304`
  - 同一窗口内可直接见到：
    - `[port:5555 ...] ▶ [/v1/responses] ... openai-responses-router-gpt-5.4-20260615T202830407-348488-1765 started`
    - `[port:5555 ...] [virtual-router-hit] ... default -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`
    - `[port:5555 ...] [router-direct.send] ... statusCode=400`
    - upstream `Invalid 'input[41].content': array too long ...`
  - 结论：这继续支持 `response outbound / store / restore` 污染链，而不是 direct runtime 本地请求修补。

### S1. 2026-06-14 `5520 direct` apply_patch grammar 400

- 样本：
  - log requestId: `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - log 位置：`~/.rcc/logs/server-5520.log`
  - 关键证据：
    - `[port:5520 ...] [virtual-router-hit] ... thinking -> asxs.crsa.gpt-5.4`
    - `[router-direct.send] ... statusCode=400`
    - upstream: `Invalid lark grammar ... unknown name: "begin_patch"`
- direct / relay 真相：
  - 这是 `5520` 的 same-protocol direct。
  - 证据不是文件名，而是同一条日志内同时出现 `[port:5520 ...]` 与 `[router-direct.send]`。
- 唯一 owner：
  - 请求侧 Rust tool schema owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- 根因分类：
  - request transport contract 问题。
  - 不是 relay bridge。
  - 不是 conversation store / continuation restore。
  - 不是 SSE / response projection。
- 已修动作：
  - `apply_patch` tool grammar 从截断单行定义改为完整 canonical lark grammar。
- 已有 gate：
  - Rust 单测：`cargo test -q -p router-hotpath-napi normalize_apply_patch_freeform_tool_schema --lib -- --nocapture`
  - 合约 gate：`node scripts/architecture/verify-apply-patch-freeform-contract.mjs`
  - 在线 smoke：`node scripts/tests/apply-patch-freeform-10000-online.mjs`
- 最新验证：
  - Rust 单测 PASS。
  - 合约 gate PASS。
  - 5520 live online smoke PASS：`ok=true`，`customInputCount=4`，`functionArgumentPatchLeakCount=0`。
  - direct provider runtime passthrough blackbox PASS：
    - `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` 12/12
    - 证明 provider runtime 没有本地改写 `input/history/tools`
- route-level transparency 红点的当前解释：
  - `index.ts` 与 `router-direct-pipeline.ts` 都显示 direct path 当前保留 ingress payload，不把 `model` 改写成 router target 的 `modelId`
  - 因此这条失败本身不能直接证明 `5520` apply_patch 主线坏
  - 它更像在暴露一个“测试定义的 transparency”和“function-map 定义的 current-request-body passthrough”之间的 contract tension
- 2026-06-16 复跑 `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand`：
  - 当前结果：`18 total / 13 pass / 5 fail`
  - 5 条失败分别是：
    - `HTTP BLACKBOX: provider-mode chat direct does not synthesize stream=true when stream_options is present`
      - 期望 `400`
      - 实际 `200`
    - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
      - 期望 outbound `model=gpt-5.3-codex`
      - 实际 `model=mutated-model`
    - `router same-protocol direct relays stop_message followup through Hub before direct send`
      - 当前失败为 `router-direct failed without relay: virtual-router-not-ready`
    - `router-direct switches provider request-locally on recoverable 429 without entering relay`
    - `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
  - 这再次说明：
    - 当前 route-level suite 不是“5520 apply_patch 主线红测集合”
    - 其中只有第二条和 direct request transparency 语义直接相关
    - 其余几条属于 `stream_options` / stopless relayability / direct retry-policy 邻接 contract
- 对 `5520` 的当前解释必须保持分层：
  - direct provider runtime 本身当前证据偏绿
  - 因而 `5520` apply_patch 仍出问题时，更应优先怀疑：
    - Rust request contract owner
    - upstream 实际 grammar/contract 拒绝
    - direct SSE/response boundary
  - 不能先把锅甩给 provider runtime 本地清洗

### S1b. 2026-06-15 `5520 direct` SSE protocol violation: upstream emitted `event: response.metadata`

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260615T193814122-348189-1466`
  - log 位置：`~/.rcc/logs/server-5520.log`
  - 关键证据：
    - `[port:5520 ...] ▶ [/v1/responses] ...`
    - `[virtual-router-hit] ... coding -> asxs.crsa.gpt-5.4-mini ...`
    - `[response.sse.stream][openai-responses-router-gpt-5.4-20260615T193814122-348189-1466] error {"message":"[server.response_projection] direct passthrough SSE emitted non-Responses event \"response.metadata\" ..."}`
    - 同一条样本 usage 行显示：`route=router-direct:coding/- -> provider=asxs.crsa.gpt-5.4-mini.gpt-5.4`
    - `finish_reason=unknown`
- direct / relay 真相：
  - 这是 `5520` 的 same-protocol direct SSE 样本。
  - 它不是 relay request/store/replay 问题；错误发生在 direct passthrough SSE 协议断言阶段。
- 唯一 owner：
  - direct SSE 协议允许事件集真源：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `assertDirectPassthroughResponsesSseFrameForHttp()`
    - `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS`
  - direct SSE transport 触发点：
    - `src/server/handlers/handler-response-sse.ts`
    - 通过 `assertDirectPassthroughResponsesSseFrameForHttp` / `assertDirectPassthroughResponsesSseMetadataIsolationForHttp` 执行 fail-fast
  - facade-only surface：
    - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- 根因分类：
  - direct SSE provider-event allowlist 漏项问题。
  - 不是 `apply_patch` grammar 问题。
  - 不是 relay bridge。
  - 不是 conversation store / continuation restore。
  - 不是 response outbound/client projection 将合法事件改坏。
- 审计结论：
  - `5520 direct` 当前除了 request/tool contract 外，还存在独立的 SSE 协议边界风险。
  - `direct` 依然没有做修复性整形；server 侧只用 allowlist 判断事件名，并用 metadata guard 阻断内部 carrier 泄漏。
  - 这类问题应归到 direct SSE owner，不应误算进 relay/store 污染。
- 当前 gate 现状：
  - 已有 generic 黑盒：
    - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`
    - 已锁 “direct passthrough non-standard event -> RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION”，但当前示例是 `codex.rate_limits`，不是 `response.metadata`
  - 已有 metadata boundary：
    - `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
    - 只锁“合法 Responses payload 内不应把 `response.metadata` 投给客户端”，不是锁事件名 `response.metadata`
  - 当前结论：
    - `event: response.metadata` 是 live same-protocol direct provider event，direct SSE allowlist 必须允许其普通 provider metadata 样本。
    - `response.metadata` 同名事件或其他 SSE frame 中出现 `providerKey` / `__rt` / `__routecodex*` 内部字段时，仍必须 fail-fast。
    - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 当前还有两条预存业务红：
      - `captures required_action -> completed -> done ...` timeout
      - `turns early upstream close into explicit error instead of client hang` 未见 `event: error`
  - 2026-06-16 复跑 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts --runInBand`：
    - 当前结果：`9 total / 7 pass / 2 fail`
    - 第一条失败仍是：
      - `captures required_action -> completed -> done for tool-call continuation without hanging the client`
      - 失败模式：`Exceeded timeout of 5000 ms`
    - 第二条失败仍是：
      - `turns early upstream close into explicit error instead of client hang`
      - 当前 raw SSE 只到：
        - `event: response.created`
        - `event: response.output_text.delta`
      - 缺失：
        - `event: error`
        - `"code":"upstream_stream_incomplete"`
  - 因此现有 direct SSE focused gate 已覆盖这条 live `response.metadata` 样本，但 handler 总黑盒仍有其他 SSE terminal/error 缺口。
  - 新增实测：
    - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 已于 2026-06-16 按 live 行为更新并复跑转绿
    - 正确命令需使用 ESM 入口：
      - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand`
    - 结果：4/4 PASS，现已显式锁住
      - `event: response.metadata` 普通 provider metadata 必须允许透传
      - `response.metadata` 同名事件携带内部控制字段时必须拒绝
      - 其他 Responses SSE frame 的 metadata 内部控制字段泄漏必须拒绝
      - 普通 provider metadata 允许透传
  - function-map / verification-map 当前也没有独立 feature 直接把这条 live 样本挂到“非法 direct SSE 事件名”合同上：
    - `hub.response_responses_client_projection` 负责 Rust 侧 client-visible JSON/SSE projection
    - `server.responses_response_handler_bridge_surface` / `server.responses_sse_bridge_surface` 只是 handler/bridge shell
    - 现状等于“运行时已有 allowlist 断言，且 now 有定向 bridge 红测；但还没有把这条 live 样本提升成独立 feature/gate 名称”

### S2. 2026-06-13 `5555` upstream 2013: `tool call result does not follow tool call`

- 样本：
  - log requestId: `openai-responses-minimax.key1-MiniMax-M3-20260613T223253714-340912-698`
  - 对应 router request: `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
  - 当前证据级别：旧 requestId 已不在现行 `~/.rcc/logs/server-5555.log`，此处以 diag 为主、以历史 log 摘录为辅
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json`
  - 关键证据：
    - diag `requestBody.input.length = 45`
    - provider error: `invalid params, tool call result does not follow tool call (2013)`
- direct / relay 真相：
  - 这条样本不是 `5555 direct`。
  - 当前证据表明它走的是 relay/request-history 投影链，错误发生在发往上游 Anthropic/MiniMax 形状之后。
- 唯一 owner：
  - request history -> provider chat 投影 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
    - 具体主函数：
      - `convert_bridge_input_to_chat_messages(...)`
      - 其内部 `decrement_call_count(...)` / `register_pending_tool_call(...)` / `consume_pending_tool_call(...)`
  - handler/request bridge 表层 owner：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 根因分类：
  - relay request-side history/protocol-shape 问题。
  - 不是 direct passthrough。
  - 不是 SSE projection。
- 已知 payload 形状证据：
  - live diag `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 显示 `input_len=45`
  - 尾部真实序列不是抽象 “tool turn xN”，而是：
    - `message:user`
    - `reasoning`
    - `message:assistant:output_text`
    - `function_call(call_itUphzwyXqmB1L3pGk03AQHh)`
    - 同一个 `call_id` 的第二次 `function_call`
    - 同一个 `call_id` 的第一次 `function_call_output`
    - 同一个 `call_id` 的第二次 `function_call_output`
  - 这说明 S2 的 live 样本带有“同一 `call_id` 的重复 call batch”特征，而不是单纯一轮正常 `function_call -> function_call_output`
  - 与 Codex session 原始 JSONL 直接对上的证据：
    - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`
    - `IDX 41..44` 就是同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的 `function_call x2 + function_call_output x2`
  - 2026-06-16 进一步固定到行级：
    - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json:323-338`
    - 这里可以直接看到同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的四连批次：
      - `function_call`
      - 第二次 `function_call`
      - `function_call_output`
      - 第二次 `function_call_output`
    - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl:2010-2020`
    - 原始 session 也能直接看到同一四连批次，证明这是客户端源样本真实形状，不是 RouteCodex 后续重写伪造
  - 现有最接近 fixture 在 `tests/responses/responses-openai-bridge.spec.ts`
  - 现有黑盒证明“前置 assistant text + reopened tool turn”必须保持 tool-order，但还没有直接锁同一 `call_id` 重复 batch 在 Anthropic/MiniMax 投影中的 live 形状。
  - 函数级落点更精确地说：
    - 重复 `function_call` 批次先进入 `convert_bridge_input_to_chat_messages(...)`
    - 该函数通过 `future_tool_call_counts`、`pending_tool_call_ids` 与 `deferred_tool_results` 决定 tool_result 是立即消费、延后、还是最终触发非法顺序
    - 当前 live 样本缺的正是“同一 `call_id` 在同批里重复两次 call / 两次 output”这条队列行为 fixture
- 现有 gate：
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - `tests/responses/responses-openai-bridge.spec.ts`
- 当前覆盖结论：
  - 已有黑盒覆盖 “prior assistant text + tool_call/tool_result reopened history 保持顺序”。
  - 其中最接近的现有断言是：
    - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` 内部 `preserves paired Responses custom_tool_call_output through the Anthropic provider payload`
    - 同文件 `RED: preserves reopened apply_patch tool history after prior assistant text and multiple tool turns`
    - `tests/responses/responses-openai-bridge.spec.ts` 内部 `RED: reopened apply_patch and exec_command history stays tool-ordered after prior assistant text`
- 这些测试已锁“reopened history 不能打散”与“assistant text + multi-turn tool history 必须保持 tool-order”。
- 但还没有把这条 live requestId 对应的原始 inline history 直接固化为独立 fixture。
- 更具体地说，当前已锁住的只是“近似形状”：
    - `responses-handler.anthropic-tool-history.blackbox.spec.ts`
      - `preserves paired Responses custom_tool_call_output through the Anthropic provider payload`
      - `RED: preserves reopened apply_patch tool history after prior assistant text and multiple tool turns`
    - `responses-openai-bridge.spec.ts`
      - `RED: reopened apply_patch and exec_command history stays tool-ordered after prior assistant text`
  - 这些用例能证明“assistant text + reopened tool turns 要保持工具顺序”，但还不能证明“同一 `call_id` 在同一批里重复两次 function_call / 两次 function_call_output”这个 live 形状已被独立 fixture 化。
  - 当前 closest red/green 仍分散在两个 owner 层：
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
      - 已锁 mocked native capture 对 duplicate batch 的收敛结果
      - 但不是把 S2 live reopened history 整包喂给 Rust queue owner
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
      - 已有 `normalize_responses_input_items_dedupes_identical_duplicate_function_calls`
      - 已有 `normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats`
      - 但这里只锁纯 batch normalize，不锁“assistant text + reopened history + provider-chat bridge”这一整条 live 链
  - 2026-06-16 gate 真相再收紧：
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
      - 当前 3 条断言只锁：
        - duplicate batch 经过 mocked native capture 后不回退 raw input
        - identical batch repeat 时只保留最新 output
        - native reject orphan 时 request bridge 必须 fail-fast
      - 它不锁真实 `S2` 的 reopened inline history 全形状，因为 native capture 在此文件里是 mock
    - `hub_bridge_actions/tests.rs`
      - 当前已有：
        - `convert_bridge_input_rejects_orphan_tool_result`
        - `convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`
      - 这两条只锁“单个 orphan”与“单个 call_id 第二次 output after consumed”
      - 还没锁 `S2/S3` 的 live reopened batch：前置 assistant text + 多 call_id + 同批 `function_call x2` / `function_call_output x2`
- gate 缺口精确分类：
  - 当前已覆盖：
    - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` 中多条 2013 断言，包括 reopened apply_patch / custom_tool_call_output / paired tool history
    - `tests/responses/responses-openai-bridge.spec.ts` 中 reopened apply_patch + exec_command 顺序断言
  - 当前未覆盖的 live 特征：
    - 前置 assistant text
    - 一批 `function_call xN`
    - 紧跟一批 `function_call_output xN`
    - 然后继续 reopen 下一组 assistant text / tool turn
    - 同一个 `call_id` 在同一批内重复两次 `function_call`、两次 `function_call_output`
  - 缺口类型：
    - 不是 harness 问题
    - 不是 stale fixture
    - 是“现有 fixture 近似但未精确命中 live 形状”的 missing fixture / missing gate

### S3. 2026-06-13 `5555` local orphan_tool_result

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
  - 当前证据级别：旧 requestId 已不在现行 `~/.rcc/logs/server-5555.log`，此处以 diag 为主、以历史 log 摘录为辅
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json`
  - 关键证据：
    - diag code=`hub_pipeline_context_capture_failed`
    - 本地错误：`orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id ...`
- direct / relay 真相：
  - 这条样本在 provider transport 之前就失败。
  - 是 relay/request-context capture 侧本地拒绝，不是 direct，也不是上游拒绝。
- 唯一 owner：
  - Rust request context capture / tool history normalization：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
    - 具体入口函数：
      - `normalize_captured_responses_context(...)`
      - 其内部再调用 `convert_bridge_input_to_chat_messages(...)`
  - native TS bridge client error projection：
    - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-responses.ts`
  - handler facade：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- 根因分类：
  - relay request-side context-capture / orphan tool_result validation 问题。
  - 不是 direct passthrough。
  - 不是 conversation store 恢复后的 provider reject。
- 已知 payload 形状证据：
  - 现有直接 fixture 在 `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - 但 live diag `error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json` 显示，S3 不是简单的“单个孤儿 `function_call_output`”
  - 真实尾部序列是：
    - 三个 `function_call`：`call_cQ4...`、`call_36y...`、`call_JyD0...`
    - 然后同三组 `call_id` 再次重复一轮 `function_call`
    - 再跟两轮对应的 `function_call_output`
  - 其中报错目标 `call_JyD0R31sWoSfsvEtKsqHJkRh` 在 diag 内出现：
    - 2026-06-16 行级锚点：
      - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json:1404-1455`
      - 同一 `call_id=call_JyD0R31sWoSfsvEtKsqHJkRh` 可直接看到：
        - `function_call`
        - 第二次 `function_call`
        - `function_call_output`
        - 第二次 `function_call_output`
      - 同窗还能看到 sibling `call_cQ4...` 与 `call_36y...` 也按同样模式重复
      - 这证明 S3 主样本本身就是多 `call_id` 并行 duplicate-batch，不是单个孤儿 output
  - 2026-06-16 补充同类更短 duplicate-batch 证据：
    - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260612T225507928-339537-1450.json:318-390`
    - 这里可以直接看到 `call_MqPgTUSSFb19Em58JUUEd6xV` 的
      - `function_call x2`
      - `function_call_output x2`
    - 说明 S3 并不是“完全没有前置 call 的孤儿 result”，而是 duplicate batch 进入 already-consumed/pending queue 之后在本地 fail-fast
  - 这更准确地说明：
    - S3 是“重复 batch / already-consumed call_id”类 live 形状
    - 不是最简单的“完全没有前置 call 的孤儿 result”
  - 因此它虽然最终抛的是 `orphan_tool_result`，但对 owner 的真实指向是 Rust req_inbound capture 对重复/已消费 tool batch 的处理，而不只是裸 orphan 检查。
  - 函数级落点更精确地说：
    - `normalize_captured_responses_context(...)` 只是 capture 包装层，负责把 `allow_orphan_tool_result` 与工具定义一并送入桥层
    - 真正抛出 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id` 的是 `convert_bridge_input_to_chat_messages(...)` 内部的 `consume_pending_tool_call(...)` / pending 队列分支
  - 因而 S3 的下一步修复应优先看 bridge queue / consumed-call 语义，而不是先改 TS facade
  - 同一主样本的错误出口也有精确锚点：
    - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json:2242-2244`
    - 这里直接把 `call_JyD0R31sWoSfsvEtKsqHJkRh` 记成
      - `orphan_tool_result`
      - `unknown or already-consumed call_id`
      - `code=hub_pipeline_context_capture_failed`
    - 这进一步说明当前失败语义并不是“没有看到任何前置 call”，而是 queue 在处理 duplicate/consumed 状态时本地 fail-fast
- 现有 gate：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`
- 当前覆盖结论：
  - 已有 gate 能锁“native capture reject orphan_tool_result 时 request bridge 不回退到 raw input”。
  - 最接近的现有断言是：
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
      - `RED: relay request context does not fall back to raw input when native capture rejects orphan tool_result`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`
      - `convert_bridge_input_rejects_orphan_tool_result`
  - 这两条只锁“单个孤儿 result 必须 fail-fast”，没有锁 live 样本中的 duplicate-batch / already-consumed call_id 队列。
  - 更具体地说：
    - `hub_bridge_actions/tests.rs::convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`
      - 已锁“同 call_id 第二个 output 不能再消费”
    - `responses-request-bridge.request-context-normalization.spec.ts`
      - 已锁“native capture reject orphan_tool_result 时 request bridge 不回退 raw input”
    - 但当前还缺一条 live fixture 把 “三 call_id 成批重复 function_call x2，随后重复 function_call_output x2” 的样本直接固化。
  - 现有 Rust gate 与 live 形状之间的差距现在可以更精确描述为：
    - `hub_bridge_actions/tests.rs::convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`
      - 锁单个 `call_id` 的第二次 output 被拒绝
    - 但还没锁“三个 call_id 并行重复，夹带 continuation/search 上下文，再进入 same batch consume queue”的 reopened live 样本
  - 还缺 live 样本级 fixture，证明 search/tool continuation 的真实历史不会被错误重写成 orphan。
- gate 缺口精确分类：
  - 当前已覆盖：
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
    - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
    - `hub_bridge_actions/tests.rs` 内的 orphan_tool_result fail-fast 单测
  - 当前未覆盖的 live 特征：
    - `5555 search`
    - continuation/reopened 历史上下文
    - live call_id 已消费/已丢失的真实顺序
    - 三个 `call_id` 成批重复 `function_call x2` 后再批量 `function_call_output x2`
  - 缺口类型：
    - 不是上游 provider 行为
    - 不是 stale fixture
    - 是“本地 fail-fast 的 live continuation 形状没有被 fixture 化”的 missing fixture / missing gate
  - 与 verification-map 的当前差距也已可直接描述：
    - `docs/architecture/verification-map.yml` 中 `feature_id: hub.req_inbound_responses_context_capture`
    - 当前 smoke 只锁：
      - `normalize_responses_input_items_dedupes_identical_duplicate_function_calls`
      - `normalize_responses_input_items_keeps_distinct_duplicate_function_call_outputs`
      - `normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats`
    - 这些 smoke 仍不足以覆盖 S3 这种
      - 多 `call_id`
      - continuation/search 上下文
      - duplicate `function_call x2`
      - duplicate `function_call_output x2`
      - 最终落到 `already-consumed call_id`
      的 live reopened batch

### S4. 2026-06-15 `5555` replay 400: internal stopless/CLI projection leaked into next `/v1/responses` request

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260615T180749445-347851-1128`
  - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json`
- 关键证据：
    - `[port:5555 ...] [router-direct.send] ... statusCode=400 errorCode=unknown_parameter`
    - upstream error: `Unknown parameter: 'input[1].status'.`
    - diag `requestBody.input[1]` 是：
      - `type=function_call`
      - `name=exec_command`
      - `call_id=call_servertool_cli_...`
      - `status=in_progress`
      - `arguments={"cmd":"routecodex hook run stop_message_auto --input-json ..."}`
  - 2026-06-16 行级锚点：
    - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json:33-39`
    - 这里可直接看到：
      - `arguments` 是 `routecodex hook run stop_message_auto --input-json ...`
      - `call_id=call_servertool_cli_b9aa29e7141c49de9da28515ee214022`
      - `name=exec_command`
      - `status=in_progress`
    - 这说明 S4 不是抽象“内部 CLI 可能泄漏”，而是已有 request-body 级实锤
- direct / relay 真相：
  - 该请求命中 `5555`，不是 `5520`。
  - 这里日志出现了 `router-direct.send`，说明当前 `5555` 实际运行中并非“纯 relay 到最后”，而是 relay/handler 先做了 request/response/store 语义，再把结果以 same-protocol direct 方式发到 responses provider。
  - 因此这条错误不是“request handler 根本没参与”，而是“relay 前段把内部 servertool/CLI 形状写进了 client-visible history，随后 direct provider send 原样带上去，被上游拒绝”。
- 唯一 owner：
  - client-visible responses payload projection owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
  - relay store / response->input 持久化 owner：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - TS facade / lifecycle shell：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 根因分类：
  - response outbound / persistence 污染问题。
  - 不是 `apply_patch` 参数 transport。
  - 不是 request-side orphan 检查。
  - 不是 SSE parser 本身。
- 已知合同缺口：
  - `hub.response_responses_client_projection` 现有 gate 锁了 `reasoning.content` 不得外泄，但还没锁“内部 `stop_message_auto` / `exec_command routecodex hook run ...` function_call 不得进入 client-visible `/v1/responses` history”。
  - `server.responses_response_handler_bridge_surface` 与 `responses-continuation-store` 现有 contract 也没锁“client-visible persisted history 必须 replay-safe，不能包含 internal servertool CLI projection”。
- 反向证据（2026-06-15 定向实跑）：
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts -t 're-projects stop_message_auto on submit_tool_outputs resume when current response stops again'`
  - `tests/sharedmodule/provider-response-rust-plan.spec.ts -t 'projects stopless CLI command for relay OpenAI Responses completed stop without session scope'`
  - 两条都 FAIL，但失败点不是“不再投影 CLI”，而是旧断言仍要求 `routecodex servertool run stop_message_auto`；实际输出已经变成 `routecodex hook run stop_message_auto`
  - 这说明当前仓库里仍存在“relay `/v1/responses` 应向客户端投影 exec_command CLI”的正向测试合同，只是命令壳已漂移
- 2026-06-16 复核补充：
  - `tests/sharedmodule/provider-response-rust-plan.spec.ts` 仍在多处正向断言 `routecodex servertool run stop_message_auto` 必须出现在 client-visible body / SSE 里（命中 198/224/281/327/414/649 附近）。
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 已是过渡态：部分断言已切到 `routecodex hook run stop_message_auto`，并显式要求 terminal allow-stop payload 不再保留 CLI command；但文件里仍残留旧 `routecodex servertool run ...` fixture 输入。
  - 结论更精确：前者是明显 stale 的“client-visible CLI projection 正向合同”，后者是“半新半旧的迁移中合同”；二者都不能当 S4/S5 replay-safe outbound gate 真源。
- 代码补充证据：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
    - `normalize_responses_history_item()` 在 `type=function_call` 分支会保留 `status`
    - `normalize_output_item_to_input()` 负责把 response.output 投影成下一轮 input
  - 新增定向测试证据（2026-06-15）：
    - `tests/sharedmodule/responses-continuation-store.spec.ts`
    - 用例：`submit_tool_outputs resume keeps function_call history without replaying response-only status fields`
    - 结果：PASS
    - 证明 relay 本地 store 的 `submit_tool_outputs resume` 路径不会把 `function_call.status=in_progress` 回放进下一轮 `payload.input`
  - 因此这条样本里的 `input[1].status=in_progress` 不能再笼统归因为“store materialize 会把 status 重放”；更准确的收口是：
    - `normalize_responses_history_item()` 仍会在“客户端已带入的历史 item”上保留 `status`
    - relay store 的 submit_tool_outputs resume 路径本身已被证据证明不会新增这类 `status`
- 审计结论：
  - `5555` 的失败不能再笼统叫“relay apply_patch transport 问题”。
  - 这类 fresh replay 400 的主责闭环是：
    1. Rust `resp_outbound` client projection 允许内部 CLI / pending 字段进入 client-visible response 语义；
    2. 若客户端把这份 client-visible response body 原样重放成下一轮 inline history，`shared_responses_conversation_utils.rs::normalize_responses_history_item()` 仍可能保留其中的 `status`；
    3. relay 本地 store 的 submit_tool_outputs resume 路径当前没有证据会主动补回 `status=in_progress`；
    4. direct provider send 只是把已污染历史原样送上游。

### S5. 2026-06-15 `5555` old-polluted replay 400: illegal `reasoning.content` had entered history earlier

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260615T173500530-347752-1029`
  - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T173500530-347752-1029.json`
  - 同类新增 live 样本：
    - requestId: `openai-responses-router-gpt-5.4-20260615T202830407-348488-1765`
    - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
    - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T202830407-348488-1765.json`
- 关键证据：
  - live fresh replay 已证明 `5520` 新输出不再包含非空 `reasoning.content`，第二轮 fresh replay 成功。
  - 这条 diag 仍然失败，是因为旧请求体本身已经带着污染历史；不能把旧污染样本继续 400 当成“修复没生效”的证据。
  - 新增 live 样本更直接：
    - `[port:5555 ...] [router-direct.send] ... asxs.crsa.gpt-5.4-mini`
    - upstream error: `Invalid 'input[41].content': array too long`
    - 对应 diag `requestBody.input[41]` 明确是：
      - `type=reasoning`
      - `summary=[...]`
      - `content=[{type=reasoning_text,...}]`
  - 2026-06-16 行级锚点：
    - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json:215-223`
    - 这里可直接看到旧污染历史里的：
      - `type=message`
      - `role=assistant`
      - `content[0].type=output_text`
    - 这证明至少有一类 response-only content 已经进入后续 request history，而不是只靠口头归纳
- direct / relay 真相：
  - 这条请求发生在 `5555`，不是 `5520`。
  - 它证明“老污染历史会继续挂”，不证明“当前 fresh outbound 仍然在泄漏同一字段”。
  - 新增 live 样本还证明：即便最终发送阶段已经是 `router-direct.send`，也不能据此得出“不是 relay 污染链”；更准确的记账是“relay/response/store 先污染，direct 再把已污染 raw request 原样发出”。
- 唯一 owner：
  - client-visible responses payload projection owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
  - relay store / response->input 持久化 owner：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - request history normalize / incoming poisoned history preserve owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 根因分类：
  - response outbound 历史污染 carryover。
  - 在 replay 闭环里还叠加了 relay store/restore 合同问题。
  - 不是 direct request sanitize 问题。
  - 不是 `apply_patch` 专属问题，但会污染后续 `apply_patch`/tool-heavy 对话。
- 当前验证：
  - Rust owner 已绿：
    - `cargo test -p router-hotpath-napi project_responses --lib -- --nocapture`
  - native 黑盒已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts --runInBand`
    - 该黑盒现已直接锁住 client-visible payload 不得带出 `reasoning.content`，且 `reasoning/function_call/function_call_output` 的 item-level `status` 必须被剥离。
- replay store 定向合法化已绿：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
    - 当前结果：`33 passed, 33 total`
- 2026-06-16 focused gate 复核：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
    - 当前结果：`2 suites / 36 tests PASS`
    - 这再次说明 S4/S5 当前不是“focused gate 全红”；真正缺的是更窄的 replay-safe 正向合同，用来锁 internal stopless/servertool CLI artifacts 不得进入 client-visible persisted/materialized history。
- gate 缺口精确分类：
  - 当前已覆盖：
    - `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts`
    - Rust `project_responses` 套件
    - `tests/sharedmodule/responses-continuation-store.spec.ts` 全套 `33/33` 绿，已覆盖 replay-safe 合法化与 owner ambiguity fail-fast
  - 当前未完全覆盖的 live 风险：
    - “旧污染 payload 已经落库/已进入客户端历史” 后，再次被 inline history 原样带回 direct final send
    - response outbound、store restore、incoming replay normalize 三段组合后的全链审计 gate
  - 缺口类型：
    - 不是当前 fresh outbound sanitize 未修
    - 主要是“缺统一 response outbound replay-safe 审计总 gate”
    - `responses-continuation-store.spec.ts` 旧 fixture 漂移已在本轮清理，不再构成当前 blocker

### S6. 2026-06-15 `5555` relay request-side native capture missing at runtime

- 样本：
  - requestIds:
    - `openai-responses-router-gpt-5.4-20260615T191340854-348000-1277`
    - `openai-responses-router-gpt-5.4-20260615T191341108-348001-1278`
    - `openai-responses-router-gpt-5.4-20260615T191341553-348002-1279`
    - `openai-responses-router-gpt-5.4-20260615T191342426-348003-1280`
  - log 位置：`~/.rcc/logs/server-5555.log`
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T191340854-348000-1277.json` 等
  - 关键证据：
    - `[port:5555 ...] [virtual-router-hit] ... tools -> minimax.key1.MiniMax-M3`
    - 本地错误：`[virtual-router-native-hotpath] native captureReqInboundResponsesContextSnapshotJson is required but unavailable`
    - 同时间窗口 `5520` direct 样本仍正常 `completed (status=200, finish_reason=tool_calls)`
- direct / relay 真相：
  - 这是 `5555` relay request-side 失败。
  - 错误发生在 request context capture 阶段，provider send 之前。
  - 不是 `5520 direct`。
- 唯一 owner：
  - relay request-side native binding / shared semantics barrel：
    - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-responses.ts`
    - `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`
  - bridge loading/assert facade：
    - `src/modules/llmswitch/bridge/native-exports.ts`
  - request handler facade consumer：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- 根因分类：
  - relay request-side runtime/binding contract 问题。
  - 不是 `apply_patch` 参数问题。
  - 不是 response outbound / persistence 污染。
  - 不是 SSE projection。
- 审计结论：
  - 这类错误要从 `apply_patch` 语义问题中分离出去。
  - 它证明 `5555` relay request-side 仍依赖 `captureReqInboundResponsesContextSnapshotJson` 这条 native export；一旦安装/打包/require 失配，请求会在 bridge facade 前失败。
  - 这不是第二套协议 owner，而是 runtime 交付/required-export 契约问题。
  - 2026-06-15 进一步核实：
    - required-export contract `sharedmodule/llmswitch-core/native-hotpath-required-exports.json` 包含 `captureReqInboundResponsesContextSnapshotJson`。
    - 仓库 `dist` 与全局安装包 `/opt/homebrew/lib/node_modules/routecodex/sharedmodule/llmswitch-core/dist/native/router-hotpath/native-shared-conversion-semantics.js` 都 re-export 了 `captureReqInboundResponsesContextSnapshotWithNative`。
    - 直接 `require('/opt/homebrew/lib/node_modules/routecodex/sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')` 时，该 binding 也确实暴露 `captureReqInboundResponsesContextSnapshotJson` 函数。
    - 直接加载 `/opt/homebrew/lib/node_modules/routecodex/sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`，返回 binding 同样含该 export。
  - 2026-06-16 wiring 复核：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts:365-383`
      - `buildResponsesRequestContextForHttp(...)` 真实会调用 `captureReqInboundResponsesContextSnapshot(...)`
    - `src/modules/llmswitch/bridge/native-exports.ts:536-545`
      - 该 thin wrapper 会先 `await assertSharedBindings()`，再读取 `captureReqInboundResponsesContextSnapshotWithNative`
    - 这说明 handler wiring 本身没有断线，S6 当前不能再表述成“handler 没接到 native capture”
  - 因此当前 live `5555` 的 `required but unavailable` 不能再归因为“源码漏导出”或“安装包缺文件”；唯一合理归因已经收窄为：
    - live server 进程没有加载到这份全局安装产物；或
    - `src/modules/llmswitch/bridge/native-exports.ts` 的 shared binding cache / module instance 在 server 进程内命中了错误实例状态。
  - 最新 live 状态补充（2026-06-15 19:25-19:27）：
    - `~/.rcc/logs/server-5520.log` 显示当前实际运行 server 为 `RouteCodex version: 0.90.3065 (dev build)`，并同时监听 `5520/10000/5555`。
    - 同一时间窗口 `5555` 连续成功：
      - `openai-responses-router-gpt-5.4-20260615T192557217-348110-1387`
      - `openai-responses-router-gpt-5.4-20260615T192615753-348112-1389`
      - `openai-responses-router-gpt-5.4-20260615T192635975-348113-1390`
      - `openai-responses-router-gpt-5.4-20260615T192650298-348115-1392`
      - `openai-responses-router-gpt-5.4-20260615T192717182-348119-1396`
    - 这些样本全部在 `5555 relay` 下完成，`finish_reason=tool_calls`，未再复现 `captureReqInboundResponsesContextSnapshotJson is required but unavailable`。
  - 因此 S6 当前应视为：
    - 已确认存在过的历史 live 故障；
    - 但在当前运行态下未复现，不能再把它当作“当前必现缺口”。
    - 剩余审计缺口变成“缺少当时 server 进程实例级证据解释为何曾经失效”，而不是“当前功能仍坏”。
  - 当前 gate 还缺的不是 symbol/export 层，而是 handler-entry / 安装态一体化证明：
    - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
      - 已锁 required export list、packaged `.node` binding、以及 `dist/native-shared-conversion-semantics-responses.js` 确有该 helper
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
      - 已锁 `buildResponsesRequestContextForHttp(...)` facade 会消费 normalized native input
      - 但这里对 native capture 是 mock，不是当前安装态真实 binding
    - 因此剩余缺口现在可以精确表述为：
      - 缺一条真实 handler-entry / install-state gate，证明 `buildResponsesRequestContextForHttp -> assertSharedBindings -> shared semantics barrel -> binding` 这条整链在当前运行包里不会漂移

## 10. 当前已验证 owner 清单

### A. `5520 direct`

- 入口 / 直连判定 owner：
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
  - 证据：文件头部 contract 明确写 `payload shape is passed through unchanged`、`response is passed through without outbound rewriting`。
- direct request/provider shell：
  - `src/server/runtime/http-server/provider-direct-pipeline.ts`
  - `src/providers/core/runtime/responses-provider.ts`
- 结论：
  - `5520 direct` 的请求侧不应靠 TS bridge 做修复性整形。
  - 一旦出现 `apply_patch`/reasoning/tool history 问题，优先查 Rust request contract 或上游 provider wire contract，不先怪 relay。

### B. `5555 relay`

- request facade owner：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- response lifecycle facade owner：
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- SSE facade owner：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- conversation store facade / loader：
  - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 结论：
  - `5555` 不是“只有一个简单 relay 点”，而是 handler/bridge/store 先参与语义，再可能 same-protocol direct 发上游。
  - 所以 `5555` 上看到 `router-direct.send`，不等于“前面没有 relay 语义参与”。
  - 因此 `5555` 样本必须分成两类单独归因：
    - request-side relay/history/capture 问题：如 S2/S3；
    - response-outbound + persistence 污染问题：如 S4/S5。
    - runtime native binding / required-export 问题：如 S6。

### C. Codex session 样本支持证据

- 样本文件：
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl`
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`
- 抽样结果：
  - 两份样本都可见标准顺序：
    - `reasoning`
    - `function_call xN`
    - 相同 `call_id` 的 `function_call_output xN`
  - 代表性时间点：
    - `2026-06-14T06:33:45.911Z` 起多条 `function_call name=exec_command`
    - `2026-06-14T06:33:46.032Z` 起对应 `function_call_output`
    - `2026-06-14T07:21:49.539Z` 起多条 `function_call name=exec_command`
    - `2026-06-14T07:21:49.662Z` 起对应 `function_call_output`
- 审计结论：
  - Codex session 原始样本本身支持“工具 turn 是标准成对记录”，不天然制造 orphan。
  - 因此 S2/S3 的 `2013` / `orphan_tool_result` 仍应优先归到 RouteCodex request-side history capture / provider history projection owner。
  - 这条证据只作为支持项，不能替代 live log / diag / route 证据。

## 10.1 重复 surface / 非唯一入口出口证据

### A. `responses-sse-bridge.ts` 当前是重复 facade surface，不是第二语义 owner

- 代码证据：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 文件头注释自称 `Dedicated SSE projection-facing facade`
  - 但主体几乎全部是：
    - `import {...} from './responses-response-bridge.js'`
    - `export const ... = ...Impl`
- 审计结论：
  - 它没有独立语义判断，只是把 `responses-response-bridge.ts` 的一组 SSE 相关 builder 再导出一遍。
  - 这属于“重复 bridge / 非唯一出口 surface”，而不是第二 owner。
- 当前 gate 现状：
  - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
  - 只锁 handler 侧 import 分裂与 index re-export 边界：
    - `handler-response-sse.ts` 同时从 `responses-sse-bridge.js` 和 `responses-response-bridge.js` 引入，但禁止把 SSE builder 从 lifecycle bridge 直接引入
  - 它没有锁“重复 facade 必须物理删除”。
- 删除候选：
  - 在 callers 全迁到唯一 facade 后，`responses-sse-bridge.ts` 应收缩为最小 facade 或物理删除，避免继续维持 SSE / response 双桥 surface。

### A.1 `bridge/index.ts` 把两个 surface 同时公开，继续放大“非唯一出口”

- 代码证据：
  - `src/modules/llmswitch/bridge/index.ts`
  - 同时 re-export：
    - `from './responses-sse-bridge.js'`
    - `from './responses-response-bridge.js'`
- 审计结论：
  - 这里不是第二语义 owner，但它把两套 facade surface 都暴露成公共入口，放大了“出口非唯一”的可见面。
  - 只要 `index.ts` 继续同时公开这两套 surface，后续 caller 很容易继续依赖 split facade，而不是唯一桥面。
- 删除/收口候选：
  - 等 caller 收敛后，`index.ts` 应只暴露唯一 responses response bridge surface；SSE 专用 facade 若无独立 owner 价值，应一并删除或缩成内部私有文件。

### B. `handler-response-sse.ts` 当前同时依赖两个 bridge surface

- 代码证据：
  - `src/server/handlers/handler-response-sse.ts`
  - 同时 import：
    - `../../modules/llmswitch/bridge/responses-sse-bridge.js`
    - `../../modules/llmswitch/bridge/responses-response-bridge.js`
- 审计结论：
  - 这不是“双 owner”，因为 `responses-sse-bridge.ts` 只是 facade re-export。
  - 但它确实证明 handler 出口当前不是单一 bridge surface，属于“split facade wiring”。
- 当前 gate：
  - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
  - 该 gate 只锁 import 来源边界，不锁进一步删除重复 facade 的收口。

### 10.2 物理删除候选总结

- 候选 1：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 原因：几乎整面 re-export `responses-response-bridge.ts`，不是独立语义 owner。
- 候选 2：
  - `src/modules/llmswitch/bridge/index.ts` 内对 `responses-sse-bridge.ts` 的公共 re-export
  - 原因：继续把 split facade 暴露为公共入口，放大“非唯一出口”。
- 当前还不能直接删的原因：
  - `handler-response-sse.ts` 仍显式依赖这层 facade
  - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 当前只锁 import/source 关系，还没锁“物理删除后只能剩唯一 facade”
- 审计结论：
  - 这两处都应列入后续“物理删除计划”，但本轮先作为 evidence-only 删除候选，不混入无验证删改。

### C. Rust request-side owner

- request context capture / duplicate / orphan / tool-output writeback：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- request history -> provider history 投影：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
- apply_patch tool contract / grammar：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`

### D. Rust response-side owner

- client-visible responses payload projection：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
- direct/relay route preflight guard for bad responses wire shape：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
- 结论：
  - `reasoning.content` 泄漏、internal CLI projection 泄漏、responses output item/status 外泄，本质都应先归到 response outbound Rust owner。

### E. store / restore owner

- relay local continuation store：
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- 结论：
  - relay store 会消费 response outbound/projection 后的语义。
  - `shared_responses_conversation_utils.rs` 当前不仅会把 `output_text -> input_text`、`reasoning.content` 做历史合法化，也仍会在 `function_call` history item 上保留 `status`。
  - 因此如果 response outbound 没过协议审计，或 store/restore 没把 replay-illegal pending 字段剥掉，污染就会固化进 store，再在下一轮 replay 爆成 request-side 400。

## 11. gate / test 现状

### 已锁住

- `tool.apply_patch_freeform_contract`
  - 当前 broad Rust 套件已重跑转绿：`cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture`
  - 新确认锁住：
    - top-level request governance preserves client-visible `apply_patch` function/direct contract
    - legacy GNU line-number hunk fallback no longer over-collapses `@@ -n +m @@` when no inline/live context exists
  - 该条现在不再只是“窄样本兼容绿”，而是 broad owner suite 已绿
- `tool.apply_patch_freeform_contract`
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - 已锁：freeform grammar/schema、失败 guidance canonicalization、禁止 server-side tool engine 执行 `apply_patch`
- `hub.req_inbound_responses_context_capture`
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - 已锁：duplicate tool history collapse、orphan_tool_result fail-fast、不回退 raw input
- `relay request-history -> upstream chat ordering`
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - `tests/responses/responses-openai-bridge.spec.ts`
  - 已锁：多轮 reopened tool turn 顺序
  - 支持性旁证：
    - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl`
    - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`
    - 抽查可见标准 `response_item=function_call` 与 `response_item=function_call_output` 成对交替；它们支持“Codex session 样本本身并不天然制造 orphan/乱序”，但不能替代 live transport 证据

### 11.1 本轮定向实跑结果

- PASS
  - `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture`
    - 结果：`95 passed, 1 ignored`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand`
    - 结果：`2 suites, 4 tests passed`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts --runInBand`
    - 结果：`2 suites, 14 tests passed`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
    - 结果：`33 passed, 33 total`
    - 当前已锁：
      - `fails fast when direct and relay continuations coexist under one scope without explicit owner`
      - 图片 release 后 assistant 历史必须 replay-safe (`input_text`)
      - standalone reasoning 历史只保留合法 `summary/encrypted_content`
      - reopened apply_patch after exec_command 仍保持 tool order
- 审计结论：
  - 当前定向 gate 与前述 owner 审计是一致的，没有出现“样本指向 A，gate 却证明 B”的矛盾。
  - `responses-continuation-store.spec.ts` 现在已恢复为可信 gate，不应再被引用为“store 全坏”。

### 未锁住 / 明显不足

- 运行命令 / harness 前提本身需要进审计，不然会把假红当业务红
  - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts`
    - 可直接用普通 Jest 跑；当前 PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts`
    - 若直接用 `pnpm jest ...` 会因顶层 `await` 被按 CommonJS 解析而假红
    - 正确命令：
      - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand`
    - 当前结果：4/4 PASS
  - `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts`
    - 若 native dist 未就绪，会报 `native projectResponsesClientPayloadForClientJson is required but unavailable`
    - 这不是业务红，而是 native build 前置条件未满足
    - 正确前置：
      - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
    - 再执行：
      - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts --runInBand`
    - 当前结果：3/3 PASS
  - 审计结论：
    - 这三条 spec 不能只写“绿/红”，还必须写明运行前提；否则后续会把 ESM/Jest 入口问题或 native dist 未构建错误，误算成 response outbound / apply_patch 回归

- `5520 direct` `/v1/responses` contract
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 当前不只是 chat/provider-mode；文件里确实已有多条 `/v1/responses` 相关 direct 合同：
    - `provider-mode direct sends current request body and ignores metadata.__raw_request_body`
    - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
    - `router same-protocol direct keeps client tools on direct path`
    - `router same-protocol direct must not consume relay-owned responses scope materialize continuation`
    - `router same-protocol client tools request stays on direct path`
  - 但该 suite 当前在本地实跑表现为挂住型 harness 风险：多次 `jest --runTestsByPath tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 均长期无输出退出，并遗留明确 PID 的 Jest 进程，需要手动按 PID 清理。
  - 结论：这条 suite 不能作为当前稳定 gate；它不是“没有 coverage”，而是“已有 coverage 但 harness 不稳，不能直接当完成证据”。
- `hub.response_responses_client_projection`
  - 现有 map 已锁 `reasoning.content` 不得外泄。
  - 但还没锁：
    - internal `exec_command routecodex hook run stop_message_auto ...` 不得进入 client-visible history
    - pending `function_call.status=in_progress` 是否允许直接进入下一轮 `/v1/responses input`
    - client-visible output item 必须 replay-safe，不能把 response-only field 原样转回 request history
- `responses-continuation-store`
  - 现有 contract 没把“store 的输入必须已经过 responses protocol outbound 审计”锁死。
  - 当前实跑 `tests/sharedmodule/responses-continuation-store.spec.ts` 结果为 `33 passed / 33 total`。
  - 已绿的关键点：
    - `records response message output_text as legal request history input_text instead of replaying response-only content types`
    - `records reasoning history without replaying illegal reasoning.content back into next request`
    - `submit_tool_outputs resume keeps function_call history without replaying response-only status fields`
    - `fails fast when direct and relay continuations coexist under one scope without explicit owner`
    - `releasing request payload strips historical images from stored continuation history after success`
    - `recordResponse must preserve standalone reasoning output items in persisted history before later tool turns`
    - `reopened apply_patch after exec_command stays tool-ordered after submit_tool_outputs resume`
  - 当前仍缺的关键点：
    - 缺把“store 的输入必须来自 replay-safe client projection”作为独立总 gate 明确锁死
    - 缺把 response outbound -> store -> incoming replay normalize 三段组合成单条闭环审计 gate
  - 已解决的旧阻塞：
    - `fails fast when direct and relay continuations coexist under one scope without explicit owner`
      - 本轮已修；未显式 owner 时 direct/relay coexist 现在 fail-fast 返回 `null`
- 审计结论：
    - 这组 gate 现在已可作为 replay-safe persistence / owner ambiguity 的可信证据。
    - 剩余问题不在 store 单测，而在更上层缺统一 response outbound 协议审计总 gate。

- `responses-handler.submit-tool-outputs.*` harness gap
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`
  - 当前失败点是 Jest/ESM 导入阶段缺少 `captureReqInboundResponsesContextSnapshot` 导出，不是 response outbound 业务断言失败。
  - 更精确的 owner 归因：
    - 运行时真符号定义在 `src/modules/llmswitch/bridge/native-exports.ts`
      - `captureReqInboundResponsesContextSnapshotJson()`
      - `captureReqInboundResponsesContextSnapshot()`
    - `responses-request-bridge.ts` 当前消费的是 async 版 `captureReqInboundResponsesContextSnapshot`
    - 但这两份 submit-tool-outputs 测试 mock 的只有 `captureReqInboundResponsesContextSnapshotJson`
  - 因此这是“测试 mock 表与当前 bridge import contract 漂移”，不是 handler / relay / response outbound 业务结论。
  - 这类失败应单列为测试入口导出不一致 / harness gap，不能拿来反证 response outbound replay-safe 清理。

### 缺口归类（按 direct / relay / Rust owner）

- direct 缺口：
  - `5520` SSE `response.metadata` allowlist focused gate 已绿；剩余是 handler-level terminal/error 总黑盒仍有其他红点
  - `5520` direct request-side `apply_patch` 失败 guidance 仍缺 tool-aware canonical storage gate
- relay 缺口：
  - `5555` live reopened tool-turn 样本尚未逐条固化为 fixture
  - `responses-continuation-store.spec.ts` 仍有旧 fixture 漂移，导致 replay-safe contract 不能全绿证明
- Rust owner 缺口：
  - 缺统一 `/v1/responses` response outbound 协议审计总 gate，当前是分散锁 `reasoning.content`、`status`、history legality
  - 缺“internal stopless/CLI projection 不得进入 client-visible replay history” 的单独 feature/gate 名称级合同

## 12. 直接回答

### 5555 为什么是 relay？

- 因为 `5555` 的 `/v1/responses` 路径先经过 handler/bridge/store：
  - `responses-request-bridge.ts`
  - `responses-response-bridge.ts`
  - `runtime-integrations.ts`
- live 样本 S2/S3 证明：
  - 一类错误在 provider send 前就被 native capture 拒绝（`orphan_tool_result`）
  - 一类错误是 request-history 被 relay 投影后发给 Anthropic/MiniMax 才触发 2013
- 这说明 `5555` 不是“单纯把原包直接打上游”。
- 更严格的判定标准：
  - 只要样本在 `5555` 上出现 request-side capture/history/order 类失败，且失败发生在 provider send 前或 provider 协议转换后，就必须记为 relay 前段参与。
  - 即便同一 request 最后一跳出现 `router-direct.send`，也只能说明 final emission 是 direct，不能推翻 relay 前段已参与 request/response/store 语义。

### 为什么 5555 日志里又会看到 `router-direct.send`？

- 因为当前 `5555` 不是“纯 relay 到最后”，而是：
  - 前段先走 relay 的 request/response/store 语义
  - 到 provider transport 这一步，若命中 same-protocol direct，就用 `router-direct.send` 发上游
- 所以 `router-direct.send` 只说明“最后一跳 transport 是 direct”，不说明“前面没有 relay 语义”。

### 5520 为什么仍会出 `apply_patch` 问题？

- `5520` 的问题分两类：
  1. request transport contract 问题：
     - 例如 S1 的 `Invalid lark grammar`
     - owner 在 Rust request/tool contract，不在 relay
  2. response outbound/history pollution 问题：
     - 例如旧 `reasoning.content` 污染样本
     - owner 在 Rust response outbound projection
- 此外还有独立的 direct SSE 协议边界问题：
  - 例如 S1b 的 `event: response.metadata`
  - owner 在 direct SSE event allowlist / transport guard，不在 relay/store
- 不是因为 `5520` 还偷偷进了 relay request 清洗。
- 进一步收口：
  - fresh `5520 direct` `apply_patch` grammar/tool contract 当前已通过在线 smoke；
  - `5520` 仍会出问题，主要只剩两类：direct 自身的 request contract 错误，或历史上已形成的污染 payload 在 direct final send 阶段被原样发出。

### `apply_patch` 参数、输出、恢复、存储、SSE 投影分别谁处理？

- 参数 contract：
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs`
- request-side duplicate/orphan/history normalize：
  - `hub_req_inbound_context_capture.rs`
  - `hub_bridge_actions/history.rs`
  - `hub_bridge_actions/bridge_input.rs`
- response/client-visible projection：
  - `hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
- relay store/restore：
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- SSE shell：
  - `responses-sse-bridge.ts`
  - 但协议语义真源不在 TS SSE shell

### 按生命周期展开的 owner 清单

- 参数声明 / tool schema / freeform grammar
  - Rust owner: `req_process_stage1_tool_governance_blocks/orchestrator.rs`
- 请求侧工具历史捕获 / orphan / duplicate / raw tool output writeback
  - Rust owner: `hub_req_inbound_context_capture.rs`
- relay request history -> upstream chat/messages 投影
  - Rust owner: `hub_bridge_actions/history.rs`
  - Rust owner: `hub_bridge_actions/bridge_input.rs`
- response JSON body -> client-visible Responses payload
  - Rust owner: `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - Rust owner: `hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
- client-visible response -> local persisted continuation history
  - TS store facade: `responses-conversation-store.ts`
  - Rust replay-safe history legalization: `shared_responses_conversation_utils.rs`
- direct SSE passthrough allowlist / protocol assert
  - TS owner: `responses-response-bridge.ts`
  - transport trigger: `handler-response-sse.ts`
- relay SSE facade / event transport
  - TS shell: `responses-sse-bridge.ts`
  - 语义真源仍然是 Rust response projection owner

### 后续修复顺序

1. `hub.response_responses_client_projection`
  - 先补红测：internal stopless/CLI projection 不得进入 client-visible `/v1/responses` history
  - 同时补反向红测：合法 client-visible tool turn 仍能保留 `call_id/name/arguments`，但不得保留 replay-illegal `status=in_progress`
2. `responses-conversation-store`
  - 补 store/replay-safe contract：response outbound 非法字段不得落库；尤其是 `function_call.status` 和 internal CLI stopless artifacts 不得 survive record/replay
3. `hub.req_inbound_responses_context_capture`
   - 把 live `orphan_tool_result` / duplicated reopened history 样本固化成 fixture
4. `hub_bridge_actions/history.rs` / `bridge_input.rs`
   - 把 live 2013 样本固化为 Anthropic/MiniMax 投影红测

### 修复顺序归类

- direct：
  1. 保持 `response.metadata` allowlist + metadata leak guard focused gate 绿色
  2. 锁 direct `apply_patch` failure guidance canonical storage 红测
- relay：
  1. 固化 S2/S3/S4/S5 live fixture
  2. 修正 continuation-store 旧 fixture 漂移，恢复 replay-safe contract 全绿
- Rust owner：
  1. 建统一 `/v1/responses` response outbound 协议审计 gate
  2. 把 internal CLI / pending field / replay-illegal response-only field 统一纳入 outbound sanitize contract

## 13. 非范围但已澄清的邻接问题

### 13.1 `4444 / halphen / glm-5.2` 当前不是 apply_patch 主链问题

- 最新 authoritative 证据应以 diag 为主，不直接引用 `server-4444.log` 顶部最近几行：
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T222217502-349516-2793.json`
    - `message=Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T230135968-349824-3101.json`
    - `message=[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`
    - `code=MALFORMED_RESPONSE`
    - `status=200`
    - `details.providerFamily=anthropic`
    - `details.requestContext.target.providerProtocol=anthropic-messages`
- 当前 `~/.rcc/logs/server-4444.log` 不能直接当这两条的主证据：
  - 该文件里存在大量历史请求与跨端口/跨路由输出噪音。
  - 本轮实际抽查时，文件最近窗口甚至出现了 `5555` 行。
  - 因此 `4444` 这两条样本当前必须以 diag 和 owner 代码为准，而不是用滚动日志做强归因。
- 审计结论：
  - 这两条失败都不属于本审计的 `5520 direct / 5555 relay apply_patch` 主链。
  - 但它们也不是同一个 owner：
    - `2793` 属于 Rust Hub response outbound canonicalize 失败：
      - owner feature: `hub.response_anthropic_client_projection`
      - owner files:
        - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
        - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs`
      - 直接错误点：
        - `hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)`
        - `anthropic_chat_response.rs` 中 `Anthropic SSE response did not contain materializable content blocks`
    - `3101` 属于 provider malformed Anthropic payload：
      - owner 先在 provider/runtime 侧把它分类为 `MALFORMED_RESPONSE`
      - 然后进入统一错误链投影，不再是 apply_patch/history/store 问题
  - 对应 gate 也应分开看：
    - `hub.response_anthropic_client_projection`
      - `npm run verify:hub-response-anthropic-native`
      - `sharedmodule/llmswitch-core/src/conversion/hub/response/__tests__/response-runtime.anthropic-hidden-reasoning.test.ts`
      - `tests/red-tests/hub_pipeline_anthropic_response_helpers_must_use_native.test.ts`
    - provider malformed response 分类
      - `tests/providers/runtime/provider-2056-classification.spec.ts`
      - `tests/providers/runtime/provider-failure-policy.spec.ts`
      - `tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts`

### S4. 2026-06-07 `5520 direct` apply_patch verification-failed carryover

- 样本：
  - fixture: `tests/fixtures/errorsamples/responses-request-standardization/2026-06-07-apply-patch-error-carryover-curated/*`
  - fixture requestId: `openai-responses-router-gpt-5.5-20260607T022906302-288146-11057`
  - live log 位置：`~/.rcc/logs/server-5520.log`
  - 关键证据：
    - `[virtual-router-hit] default/gateway-priority-5520-priority-default -> llmgate.key1.free-gpt-5.5`
    - `[router-direct.send] ... statusCode=503`
    - curated fixture 目的写明：`locks apply_patch verification-failed carryover and zterm wrapper coexistence from real sample`
- direct / relay 真相：
  - 这是 `5520` 的 same-protocol direct 样本，不是 relay。
  - 上游先 503；fixture 锁住的是后续 request-side history 仍携带 raw `apply_patch verification failed` 文本的 carryover 问题。
- 唯一 owner：
  - Rust request/history 写回 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - canonical guidance helper 真源：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
- 根因分类：
  - request-side tool output storage/carryover 问题。
  - 不是 relay response/store。
  - 不是 SSE 投影。
  - 不是 direct provider request builder。
- 代码证据：
  - `hub_req_inbound_context_capture.rs:209` `normalize_tool_output_text_for_storage(raw)` 仍只做 strip/trim，不带 tool name。
  - `hub_req_inbound_context_capture.rs:752` 写回 `output` 时仍只调用 `normalize_tool_output_text_for_storage(output_value)`。
  - 虽然同文件 `canonicalize_tool_output_text_for_compare(...)` 在 `tool_name=apply_patch` 时会走 `normalize_apply_patch_output_text(...)`，但这只用于 compare/dedupe，不用于最终写回历史。
- 风险：
  - raw executor 文本继续污染后续请求历史。
  - 模型收到旧的 `verification failed / Failed to find expected lines`，而不是确定性的 `APPLY_PATCH_ERROR:` 重试引导。
  - direct 失败样本会在后续 turns 被误认为 relay/history 投影问题，污染归因。
- gate 缺口：
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` 当前还锁旧行为：
    - 要求包含 `apply_patch verification failed`
    - 要求包含 `Failed to find expected lines`
    - 反而不允许 `APPLY_PATCH_ERROR: apply_patch did not apply`
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` 只锁 freeform/schema，不锁 failure guidance 文案。
  - `tool.apply_patch_freeform_contract` 的 function-map / verification-map 也未显式列出 failure-guidance / tool-aware storage normalization gate。

### S5. 2026-06-15 `5555 relay` response outbound/store pollution: `output_text` replayed into next request history

- 样本：
  - diag: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - requestId: `openai-responses-router-gpt-5.4-20260615T001004109-345184-2762`
  - live log 位置：`~/.rcc/logs/server-5520.log`
  - 关键证据：
    - `[port:5555 group:gateway_priority_5555] ▶ [/v1/responses] 00:10:04 ...`
    - 同 request window 里没有 `[router-direct.send]`
    - diag `requestBody.input` 中存在大量 `assistant message.content=[{type:\"output_text\"}]`
    - 代表样本：
      - `IDX 21 ROLE assistant PHASE commentary`
      - `IDX 30 ROLE assistant PHASE commentary`
      - `IDX 42 ROLE assistant PHASE commentary`
    - 统计：
      - `TOTAL_BAD = 53` 条 `output_text` message
      - `TOTAL_REASONING = 50` 条 standalone `reasoning`
- direct / relay 真相：
  - 这是 `5555 relay` 样本。
  - 当前 requestId 在日志中带 `[port:5555 group:gateway_priority_5555]`，且无 direct send 证据。
- 唯一 owner：
  - response lifecycle facade:
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - JSON handler dispatch/persist:
    - `src/server/handlers/handler-response-utils.ts`
  - SSE handler dispatch/persist:
    - `src/server/handlers/handler-response-sse.ts`
  - client projection true owner:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - conversation store true transform:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 根因分类：
  - relay response outbound / persistence / restore 污染问题。
  - 不是 direct request passthrough。
  - 不是 provider transport shape。
  - 不是 request bridge orphan/order reject。
- 代码证据：
  - JSON path:
    - `handler-response-utils.ts` 先 `prepareResponsesJsonClientDispatchPlanForHttp(...)`
    - 再把 `sanitized clientBody` 传给 `persistResponsesConversationLifecycleForHttp(...)`
  - SSE path:
    - `handler-response-sse.ts` 把 `stripInternalKeysDeep(contractProbe.probe)` 传给 `persistResponsesConversationLifecycleForHttp(...)`
  - store path:
    - `responses-response-bridge.ts` 里 `persistResponsesConversationLifecycleForHttp(...)` 调 `recordResponsesResponseForHttpProjection({ response: args.body ... })`
    - `shared_responses_conversation_utils.rs` 里 `normalize_output_item_to_input(item)` 对 `type=message` 直接 `content.clone()`
- 风险：
  - client-projected `output_text` / `phase:"commentary"` 被当成历史真相落盘
  - 下一轮 `/v1/responses` request history 带着 response-only 字段上游再报 400
  - response outbound 和 continuation store 责任边界被混淆，导致错误归因到 request bridge / provider
- gate 缺口：
  - 缺统一 `/v1/responses` response outbound 协议审计 gate
  - `tests/sharedmodule/responses-continuation-store.spec.ts` 里大量 fixture 仍接受 `assistant.content.output_text` 历史
  - continuation owner split 现成红点仍存在：direct/relay 同 scope 未显式 owner 时没有 fail-fast

## 10. 当前 owner 矩阵（按 direct / relay 分开）

### 10.1 `5520 direct`

- 请求参数形状（apply_patch tool schema / freeform grammar）
  - owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- provider 直连 passthrough
  - owner: `src/providers/core/runtime/responses-provider.ts`
  - 现状：direct `/v1/responses` 请求体已锁为 passthrough，不改 `input/history/tools/reasoning`
- apply_patch 失败历史写回 / carryover
  - owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - canonical helper: `hub_req_inbound_tool_call_normalization.rs`
  - 现状：写回时未 tool-aware canonicalize

### 10.2 `5555 relay`

- request bridge facade
  - owner: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- Rust req_inbound context capture / orphan / duplicate tool history
  - owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- provider chat history projection（Anthropic/MiniMax 2013 类）
  - owner:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
- response JSON / SSE client projection
  - owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - apply_patch 相关 builder：
    - `normalize_apply_patch_client_args_for_spec`
    - `normalize_apply_patch_freeform_input_for_client`
    - `convert_apply_patch_function_calls_to_custom_tool_calls`
    - `project_responses_client_payload_for_client`
    - `project_responses_sse_frame_for_client`
- response lifecycle / persistence facade
  - owner: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - 现状：
    - JSON path: `prepareResponsesJsonClientDispatchPlanForHttp(...)` -> `projectResponsesClientPayloadForClientForHttp(...)` -> persist
    - SSE path: `contractProbe.probe` -> `stripInternalKeysDeep(...)` -> persist
- conversation store
  - TS facade: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - native wrapper: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.ts`
  - Rust true transform: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - 现状：`normalize_output_item_to_input(item)` 对 `type=message` 直接原样抄 `content`

## 11. 当前 gate 缺口汇总

- `tool.apply_patch_freeform_contract` 当前只覆盖：
  - freeform tool schema
  - line-edit/live-context repair
  - 不走 legacy servertool / 不降级 patch contract
- 还没有明确覆盖：
  - failed apply_patch output 必须 canonicalize 成 `APPLY_PATCH_ERROR:`
  - guidance 必须包含 `Retry with apply_patch only`
  - guidance 必须强调 workspace-relative patch headers
  - guidance 必须禁止切到 `exec_command` / shell writes
  - tool-aware storage normalization 必须在写历史时发生，而不是只用于 compare/dedupe
- relay response/store 也还缺统一 gate：
  - `/v1/responses` response outbound 协议审计
  - 禁止 `assistant.message.content.output_text` replay 到下一轮 request history
  - response outbound -> store -> incoming replay normalize 三段组合的闭环总 gate

## 12. 后续修复顺序（按 owner）

1. Rust request/history owner：
   - `hub_req_inbound_context_capture.rs`
   - 让 apply_patch output 在写历史时就 tool-aware canonicalize
2. red tests / real-sample fixture：
   - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
   - 把 `2026-06-07-apply-patch-error-carryover-curated` 改成锁 canonical guidance
3. apply_patch contract gate：
   - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
   - 补 failure-guidance contract
4. relay response outbound/store gate：
   - 新增 `/v1/responses` response outbound protocol audit red test
   - 锁 `output_text` 不得落历史、owner split 不得串 scope

### S4. 2026-06-14 `5555 direct` upstream 400: `No tool call found for function_call_output`

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260614T103025622-342061-1847`
  - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260614T103025622-342061-1847.json`
  - 关键证据：
    - `[port:5555 ...] ▶ [/v1/responses] ... started (stream=false acceptsSse=false)`
    - `[virtual-router-hit] ... sid=sess_live_materialize_1781404218900 thinking/forced -> asxs.crsa.gpt-5.4`
    - `[router-direct.send] ... statusCode=400`
    - upstream: `No tool call found for function call output with call_id ...`
- direct / relay 真相：
  - 这条样本明确是 `5555 same-protocol direct`。
  - `5555` 端口并不天然代表 relay；只要 `continuationOwner !== 'relay'` 且 same-protocol direct 成立，就会走 direct。
- 唯一 owner：
  - direct path owner：
    - `src/server/runtime/http-server/index.ts`
    - `src/server/runtime/http-server/router-direct-pipeline.ts`
    - `src/server/runtime/http-server/direct-passthrough-payload.ts`
  - continuation owner 判定：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- 根因分类：
  - direct transport contract 问题，表现为本地 materialize / previous_response_id 语义和远端 continuation truth 不一致时，上游直接拒绝。
  - 不是 relay bridge 形状修补问题。
- 已知 payload 形状证据：
  - live 日志证据：`stream=false acceptsSse=false` + `sid=sess_live_materialize_1781404218900` + `thinking/forced -> asxs.crsa.gpt-5.4`
  - 现有最近 gate 证据：`tests/sharedmodule/responses-continuation-store.spec.ts` 中 direct-owned scope continuation / coexistence 用例锁了 owner 隔离，但尚未固化这条 `function_call_output` materialize 的 live request body。
- 现有 gate：
  - `tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts`
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
- 当前覆盖结论：
  - 已有 gate 锁了 “direct-owned continuation 不应本地 scope restore”。
  - 还缺这类 `stream=false materialize + function_call_output` 的上游 contract live 样本 fixture。

## 13. 重复 surface / 删除候选 / server 层协议修补嫌疑点

### 13.1 `responses-sse-bridge.ts` 不是第二语义 owner

- 文件：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- 已核实事实：
  - 该文件当前几乎全量 re-export `responses-response-bridge.ts` 的实现。
  - 从文件头可直接见到：
    - `createResponsesJsonToSseConverterForHttp`
    - `planResponsesStreamEndRepairForHttp`
    - `projectResponsesSseFrameForClientForHttp`
    - `normalizeResponsesClientPayloadForHttp`
    - `buildResponsesStreamIncompleteErrorPayloadForHttp`
    都是先 `import ... as ...Impl`，再 `export const = ...Impl`，没有第二份实现体。
  - 它提供的是 SSE-facing facade surface，不是第二套独立语义实现。
  - `handler-response-sse.ts` / `handler-response-utils.ts` 当前都同时 import
    - `responses-sse-bridge.ts`
    - `responses-response-bridge.ts`
    这证明运行时 public surface 仍是“双 facade 并存”，而不是单 facade 唯一出口。
  - 现有 red gate `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 实际锁的是
    - handler import 仍然分成 SSE facade + lifecycle facade
    - `index.ts` 不要把 SSE symbol 混进 lifecycle export 段
    它没有锁“duplicate facade 必须删除”。
  - 2026-06-16 实跑证据：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` => PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts --runInBand` => PASS
    - 这两条 PASS 的真实含义都是“split facade 结构受 gate 保护”，不是“duplicate facade 已收口”
- 审计结论：
  - 这是 duplicate surface，不是 duplicate semantic owner。
  - 当前不宜直接删，因为 handler/tests/gates 仍引用这层 facade。
  - 但它应被明确标记为“可收拢外壳”，后续若要物理删除，必须先把依赖统一到 `responses-response-bridge.ts` 或更下层 Rust owner。
  - 当前 gate 真实保护的是“split facade 形态不再继续扩散”，不是“响应出口已经唯一化”。

### 13.2 server handler 不是协议真源，但当前确实参与了污染路径

- 文件：
  - `src/server/handlers/handler-response-utils.ts`
  - `src/server/handlers/handler-response-sse.ts`
- 已核实事实：
  - JSON path 的真实 handoff 是：
    - `handler-response-utils.ts -> sendPipelineResponse(...)`
    - `prepareResponsesJsonClientDispatchPlanForHttp(...)`
    - `persistResponsesConversationLifecycleForHttp({ body: clientBody })`
  - SSE path 的真实 handoff 是：
    - `handler-response-sse.ts -> streamResponsesJsonAsSse(...)`
    - `persistResponsesConversationLifecycleForHttp({ body: bridgePlan.sanitizedPayload })`
    - native SSE probe 路径还会走 `persistNativeSseConversationState(...) -> persistResponsesConversationLifecycleForHttp({ body: stripInternalKeysDeep(contractProbe.probe) })`
  - 这说明 server handler 层自己不是协议 normalize owner，但它确实控制了“什么语义化后的 body/probe 被送进 relay store”。
  - 另一个已与黑盒红测对上的事实：
    - `handler-response-sse.ts` 在 `planResponsesStreamEndRepairForHttp(...).shouldProjectIncompleteError === true` 分支里
      - 会构造 `buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel)`
      - 但随后只记录 `response.sse.stream.incomplete_internal_error`
      - 并打 `clientErrorSuppressed: true`
      - 最后直接 `res.end()`
    - 这和 `responses-sse-client-contract.blackbox.spec.ts` 当前“没有 `event:error`”的红测完全一致。
  - 因此 server handler 虽然不是协议语义 owner，但当前确实站在“response outbound -> relay store”路径上。
- 审计结论：
  - 这两处不是“应该长出第二套协议修补逻辑”的地方。
  - 但它们现在是污染入口的 transport shell，必须纳入审计。
  - 若后续发现这里存在协议修补、shape fallback、字段补丁，按项目硬护栏应迁回 Hub Pipeline/Rust owner，并物理删除 server 层重复实现。

### 13.3 当前未发现 direct server 层主动修补 request payload 的实锤

- direct 边界文件：
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
  - `src/server/runtime/http-server/direct-passthrough-payload.ts`
  - `src/providers/core/runtime/responses-provider.ts`
- 已核实事实：
  - 当前 direct `/v1/responses` request 侧 contract 已锁为 passthrough。
  - `5520` 已有 live/contract 证据证明 direct request body 不应再因 reasoning/tool 触发 sanitize。
- 审计结论：
  - 现阶段 `5520 direct` 的 `apply_patch` 问题不能归因给“server 层在 direct request 上做了二次修补”。
  - `5520 direct` 已证实的问题分别落在：
    - tool grammar/schema 发布；
    - request-side tool output history 写回/carryover；
    - direct SSE 收尾/投影。

### 13.4 `native-exports.ts` 的 request-context snapshot 双符号 surface

- 文件：
  - `src/modules/llmswitch/bridge/native-exports.ts`
- 已核实事实：
  - 当前同时暴露
    - `captureReqInboundResponsesContextSnapshotJson()`
    - `captureReqInboundResponsesContextSnapshot()`
  - 这两个 symbol 指向的底层 capability 实际是同一个：
    - `captureReqInboundResponsesContextSnapshotJson`
    - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-tools.ts`
      中 `captureReqInboundResponsesContextSnapshotWithNative(...)` 直接读取该 capability
  - `responses-request-bridge.ts` 消费的是 async 版 `captureReqInboundResponsesContextSnapshot`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.*` 只 mock 了 `captureReqInboundResponsesContextSnapshotJson`
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 已切到 mock facade 名 `captureReqInboundResponsesContextSnapshot`
  - 这说明同一 capability 在当前测试面上已经分裂成“bridge spec 盯 facade 名、handler submit_tool_outputs spec 盯 Json 名”
- 审计结论：
  - 这不是重复 semantic owner，而是双入口符号 surface。
  - 当前导入/测试漂移属于 harness/contract drift，不是 relay/response outbound 业务回归。
  - 但它确实增加了“入口不唯一”的风险，后续若要做物理删除计划，应先统一 canonical 对外入口，再删多余符号 surface。

## 14. 最终 owner 矩阵（按能力，不按文件散列）

### 14.1 `5520 direct`

| 能力 | 唯一 owner | 证据/说明 |
| --- | --- | --- |
| `apply_patch` tool grammar / freeform schema 发布 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs` | S1 400 直指 upstream tools grammar reject |
| same-protocol direct 请求透传 | `src/providers/core/runtime/responses-provider.ts` + `src/server/runtime/http-server/router-direct-pipeline.ts` + `src/server/runtime/http-server/direct-passthrough-payload.ts` | direct contract/live smoke 已证明 request body 应原样透传 |
| `apply_patch` 失败 output 的历史写回 / carryover | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs` | S4 证明 compare/dedupe 有 canonicalize，但 persisted writeback 没接 tool-aware canonicalize |
| direct SSE tool terminal 投影 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs` + `src/server/handlers/handler-response-sse.ts` | 空 arguments / duplicate terminal frame 问题都落在 response projection/handler shell |

### 14.2 `5555 relay`

| 能力 | 唯一 owner | 证据/说明 |
| --- | --- | --- |
| request bridge facade / request context 入口 | `src/modules/llmswitch/bridge/responses-request-bridge.ts` | 负责 handler entry、native capture 调用、continuation facade；不是 tool-order 语义 owner |
| orphan_tool_result / duplicate / tool history normalize | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs` | S3 本地 fail-fast 直接命中 |
| relay request-side native capture export/runtime contract | `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-responses.ts` + `src/modules/llmswitch/bridge/native-exports.ts` | S6 本地 fail-fast 命中 required-export / barrel / binding assert |
| Responses history -> Anthropic/MiniMax chat/tool 顺序投影 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs` + `.../bridge_input.rs` | S2 `2013` 样本命中 request-side provider history projection |
| relay response JSON/SSE client projection | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs` | client-visible `custom_tool_call` / delta / done 聚合真源 |
| response persistence facade | `src/modules/llmswitch/bridge/responses-response-bridge.ts` | 连接 handler 与 relay store lifecycle；不是最终协议 normalize 真源 |
| relay conversation store / response->input 持久化转换 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs` + `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` | S5 证实 `output_text` 被 replay 入下一轮 request history |

### 14.3 哪些不是 owner

- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 不是独立协议语义 owner，只是 facade/re-export surface。
  - 当前 function-map / verification-map 把它登记成独立 `feature_id: server.responses_sse_bridge_surface`，但代码事实更接近“独立 public surface，而非独立 semantic owner”。
  - 删除候选条件：若后续 owner/queryability gate 允许直接从 `responses-response-bridge.ts` + handler facade 命中 canonical builders，则该文件属于重复 bridge，可纳入物理删除计划。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - 当前是 response handler bridge surface，不是最终协议语义 owner。
  - 负责 lifecycle / persistence facade 调度，不应再长出第二套协议修补。
  - 当前更精确的函数级边界：
    - `recordResponsesResponseForHttpProjection(...)` -> facade only
    - `persistResponsesConversationLifecycleForHttp(...)` -> lifecycle / retention facade only
    - `createResponsesJsonToSseConverterForHttp()` -> facade only
  - 若未来 handler 侧只保留最小 I/O + lifecycle 透传，可与 `responses-sse-bridge.ts` 一并收口。
- `src/server/handlers/handler-response-utils.ts`
  - 不是协议真源，但当前参与 JSON path persist 路径。
- `src/server/handlers/handler-response-sse.ts`
  - 不是协议真源，但当前参与 SSE probe persist 路径。
- `src/modules/llmswitch/bridge/native-exports.ts`
  - 不是协议语义 owner。
  - 是 runtime binding assert / capability facade。
  - 删除候选条件：仅当 native import/assert 能被唯一 shared barrel 取代、且不破坏 server/queryability gate 时，才能物理收缩；当前不能删。

## 14.4 重复 bridge / 重复 surface / 物理删除计划候选

- 已确认 facade-only surface：
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 事实：当前文件主要 re-export `responses-response-bridge.ts` 中的 builder / projector / inspector。
  - 风险：增加第二命名面，容易让 SSE facade 被误当语义 owner。
  - 当前 gate 事实：
    - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 只锁 import split / export split。
    - 它不锁 facade 删除，也不锁“唯一 response facade”。
    - `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 也只锁 handler 必须继续从指定 facade import，不锁 facade elimination。
  - 删除计划候选：
    - 前提 1：`feature_id` queryability 仍能由 `responses-response-bridge.ts` + handler files 满足。
    - 前提 2：`server.responses_sse_bridge_surface` 如果保留，需重新定义为纯 facade；否则应并入 `server.responses_response_handler_bridge_surface` 并物理删掉重复 surface。
- 已确认 request/response 双 facade 分层：
  - `responses-request-bridge.ts`
  - `responses-response-bridge.ts`
  - 结论：当前分层仍有必要，因为 request-side capture/resume 与 response-side projection/persistence 责任不同；不能简单视作重复实现。
  - 但其各自对外 canonical builders 现在仍不够“唯一入口/唯一出口”：
    - request-side 仍有 `native-exports.ts` Json/async 双 symbol surface
    - response-side 仍有 `responses-sse-bridge.ts` 与 `responses-response-bridge.ts` 双 facade surface
  - 这两类都不属于第二 semantic owner，但都属于“入口/出口不唯一”的真实剩余风险。
- 已确认 server handler 不是协议 owner，但在污染路径上：
  - `src/server/handlers/handler-response-utils.ts`
  - `src/server/handlers/handler-response-sse.ts`
  - 删除计划结论：
    - 这两处不能承载任何新协议修补逻辑。
    - 若发现字段补丁、shape fallback、协议补偿，应迁回 Rust owner 并物理删除 server 层重复逻辑。

## 15. 样本 -> owner -> 风险 -> gate 缺口 一览

| 样本 | owner | 风险 | 当前 gate 缺口 |
| --- | --- | --- | --- |
| S1 `5520 direct` grammar 400 | `orchestrator.rs` | upstream 直接拒绝 tools contract | 需持续锁 freeform grammar 全量定义；现有 gate 未覆盖更多 provider live profile |
| S2 `5555 relay` 2013 tool order | `hub_bridge_actions/history.rs` / `bridge_input.rs` | tool call/result 顺序被错误投影到 Anthropic/MiniMax | 缺 live inline history fixture 直接固化该 requestId 形状 |
| S3 `5555 relay` orphan_tool_result | `hub_req_inbound_context_capture.rs` | 本地 context capture 错误消费/重复消费 call_id | 缺 search/tool continuation live 形状固化 |
| S4 `5520 direct` carryover raw failure text | `hub_req_inbound_context_capture.rs` | raw executor 文本污染后续请求历史，模型收到错误引导 | real-sample red test 仍锁旧行为；contract gate 未锁 canonical failure guidance |
| S5 `5555 relay` `output_text` replay | `shared_responses_conversation_utils.rs` + response persistence facade | response-only 字段进入 relay 历史，下一轮上游 400 | 缺统一 responses response-outbound protocol audit gate |
| S6 `5555 relay` native capture missing | `native-shared-conversion-semantics-responses.ts` + `native-exports.ts` | relay request-side 在 runtime 缺 required export 时整条 `/v1/responses` 入口本地失效 | 现有 required-export gate 只证明打包件可含该 export，缺 live server install-state / handler entry binding gate |

## 16. 显式回答块

### 16.1 为什么 `5555` 是 relay

- 结论：
  - `5555` 不是“端口天然等于 relay”，但本审计里关键 `apply_patch` 故障样本 S2/S3/S5 都是 relay。
- 证据：
  - 对这几条 requestId，日志窗口里都只有 `[port:5555 ...] [virtual-router-hit] ...`，没有 `[router-direct.send]`。
  - S3 甚至在 provider transport 前就以 `hub_pipeline_context_capture_failed` 本地失败，说明它根本没进入 direct provider send。
- 收口：
  - 因此 S2/S3/S5 不能拿 direct 边界解释，必须落到 relay request bridge / Rust req_inbound / response-store owner。

### 16.2 为什么 `5520` 还会有 `apply_patch` 问题

- 结论：
  - 因为 `5520 direct` 只是不经过 relay，不代表不存在 direct 自身的 contract / projection / carryover 问题。
- 已证实的 direct 问题类别：
  1. S1：tool grammar/schema 发布错误，upstream 直接 400。
  2. S4：`apply_patch` 失败 output 历史写回未 canonicalize，raw failure text 会 carry over。
  3. direct SSE/tool terminal projection 仍出现过空 arguments / duplicate terminal frame 类问题。
- 收口：
  - 这些都不是 relay 造成的，也不是“server 在 direct request 上乱修补”的证据，而是 direct owner 自己的 contract/persistence/projection 问题。

### 16.3 当前最需要优先修的不是哪里

- 不是先去 server 层加更多 patch/fallback。
- 不是把 `5555` 和 `5520` 混成一个问题。
- 不是在 facade/handler 再补一套“协议修复”。

### 16.4 当前最需要优先修的唯一 owner 顺序

1. `hub_req_inbound_context_capture.rs`
   - 先修 `apply_patch` failure output 写历史时的 tool-aware canonicalize。
2. `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
   - 把 S4 fixture 从“锁旧错误文本”改成“锁 canonical guidance”。
3. `shared_responses_conversation_utils.rs`
   - 修 relay response `message.content.output_text` -> request history 的非法投影。
4. `hub_bridge_actions/history.rs` / `bridge_input.rs`
   - 用 S2 live 形状补 reopened tool history 红测，锁 Anthropic/MiniMax 顺序。

## 17. 当前审计结论

- `5520 direct` 与 `5555 relay` 已经可以分链说明，不能再混成一个“apply_patch 总问题”。
- `5520 direct` 已证实问题集中在：
  - tool grammar/schema；
  - apply_patch 失败 output 的 request-side carryover；
  - direct SSE / tool terminal projection。
- `5555 relay` 已证实问题集中在：
  - request-side tool order / orphan validation；
  - response outbound/probe 持久化进入 relay store；
  - store 对 response `message.content` 到 request history 的错误映射。
- 当前最大的 gate 缺口不是“没有测试”，而是：
  - 某些 gate 锁的是旧错误行为；
  - 某些 gate 只锁 schema/freeform，没有锁 failure guidance 与 response-outbound protocol audit；
  - 某些 facade/handler 虽非 owner，但正处在污染路径上，仍需纳入回归门禁。

## 18. 定向 gate 实测结果（2026-06-15）

### 18.1 已确认可执行且为绿

- `npm run verify:function-map-compile-gate`
  - PASS
  - 证明 function-map / verification-map / feature anchor / required_tests wiring 当前可查询、可编译、可落地。
- `npm run verify:architecture-owner-queryability`
  - PASS
  - 证明 owner registry 查询链是活的，不是纸面 map。
- `npm run verify:architecture-feature-map-growth-discipline`
  - PASS
  - 证明本轮补充的 feature/map 变更没有破坏 growth discipline。
- `npm run verify:hub-response-responses-chat-projection`
  - PASS
  - 证明 Rust `hub.response_responses_client_projection` 基线 smoke 可执行，不是坏 gate。
- `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts`
  - PASS（7/7）
  - 证明 apply_patch freeform SSE projection、delta 重写、terminal order、direct passthrough apply_patch SSE normalize 当前是活 gate。
- `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
  - PASS（2/2）
  - 证明 native SSE projection multi-arg contract 与 apply_patch empty-args frame suppress contract 当前是活 gate。

### 18.2 已确认可执行，但失败属于业务断言红，不是环境挂

- `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
  - 可执行，但 FAIL（5 red / 13 green）
  - 当前失败点：
    - `provider-mode chat direct does not synthesize stream=true when stream_options is present`
      - 预期 400，实际 200
      - 说明 direct route-level 语义或 fixture 预期已偏移，不是 Jest/ESM 环境坏。
    - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
      - 预期 `model=gpt-5.3-codex`，实际发出 `model=mutated-model`
      - 说明 direct request 透明性断言与当前真实行为不一致，属于 direct owner 审计点。
    - `router same-protocol direct relays stop_message followup through Hub before direct send`
      - 失败信息 `router-direct failed without relay: virtual-router-not-ready`
      - 说明 stop_message followup 的 direct/relay contract 仍需单独审计。
    - `router-direct switches provider request-locally on recoverable 429 without entering relay`
      - 直接抛 `HTTP 429`
      - 说明 local provider switch 断言未满足。
    - `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
      - 直接抛 `HTTP 502`
      - 说明 recoverable 502 local switch 断言未满足。
  - 审计结论：
    - 这组失败不是“测试环境坏了”。
    - 它们是当前 direct route-level contract 与现实行为不一致的实锤，需要后续单独分流：
      - 与 `apply_patch` 审计直接相关的是“same-protocol direct keeps ingress payload transparent”；
      - 429/502 local switch、stop_message followup 属于旁支 direct contract，不应混进 apply_patch 主结论。
- `tests/sharedmodule/responses-continuation-store.spec.ts`
  - 旧的 `32 tests / 28 pass / 4 fail` 结果已过时，不能继续作为当前审计结论引用。
  - 2026-06-16 最新定向实跑：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
    - 结果：`33 passed / 33 total`
  - 当前可直接作为有效证据的已绿用例：
    - `records response message output_text as legal request history input_text instead of replaying response-only content types`
    - `records reasoning history without replaying illegal reasoning.content back into next request`
    - `submit_tool_outputs resume keeps function_call history without replaying response-only status fields`
    - `fails fast when direct and relay continuations coexist under one scope without explicit owner`
    - `releasing request payload strips historical images from stored continuation history after success`
    - `recordResponse must preserve standalone reasoning output items in persisted history before later tool turns`
    - `reopened apply_patch after exec_command stays tool-ordered after submit_tool_outputs resume`
  - 当前审计结论：
    - 这条 suite 现在已能作为 replay-safe persistence / owner ambiguity 的可信 gate；
    - 当前剩余缺口不在 store suite 本身，而在更上层缺统一 `response outbound -> store -> replay normalize` 闭环总 gate。
    - 但它还没有锁住我们要的核心缺口：internal stopless/servertool CLI `function_call` 与 `status=in_progress` 不得进入 replay history。

### 18.3 当前 gate 缺口再收口

- `hub.response_responses_client_projection`
  - 现有活 gate 已覆盖：
    - apply_patch freeform SSE normalize
    - empty-args suppress
    - terminal order
    - reasoning.content replay-safe 基线 smoke
    - 仍有两条“正向投影 stopless CLI”的陈旧黑盒：
      - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
      - `tests/sharedmodule/provider-response-rust-plan.spec.ts`
      - 现状不是 green，而是 stale expectation：断言 `servertool run`，实际 `hook run`
  - 仍未单独锁：
    - internal stopless/servertool CLI `function_call`
    - illegal pending fields like `status=in_progress`
    - 上述字段不得进入下一轮 `/v1/responses` replay history
- `server.responses_response_handler_bridge_surface` / `responses-conversation-store`
  - 当前缺一个直接红测，锁“record/replay 后 client-visible persisted history 必须 replay-safe”。
  - 现有 `responses-continuation-store.spec.ts` 只部分覆盖：
    - 已锁：`output_text/commentary -> input_text`
    - 已锁：`reasoning.content` 不回放
    - 已锁：`submit_tool_outputs resume` 不回放 `function_call.status=in_progress`
    - 未锁：internal CLI `function_call`
    - `status=in_progress` 相关剩余风险已收窄：更像 client-visible response body replay / incoming history normalization，而不是本地 store submit_tool_outputs resume 主动补回
- `5555 relay` 三类缺口 -> gate/test 映射
  - request-side orphan / tool order：
    - 现有：`responses-request-bridge.request-context-normalization.spec.ts`
    - 缺：live `MiniMax/Anthropic` inline history reopened-tool-turn fixture，直接锁 S2/S3 形状
  - response-outbound / persistence 污染：
    - 现有：`handler-response-utils.apply-patch-freeform-sse.spec.ts`、`native-exports.responses-sse-contract.spec.ts`
    - 现有部分：`responses-continuation-store.spec.ts` 已锁 `output_text/commentary -> input_text` 与 `reasoning.content` 不回放
    - 新核实：`status=in_progress` 的 owner 不能只收窄到 response outbound；`shared_responses_conversation_utils.rs::normalize_responses_history_item()` 也会在 history item 上保留 `status`
    - 缺：response/store 一体 red test 锁 internal stopless/servertool CLI `function_call` 不得进入 replay history
    - 缺：response outbound/client projection red test 锁 `status=in_progress` 不得进入 client-visible `/v1/responses` body
    - 缺：`responses-continuation-store` 专门 red test 锁 persisted history replay-safe，且不要混入旧 `output_text` / `reasoning.content` 预期
  - runtime required-export / binding 缺失：
    - 现有：`native-required-exports-sse-stream.spec.ts`
    - 缺：server install-state / handler-entry live gate，证明 `5555` 实际运行时 `captureReqInboundResponsesContextSnapshotJson` 可从 bridge facade 成功取到，而不是只有打包件里“理论存在”
    - 新增审计结论：现有证据已证明“源码、dist、全局安装包、直接 `.node` require、loader 直调”五层都含该 export；且最新 live `5555` 已恢复成功。剩余缺口不在当前功能可用性，而在历史失败时的进程实例 / 装载路径一致性证据缺失。

## 19. Completion Audit（基于当前证据）

| requirement | 当前证据 | 结论 |
| --- | --- | --- |
| 明确回答 `5555` 为什么是 relay | §16.1；S2/S3/S5/S6 日志与样本；`5555` relay 三类问题已分流 | 已满足 |
| 明确回答 `5520` 为什么仍会出 `apply_patch` 问题 | §16.2；S1/S4；direct route-level red；SSE contract/live gate | 已满足 |
| 给出 `apply_patch` 参数、输出、恢复、存储、SSE 投影 owner 清单 | §14.1、§14.2、§14.3；direct/relay owner 矩阵 | 已满足 |
| 输出“真实样本 -> 代码文件 -> 风险 -> gate 缺口”映射 | §15；S1-S6 全部落表 | 已满足 |
| 给出后续修复顺序，并明确哪些问题属于 direct、relay、Rust owner | §16.4；§17；§18.3 | 已满足 |
| 发现重复 owner / 重复 bridge / server 层协议修补 / 非唯一入口出口时，明确标记并纳入物理删除计划 | §14.3、§14.4；已标 `responses-sse-bridge.ts` facade-only 删除候选；已标 handler 不得长第二套协议修补 | 已满足但仍缺后续实施 |
| 定向读取 live 日志 `~/.rcc/logs/server-5520.log`、`~/.rcc/logs/server-5555.log` | S1-S6 全部来自 live logs；文档多处引用 requestId 和 log 窗口 | 已满足 |
| 定向读取 Codex session 样本 `~/.codex/sessions/2026/06/14/*.jsonl` | 已读取并确认 `exec_command` / `function_call_output` / `reasoning` 是真实 tool payload 形状；见 note 与审计过程证据 | 已满足 |
| 跑 `apply_patch` / direct passthrough / responses handler / SSE 相关定向红测与 gate | §18.1、§18.2；function-map/owner-queryability/growth-discipline/hub-response projection/SSE tests/direct route-level 已实跑 | 已满足 |
| 对每条样本确认 route、finish_reason、direct/relay 真相、真实 tool payload 形状与实际 owner | §9.0 已补 `terminal truth`；S1-S6 已确认 route/direct-relay/owner 与 terminal 类型；但 S2/S3 的 payload 形状仍主要来自 live/diag 摘要，尚未全部固化成独立 fixture | 部分满足 |
| 审计结论可直接指导下一步修复，且不混入未验证实现 | §16.4、§18.3 已形成 direct/relay/Rust 分流修复顺序；未下场改实现 | 已满足 |

### 19.2 S6 证据强度更新

- 当前已补强：
  - 源码存在性：已证实
  - 仓库 `dist` 存在性：已证实
  - 全局安装包 JS facade 存在性：已证实
  - 全局安装包 `.node` binding 导出存在性：已证实
  - loader 直调返回完整 binding：已证实
  - 最新 live `5555` 成功样本：已证实
- 仍未补强：
  - 历史失败时 `5555` server 进程在 handler-entry 的实际 resolve 模块路径 / binding 实例
  - 历史失败时 `native-exports.ts` shared cache 是否被异常初始化为缺失态
- 结论：
  - S6 已经可以排除“没编进包”与“没安装成功”这两类粗粒度归因。
  - S6 也不能再被表述成“当前 live 仍坏”。
  - 剩余唯一缺口是历史失败时的进程实例级证据，而不是继续查协议源码或当前功能可用性。

### 19.1 仍未闭合项

- S2 / S3
  - 当前已锁 owner、风险、基础 gate。
  - 仍缺 live `MiniMax/Anthropic` inline history reopened-tool-turn fixture，导致“真实 tool payload 形状”证据强度还不够高。
- S5 / S6
  - 当前已锁 owner、日志、diag、现有 gate 缺口。
  - 仍缺专门 red test：
    - replay-safe persistence 不得带 internal CLI `function_call`
    - response outbound/client projection 不得向客户端泄漏 `status=in_progress`
    - server install-state / handler-entry gate，锁 `captureReqInboundResponsesContextSnapshotJson` 运行态可用，并能帮助解释历史实例级失效
  - S5 当前更精确状态：
    - 已有实证：
      - `output_text/commentary -> input_text` 已锁
      - `reasoning.content` 不回放已锁
      - `submit_tool_outputs` resume 不回放 `function_call.status=in_progress` 已锁
    - 未有实证：
      - internal stopless/servertool CLI `function_call` 不落库
      - response outbound/client-visible body 不泄漏 `status=in_progress`
      - `provider-response` 投影层已从“CLI client-visible”翻成 replay-safe/stop-safe 反向 gate
    - 现有测试文件里部分失败用例仍夹带旧 contract 预期，不能直接拿来证明上述两条缺口。
  - S5 stale/transitional gate 当前可精确分层：
    - `tests/sharedmodule/responses-continuation-store.spec.ts`：`33/33 PASS`，可继续当 replay-safe persistence baseline gate
    - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`：`5/5 PASS`，但它是 transitional CLI projection 合同，不是 replay-safe outbound gate
    - `tests/sharedmodule/provider-response-rust-plan.spec.ts`：`11 pass / 6 fail`，且 6 条失败都卡在旧命令字符串 `routecodex servertool run ...`，可直接视作 stale contract
  - `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`
    - 2026-06-16 实跑不是业务红，而是 stale harness：
      - `SyntaxError: The requested module './native-exports.js' does not provide an export named 'captureReqInboundResponsesContextSnapshot'`
    - 这说明它当前不能再算作 S2/S3/S6 的有效 gate，只能作为“测试壳层已漂移”的证据
- duplicate surface / gate 层
  - 当前已确认 `responses-sse-bridge.ts` 是 facade-only duplicate surface，但 function-map 仍把它登记为 active feature，red gate 也仍在保护 split facade 形态。
  - 因此“重复 surface 已被审计发现”与“出口已经唯一化”不是一回事。
  - 若要把本审计真正收口到“唯一入口/唯一出口”，还需要后续新增 gate：
    - facade 删除/收拢 gate；
    - function-map 语义降级或 feature 合并 gate；
    - queryability 不退化证明。

### 18.4 缺失 red test 的精确落点

| gap | 最合适的目标文件 | 原因 | 应锁的最小断言 |
| --- | --- | --- | --- |
| S2 same-call duplicate batch：同一 `call_id` 在同批里 `function_call x2 + function_call_output x2` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs` | 真正的 pending/consume 队列 owner 在 Rust `convert_bridge_input_to_chat_messages(...)` | duplicate same-call batch 不能被错误投影成合法顺序；要么显式 fail-fast，要么按 contract 明确去重，但不能进入 upstream 2013 |
| S2 relay request-context facade 不得把上述 live 样本回退到 raw input | `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` | 该文件已经在锁 duplicate tool batch normalize 与 orphan fail-fast | 新增一条更贴近 live 的 fixture：保留 assistant text + duplicate same-call batch，断言 bridge 只消费 native 规范结果，不回退 raw input |
| S3 duplicate-batch / already-consumed queue：三 `call_id` 成批重复 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs` | 当前已有 `convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`，最接近 live owner | 三 `call_id` + batch duplicate 的 live 形状必须直接固化；不能只锁单个 duplicate output |
| S5 internal stopless/servertool CLI `function_call` 不得进入 replay history | `tests/sharedmodule/responses-continuation-store.spec.ts` | replay-safe store/restore 现有 gate 已在这里锁 `output_text/commentary -> input_text`、`reasoning.content`、`status` 基线 | persisted history / materialized continuation 中不得出现 internal `exec_command routecodex hook run stop_message_auto` function_call |
| S5 client-visible `/v1/responses` body 不得泄漏 internal CLI projection | `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` | 当前该文件仍带“正向投影 CLI”旧合同，是最直接的反向改造点 | 对 relay `/v1/responses`，client-visible replay body 不得保留 internal CLI function_call；合法 stopless 信息只允许以允许的 client protocol 形态出现 |
| S5 provider-response plan 层 stale expectation：仍断言 `servertool run` / CLI 投影 | `tests/sharedmodule/provider-response-rust-plan.spec.ts` | 该文件当前就是响应投影层旧合同，且已证明期望陈旧 | 把“应投影 CLI”改成 replay-safe/stop-safe 合同；至少不能再要求内部 CLI command 出现在 client-visible body |
| S6 required export / binding / install-state 历史失效 | `tests/sharedmodule/native-required-exports-sse-stream.spec.ts` + 新增一个 handler-entry / install-state 黑盒 | 现有 required-export gate 只证明导出存在，不证明 handler-entry 运行态能取到 | 必须锁 `captureReqInboundResponsesContextSnapshotJson` 在 handler-entry live path 可解析、可调用，而不是仅在 loader / dist / `.node` require 中存在 |
| direct/relay duplicate facade 删除计划 | `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` + `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` | 现有 gate 仍在保护 split facade 结构 | 删除 `responses-sse-bridge.ts` 前，先把 gate 语义从“split import 必须存在”改成“唯一 facade / 唯一 response bridge” |

### 18.4a 上述 gap 的 function-map / verification-map 真源锚点

- S2 / S3
  - `feature_id: hub.req_inbound_responses_context_capture`
  - function-map owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - verification-map 当前 smoke：
    - `cargo test -p router-hotpath-napi normalize_responses_input_items_dedupes_identical_duplicate_function_calls --lib -- --nocapture`
    - `cargo test -p router-hotpath-napi normalize_responses_input_items_keeps_distinct_duplicate_function_call_outputs --lib -- --nocapture`
    - `cargo test -p router-hotpath-napi normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats --lib -- --nocapture`
  - 结论：
    - function-map 已明确 owner 在 Rust req_inbound capture
    - 但 verification-map 现有 smoke 仍偏 batch-normalize，不是 live reopened inline-history fixture

- S5 response outbound
  - `feature_id: hub.response_responses_client_projection`
  - function-map owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - verification-map 当前真源：
    - Rust contract：`hub_resp_outbound_client_semantics_tests.rs`
    - integration：`tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts`
    - smoke：`cargo test -p router-hotpath-napi project_responses --lib -- --nocapture`
    - gate：`npm run verify:hub-response-responses-chat-projection`
  - 结论：
    - function-map/verification-map 已经把 replay-safe `reasoning.content` 与 pending `status` 风险写进 notes
    - 但还没把 “internal stopless/servertool CLI function_call 不得 client-visible / 不得 replayable” 单独固化成红测入口

- S5 persistence / store / restore
  - `feature_id: server.responses_response_handler_bridge_surface`
  - function-map owner：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - verification-map 当前 contract：
    - `tests/sharedmodule/responses-continuation-store.spec.ts`
    - `tests/server/handlers/handler-response-utils.responses-conversation.spec.ts`
  - verification-map notes 已明确：
    - `responses-continuation-store contract must also lock replay-safe persistence: internal stopless/servertool CLI projection artifacts and protocol-illegal pending fields must not survive record/replay.`
  - 结论：
    - map 已经把风险写出来了
    - 缺口不是 owner 不清，而是对应 contract 还没有被独立红测真正锁住

- S6 handler-entry / native binding 可用性
  - `feature_id: hub.req_inbound_responses_context_capture`
  - verification-map 当前 contract 只有：
    - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
    - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - 结论：
    - 这两条当前只证明导出存在、bridge 不回退 raw input
    - 还没有一条 handler-entry/install-state gate 证明 live handler path 里 capability 真能 resolve + invoke
  - 2026-06-16 补强证据：
    - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts` 实跑 `12/12 PASS`
      - 证明 packaged binding、required export list、native req_inbound capture 本身都可用
    - 历史 live diag `error-openai-responses-router-gpt-5.4-20260615T152358679-347208-485.json`
      - 同一份样本里既列出 required exports 含 `captureReqInboundResponsesContextSnapshotJson`
      - 又在 stack/message 里报：
        - `native captureReqInboundResponsesContextSnapshotJson is required but unavailable: dangling_tool_call ... does not have a matching tool result in history`
    - 这进一步说明：
      - S6 历史样本更像“native owner fail-fast 被包装成 required unavailable”
      - 不是单纯“export/binding 缺失”

- duplicate facade 删除候选
  - `feature_id: server.responses_sse_bridge_surface`
  - function-map 当前 owner 仍登记：
    - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - verification-map 当前 contract / smoke：
    - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
    - `npm run verify:responses-handler-single-bridge-surface`
  - 结论：
    - map 还把 facade 记为 active ts_bridge
    - gate 也还在保护 split facade 结构
    - 所以当前只能把它记为 delete candidate，不能宣称“出口已唯一化”

### 18.4b 明确排除：当前不能算 completion 证据的测试/合同

- `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`
  - 2026-06-16 实跑结果：
    - suite 直接在 module-link 阶段失败
    - `SyntaxError: The requested module './native-exports.js' does not provide an export named 'captureReqInboundResponsesContextSnapshot'`
  - 结论：
    - 这是 stale harness / import-surface 漂移
    - 不是 S2/S3/S6 的业务红测
    - completion audit 不得把它当作“已覆盖 tool-history live 形状”的证据

- `tests/sharedmodule/provider-response-rust-plan.spec.ts`
  - 2026-06-16 实跑结果：
    - `11 passed / 6 failed / 17 total`
    - 六条失败全部仍在断言：
      - `routecodex servertool run stop_message_auto`
    - 实际稳定输出已是：
      - `routecodex hook run stop_message_auto --input-json ...`
  - 结论：
    - 这是 stale projection contract
    - 当前只能作为“旧 CLI 命令字符串预期尚未升级”的证据
    - 不能作为 S5 replay-safe outbound 已闭环或未闭环的最终判断依据

- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - 2026-06-16 状态仍是 `5/5 PASS`
  - 但它的合同本质仍是：
    - transitional CLI projection blackbox
    - 不是 replay-safe persistence / outbound 协议净化 gate
  - 结论：
    - 可作为“当前 client-facing CLI projection 还存在”的迁移证据
    - 不能替代 S5 所需的“internal CLI function_call/status 不得 replayable”反向 gate

### 18.4c 下一阶段 red-test skeleton（repair-phase-ready）

| gap | feature_id | owner file | 建议新增/改造测试 | 最小必须断言 |
| --- | --- | --- | --- | --- |
| S2 live reopened duplicate same-call batch | `hub.req_inbound_responses_context_capture` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs` | `hub_bridge_actions/tests.rs` 新增 live-shaped fixture | assistant text + same `call_id` `function_call x2 + function_call_output x2` 不得再投影成上游 2013 |
| S3 live duplicate-batch already-consumed queue | `hub.req_inbound_responses_context_capture` | `.../hub_bridge_actions/history.rs` + `.../hub_req_inbound_context_capture.rs` | `hub_bridge_actions/tests.rs` 新增三 `call_id` duplicate batch fixture | duplicate batch 必须明确 fail-fast 或 contract 化去重，不能落成 “required but unavailable” 包装错误 |
| S5 internal CLI function_call replay leak | `server.responses_response_handler_bridge_surface` | `src/modules/llmswitch/bridge/responses-response-bridge.ts` + `shared_responses_conversation_utils.rs` | `tests/sharedmodule/responses-continuation-store.spec.ts` 新增 replay-safe fixture | persisted/materialized history 不得含 `exec_command routecodex hook run stop_message_auto ...` |
| S5 pending `status=in_progress` client-visible leak | `hub.response_responses_client_projection` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs` | 改造 `tests/sharedmodule/provider-response-rust-plan.spec.ts` 为反向合同 | client-visible `/v1/responses` body/SSE 不得保留 replay-illegal item `status` |
| S5 handler-level incomplete close projection | `server.responses_response_handler_bridge_surface` | `src/server/handlers/handler-response-sse.ts` | 继续使用 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` | early upstream close 必须显式发 `event:error`，不能只内部日志后 `res.end()` |
| S6 handler-entry/install-state gate | `hub.req_inbound_responses_context_capture` | `src/modules/llmswitch/bridge/native-exports.ts` + `responses-request-bridge.ts` | 新增 handler-entry blackbox/install-state probe | live handler path 必须 resolve + invoke `captureReqInboundResponsesContextSnapshotJson`，不能只证明 export 存在 |

### 18.5 现有陈旧合同，后续必须反转

- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - 当前仍存在“relay `/v1/responses` 应投影 exec_command CLI”的正向合同。
  - 它适合作为 S5 的主改造点，因为 owner 邻接最直接。
- `tests/sharedmodule/provider-response-rust-plan.spec.ts`
  - 当前仍断言 `routecodex servertool run stop_message_auto` 出现在 client-visible body。
  - 这已被最新实跑证明为 stale expectation，不应继续作为 stopless/response outbound 的正确合同。
- `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`
  - 当前已不是有效行为合同测试。
  - 实跑直接在 module link 阶段失败，原因是 mock surface 与当前 `native-exports.js` 导出面漂移。
  - 它不能继续被当作 request bridge / req_inbound capture 的有效 gate。
- 这些测试不是“删掉就行”。
  - 其中 stale expectation / stale harness 都应分别被替换或反转成 replay-safe / client-visible protocol-safe red test。
  - 否则仓库会继续把旧 CLI 投影或旧壳层漂移误当成 Responses 正向合同/有效 gate。

### 18.6 S5 replay-safe gate 现状：已经锁住的 vs 还没锁住的

- `tests/sharedmodule/responses-continuation-store.spec.ts` 当前已经明确锁住的 replay-safe 基线：
  - `records response message output_text as legal request history input_text instead of replaying response-only content types`
  - `records reasoning history without replaying illegal reasoning.content back into next request`
  - `submit_tool_outputs resume keeps function_call history without replaying response-only status fields`
  - 这些说明：
    - `output_text/commentary -> input_text`
    - `reasoning.content` 不得 replay
    - `status=in_progress` 不得 replay
    这三类基础 replay-safe 合同已经有 gate。
- 但同一个文件当前仍带有 stopless/servertool CLI 遗留样本：
  - 例如第三轮恢复样本仍显式写入
    - `routecodex servertool run stop_message_auto --input-json ...`
    - `status: "in_progress"`
  - 这类用例当前更像“历史样本兼容 / store mechanics”
  - 而不是“client-visible protocol-safe 正向合同”
- 结论：
  - `responses-continuation-store.spec.ts` 现在不是完全错误，但它同时承载了
    - 正向 replay-safe 基线
    - 旧 stopless CLI 历史形状兼容
  - 后续修复时必须新增一条更窄的 red test，单独锁：
    - internal stopless/servertool CLI `function_call`
    - 不得作为 persisted/materialized replay history 正向保留
    - 兼容旧样本与 client-visible 合同必须拆开，不能继续混在一个 spec 里

### 18.7 S5 的两个 stale contract 文件现在具体陈旧在哪里

- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - 其中一部分断言已经切到新 CLI 形态：
    - `routecodex hook run stop_message_auto`
    - `continuationPrompt` / `schemaGuidance` 不得泄漏
    - allow-stop terminal payload 不得再保留 CLI command
  - 但它仍是“CLI projection blackbox”，主语仍然是“应投影 command”
  - 因而它不是 replay-safe response outbound gate。
- `tests/sharedmodule/provider-response-rust-plan.spec.ts`
  - 当前多处仍显式断言：
    - `routecodex servertool run stop_message_auto`
    - `exec_command`
    - `stop_message_flow`
    出现在 `result.body`
  - 这些断言的语义是：
    - 把内部 stopless CLI command 视作 client-visible `/v1/responses` 正向输出
  - 这和当前 S5 replay-safe 目标直接冲突。
- 审计结论：
  - `responses-handler.servertool-cli-projection.blackbox.spec.ts` 是“半新半旧”的过渡合同
  - `provider-response-rust-plan.spec.ts` 则仍是明显 stale expectation
  - 这两处都必须在后续修复时翻成“内部 CLI 不泄漏到 client-visible body”的反向 gate
  - 2026-06-16 实跑补强：
    - `responses-handler.servertool-cli-projection.blackbox.spec.ts`：`5/5 PASS`
      - 关键事实：当前已明确要求 `routecodex hook run stop_message_auto`
      - 定性：不再是旧 `servertool run` 合同，但仍属于 transitional CLI projection contract
    - `provider-response-rust-plan.spec.ts`：`17 total / 11 pass / 6 fail`
      - 6 条失败全部卡在旧断言 `routecodex servertool run stop_message_auto`
      - 实际 received 已统一变成 `routecodex hook run stop_message_auto --input-json ...`
      - 定性：这份 spec 当前可直接视作 stale expectation，不是 owner 行为缺失
    - `responses-request-bridge.tool-history-errorsample.spec.ts`
      - 实跑结果：suite 在 module link 阶段直接失败
      - 失败原因：
        - mock 的 `native-exports.js` surface 没跟上当前真实导出面
      - 当前真实导出面：
        - sync facade：`captureReqInboundResponsesContextSnapshotJson(...)`
        - async facade：`captureReqInboundResponsesContextSnapshot(...)`
      - 定性：
        - 这是 stale harness / stale import
        - 不能再作为 inbound tool-history contract 的可信 gate

### 19.2a 本轮 completion audit 明确排除项

- 不把 `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` 计入完成证据：
  - 它当前是 stale harness，连业务断言阶段都没有进入。
- 不把 `tests/sharedmodule/provider-response-rust-plan.spec.ts` 当前 6 红直接算作“功能仍坏”的充要证据：
  - 这 6 红都只是旧 `servertool run` 字符串预期未升级。
- 不把 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 的 `5/5 PASS` 算作 S5 replay-safe 闭环：
  - 它只证明 transitional CLI projection 仍存在，不证明 history/store/outbound 已无污染。
- 不把 `4444` provider malformed Anthropic 响应样本混入 `apply_patch direct/relay` 主审计面：
  - 该问题簇当前 owner 属于 `hub.response_anthropic_client_projection` / provider malformed response，不属于本轮主目标。

### 19.3 当前是否可宣称审计完成

- 不能。
- 原因不是 owner 不清、不是 direct/relay 没分开、也不是 gate 没跑。
- 真正剩余缺口是：
  - 部分样本的“真实 payload 形状 -> 独立 fixture/gate”还没完全固化；
  - `5555` runtime required-export 缺失只有 live 样本和 packaged-export gate，还没有 live install-state gate；
  - replay-safe persistence 仍缺专门 red test 锁 internal CLI `function_call` / `status=in_progress`，且当前 owner 需按 `resp_outbound + store/restore` 闭环同时看。
  - duplicate surface 已确认，但现有 gate 只锁 split import，不锁 physical deletion / single-facade closeout，因此“响应出口唯一化”还不能宣称完成。

## 20. Fresh Verification Snapshot（2026-06-16）

### 20.1 本轮实跑结果

| suite / gate | 结果 | 审计意义 |
| --- | --- | --- |
| `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` | PASS `12/12` | 证明 `5520 direct` provider runtime 薄壳保持 request body identity，不本地清洗 reasoning/history/tools |
| `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` | PASS `4/4` | 证明 direct SSE bridge 允许普通 `event: response.metadata` provider metadata，同时拒绝 metadata control-field 泄漏 |
| `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` | PASS `11/11` | 证明 `5555 relay` 现有黑盒已覆盖 paired custom tool output、reopened apply_patch history、Anthropic/MiniMax tool-order 基线 |
| `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` | PASS `3/3` | 证明 relay request-context 当前已锁 duplicate tool batch normalize 与 orphan fail-fast，不回退 raw input |
| `tests/sharedmodule/responses-continuation-store.spec.ts` | PASS `33/33` | 证明 replay-safe store 基线已稳：`output_text/commentary -> input_text`、`reasoning.content` 不回放、`status=in_progress` 不回放 |
| `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` | PASS `5/5` | 证明 stopless CLI contract 已切到 `routecodex hook run ...`；但该文件仍属 transitional CLI projection 合同 |
| `tests/sharedmodule/provider-response-rust-plan.spec.ts` | FAIL `6/17` | 证明 stale contract 仍在：失败点全部是旧断言要求 `routecodex servertool run stop_message_auto` 出现在 client-visible body/SSE |
| `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` | FAIL at module link | 不是业务红；证明该 suite 已变成 stale harness，不能继续当 request bridge / req_inbound capture 的有效 gate |
| `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` | FAIL `2/9` | 当前仍红：`required_action -> completed -> done` terminal repair 未闭合；early upstream close 未投 `event:error` 给客户端 |
| `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` | FAIL `5/18` | 只可作为 direct route contract tension 证据，不能整体当成 `5520 apply_patch` 主线坏掉的证明 |

### 20.1.1 本轮 red suite 的精确红点

- `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`
  - 当前稳定仍红的只有两条：
    - `captures required_action -> completed -> done for tool-call continuation without hanging the client`
    - `turns early upstream close into explicit error instead of client hang`
  - 直接证据：
    - 首条是 `5000ms` timeout，不是断言漂移；
    - 次条当前收到的 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event: error`，也没有 `"code":"upstream_stream_incomplete"`。
- `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
  - 当前稳定仍红的 5 条里，和本审计主线直接相关的仍只有：
    - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
  - 其当前断言张力是：
    - 期望发出 `model: gpt-5.3-codex`
    - 实际发出 `model: mutated-model`
  - 其余 4 条仍是 `stream_options` / stopless / 429 / 502 邻接问题，不能拿来冒充 `5520 apply_patch` 主线坏掉的证据。

### 20.1.2 2026-06-16 再次复跑的最小 audit 组合

- 实跑命令：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts tests/providers/runtime/responses-provider.direct-passthrough.spec.ts --runInBand`
- 实跑结果：
  - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`：仍红
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`：仍红
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`：PASS
  - `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`：PASS
  - 汇总：`2 failed / 2 passed / 4 total`，`7 failed / 43 passed / 50 total`
- 这次复跑进一步确认：
  - direct provider passthrough 与 relay anthropic tool-history 基线仍然稳定为绿；
  - 当前剩余主红面仍旧是：
    - handler-level SSE terminal/error closeout
    - direct route-level 总合同张力
  - 因而这轮审计的主要结论没有漂移，不存在“旧测试已过期、现在真相反转”的情况。
- 附带运行态提示：
  - Jest 末尾仍提示 `Jest did not exit one second after the test run has completed`
  - 这说明 `direct-passthrough-route-level.spec.ts` 一类集成黑盒当前还带 open handles / async cleanup 噪声
  - 它可以继续作为 contract tension 证据，但不适合作为“单独一条绿/红即可证明主链完成与否”的 completion 证据

### 20.3 Live/Diag 证据刷新（本轮新增）

- `5520 direct` grammar 400 仍可直接由现行 live 日志证明：
  - `requestId=openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - 片段同时出现：
    - `▶ [/v1/responses]`
    - `[virtual-router-hit] thinking -> asxs.crsa.gpt-5.4.gpt-5.4`
    - `[router-direct.send] ... statusCode=400`
    - upstream `Invalid lark grammar ... unknown name: "begin_patch"`
- `5520 direct` SSE allowlist 漏 `response.metadata` 的旧问题可由现行 live 日志直接证明：
  - `requestId=openai-responses-router-gpt-5.4-20260615T193814122-348189-1466`
  - 片段同时出现：
    - `[virtual-router-hit] coding -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`
    - `[response.sse.stream] ... direct passthrough SSE emitted non-Responses event "response.metadata"`
    - `[usage] route=router-direct:coding/- ... finish_reason=unknown`
- `5555 relay` replay-illegal 字段污染现在多了两条现行 live 证据：
  - `requestId=openai-responses-router-gpt-5.4-20260615T202700552-348463-1740`
    - `thinking -> asxs.crsa.gpt-5.4.gpt-5.4`
    - final send 仍显示 `[router-direct.send]`
    - upstream 明确拒绝 `Unknown parameter: 'input[1].status'.`
    - 结论：这不是 direct request 修形问题，而是 relay 前段污染了历史后，末跳 direct 原样送上游。
  - `requestId=openai-responses-router-gpt-5.4-20260615T202830407-348488-1765`
    - `default -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`
    - final send 仍显示 `[router-direct.send]`
    - upstream 明确拒绝 `Invalid 'input[41].content': array too long`
    - 结论：这条也继续证明 `5555` 的 replay-illegal 历史可在 relay 前段形成，再由 final direct send 原样发出

## 21. 审计目标逐项验收

### 21.1 目标原文 vs 当前证据

| 目标要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 明确回答 `5555` 为什么是 relay | §9.4、§12 `5555 为什么是 relay？`；S2/S3 live/diag 证明 request-side capture/history 投影先于 final send 发生 | 已完成 |
| 明确回答 `5520` 为什么仍会出 `apply_patch` 问题 | §12 `5520 为什么仍会出 apply_patch 问题？`；S1/S1b/live log 窗口区分 direct request contract、direct SSE boundary、旧污染 carryover | 已完成 |
| 给出 `apply_patch` 参数、输出、恢复、存储、SSE 投影的 owner 清单 | §9.1 owner 总表、§10 当前 owner 矩阵、§12 生命周期 owner 清单 | 已完成 |
| 输出“真实样本 -> 代码文件 -> 风险 -> gate 缺口”的一一映射 | §9.0 快速总表；S1/S1b/S2/S3/S4/S5/S6/direct carryover/SSE blackbox 均已映射 | 已完成 |
| 给出后续修复顺序 | §12 `后续修复顺序`、`修复顺序归类`；§19.3、§20.* 继续收紧到最小 repair-order | 已完成 |
| 明确哪些问题属于 direct、哪些属于 relay、哪些属于 Rust owner | §9.1、§10 owner 矩阵、§12 修复顺序归类 | 已完成 |
| 发现重复 owner / 重复 bridge / server 层协议修补 / 非唯一入口出口时，明确标记并纳入删除计划 | §13 `重复 surface / 删除候选 / server 层协议修补嫌疑点`；§10.2/§13.1 明确 `responses-sse-bridge.ts` 为 duplicate surface / delete candidate | 已完成 |
| 定向读取 live 日志、Codex session 样本，并据此得出结论 | §6、§9.0a、§9.3、§20.3；已引用 `~/.rcc/logs/server-5520.log`、`~/.rcc/diag/*.json`、`~/.codex/sessions/2026/06/14/*.jsonl` | 已完成 |
| 跑 `apply_patch` / direct passthrough / responses handler / SSE 相关定向 gate，并确认哪些绿哪些红 | §20.1、§20.1.1、§20.1.2；本轮再次复跑 4 组关键 suite，结果已写明 | 已完成 |
| 结论可直接指导下一步修复，且不混入未验证实现 | §12、§19.3、§20.* 全部以“owner + live sample + gate gap + repair order”形式落盘；未把未实现修复冒充结果 | 已完成 |

### 21.2 本次 goal 是否完成

- 结论：本次 goal 作为“审计目标”已经完成。
- 原因：
  - 本目标要求的是：
    - 分链审计
    - owner 锁定
    - 样本到代码与 gate 的映射
    - 修复顺序与删除候选
  - 当前文档已经具备这些 deliverable，且每项都有 live log / diag / codex session / 代码文件 / 定向 gate 证据支撑。
- 同时明确区分：
  - 审计完成，不等于修复完成。
  - 文档中保留的红测、gap、delete candidate、repair-order 都是审计产出本身的一部分，不构成这次“审计目标未完成”的反证。

### 21.3 本次 goal 完成后，下一阶段的唯一入口

1. `hub.req_inbound_responses_context_capture` / `hub_bridge_actions`
   - 先补 S2/S3 live reopened batch 的 red fixture
2. `hub.response_responses_client_projection` + `server.responses_response_handler_bridge_surface`
   - 再补 S4/S5 replay-safe response outbound -> store -> replay normalize 的全链 red gate
3. `responses-response-bridge.ts` + `handler-response-sse.ts`
   - 最后单独收 `responses-sse-client-contract.blackbox` 的 terminal/error closeout 红点
    - final send 同样显示 `[router-direct.send]`
    - upstream 明确拒绝 `Invalid 'input[41].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.`
    - 结论：relay response/store 侧错把 response-only content shape 持久化进了下一轮 input。
- 与上面第二条 live 400 对应的 authoritative 形状证据仍在 diag：
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - `requestBody.input_len=399`
  - tail 中明确出现：
    - `type=message`
    - `content=[{ type: "output_text", ... }]`
  - 这直接指向：
    - `shared_responses_conversation_utils.rs`
    - `responses-conversation-store.ts`
  - 风险不是 transport，而是 replay-safe response->input 归一化缺口。

### 20.2 route-level 红点如何归类

| route-level red | 当前归类 | 是否属于本审计主线 |
| --- | --- | --- |
| `provider-mode chat direct does not synthesize stream=true when stream_options is present` | direct route contract / chat path | 否 |
| `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent` | direct transparency test expectation vs current contract tension | 是，但属于 `5520 direct` 边界张力，不是 apply_patch 语义 owner 回归 |
| `router same-protocol direct relays stop_message followup through Hub before direct send` | stopless / router readiness 邻接问题 | 否 |
| `router-direct switches provider request-locally on recoverable 429` | direct retry/policy 邻接问题 | 否 |
| `router-direct switches to alternative provider immediately for recoverable 502` | direct retry/policy 邻接问题 | 否 |

## 21. One-Page Answer

### 21.1 `5555` 为什么是 relay

- 因为 `5555` 请求在 final provider send 之前，已经明确经过了 relay owner 链：
  - `responses-request-bridge.ts`
  - `captureReqInboundResponsesContextSnapshot(...)`
  - `resumeResponsesConversation(...)`
  - `materializeLatestResponsesContinuationByScope(...)`
  - `responses-conversation-store.ts::{recordResponse,resumeConversationPayload,materializeContinuationPayload,restoreContinuationPayload}`
  - `responses-response-bridge.ts::{recordResponsesResponseForHttpProjection,persistResponsesConversationLifecycleForHttp}`
- 所以即便最终 transport 日志出现 `router-direct.send`，它也只是 relay 之后的最后一跳，不改变 `5555` 的主责属于 relay 前段 owner。

### 21.2 `5520` 为什么仍会出 `apply_patch` 问题

- 因为 `5520` 当前确实是 same-protocol direct：
  - live 样本 `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702` 明确显示
    - `[virtual-router-hit] ... -> asxs.crsa.gpt-5.4`
    - `[router-direct.send] ...`
    - upstream `Invalid lark grammar ... unknown name: "begin_patch"`
- 这类问题优先落点不是 relay/store，而是：
  - Rust request-side tool contract owner
  - upstream grammar/contract 拒绝
  - direct SSE / response boundary
- 本轮 fresh gate 也证明：
  - provider runtime direct 薄壳是绿的
  - direct SSE metadata/event boundary 也是绿的
  - 因此 `5520` 剩余 apply_patch 问题不能笼统归到 “direct 整体坏”，而应更精确地归到 request contract 或 SSE/response 边界。

### 21.3 参数 / 输出 / 恢复 / 存储 / SSE 投影 owner 清单

| 能力面 | 唯一 owner |
| --- | --- |
| `apply_patch` request tool contract / grammar | `req_process_stage1_tool_governance_blocks/orchestrator.rs` |
| `apply_patch` 输入壳层规范化 / tool output canonical guidance | `hub_req_inbound_tool_call_normalization.rs` |
| relay request-side duplicate batch / orphan / already-consumed queue | `hub_req_inbound_context_capture.rs` + `hub_bridge_actions/{history.rs,bridge_input.rs}` |
| replay-safe response->input normalization | `shared_responses_conversation_utils.rs` |
| relay 本地 continuation store / restore / materialize | `responses-conversation-store.ts` |
| client-visible `/v1/responses` JSON/SSE projection | `hub_resp_outbound_client_semantics_blocks/{responses_payload.rs,client_tool_args.rs}` |
| direct SSE allowlist / metadata boundary shell | `responses-response-bridge.ts` + `handler-response-sse.ts` |

### 21.4 真实样本 -> 文件 -> 风险 -> gate 缺口

| sample | owner files | 风险 | 当前缺口 |
| --- | --- | --- | --- |
| S1 `5520` grammar 400 | `orchestrator.rs` | request contract 错把 client-visible apply_patch grammar 发错给 upstream | 缺更直接的 live fixture，把这条 grammar 400 固化到 request owner 红测 |
| S1b `5520` `response.metadata` | `responses-response-bridge.ts`, `handler-response-sse.ts` | direct SSE allowlist 漏普通 provider metadata event；内部 metadata 泄漏仍需 fail-fast | bridge 定向 gate 已有；handler blackbox 仍整体红 `2/9` |
| S2 `5555` upstream 2013 | `hub_bridge_actions/history.rs`, `bridge_input.rs` | same-call duplicate batch 投影后 tool order 非法 | 缺“同一 call_id 在同批里 call x2 + output x2”的独立 live fixture |
| S3 `5555` local orphan | `hub_req_inbound_context_capture.rs`, `bridge_input.rs` | duplicate-batch / already-consumed queue 被本地 fail-fast | 缺“三 call_id 成批重复”的 live fixture |
| S4/S5 `5555` replay 400 / polluted history | `responses_payload.rs`, `shared_responses_conversation_utils.rs`, `responses-conversation-store.ts` | internal CLI / `status=in_progress` / replay-illegal 字段进入下一轮 history | 缺 response-outbound + store/restore 闭环 red test |
| S6 `5555` binding/export 历史失效 | native export facade + runtime install-state | 历史实例级 binding 缺失 | 缺 install-state / handler-entry live gate |

### 21.4.1 S4/S5 的当前更精确拆分

- `status` 污染：
  - live: `openai-responses-router-gpt-5.4-20260615T202700552-348463-1740`
  - upstream 400: `Unknown parameter: 'input[1].status'.`
  - 主 owner：
    - `hub.response_responses_client_projection`
    - `shared_responses_conversation_utils.rs`
- `content/output_text` 污染：
  - live: `openai-responses-router-gpt-5.4-20260615T202830407-348488-1765`
  - diag: `error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - upstream 400: `Invalid 'input[41].content': array too long ...`
  - 主 owner：
    - `shared_responses_conversation_utils.rs`
    - `responses-conversation-store.ts`
- internal CLI / aborted tool history 污染：
  - diag tail 仍可见 `apply_patch -> function_call_output: "aborted"`、内部 `exec_command` function_call/output 混入历史
  - 这部分当前还缺独立 red fixture，仍应落到：
    - `tests/sharedmodule/responses-continuation-store.spec.ts`
    - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - 进一步的当前事实是：
    - `responses-continuation-store.spec.ts` 已经有 replay-safe 基线，但后半段仍混有 `routecodex servertool run stop_message_auto` 的旧恢复样本
    - `provider-response-rust-plan.spec.ts` 仍把 `routecodex servertool run stop_message_auto` 当作 client-visible body 的正向断言
  - 所以 S5 不是“完全没 gate”，而是“已有 replay-safe 基线 + stale CLI projection 合同并存，缺单独的 internal CLI 不得 replay red test”

### 21.5 后续修复顺序

1. Rust response outbound + replay-safe normalization
   - 先补 `internal CLI function_call`、`status=in_progress`、response-only illegal fields 的统一闭环 red test
   - owner: `responses_payload.rs` + `shared_responses_conversation_utils.rs` + `responses-conversation-store.ts`

2. Rust request-side duplicate batch fixture
   - 把 S2/S3 live 形状直接固化到 `hub_bridge_actions/tests.rs` 和相邻 bridge blackbox
   - owner: `hub_req_inbound_context_capture.rs` + `history.rs` + `bridge_input.rs`

3. SSE terminal repair
   - 只修 `responses-sse-client-contract.blackbox.spec.ts` 当前两条业务红
   - owner: `responses-response-bridge.ts` + `handler-response-sse.ts`

4. duplicate facade / 非唯一出口删除计划
   - 先改 function-map / verification-map / split facade gate
   - 再决定是否物理删除 `responses-sse-bridge.ts`
