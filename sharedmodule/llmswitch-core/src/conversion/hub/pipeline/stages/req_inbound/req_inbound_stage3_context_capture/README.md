# req_inbound_stage3_context_capture

**目标**：统一执行 Stage3 捕获逻辑：
- Responses 协议：提取 input/tools/response_format/parallel_tool_calls 等上下文，用于：
  - tool loop resume 的会话存储（`responses-conversation-store`）
  - 调试/快照记录（StageRecorder）
  - （必要时）为后续阶段提供 best-effort 的上下文摘要
- Chat/Anthropic/Gemini 协议：仍需执行 Stage3（即便不捕获内容），以便 StageRecorder 有一致的记录，也为后续扩展（如 tool call 补齐）留出钩子。

**输入**
- 原始请求 JSON。
- `AdapterContext`。

**输出**
- Responses：上下文捕获结果应进入 `ChatEnvelope.semantics.responses.context`（由语义映射阶段完成），Stage3 仅负责捕获/记录与 tool loop 存储。
- 其他协议：记录一个包含 `providerProtocol` 的快照，供 StageRecorder / 未来扩展使用。

**依赖**
- `captureResponsesContext`, `buildChatRequestFromResponses`（用于工具归一、system/instruction 复原）。
- `StageRecorder` snapshot（可记录上下文摘要，注意脱敏）。

**错误落点**
- 仅在 payload 非法导致 context 构造失败时抛出 Error；一般情况以 best-effort 写入 meta。

**下一步**
- `req_process_stage1_tool_governance`：工具治理使用 `ChatEnvelope`，meta 中的上下文继续透传。
