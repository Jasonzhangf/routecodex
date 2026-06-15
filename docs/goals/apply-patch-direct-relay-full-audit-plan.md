# Apply Patch Direct/Relay Full Audit Plan

Last updated: 2026-06-15

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

### S2. 2026-06-13 `5555` upstream 2013: `tool call result does not follow tool call`

- 样本：
  - log requestId: `openai-responses-minimax.key1-MiniMax-M3-20260613T223253714-340912-698`
  - 对应 router request: `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
  - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json`
  - 关键证据：
    - `[port:5555 ...] [virtual-router-hit] ... tools -> minimax.key1.MiniMax-M3`
    - 没有 `[router-direct.send]`
    - provider error: `invalid params, tool call result does not follow tool call (2013)`
- direct / relay 真相：
  - 这条样本不是 `5555 direct`。
  - 当前证据表明它走的是 relay/request-history 投影链，错误发生在发往上游 Anthropic/MiniMax 形状之后。
- 唯一 owner：
  - request history -> provider chat 投影 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
  - handler/request bridge 表层 owner：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 根因分类：
  - relay request-side history/protocol-shape 问题。
  - 不是 direct passthrough。
  - 不是 SSE projection。
- 已知 payload 形状证据：
  - 现有最接近 fixture 在 `tests/responses/responses-openai-bridge.spec.ts`
  - 已锁形状：`assistant text -> apply_patch/custom_tool_call -> custom_tool_call_output -> assistant text -> exec_command/function_call -> function_call_output -> assistant text -> apply_patch/custom_tool_call -> custom_tool_call_output`
  - 现有黑盒证明这类“前置 assistant text + 多轮 reopened tool turn”必须保持 tool-order，不得在 Anthropic/MiniMax 投影时打散成非法顺序。
- 现有 gate：
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - `tests/responses/responses-openai-bridge.spec.ts`
- 当前覆盖结论：
  - 已有黑盒覆盖 “prior assistant text + tool_call/tool_result reopened history 保持顺序”。
  - 但还没有把这条 live requestId 对应的原始 inline history 直接固化为独立 fixture。

### S3. 2026-06-13 `5555` local orphan_tool_result

- 样本：
  - requestId: `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
  - log 位置：`~/.rcc/logs/server-5520.log` 中的 `[port:5555 ...]` 段
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json`
  - 关键证据：
    - `[port:5555 ...] [virtual-router-hit] ... search -> minimax.key1.MiniMax-M3`
    - 没有 `[router-direct.send]`
    - 本地错误：`orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id ...`
    - diag code=`hub_pipeline_context_capture_failed`
- direct / relay 真相：
  - 这条样本在 provider transport 之前就失败。
  - 是 relay/request-context capture 侧本地拒绝，不是 direct，也不是上游拒绝。
- 唯一 owner：
  - Rust request context capture / tool history normalization：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
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
  - 样状：`input=[{ type:function_call_output, call_id:<unknown>, output:'late tool result' }]`
  - 该形状在 native req_inbound capture 必须 fail-fast，bridge 不得退回 raw input。
- 现有 gate：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`
- 当前覆盖结论：
  - 已有 gate 能锁“native capture reject orphan_tool_result 时 request bridge 不回退到 raw input”。
  - 还缺 live 样本级 fixture，证明 search/tool continuation 的真实历史不会被错误重写成 orphan。

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
  - continuation owner split 同 scope 必须 fail-fast，不得默认命中 relay continuation

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
  - 它提供的是 SSE-facing facade surface，不是第二套独立语义实现。
- 审计结论：
  - 这是 duplicate surface，不是 duplicate semantic owner。
  - 当前不宜直接删，因为 handler/tests/gates 仍引用这层 facade。
  - 但它应被明确标记为“可收拢外壳”，后续若要物理删除，必须先把依赖统一到 `responses-response-bridge.ts` 或更下层 Rust owner。

### 13.2 server handler 不是协议真源，但当前确实参与了污染路径

- 文件：
  - `src/server/handlers/handler-response-utils.ts`
  - `src/server/handlers/handler-response-sse.ts`
- 已核实事实：
  - JSON path 会把 client-projected / sanitized `clientBody` 传入 `persistResponsesConversationLifecycleForHttp(...)`。
  - SSE path 会把 `stripInternalKeysDeep(contractProbe.probe)` 传入同一 persistence facade。
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
| Responses history -> Anthropic/MiniMax chat/tool 顺序投影 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs` + `.../bridge_input.rs` | S2 `2013` 样本命中 request-side provider history projection |
| relay response JSON/SSE client projection | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs` | client-visible `custom_tool_call` / delta / done 聚合真源 |
| response persistence facade | `src/modules/llmswitch/bridge/responses-response-bridge.ts` | 连接 handler 与 relay store lifecycle；不是最终协议 normalize 真源 |
| relay conversation store / response->input 持久化转换 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs` + `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` | S5 证实 `output_text` 被 replay 入下一轮 request history |

### 14.3 哪些不是 owner

- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 不是独立协议语义 owner，只是 facade/re-export surface。
- `src/server/handlers/handler-response-utils.ts`
  - 不是协议真源，但当前参与 JSON path persist 路径。
- `src/server/handlers/handler-response-sse.ts`
  - 不是协议真源，但当前参与 SSE probe persist 路径。

## 15. 样本 -> owner -> 风险 -> gate 缺口 一览

| 样本 | owner | 风险 | 当前 gate 缺口 |
| --- | --- | --- | --- |
| S1 `5520 direct` grammar 400 | `orchestrator.rs` | upstream 直接拒绝 tools contract | 需持续锁 freeform grammar 全量定义；现有 gate 未覆盖更多 provider live profile |
| S2 `5555 relay` 2013 tool order | `hub_bridge_actions/history.rs` / `bridge_input.rs` | tool call/result 顺序被错误投影到 Anthropic/MiniMax | 缺 live inline history fixture 直接固化该 requestId 形状 |
| S3 `5555 relay` orphan_tool_result | `hub_req_inbound_context_capture.rs` | 本地 context capture 错误消费/重复消费 call_id | 缺 search/tool continuation live 形状固化 |
| S4 `5520 direct` carryover raw failure text | `hub_req_inbound_context_capture.rs` | raw executor 文本污染后续请求历史，模型收到错误引导 | real-sample red test 仍锁旧行为；contract gate 未锁 canonical failure guidance |
| S5 `5555 relay` `output_text` replay | `shared_responses_conversation_utils.rs` + response persistence facade | response-only 字段进入 relay 历史，下一轮上游 400 | 缺统一 responses response-outbound protocol audit gate |

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
