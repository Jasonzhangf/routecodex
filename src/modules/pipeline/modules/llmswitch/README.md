# LLMSwitch 模块

LLMSwitch 模块提供多协议转换功能，将不同的大语言模型API协议进行相互转换，支持 OpenAI、Anthropic、Responses 等多种协议格式。

## 🎯 模块概述

LLMSwitch 模块是流水线架构的第 1 层（协议转换层），负责处理进入流水线的第一个协议转换步骤。它分析传入请求的协议类型，并将其转换为目标供应商所期望的协议格式。

## 🔄 支持的协议转换

### 🔧 OpenAI 规范化转换器
- **实现文件**: `openai-normalizer.ts` / `llmswitch-openai-openai.ts`
- **功能**: OpenAI 协议规范化，保持请求结构一致
- **特性**:
  - 完整的 OpenAI 协议支持
  - 请求/响应元数据添加
  - 性能监控和调试信息
  - 协议验证和标准化
  - 错误上下文增强

### 🤖 Anthropic-OpenAI 双向转换器
- **实现文件**: `llmswitch-anthropic-openai.ts`
- **功能**: Anthropic 协议与 OpenAI 协议互转
- **特性**:
  - 消息格式转换
  - 工具调用适配
  - 流式响应处理
  - 推理内容处理
  - 响应格式标准化

### 🆕 Responses-Chat 转换器
- **实现文件**: `llmswitch-response-chat.ts`
- **功能**: OpenAI Responses API 与 Chat Completions API 互转
- **特性**:
  - **双向转换**: Responses ↔ Chat 格式完全支持
  - **工具调用**: 完整的工具调用格式转换
  - **流式事件**: 支持 Responses API 的所有 SSE 事件
  - **元数据保持**: 保留原始请求上下文和协议信息
  - **智能处理**: 自动处理 reasoning、function_call 等特殊内容

### 🔄 统一协议转换器
- **实现文件**: `llmswitch-unified.ts`
- **功能**: 多协议智能转换和路由
- **特性**:
  - 自动协议检测
  - 智能转换策略选择
  - 多协议支持
  - 统一错误处理

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
├── openai-normalizer.ts              # OpenAI 规范化实现
├── llmswitch-openai-openai.ts        # OpenAI → OpenAI 转换器
├── llmswitch-anthropic-openai.ts    # Anthropic ↔ OpenAI 转换器
├── llmswitch-response-chat.ts        # Responses ↔ Chat 转换器 ⭐
├── llmswitch-unified.ts              # 统一协议转换器
├── anthropic-openai-converter.ts    # Anthropic 转换器工具
├── anthropic-openai-config.ts        # Anthropic 转换配置
└── README.md                         # 本文档
```

## 🚀 使用示例

### Responses API 转换
```typescript
import { ResponsesToChatLLMSwitch } from './llmswitch-response-chat.js';

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

### 在流水线配置中使用
```typescript
const pipelineConfig = {
  modules: {
    llmSwitch: {
      type: 'llmswitch-response-chat',  // Responses 支持
      config: {
        enableValidation: true,
        enablePerformanceTracking: true,
        preserveOriginalContext: true
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