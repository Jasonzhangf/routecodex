# req_inbound_stage2_semantic_map

**目标**：把 `FormatEnvelope` 映射为 `ChatEnvelope`，并应用协议特定的 bridge policy（Responses：system 合并、工具名称规范化；Anthropic/Gemini：各自语义映射），确保所有请求走同一个 Chat 语义层。

**输入**
- Stage1 产出的 `FormatEnvelope`。
- `AdapterContext` 与 stage metadata。

**输出**
- `ChatEnvelope`：标准化 messages、tools、parameters。

**依赖**
- `ResponsesSemanticMapper.toChat`（或协议对应的 SemanticMapper）。
- `responses-openai-bridge` 中的 policy action（通过 mapper 调用）。

**错误落点**
- 缺失必要字段（model/messages）或 policy 执行失败时抛出标准 Error，由 Hub 捕获并记录 stage id。

**下一步**
- `req_inbound_stage3_context_capture`：额外捕获 Responses 特有上下文供后续出站复用。
