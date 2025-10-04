# OpenAI Router 模块

本模块提供 OpenAI 兼容的 API 路由与流式（SSE）桥接，集成错误处理与预心跳机制。

## 近期变更（错误可见性与预心跳优化）

- 优先返回 JSON 错误：若请求为流式（`stream=true`）但尚未开始发送 SSE 头（`headersSent=false`），当出现上游/内部错误时，直接返回 HTTP 错误（4xx/5xx，包含 `error.code` 与 `error.message`），避免“静默停止”。
- SSE 错误块：若 SSE 已启动，则输出包含错误信息的 SSE 块后再发送 `[DONE]` 结束，不再发送“空块+DONE”。
- 预心跳延迟：在启动 SSE 预心跳前加入短延迟窗口（默认 800ms），以便早期错误能够走 JSON 错误路径，提升可见性。

## 环境变量

- `RCC_PRE_SSE_HEARTBEAT_DELAY_MS`（默认 800）：预心跳启动前的延迟，单位 ms。
- `RCC_PRE_SSE_HEARTBEAT_MS`（默认 3000）：预心跳间隔，单位 ms。设为 0 可禁用预心跳循环。
- `RCC_SSE_HEARTBEAT_MS`（默认 15000）：SSE 桥接的心跳间隔。
- `RCC_SSE_HEARTBEAT_MODE=chunk|comment`（默认 chunk）：心跳以 OpenAI chunk 还是 SSE 注释行输出。
- `RCC_SSE_HEARTBEAT_USE_REASONING=0|1`（默认 0）：是否将心跳文本写入 reasoning_content（仅 chunk 模式）。

## 错误映射

- 路由统一构造 OpenAI 风格的错误体，包含：
  - `error.message`：错误信息
  - `error.type`：错误类型（如 `server_error`/`bad_request` 等）
  - `error.code`：错误代码
  - `error.details`：最小化的调试细节，例如 `requestId`、`provider`、`upstreamStatus` 等

## 使用建议

- 当客户端需要流式输出，仍可以获得明确错误提示（JSON 或包含信息的 SSE 块）。
- 若希望尽量以 JSON 错误返回，可适当增大 `RCC_PRE_SSE_HEARTBEAT_DELAY_MS`。
