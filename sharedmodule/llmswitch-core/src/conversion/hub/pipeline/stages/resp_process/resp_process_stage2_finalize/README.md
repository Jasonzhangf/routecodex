# resp_process_stage2_finalize

**目标**：将治理后的响应按照 entry endpoint 期望进行 finalize（model override、reasoning strip/append、processedRequest 构建）。

**输入**
- 治理后的 ChatCompletion-like payload。
- `AdapterContext`（entryEndpoint、model hints、wantsStream）。

**输出**
- Finalized OpenAI Chat payload。
- `ProcessedRequest`（由 `buildProcessedRequestFromChatResponse` 生成）。

**依赖**
- `finalizeOpenAIChatResponse`。
- `buildProcessedRequestFromChatResponse`。
- 环境变量 `ROUTECODEX_CHAT_REASONING_MODE` 控制 reasoning 投影。

**错误落点**
- finalize 失败或 processedRequest 构建异常时抛出 Error。

**下一步**
- `resp_outbound_stage1_client_remap`：根据入口协议生成最终客户端 payload。
