# routecodex & rcc

[![npm version](https://badge.fury.io/js/%40jsonstudio%2Frcc.svg)](https://www.npmjs.com/package/@jsonstudio/rcc)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

RouteCodex 项目提供两个 CLI 工具：

- **`routecodex`** (dev mode) - Development build with local `llmswitch-core` symlink
- **`rcc`** (release mode) - Production build from npm `@jsonstudio/rcc`

Both provide a **unified gateway for AI providers**, handling **routing + protocol conversion + tool call governance** across different upstream protocols.

> **Note**: This README covers both tools. For CLI-specific usage, see `docs/INSTALLATION_AND_QUICKSTART.md`.

## 主要功能

- **多入口同时支持（同一服务端口）**
  - OpenAI Chat：`POST /v1/chat/completions`
  - OpenAI Responses：`POST /v1/responses`
  - Anthropic Messages：`POST /v1/messages`
- **多 Provider / 多协议支持**
  - OpenAI-compatible、Anthropic、Gemini/Gemini CLI、GLM、Qwen、iFlow、LM Studio 等（按配置启用）。
  - 部分 Provider 支持 OAuth / token file（按配置启用）。
- **可配置路由**
  - 将不同"流量池/路由类别"（如 `default` / `thinking` / `tools` / `search` / `longcontext` 等）映射到不同 Provider 目标列表。
- **请求级"语法控制"**
  - **指定 Provider/模型**：`model` 可直接写成 `provider.model`（例如 `iflow.glm-4.7`）。
  - **路由指令**：可在用户文本中插入 `<**...**>` 指令（例如 `<**glm.glm-4.7**>`），详见 `docs/routing-instructions.md`。
- **Passthrough（透传）**
  - 可按 Provider 配置启用透传：只做鉴权/路由/日志，不做语义修补（适合严格 SSE 透传场景）。

## 安装

环境要求：Node.js 20+（推荐 LTS）。

### routecodex (dev mode)

```bash
# Build shared module first
npm --prefix sharedmodule/llmswitch-core run build

# Build host (dev)
npm run build:dev

# Install globally
npm run install:global

# Verify
routecodex --version
```

### rcc (release mode, recommended for production)

```bash
npm install -g @jsonstudio/rcc
rcc --version
```

升级/卸载：

```bash
npm update -g @jsonstudio/rcc
npm uninstall -g @jsonstudio/rcc
```

## 使用

### 1) 初始化配置并启动

```bash
routecodex init
routecodex start
```

或使用 release CLI：

```bash
rcc init
rcc start
```

默认配置路径：
- macOS / Linux：`~/.routecodex/config.json`
- Windows：`%USERPROFILE%\\.routecodex\\config.json`

`routecodex init` / `rcc init` 会在 `~/.routecodex/` 生成默认 `config.json`，并把常用文档复制到 `~/.routecodex/docs`。

如果配置文件已存在，需要重新生成模板：

```bash
routecodex init --force
# 或
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

### 入门指南
- **安装与快速上手**：`docs/INSTALLATION_AND_QUICKSTART.md`
- **OAuth（认证与刷新）**：`docs/OAUTH.md`
- **内置 Provider**：`docs/PROVIDERS_BUILTIN.md`
- **Provider 类型与协议**：`docs/PROVIDER_TYPES.md`

### 核心功能
- **路由指令/语法**：`docs/routing-instructions.md`
- **端口与入口**：`docs/PORTS.md`
- **Codex / Claude Code 集成**：`docs/CODEX_AND_CLAUDE_CODE.md`

### 架构与设计
- **架构总览**：`docs/ARCHITECTURE.md`
- **配置架构**：`docs/CONFIG_ARCHITECTURE.md`
- **V2 架构（历史参考）**：`docs/v2-architecture/README.md`
- **V3 入出站设计**：`docs/V3_INBOUND_OUTBOUND_DESIGN.md`

### 错误处理与调试
- **错误处理 V2**：`docs/error-handling-v2.md`
- **调试系统设计**：`docs/debug-system-design.md`

### 高级主题
- **路由策略**：`docs/ROUTING_POLICY_SCHEMA.md`
- **虚拟路由器优先级与健康**：`docs/VIRTUAL_ROUTER_PRIORITY_AND_HEALTH.md`
- **配额管理 V3**：`docs/QUOTA_MANAGER_V3.md`

### 开发者文档
- **源代码目录说明**：`src/README.md`
- **Provider 模块**：`src/providers/README.md`
- **配置模块**：`src/config/README.md`

## CLI 差异说明

| 特性 | routecodex (dev) | rcc (release) |
|------|------------------|---------------|
| 构建方式 | 本地构建 (`npm run build:dev`) | npm 发布包 |
| llmswitch-core | local symlink | npm `@jsonstudio/llms` |
| 共享模块构建 | 需要先 `npm --prefix sharedmodule/llmswitch-core run build` | 不需要 |
| 用途 | 开发、调试、测试 | 生产环境 |
| CLI 命令 | `routecodex` | `rcc` |

## 参考配置

- `configsamples/config.reference.json`
- `configsamples/provider/*/config.v1.json`

## 相关链接

- [npm package (@jsonstudio/rcc)](https://www.npmjs.com/package/@jsonstudio/rcc)
- [AGENTS.md](./AGENTS.md) - 项目原则与职责边界
- [sharedmodule/llmswitch-core](https://github.com/jsonstudio/llmswitch-core) - Hub Pipeline 详细说明
