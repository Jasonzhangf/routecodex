# req_inbound_stage1_format_parse

**目标**：将 `/v1/responses`、`/v1/messages`、`/v1/responses`(Gemini) 等入口协议的原始 JSON 请求解析为 `FormatEnvelope`。这是入站流水线的第一步，负责 schema 校验、基础清洗，以及为后续语义映射提供协议标识。

**输入**
- 原始请求 JSON 或由 SSE 解包后的 payload。
- `AdapterContext`（包含 entryEndpoint、providerProtocol）。

**输出**
- `FormatEnvelope`：`payload` 字段保存解析后的请求，`protocol` 记录 provider wire（例：`openai-responses`）。

**依赖**
- `ResponsesFormatAdapter.parseRequest`（Responses 为基线，其他协议可替换对应 adapter）。
- StageRecorder 将使用本 stage id `req_inbound_stage1_format_parse` 进行快照。

**错误落点**
- 非 JSON 或协议字段缺失 → 抛出 `ConversionError` 并终止流水线。

**下一步**
- `req_inbound_stage2_semantic_map`：使用同一个 `FormatEnvelope` 生成 `ChatEnvelope`。
