# 内置 Provider 配置说明（virtualrouter.providers）

> 本文只描述“用户配置层”的 provider 写法（`~/.routecodex/config.json`）。运行时会被 llmswitch-core 规范化为 Provider V2 Profile 并交给 Provider V2 传输层执行。

## 通用字段

`virtualrouter.providers.<providerId>` 常用字段：

- `id`: provider 标识（建议与 key 一致）
- `enabled`: 是否启用（默认建议 `true`）
- `type`: provider 协议类型（见 `docs/PROVIDER_TYPES.md`）
- `baseURL` / `baseUrl` / `endpoint`: 上游 API Base URL（任一字段均可）
- `auth`: 认证配置（apiKey / oauth / cookie）
- `compatibilityProfile`: 兼容配置（如 `chat:qwen`、`chat:iflow`、`chat:glm`）
- `headers`: 额外请求头
- `process`: `chat`（默认）或 `passthrough`
- `models`: 模型列表（键为 modelId；值可写 `supportsStreaming`、`maxTokens`、`maxContext` 等）

## 认证字段（auth）

常见三类：

### 1) API Key

```jsonc
"auth": { "type": "apikey", "apiKey": "YOUR_API_KEY_HERE" }
```

### 2) OAuth（tokenFile）

```jsonc
"auth": { "type": "qwen-oauth", "tokenFile": "~/.routecodex/auth/qwen-oauth.json" }
```

### 3) Cookie（cookieFile）

```jsonc
"auth": { "type": "iflow-cookie", "cookieFile": "~/.routecodex/auth/iflow-work.cookie" }
```

## 各内置 Provider 的参考样本

仓库内已经提供了可直接复制的脱敏样本（port 只是示例，可自行改）。下面按 provider 逐个说明“你需要改什么/注意什么”。

### TAB（Responses）

- 样本：`configsamples/provider/tab/config.v1.json`
- 关键点：`type: "responses"`；建议保留 `responses.process: "chat"` + `responses.streaming`
- 你需要：填写 `auth.apiKey`

### CRS（Responses）

- 样本：`configsamples/provider/crs/config.v1.json`
- 关键点：同 TAB；模型列表通常更全
- 你需要：填写 `auth.apiKey`

### TABGLM（Anthropic Messages wire）

- 样本：`configsamples/provider/tabglm/config.v1.json`
- 关键点：`type: "anthropic"`（走 `/v1/messages` 协议）；`compatibilityProfile: "chat:claude-code"`（对齐 Claude Code 官方 system prompt 校验）
- 你需要：填写 `auth.apiKey`
- 说明：详见 `docs/providers/tabglm-claude-code-compat.md`

### GLM（OpenAI-compatible）

- 样本：`configsamples/provider/glm/config.v1.json`
- 关键点：`compatibilityProfile: "chat:glm"`；并示例了 `webSearch.engines` + `routing.web_search`
- 你需要：填写 `auth.apiKey`，并按需调整模型（`glm-4.7`、`glm-4.6v` 等）

### GLM（Anthropic Messages wire）

- 样本：`configsamples/provider/glm-anthropic/config.v1.json`
- 关键点：`type: "anthropic"`（走 `/v1/messages` 协议）；适用于某些上游只提供 anthropic 入口的场景
- 你需要：填写 `auth.apiKey`

### Qwen（OAuth）

- 样本：`configsamples/provider/qwen/config.v1.json`
- 关键点：`auth.type: "qwen-oauth"` + `auth.tokenFile` 指向你的 token 文件；`compatibilityProfile: "chat:qwen"`
- 你需要：先完成一次 OAuth 登录生成 tokenFile（或按你自己的路径修改 tokenFile）

### iFlow（OAuth）

- 样本：`configsamples/provider/iflow/config.v1.json`
- 关键点：`auth.type: "iflow-oauth"` + `auth.tokenFile`；`compatibilityProfile: "chat:iflow"`
- 你需要：先完成一次 OAuth 登录生成 tokenFile

### Kimi（API Key）

- 样本：`configsamples/provider/kimi/config.v1.json`
- 关键点：OpenAI-compatible wire；通常建议保留 `headers.User-Agent`
- 你需要：填写 `auth.apiKey`

### ModelScope（API Key）

- 样本：`configsamples/provider/modelscope/config.v1.json`
- 关键点：OpenAI-compatible wire；模型名常为带 namespace 的长字符串
- 你需要：填写 `auth.apiKey`

### LM Studio（本地）

- 样本：`configsamples/provider/lmstudio/config.v1.json`
- 关键点：`baseURL: "http://127.0.0.1:1234/v1"`；模型名通常来自本地加载的模型列表
- 你需要：确保 LM Studio 已启动并暴露 OpenAI endpoint；按需调整 `routing.default` 指向你本地可用的模型

### MiMo（API Key）

- 样本：`configsamples/provider/mimo/config.v1.json`
- 关键点：OpenAI-compatible wire（样本里是 `openai-standard`，等价地也可用 `openai`）
- 你需要：填写 `auth.apiKey`

建议用 `rcc init` 先生成骨架，再按上面对应 provider 的注意事项做精修（模型列表、routing 池子、auth 文件路径等）。
