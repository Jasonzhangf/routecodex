# Server Handlers（HTTP 协议层）

本模块负责各 HTTP 端点的协议层处理与委托：/v1/chat/completions、/v1/responses、/v1/messages。

## 职责（Do）
- HTTP 协议处理：入参读取、SSE 头设置、错误帧输出。
- 认证/鉴权（按上层策略）。
- SSE 预心跳与最小错误帧（`NO_CORE_SSE`）。
- 委托：将请求封装为 SharedPipelineRequest 并交给 Pipeline 处理。

## 禁止（Don't）
- 工具处理或工具语义修复（由 llmswitch-core 统一处理）。
- 业务逻辑或 Provider/Compatibility 的字段修复。
- 响应语义变更（仅协议层输出）。

## 关键文件
- chat-handler.ts：OpenAI Chat SSE 端点
- responses-handler.ts：OpenAI Responses SSE 端点
- messages-handler.ts：Anthropic Messages 端点

## 备注
- /v1/responses：优先透传来自 core 的 `__sse_responses`；否则输出最小错误帧并 `[DONE]`。

