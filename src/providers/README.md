# Provider V2 模块

## 核心职责
Provider V2 仅负责：
- HTTP 通信（统一 baseUrl/headers/timeout/retry）。
- 认证管理（API Key / OAuth / TokenFile）。
- 请求/响应快照记录。
- 最小兼容层（GLM/Qwen/iFlow/LM Studio）通过 `ProviderComposite` 注入。

所有工具治理、路由决策、参数修复均由 `llmswitch-core` Hub Pipeline 完成；Host 不再自行修补 payload。

## 入口分层
```
routecodex-server → Hub Pipeline → ProviderComposite
                                  │
                                  ├─ compat/（最小字段修剪）
                                  └─ core/（HTTP 发送 + 快照）
```

## 关键文件
- `src/providers/core/runtime/*-http-provider.ts`：协议专用实现（Chat/Responses/Anthropic/Gemini）。
- `src/providers/core/strategies/`：OAuth 流程（device/code/hybrid）。
- `src/providers/compat/`：Provider 家族最小兼容，仅做字段映射与黑名单。
- `src/providers/core/utils/provider-error-reporter.ts`：统一错误上报到 `errorHandlingCenter`。

## 配置驱动
Provider runtime 由 `bootstrapVirtualRouterConfig` 生成，Host 在请求时注入 `ProviderRuntimeMetadata`；Provider 负责读取该元数据并执行。

## 调试
- Provider runtime 元数据在快照中可见（`provider.request.pre`）。
- 可通过 `src/debug/harnesses/provider-harness.ts` 干跑 provider 层。

## 贡献须知
- 新增 Provider 必须实现 `ChatHttpProviderBase`，并在 factory 注册。
- 兼容层仅做最小字段修剪，不得包含工具逻辑。
- 所有错误必须调用 `emitProviderError` 并附带 dependencies。
