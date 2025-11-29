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
- Provider：`generic-responses`
  - 文件：`src/modules/pipeline/modules/provider/generic-responses.ts`。
  - 非流：POST `${baseUrl}/responses`；流式：同 URL + `Accept: text/event-stream`。
  - 认证：`Authorization: Bearer ${GENERIC_RESPONSES_API_KEY}`；头：`OpenAI-Beta: responses-2024-12-17`（允许 env 覆盖）。
  - 错误：原样透传上游 `{"error":{...}}`。
  - 可选快照：`~/.routecodex/codex-samples/responses-replay/provider-out-generic_*.json`、`sse-events-<RID>.log`。
- LLMSwitch：`llmswitch-responses-passthrough`
  - 文件：`src/modules/pipeline/modules/llmswitch/llmswitch-responses-passthrough.ts`。
  - transformRequest/Response：严格透传，仅做形状校验；失败 400；不做 Responses↔Chat 转换。
- 模块注册
  - `src/modules/pipeline/core/pipeline-registry.ts` 注册 `generic-responses` 与 `llmswitch-responses-passthrough`。
- 装配器消费
  - `src/modules/pipeline/config/pipeline-assembler.ts` 放行上述类型（仅消费 bootstrap 产出的 virtualRouter，严禁默认回退）。
- Handler 路由
  - `src/server/handlers/responses.ts` 严格按 virtualRouter 配置选取 `openai.responses.generic` 管线处理 `/v1/responses`，禁用任何转换兜底。
- Streaming
  - `src/server/utils/streaming-manager.ts` 透传 Responses SSE 事件序列（不拼接、不改序）。

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
