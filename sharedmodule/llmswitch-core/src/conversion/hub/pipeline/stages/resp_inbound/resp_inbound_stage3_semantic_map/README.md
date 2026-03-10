# resp_inbound_stage3_semantic_map

**目标**：将 `FormatEnvelope` 转换为 canonical ChatCompletion-like 对象（messages、choices、tool_calls），供响应治理共享使用。

**输入**
- `FormatEnvelope`（Responses/Chat/Anthropic/…）。
- `AdapterContext`。

**输出**
- ChatCompletion-like payload（`ResponseMapper.toChatCompletion` 结果）。

**依赖**
- Responses: `ResponsesResponseMapper`；其他协议：`OpenAIChatResponseMapper`、`AnthropicResponseMapper`、`GeminiResponseMapper`。

**错误落点**
- 协议不匹配或 mapper 转换失败时抛出 Error。

**下一步**
- `resp_process_stage1_tool_governance`：对响应执行工具治理。
