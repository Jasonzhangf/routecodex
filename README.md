# RouteCodex – 多提供商 AI 代理

[![npm version](https://badge.fury.io/js/%40jsonstudio%2Frcc.svg)](https://www.npmjs.com/package/@jsonstudio/rcc)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)

RouteCodex 是 JSON Studio 推出的多提供商 AI 代理，提供统一的 OpenAI / Anthropic / Responses / Gemini 入口，自动完成协议转换、工具治理、速率控制与快照审计。项目包含两个分发形态：

- **Release CLI (`@jsonstudio/rcc`)**：给终端用户的 npm 包，自带 `rcc` 命令。
- **Dev Worktree (`routecodex`)**：本仓库源码，开发者可修改、构建并贡献。

本文档面向 release 使用者与贡献者，覆盖架构、安装、配置与常见操作。

---

## 架构总览

### 单一执行路径

```
HTTP Server → llmswitch-core Hub Pipeline → Provider V2 Runtime → 上游 AI API
```

- **Hub Pipeline（llmswitch-core）**：唯一的工具治理点，完成协议归一、tool call 修复、路由决策、SSE 处理。
- **Provider V2**：纯运输层，只负责认证、重试和兼容性 hook；不解析或修改用户语义。
- **Compatibility**：按 upstream 协议最小字段映射，确保 usage / finish_reason / required_action 一致。
- **Host (RouteCodexHttpServer)**：只做 HTTP/SSE 封装、配置加载与 provider 生命周期管理。

### 模块职责矩阵

| 模块 | 代码位置 | 职责 | 禁止行为 |
| --- | --- | --- | --- |
| HTTP Server | `src/server/runtime/http-server` | Express 路由、SSE 包装、调用 Hub Pipeline | 工具决策、路由逻辑、配置拼装 |
| Hub Pipeline | `sharedmodule/llmswitch-core` | 请求标准化、tool_calls 统一处理、虚拟路由 | 进行 HTTP 请求、处理认证 |
| Provider V2 | `src/providers` | 请求签名、HTTP 发送、快照输出 | 解析/修复工具调用、修改配置 |
| Compatibility | `sharedmodule/llmswitch-core/src/conversion/compat/*` | 上下游字段映射、最小清理 | 工具解码、兜底 try/catch |

更多细节请参考 `docs/ARCHITECTURE.md` 与 `docs/CONFIG_ARCHITECTURE.md`。

---

## 安装与升级

### 环境要求
- Node.js 20.x（20.11 及以上，<26）
- npm 9.x 或 10.x
- macOS / Linux：bash 或 zsh
- Windows：PowerShell 5.1+ 或 Windows Terminal

### Release CLI（推荐）

> CLI 名称：`rcc`，包名：`@jsonstudio/rcc`

**macOS / Linux**
```bash
npm install -g @jsonstudio/rcc
rcc --version
```

**Windows（PowerShell）**
```powershell
npm install -g @jsonstudio/rcc
rcc --version
```

安装成功后，`rcc --version` 会显示形如 `0.89.xxx (release)` 的版本信息；可通过 `npm update -g @jsonstudio/rcc` 升级，`npm uninstall -g @jsonstudio/rcc` 卸载。

### Dev CLI（本仓库）
开发者使用以下命令安装 dev CLI（必须先构建 sharedmodule）：

```bash
npm --prefix sharedmodule/llmswitch-core run build
npm run build:dev
npm run install:global
```

> ⚠️ 禁止：`routecodex` 只用于本地调试，严禁发布到 npm。发布 `@jsonstudio/rcc` 必须使用 `npm run install:release`。

---

## 默认目录结构

| 系统 | 主配置 | Provider 配置 | 日志 / 快照 |
| --- | --- | --- | --- |
| macOS / Linux | `~/.routecodex/config.json`（或 `ROUTECODEX_CONFIG_PATH` 指定路径） | `~/.routecodex/provider/<name>/config.v1.json` | `~/.routecodex/logs`、`~/.routecodex/codex-samples/*` |
| Windows | `%USERPROFILE%\.routecodex\config.json` | `%USERPROFILE%\.routecodex\provider\<name>\config.v1.json` | `%USERPROFILE%\.routecodex\logs` 等 |

RouteCodex 会按以下优先级查找配置：

1. CLI 参数 `--config <path>`
2. 环境变量 `ROUTECODEX_CONFIG_PATH`
3. 默认路径（见上表）

---

## 无密钥配置样本

仓库附带了一份不含真实密钥的示例：`samples/configs/openai-chat-sample.json`。复制到本地后，只需提供环境变量即可启动。

```json
{
  "httpserver": { "host": "127.0.0.1", "port": 5555 },
  "virtualrouter": {
    "providers": {
      "demo.glm": {
        "providerType": "openai",
        "protocol": "openai-chat",
        "baseUrl": "https://api.example.com/v1",
        "auth": { "type": "apikey", "env": "GLM_API_KEY" },
        "models": {
          "glm-4.6": {
            "supportsStreaming": true,
            "profiles": ["glm-default"]
          }
        }
      }
    },
    "routing": {
      "default": ["demo.glm.glm-4.6"]
    }
  }
}
```

使用步骤：

1. **复制样本**
   ```bash
   mkdir -p ~/.routecodex
   cp samples/configs/openai-chat-sample.json ~/.routecodex/config.json
   ```
2. **提供密钥（示例为环境变量）**
   - macOS / Linux：`export GLM_API_KEY="sk-your-key"`
   - Windows：`setx GLM_API_KEY "sk-your-key"`
3. **启动**
   ```bash
   rcc start --config ~/.routecodex/config.json
   ```
4. **验证**
   - 健康检查：`curl http://127.0.0.1:5555/health`
   - Chat API：`curl http://127.0.0.1:5555/v1/chat/completions ...`

> 样本仅用于演示。请把 `baseUrl` / `routing` 更新为真实 provider，再通过环境变量、`authfile-*` 或 Secret 管理工具提供密钥。

### 自定义路由关键字

虚拟路由器内置了一组默认关键字（如 `思考/think` → `thinking` 路由，`vision/image` → `vision` 路由）。若希望在不覆盖默认词表的前提下追加命中词，可以在用户配置中加入 `virtualrouter.classifier.keywordInjections`：

```json
{
  "virtualrouter": {
    "classifier": {
      "keywordInjections": {
        "thinking": ["慢慢分析", "stepwise"],
        "vision": ["截图如下"],
        "background": ["context dump please"]
      }
    }
  }
}
```

- 字段名对应路由类别（`thinking` / `background` / `vision` / `coding`），只需写新增词条即可，默认常量会自动保留。
- 若同一词出现在多个路由，将沿用 `ROUTE_PRIORITY`（`longcontext → thinking → vision → ...`）顺序做匹配。
- 更新配置文件后重启服务即可生效。

---

## 快速使用

1. **准备配置**：如上所述放置 `config.json` 或使用 `--config` 指定文件。
2. **启动 release server**
   ```bash
   rcc start --config ~/.routecodex/config.json
   ```
   CLI 会输出健康检查地址、配置文件路径和当前版本。
3. **调用 API**
   - OpenAI Chat：`POST /v1/chat/completions`
   - OpenAI Responses：`POST /v1/responses`
   - Anthropic：`POST /v1/messages`
4. **开发者模式**
   - `rcc code ...`：启动 Claude Code 并把所有请求代理到本地 RouteCodex。
   - `rcc start --exclusive`：独占端口，自动终止旧实例。

---

## 配置与密钥管理

- **AuthFile 引用**：在配置中使用 `authfile-<name>`，RouteCodex 会读取 `~/.routecodex/auth/<name>`。适用于多账号切换。
- **环境变量**：将 `auth.type` 设为 `apikey` 且 `env` 字段指定变量名，server 会在启动时解析。
- **provider profiles**：`src/providers/profile/` 定义了各 provider 允许的协议、Auth 方式及兼容 profile，可在配置中通过 `profiles` 字段引用。

更多细节见 `docs/CONFIG_ARCHITECTURE.md`。

---

## 开发者工作流

1. **克隆仓库并安装依赖**
   ```bash
   git clone https://github.com/jsonstudio/routecodex.git
   cd routecodex
   npm install
   ```
2. **构建 sharedmodule（必要）**
   ```bash
   npm --prefix sharedmodule/llmswitch-core run build
   ```
3. **编译与验证**
   ```bash
   npm run build:dev              # 生成 dist 并执行工具链验证
   npm run install:global         # 安装本地版 routecodex CLI
   ```
4. **与 release 区分**
   - Release：使用 npm 安装 `@jsonstudio/rcc`
   - Dev：仓库内 `routecodex` CLI，支持 `npm run start:bg` 等脚本

---

## 故障排查

| 症状 | 检查点 |
| --- | --- |
| `config:core:run` 提示缺失 | Release CLI 默认跳过动态 pipeline 生成；自定义流程可设置 `config:core:run` 脚本。 |
| SSE 变为 JSON | 检查入口 `stream` 字段与客户端 `Accept` 头；RouteCodex 会根据 inbound 请求保持一致。 |
| usage 始终 100% | 确保配置启用了对应 provider 的 `supportsStreaming`，并检查 `~/.routecodex/codex-samples/*` 快照确认 usage 字段已写入。 |
| Release install 验证失败 | 查看 `/tmp/routecodex-release-verify-*.log`；脚本位于 `scripts/install-verify.mjs`，可单独执行 `node scripts/install-verify.mjs --launcher cli --cli-binary rcc ...`。 |

---

## TOON 工具协议与 CLI 解码说明

RouteCodex / llmswitch-core 对「模型看到的工具参数」与「CLI/执行器真正消费的参数」做了明确分层：

- **模型视角（统一协议）**
  - 所有支持 TOON 的工具（例如 `exec_command`、`apply_patch`）都可以通过 `arguments.toon` 传参：
    - 形如 `command: ...\nworkdir: ...\n` 的多行 `key: value`。
    - 模型无需关心 CLI 的内部 JSON 结构（`cmd` / `input` 等字段名）。
- **执行视角（CLI 黑盒）**
  - Codex CLI 的工具实现不会理解 TOON，只接受传统 JSON 形态：
    - `exec_command` 只认 `{ cmd: string, workdir?, command? ... }`。
    - `apply_patch` 只认 `{ input: string, patch?: string }`，且 `input` 必须是标准统一 diff（`*** Begin Patch` 开头）。
  - CLI 被视为黑盒：不能指望它去解析 TOON 或结构化 `changes`。

为此，llmswitch-core 在 **响应侧** 增加了成对的解码过滤器，用于在把响应发回 CLI 之前“翻译”工具参数：

- `ResponseToolArgumentsToonDecodeFilter`
  - 作用于所有协议（包括 `/v1/responses`），在响应处理阶段对 `choices[].message.tool_calls[*].function.arguments` 解码：
    - 对 shell/exec 类工具（`shell` / `shell_command` / `exec_command`）：
      - 从 `toon` 中解析 `command`/`cmd`、`workdir`/`cwd`、`timeout_ms`、`with_escalated_permissions`、`justification` 等字段。
      - 统一输出为 JSON 字符串：`{"cmd":"...","command":"...","workdir":"...","timeout_ms":...,"with_escalated_permissions":...,"justification":"..."}`。
    - 对其它工具（如 `view_image`、MCP 工具等）：
      - 将所有 TOON `key: value` 对映射为普通 JSON 字段，并做轻量类型推断（`true/false`→布尔，数字→number，可解析的 `{}`/`[]`→JSON 对象/数组）。
    - 对 `apply_patch`：
      - 直接保留 `toon`/结构化字段，由 Chat process 中的工具验证器（`validateToolCall('apply_patch', ...)`）统一转换为 `{ input, patch }` 的标准形态。

整体约束可以概括为：

- **对模型**：可以使用 TOON 或结构化 JSON（例如 `changes`）；RouteCodex 会在 Hub Pipeline 内对齐为统一 JSON 结构。
- **对 CLI / 客户端**：始终看到历史兼容形态：
  - `exec_command`：具备 `cmd` 字段的 JSON；
  - `apply_patch`：具备 `input`（统一 diff）的 JSON。
- **对维护者**：
  - 所有 TOON → JSON 的解码逻辑集中在 `sharedmodule/llmswitch-core/src/filters/special/` 及响应工具治理路径中；
  - CLI 侧不需要理解 TOON，也无需修改其内部工具实现；一切转换在 Hub 层完成。

### TOON 开关（全局参数）

为方便在不同环境中逐步 rollout 或紧急关闭 TOON 支持，llmswitch-core 提供了统一的开关：

- 环境变量（两者等价，任意其一生效）：
  - `RCC_TOON_ENABLE`
  - `ROUTECODEX_TOON_ENABLE`
- 取值规则（大小写不敏感）：
  - 未设置 / 空字符串：默认 **开启** TOON 支持。
  - 设置为 `0` / `false` / `off`：**关闭** TOON 支持。
  - 其它任何非空值：视为开启。
- 影响范围：
  - **请求侧**：`request-tools-normalize` 不再对 exec_command/apply_patch 等工具注入 TOON 形态 schema。
  - **响应侧**：`ResponseToolArgumentsToonDecodeFilter` 不再解码 `arguments.toon`，模型看到/返回的将是传统 JSON 形态，TOON 完全禁用。

> 建议：开发环境默认开启 TOON，便于调试；遇到兼容性问题或需要验证“纯 JSON 模式”时，可临时设置  
> `RCC_TOON_ENABLE=0 routecodex ...` 来关闭 TOON 编解码，对客户端与 Provider 完全透明。

---

## 参考文档

- `docs/ARCHITECTURE.md` – 全量架构细节与数据流
- `docs/CONFIG_ARCHITECTURE.md` – 配置解析、authfile、虚拟路由
- `docs/pipeline-routing-report.md` – Hub Pipeline 节点详解
- `docs/codex-samples-replay.md` – 快照与回放说明

如需提交问题或贡献代码，请查看 `CONTRIBUTING.md`（若不存在可参考 Issues 模板）并遵守 `AGENTS.md` 中的 V2 工作约定。
- **Provider层**: 统一HTTP通信、认证管理、连接池优化、双向请求响应处理
- **External AI Service层**: 多提供商AI模型支持、性能监控、双向数据流

### 🔧 智能路由系统
支持7种动态路由类别，自动选择最优处理流水线：
- `default`: 标准请求路由
- `longcontext`: 长文本处理请求（tiktoken 统计超过 180k token 时切向 ≥256k provider，例如 fai/c4m）
- `thinking`: 复杂推理请求
- `background`: 后台处理请求
- `websearch`: 网络搜索请求
- `vision`: 图像处理请求
- `coding`: 代码生成请求

**强制路由/模型标签（请求文本内插入 `<**...**>`）**
- `<**thinking|coding|tools|vision|websearch|longcontext|background**>`：强制命中对应路由，忽略其它关键词。
- `<**provider.model**>`：强制命中某个 provider 模型（如 `<**c4m.gpt-5.1-codex**>`，当 provider 存在并健康时直接命中）。
- 标签在路由阶段被剥离，真实请求不会把控制标签透传给上游。

### 🛠️ Provider V2架构
完全重构的Provider系统，提供：
- 统一的OpenAI标准接口（支持5大提供商）
- 配置驱动的服务适配（API Key + OAuth）
- 认证管理模块化
- 请求/响应快照系统
- Fail Fast错误处理机制

### 🎯 Dry-Run调试系统
完整的调试和测试框架：
- 节点级dry-run执行
- 智能输入模拟
- 双向管道处理
- 完整快照链路追踪
- 结构化错误分析

### 📊 实时监控界面
基于Web的综合调试界面：
- 实时系统监控
- 性能可视化
- 模块管理
- 事件探索

## 📦 支持的提供商

| 提供商 | 支持状态 | 认证方式 | 特色功能 | V2架构状态 |
|--------|----------|----------|----------|-------------|
| **OpenAI** | ✅ 完全支持 | API Key | GPT系列模型，DALL-E图像生成 | ✅ Provider V2 |
| **Anthropic** | ✅ 完全支持 | API Key | Claude系列模型，长上下文支持 | ✅ Provider V2 |
| **Qwen** | ✅ 完全支持 | OAuth | 阿里云通义千问系列，客户端元数据 | ✅ Provider V2 |
| **GLM** | ✅ 完全支持 | API Key | 智谱AI GLM系列，思考内容处理 | ✅ Compatibility V2 + Provider V2 |
| **LM Studio** | ✅ 完全支持 | API Key | 本地模型部署，工具调用支持 | ✅ Provider V2 |
| **iFlow** | ✅ 完全支持 | OAuth | 多模态AI服务，PKCE支持 | ✅ Provider V2 |

## 🚀 快速开始

### 系统要求

- **Node.js**: 20.0.0 或更高版本（推荐 < 26）
- **npm**: 8.0.0 或更高版本
- **操作系统**: Windows 10+, macOS 10.15+, Ubuntu 20.04+
- **内存**: 建议 4GB 以上
- **磁盘空间**: 500MB 可用空间

### 安装

#### 自动安装（推荐，dev 包 `routecodex`）

```bash
# 一键构建并全局安装（自动处理权限问题）
npm run install:global
```

安装脚本会自动：
- ✅ 检查Node.js版本（需要>=20）
- ✅ 清理旧的安装残留
- ✅ 构建项目（编译为 dev 模式，默认端口 5555）
- ✅ 处理权限配置
- ✅ 全局安装到正确位置
- ✅ 验证安装结果

> 说明：`routecodex` 作为 dev 包，适用于本地开发与调试，默认在端口 **5555** 启动（也可通过 `ROUTECODEX_PORT` / `RCC_PORT` 显式指定）。

#### 手动安装（等价于 dev 包）

```bash
# 克隆仓库
git clone https://github.com/your-repo/routecodex.git
cd routecodex

# 安装依赖
npm install

# 构建项目
npm run build

# 全局安装（dev 包 routecodex）
npm install -g .
```

#### Release 安装（发布包 `rcc`，可选）

```bash
# 基于当前源码构建并全局安装 rcc（release 包）
npm run install:release
```

- `rcc` 作为 release 包，仅从用户配置中读取端口（`httpserver.port` / `server.port` / 顶层 `port`），**不会复用 dev 默认 5555**。
- 适合在实际使用环境中按配置文件严格控制监听端口。

#### 清理旧安装

如果遇到安装问题，可以先清理旧安装：

```bash
# 清理全局安装残留
./scripts/cleanup-global.sh

# 然后重新安装
npm run install:global
```

#### 权限问题解决

如果遇到权限问题，请参考 [INSTALL.md](./INSTALL.md) 中的详细说明。

> 说明：统一使用 `scripts/install-global.sh`，支持自动权限处理和旧安装清理。安装脚本会在安装完成后自动使用 `~/.routecodex/provider/glm/config.v1.json` 启动一次服务器，并向模型发送“列出本地文件目录”的工具请求来验证端到端链路，请保证该配置文件存在且有效。

### 会话级路由 / sticky 指令语法总览

RouteCodex 支持在用户消息中通过 `<**...**>` 标签设置**当前会话的路由 / 粘性 / 禁用 / 自动续写**行为。这些标签只在路由层解析，不会透传给上游模型。

- **单次强制模型 / provider**
  - `<**provider.model**>`：仅对当前请求强制使用某个模型  
    - 例：`<**glm.glm-4.7**>`、`<**antigravity.claude-sonnet-4-5**>`
  - `<**provider**>`：将当前会话的 provider 白名单重置为该 provider  
    - 例：`<**antigravity**>`（只允许 antigravity 的所有模型/key 命中）

- **粘性（sticky）指定，跨轮生效**
  - `<**!provider.model**>`：对当前会话粘在某个模型上，并在该模型的多 key 之间轮询  
    - 例：`<**!antigravity.claude-sonnet-4-5**>`
  - `<**!provider.keyAlias.model**>` / `<**!provider.N**>`：粘在某一个具体 key 上，不再轮询其它 alias  
    - 例：`<**!antigravity.geminikey.gemini-3-pro-high**>`、`<**!openai.2**>`

- **白名单 / 禁用 / 解除禁用**
  - 白名单（只允许这些 provider）  
    - `<**!glm**>`、`<**!glm,openai**>`
  - 禁用（只对当前会话生效，支持 provider / keyAlias / 序号）  
    - `<**#glm**>`（禁用 glm 全部 key）  
    - `<**#openai.1**>`、`<**#anthropic.primary**>`
  - 启用（解除禁用）  
    - `<**@glm**>`、`<**@openai.1**>`

- **清理所有路由状态**
  - `<**clear**>`：清除 sticky / 白名单 / 禁用 状态，恢复默认路由

- **自动续写 stopMessage（基于 sticky 状态）**
  - 启用 / 更新：  
    - `<**stopMessage:"继续"**>` → 默认最多自动续写 1 次  
    - `<**stopMessage:"继续",3**>` → 最多自动续写 3 次
  - 清理：  
    - `<**stopMessage:clear**>`
  - 触发条件（由内置 `stop_message_auto` servertool 在服务端判断）：  
    - 当前响应 `finish_reason = "stop"`；  
    - 当前轮没有工具调用（`tool_calls` 为空）；  
    - `stopMessageUsed < stopMessageMaxRepeats` 且客户端仍连接。  
  - 会话要求：sticky 状态依赖 `sessionId` / `conversationId`。`/v1/messages` 请求请确保 `metadata.user_id` 内包含 `session_<uuid>` 字样，系统会在缺少 header/metadata.sessionId 时从 `metadata.__raw_request_body.metadata.user_id` 自动提取用作会话键。  
  - 行为：在保存的原始请求消息末尾追加一条 `{ role: "user", content: "<配置的文本>" }`，通过内部 `reenterPipeline` 自动发下一轮对话，对客户端透明。

> 完整说明、状态持久化规则及 daemon 管理示例，参见 `docs/routing-instructions.md`。

### 基础配置

1. **创建配置文件**
```bash
# 复制示例配置
cp config/examples/basic-config.json ~/.routecodex/config.json
```

2. **V2架构配置示例**
```json
{
  "version": "1.0",
  "providers": {
    "glm-provider": {
      "type": "chat-http-provider",
      "config": {
        "providerType": "openai",
        "providerId": "glm",
        "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
        "auth": {
          "type": "apikey",
          "apiKey": "${GLM_API_KEY}"
        },
        "models": {
          "glm-4": {
            "maxTokens": 8192,
            "temperature": 0.7
          }
        }
      }
    },
    "qwen-provider": {
      "type": "chat-http-provider",
      "config": {
        "providerType": "openai",
        "auth": {
          "type": "qwen-oauth",
          "clientId": "${QWEN_CLIENT_ID}",
          "clientSecret": "${QWEN_CLIENT_SECRET}",
          "tokenFile": "${HOME}/.routecodex/auth/qwen-oauth.json"
        }
      }
    }
  },
  "pipelines": [
    {
      "id": "glm-pipeline",
      "providerId": "glm-provider",
      "models": ["glm-4"],
      "modules": {
        "llmSwitch": { "type": "llmswitch-v2" },
        "compatibility": { "type": "compat:passthrough" },
        "provider": { "type": "chat-http-provider" }
      }
    }
  ],
  "dynamicRouting": {
    "enabled": true,
    "defaultTarget": {
      "providerId": "glm-provider",
      "modelId": "glm-4"
    }
  }
}
```

3. **设置环境变量**
```bash
# GLM API密钥（智谱AI）
export GLM_API_KEY="your-glm-api-key"

# Qwen OAuth配置（阿里云）
export QWEN_CLIENT_ID="your-qwen-client-id"
export QWEN_CLIENT_SECRET="your-qwen-client-secret"

# 其他提供商密钥
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

### 启动服务

```bash
# 启动RouteCodex服务器
routecodex start --config ~/.routecodex/config.json --port 5506

# 后台运行
routecodex start --config ~/.routecodex/config.json --port 5506 --daemon

# 前台运行（限时）
routecodex start --config ~/.routecodex/config.json --port 5506 --timeout 300
```

### 验证安装

```bash
# 检查版本
routecodex --version

# 检查配置
routecodex config validate

# 测试API连接
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

## 📖 使用指南

### 基础API调用

RouteCodex提供与OpenAI完全兼容的API接口：

#### Chat Completions

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum computing in simple terms."}
    ],
    "max_tokens": 1000,
    "temperature": 0.7
  }'
```

#### 工具调用

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather information",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City name"}
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

#### 流式响应

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Write a short story"}],
    "stream": true
  }'
```

### 高级功能

#### 动态路由配置

```json
{
  "dynamicRouting": {
    "enabled": true,
    "categories": {
      "longcontext": {
        "targets": [
          {
            "providerId": "fai-provider",
            "modelId": "gpt-5.1-codex"
          },
          {
            "providerId": "c4m-provider",
            "modelId": "gpt-5.1-codex"
          }
        ],
        "triggers": [
          {"type": "token_count", "threshold": 180000},
          {"type": "content_type", "value": "document"}
        ]
      },
      "coding": {
        "targets": [
          {
            "providerId": "qwen-provider",
            "modelId": "qwen3-coder-plus"
          }
        ],
        "triggers": [
          {"type": "keyword", "values": ["code", "function", "bug"]},
          {"type": "language_detection", "languages": ["python", "javascript", "typescript"]}
        ]
      }
    }
  }
}
```

#### Dry-Run调试

```bash
# 启用dry-run模式
routecodex start --config ~/.routecodex/config.json --dry-run

# 运行dry-run测试
routecodex dry-run --config ~/.routecodex/config.json --test-file examples/test-request.json

# 生成dry-run报告
routecodex dry-run --config ~/.routecodex/config.json --output-report debug-report.json
```

#### 性能监控

```bash
# 启用监控
routecodex start --config ~/.routecodex/config.json --monitoring

# 查看性能指标
curl http://localhost:5506/api/debug/metrics

# 导出监控数据
curl http://localhost:5506/api/debug/export/json > monitoring-data.json
```

## 🏗️ 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                 RouteCodex V2 双向流水线架构                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   HTTP Server   │  │   WebSocket     │  │   Debug API     │  │
│  │   (双向通信)     │  │   Interface     │  │   (双向监控)     │  │
│  │ • REST API      │  │ • Real-time     │  │ • Metrics       │  │
│  │ • Streaming     │  │   updates       │  │ • Event log     │  │
│  │ • Authentication│  │ • Monitoring    │  │ • Health check  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                  ▲▼             ▲▼                    ▲▼           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                双向4-Layer Pipeline Architecture             │  │
│  │                          ▲▼ 双向数据流                       │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │LLM Switch   │ Compatibility │        Provider         │  │  │
│  │  │  Workflow   │    Layer     │          Layer              │  │  │
│  │  │      ▲▼     │      ▲▼      │           ▲▼             │  │  │
│  │  │ • 双向路由   │ • 双向格式   │ • 双向HTTP通信            │  │  │
│  │  │ • 双向协议   │   转换       │ • 双向认证               │  │  │
│  │  │ • 双向分类   │ • 双向字段   │ • 双向错误处理            │  │  │
│  │  │ • 工具统一   │   映射       │ • 双向健康监控            │  │  │
│  │  │   处理      │             │                          │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                  ▲▼ 双向工具处理循环                              │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              llmswitch-core 双向工具处理核心                  │  │
│  │                          ▲▼                                │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │ 工具规范化器  │  文本收割器   │      系统工具指引         │  │  │
│  │  │      ▲▼     │      ▲▼     │           ▲▼            │  │  │
│  │  │ • 双向规范   │ • 双向收割   │ • 双向schema增强         │  │  │
│  │  │ • 双向生成   │ • 双向提取   │ • 双向指引注入           │  │  │
│  │  │ • 双向去重   │ • 双向清理   │ • 双向行为标准化         │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Configuration & Management               │  │
│  │                          ▲▼                                │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   Config    │   Monitoring  │      Dry-Run System      │  │  │
│  │  │  Engine     │              │                          │  │  │
│  │  │ • 双向JSON  │ • 双向性能   │ • 双向节点级执行           │  │  │
│  │  │ • 双向验证   │ • 双向指标   │ • 双向输入模拟            │  │  │
│  │  │ • 双向热重载 │ • 双向健康   │ • 双向错误边界            │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

▲▼ 双向数据流：请求流(↓)和响应流(↑)在每一层双向传递
工具循环：工具选择 → llmswitch处理 → Provider修剪 → AI执行 → 结果收集 → 下一轮请求
```

### 核心组件

#### 1. LLM Switch Workflow层
- **双向动态路由分类**: 基于请求内容自动选择处理流水线
- **双向协议转换**: OpenAI ↔ Anthropic ↔ Gemini协议双向转换
- **llmswitch-core工具处理**: 统一工具调用处理、文本收割、系统指引
- **双向请求预处理**: 模型映射、参数标准化、工具调用处理

#### 2. Compatibility层
- **双向格式转换**: 字段映射、数据结构适配、双向修剪转换
- **双向提供商适配**: 处理不同提供商的特殊要求
- **双向响应标准化**: 统一输出格式，错误处理，字段映射

#### 3. Provider层 (V2)
- **双向统一接口**: 标准化的Provider实现，支持双向请求响应
- **双向认证管理**: API Key、OAuth、会话管理
- **双向连接管理**: 连接池、重试机制、健康检查、双向HTTP通信
- **协议化实现**: `chat-http-provider.ts`、`responses-http-provider.ts`、`anthropic-http-provider.ts`、`gemini-http-provider.ts` 分别对应四大协议，通过 ProviderComposite 执行最小兼容，再交由 Provider Runtime Profile 注入 baseURL/headers/auth。

#### 4. External AI Service层
- **双向多提供商支持**: 统一的AI服务接口，双向数据流
- **双向模型管理**: 动态模型加载、能力检测
- **双向性能优化**: 批量处理、缓存机制、双向监控

### 配置系统

#### 配置文件结构
```json
{
  "version": "1.0",
  "server": {
    "host": "0.0.0.0",
    "port": 5506,
    "cors": {
      "enabled": true,
      "origins": ["*"]
    }
  },
  "providers": {
    "provider-id": {
      "type": "chat-http-provider|responses-http-provider|anthropic-http-provider|gemini-http-provider",
      "enabled": true,
      "config": {
        "providerType": "openai|responses|anthropic|gemini",
        "providerId": "glm|qwen|c4m",
        "baseUrl": "https://api.provider.com/v1",
        "auth": {
          "type": "apikey|oauth",
          "apiKey": "${API_KEY}" | "oauth-config"
        },
        "models": {
          "model-id": {
            "maxTokens": 8192,
            "temperature": 0.7,
            "supportsTools": true,
            "supportsStreaming": true
          }
        },
        "overrides": {
          "defaultModel": "gpt-4",
          "headers": {
            "User-Agent": "RouteCodex/2.0"
          }
        }
      }
    }
  },
  "pipelines": [
    {
      "id": "pipeline-id",
      "providerId": "provider-id",
      "models": ["model-1", "model-2"],
      "modules": {
        "llmSwitch": {
          "type": "openai-passthrough|anthropic-converter",
          "config": {}
        },
        "compatibility": {
          "type": "openai-normalizer|field-mapping",
          "config": {}
        },
        "provider": {
          "type": "openai-http|anthropic-http",
          "config": {}
        }
      },
      "hooks": {
        "preProcess": [],
        "postProcess": []
      }
    }
  ],
  "dynamicRouting": {
    "enabled": true,
    "defaultTarget": {
      "providerId": "default-provider",
      "modelId": "default-model"
    },
    "categories": {
      "category-id": {
        "targets": [
          {
            "providerId": "provider-id",
            "modelId": "model-id",
            "weight": 1.0
          }
        ],
        "triggers": [
          {
            "type": "token_count|content_type|keyword|language_detection",
            "condition": ">=|<=|==|contains|matches",
            "value": "threshold|pattern|list"
          }
        ]
      }
    }
  },
  "monitoring": {
    "enabled": true,
    "metrics": {
      "performance": true,
      "errors": true,
      "usage": true
    },
    "logging": {
      "level": "info",
      "format": "json"
    }
  },
  "dryRun": {
    "enabled": false,
    "global": {
      "defaultMode": "output-validation",
      "verbosity": "normal",
      "autoCleanup": true
    },
    "memory": {
      "maxMemoryUsage": 536870912,
      "cleanupInterval": 60000,
      "enableMonitoring": true
    }
  }
}
```

## 🔧 开发指南

### 项目结构

```
routecodex/
├── src/                          # 源代码目录
│   ├── cli.ts                   # CLI入口点
│   ├── index.ts                 # 主模块入口
│   ├── commands/                # CLI命令实现
│   │   ├── start.ts            # 启动命令
│   │   ├── config.ts           # 配置命令
│   │   ├── dry-run.ts          # Dry-run命令
│   │   └── debug.ts            # 调试命令
│   ├── server/                  # HTTP服务器
│   │   ├── http-server.ts      # 主HTTP服务器
│   │   ├── websocket-server.ts # WebSocket服务器
│   │   └── handlers/           # API处理器
│   ├── modules/                # 核心模块
│   │   ├── pipeline/           # 4层管道架构
│   │   │   ├── modules/        # 管道模块
│   │   │   │   ├── provider/   # Provider V2模块
│   │   │   │   └── ...
│   │   │   └── ...
│   │   ├── config-manager/     # 配置管理
│   │   ├── monitoring/         # 监控系统
│   │   └── debug/             # 调试系统
│   └── types/                  # TypeScript类型定义
├── sharedmodule/               # 共享模块
│   ├── llmswitch-core/        # LLM转换核心
│   ├── config-engine/         # 配置引擎
│   └── config-testkit/        # 配置测试工具
├── config/                     # 配置文件
│   ├── examples/              # 配置示例
│   └── schemas/               # JSON Schema定义
├── scripts/                    # 构建和安装脚本
├── web-interface/             # Web调试界面
├── docs/                      # 文档
├── tests/                     # 测试文件
└── vendor/                    # 第三方依赖
```

#### HTTP服务器职责（精简版）

- 服务器只负责 **HTTP ↔ Hub Pipeline** 转发：`/v1/chat`、`/v1/messages`、`/v1/responses` handler 将请求封装为 `HubPipelineRequest`，调用 `hubPipeline.execute()`，然后把返回的 provider payload/runtimeKey 交给对应 Provider。
- ProviderPool、兼容层、Virtual Router、工具治理都由 llmswitch-core 完成。Host 只在启动时执行 `bootstrapVirtualRouterConfig`、构造 Hub Pipeline，并根据 `targetRuntime` 初始化 Provider 实例。
- Provider runtime map 是唯一的数据来源：`bootstrapVirtualRouterConfig` 会输出 `targetRuntime[providerKey]`，Server 把该 profile 注入 `ChatHttpProvider`/`ResponsesHttpProvider`/`AnthropicHttpProvider`，同时通过 `attachProviderRuntimeMetadata` 把 `providerKey/runtimeKey/routeName` 写入请求体，确保错误上报与熔断都能定位到具体 key-alias。
- SSE/JSON 序列化、错误处理、日志快照均由 llmswitch-core 的节点链完成，HTTP handler 不再负责心跳/重试等逻辑，真正实现“瘦”外壳，便于未来接入自定义编排。

### 🏗️ 兼容层架构重构

#### 概述

RouteCodex V2架构已完成兼容层的函数化重构，实现了两层架构设计，大幅提升了代码可维护性和模块化程度。

#### 两层架构设计

**第一层：接口兼容层**
- 保持现有接口完全不变
- 确保与PipelineManager的集成无任何破坏性改动
- 提供向后兼容性和稳定性

**第二层：函数化实现层**
- 将复杂逻辑拆分为纯函数
- 单一职责原则，每个函数专注特定功能
- 易于测试、维护和扩展

#### 重构成果

**代码减少统计**
- GLM兼容模块：234行 → 141行（减少40%）
- iFlow兼容模块：201行 → 115行（减少43%）
- 总计减少冗余代码：约740行

**架构优化**
- 移除重复wrapper实现
- 统一适配器模式（`CompatibilityToPipelineAdapter`）
- 正确的上下文传递和元数据管理
- 完整的模块注册机制

#### 核心文件结构

```
sharedmodule/llmswitch-core/src/conversion/compat/
├── compat/profile-store                 # built-in profile registry
├── profiles/chat-*.json                 # chat models（glm / qwen / iflow / lmstudio ...）
├── profiles/responses-*.json            # responses family（c4m、fai……）
└── compat-engine.ts                     # request/response 映射引擎

⚠️ 0.89.258 起，兼容逻辑 **全部** 驻留在 llmswitch-core，由 virtual router 在命中 provider 后将 `compatibilityProfile` 注入 Hub Pipeline。Host 仓库已删除 `src/providers/compat/*`，仅保留 provider/runtime/handler；新增的兼容需求请直接在 sharedmodule 中新增 profile 并引用。
```

#### 函数化实现模式

每个Provider模块采用统一的函数化模式：

```typescript
// 函数化处理器（functions/provider-processor.ts）
export const processProviderIncoming = async (request, config, context) => {
  // 请求处理逻辑
};

export const processProviderOutgoing = async (response, config, context) => {
  // 响应处理逻辑
};

export const sanitizeProviderToolsSchema = async (tools, config, context) => {
  // 工具schema清理
};

// 兼容模块主类（provider/provider-compatibility.ts）
export class ProviderCompatibility implements CompatibilityModule {
  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    return await processProviderIncoming(request, this.processConfig, context);
  }
}
```

#### 关键技术修复

1. **模块注册修复**：在PipelineManager中正确注册GLM和iFlow模块
2. **上下文传递修复**：从SharedPipelineRequest.route.requestId提取真实ID
3. **端点识别修复**：在CompatibilityContext顶层设置entryEndpoint
4. **接口扩展**：为CompatibilityContext添加entryEndpoint字段

#### 使用示例

**创建新的Provider兼容模块**

```typescript
// 1. 创建functions/processor.ts
export const processNewProviderIncoming = async (request, config, context) => {
  // 实现新Provider的请求转换逻辑
};

// 2. 创建兼容模块主类
export class NewProviderCompatibility implements CompatibilityModule {
  // 实现CompatibilityModule接口
  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    return await processNewProviderIncoming(request, this.processConfig, context);
  }
}

// 3. 在PipelineManager中注册
this.registry.registerModule("new-provider", this.createNewProviderCompatibilityModule);
```

### 构建和开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建项目
npm run build

# 运行测试
npm test

# 代码检查
npm run lint

# 自动修复lint问题
npm run lint:fix

# 类型检查
npm run type-check

# 清理构建文件
npm run clean
```

### 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- --grep "provider"

# 运行集成测试
npm run test:integration

# 运行E2E测试
npm run test:e2e

# 生成测试覆盖率报告
npm run test:coverage

# 运行性能测试
npm run test:performance

# 黄金样本 + Mock 回归（覆盖 chat/responses/anthropic）
npm run test:golden

# 将 ~/.routecodex/golden_samples/new/** 同步到仓库内的 samples/ci-goldens/**
npm run sync:ci-goldens
```

#### Provider 专项测试

| 测试文件 | 作用 |
| --- | --- |
| `tests/provider/provider-outbound-provider.test.ts` | 使用黄金样本（openai-chat/responses）验证 `ChatHttpProvider`/`ResponsesHttpProvider` 的请求整形、兼容层开关以及 HTTP 头部/模型注入。 |
| `tests/provider/provider-outbound-param.test.ts` | 从 `~/.routecodex/codex-samples` 按需加载聊天快照，分别对 openai/responses/anthropic 协议执行出站整形，确保三条链路共用相同 payload。 |
| `tests/provider/provider-composite-guards.test.ts` | 覆盖 ProviderComposite 的协议守卫（protocol ↔ providerType），模拟 ErrorCenter 回调，确保 mismatch 会 fail fast。 |
| `tests/provider/provider-factory.test.ts` | 校验 ProviderFactory 的 Fail-Fast 行为，未知 `providerType/moduleType` 会直接抛错，防止静默回退。 |

> 建议在跑专项测试前设置 `RCC_TEST_FAKE_OPENAI_COMPAT=1` 等 mock 环境变量，以避免真实兼容模块加载 import.meta。

#### 黄金样本库与 Mock 测试

`samples/ci-goldens/<entry>/<provider>/` 随仓库提供一套最小聊天请求，确保在完全离线的 CI
环境也能复现工具字段、system 块与 streaming 行为。`npm run test:golden` 会：

1. 执行 `scripts/tools/capture-provider-goldens.mjs --custom-only --update-golden`，把
   `~/.routecodex/golden_samples/new/**` 或 `samples/ci-goldens/**` 中的最新请求复制到
   `~/.routecodex/golden_samples/provider_golden_samples/`；
2. 执行 `scripts/mock-provider/run-regressions.mjs`，通过 mock provider 跑完整的
   chat/responses/anthropic 回归。

若本地存在 `~/.routecodex/codex-samples`，脚本会提示额外运行
`node scripts/mock-provider/capture-from-configs.mjs` 把真实 provider 录制转成 mock
样本。若需要把最新的 `~/.routecodex/golden_samples/new/**` 同步进仓库，执行
`npm run sync:ci-goldens`；更多细节参见 `docs/golden-ci-library.md`。

### 代码规范

- **TypeScript**: 严格模式，完整类型定义
- **ESLint**: 代码风格检查和错误预防
- **Prettier**: 代码格式化
- **Husky**: Git hooks，确保代码质量
- **Conventional Commits**: 标准化提交信息

## 📊 监控和调试

### Web调试界面

RouteCodex提供功能强大的Web调试界面：

```bash
# 启动Web界面
cd web-interface
npm install
npm run dev

# 访问界面
open http://localhost:3000
```

**功能特性**:
- 📊 实时性能仪表板
- 🔧 模块管理和配置
- 📈 交互式图表
- 🔍 事件探索器
- 🎨 响应式设计，支持深色模式

### CLI调试工具

```bash
# 查看系统状态
routecodex status

# 验证配置
routecodex config validate

# 测试提供商连接
routecodex test-provider --provider openai-provider

# 查看实时日志
routecodex logs --follow

# 导出调试数据
routecodex debug export --format json

# 性能分析
routecodex debug profile --duration 60
```

### API调试端点

```bash
# 系统健康检查
GET /api/debug/health

# 模块状态列表
GET /api/debug/modules

# 模块详细信息
GET /api/debug/modules/:id

# 事件列表（支持过滤）
GET /api/debug/events?type=error&limit=100

# 性能指标
GET /api/debug/metrics

# 导出调试数据
GET /api/debug/export/:format
```

## 🔌 集成示例

### Node.js集成

```javascript
import { RouteCodexClient } from 'routecodex-client';

const client = new RouteCodexClient({
  baseURL: 'http://localhost:5506',
  apiKey: 'your-api-key'
});

// 简单对话
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello, RouteCodex!' }
  ]
});

console.log(response.choices[0].message.content);
```

### Python集成

```python
import openai

# 配置RouteCodex端点
openai.api_base = "http://localhost:5506/v1"
openai.api_key = "your-api-key"

# 使用标准OpenAI客户端
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=[
        {"role": "user", "content": "Hello from Python!"}
    ]
)

print(response.choices[0].message.content)
```

### cURL集成

```bash
# 设置环境变量
export ROUTECODEX_URL="http://localhost:5506"
export ROUTECODEX_API_KEY="your-api-key"

# 创建别名方便使用
alias rcurl='curl -H "Authorization: Bearer $ROUTECODEX_API_KEY" -H "Content-Type: application/json" $ROUTECODEX_URL/v1'

# 使用别名调用API
rcurl/chat/completions -d '{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Hello from cURL!"}]
}'
```

## 🚨 故障排除

### 常见问题

#### 1. 安装问题

**问题**: `npm install -g routecodex` 权限错误
```bash
# 解决方案1：使用nvm管理Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install node
npm install -g routecodex

# 解决方案2：直接使用npm install -g
npm install -g routecodex
```

#### 2. 启动失败

**问题**: 端口被占用
```bash
# 查看端口占用
lsof -i :5506

# 杀死占用进程
kill -9 <PID>

# 或者使用其他端口
routecodex start --port 5507
```

#### 3. 认证问题

**问题**: API密钥无效
```bash
# 检查环境变量
echo $OPENAI_API_KEY

# 测试API连接
routecodex test-provider --provider openai-provider

# 验证配置
routecodex config validate
```

#### 4. 性能问题

**问题**: 响应速度慢
```bash
# 启用性能监控
routecodex start --monitoring

# 查看性能指标
curl http://localhost:5506/api/debug/metrics

# 优化建议：
# 1. 增加连接池大小
# 2. 启用请求缓存
# 3. 调整超时设置
# 4. 使用更快的模型
```

### 调试模式

```bash
# 启用详细日志
DEBUG=routecodex:* routecodex start

# 启用调试API
routecodex start --debug-api

# 查看内部状态
curl http://localhost:5506/api/debug/internal
```

### 日志分析

```bash
# 查看错误日志
routecodex logs --level error

# 实时跟踪日志
routecodex logs --follow

# 导出日志
routecodex logs --export logs.json

# 分析日志模式
routecodex logs --analyze --pattern "timeout"
```

## 📈 性能优化

### 配置优化

```json
{
  "server": {
    "compression": true,
    "maxRequestSize": "10mb",
    "timeout": 30000
  },
  "providers": {
    "provider-id": {
      "connectionPool": {
        "maxConnections": 10,
        "minConnections": 2,
        "acquireTimeout": 5000
      },
      "cache": {
        "enabled": true,
        "ttl": 300,
        "maxSize": 1000
      }
    }
  }
}
```

### 监控指标

- **响应时间**: P50, P95, P99延迟
- **吞吐量**: 每秒请求数
- **错误率**: 4xx/5xx错误比例
- **内存使用**: 堆内存和系统内存
- **CPU使用**: 处理器使用率

### 扩展性

- **水平扩展**: 支持多实例部署
- **负载均衡**: 内置负载均衡策略
- **缓存策略**: 多级缓存机制
- **连接复用**: HTTP连接池管理

## 🤝 贡献指南

### 开发流程

1. **Fork仓库**并创建功能分支
   ```bash
   git checkout -b feature/amazing-feature
   ```

2. **编写代码**并遵循项目规范
   - TypeScript严格模式
   - 完整的单元测试
   - 详细的文档注释

3. **运行测试**确保代码质量
   ```bash
   npm test
   npm run lint
   npm run type-check
   ```

4. **提交代码**使用规范化信息
   ```bash
   git commit -m "feat: add amazing feature"
   ```

5. **推送分支**并创建Pull Request
   ```bash
   git push origin feature/amazing-feature
   ```

### 代码贡献规范

- **提交信息**: 遵循[Conventional Commits](https://www.conventionalcommits.org/)
- **代码风格**: 使用ESLint和Prettier保持一致
- **测试覆盖率**: 新功能必须包含测试，覆盖率>90%
- **文档更新**: 重大变更需要更新相关文档

### 问题报告

使用GitHub Issues报告问题时，请包含：

- **详细描述**: 问题的具体表现
- **复现步骤**: 如何触发问题
- **环境信息**: OS、Node.js版本、RouteCodex版本
- **相关日志**: 错误日志和调试信息
- **期望行为**: 您期望发生什么

## 📄 许可证

本项目采用MIT许可证 - 详见[LICENSE](LICENSE)文件。

## 🙏 致谢

感谢以下开源项目的支持：

- **OpenAI**: GPT模型和API标准
- **Anthropic**: Claude模型和安全研究
- **TypeScript**: 类型安全的JavaScript
- **Fastify**: 高性能Node.js web框架
- **Zod**: 运行时类型验证
- **Winston**: 日志管理库

## 📞 支持

- **文档**: [完整文档](https://docs.routecodex.com)
- **API参考**: [API文档](https://api.routecodex.com)
- **社区**: [GitHub Discussions](https://github.com/your-repo/routecodex/discussions)
- **问题反馈**: [GitHub Issues](https://github.com/your-repo/routecodex/issues)
- **邮箱**: support@routecodex.com

## 🗺️ 路线图

### v1.0 (当前版本)
- ✅ 4层管道架构
- ✅ Provider V2系统
- ✅ 动态路由分类
- ✅ Dry-Run调试系统
- ✅ Web调试界面

### v1.1 (计划中)
- 🔄 更多AI提供商支持
- 🔄 插件系统
- 🔄 高级缓存策略
- 🔄 分布式部署支持

### v1.2 (未来版本)
- 📋 机器学习模型
- 📋 自动化测试
- 📋 性能优化
- 📋 安全增强

---

**RouteCodex** - 让AI服务集成变得简单而强大 🚀
