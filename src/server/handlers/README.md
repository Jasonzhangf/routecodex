# Server Handlers

HTTP 路由处理器仅负责：
- Express 协议封装、SSE 心跳/错误帧。
- 调用 Hub Pipeline 并将结果返回客户端。

## 路由与映射
- `/v1/chat/completions` → `ChatHandler` → Hub Pipeline（Chat）
- `/v1/responses` → `ResponsesHandler` → Hub Pipeline（Responses）
- `/v1/messages` → `MessagesHandler` → Hub Pipeline（Anthropic）

## 关键实现
- `middleware.ts`：CORS、日志、错误映射。
- `llmswitch-loader.ts`：加载并初始化 Hub Pipeline。
- `provider-utils.ts`：注入 Provider runtime metadata。
- `http-error-mapper.ts`：Provider 错误 → HTTP 响应。

## 职责边界
**Do**
- 仅处理 HTTP 协议与 SSE 封装。
- 将请求体原样传递给 Hub Pipeline。
- 统一错误帧与预心跳（`preSSEHeartbeatDelayMs`）。

**Don't**
- 不在 handler 中解析/修改 payload。
- 不绕过 Hub Pipeline 直接调用 Provider。
- 不做工具治理或兜底逻辑。

## 调试
- 请求快照：`http-request` 节点记录原始 body。
- 错误帧：未开始 SSE 时返回 JSON；已开始则输出 `data: {"error":...}` + `[DONE]`。
