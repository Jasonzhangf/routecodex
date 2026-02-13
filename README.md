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

### 1) 初始化（推荐用 `rcc`）

默认配置路径：
- macOS / Linux：`~/.routecodex/config.json`
- Windows：`%USERPROFILE%\\.routecodex\\config.json`

默认初始化（会把内置脱敏 quickstart 配置复制到目标路径）：

```bash
rcc init
```

按 provider 模板直接生成 v2（覆盖默认复制流程）：

```bash
rcc init --providers deepseek-web,tab,qwen --default-provider deepseek-web --camoufox --force
```

说明：
- `--providers` 使用 init 内置 provider id（见下文鉴权表）。
- `--camoufox` 会显式触发 Camoufox 环境准备（即使当前 provider 不强依赖）。
- `--force` 会先备份旧配置到 `config.json.bak*` 再重写。

如果你使用 dev CLI，把 `rcc` 替换成 `routecodex` 即可。

#### 1.1 推荐顺序（先 `--camoufox`，再 provider 化）

推荐按这 3 步执行：

1. 先跑 `rcc init --camoufox`
2. 再用 `rcc init --config ... --force` 把默认/v1 配置转换为 provider 分文件（v2）
3. 最后配置 key/token 并启动

示例：

```bash
# Step 1: 先做 camoufox 环境检查/准备
rcc init --camoufox

# Step 2: rcc init 已自动写入默认 quickstart；这里执行 v1 -> v2 转换
rcc init --config ~/.routecodex/config.json --force

# Step 3: 配置密钥与 token 后启动
rcc init --list-current-providers
rcc start --config ~/.routecodex/config.json
```

Step 2 完成后，provider 会拆分到：
- `~/.routecodex/provider/<providerId>/config.v2.json`

Step 3（配置密钥/token）的最小动作：
- API Key 类：设置环境变量（如 `OPENAI_API_KEY` / `TAB_API_KEY` / `GLM_API_KEY`）
- OAuth 类：执行 `rcc oauth qwen-auto qwen`、`rcc oauth gemini-auto gemini-cli`、`rcc oauth antigravity-auto antigravity`
- DeepSeek：在 `~/.routecodex/auth/deepseek-account-1.json` 写入 `mobile/password`，启动后自动回填 `access_token`

Windows PowerShell 对应写法：

```powershell
rcc init --camoufox
rcc init --config "$env:USERPROFILE\.routecodex\config.json" --force
rcc init --list-current-providers
rcc start --config "$env:USERPROFILE\.routecodex\config.json"
```

### 2) Camoufox 初始化（macOS / Windows）

`rcc init --camoufox` 会自动检查/安装 Camoufox。你也可以先手工准备：

macOS:

```bash
python3 -m pip install --user -U camoufox
python3 -m camoufox path
```

Windows (PowerShell):

```powershell
py -3 -m pip install --user -U camoufox
py -3 -m camoufox path
```

可选环境变量（当 Python 不在默认命令路径时）：
- `ROUTECODEX_PYTHON` / `RCC_PYTHON`：指定 Python 可执行文件路径
- `ROUTECODEX_CAMOUFOX_AUTO_INSTALL=0`：关闭自动安装（默认开启）

验证 Camoufox profile + 指纹是否可打开：

```bash
rcc camoufox antigravity-oauth-1-alias1.json
```

### 3) macOS / Windows 环境变量写法

macOS/Linux (zsh/bash):

```bash
export OPENAI_API_KEY="your_openai_key"
export TAB_API_KEY="your_tab_key"
export GLM_API_KEY="your_glm_key"
```

Windows PowerShell（当前会话）：

```powershell
$env:OPENAI_API_KEY="your_openai_key"
$env:TAB_API_KEY="your_tab_key"
$env:GLM_API_KEY="your_glm_key"
```

Windows PowerShell（持久化）：

```powershell
setx OPENAI_API_KEY "your_openai_key"
setx TAB_API_KEY "your_tab_key"
setx GLM_API_KEY "your_glm_key"
```

API key 类 provider 的常用环境变量（按 init 模板）：
- `OPENAI_API_KEY`
- `TAB_API_KEY`
- `GLM_API_KEY`
- `KIMI_API_KEY`
- `MODELSCOPE_API_KEY`
- `MIMO_API_KEY`

### 4) 按 init 内置 provider 配置鉴权

下表对应 `rcc init --list-providers` 的内置模板：

| Provider ID | 默认 auth 类型 | 你需要做什么 |
|------|------|------|
| `openai` | `apikey` | 设置 `OPENAI_API_KEY` |
| `tab` | `apikey` (responses) | 设置 `TAB_API_KEY` |
| `deepseek-web` | `deepseek-account` (`tokenFile` entries) | 准备 `~/.routecodex/auth/deepseek-account-*.json` |
| `glm` | `apikey` | 设置 `GLM_API_KEY` |
| `glm-anthropic` | `apikey` (`/v1/messages`) | 设置 `GLM_API_KEY` |
| `kimi` | `apikey` | 设置 `KIMI_API_KEY` |
| `modelscope` | `apikey` | 设置 `MODELSCOPE_API_KEY` |
| `lmstudio` | `apikey` (本地) | 通常可留空或填本地网关 key |
| `qwen` | `qwen-oauth` (`tokenFile=default`) | 先跑 OAuth 生成 token |
| `iflow` | `iflow-cookie` | 准备 `~/.routecodex/auth/iflow-work.cookie` |
| `mimo` | `apikey` | 设置 `MIMO_API_KEY` |
| `gemini-cli` | `gemini-cli-oauth` (`entries[].tokenFile`) | 先跑 OAuth 生成 token |
| `antigravity` | `antigravity-oauth` (`entries[].tokenFile`) | 先跑 OAuth 生成 token |

#### 4.1) Vision / Web Search 需要配置哪些 provider

这两个能力不是“自动可用”，需要你在路由里显式配置可用目标：

- `virtualrouter.routing.vision`：至少 1 个支持图像输入的 `provider.model`
- `virtualrouter.routing.web_search`：至少 1 个支持联网搜索的 `provider.model`

按当前 quickstart 的默认实践，推荐如下：

- Vision：`iflow.qwen3-vl-plus`（主）+ `tabglm.glm-4.6v`（备）
- Web Search：`iflow.glm-4.7`（主）+ `gemini-cli.gemini-2.5-flash-lite` / `tabglm.glm-4.7`（备）

如果你只使用 `rcc init` 内置 provider（不加 `tabglm` 自定义 provider），可先用这组：

- Vision：`iflow.qwen3-vl-plus`
- Web Search：`iflow.glm-4.7` + `gemini-cli.gemini-2.5-flash-lite`

最小检查原则：

- `routing.vision` / `routing.web_search` 里的每个 `provider.model`，都必须在对应 `~/.routecodex/provider/<providerId>/config.v2.json` 的 `models` 里存在
- 上述 provider 的鉴权必须先配好（apikey/oauth/cookie/tokenFile），否则会在启动时被跳过初始化

OAuth 认证命令（常用）：

```bash
rcc oauth qwen-auto qwen
rcc oauth gemini-auto gemini-cli
rcc oauth antigravity-auto antigravity
```

DeepSeek 单文件凭据 + token（同一文件）示例：

```json
{
  "mobile": "13800000000",
  "password": "your_password",
  "access_token": ""
}
```

放在 `~/.routecodex/auth/deepseek-account-1.json` 后，启动时会自动登录并回填 `access_token`。

### 5) 脱敏快速配置（来自当前线上配置）

已提供脱敏模板：
- `configsamples/config.v1.quickstart.sanitized.json`

快速使用：

```bash
rcc init
rcc start --config ~/.routecodex/config.json
```

此模板已经脱敏（API key、token、账号别名），保留了可直接复用的路由结构和 provider 组合。

#### 5.1) 用 `rcc init` 把本地 v1 配置转换为 v2

如果你要把 `configsamples/config.v1.quickstart.sanitized.json` 本地化成 v2（provider 分文件 + `virtualrouterMode: v2`），推荐直接用：

```bash
rcc init
rcc init --config ~/.routecodex/config.json --force
```

说明：
- `rcc init` 会检测到这是 v1 配置并执行迁移。
- `--force` 会跳过交互确认，适合脚本化/CI。
- 迁移后会生成 `~/.routecodex/provider/<providerId>/config.v2.json`，并备份原始 v1 文件为 `config.json.bak*`。

可选检查：

```bash
rcc init --list-current-providers
rcc start --config ~/.routecodex/config.json
```

### 6) 调用 API（示例）

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
- `configsamples/config.v1.quickstart.sanitized.json`
- `configsamples/provider/*/config.v1.json`

## 相关链接

- [npm package (@jsonstudio/rcc)](https://www.npmjs.com/package/@jsonstudio/rcc)
- [AGENTS.md](./AGENTS.md) - 项目原则与职责边界
- [sharedmodule/llmswitch-core](https://github.com/jsonstudio/llmswitch-core) - Hub Pipeline 详细说明
