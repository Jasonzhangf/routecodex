# Server Module

HTTP 服务与协议适配入口，承载 OpenAI/Anthropic 形状的 Chat 与 Responses 端点、SSE 流式传输、工具调用桥接等。

## 主要职责
- 路由到 Pipeline/Provider，整合 LLMSwitch 转换
- Chat 与 Responses 端点统一：工具调用标准化、SSE 事件聚合
- 流式管理与连接生命周期控制

## 目录概览
- `handlers/`：请求处理器（chat-completions.ts、responses.ts 等）
- `streaming/`：SSE/分块传输管理
- `conversion/`：与 llmswitch-core 的桥接
- `utils/`：请求/响应工具

