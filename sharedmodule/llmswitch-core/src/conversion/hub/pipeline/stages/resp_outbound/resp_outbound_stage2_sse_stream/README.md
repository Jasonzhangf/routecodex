# resp_outbound_stage2_sse_stream

**目标**：根据客户端协议与流式需求生成 `Readable` SSE 流或复用 provider 原生 SSE，确保 HTTP 层只需检测 `__sse_responses`。

**输入**
- Client-facing JSON（来自 stage1）。
- wantsStream flag、clientProtocol、requestId。
- Passthrough 状态（若 `resp_inbound_stage1_sse_decode` 标记可以直接透传）。

**输出**
- `Readable` (`__sse_responses`) 或保留 JSON（非流）。

**依赖**
- `defaultSseCodecRegistry`（`convertJsonToSse` / `convertSseToJson`）。
- SSE 事件生成策略（responses 输出 canonical `response.*` 事件）。

**错误落点**
- SSE 编解码失败时记录错误并回退到非流式响应；严重错误抛出以阻断返回。

**下一步**
- HTTP 层将 `body`/`__sse_responses` 写回客户端。
