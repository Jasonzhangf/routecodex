# req_outbound_stage1_semantic_map

**目标**：将（处理后的）ChatEnvelope 再次映射为协议 FormatEnvelope，使用路由阶段写入的 target metadata，并按需恢复协议相关语义。

注意：在 `processMode=chat` 下，协议语义必须来自 `ChatEnvelope.semantics`（Chat Extension Protocol），不得依赖 `metadata.responsesContext` 之类的 legacy meta 存储。

**输入**
- `StandardizedRequest` 或 `ProcessedRequest`。
- Stage metadata（target providerProfile / route 选择结果等）。

**输出**
- `FormatEnvelope`：已带 outbound profile/endpoint。

**依赖**
- `ResponsesSemanticMapper.fromChat`（或协议对应 mapper）。
- 协议语义来源：`ChatEnvelope.semantics`（例如 Responses 的 `semantics.responses.context` / `semantics.responses.resume`）。

**错误落点**
- 缺少 context 或 mapper 失败 → 抛出 Error；需要保证 `req_inbound_stage3_context_capture` 已执行。

**下一步**
- `req_outbound_stage2_format_build`：调用 format adapter 生成 provider wire payload。
