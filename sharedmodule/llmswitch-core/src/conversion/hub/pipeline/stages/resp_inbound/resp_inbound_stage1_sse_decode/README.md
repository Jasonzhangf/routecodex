# resp_inbound_stage1_sse_decode

**目标**：检测 provider 返回的 SSE 流（`__sse_responses`/`__sse_stream`）并使用 `defaultSseCodecRegistry` 解码为 JSON，或在协议匹配时直接透传。

**输入**
- Provider Response（可能包含 Readable）。
- `AdapterContext`（requestId、model hints）。

**输出**
- JSON payload（若 SSE 被解码），或标记“passthrough”信息供下游 stage 使用。

**依赖**
- `defaultSseCodecRegistry.get(protocol)`，支持 `openai-chat|openai-responses|anthropic-messages|gemini-chat`。
- Stage metadata 记录 `protocol`、`passthrough` 标志。

**错误落点**
- SSE decode 失败时记录错误并抛出协议错误；对“流内容其实是 JSON”的场景会先做 JSON 探测与回退处理。

**下一步**
- `resp_inbound_stage2_format_parse`：对 JSON payload 执行 format parse。
