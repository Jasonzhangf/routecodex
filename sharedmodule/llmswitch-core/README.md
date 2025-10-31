# @routecodex/llmswitch-core

RouteCodex LLMSwitch 核心模块，提供 AI 服务提供商之间的协议转换和标准化功能。

## 🧩 构建顺序（重要）

当修改到 `sharedmodule/` 下的代码（本模块属于该目录）时，请严格遵循“先模块、后整包”的构建与安装顺序：

- 先在本目录构建并产出 `dist/`：
  - `npm --prefix sharedmodule/llmswitch-core run build`
- 再回到仓库根目录进行构建/发布/安装：
  - `npm run build`（或项目既定脚本）

该顺序可避免根包引用到旧版本构建产物，已在仓库根 `AGENTS.md` 明确。

## 🏗️ 架构概览

本模块采用分层架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                    Conversion Layer                        │
│  ┌─────────────┬──────────────┬──────────────────────────┐  │
│  │   Codecs    │   Streaming  │      Responses          │  │
│  │  ┌─────────┐│ ┌───────────┐│ ┌─────────────────────┐  │  │
│  │  │OpenAI   ││ │SSE        ││ │OpenAI↔Chat Bridge   │  │  │
│  │  │Anthropic││ │Coalescing ││ │Tool Call Conversion │  │  │
│  │  └─────────┘│ └───────────┘│ └─────────────────────┘  │  │
│  └─────────────┴──────────────┴──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                    Switch Orchestrator                     │
│                    统一转换调度中心                         │
└─────────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                    Provider Adapters                       │
│  ┌─────────────┬──────────────┬──────────────────────────┐  │
│  │   OpenAI    │  Anthropic   │      Responses          │  │
│  │  ┌─────────┐│ ┌───────────┐│ ┌─────────────────────┐  │  │
│  │  │Normalizer ││ │Converter  ││ │Passthrough Handler│  │  │
│  │  └─────────┘│ └───────────┘│ └─────────────────────┘  │  │
│  └─────────────┴──────────────┴──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 📦 核心功能

### 1. 协议转换编解码器 (Codecs)
- **OpenAI↔OpenAI**: OpenAI Chat 规范化
- **Anthropic↔OpenAI**: Anthropic Messages 与 OpenAI Chat 双向转换
- **Responses↔OpenAI**: OpenAI Responses API 与 Chat API 转换

### 2. 流式处理
- **SSE 事件聚合**: 智能合并流式响应事件
- **消息缓冲**: 优化流式传输性能

### 3. 工具调用标准化
- **统一工具格式**: 标准化不同提供商的工具调用格式
- **参数验证**: JSON Schema 验证和修复
- **MCP 集成**: Model Context Protocol 支持

## 🚀 快速开始

### 基础导入

```typescript
// 转换核心功能
import { normalizeChatRequest } from 'rcc-llmswitch-core/conversion';

// 特定编解码器
import { OpenAIOpenAIConversionCodec } from 'rcc-llmswitch-core/conversion/codecs/openai-openai-codec';
import { AnthropicOpenAIConversionCodec } from 'rcc-llmswitch-core/conversion/codecs/anthropic-openai-codec';

// 路由和协调器
import { SwitchOrchestrator } from 'rcc-llmswitch-core/conversion/switch-orchestrator';
```

### 使用示例

```typescript
// OpenAI 请求规范化（响应侧按原样返回，避免重复归一）
const normalizedRequest = normalizeChatRequest(openaiRequest);

// Anthropic↔OpenAI 转换
const converter = new AnthropicOpenAIConversionCodec();
const openaiFormat = converter.encode(anthropicMessage);
const anthropicFormat = converter.decode(openaiChat);
```

## 📋 模块导出

| 导出路径 | 功能描述 |
|---------|---------|
| `rcc-llmswitch-core` | 主模块入口 |
| `rcc-llmswitch-core/conversion` | 转换核心功能 |
| `rcc-llmswitch-core/conversion/switch-orchestrator` | 转换协调器 |
| `rcc-llmswitch-core/llmswitch/llmswitch-conversion-router` | 转换路由器 |
| `rcc-llmswitch-core/llmswitch/openai-normalizer` | OpenAI 规范化器 |
| `rcc-llmswitch-core/llmswitch/anthropic-openai-converter` | Anthropic↔OpenAI 转换器 |
| `rcc-llmswitch-core/guidance` | 工具指导功能 |

## 🔧 技术规范

### 数据格式约定

1. **工具调用格式**
   ```typescript
   assistant.tool_calls[].function.arguments // 必须为 JSON 字符串
   ```
   - 对象会被自动 JSON.stringify
   - 工具定义采用 OpenAI function 形状

2. **工具定义结构**
   ```typescript
   {
     type: 'function',
     function: {
       name: string,
       description?: string,
       parameters: JSONSchema
     }
   }
   ```

3. **名称规范化**
   - 仅允许字符：`[a-zA-Z0-9_-]`
   - 最大长度：64 字符

### 环境变量配置

| 变量名 | 描述 | 默认值 |
|-------|------|--------|
| `RCC_ALLOWED_TOOLS` | 额外允许的函数工具（逗号分隔） | - |
| `RCC_TOOL_LIMIT` | 工具最大保留数量 | `32` |
| `ROUTECODEX_MCP_ENABLE` | 启用 MCP 集成 | `'1'` |
| `RCC_SYSTEM_TOOL_GUIDANCE` | 启用系统工具指导 | `'1'` |
| `ROUTECODEX_TOOL_OUTPUT_LIMIT` | 工具输出长度限制 | `1000` |
| `RCC_O2A_COALESCE_MS` | OpenAI→Anthropic 聚合窗口 | `1000ms` |
| `RCC_R2C_COALESCE_MS` | Responses→Chat 聚合窗口 | `1000ms` |

## 🏗️ 项目结构

```
src/
├── conversion/           # 转换核心
│   ├── codecs/          # 协议编解码器
│   ├── responses/       # Responses API 处理
│   ├── shared/          # 共享工具函数
│   ├── streaming/       # 流式处理
│   ├── codec-registry.ts    # 编解码器注册表
│   ├── switch-orchestrator.ts # 转换协调器
│   └── types.ts         # 类型定义
├── llmswitch/           # LLMSwitch 实现
│   ├── anthropic-openai-converter.ts
│   ├── llmswitch-conversion-router.ts
│   ├── llmswitch-response-chat.ts
│   ├── llmswitch-responses-passthrough.ts
│   └── openai-normalizer.ts
├── types/               # TypeScript 类型定义
└── guidance/            # 工具指导功能
```

## ⚠️ 已知问题

### 代码重复
- `splitCommandString()` 函数在多个文件中重复实现
- `normalizeTools()` 函数重复实现
- 工具输出清理逻辑分散在多个文件

### 硬编码问题
- 环境变量默认值分散在各文件
- 文件路径和魔法数字缺乏统一管理
- MCP 工具列表硬编码在多处

### 架构改进计划
1. **工具标准化核心**: 创建统一的 `ToolNormalizer` 类
2. **配置管理中心**: 集中管理环境变量和常量
3. **MCP 管理器**: 统一 MCP 服务器发现和工具注入
4. **输出清理器**: 统一工具输出处理和截断逻辑

## 🔗 相关文档

- [架构设计文档](../../docs/ARCHITECTURE.md)
- [流水线架构](../../docs/pipeline/ARCHITECTURE.md)
- [LM Studio 集成指南](../../docs/lmstudio-tool-calling.md)

## 📄 许可证

MIT License - 详见项目根目录 LICENSE 文件
