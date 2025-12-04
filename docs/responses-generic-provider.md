# OpenAI Responses 透传通路（generic-responses）设计说明

目标
- 在 `/v1/responses` 下提供一条“严格透传”的 Responses 流水线：请求/响应完全遵循 OpenAI Responses 规范，无跨协议转换、无兜底。
- 在 `./sharedmodule` 的配置模块中新增 provider 家族 `generic_responses`，由配置引擎解析 `config.toml` 并产出 `virtualRouter`/`targetRuntime`（经 `bootstrapVirtualRouterConfig` 生成）；本仓仅消费该产物并完成模块接线。

配置（config.toml 输入）
- provider
  - `[model_providers.generic_responses]`
  - `name = "generic_responses"`
  - `base_url = "https://api.example.com/v1"`
  - `env_key = "GENERIC_RESPONSES_API_KEY"`
  - `wire_api = "responses"`
- 路由
  - `[routes.responses]`
  - `default = "generic_responses"`
- 可选 key 映射
  - `[keys.providers.generic_responses]`
  - `key1 = "GENERIC_RESPONSES_API_KEY"`

sharedmodule 改动（配置引擎与兼容映射）
- config-engine（解析/校验）
  - 新增 family: `generic_responses` 的 schema 与解析逻辑。
  - 校验必填：`base_url`、`env_key`、`wire_api=responses`。
  - 归一化输出 provider 记录：`type: "generic-responses"`，`config: { baseUrl, auth: { apiKey: "${GENERIC_RESPONSES_API_KEY}" } }`。
  - 解析 `[routes.responses]`，校验 `default` 指向有效的 `generic_responses` provider。
- config-compat（生成装配输入）
  - pipelines += `openai.responses.generic`：
    - `compatibility: { type: "passthrough-compatibility" }`
    - `llmSwitch: { type: "llmswitch-responses-passthrough" }`
    - `provider: { type: "generic-responses", config: { baseUrl, auth: { apiKey } } }`
  - routePools["/v1/responses"] = ["openai.responses.generic"].
  - routeMeta["openai.responses.generic"] = `{ providerId: "generic_responses", modelId: "responses", keyId: "key1" }`。
  - compatibilityConfig.keyMappings.providers.generic_responses.key1 = `${GENERIC_RESPONSES_API_KEY}`。
  - 严格模式：未配置 `routes.responses` 时不生成上述管线/路由。
- config-testkit（如有）
  - 新增用例：最小配置、缺失 routes.responses、env_key 注入校验。

virtualRouter 期望（关键片段）
- `virtualRouter.routing["/v1/responses"]` 指向 `openai.responses.generic`。
- `virtualRouter.pipelines` 包含：
  - id: `openai.responses.generic`
  - modules:
    - `compatibility: { type: "passthrough-compatibility", config: {} }`
    - `llmSwitch: { type: "llmswitch-responses-passthrough", config: {} }`
    - `provider: { type: "generic-responses", config: { baseUrl, auth: { apiKey } } }`
- `targetRuntime["openai.responses.generic"]` = `{ providerId: "generic_responses", modelId: "responses", keyId: "key1", ... }`。
- `keyMappings.providers.generic_responses.key1 = "${GENERIC_RESPONSES_API_KEY}"`。

本仓接线与运行时模块
- Provider：
  - `src/providers/core/runtime/responses-provider.ts`：完整 Responses SSE 透传实现，负责 real-time `/responses` 请求、上游 SSE → Host JSON 的转换，以及快照写入。
  - `src/providers/core/runtime/responses-http-provider.ts`：OpenAI Responses HTTP 直连 Provider（继承 `ChatHttpProvider`，统一通过 provider 层发送请求）。
- LLMSwitch：`llmswitch-responses-passthrough`
  - 逻辑位于 `sharedmodule/llmswitch-core`，Host 仅通过 `src/modules/llmswitch/bridge.ts` 间接调用，保持“llmswitch-core owns routing/tools”的约束。
- 模块注册
  - 由 llmswitch-core 的 pipeline registry 统一管理，Host 不再手动注册 Provider/LLMSwitch 组合，避免与 `bootstrapVirtualRouterConfig` 产物冲突。
- 装配器消费
  - 管线装配逻辑也在 llmswitch-core 内，Host 仅接收 virtualRouter + targetRuntime 并实例化 provider/runtime。
- Handler 路由
  - `src/server/handlers/responses-handler.ts` 按 virtualRouter pipelines 选择 `openai.responses.*` 管线处理 `/v1/responses`，禁用兜底。
- Streaming
  - Responses SSE 的透传/解析由 `src/providers/core/runtime/responses-provider.ts` 直接处理（Provider 层解析 SSE，再回写 JSON 响应）。

校验与错误策略
- 请求：缺失必填字段/类型不符 → 400（conversion_error），不 fallback 到 Chat。
- 响应：原样返回；SSE 事件名/载荷/顺序不改动；解析失败 → 中断并映射 502。
- 工具链：`required_action.submit_tool_outputs` 原样透传，不文本化。

落盘与回放
- 目录：`~/.routecodex/codex-samples/responses-replay`。
- 文件：`raw-request_req_*.json`、`provider-out-generic_*.json`、`sse-events-<RID>.log`。
- 脚本（新增）：
  - `scripts/verify-responses-passthrough.mjs`：对比 raw-request 与 provider-out 正文字段一致（headers/trace 差异允许）。
  - `scripts/replay-responses.mjs`：批量回放样本校验一致性。

执行计划
1) sharedmodule/config-engine：
   - 新增 family `generic_responses` 的 schema 与解析；解析 `[routes.responses]`；输出规范 provider 与 routes。
2) sharedmodule/config-compat：
   - 生成 `openai.responses.generic` 管线与 routePools/routeMeta/keyMappings；严格模式无 fallback。
3) 本仓接线：
   - Provider `generic-responses`、LLMSwitch `llmswitch-responses-passthrough` 实现与注册；Assembler 放行类型；Responses Handler 固定直通。
4) 校验工具：
   - 新增 `scripts/verify-responses-passthrough.mjs`、`scripts/replay-responses.mjs`；准备 10 非流 + 10 流式样本自检。
5) 文档与发布：
   - 更新 README/变更日志；bump 版本，构建与全局安装（不自启动）。
