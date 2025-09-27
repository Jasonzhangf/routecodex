# Anthropic ↔ OpenAI LLMSwitch 设计文档

## 设计原则

### 职责分离
- **流水线层**: 只处理协议格式转换，不涉及模型映射和参数
- **Provider层**: 负责模型映射、参数初始化和请求发送
- **LLMSwitch层**: 根据端点类型决定转换策略

### 工作模式
- **Anthropic端点**: 启用 `llmswitch-anthropic-openai` 进行协议转换
- **OpenAI端点**: 使用 `llmswitch-openai-openai` 规范化请求

## 架构设计

### 核心接口

```typescript
export interface LLMSwitchModule extends PipelineModule {
  readonly protocol: string;
  
  /**
   * 转换请求到目标协议格式
   */
  transformRequest(request: any): Promise<any>;
  
  /**
   * 转换响应从目标协议格式
   */
  transformResponse(response: any): Promise<any>;
}
```

### Anthropic↔OpenAI转换器

```typescript
export class AnthropicOpenAIConverter implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai';
  readonly protocol = 'bidirectional';
  readonly direction: 'anthropic-to-openai' | 'openai-to-anthropic';
  
  private isInitialized = false;
  private logger: PipelineDebugLogger;
  
  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `llmswitch-anthropic-openai-${Date.now()}`;
    this.logger = dependencies.logger as any;
    // 根据请求格式自动检测方向
    this.direction = this.detectDirection(config);
  }
  
  async initialize(): Promise<void> {
    this.validateConfig();
    this.isInitialized = true;
  }
  
  /**
   * 处理入站请求 - 协议格式转换
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('AnthropicOpenAIConverter is not initialized');
    }
    
    // 只处理 Anthropic -> OpenAI 方向
    if (this.isAnthropicRequest(request)) {
      const transformedRequest = this.convertAnthropicToOpenAI(request);
      this.logger.logTransformation(this.id, 'anthropic-to-openai', request, transformedRequest);
      return transformedRequest;
    }
    
    // OpenAI 格式请求直接透传
    return request;
  }
  
  /**
   * 处理出站响应 - 协议格式转换
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('AnthropicOpenAIConverter is not initialized');
    }
    
    // 只处理 OpenAI -> Anthropic 方向
    if (this.isOpenAIResponse(response)) {
      const transformedResponse = this.convertOpenAIToAnthropic(response);
      this.logger.logTransformation(this.id, 'openai-to-anthropic', response, transformedResponse);
      return transformedResponse;
    }
    
    // Anthropic 格式响应直接透传
    return response;
  }
  
  /**
   * 转换请求到目标协议
   */
  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }
  
  /**
   * 转换响应从目标协议
   */
  async transformResponse(response: any): Promise<any> {
    return this.processOutgoing(response);
  }
}
```

## 转换规则

### 请求转换 (Anthropic → OpenAI)

#### 消息结构转换
```typescript
// Anthropic 格式
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}

// 转换为 OpenAI 格式
{
  "messages": [
    {
      "role": "user", 
      "content": "Hello"
    }
  ]
}
```

#### 工具定义转换
```typescript
// Anthropic 工具定义
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather information",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        }
      }
    }
  ]
}

// 转换为 OpenAI 函数定义
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather information", 
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          }
        }
      }
    }
  ]
}
```

#### 系统消息处理
```typescript
// Anthropic 系统消息
{
  "system": "You are a helpful assistant",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}

// 转换为 OpenAI 格式
{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "Hello"}
  ]
}
```

### 响应转换 (OpenAI → Anthropic)

#### 基本响应结构
```typescript
// OpenAI 响应
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ]
}

// 转换为 Anthropic 格式
{
  "role": "assistant",
  "content": "Hello! How can I help you?",
  "stop_reason": "end_turn"
}
```

#### 工具调用响应
```typescript
// OpenAI 工具调用
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function", 
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\": \"Beijing\"}"
            }
          }
        ]
      }
    }
  ]
}

// 转换为 Anthropic 工具使用
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "call_123",
      "name": "get_weather", 
      "input": {"location": "Beijing"}
    }
  ]
}
```

#### 使用统计转换
```typescript
// OpenAI 使用统计
{
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}

// 转换为 Anthropic 格式
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  }
}
```

## 流式响应处理

### 事件映射

| OpenAI 事件 | Anthropic 事件 | 转换处理 |
|------------|---------------|----------|
| `content.delta` | `content_block_delta` | 直接映射内容增量 |
| `tool_calls.delta` | `content_block_delta` | 工具调用参数增量转换 |
| `finish_reason` | `message_delta` | 完成原因映射 |

### 流式工具调用
```typescript
// OpenAI 流式工具调用
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "function": {
          "arguments": "{\"location\": \"Beijing\"}"
        }
      }]
    }
  }]
}

// 转换为 Anthropic 格式
{
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\": \"Beijing\"}"
  }
}
```

## 配置规范

### 模块配置
```json
{
  "modules": {
    "llmSwitch": {
      "enabled": true,
      "type": "llmswitch-anthropic-openai",
      "config": {
        "enableStreaming": true,
        "enableTools": true,
        "maxRetries": 3,
        "timeout": 30000
      }
    }
  }
}
```

### 路由配置
```json
{
  "routes": [
    {
      "id": "anthropic-route",
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "modules": {
        "llmSwitch": {
          "type": "llmswitch-anthropic-openai"
        }
      }
    },
    {
      "id": "openai-route", 
      "provider": "openai",
      "model": "gpt-4o",
      "modules": {
        "llmSwitch": {
          "type": "llmswitch-openai-openai"
        }
      }
    }
  ]
}
```

## 错误处理

### 转换错误
```typescript
class ConversionError extends Error {
  constructor(
    message: string,
    public readonly sourceFormat: string,
    public readonly targetFormat: string,
    public readonly originalData: any
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}
```

### 回退机制
1. **结构转换失败**: 返回原始数据并记录警告
2. **工具转换失败**: 移除工具相关字段，降级为文本对话
3. **流式转换失败**: 终止流并返回错误响应

## 性能优化

### 缓存策略
```typescript
interface ConversionCache {
  // 工具定义缓存
  toolDefinitionCache: Map<string, any>;
  // 模型映射缓存  
  modelMappingCache: Map<string, string>;
  // 响应结构缓存
  responseStructureCache: Map<string, any>;
}
```

### 批处理优化
- 工具定义转换结果缓存
- 常用消息结构模板化
- 流式响应增量转换

## 监控与调试

### 转换指标
```typescript
interface ConversionMetrics {
  totalConversions: number;
  successfulConversions: number;
  failedConversions: number;
  averageConversionTime: number;
  conversionErrors: Map<string, number>;
}
```

### 调试日志
```typescript
// 请求转换日志
logger.logTransformation(moduleId, 'request-conversion', {
  direction: 'anthropic-to-openai',
  original: request,
  converted: transformedRequest,
  duration: conversionTime
});

// 响应转换日志  
logger.logTransformation(moduleId, 'response-conversion', {
  direction: 'openai-to-anthropic',
  original: response,
  converted: transformedResponse,
  duration: conversionTime
});
```

## 测试策略

### 单元测试
- 消息结构转换测试
- 工具定义转换测试
- 流式响应转换测试
- 错误处理测试

### 集成测试
- 完整请求-响应循环测试
- 多轮对话转换测试
- 工具调用流程测试
- 性能压力测试

### 兼容性测试
- Anthropic API版本兼容
- OpenAI API版本兼容
- 第三方Provider集成测试

## 部署指南

### 模块注册
```typescript
// 在 module-registrar.ts 中注册
this.registry.registerModule('llmswitch-anthropic-openai', async (config, dependencies) => {
  const { AnthropicOpenAIConverter } = await import('../modules/llmswitch/anthropic-openai-converter.js');
  return new AnthropicOpenAIConverter(config, dependencies);
});
```

### 配置验证
```typescript
private validateConfig(): void {
  if (!this.config.config) {
    throw new Error('LLMSwitch configuration is required');
  }
  
  // 验证必需字段
  const requiredFields = ['enableStreaming', 'enableTools'];
  for (const field of requiredFields) {
    if (this.config.config[field] === undefined) {
      throw new Error(`Missing required configuration field: ${field}`);
    }
  }
}
```

## 总结

本设计遵循职责分离原则，LLMSwitch只负责协议格式转换，模型映射由Provider层处理。通过双向转换器实现Anthropic和OpenAI协议的无缝转换，支持完整的对话、工具和流式功能。
