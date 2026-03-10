# resp_process_stage1_tool_governance

**目标**：运行响应侧的工具治理，防止 provider 返回未授权的 tool_calls / tool_outputs，并同步记录治理摘要。

**输入**
- ChatCompletion-like payload。
- entry endpoint / requestId / providerProtocol。

**输出**
- 已治理的响应 JSON。
- Tool governance summary（写入 metadata）。

**依赖**
- `runChatResponseToolFilters`。
- `ToolGovernanceEngine.governResponse`。

**错误落点**
- 工具治理失败时抛出 Error 或返回 `summary.applied=false`（按现有策略）。

**下一步**
- `resp_process_stage2_finalize`：执行最终格式化与 `ProcessedRequest` 构建。
