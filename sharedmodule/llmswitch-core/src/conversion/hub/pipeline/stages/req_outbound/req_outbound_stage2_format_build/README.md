# req_outbound_stage2_format_build

**目标**：根据 FormatEnvelope 构造最终 provider 请求 JSON，并保证字段与 provider wire 完全对齐（例如 `/v1/responses` 的 `input[]`, `tool_outputs`, `response_format` 等）。

**输入**
- `FormatEnvelope`（来自 stage1）。
- `AdapterContext`（包含 outboundProfile、toolCallIdStyle）。

**输出**
- Provider wire JSON（将传给 Provider 层）。

**依赖**
- `ResponsesFormatAdapter.buildResponse`。
- Stage metadata（toolCallIdStyle、streamingHint）。

**错误落点**
- 输出非 JSON 或必填字段缺失时抛出 Error。

**下一步**
- Provider 层发送请求；响应回流后触发 `resp_inbound_stage1_sse_decode`。
