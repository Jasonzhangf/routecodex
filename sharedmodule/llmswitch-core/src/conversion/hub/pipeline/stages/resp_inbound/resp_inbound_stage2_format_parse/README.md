# resp_inbound_stage2_format_parse

**目标**：利用 provider 协议对应的 FormatAdapter 解析响应 JSON，生成 `FormatEnvelope` 并保留 protocol 与 direction 信息。

**输入**
- SSE decode 后的 JSON（或原始 provider payload）。
- `AdapterContext`。

**输出**
- `FormatEnvelope`（direction=`response`）。

**依赖**
- Responses: `ResponsesFormatAdapter.parseResponse`；其他协议同理。

**错误落点**
- 响应缺失核心字段→抛出 Error。

**下一步**
- `resp_inbound_stage3_semantic_map`：映射到 ChatCompletion 形状。
