# LLMSwitch 模块

LLMSwitch 模块提供协议转换功能，将不同的大语言模型API协议进行相互转换，支持 OpenAI、Anthropic Claude、Responses API 等多种协议的双向转换。

## 🎯 模块概述

LLMSwitch 模块是流水线架构的第 1 层（协议转换层），负责处理进入流水线的第一个协议转换步骤。它分析传入请求的协议类型，并将其转换为目标供应商所期望的协议格式。

### 📋 核心职责
- **协议识别**: 自动检测请求协议类型（OpenAI Chat、Responses、Anthropic）
- **双向转换**: 支持多种协议之间的双向转换
- **格式规范化**: 确保请求格式符合目标协议要求
- **元数据注入**: 添加转换追踪和调试信息
- **工具调用适配**: 处理不同协议的工具调用格式差异

## 🔄 支持的协议转换

### 🔧 OpenAI → OpenAI 规范化
- **实现来源**: rcc-llmswitch-core（包内实现）
- **导入路径**: `rcc-llmswitch-core/llmswitch/openai-normalizer`
- **类型**: `llmswitch-openai-openai`
- **协议**: `openai` → `openai`
- **功能**: OpenAI 协议规范化和验证
- **特性**:
  - 严格的 Chat Completions 格式验证
  - 工具调用参数标准化（JSON 字符串验证）
  - 函数名称与工具声明匹配验证
  - 消息格式规范化
  - 基于 `rcc-llmswitch-core` 的转换引擎
  - 请求/响应元数据添加
  - 调试和性能监控

### 🔄 Anthropic ↔ OpenAI 双向转换
- **实现来源**: rcc-llmswitch-core（包内实现）
- **导入路径**: `rcc-llmswitch-core/llmswitch/anthropic-openai-converter`
- **类型**: `llmswitch-anthropic-openai`
- **协议**: `anthropic` ↔ `openai`
- **功能**: Anthropic Claude API 与 OpenAI Chat API 互转
- **特性**:
  - 基于配置驱动的转换映射
  - 支持请求和响应双向转换
  - 智能协议检测和路由
  - 工具调用格式适配
  - 流式响应支持
  - 模型参数映射（temperature, max_tokens 等）
  - 转换上下文管理（按 requestId 记录入口协议）
  - 严格模式和信任模式（trustSchema）

### 🌐 Responses → Chat 转换
- **实现来源**: rcc-llmswitch-core（包内实现）
- **导入路径**: `rcc-llmswitch-core/llmswitch/llmswitch-response-chat`
- **类型**: `llmswitch-response-chat`
- **协议**: `openai-responses` → `openai`
- **功能**: OpenAI Responses API 转换为 Chat Completions 格式
- **特性**:
  - 基于 `rcc-llmswitch-core/conversion` 的标准化转换
  - 请求上下文捕获和管理
  - 工具调用格式转换
  - 响应 ID 提取和追踪
  - 自动模式检测（自动选择最佳转换策略）

### 🔄 Responses Passthrough
- **实现来源**: rcc-llmswitch-core（包内实现）
- **导入路径**: `rcc-llmswitch-core/llmswitch/llmswitch-responses-passthrough`
- **类型**: `llmswitch-responses-passthrough`
- **协议**: `openai-responses` → `openai-responses`
- **功能**: Responses API 直接透传，最小转换开销
- **特性**:
  - 基本的对象形状验证
  - 元数据标记和注入
  - 最小性能开销
  - 适用于原生 Responses API 支持

### 🛠️ 转换路由器
- **实现文件**: `llmswitch-conversion-router.ts`
- **类型**: `llmswitch-conversion-router`
- **协议**: 智能路由到其他 LLMSwitch 实现
- **功能**: 根据请求类型和配置智能路由到适当的转换器
- **特性**:
  - 动态转换器选择
  - 配置驱动的路由规则
  - 多协议支持
  - 回退机制

## 📁 文件结构

```
src/modules/pipeline/modules/llmswitch/
├── conversion/                     # （如需覆盖的）转换规则/配置
│   ├── anthropic-openai-config.ts
│   └── ...
├── utils/
│   └── ...
├── (核心实现由 rcc-llmswitch-core 提供)
├── llmswitch-conversion-router.ts   # 路由器（如保留）
└── README.md                        # 本文档
```

## 🚀 使用示例

### OpenAI 规范化使用
```typescript
import { OpenAINormalizerLLMSwitch } from 'rcc-llmswitch-core/llmswitch/openai-normalizer';

const llmSwitch = new OpenAINormalizerLLMSwitch({
  type: 'llmswitch-openai-openai',
  config: {
    enableValidation: true,
    enableMetadata: true
  }
}, dependencies);

await llmSwitch.initialize();

// 处理 OpenAI 请求，确保格式规范
const normalizedRequest = await llmSwitch.processIncoming({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Perform calculations',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string' }
          }
        }
      }
    }
  ]
});

// 结果: 格式规范化的请求，包含工具调用验证
```

### Anthropic-OpenAI 双向转换
```typescript
import { AnthropicOpenAIConverter } from 'rcc-llmswitch-core/llmswitch/anthropic-openai-converter';

const converter = new AnthropicOpenAIConverter({
  type: 'llmswitch-anthropic-openai',
  config: {
    enableStreaming: true,
    enableTools: true,
    trustSchema: true,
    conversionMappings: {
      // 自定义转换映射
      requestMappings: { /* ... */ },
      responseMappings: { /* ... */ }
    }
  }
}, dependencies);

await converter.initialize();

// Anthropic 格式请求
const anthropicRequest = {
  model: 'claude-3-sonnet',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  max_tokens: 1000,
  tools: [ /* Anthropic 工具格式 */ ]
};

// 自动检测并转换为 OpenAI 格式
const openAIRequest = await converter.processIncoming(anthropicRequest);
```

### Responses API 转换
```typescript
import { ResponsesToChatLLMSwitch } from 'rcc-llmswitch-core/llmswitch/llmswitch-response-chat';

## 构建顺序（重要）

涉及 `sharedmodule/` 下的修改，请遵循“先模块、后整包”的构建顺序：

- 构建共享模块：`npm run --workspace sharedmodule/llmswitch-core build`
- 构建根包：`npm run build`

确保 core 改动优先生效，避免引用旧构件导致的不一致。

const responsesConverter = new ResponsesToChatLLMSwitch({
  type: 'llmswitch-response-chat',
  config: {
    // 配置选项
  }
}, dependencies);

await responsesConverter.initialize();

// Responses API 格式请求
const responsesRequest = {
  model: 'gpt-4-turbo',
  input: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [ /* Responses 工具格式 */ ]
};

// 转换为 Chat Completions 格式
const chatRequest = await responsesConverter.processIncoming(responsesRequest);
```

## ⚙️ 配置选项

### OpenAI 规范化配置
```typescript
interface OpenAINormalizerConfig {
  enableValidation?: boolean;        // 启用严格验证
  enableMetadata?: boolean;          // 启用元数据增强
  maxLogEntries?: number;           // 最大日志条目数
}
```

### Anthropic-OpenAI 转换配置
```typescript
interface AnthropicOpenAIConfig {
  enableStreaming?: boolean;         // 启用流式转换
  enableTools?: boolean;            // 启用工具转换
  trustSchema?: boolean;            // 信任模式（不重命名工具）
  conversionMappings?: {            // 自定义转换映射
    requestMappings?: any;
    responseMappings?: any;
  };
}
```

### Responses 转换配置
```typescript
interface ResponsesChatConfig {
  autoMode?: boolean;              // 自动模式检测
  preserveResponsesFormat?: boolean; // 保持 Responses 格式
}
```

## 🔄 转换流程

### 协议检测和路由
```typescript
// 自动协议检测
function detectProtocol(request: any): 'openai' | 'anthropic' | 'responses' {
  if (request.messages) return 'openai';
  if (request.input) return 'responses';
  if (request.anthropic_version) return 'anthropic';
  return 'openai'; // 默认
}

// 转换路由
const converter = selectConverter(detectProtocol(request), targetProtocol);
const converted = await converter.processIncoming(request);
```

### 元数据注入
```typescript
// 所有转换都会注入统一的元数据
const enhancedRequest = {
  ...convertedRequest,
  _metadata: {
    switchType: 'llmswitch-xxx',
    timestamp: Date.now(),
    entryProtocol: 'detected-protocol',
    targetProtocol: 'target-protocol',
    requestId: 'generated-or-preserved-id',
    conversionContext: { /* 转换上下文 */ }
  }
};
```

## 🛡️ 错误处理

### 协议验证错误
```typescript
// OpenAI 格式验证
if (!request.messages && !request.prompt) {
  throw new Error('Invalid OpenAI protocol: missing messages or prompt');
}

// 工具调用验证
if (request.tool_calls) {
  for (const toolCall of request.tool_calls) {
    if (toolCall.function && typeof toolCall.function.arguments !== 'string') {
      throw new Error('Tool function.arguments must be a JSON string');
    }
  }
}
```

### 转换错误处理
```typescript
// 转换失败时的处理
try {
  const converted = await this.convertRequest(request);
} catch (error) {
  this.logger.logModule(this.id, 'conversion-error', {
    error: error.message,
    entryProtocol: this.detectedProtocol,
    targetProtocol: this.targetProtocol
  });
  throw new Error(`Protocol conversion failed: ${error.message}`);
}
```

## 📊 性能监控

### 转换性能追踪
```typescript
// 性能元数据
const performanceMetadata = {
  conversionTime: Date.now() - startTime,
  entryProtocol: detectedProtocol,
  targetProtocol: targetProtocol,
  conversionRules: appliedRules.length,
  hasTools: !!request.tools,
  messageCount: request.messages?.length || 0
};
```

### 转换统计
```typescript
// 转换统计信息
const stats = await llmSwitch.getConversionStats();
console.log({
  totalConversions: stats.totalConversions,
  successRate: stats.successRate,
  averageConversionTime: stats.averageTime,
  protocolDistribution: stats.protocolDistribution
});
```

## 🌐 API 协议支持

### OpenAI Chat Completions API
- **端点**: `/v1/chat/completions`
- **请求格式**: `{ messages, model, tools, tool_calls, stream }`
- **响应格式**: `{ choices, usage, id, created }`
- **特性**: 工具调用、流式响应、多轮对话

### OpenAI Responses API
- **端点**: `/v1/responses`
- **请求格式**: `{ input, model, tools, stream }`
- **响应格式**: `{ output, usage, id, created }`
- **特性**: 新一代 API、简化格式、原生工具支持

### Anthropic Claude API
- **端点**: `/v1/messages`
- **请求格式**: `{ messages, model, max_tokens, tools }`
- **响应格式**: `{ content, usage, id, created }`
- **特性**: 系统提示、工具使用、思考内容

## 🔧 扩展性

### 添加新的协议转换
```typescript
class NewProtocolConverter implements LLMSwitchModule {
  readonly type = 'llmswitch-new-protocol';
  readonly protocol = 'new-protocol';

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    // 检测协议
    const detectedProtocol = this.detectProtocol(request.data);

    // 执行转换
    const converted = await this.convertProtocol(request.data, detectedProtocol, 'target');

    // 注入元数据
    return {
      ...request,
      data: {
        ...converted,
        _metadata: {
          switchType: this.type,
          timestamp: Date.now(),
          entryProtocol: detectedProtocol,
          targetProtocol: 'target'
        }
      }
    };
  }

  private detectProtocol(data: any): string {
    // 实现协议检测逻辑
  }

  private async convertProtocol(data: any, from: string, to: string): Promise<any> {
    // 实现协议转换逻辑
  }
}
```

### 自定义转换规则
```typescript
// 在 anthropic-openai-config.ts 中添加自定义映射
const customMappings = {
  requestMappings: [
    {
      sourcePath: 'max_tokens',
      targetPath: 'max_tokens',
      transform: 'direct'
    },
    {
      sourcePath: 'temperature',
      targetPath: 'temperature',
      transform: 'mapping',
      mapping: {
        0: 0,
        1: 1,
        2: 2  // Anthropic 0-2 映射到 OpenAI 0-2
      }
    }
  ],
  responseMappings: [
    // 响应映射规则
  ]
};
```

## 📈 版本信息

- **当前版本**: 3.0.0
- **新增特性**:
  - Responses API 支持
  - Anthropic 双向转换
  - 智能转换路由
  - 基于 `rcc-llmswitch-core` 的标准化转换
- **兼容性**: RouteCodex Pipeline >= 3.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-llmswitch-core**: 核心转换引擎和工具函数
- **PipelineDebugLogger**: 模块日志记录
- **BaseModule**: 基础模块接口
- **SharedPipelineRequest/Response**: 共享数据传输对象

## 🚨 已知限制

### 当前限制
1. **协议版本支持** - 主要支持 API v1 版本
2. **实时转换** - 流式协议转换存在延迟
3. **复杂工具链** - 多步骤工具调用转换可能不完整
4. **错误恢复** - 转换失败后的回退机制有限

### 未来计划
1. **更多协议支持** - Google Gemini、Cohere 等
2. **实时流式转换** - 零延迟流式协议转换
3. **智能协议检测** - 基于内容特征的自动协议识别
4. **转换规则学习** - 基于使用模式的智能优化

## 🔄 更新日志

### v3.0.0 (2025-10-24)
- ✨ 新增 Responses API 完整支持
- ✨ 新增 Anthropic ↔ OpenAI 双向转换
- ✨ 新增智能转换路由器
- 🔄 基于 `rcc-llmswitch-core` 的标准化重构
- 🛡️ 增强的工具调用验证和转换
- 📊 完善的性能监控和调试支持

### v2.0.0 (2025-01-22)
- 🔧 OpenAI 规范化功能增强
- 📊 性能监控功能完善
- 🛡️ 错误处理机制优化

### v1.0.0 (2025-01-15)
- 🎯 初始版本发布
- 🔄 基础的 OpenAI 透传功能
- 📊 简单的元数据注入

## 📞 技术支持

如有问题或建议，请：
1. 检查协议格式是否符合对应 API 规范
2. 验证转换配置是否正确
3. 查看转换日志了解详细信息
4. 检查目标协议的官方文档

---

**最后更新**: 2025-10-24 - 全面更新 LLMSwitch 模块文档，新增 Responses API 和 Anthropic 支持

LLMSwitch 模块提供多协议转换功能，将不同的大语言模型API协议进行相互转换，支持 OpenAI、Anthropic、Responses 等多种协议格式。

## 🎯 模块概述

LLMSwitch 模块是流水线架构的第 1 层（协议转换层），负责处理进入流水线的第一个协议转换步骤。它分析传入请求的协议类型，并将其转换为目标供应商所期望的协议格式。

## 🔄 支持的协议转换

### 🔧 OpenAI 规范化转换器
- 实现来源: rcc-llmswitch-core（包内实现）
- 导入路径: `rcc-llmswitch-core/llmswitch/openai-normalizer`
- **功能**: OpenAI 协议规范化，保持请求结构一致
- **特性**:
  - 完整的 OpenAI 协议支持
  - 请求/响应元数据添加
  - 性能监控和调试信息
  - 协议验证和标准化
  - 错误上下文增强

### 🤖 Anthropic-OpenAI 双向转换器
- 实现来源: rcc-llmswitch-core（包内实现）
- 导入路径: `rcc-llmswitch-core/llmswitch/anthropic-openai-converter`
- **功能**: Anthropic 协议与 OpenAI 协议互转
- **特性**:
  - 消息格式转换
  - 工具调用适配
  - 流式响应处理
  - 推理内容处理
  - 响应格式标准化

### 🆕 Responses-Chat 转换器（经由 core codecs）
- 实现来源: rcc-llmswitch-core（包内实现）
- 导入路径: `rcc-llmswitch-core/llmswitch/llmswitch-response-chat`
- **功能**: OpenAI Responses API 与 Chat Completions API 互转
- **特性**:
  - **双向转换**: Responses ↔ Chat 格式完全支持
  - **工具调用**: 完整的工具调用格式转换
  - **流式事件**: 支持 Responses API 的所有 SSE 事件
  - **元数据保持**: 保留原始请求上下文和协议信息
  - **智能处理**: 自动处理 reasoning、function_call 等特殊内容
- **统一入口**: 在最新架构下，所有流水线实例都挂载 `llmswitch-conversion-router`，并依靠 `entryEndpoint` 自动匹配对应 codec（OpenAI / Anthropic / Responses），无需额外的手工配置。
- **核心实现收敛**: 具体的转换逻辑（Responses↔Chat、OpenAI 规范化等）已迁移到 `@routecodex/llmswitch-core`，此处适配器仅做委派，避免重复实现。

### ⛔ 统一协议转换器
该实现已移除。统一路由由 `llmswitch-conversion-router` + `rcc-llmswitch-core` 的 `switch-orchestrator` + `codecs/*` 提供，请使用 conversion-router 作为入口。

## 🌟 核心功能

### 📊 协议检测与路由
```typescript
// 自动协议检测
private detectProtocol(request: any): 'openai' | 'anthropic' | 'responses' | 'unknown' {
  if (request.input && Array.isArray(request.input)) {
    return 'responses';
  } else if (request.messages) {
    return 'openai';
  } else if (this.hasAnthropicFormat(request)) {
    return 'anthropic';
  }
  return 'unknown';
}
```

### 🔄 Responses 转换示例
```typescript
// Responses → Chat 转换
const responsesToChat = new ResponsesToChatLLMSwitch(config, dependencies);

// 输入：Responses API 格式
const responsesRequest = {
  model: 'gpt-4',
  instructions: 'You are a helpful assistant.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello!' }]
    }
  ],
  tools: [/* 工具定义 */],
  stream: true
};

// 输出：Chat Completions 格式
const chatRequest = await responsesToChat.processIncoming(responsesRequest);
// {
//   model: 'gpt-4',
//   messages: [
//     { role: 'system', content: 'You are a helpful assistant.' },
//     { role: 'user', content: 'Hello!' }
//   ],
//   tools: [/* 转换后的工具定义 */],
//   stream: true,
//   _metadata: {
//     switchType: 'llmswitch-response-chat',
//     entryProtocol: 'responses',
//     targetProtocol: 'openai'
//   }
// }
```

### 📋 元数据增强
```typescript
// 请求元数据提取
private extractRequestMetadata(request: any, protocol: string): Record<string, any> {
  return {
    timestamp: Date.now(),
    protocol,
    entryProtocol: protocol,
    targetProtocol: this.getTargetProtocol(protocol),
    hasModel: !!request.model,
    hasTools: !!request.tools,
    hasStream: !!request.stream,
    messageCount: this.getMessageCount(request),
    toolCount: request.tools?.length || 0,
    requestType: this.inferRequestType(request, protocol)
  };
}
```

### 🛡️ 协议验证
```typescript
// 协议验证
private validateProtocol(request: any, protocol: string): void {
  switch (protocol) {
    case 'openai':
      this.validateOpenAIProtocol(request);
      break;
    case 'anthropic':
      this.validateAnthropicProtocol(request);
      break;
    case 'responses':
      this.validateResponsesProtocol(request);
      break;
    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
}
```

## 📁 文件结构

```
src/modules/pipeline/modules/llmswitch/
├── (兼容保留) openai-normalizer.ts   # 旧本地实现（已由 core 提供统一实现）
├── (核心实现由 rcc-llmswitch-core 提供)
├── anthropic-openai-config.ts        # （如需覆盖）Anthropic 转换配置
└── README.md                         # 本文档
```

## 🚀 使用示例

### Responses API 转换
```typescript
import { ResponsesToChatLLMSwitch } from 'rcc-llmswitch-core/llmswitch/llmswitch-response-chat';

const responsesSwitch = new ResponsesToChatLLMSwitch({
  type: 'llmswitch-response-chat',
  config: {
    enableValidation: true,
    enableMetadata: true,
    preserveReasoning: true
  }
}, dependencies);

await responsesSwitch.initialize();

// 处理 Responses API 请求
const chatRequest = await responsesSwitch.processIncoming({
  model: 'gpt-4',
  instructions: 'You are a helpful assistant.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Calculate 15 * 25' }]
    }
  ],
  tools: [
    {
      type: 'function',
      name: 'calculate',
      description: 'Perform mathematical calculations',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' }
        }
      }
    }
  ]
});
```

### 在流水线配置中使用（通过 conversion-router）
```typescript
const pipelineConfig = {
  modules: {
    llmSwitch: {
      type: 'llmswitch-conversion-router',  // 统一入口（根据 entryEndpoint 自动选择 codec）
      config: {
        // 由主包在运行时提供：
        // baseDir 指向包根（包含 config/），profilesPath 相对该目录
        baseDir: "<auto>",
        profilesPath: "config/conversion/llmswitch-profiles.json"
      }
    }
  }
};
```

### 配置示例
```json
{
  "virtualrouter": {
    "inputProtocol": "responses",
    "outputProtocol": "openai",
    "providers": {
      "lmstudio": {
        "type": "lmstudio",
        "baseURL": "http://localhost:1234",
        "apiKey": "your-api-key",
        "models": {
          "gpt-4": {
            "compatibility": {
              "type": "responses-chat-switch"
            }
          }
        }
      }
    },
    "routing": {
      "default": ["lmstudio.gpt-4"]
    }
  }
}
```

## ⚙️ 配置选项

### Responses-Chat 转换配置
```typescript
interface ResponsesChatConfig {
  enableValidation?: boolean;           // 启用协议验证
  enableMetadata?: boolean;             // 启用元数据增强
  preserveReasoning?: boolean;          // 保留推理内容
  enableToolMapping?: boolean;          // 启用工具映射
  maxLogEntries?: number;               // 最大日志条目数
  streamingChunkSize?: number;          // 流式响应块大小
}
```

### OpenAI 透传配置
```typescript
interface OpenAIPassthroughConfig {
  enableValidation?: boolean;           // 启用协议验证
  enableMetadata?: boolean;             // 启用元数据增强
  enablePerformanceTracking?: boolean;  // 启用性能跟踪
  maxLogEntries?: number;               // 最大日志条目数
}
```

### Anthropic-OpenAI 转换配置
```typescript
interface AnthropicOpenAIConfig {
  direction: 'anthropic-to-openai' | 'openai-to-anthropic';
  enableTools?: boolean;                 // 启用工具转换
  enableStreaming?: boolean;             // 启用流式转换
  preserveReasoning?: boolean;           // 保留推理内容
  modelMappings?: Record<string, string>; // 模型映射
}
```

## 🔄 支持的转换映射

### Responses ↔ Chat 转换
| Responses 字段 | Chat 字段 | 说明 |
|----------------|------------|------|
| `instructions` | `messages[0].content` (system role) | 系统指令 |
| `input[].content[]` | `messages[].content` | 消息内容 |
| `tools[]` | `tools[]` | 工具定义 |
| `tool_choice` | `tool_choice` | 工具选择 |
| `max_output_tokens` | `max_tokens` | 最大令牌数 |
| `stream` | `stream` | 流式控制 |

### 工具调用转换
```typescript
// Responses 格式工具调用
{
  "type": "function_call",
  "name": "calculate",
  "arguments": "{\"expression\":\"15*25\"}",
  "call_id": "call_123"
}

// 转换为 Chat 格式
{
  "tool_calls": [{
    "id": "call_123",
    "type": "function",
    "function": {
      "name": "calculate",
      "arguments": "{\"expression\":\"15*25\"}"
    }
  }]
}
```

## 🎛️ 请求类型推断

### 支持的请求类型
```typescript
type RequestType =
  | 'chat'           // 聊天完成 (OpenAI)
  | 'messages'       // 消息格式 (Anthropic)
  | 'responses'      // Responses API
  | 'completion'     // 文本完成
  | 'embedding'      // 文本嵌入
  | 'tool'           // 工具调用
  | 'unknown';       // 未知类型
```

### 协议自动检测
```typescript
private detectProtocol(request: any): ProtocolType {
  // Responses API 检测
  if (request.input && Array.isArray(request.input)) {
    return 'responses';
  }

  // OpenAI Chat 检测
  if (request.messages && Array.isArray(request.messages)) {
    return 'openai';
  }

  // Anthropic Messages 检测
  if (this.hasAnthropicFormat(request)) {
    return 'anthropic';
  }

  return 'unknown';
}
```

## 📊 性能跟踪

### 性能元数据
```typescript
private addPerformanceMetadata(data: any, operation: string): any {
  return {
    ...data,
    _performance: {
      ...(data._performance || {}),
      [operation]: {
        timestamp: Date.now(),
        operation,
        moduleId: this.id,
        protocol: data._metadata?.originalProtocol
      }
    }
  };
}
```

### 转换性能监控
```typescript
// 转换性能统计
const conversionStats = {
  conversionTime: endTime - startTime,
  inputSize: JSON.stringify(request).length,
  outputSize: JSON.stringify(transformed).length,
  protocol: detectedProtocol,
  hasTools: !!request.tools,
  messageCount: this.getMessageCount(request)
};
```

## 🚨 错误处理

### 协议验证错误
```typescript
// Responses API 验证
if (protocol === 'responses') {
  if (!request.input || !Array.isArray(request.input)) {
    throw new Error('Invalid Responses protocol: input must be an array');
  }
}

// 工具格式验证
if (request.tools && !this.validateTools(request.tools)) {
  throw new Error('Invalid tool format in request');
}
```

### 转换错误处理
```typescript
// 转换错误记录和恢复
try {
  const transformed = await this.transformRequest(request, protocol);
} catch (error) {
  this.logger.logModule(this.id, 'transform-error', {
    error: error instanceof Error ? error.message : String(error),
    protocol,
    requestType: this.inferRequestType(request, protocol)
  });

  // 尝试降级处理
  return this.handleTransformError(request, error);
}
```

## 🔍 调试支持

### 详细日志记录
```typescript
// 请求转换日志
this.logger.logTransformation(this.id, 'responses-to-chat', request, transformed);

// 响应转换日志
this.logger.logTransformation(this.id, 'chat-to-responses', response, converted);

// 流式事件日志
this.logger.logModule(this.id, 'stream-event', {
  eventType: event.type,
  itemId: event.data.item_id,
  sequenceNumber: event.data.sequence_number
});
```

### 调试信息
```typescript
// 完整的调试上下文
const debugInfo = {
  sessionId: request._metadata?.sessionId,
  moduleId: this.id,
  operationId: 'llmswitch_transform',
  timestamp: Date.now(),
  type: 'transform',
  position: 'middle',
  data: {
    original: request,
    transformed: transformed,
    metadata: transformed._metadata,
    protocol: detectedProtocol,
    conversionStats
  }
};
```

## 🌐 API 端点支持

### 支持的端点
- **`/v1/chat/completions`** - OpenAI Chat Completions API
- **`/v1/responses`** - OpenAI Responses API ⭐
- **`/v1/messages`** - Anthropic Messages API
- **`/v1/completions`** - OpenAI Completions API

### 端点映射
```typescript
const endpointMappings = {
  '/v1/responses': {
    entryProtocol: 'responses',
    switchType: 'llmswitch-response-chat',
    targetProtocol: 'openai'
  },
  '/v1/chat/completions': {
    entryProtocol: 'openai',
    switchType: 'llmswitch-openai-openai',
    targetProtocol: 'openai'
  },
  '/v1/messages': {
    entryProtocol: 'anthropic',
    switchType: 'llmswitch-anthropic-openai',
    targetProtocol: 'openai'
  }
};
```

## 🔧 扩展性

### 添加新的 LLMSwitch 实现
```typescript
class NewProtocolLLMSwitch implements LLMSwitchModule {
  readonly type = 'llmswitch-new-protocol';
  readonly protocol = 'new-protocol';

  async processIncoming(request: any): Promise<any> {
    const context = this.captureRequestContext(request);
    const transformed = this.transformRequest(request, context);

    return {
      ...transformed,
      _metadata: {
        switchType: this.type,
        timestamp: Date.now(),
        entryProtocol: this.protocol,
        targetProtocol: 'openai',
        ...context
      }
    };
  }

  async processOutgoing(response: any): Promise<any> {
    const context = this.extractResponseContext(response);
    return this.transformResponse(response, context);
  }
}
```

### 自定义协议转换器
```typescript
class CustomProtocolConverter {
  async convertRequest(request: any, targetProtocol: string): Promise<any> {
    // 自定义请求转换逻辑
    switch (targetProtocol) {
      case 'openai':
        return this.convertToOpenAI(request);
      case 'anthropic':
        return this.convertToAnthropic(request);
      case 'responses':
        return this.convertToResponses(request);
      default:
        throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
}
```

## 📈 版本信息

- **当前版本**: 2.0.0
- **新增特性**: Responses API 完整支持
- **兼容性**: RouteCodex Pipeline >= 2.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-debugcenter**: 调试中心集成
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成
- **DebugEventBus**: 事件总线通信
- **BaseModule**: 基础模块接口

## ✨ 新特性 (v2.0.0)

### 🆕 Responses API 支持
- 完整的 Responses ↔ Chat 格式转换
- 支持所有 Responses API 字段和功能
- 工具调用完整支持
- 流式事件处理

### 🔧 增强的协议检测
- 自动检测输入协议类型
- 智能转换策略选择
- 错误恢复机制

### 📊 改进的调试功能
- 详细的转换日志
- 性能统计
- 协议转换可视化

## 🚀 更新日志

### v2.0.0 (2025-10-17)
- ✨ 新增 `llmswitch-response-chat` 转换器
- 🔄 完整的 Responses API 支持
- 📊 改进的性能跟踪和调试功能
- 🛡️ 增强的协议验证和错误处理
- 📚 完整的文档更新

### v1.5.0 (2025-01-22)
- 🔧 完善 Anthropic-OpenAI 转换
- 📊 新增性能跟踪功能
- 🛡️ 改进错误处理机制
- 📚 完善文档和调试支持说明

## 🔮 未来计划

### v2.1.0 计划
- 🤖 Google Gemini 协议支持
- 🔄 实时流式协议转换
- 📊 协议转换性能优化
- 🧪 更多的协议测试覆盖

### 长期规划
- 🌐 更多协议支持 (Cohere, Mistral 等)
- 🔄 协议版本管理
- 🧠 智能协议转换策略
- 📊 协议转换分析和报告

## 📞 技术支持

如有问题或建议，请：
1. 查看调试日志了解详细信息
2. 检查协议格式是否符合规范
3. 验证配置文件设置
4. 参考本文档的使用示例

---

**最后更新**: 2025-10-17 - 新增 Responses API 支持文档
