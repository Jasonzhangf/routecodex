# Pipeline Module

基于RouteCodex 9大核心架构原则的流水线模块，提供可组合的请求处理流水线，支持协议转换、流式控制和Provider适配。

## 概述

流水线模块是RouteCodex系统的核心请求处理组件，严格遵循9大架构原则，负责将路由后的请求通过预定义的处理流水线转换为Provider可处理的格式，并将响应转换回客户端期望的格式。

### 🚨 架构原则合规性

本模块严格遵循RouteCodex 9大核心架构原则：

| 架构原则 | 实施状态 | 关键实现 |
|---------|---------|----------|
| 原则1: 统一工具处理 | ✅ 完全合规 | 所有工具调用通过llmswitch-core处理 |
| 原则2: 最小兼容层 | ✅ 完全合规 | Compatibility层仅处理provider特定字段 |
| 原则3: 统一工具引导 | ✅ 完全合规 | 工具指引通过llmswitch-core统一管理 |
| 原则4: 快速死亡 | ✅ 完全合规 | 错误立即暴露，无fallback逻辑 |
| 原则5: 暴露问题 | ✅ 完全合规 | 结构化日志，完整错误上下文 |
| 原则6: 清晰解决 | ✅ 完全合规 | 单一处理路径，确定性行为 |
| 原则7: 功能分离 | ✅ 完全合规 | 模块职责明确，无功能重叠 |
| 原则8: 配置驱动 | ✅ 完全合规 | 完全配置化，无硬编码 |
| 原则9: 模块化 | ✅ 完全合规 | 文件大小控制，功能分拆 |

## 核心特性

### 🔧 模块化架构 (原则7: 功能分离)

严格遵循功能分离原则，每个模块职责单一明确：

- **LLMSwitch**: 协议转换层（目前专注OpenAI透传）
  - **不处理**: 工具调用转换、Provider特定字段
  - **专注**: 协议格式转换、请求规范化

- **Workflow**: 流式/非流式转换控制
  - **不处理**: 业务逻辑、数据格式转换
  - **专注**: 流式控制、缓冲管理

- **Compatibility**: 协议内字段适配和Provider特定处理
  - **不处理**: 工具调用转换（原则2: 最小兼容层）
  - **专注**: Provider特定字段标准化、reasoning_content处理

- **Provider**: 具体供应商实现（支持Qwen、LM Studio等）
  - **不处理**: 数据格式转换、工具逻辑
  - **专注**: HTTP通信、认证管理、连接管理

### 🚀 预创建流水线
- 初始化时创建所有需要的流水线
- 路由时直接选择对应流水线
- 避免运行时动态创建开销

### 📋 配置驱动 (原则8: 配置驱动)
- **完全配置化**: Provider配置中直接指定Compatibility规则
- **无硬编码**: 基于JSON配置的字段转换，所有参数可配置
- **类型安全**: 统一的转换表格式，配置验证机制
- **动态更新**: LM Studio Tools API自动适配，支持配置热更新

### 🛡️ 错误处理集成 (原则4-5: 快速死亡 & 暴露问题)
- **快速失败**: 集成ErrorHandlingCenter，错误立即暴露
- **无静默失败**: 所有错误都上报，提供完整上下文
- **清晰解决方案**: 认证失败自动恢复，单一处理路径
- **调试友好**: 结构化日志记录，包含完整错误信息和堆栈跟踪

## 近期变更（GLM 1210 兼容）

- 历史消息清理：对发往 GLM 的最终载荷，统一移除“非最后一条”消息上的 `assistant.tool_calls` 字段（最后一条若存在可保留）。此转换不禁用工具功能，也不删除上下文，仅去除会导致 GLM 1210 的历史痕迹字段。
- 工具与上下文保留：`tools` 定义、`tool` 角色消息保留（必要时仅保留文本内容），`tool_choice` 保持为上游支持的策略（默认 `auto`）。
- 回归验证：对最近失败样本离线上游重放，原样 400/1210 → 清理历史 `assistant.tool_calls` 后 200，一致通过。

### 相关环境变量

- `RCC_GLM_MAX_CONTEXT_TOKENS` / `RCC_GLM_CONTEXT_SAFETY_RATIO`：上下文裁剪预算与安全边界。
- `RCC_GLM_DISABLE_TRIM`：关闭上下文裁剪（默认启用裁剪）。
- `RCC_GLM_FEATURE_TOOLS`：是否启用工具功能（默认启用；设置为 `0` 可关闭）。

## 文件结构

```
src/modules/pipeline/
├── index.ts                          # 模块入口
├── README.md                         # 模块文档
├── core/                             # 核心流水线实现
│   ├── base-pipeline.ts              # 基础流水线类
│   ├── pipeline-manager.ts           # 流水线管理器
│   ├── openai-pipeline.ts            # OpenAI流水线实现
│   └── openai-pipeline-factory.ts    # OpenAI流水线工厂
├── interfaces/                       # 模块接口定义
│   ├── llm-switch-module.ts          # LLMSwitch接口
│   ├── workflow-module.ts            # Workflow接口
│   ├── compatibility-module.ts       # Compatibility接口
│   └── provider-module.ts           # Provider接口
├── modules/                          # 具体模块实现
│   ├── llm-switch/                   # LLMSwitch（实现由 rcc-llmswitch-core 提供）
│   │   └── README.md                 # 使用说明与引入方式
│   ├── workflow/                     # Workflow实现
│   │   └── streaming-control.ts      # 流式控制实现
│   ├── compatibility/                # Compatibility实现
│   │   ├── field-mapping.ts          # 字段映射实现
│   │   └── lmstudio-compatibility.ts  # LM Studio兼容性处理
│   └── providers/                    # Provider实现
│       ├── base-provider.ts          # 基础Provider类
│       ├── qwen-http-provider.ts     # Qwen HTTP Provider
│       ├── lmstudio-provider.ts      # LM Studio Provider
│       ├── generic-http-provider.ts   # 通用HTTP Provider
│       └── openai-provider.ts        # OpenAI Provider
├── types/                            # 类型定义
│   ├── pipeline-types.ts             # 流水线类型
│   ├── transformation-types.ts       # 转换类型
│   └── provider-types.ts             # Provider类型
├── utils/                            # 工具类
│   ├── transformation-engine.ts       # 转换引擎
│   ├── error-integration.ts          # 错误处理集成
│   └── debug-logger.ts              # 调试日志
└── config/                           # 配置管理
    └── pipeline-config-manager.ts    # 配置管理器
```

## 核心概念

### 流水线组合原则

源协议 + 目标Provider决定了流水线的组成：

```
源协议: OpenAI + 目标Provider: Qwen =
  LLMSwitch(OpenAI→OpenAI规范化) +
  Workflow(流控) +
  Compatibility(Qwen适配) +
  Provider(Qwen实现)

源协议: OpenAI + 目标Provider: LM Studio =
  LLMSwitch(OpenAI→OpenAI规范化) +
  Workflow(流控) +
  Compatibility(LM Studio Tools API适配) +
  Provider(LM Studio实现)
```

### 模块层次 (原则7: 功能分离 & 原则2: 最小兼容层)

1. **LLMSwitch层**: 协议转换 (委托给llmswitch-core)
   - OpenAI → OpenAI: 请求规范化
   - Anthropic → OpenAI: 协议转换
   - **原则1合规**: 工具调用统一处理通过llmswitch-core
   - 未来可扩展其他协议映射

2. **Workflow层**: 流式控制
   - 流式请求 → 非流式发送
   - 非流式响应 → 流式返回
   - 缓冲管理
   - **原则7合规**: 只处理流式控制，不涉及业务逻辑

3. **Compatibility层**: 字段适配 (最小化处理)
   - 基于JSON配置的字段转换
   - **原则2合规**: 仅处理Provider特定字段，不做工具调用转换
   - LM Studio Tools API字段映射（非工具逻辑）
   - 响应格式标准化（reasoning_content、usage等）

4. **Provider层**: 服务实现
   - HTTP请求处理
   - 认证管理
   - **原则4合规**: 错误立即暴露，不隐藏失败
   - 连接管理和超时控制
   - **原则2合规**: 不处理工具调用逻辑

## 使用示例

### 基本使用

```typescript
import { PipelineManager, OpenAIPipelineFactory } from './pipeline/index.js';

// 创建流水线管理器
const pipelineManager = new PipelineManager();
await pipelineManager.initialize({
  pipelines: [
    {
      id: 'qwen.qwen3-coder-plus',
      provider: qwenProviderConfig,
      modules: {
        llmSwitch: { type: 'llmswitch-openai-openai' },
        workflow: { type: 'streaming-control' },
        compatibility: { type: 'field-mapping' },
        provider: { type: 'qwen-http' }
      }
    }
  ]
});

// 选择流水线处理请求
const pipeline = pipelineManager.selectPipeline({
  providerId: 'qwen',
  modelId: 'qwen3-coder-plus'
});

const response = await pipeline.processRequest(request);
```

### LM Studio集成示例

LM Studio集成支持Tools API和完整的工具调用功能：

```typescript
// 创建LM Studio流水线
const lmStudioPipeline = {
  id: 'lmstudio.llama2-7b-chat',
  provider: {
    type: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    protocol: 'openai',
    compatibility: {
      enabled: true,
      toolsApi: true,
      requestMappings: [
        {
          sourcePath: 'tools',
          targetPath: 'tools',
          transform: 'lmstudio-tools'
        },
        {
          sourcePath: 'model',
          targetPath: 'model',
          transform: 'mapping',
          mapping: {
            'gpt-4': 'llama2-7b-chat',
            'gpt-3.5-turbo': 'llama2-7b-chat'
          }
        }
      ]
    },
    config: {
      baseUrl: 'http://localhost:1234',
      auth: {
        type: 'apikey',
        apiKey: '${LM_STUDIO_API_KEY}'
      },
      models: {
        'llama2-7b-chat': {
          maxTokens: 4096,
          temperature: 0.7,
          toolsEnabled: true
        }
      }
    }
  },
  modules: {
    llmSwitch: { type: 'llmswitch-openai-openai' },
    workflow: { type: 'streaming-control' },
    compatibility: { type: 'lmstudio-compatibility' },
    provider: { type: 'lmstudio-http' }
  }
};

// 使用工具调用
const toolCallRequest = {
  messages: [
    { role: 'user', content: 'What is the weather in Beijing?' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather information for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state, e.g. San Francisco, CA'
            }
          },
          required: ['location']
        }
      }
    }
  ]
};

const response = await pipeline.processRequest(toolCallRequest);
```

### Provider配置示例

```typescript
const qwenProviderConfig = {
  id: 'qwen-provider',
  type: 'qwen',
  protocol: 'openai',
  compatibility: {
    enabled: true,
    requestMappings: [
      {
        sourcePath: 'model',
        targetPath: 'model',
        transform: 'mapping',
        mapping: {
          'gpt-4': 'qwen3-coder-plus',
          'gpt-3.5-turbo': 'qwen3-coder'
        }
      }
    ],
    responseMappings: [
      {
        sourcePath: 'usage.prompt_tokens',
        targetPath: 'usage.prompt_tokens',
        transform: 'direct'
      }
    ]
  },
  config: {
    baseUrl: 'https://portal.qwen.ai/v1',
    auth: {
      type: 'apikey',
      apiKey: '${QWEN_API_KEY}'
    }
  }
};
```

## 配置选项

### 流水线配置

```typescript
interface PipelineConfig {
  id: string;                              // 流水线ID (provider.model)
  provider: ProviderConfig;                // Provider配置
  modules: {
    llmSwitch: {
      type: 'llmswitch-openai-openai';     // LLMSwitch类型（实现来源 rcc-llmswitch-core）

## 构建顺序（重要）

涉及 `sharedmodule/` 下的修改，需要遵循“先模块、后整包”的构建顺序：

- 先编译共享模块（例如：`sharedmodule/llmswitch-core`）：
  - `npm run --workspace sharedmodule/llmswitch-core build`
- 再编译根包并进行安装或发布：
  - `npm run build`
  - 如需全局安装：`npm pack && npm i -g ./routecodex-<version>.tgz`

这样可确保 rcc-llmswitch-core 的最新改动被根包正确引用，避免“旧实现或未生效”的问题。
      config?: any;                        // 额外配置
    };
    workflow: {
      type: 'streaming-control';           // Workflow类型
      config: {
        streamingToNonStreaming: boolean;  // 流式转非流式
        nonStreamingToStreaming: boolean;  // 非流式转流式
      };
    };
    compatibility: {
      type: 'field-mapping';              // Compatibility类型
    };
    provider: {
      type: string;                        // Provider类型
      config: any;                         // Provider配置
    };
  };
}
```

### 转换规则配置

```typescript
interface TransformationRule {
  sourcePath: string;          // 源JSON路径
  targetPath: string;          // 目标JSON路径
  transform: TransformType;   // 转换类型
  mapping?: Record<string, any>; // 值映射表
  defaultValue?: any;          // 默认值
  required?: boolean;          // 是否必需
}

type TransformType =
  | 'direct'                    // 直接映射
  | 'mapping'                   // 值映射
  | 'rename'                    // 重命名字段
  | 'structure'                 // 结构转换
  | 'array-transform'           // 数组转换
  | 'object-transform'          // 对象转换
  | 'conditional'               // 条件转换
  | 'function'                  // 自定义函数
  | 'lmstudio-tools'            // LM Studio工具调用转换
  | 'lmstudio-response'         // LM Studio响应格式转换
```

## 错误处理

流水线模块集成了ErrorHandlingCenter，提供统一的错误处理机制：

```typescript
// 错误处理示例
try {
  const response = await pipeline.processRequest(request);
} catch (error) {
  // 错误已自动上报到ErrorHandlingCenter
  // 包含完整的上下文信息：
  // - 流水线ID
  // - 失败模块
  // - 请求ID
  // - 时间戳
  // - 错误堆栈
}
```

### 认证错误处理

- **APIKey失效**: 直接返回错误
- **OAuth过期**: 自动刷新Token
- **认证失败**: 触发浏览器重新认证

## 调试支持

每个请求和响应都会被记录为单独的debug信息：

```typescript
// Debug日志包含每个处理阶段的信息
{
  pipeline: 'qwen.qwen3-coder-plus',
  stage: 'compatibility.request',
  timestamp: '2025-01-22T10:30:00Z',
  data: { /* 转换后的请求数据 */ },
  metadata: {
    requestId: 'req-123',
    duration: 5,
    transformRules: ['model-mapping', 'max_tokens-direct']
  }
}
```

## 性能考虑

- **预创建流水线**: 避免运行时创建开销
- **模块化设计**: 支持按需加载和替换
- **并行处理**: 支持多个请求并行处理
- **内存管理**: 及时清理中间数据

## 扩展性

### 添加新的LLMSwitch实现

```typescript
class NewLLMSwitch implements LLMSwitchModule {
  async transformRequest(request: any): Promise<any> {
    // 实现协议转换逻辑
  }

  async transformResponse(response: any): Promise<any> {
    // 实现响应转换逻辑
  }
}
```

### 添加新的Provider实现

```typescript
class NewProvider extends BaseProvider {
  async sendRequest(request: any): Promise<any> {
    // 实现Provider特定的请求处理
  }

  async authenticate(): Promise<AuthResult> {
    // 实现认证逻辑
  }
}
```

## 依赖关系

- **rcc-basemodule**: 基础模块功能
- **errorhandling**: 错误处理中心
- **debugcenter**: 调试中心集成
- **config-manager**: 配置管理
- **transformation-tables**: 转换表配置

## 版本信息

- **当前版本**: 1.0.0
- **兼容性**: RouteCodex v0.2+
- **最后更新**: 2025-01-22
