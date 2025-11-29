# RouteCodex - 多提供商OpenAI代理服务器

[![npm version](https://badge.fury.io/js/routecodex.svg)](https://badge.fury.io/js/routecodex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)

RouteCodex是一个功能强大的多提供商OpenAI代理服务器，基于配置驱动的V2架构，支持原生dry-run调试能力、动态路由分类、4层管道架构和实时监控。提供统一的API接口，无缝集成多个AI服务提供商。

当前开发版本：`0.81.54`

## LLM Switch（前后半段）总览

- 前半段（Conversion）
  - Chat：保持 OpenAI Chat 标准；删除 stream，统一非流
  - Responses：instructions + input → Chat.messages（仅形状转换，不做工具治理/兜底）
  - Anthropic：Claude → Chat（仅形状转换）
  - SSE：默认不上游直通；需要时前半段合成为非流 JSON

- 后半段（Chat Pipeline，唯一治理点）
  - 请求：canonicalize + arguments 修复 + MCP 两步暴露
  - Provider：仅 HTTP 转发与快照
  - 响应：统一 Chat 形状，工具结果与 tool_call_id 配对
  - Responses：从 Chat 反向映射 required_action/items（仅映射，不治理）

文档与代码参考：
- 核心实现与详细说明：`sharedmodule/llmswitch-core/`
- 源码文档：`sharedmodule/llmswitch-core/README.md`

### Super Pipeline 架构（唯一入口）

- **唯一入口**：HTTP handler 直接调用 `sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/pipelines/super-pipeline`，本仓库不再维护自研 pipeline/blueprint。
- **配置流**：`routecodex-config-loader` 读取用户配置，传给 `bootstrapVirtualRouterConfig`，由 llmswitch-core 输出 `VirtualRouterConfig + targetRuntime` 并注入 Super Pipeline。
- **节点链路（由 llmswitch-core 内部维护）**
  - `SSE Input`：SSE ↔ JSON 转换、旁路透传。
  - `Input Nodes`：解析 Chat / Responses / Messages 请求，生成 canonical `standardizedRequest`。
  - `Chat Process`：唯一工具治理点，处理 tool_calls、MCP 规则、上下文压缩。
  - `Virtual Router Process`：分类、熔断、挑选 provider，并覆写 `request.model`、写入 `target.runtimeKey`。
  - `Output/SSE Nodes`：把 `processedRequest` 还原为目标协议，生成 usage、SSE 流和最终响应。
- **Host 职责**：`RouteCodexHttpServer` 只负责 HTTP/SSE 封装与 Provider runtime 映射，工具治理与路由决策全部在 llmswitch-core 完成。

## 快照排查指南（命令行）

- 快速查看某个请求 RID 在各阶段的顶层键/消息概况/可疑字段：
  - 运行：`npm run snapshot:inspect -- --rid <RID> [--endpoint openai-responses|openai-chat|anthropic-messages]`
  - 输出：
    - http-request / llmswitch.request.post / compatibility.request.post / provider.request.pre 的顶层键
    - messages 统计（条数、角色覆盖、是否存在 user）
    - 是否出现 data/metadata/stream 等可疑顶层键
    - 简要差异（哪个阶段新增了可疑键）

## 🔄 V2 架构特性

本仓库已完成面向生产的 V2 重构并默认启用，基于9大核心架构原则：

### 🏗️ V2 核心组件

- **Compatibility V2（配置驱动）**
  - 位置：`src/modules/pipeline/modules/provider/v2/compatibility/glm/*`（模块化 + Hook 系统）
  - 职责：仅做 Provider 特定的最小字段标准化与 reasoning_content 处理
  - 特性：配置驱动字段映射、GLM 专用最小清理与 1210/1214 错误兼容
  - 工具治理：统一在 llmswitch-core v2 处理；兼容层不进行工具语义修复/文本收割

- **Provider V2（统一OpenAI标准）**
  - 位置：`src/modules/pipeline/modules/provider/v2/*`
  - 能力：统一 HTTP 发送、认证管理、请求/响应快照
  - 支持服务：OpenAI、GLM、Qwen、iFlow、LM Studio
  - 策略：Fail Fast 原则，无隐藏兜底机制

- **LLM Switch Core（工具处理中心）**
  - 位置：`sharedmodule/llmswitch-core/`
  - 职责：工具调用统一处理（唯一入口）、文本意图收割、系统工具指引
  - 特性：三端一致性（Chat/Responses/Messages）；arguments 三段式修复（JSON→JSON5→安全修复→"{}"）；必要时从文本块收割重建 tool_calls；（可选）SSE 参数聚合

## 📐 模块职责边界（Do / Don't）

### llmswitch-core（唯一工具入口）
- Do
  - 统一工具规范：`canonicalizeChatResponseTools()` 保证 `content=null`、`finish_reason='tool_calls'`
  - arguments 统一修复：`jsonish.repairArgumentsToString()`（JSON/JSON5 容错 + 安全修复）
  - 文本收割：在“可疑+存在文本工具块”时，用 `harvestTools()` 重建标准 `tool_calls`
  - （可选）SSE 聚合：吞掉参数增量，在工具完成时一次性下发完整 arguments（默认关闭）
- Don't
  - 进行 Provider 特定修复/HTTP 通信/配置管理
  - 将同样逻辑复制到兼容层或 Provider 层

### Compatibility（最小兼容层）
- Do
  - Provider 字段标准化、reasoning_content 处理、配置驱动映射
  - 1210/1214 最小兼容（GLM）
  - 请求侧最小黑名单（例如 GLM 删除 `tools[].function.strict`；无 tools 删除 `tool_choice`）
  - 响应侧最小黑名单（仅非流式）：默认仅删 `usage.prompt_tokens_details.cached_tokens`
    - 配置：`src/modules/pipeline/modules/provider/v2/compatibility/<provider>/config/response-blacklist.json`
    - 关键字段保护：status/output/output_text/required_action/choices[].message.content/tool_calls/finish_reason
- Don't
  - 工具语义修复或文本收割（统一由 llmswitch-core 处理）

### Provider V2（HTTP 通信）
- Do
  - 统一 HTTP 发送、认证管理、快照记录
  - 配置驱动（baseUrl/timeout/retry/headers）
- Don't
  - 工具语义修复/参数归一（如改写 `shell.command`）
  - 业务逻辑或格式转换
  - 默认不上游真流式（Responses 直通）
    - 开关（默认关闭）：`ROUTECODEX_RESPONSES_UPSTREAM_SSE=1` 或 `RCC_RESPONSES_UPSTREAM_SSE=1`

### Server Endpoints（HTTP 协议层）
- Do
  - SSE 预心跳/错误帧、HTTP 协议处理、委托到管道
- Don't
  - 工具处理/格式转换/业务逻辑

### 🎯 9大核心架构原则

1. **统一工具处理** - 所有工具调用通过 llmswitch-core 统一入口
2. **最小兼容层** - Compatibility层仅处理provider特定字段
3. **统一工具引导** - 系统工具指引集中管理
4. **快速死亡** - Fail Fast，无隐藏fallback
5. **暴露问题** - 结构化日志，完整错误上下文
6. **清晰解决** - 单一处理路径，确定性行为
7. **功能分离** - 模块职责单一，边界清晰
8. **配置驱动** - 无硬编码，外部化配置管理
9. **模块化** - 文件大小控制，功能导向拆分

### 🔧 构建与调试

**构建顺序（重要）**：
```bash
# 1. 先编译共享模块
npm --prefix sharedmodule/llmswitch-core run build

# 2. 再编译根包
npm run build

# 3. 安装或发布
npm pack && npm i -g ./routecodex-*.tgz
```

**调试与快照**：
- 环境变量：`ROUTECODEX_HOOKS_VERBOSITY=verbose`
- 快照路径：`~/.routecodex/codex-samples/{openai-chat|openai-responses|anthropic-messages}`
- 完整链路：raw-request → pre-llmswitch → post-llmswitch → compat-pre → provider-request → provider-response → compat-post

## 🔀 选择静态/动态流水线（V1/V2）

- 开关：`ROUTECODEX_PIPELINE_MODE`
- 取值：`dynamic`（动态流水线，V2，默认）或 `static`（静态流水线，V1）
- 兼容：历史 `ROUTECODEX_USE_V2` 已弃用，请迁移至 `ROUTECODEX_PIPELINE_MODE`

示例：

```bash
# 动态流水线（V2，默认）
ROUTECODEX_PIPELINE_MODE=dynamic routecodex

# 静态流水线（V1）
ROUTECODEX_PIPELINE_MODE=static routecodex
```

## 🖥️ CLI：`rcc code` 参数透传到 Claude

`rcc code` 会把紧跟在子命令 `code` 之后的参数默认传递给 Claude（Claude Code 可执行文件）。这使你可以无缝使用 Claude 自身的命令行参数，同时由 RouteCodex 代理请求到本地服务。

- 透传规则
  - `rcc code` 自身会消费的选项（不会透传）：
    - `-p/--port`、`-h/--host`、`-c/--config`、`--claude-path`、`--model`、`--profile`、`--ensure-server`
  - 除上述选项外，`code` 后的其它参数会按原顺序透传给 Claude。
  - 若使用分隔符 `--`，则 `--` 之后的所有参数将不做解析、原样透传。

- 环境与代理
  - `rcc code` 会为子进程设置：`ANTHROPIC_BASE_URL/ANTHROPIC_API_URL=http://<host>:<port>` 与 `ANTHROPIC_API_KEY=rcc-proxy-key`，并清理 `ANTHROPIC_AUTH_TOKEN/ANTHROPIC_TOKEN`，确保经由 RouteCodex 代理。
  - 可用 `--ensure-server` 在启动 Claude 前探测并尝试启动本地 RouteCodex 服务。

- 使用示例
  ```bash
  # 直接传递 Claude 自身参数（无分隔符）
  rcc code --model claude-3-5 -- --project ~/my/repo --editor vscode

  # 显式使用分隔符 -- 强制原样传参（推荐在复杂参数场景）
  rcc code -p 5506 -- --project ~/src/foo --some-claude-flag value

  # 指定 Claude 可执行文件路径
  rcc code --claude-path /usr/local/bin/claude -- --project ~/repo
  ```

> 提示：若透传参数与 `rcc code` 自身选项名冲突，建议使用 `--` 分隔，避免被 CLI 解析。

## 🚀 核心特性

### 🏗️ 双向4层管道架构
- **LLM Switch Workflow层**: 动态路由分类、协议转换、llmswitch-core工具处理统一入口
- **Compatibility层**: Provider特定字段标准化、reasoning_content处理、双向修剪转换
- **Provider层**: 统一HTTP通信、认证管理、连接池优化、双向请求响应处理
- **External AI Service层**: 多提供商AI模型支持、性能监控、双向数据流

### 🔧 智能路由系统
支持7种动态路由类别，自动选择最优处理流水线：
- `default`: 标准请求路由
- `longcontext`: 长文本处理请求
- `thinking`: 复杂推理请求
- `background`: 后台处理请求
- `websearch`: 网络搜索请求
- `vision`: 图像处理请求
- `coding`: 代码生成请求

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
        "compatibility": { "type": "glm-compatibility" },
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
            "providerId": "anthropic-provider",
            "modelId": "claude-3-5-sonnet-20241022"
          }
        ],
        "triggers": [
          {"type": "token_count", "threshold": 100000},
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

- 服务器只负责 **HTTP ↔ SuperPipeline** 转发：`/v1/chat`、`/v1/messages`、`/v1/responses` handler 将请求封装为 `SuperPipelineRequest`，调用 `superPipeline.execute()`，然后把返回的 provider payload/runtimeKey 交给对应 Provider。
- ProviderPool、兼容层、Virtual Router、工具治理都由 llmswitch-core 完成。Host 只在启动时执行 `bootstrapVirtualRouterConfig`、构造 SuperPipeline，并根据 `targetRuntime` 初始化 Provider 实例。
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
src/modules/pipeline/modules/provider/v2/compatibility/
├── compatibility-interface.ts           # 兼容层接口定义
├── compatibility-adapter.ts             # PipelineModule适配器
├── base-compatibility.ts                # 基础兼容抽象类
├── glm/                                 # GLM兼容模块
│   ├── glm-compatibility.ts            # GLM兼容模块主类
│   ├── functions/glm-processor.ts      # GLM函数化实现
│   └── field-mapping/                  # 字段映射处理
└── iflow/                               # iFlow兼容模块
    ├── iflow-compatibility.ts          # iFlow兼容模块主类
    ├── functions/iflow-processor.ts    # iFlow函数化实现
    └── field-mapping/                  # 字段映射处理
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
```

#### Provider 专项测试

| 测试文件 | 作用 |
| --- | --- |
| `tests/provider/provider-outbound-provider.test.ts` | 使用黄金样本（openai-chat/responses）验证 `ChatHttpProvider`/`ResponsesHttpProvider` 的请求整形、兼容层开关以及 HTTP 头部/模型注入。 |
| `tests/provider/provider-outbound-param.test.ts` | 从 `~/.routecodex/codex-samples` 按需加载聊天快照，分别对 openai/responses/anthropic 协议执行出站整形，确保三条链路共用相同 payload。 |
| `tests/provider/provider-composite-guards.test.ts` | 覆盖 ProviderComposite 的协议守卫（protocol ↔ providerType），模拟 ErrorCenter 回调，确保 mismatch 会 fail fast。 |
| `tests/provider/provider-factory.test.ts` | 校验 ProviderFactory 的 Fail-Fast 行为，未知 `providerType/moduleType` 会直接抛错，防止静默回退。 |

> 建议在跑专项测试前设置 `RCC_TEST_FAKE_OPENAI_COMPAT=1` 等 mock 环境变量，以避免真实兼容模块加载 import.meta。

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
