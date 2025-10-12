# Provider 模块说明（GLM HTTP Provider）

本目录包含各类 Provider 实现。其一：GLM HTTP Provider（`glm-http-provider`）。

## GLM HTTP Provider 特性

- 直接通过 HTTP 访问智谱 GLM Coding API（`/chat/completions`）。
- 认证：Bearer Token（支持 `auth.apiKey` 或 `auth.token`）。
- 超时：可通过 `GLM_HTTP_TIMEOUT_MS` 或 `RCC_UPSTREAM_TIMEOUT_MS` 配置（默认 300000ms）。
- 诊断：会在 `~/.routecodex/codex-samples/` 下保存最终上游载荷快照（`provider-out-glm_*.json`）。

## 近期变更（1210 兼容）

- 历史消息中的 `assistant.tool_calls` 会在 Compatibility/预检阶段被移除（仅“非最后一条”），以避免上游返回 1210 错误。工具功能、`tool` 角色消息与 `tools` 定义仍然保留。

## 环境变量

- `GLM_HTTP_TIMEOUT_MS` 或 `RCC_UPSTREAM_TIMEOUT_MS`：上游 HTTP 请求超时。
- `RCC_GLM_FEATURE_TOOLS`：是否启用工具功能（默认启用；设为 `0` 可关闭）。

## 日志与诊断

- 上游错误（4xx/5xx/超时）会通过 ErrorHandlingCenter 记录并映射到统一错误体；同时在调试中心（DebugCenter）记一条事件，便于回溯。

## 更新（0.41.1）

- 与路由层配合，Anthropic 端点流式输出已对齐规范：当上游为 OpenAI 形态时，路由层会合成标准 SSE 事件序列（包含 tool_use 输入），避免客户端在累积阶段出现空参数工具调用。
