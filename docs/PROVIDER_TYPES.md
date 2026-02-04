# Provider 类型（type）说明

`virtualrouter.providers.<id>.type` 主要决定：
- 上游“线协议 / wire”（Chat / Responses / Messages / Gemini 等）
- Provider V2 选择的传输实现（openai/responses/anthropic/gemini…）

> 品牌/家族（glm、qwen、iflow、lmstudio…）建议通过 `id`、`compatibilityProfile`、`auth.type` 等表达，而不是把品牌写成协议类型。

## 推荐使用的 type

- `openai`：OpenAI Chat wire（`/v1/chat/completions`）以及 OpenAI-compatible Chat endpoint
- `responses`：OpenAI Responses wire（`/v1/responses`）
- `anthropic`：Anthropic Messages wire（`/v1/messages`）
- `gemini`：Gemini Chat wire
- `gemini-cli`：Gemini CLI wire（Cloud Code Assist；仅在需要时使用）
- `mock`：Mock Provider（测试/回归用）

## 常见组合（示例）

### 标准 OpenAI Chat（API Key）

```jsonc
{
  "id": "openai",
  "type": "openai",
  "baseURL": "https://api.openai.com/v1",
  // 推荐：用环境变量引用，config 可共享/可进 repo
  "auth": { "type": "apikey", "apiKey": "${OPENAI_API_KEY}" }
  // 兼容：也支持直接明文写入（不推荐）
  // "auth": { "type": "apikey", "apiKey": "sk-..." }
}
```

### OpenAI-compatible（例如 GLM/Qwen/Kimi 等）

仍然建议 `type: "openai"`，并通过 `compatibilityProfile` 做最小字段适配：

```jsonc
{
  "id": "qwen",
  "type": "openai",
  "baseURL": "https://portal.qwen.ai/v1",
  "compatibilityProfile": "chat:qwen",
  "auth": { "type": "qwen-oauth", "tokenFile": "default" }
}
```

### OpenAI Responses

```jsonc
{
  "id": "tab",
  "type": "responses",
  "baseURL": "https://api.tabcode.cc/openai",
  "auth": { "type": "apikey", "apiKey": "${TAB_API_KEY}" }
}
```
