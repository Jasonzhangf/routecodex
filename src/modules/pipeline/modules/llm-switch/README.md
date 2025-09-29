# LLMSwitch 模块

LLMSwitch 模块提供协议转换功能，将不同的大语言模型API协议进行相互转换，目前主要专注于 OpenAI 协议的透传和转换。

## 模块概述

LLMSwitch 模块是流水线架构的第 0 层（入口层），负责处理进入流水线的第一个协议转换步骤。它分析传入请求的协议类型，并将其转换为目标供应商所期望的协议格式。

## 支持的协议转换

### 🔧 OpenAI → OpenAI 规范化
- **实现文件**: `llmswitch-openai-openai.ts`
- **功能**: OpenAI 协议规范化，保持请求结构一致
- **特性**:
  - 完整的 OpenAI 协议支持
  - 请求/响应元数据添加
  - 性能监控和调试信息
  - 协议验证和标准化
  - 错误上下文增强

### 🔄 Anthropic-OpenAI 转换器
- **实现文件**: `anthropic-openai-converter.ts`
- **功能**: Anthropic 协议与 OpenAI 协议互转
- **特性**:
  - 消息格式转换
  - 参数映射
  - 工具调用适配
  - 响应格式标准化

## 核心功能

### 🎯 协议透传
```typescript
// OpenAI 规范化实现
class OpenAINormalizerLLMSwitch implements LLMSwitchModule {
  async processIncoming(request: any): Promise<any> {
    // 添加元数据但保持协议不变
    return {
      ...request,
      _metadata: {
        switchType: 'llmswitch-openai-openai',
        timestamp: Date.now(),
        originalProtocol: 'openai',
        targetProtocol: 'openai'
      }
    };
  }
}
```

### 📊 元数据增强
```typescript
// 请求元数据提取
private extractRequestMetadata(request: any): Record<string, any> {
  return {
    timestamp: Date.now(),
    hasModel: !!request.model,
    hasMessages: !!request.messages,
    hasTools: !!request.tools,
    hasStream: !!request.stream,
    messageCount: request.messages?.length || 0,
    toolCount: request.tools?.length || 0,
    requestType: this.inferRequestType(request)
  };
}
```

### 🛡️ 协议验证
```typescript
// 协议验证
private validateProtocol(request: any): void {
  if (!request.messages && !request.prompt) {
    throw new Error('Invalid OpenAI protocol: missing messages or prompt');
  }
  
  if (request.messages && !Array.isArray(request.messages)) {
    throw new Error('Invalid OpenAI protocol: messages must be an array');
  }
}
```

## 文件结构

```
src/modules/pipeline/modules/llm-switch/
├── llmswitch-openai-openai.ts    # OpenAI → OpenAI 规范化实现
├── anthropic-openai-converter.ts # Anthropic → OpenAI 转换器
├── anthropic-openai-config.ts    # 转换配置
└── README.md                     # 本文档
```

## 使用示例

### 基本使用
```typescript
import { OpenAINormalizerLLMSwitch } from './llmswitch-openai-openai.js';

const llmSwitch = new OpenAINormalizerLLMSwitch({
  type: 'llmswitch-openai-openai',
  config: {
    enableValidation: true,
    enableMetadata: true
  }
}, dependencies);

await llmSwitch.initialize();

// 处理 OpenAI 请求
const enhancedRequest = await llmSwitch.processIncoming({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [/* 工具定义 */],
  stream: false
});

// 结果包含增强的元数据
console.log(enhancedRequest._metadata);
// {
//   switchType: 'llmswitch-openai-openai',
//   timestamp: 1643723400000,
//   originalProtocol: 'openai',
//   targetProtocol: 'openai'
// }
```

### 在流水线中使用
```typescript
const pipelineConfig = {
  modules: {
    llmSwitch: {
      type: 'llmswitch-openai-openai',
      config: {
        enableValidation: true,
        enablePerformanceTracking: true
      }
    }
  }
};

// 请求增强
const enhancedRequest = await llmSwitch.processIncoming(request);
// 包含完整的调试和性能元数据
```

### 协议转换示例
```typescript
// Anthropic 到 OpenAI 转换
import { AnthropicOpenAIConverter } from './anthropic-openai-converter.js';

const converter = new AnthropicOpenAIConverter({
  type: 'llmswitch-anthropic-openai',
  config: {
    direction: 'anthropic-to-openai',
    enableTools: true
  }
}, dependencies);

await converter.initialize();

// Anthropic 格式请求
const anthropicRequest = {
  model: 'claude-3-sonnet',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  max_tokens: 1000
};

// 转换为 OpenAI 格式
const openAIRequest = await converter.transformRequest(anthropicRequest);
```

## 配置选项

### OpenAI 透传配置
```typescript
interface OpenAIPassthroughConfig {
  enableValidation?: boolean;        // 启用协议验证
  enableMetadata?: boolean;          // 启用元数据增强
  enablePerformanceTracking?: boolean; // 启用性能跟踪
  maxLogEntries?: number;            // 最大日志条目数
}
```

### Anthropic-OpenAI 转换配置
```typescript
interface AnthropicOpenAIConfig {
  direction: 'anthropic-to-openai' | 'openai-to-anthropic'; // 转换方向
  enableTools?: boolean;             // 启用工具转换
  enableStreaming?: boolean;         // 启用流式转换
  modelMappings?: Record<string, string>; // 模型映射
}
```

### 请求格式检测配置
```typescript
interface RequestFormatDetectorConfig {
  confidenceThreshold?: number;      // 置信度阈值
  supportedFormats?: string[];       // 支持的格式列表
  enableValidation?: boolean;        // 启用格式验证
}
```

## 请求类型推断

### 支持的请求类型
```typescript
type RequestType = 
  | 'chat'           // 聊天完成
  | 'completion'     // 文本完成
  | 'embedding'      // 文本嵌入
  | 'tool'           // 工具调用
  | 'moderation'     // 内容审核
  | 'unknown';       // 未知类型
```

### 类型推断逻辑
```typescript
private inferRequestType(request: any): RequestType {
  if (request.messages) {
    return 'chat';
  } else if (request.prompt) {
    return 'completion';
  } else if (request.input) {
    return 'embedding';
  } else if (request.tools) {
    return 'tool';
  }
  return 'unknown';
}
```

## 性能跟踪

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
        moduleId: this.id
      }
    }
  };
}
```

### 响应性能跟踪
```typescript
// 响应性能数据
const responseMetadata = {
  hasChoices: !!response.choices,
  hasUsage: !!response.usage,
  choiceCount: response.choices?.length || 0,
  usage: response.usage ? {
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens
  } : null
};
```

## 错误处理

### 协议验证错误
```typescript
// 协议验证失败
if (!request.messages && !request.prompt) {
  throw new Error('Invalid OpenAI protocol: missing messages or prompt');
}

// 消息格式错误
if (request.messages && !Array.isArray(request.messages)) {
  throw new Error('Invalid OpenAI protocol: messages must be an array');
}
```

### 转换错误处理
```typescript
// 转换错误记录
try {
  const transformed = await this.transformRequest(request);
} catch (error) {
  this.logger.logModule(this.id, 'transform-error', {
    error: error instanceof Error ? error.message : String(error),
    requestType: this.inferRequestType(request)
  });
  throw error;
}
```

## 调试支持

### 详细日志记录
```typescript
// 请求转换日志
this.logger.logTransformation(this.id, 'llmswitch-request-transform', request, transformed);

// 响应转换日志
this.logger.logTransformation(this.id, 'llmswitch-response-transform', response, transformed);

// 错误日志
this.logger.logModule(this.id, 'request-transform-error', { error, request });
```

### 调试信息包含
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
    metadata: transformed._metadata
  }
};
```

## 扩展性

### 添加新的 LLMSwitch 实现
```typescript
class NewLLMSwitch implements LLMSwitchModule {
  readonly type = 'new-protocol';
  
  async processIncoming(request: any): Promise<any> {
    // 实现新的协议转换逻辑
    return {
      ...request,
      _metadata: {
        switchType: this.type,
        timestamp: Date.now(),
        originalProtocol: 'original',
        targetProtocol: 'target'
      }
    };
  }
  
  async processOutgoing(response: any): Promise<any> {
    // 实现响应转换逻辑
    return response;
  }
}
```

### 自定义协议转换
```typescript
// 注册新的转换器
class CustomProtocolConverter {
  async convertRequest(request: any): Promise<any> {
    // 自定义请求转换逻辑
  }
  
  async convertResponse(response: any): Promise<any> {
    // 自定义响应转换逻辑
  }
}
```

## 已知限制

### ❌ 当前限制
1. **协议支持有限** - 主要支持 OpenAI 协议透传
2. **无实时转换** - 不支持实时流式协议转换
3. **无多协议混合** - 不支持同一请求中的多协议混合
4. **无协议版本检测** - 不检测协议版本差异

### 🔄 未来计划
1. **多协议支持** - 添加 Anthropic、Google 等协议支持
2. **实时转换** - 支持流式数据的实时协议转换
3. **协议版本管理** - 支持不同版本的协议转换
4. **智能协议检测** - 自动检测和选择最佳转换策略

## 版本信息

- **当前版本**: 1.0.0
- **兼容性**: RouteCodex Pipeline >= 1.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 依赖关系

- **rcc-debugcenter**: 调试中心集成
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成
- **DebugEventBus**: 事件总线通信

## 最后更新

2025-01-22 - 完善协议转换文档和调试支持说明
