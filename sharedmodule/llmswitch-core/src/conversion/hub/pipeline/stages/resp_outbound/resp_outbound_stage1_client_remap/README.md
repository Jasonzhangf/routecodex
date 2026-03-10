# resp_outbound_stage1_client_remap

**目标**：将 finalize 后的 Chat payload 映射为客户端协议（/v1/chat/completions, /v1/messages, /v1/responses）。Responses 作为骨架，其他协议可覆写。

**输入**
- Finalized Chat payload。
- entry endpoint / clientProtocol 判定结果。

**输出**
- Client-facing JSON（OpenAI Chat、Anthropic Messages、OpenAI Responses）。

**依赖**
- `buildResponsesPayloadFromChat`（Responses 回传）。
- `buildAnthropicResponseFromChat`、`finalized` 本身。

**错误落点**
- 判定 client 协议失败时抛出 Error。

**下一步**
- `resp_outbound_stage2_sse_stream`：在需要流式输出时生成 `__sse_responses`。
