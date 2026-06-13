# 2026-06-13 orphan_tool_result 真源追踪

## 现象
- 5555 `/v1/responses`（gateway_priority_5555 / tools 路由）持续 `❌ orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_zUatDii8VoRu6RZvsKQkZM18`，错误码 `hub_pipeline_context_capture_failed`。
- 同 call_id 在两个独立 requestId（340926-712、340927-713）上连续复现，是稳定回放不是一次性。
- 入口：openai-responses (`/v1/responses`)，search route 命中。
- provider 落点：minimax.key1.MiniMax-M3.MiniMax-M3。
- 不同于上一轮 “fix direction: buildChatRequestFromResponses 收到的是 responses owner 的 fullInput”——这次错在 Responses 入口直接报错，没有 chat 入口。

## 排除项
- 不是 provider 5xx / 429 / 524；provider 没回流响应。
- 不是 router-direct 5xx fallback / routecodexSameProtocolDirectDisabled 重入。
- 不是 client tools 命中 relay 误报：search route 也是 standard client tools，但 VR 命中 search 路由组，不是 relay。
- 不是 SSE keepalive / protocol violation 路径。
- 不是 metadata 透传：custom client metadata 在 10000 出现过 unsupported，但本轮错误没有 metadata 引用。

## 假设链
1. `requestId` scope：同一 call_id 跨 requestId 出现 → 标准化的 requestId-scoped cleanup 把它当成“已消费”。
2. Responses conversation store：上一轮已确认 store 是 requestId+conversationId 隔离，但工具消费标记可能仍挂在 conversationId scope。
3. bridge consumer：bridge 收到同一 call_id 的 tool_result 不知道它属于哪一轮 request。
4. duplicate replay wrapper noise：zterm 2026-06-13 那一类补丁有可能在 dedupe 时把后到的 tool_result 当 orphan 丢回。

## 关键文件 / 调用链
- 出错点：`bridge tool_result item references unknown or already-consumed call_id` —— 出现在 Responses 标准化/去重链路。
- 真源候选：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`（`drop_stale_orphan_responses_tool_outputs` / `dedupe_identical_responses_tool_history_entries`）
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`（`normalize_submitted_tool_outputs` / `prepare_responses_conversation_entry` / `resume_responses_conversation_payload`）
  - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`（zterm 2026-06-13 的请求侧 normalize owner）

## 既有红样本
- `tests/fixtures/errorsamples/responses-request-standardization/2026-06-13-duplicate-replay-wrapper-noise/request-body.json`
- 回归：`tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`

## 下一步（落地）
- 抓线上真实 request body，定位 call_id 出现位置。
- 区分：(a) duplicate replay 二次进入；(b) 已经 submitted 但被前置 path 误删；(c) store 中 record 过 call_id 但 requestId scope mismatch。
- 补 red test：同 requestId 不应 orphan；跨 requestId 同 call_id 必须显式 allow-continuation 才接受。
