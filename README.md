# RouteCodex

[![npm version](https://badge.fury.io/js/%40jsonstudio%2Frcc.svg)](https://www.npmjs.com/package/@jsonstudio/rcc)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

RouteCodex 是一个 **多 Provider 的 AI 代理网关**：为 Codex、Claude Code，以及任何 OpenAI-compatible 客户端提供统一入口，并在不同上游协议之间完成 **路由 + 协议转换 + 工具调用治理**。

## 主要功能

- **多入口同时支持（同一服务端口）**
  - OpenAI Chat：`POST /v1/chat/completions`
  - OpenAI Responses：`POST /v1/responses`
  - Anthropic Messages：`POST /v1/messages`
- **多 Provider / 多协议支持**
  - OpenAI-compatible、Anthropic、Gemini/Gemini CLI、GLM、Qwen、iFlow、LM Studio 等（按配置启用）。
  - 部分 Provider 支持 OAuth / token file（按配置启用）。
- **可配置路由**
  - 将不同“流量池/路由类别”（如 `default` / `thinking` / `tools` / `search` / `longcontext` 等）映射到不同 Provider 目标列表。
- **请求级“语法控制”**
  - **指定 Provider/模型**：`model` 可直接写成 `provider.model`（例如 `iflow.glm-4.7`）。
  - **路由指令**：可在用户文本中插入 `<**...**>` 指令（例如 `<**glm.glm-4.7**>`），详见 `docs/routing-instructions.md`。
- **Passthrough（透传）**
  - 可按 Provider 配置启用透传：只做鉴权/路由/日志，不做语义修补（适合严格 SSE 透传场景）。

> Release CLI：`@jsonstudio/rcc`（命令 `rcc`）

## 安装

环境要求：Node.js 20+（推荐 LTS）。

```bash
npm install -g @jsonstudio/rcc
rcc --version
```

## 使用

### 1) 初始化配置并启动

```bash
rcc init
rcc start
```

默认配置路径：
- macOS / Linux：`~/.routecodex/config.json`
- Windows：`%USERPROFILE%\\.routecodex\\config.json`

`rcc init` 会在 `~/.routecodex/` 生成默认 `config.json`，并把常用文档复制到 `~/.routecodex/docs`。

如果配置文件已存在，需要重新生成模板：

```bash
rcc init --force
```

它会先备份旧配置为 `config.json.bak`（或 `config.json.bak.N`），再生成新模板。

### 2) 调用 API（示例）

健康检查：

```bash
curl http://127.0.0.1:5555/health
```

OpenAI Chat：

```bash
curl http://127.0.0.1:5555/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"iflow.glm-4.7","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

OpenAI Responses：

```bash
curl http://127.0.0.1:5555/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"tab.gpt-5.2","input":[{"role":"user","content":"hi"}],"stream":false}'
```

Anthropic Messages：

```bash
curl http://127.0.0.1:5555/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic.claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 文档

- 安装与快速上手：`docs/INSTALLATION_AND_QUICKSTART.md`
- OAuth（认证与刷新）：`docs/OAUTH.md`
- 内置 Provider：`docs/PROVIDERS_BUILTIN.md`
- Provider 类型与协议：`docs/PROVIDER_TYPES.md`
- 路由指令/语法：`docs/routing-instructions.md`
- 端口与入口：`docs/PORTS.md`
- Codex / Claude Code 集成：`docs/CODEX_AND_CLAUDE_CODE.md`
