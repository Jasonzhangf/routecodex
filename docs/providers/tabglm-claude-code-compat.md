# TabGLM（Anthropic）Claude Code 对齐（System Prompt compat）

tabglm 的 Anthropic 入口会对请求做“官方客户端”校验；当 `system` prompt 不符合 Claude Code 官方格式时，会返回：

- `HTTP 403` + `验证失败原因：System Prompt 不匹配 Claude Code 官方格式`

本仓库的修复原则是：**Host/CLI 不做硬编码**，通过 llmswitch-core 的 `compatibilityProfile` 在 compat 层完成对齐。

> 注意：部分 tabglm/Claude Code 兼容入口还会校验请求体是否包含顶层 `metadata` 字段；缺失时会返回 403（例如“缺少 metadata 字段”）。

## 启用方式（推荐：只改 config）

在 `~/.routecodex/config.json`（或你的自定义 config）里为 tabglm provider 开启 compat profile（必须显式配置，禁止推断）：

- 推荐：`virtualrouter.providers.tabglm.compatibilityProfile = "anthropic:claude-code"`
- 也支持：`virtualrouter.providers.tabglm.compatibilityProfile = "chat:claude-code"`

示例可参考：`configsamples/provider/tabglm/config.v1.json`

## compat 做了什么

当 `compatibilityProfile = chat:claude-code` 且协议为 `anthropic-messages` 时：

- 强制将请求体中的 `system` 设置为 Claude Code 官方字符串：
  - `You are Claude Code, Anthropic's official CLI for Claude.`
- 可选：将原有 `system` 内容移入 `messages` 的开头（默认开启），避免丢失原始指令内容。
- 确保请求体包含顶层 `metadata` 对象（允许为空），以通过某些 Claude Code 网关的格式校验。
- 同时为 Anthropic Provider 注入 Claude Code 必需的请求头（仅在未显式配置时补全）：
  - `User-Agent: claude-cli/...`
  - `X-App: claude-cli`
  - `X-App-Version: ...`
  - `anthropic-beta: ...`

## 快照验证（black-box）

开启 `routecodex start --snap` 后，检查对应请求的 `provider-request.json`：

- `body.system` 是否为上述官方字符串
- 旧的 system 是否被移动到了 `body.messages[0].content` 前缀（如果原本存在）
