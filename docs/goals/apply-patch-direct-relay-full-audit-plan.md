# Apply Patch Direct/Relay Full Audit Plan

Last updated: 2026-06-14

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

## 10. owner 清单（当前已证实）

- `apply_patch` 请求参数/schema 发布：
  - Rust owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- direct path 透传边界：
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
  - `src/server/runtime/http-server/direct-passthrough-payload.ts`
  - `src/server/runtime/http-server/index.ts`
- relay request bridge / continuation 入口：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 本地 continuation store / owner 隔离：
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- Rust req inbound context capture / tool history normalization：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
- relay SSE / response bridge 表层：
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
- direct apply_patch 输出投影：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
- Responses client-visible JSON/SSE 投影真源：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - TS facade 仅允许：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
    - `src/server/handlers/handler-response-sse.ts`
    - `src/server/handlers/handler-response-utils.ts`

## 10.3 按能力拆分的 owner 清单

- `apply_patch` 参数/schema：
  - Rust owner: `req_process_stage1_tool_governance_blocks/orchestrator.rs`
- `apply_patch` 输出历史写回/去重/规范引导：
  - Rust owner: `hub_req_inbound_context_capture.rs`
- request history -> provider chat/tool 协议投影：
  - Rust owner: `hub_bridge_actions/history.rs`, `hub_bridge_actions/bridge_input.rs`
- 本地 continuation 捕获 / 存储 / 恢复：
  - TS store owner: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- request-side bridge 入口与 continuation owner 判定：
  - TS facade owner: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - TS runtime facade: `src/modules/llmswitch/bridge/runtime-integrations.ts`
- same-protocol direct 判定与透传：
  - TS thin shell: `src/server/runtime/http-server/index.ts`
  - TS thin shell: `src/server/runtime/http-server/router-direct-pipeline.ts`
  - TS thin shell: `src/server/runtime/http-server/direct-passthrough-payload.ts`
- client-visible Responses JSON/SSE 投影：
  - Rust owner: `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
- response lifecycle / SSE facade：
  - TS facade: `responses-response-bridge.ts`
  - TS facade: `responses-sse-bridge.ts`

## 10.1 response / SSE owner 细分

- Rust 真源：
  - `feature_id: hub.response_responses_client_projection`
  - owner: `client_tool_args.rs`
  - 责任：Responses JSON body 和 SSE frame 的 client-visible 投影，包括 `apply_patch` freeform 自定义工具输出、reasoning/model 恢复。
- TS SSE facade：
  - `feature_id: server.responses_sse_bridge_surface`
  - owner: `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 现状：几乎纯 re-export facade，不持有协议语义真相。
- TS response lifecycle facade：
  - `feature_id: server.responses_response_handler_bridge_surface`
  - owner: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - 责任：continuation/conversation 生命周期 facade。

## 10.2 重复 owner / 重复 bridge 审计结论

- 当前没有发现第二个协议语义真源：
  - `apply_patch` 的请求 grammar、request history normalize、client-visible projection 真源仍然分别在 Rust owner。
- 但发现一层重复 surface：
  - `responses-sse-bridge.ts` 基本是对 `responses-response-bridge.ts` 的按符号 re-export facade。
  - 这不是“重复实现”，而是“重复 surface”。
- 当前不能直接物理删除的原因：
  - `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
  - `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
  - 两者都显式要求 handler 同时从 `responses-sse-bridge.js` 和 `responses-response-bridge.js` 导入不同 surface。
- 删除候选结论：
  - 未来如果要物理收口，应先把 SSE facade 与 lifecycle facade 的 handler import/gate 合并，再删除纯 re-export facade。
  - 在那之前，当前结论只能记为“重复 surface 候选”，不能宣称已经可删。

## 11. direct / relay 真相校正

- `5520` 当前主要样本是 same-protocol direct，但问题仍可能出在：
  - direct request contract（如 S1 grammar 400）
  - direct response projection（此前 apply_patch added-frame 空 arguments）
- `5555` 不是“天然 relay”：
  - 当 `responsesResume.continuationOwner === 'relay'` 时，`index.ts` 会强制跳过 direct，进入本地 relay continuation。
  - 当 continuation owner 不是 `relay` 且 same-protocol direct 成立时，`5555` 也会走 direct，如 S4。
- 因此本文里的“5555 relay”应解释为：
  - `5555` 上那些命中了本地 continuation/request-history owner 的 relay 样本；
  - 不是指 `5555` 端口上的所有 `/v1/responses` 请求。
- 本地 store 明确排除 direct scope restore：
  - `responses-conversation-store.ts` 里 `resumeLatestContinuationByScope` / `materializeLatestContinuationByScope` 都跳过 `continuationOwner === 'direct'`。

## 12. gate 缺口与后续修复顺序

- 缺口 G1：
  - 缺 live-fixture 级别的 `5555 relay` 2013 样本固化。
  - 下一步：把 `223253714-340912-698` 的 inline history 提炼为 fixture，补到 `responses-handler.anthropic-tool-history.blackbox.spec.ts`。
- 缺口 G2：
  - 缺 live-fixture 级别的 `orphan_tool_result` search/tool continuation 样本。
  - 下一步：把 `231359101-341020-806` 固化成 request-context-normalization + Rust bridge history 双侧红测。
- 缺口 G3：
  - 缺 `5555 direct stream=false materialize + function_call_output` 合约黑盒。
  - 下一步：在 direct boundary / continuation store 黑盒里补一条和 `342061-1847` 同形状样本。
- 缺口 G4（当前真实为红）：
  - `tests/sharedmodule/responses-continuation-store.spec.ts` 当前失败在：
    - `fails fast when direct and relay continuations coexist under one scope without explicit owner`
  - 现状不是 fail-fast，而是错误命中了 `relay` materialize 结果。
  - 这证明 direct/relay continuation owner 共存隔离仍未完全锁死。
- 修复顺序：
  1. 先修 relay request-side history owner（S2/S3，Rust capture + bridge history）。
  2. 再修 direct/relay continuation owner 共存隔离（G4，conversation store / request bridge）。
  3. 再修 `5555 direct` materialize/continuation truth（S4，direct owner + continuation owner 判定）。
  4. 最后收 SSE/response projection 残余问题；S1 已闭环，不再作为当前主 blocker。
