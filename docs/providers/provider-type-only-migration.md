# Provider 按协议类型划分（Type-only）迁移指南

本文档描述从“按品牌/家族（glm/qwen/iflow/lmstudio）”到“按协议类型（openai/responses/anthropic/gemini）”的迁移要求与示例。

## 目标

- Provider 仅以协议类型作为 `providerType`：
  - `openai`（OpenAI Chat wire）
  - `responses`（OpenAI Responses wire）
  - `anthropic`（Anthropic Messages wire）
  - `gemini`（预留）
- 品牌/家族名仅作为 `providerId` 或 OAuth `extensions.oauthProviderId` 使用。
- `providerProtocol` 由 BasePipeline 路由阶段注入，Provider/Composite 只做守卫，不自行推断。

## 迁移规则

1. 配置层
   - 将原 `providerType: 'glm'|'qwen'|'iflow'|'lmstudio'` 替换为 `providerType: 'openai'`。
   - 将家族名写入：
     - `providerId`（路由家族）；或
     - `config.extensions.oauthProviderId`（OAuth 场景）。
   - Responses/Anthropic 按照协议类型分别设置 `providerType: 'responses' | 'anthropic'`。

2. 代码层
   - Factory 改为 protocol-first 选择 Provider；对旧配置自动规范化并打印告警。
   - 兼容逻辑内聚到 ProviderComposite，品牌差异由 openai-compat-aggregator 内部处理（最小清理）。

## 配置示例

### Qwen（OAuth）

```json
{
  "type": "openai-standard",
  "config": {
    "providerType": "openai",
    "baseUrl": "https://portal.qwen.ai/v1",
    "auth": { "type": "oauth" },
    "extensions": { "oauthProviderId": "qwen" },
    "models": ["qwen3-coder-plus"]
  }
}
```

### GLM（API Key）

```json
{
  "type": "openai-standard",
  "config": {
    "providerType": "openai",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "auth": { "type": "apikey", "apiKeyEnv": "GLM_API_KEY" },
    "models": ["glm-4"]
  }
}
```

### iFlow（OAuth）

```json
{
  "type": "openai-standard",
  "config": {
    "providerType": "openai",
    "baseUrl": "https://api.iflow.com/v1",
    "auth": { "type": "oauth" },
    "extensions": { "oauthProviderId": "iflow" },
    "models": ["iflow-gpt4-1106"]
  }
}
```

### Responses（真实 /v1/responses wire）

```json
{
  "type": "responses-http-provider",
  "config": {
    "providerType": "responses",
    "baseUrl": "https://api.openai.com/v1",
    "auth": { "type": "apikey", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

### Anthropic Messages

```json
{
  "type": "anthropic-http-provider",
  "config": {
    "providerType": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1",
    "auth": { "type": "apikey", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  }
}
```

## 运行期元数据（供调试校验）

`attachProviderRuntimeMetadata(payload, meta)` 注入字段：

```ts
{
  requestId, pipelineId, routeName,
  providerId, providerKey,
  providerType, providerProtocol,
  target: { model, providerType, providerKey }
}
```

ProviderComposite 在出/入站两侧校验 `providerType → providerProtocol`，并对协议形状做最小断言，快速暴露错配。

