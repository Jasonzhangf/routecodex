# Workflow 模块

Workflow 模块提供流式控制功能，处理流式（streaming）和非流式（non-streaming）请求之间的转换，支持请求缓冲和响应管理。

## 模块概述

Workflow 模块是流水线架构的第 1 层（紧接 LLMSwitch 之后），负责控制流式请求的处理方式。它将流式请求转换为非流式请求发送给供应商，然后将非流式响应转换回流式响应返回给客户端。

## 核心功能

### 🔄 流式转换控制
- **流式 → 非流式**: 将客户端的流式请求转换为非流式请求发送给供应商
- **非流式 → 流式**: 将供应商的非流式响应转换为流式响应返回给客户端
- **请求缓冲**: 管理流式请求的缓冲和分块处理
- **响应分块**: 将完整响应分解为流式数据块

### 📊 流式参数处理
```typescript
// 处理流式特定参数
if (request.stream_options) {
  converted._originalStreamOptions = request.stream_options;
  delete converted.stream_options;
}

// 设置流式标志
if (request.stream) {
  converted._isStreaming = true;
}
```

### 🛡️ 错误边界处理
```typescript
// 流式错误处理
try {
  const result = await originalProcessIncoming.call(this, request);
} catch (error) {
  if (request._isStreaming) {
    // 流式错误响应
    return this.createStreamingErrorResponse(error);
  }
  throw error;
}
```

## 实现细节

### 当前实现策略

**重要说明**: 当前实现采用"非流式处理"策略：
- ✅ 接收流式请求 → 转换为非流式发送给供应商
- ✅ 接收非流式响应 → 保持非流式返回给客户端
- ❌ **不实现**: 非流式响应 → 流式响应的转换

这种设计选择的原因：
1. **简化实现**: 避免复杂的流式响应生成逻辑
2. **供应商兼容性**: 大多数供应商返回完整响应
3. **错误处理**: 非流式响应更容易处理错误情况
4. **性能**: 减少中间转换开销

### 流式请求处理流程
```typescript
// 1. 检测流式请求
const isStreaming = request.stream === true;

// 2. 转换为非流式请求
const nonStreamingRequest = {
  ...request,
  stream: false,  // 强制设置为非流式
  _originalStream: request.stream,  // 保存原始设置
  _originalStreamOptions: request.stream_options  // 保存流式选项
};

// 3. 删除流式特定参数
delete nonStreamingRequest.stream_options;

// 4. 发送给供应商处理
const response = await nextModule.processIncoming(nonStreamingRequest);

// 5. 保持响应格式不变（非流式）
return response;
```

## 文件结构

```
src/modules/pipeline/modules/workflow/
├── streaming-control.ts          # 流式控制主实现
└── README.md                     # 本文档
```

## 核心实现

### StreamingControlWorkflow 类
```typescript
export class StreamingControlWorkflow implements WorkflowModule {
  readonly type = 'streaming-control';
  readonly workflowType = 'streaming-converter';
  
  async processIncoming(request: any): Promise<any> {
    // 流式请求转换逻辑
    if (request.stream) {
      return this.convertStreamingToNonStreaming(request);
    }
    return request;
  }
  
  async processStreamingControl(request: any): Promise<any> {
    // 专门的流式控制处理
    return this.handleStreamingControl(request);
  }
}
```

### 流式到非流式转换
```typescript
private convertStreamingToNonStreaming(request: any): any {
  const converted = { ...request };
  
  // 保存原始流式设置
  if (request.stream) {
    converted._originalStream = request.stream;
    converted.stream = false;  // 强制非流式
  }
  
  // 处理流式选项
  if (request.stream_options) {
    converted._originalStreamOptions = request.stream_options;
    delete converted.stream_options;
  }
  
  return converted;
}
```

### 流式控制处理
```typescript
async processStreamingControl(request: any): Promise<any> {
  if (!this.isInitialized) {
    throw new Error('Streaming Control Workflow is not initialized');
  }
  
  this.logger.logModule(this.id, 'streaming-control-start', {
    hasStream: !!request.stream,
    hasStreamOptions: !!request.stream_options
  });
  
  // 根据配置决定是否进行流式转换
  const config = this.config.config || {};
  
  if (request.stream && config.streamingToNonStreaming !== false) {
    return this.convertStreamingToNonStreaming(request);
  }
  
  return request;
}
```

## 使用示例

### 基本使用
```typescript
import { StreamingControlWorkflow } from './streaming-control.js';

const workflow = new StreamingControlWorkflow({
  type: 'streaming-control',
  config: {
    streamingToNonStreaming: true,
    nonStreamingToStreaming: false  // 当前未实现
  }
}, dependencies);

await workflow.initialize();

// 处理流式请求
const streamingRequest = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
  stream_options: {
    include_usage: true
  }
};

const convertedRequest = await workflow.processIncoming(streamingRequest);
// 结果: { model: 'gpt-4', messages: [...], stream: false, _originalStream: true }
```

### 在流水线中使用
```typescript
const pipelineConfig = {
  modules: {
    workflow: {
      type: 'streaming-control',
      config: {
        streamingToNonStreaming: true
      }
    }
  }
};

// 流式请求处理
const request = {
  model: 'llama2-7b-chat',
  messages: [...],
  stream: true  // 客户端请求流式响应
};

// 经过 workflow 处理后
const processedRequest = await workflow.processIncoming(request);
// stream 被设置为 false，供应商将返回完整响应
```

## 配置选项

### 流式控制配置
```typescript
interface StreamingControlConfig {
  streamingToNonStreaming?: boolean;  // 流式转非流式 (默认: true)
  nonStreamingToStreaming?: boolean;  // 非流式转流式 (默认: false，未实现)
  bufferSize?: number;                // 缓冲区大小
  chunkSize?: number;                 // 数据块大小
  timeout?: number;                   // 超时时间
}
```

### 默认配置
```typescript
const defaultConfig = {
  streamingToNonStreaming: true,    // 启用流式到非流式转换
  nonStreamingToStreaming: false,   // 禁用非流式到流式转换
  bufferSize: 1024,                 // 1KB 缓冲区
  chunkSize: 512,                   // 512字节数据块
  timeout: 30000                    // 30秒超时
};
```

## 流式参数处理

### 支持的流式参数
```typescript
// 输入参数处理
interface StreamOptions {
  include_usage?: boolean;        // 包含使用统计
  chunk_size?: number;            // 数据块大小
  timeout?: number;               // 超时时间
}

// 内部保存的参数
interface ProcessedStreamOptions {
  _originalStream?: boolean;       // 原始流式设置
  _originalStreamOptions?: StreamOptions; // 原始流式选项
  _isStreaming?: boolean;         // 标记为流式请求
}
```

## 错误处理

### 流式错误类型
```typescript
// 工作流初始化错误
if (!this.isInitialized) {
  throw new Error('Streaming Control Workflow is not initialized');
}

// 配置验证错误
if (!this.config.type || this.config.type !== 'streaming-control') {
  throw new Error('Invalid Workflow type configuration');
}

// 流式转换错误
try {
  const result = await this.convertStreamingToNonStreaming(request);
} catch (error) {
  this.logger.logModule(this.id, 'streaming-conversion-error', { error });
  throw error;
}
```

### 错误日志记录
```typescript
// 详细的错误日志
this.logger.logModule(this.id, 'streaming-control-error', {
  error: error instanceof Error ? error.message : String(error),
  request: {
    hasStream: !!request.stream,
    hasStreamOptions: !!request.stream_options
  }
});
```

## 性能考虑

### 内存管理
```typescript
// 避免大对象复制
const converted = { ...request };  // 浅拷贝
// 删除不需要的属性
delete converted.stream_options;
```

### 异步处理
```typescript
// 异步转换避免阻塞
async processIncoming(request: any): Promise<any> {
  // 快速路径：非流式请求直接返回
  if (!request.stream) {
    return request;
  }
  
  // 流式请求需要转换
  return this.convertStreamingToNonStreaming(request);
}
```

## 调试支持

### 流式控制日志
```typescript
// 转换开始
this.logger.logModule(this.id, 'streaming-control-start', {
  hasStream: !!request.stream,
  hasStreamOptions: !!request.stream_options
});

// 转换完成
this.logger.logModule(this.id, 'streaming-control-complete', {
  originalStream: request.stream,
  convertedStream: converted.stream
});
```

### 状态监控
```typescript
// 模块状态
const status = workflow.getStatus();
console.log({
  id: status.id,
  type: status.type,
  workflowType: status.workflowType,
  isInitialized: status.isInitialized,
  config: status.config
});
```

## 已知限制

### ❌ 当前限制
1. **无流式响应生成** - 不实现非流式到流式的转换
2. **无 SSE 支持** - 不处理 Server-Sent Events
3. **无 WebSocket** - 仅支持 HTTP 请求/响应
4. **无实时流** - 需要完整的请求/响应周期

### 🔄 未来计划
1. **流式响应生成** - 实现非流式到流式的转换
2. **SSE 支持** - 添加 Server-Sent Events 处理
3. **实时缓冲** - 支持实时数据缓冲和分块
4. **WebSocket 支持** - 添加 WebSocket 流式处理

## 扩展性

### 添加新的工作流类型
```typescript
class NewWorkflow implements WorkflowModule {
  async processIncoming(request: any): Promise<any> {
    // 实现新的工作流逻辑
  }
  
  async processStreamingControl(request: any): Promise<any> {
    // 实现流式控制逻辑
  }
}
```

### 自定义流式转换
```typescript
// 扩展 StreamingControlWorkflow
class CustomStreamingControl extends StreamingControlWorkflow {
  async convertStreamingToNonStreaming(request: any): Promise<any> {
    // 自定义转换逻辑
    return super.convertStreamingToNonStreaming(request);
  }
}
```

## 版本信息

- **当前版本**: 1.0.0
- **兼容性**: RouteCodex Pipeline >= 1.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 依赖关系

- **rcc-debugcenter**: 调试日志支持
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成

## 最后更新

2025-01-22 - 完善流式控制文档和限制说明