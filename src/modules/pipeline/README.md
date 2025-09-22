# Pipeline Module

RouteCodex流水线模块提供可组合的请求处理流水线，支持协议转换、流式控制和Provider适配。

## 概述

流水线模块是RouteCodex系统的核心请求处理组件，负责将路由后的请求通过预定义的处理流水线转换为Provider可处理的格式，并将响应转换回客户端期望的格式。

## 核心特性

### 🔧 模块化架构
- **LLMSwitch**: 协议转换层（目前专注OpenAI透传）
- **Workflow**: 流式/非流式转换控制
- **Compatibility**: 协议内字段适配和工具调用转换
- **Provider**: 具体供应商实现（支持Qwen、LM Studio等）

### 🚀 预创建流水线
- 初始化时创建所有需要的流水线
- 路由时直接选择对应流水线
- 避免运行时动态创建开销

### 📋 配置驱动
- Provider配置中直接指定Compatibility规则
- 基于JSON配置的字段转换
- 统一的转换表格式
- LM Studio Tools API自动适配

### 🛡️ 错误处理集成
- 集成ErrorHandlingCenter
- 无静默失败，所有错误都上报
- 支持认证失败自动恢复

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
│   ├── llm-switch/                   # LLMSwitch实现
│   │   └── openai-passthrough.ts     # OpenAI透传实现
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
│       └── openai-passthrough.ts     # OpenAI透传Provider
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
  LLMSwitch(OpenAI透传) +
  Workflow(流控) +
  Compatibility(Qwen适配) +
  Provider(Qwen实现)

源协议: OpenAI + 目标Provider: LM Studio =
  LLMSwitch(OpenAI透传) +
  Workflow(流控) +
  Compatibility(LM Studio Tools API适配) +
  Provider(LM Studio实现)
```

### 模块层次

1. **LLMSwitch层**: 协议转换
   - OpenAI ↔ OpenAI: 透传
   - OpenAI ↔ Anthropic: 协议转换
   - 目前专注OpenAI透传

2. **Workflow层**: 流式控制
   - 流式请求 → 非流式发送
   - 非流式响应 → 流式返回
   - 缓冲管理

3. **Compatibility层**: 字段适配
   - 基于JSON配置的字段转换
   - 工具调用适配
   - LM Studio Tools API转换
   - 响应格式转换

4. **Provider层**: 服务实现
   - HTTP请求处理
   - 认证管理
   - 错误处理
   - LM Studio会话管理
   - 工具调用执行

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
        llmSwitch: { type: 'openai-passthrough' },
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
    llmSwitch: { type: 'openai-passthrough' },
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
      type: 'openai-passthrough';          // LLMSwitch类型
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