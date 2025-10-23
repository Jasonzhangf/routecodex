# Workflow 模块

Workflow 模块提供智能流式控制功能，处理流式（streaming）和非流式（non-streaming）请求之间的转换，支持请求缓冲、响应管理和多种流式协议适配。

## 🎯 模块概述

Workflow 模块是流水线架构的第 2 层，位于 LLMSwitch 和 Compatibility 之间，负责控制流式请求的处理方式。它不仅处理传统的流式/非流式转换，还支持 **Responses API 流式事件处理**，确保不同协议间的流式响应都能正确转换和管理。

### 📋 核心职责
- **流式转换**: 流式 ↔ 非流式请求的智能转换
- **协议适配**: 支持 Chat 和 Responses API 的不同流式格式
- **事件处理**: Server-Sent Events (SSE) 的规范化处理
- **缓冲管理**: 流式数据的智能缓冲和分块
- **响应重建**: 将分块响应重建成完整响应格式

## 🔄 支持的流式转换

### 📡 传统流式控制
- **实现文件**: `streaming-control.ts`
- **功能**: Chat Completions API 的流式转换
- **特性**:
  - 流式请求 → 非流式发送给供应商
  - 非流式响应 → 保持非流式返回客户端
  - 流式参数处理和保存
  - 错误边界处理和恢复

### 🆕 Responses 流式处理
- **实现文件**: `responses-streaming-workflow.ts`
- **功能**: Responses API 的流式事件处理
- **特性**:
  - **SSE 事件解析**: 解析 `response.output_text.delta` 等事件
  - **响应重建**: 将分块事件重建成完整 Responses 格式
  - **元数据处理**: 处理事件元数据和序列号
  - **工具调用支持**: 处理 `response.tool_call.delta` 事件
  - **多模态处理**: 支持文本、图像、工具调用的混合流式内容

## 🌟 核心功能

### 🔄 Chat 流式转换控制
```typescript
// 处理传统流式请求
if (request.stream) {
  converted._originalStream = request.stream;
  converted.stream = false;  // 强制非流式发送
}

// 保存流式选项
if (request.stream_options) {
  converted._originalStreamOptions = request.stream_options;
  delete converted.stream_options;
}
```

### 📡 Responses 流式事件处理
```typescript
// 处理 Responses 流式事件
const processedEvents = await this.processResponseEvents(events);
const rebuiltResponse = this.rebuildResponsesResponse(processedEvents);

return {
  ...rebuiltResponse,
  _streamingEvents: processedEvents,
  _originalProtocol: 'responses'
};
```

### 🛡️ 错误边界处理
```typescript
// 智能错误处理
try {
  const result = await this.processStreamingRequest(request);
} catch (error) {
  if (this.isStreamingRequest(request)) {
    return this.createStreamingErrorResponse(error, request._protocol);
  }
  throw this.createStandardErrorResponse(error);
}
```

## 📁 文件结构

```
src/modules/pipeline/modules/workflow/
├── streaming-control.ts              # 传统流式控制实现
├── responses-streaming-workflow.ts   # Responses 流式处理实现 ⭐
├── streaming-event-processor.ts      # 流式事件处理工具
├── response-rebuilder.ts             # 响应重建工具
└── README.md                         # 本文档
```

## 🔄 工作流类型详解

### 📡 传统流式控制 (StreamingControlWorkflow)
```typescript
export class StreamingControlWorkflow implements WorkflowModule {
  readonly type = 'streaming-control';
  readonly workflowType = 'streaming-converter';

  async processIncoming(request: any): Promise<any> {
    // Chat Completions 流式转换逻辑
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

### 🆕 Responses 流式处理 (ResponsesStreamingWorkflow)
```typescript
export class ResponsesStreamingWorkflow implements WorkflowModule {
  readonly type = 'responses-streaming-workflow';
  readonly workflowType = 'responses-event-processor';

  async processIncoming(request: any): Promise<any> {
    // Responses API 流式事件处理
    if (request._protocol === 'responses' && request._hasStreamingEvents) {
      return this.processResponsesStreamingEvents(request);
    }
    return request;
  }

  private async processResponsesStreamingEvents(request: any): Promise<any> {
    // 处理 SSE 事件流
    const events = this.extractStreamingEvents(request);
    const processedEvents = await this.processResponseEvents(events);

    // 重建完整 Responses 响应
    return this.rebuildResponsesResponse(processedEvents);
  }
}
```

### 🔄 流式到非流式转换
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

### 📡 Responses 事件处理
```typescript
private async processResponseEvents(events: StreamingEvent[]): Promise<ProcessedEvent[]> {
  const processedEvents: ProcessedEvent[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'response.output_text.delta':
        processedEvents.push(this.processTextDeltaEvent(event));
        break;
      case 'response.tool_call.delta':
        processedEvents.push(this.processToolCallDeltaEvent(event));
        break;
      case 'response.done':
        processedEvents.push(this.processCompletionEvent(event));
        break;
    }
  }

  return processedEvents;
}

private rebuildResponsesResponse(events: ProcessedEvent[]): ResponsesResponse {
  const outputText = this.rebuildOutputText(events);
  const toolCalls = this.rebuildToolCalls(events);
  const metadata = this.extractMetadata(events);

  return {
    id: metadata.responseId,
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'input_text', text: outputText },
        ...toolCalls
      ]
    }],
    usage: metadata.usage,
    _streamingEvents: events
  };
}
```

## 🚀 使用示例

### 传统流式控制使用
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

### Responses 流式处理使用
```typescript
import { ResponsesStreamingWorkflow } from './responses-streaming-workflow.js';

const responsesWorkflow = new ResponsesStreamingWorkflow({
  type: 'responses-streaming-workflow',
  config: {
    enableEventProcessing: true,
    rebuildCompleteResponse: true
  }
}, dependencies);

await responsesWorkflow.initialize();

// 处理 Responses 流式事件
const responsesEventsRequest = {
  _protocol: 'responses',
  _hasStreamingEvents: true,
  streamingEvents: [
    { type: 'response.output_text.delta', data: { delta: 'Hello' } },
    { type: 'response.output_text.delta', data: { delta: ' world!' } },
    { type: 'response.done', data: { usage: { total_tokens: 10 } } }
  ]
};

const rebuiltResponse = await responsesWorkflow.processIncoming(responsesEventsRequest);
// 结果: 完整的 Responses API 响应格式
```

### 在流水线配置中使用
```typescript
const pipelineConfig = {
  modules: {
    llmSwitch: {
      type: 'llmswitch-response-chat',  // Responses 协议支持
      config: { enableValidation: true }
    },
    workflow: {
      type: 'responses-streaming-workflow',  // Responses 流式处理
      config: { enableEventProcessing: true }
    },
    compatibility: {
      type: 'passthrough-compatibility',
      config: {}
    },
    provider: {
      type: 'lmstudio-http',
      config: { baseUrl: 'http://localhost:1234' }
    }
  }
};

// 完整的 Responses API 流式请求处理流程
const request = {
  model: 'gpt-4',
  instructions: 'You are a helpful assistant.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello!' }]
    }
  ],
  stream: true  // 流式请求
};

// 经过流水线处理：
// 1. LLM Switch: Responses → Chat 转换
// 2. Workflow: 流式控制处理
// 3. Compatibility: 格式适配
// 4. Provider: 发送给供应商
```

## ⚙️ 配置选项

### 📡 传统流式控制配置
```typescript
interface StreamingControlConfig {
  streamingToNonStreaming?: boolean;    // 流式转非流式 (默认: true)
  nonStreamingToStreaming?: boolean;    // 非流式转流式 (默认: false，未实现)
  bufferSize?: number;                  // 缓冲区大小
  chunkSize?: number;                   // 数据块大小
  timeout?: number;                     // 超时时间
  preserveStreamOptions?: boolean;      // 保留流式选项
}
```

### 🆕 Responses 流式处理配置
```typescript
interface ResponsesStreamingConfig {
  enableEventProcessing?: boolean;      // 启用事件处理
  rebuildCompleteResponse?: boolean;    // 重建完整响应
  eventTimeout?: number;                // 事件处理超时
  maxEventBufferSize?: number;          // 最大事件缓冲区
  preserveEventOrder?: boolean;         // 保持事件顺序
  enableMetrics?: boolean;              // 启用性能指标
}
```

### 默认配置
```typescript
const defaultStreamingConfig = {
  streamingToNonStreaming: true,      // 启用流式到非流式转换
  nonStreamingToStreaming: false,     // 禁用非流式到流式转换
  bufferSize: 1024,                   // 1KB 缓冲区
  chunkSize: 512,                     // 512字节数据块
  timeout: 30000,                     // 30秒超时
  preserveStreamOptions: true         // 保留流式选项
};

const defaultResponsesConfig = {
  enableEventProcessing: true,        // 启用事件处理
  rebuildCompleteResponse: true,      // 重建完整响应
  eventTimeout: 60000,                // 60秒事件超时
  maxEventBufferSize: 1000,           // 最大1000个事件
  preserveEventOrder: true,           // 保持事件顺序
  enableMetrics: true                 // 启用性能指标
};
```

## 📊 流式参数处理

### 📡 Chat 流式参数
```typescript
// OpenAI Chat Completions 流式参数
interface ChatStreamOptions {
  stream?: boolean;                   // 启用流式响应
  stream_options?: {
    include_usage?: boolean;          // 包含使用统计
    chunk_size?: number;              // 数据块大小
  };
}

// 处理后的流式参数
interface ProcessedChatStreamOptions {
  _originalStream?: boolean;          // 原始流式设置
  _originalStreamOptions?: ChatStreamOptions; // 原始流式选项
  _isStreaming?: boolean;             // 标记为流式请求
}
```

### 🆕 Responses 流式参数
```typescript
// OpenAI Responses API 流式参数
interface ResponsesStreamOptions {
  stream?: boolean;                   // 启用流式响应
  tools?: any[];                      // 工具定义
  tool_choice?: any;                  // 工具选择
  max_output_tokens?: number;         // 最大输出令牌
}

// Responses 流式事件结构
interface ResponsesStreamingEvent {
  type: string;                       // 事件类型
  data: any;                          // 事件数据
  timestamp?: number;                 // 时间戳
  sequence_number?: number;           // 序列号
  item_id?: string;                   // 项目ID
}

// 处理后的 Responses 参数
interface ProcessedResponsesStreamOptions {
  _protocol: 'responses';             // 协议标识
  _hasStreamingEvents?: boolean;      // 是否包含流式事件
  _streamingEvents?: ResponsesStreamingEvent[]; // 流式事件数组
  _originalStreamOptions?: ResponsesStreamOptions; // 原始流式选项
}
```

## 🛡️ 错误处理

### 多层错误处理
```typescript
// 智能错误处理策略
try {
  const result = await this.processStreamingRequest(request);
} catch (error) {
  // 根据协议类型选择错误处理方式
  if (request._protocol === 'responses') {
    return this.createResponsesErrorResponse(error);
  } else if (request._originalStream) {
    return this.createStreamingErrorResponse(error);
  }
  throw this.createStandardErrorResponse(error);
}

// Responses API 错误响应
private createResponsesErrorResponse(error: any): ResponsesError {
  return {
    id: `error_${Date.now()}`,
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: error.message,
      code: 'streaming_processing_error'
    },
    _protocol: 'responses',
    _errorContext: {
      workflowType: this.type,
      timestamp: Date.now()
    }
  };
}

// Chat 流式错误响应
private createStreamingErrorResponse(error: any): StreamingError {
  return {
    id: `error_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'error-model',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: `Error: ${error.message}` },
      finish_reason: 'error'
    }],
    _errorContext: {
      originalError: error.message,
      workflowType: this.type
    }
  };
}
```

### 详细错误日志
```typescript
// 分层错误日志记录
this.logger.logModule(this.id, 'workflow-error', {
  error: error instanceof Error ? error.message : String(error),
  protocol: request._protocol || 'unknown',
  requestType: this.inferRequestType(request),
  hasStreamingEvents: !!request._hasStreamingEvents,
  originalStream: !!request._originalStream,
  errorContext: {
    workflowType: this.type,
    timestamp: Date.now(),
    stack: error.stack
  }
});
```

## 📈 性能优化

### 内存管理策略
```typescript
// 流式数据内存管理
class StreamingEventBuffer {
  private events: ResponsesStreamingEvent[] = [];
  private maxBufferSize: number;

  constructor(maxSize: number = 1000) {
    this.maxBufferSize = maxSize;
  }

  addEvent(event: ResponsesStreamingEvent): void {
    // 添加事件并管理内存
    this.events.push(event);

    // 防止内存泄漏
    if (this.events.length > this.maxBufferSize) {
      this.events.shift(); // 移除最旧的事件
    }
  }

  getEvents(): ResponsesStreamingEvent[] {
    return [...this.events]; // 返回副本避免外部修改
  }
}
```

### 异步事件处理
```typescript
// 异步处理流式事件避免阻塞
async processStreamingEventsAsync(events: ResponsesStreamingEvent[]): Promise<ProcessedEvent[]> {
  const batches = this.createEventBatches(events);
  const processedBatches = await Promise.all(
    batches.map(batch => this.processEventBatch(batch))
  );

  return processedBatches.flat();
}

// 事件批处理
private createEventBatches(events: ResponsesStreamingEvent[], batchSize: number = 50): ResponsesStreamingEvent[][] {
  const batches: ResponsesStreamingEvent[][] = [];
  for (let i = 0; i < events.length; i += batchSize) {
    batches.push(events.slice(i, i + batchSize));
  }
  return batches;
}
```

## 🔍 调试支持

### 流式处理调试
```typescript
// 详细的流式处理日志
this.logger.logModule(this.id, 'streaming-processing-start', {
  protocol: request._protocol,
  hasStreamingEvents: !!request._hasStreamingEvents,
  eventCount: request._streamingEvents?.length || 0,
  originalStream: !!request._originalStream
});

// 事件处理进度
this.logger.logModule(this.id, 'event-processing-progress', {
  processedEvents: processedCount,
  totalEvents: totalEvents,
  percentage: Math.round((processedCount / totalEvents) * 100),
  processingTime: Date.now() - startTime
});

// 响应重建完成
this.logger.logModule(this.id, 'response-rebuild-complete', {
  rebuiltResponseId: response.id,
  outputLength: response.output?.[0]?.content?.[0]?.text?.length || 0,
  toolCallCount: response.output?.[0]?.content?.filter(c => c.type === 'tool_call').length || 0,
  totalProcessingTime: Date.now() - startTime
});
```

### 状态监控
```typescript
// 工作流状态监控
interface WorkflowStatus {
  id: string;
  type: string;
  workflowType: string;
  isInitialized: boolean;
  config: any;
  metrics?: {
    processedRequests: number;
    streamingRequestsProcessed: number;
    responsesEventsProcessed: number;
    averageProcessingTime: number;
    errorCount: number;
  };
}

// 获取详细状态
getStatus(): WorkflowStatus {
  return {
    id: this.id,
    type: this.type,
    workflowType: this.workflowType,
    isInitialized: this.isInitialized,
    config: this.config,
    metrics: this.metrics?.getMetrics()
  };
}
```

## 🌐 协议支持矩阵

| 协议类型 | 流式支持 | 事件处理 | 响应重建 | 工具调用 | 状态 |
|---------|---------|---------|---------|---------|------|
| Chat Completions | ✅ | ✅ | ✅ | ✅ | 稳定 |
| Responses API | ✅ | ✅ | ✅ | ✅ | 新增 |
| Anthropic | ❌ | ❌ | ❌ | ❌ | 计划中 |
| Custom | 🔄 | 🔄 | 🔄 | 🔄 | 扩展中 |

## 🚨 已知限制

### 📡 当前限制
1. **Chat 流式响应生成** - 不实现非流式到流式的转换
2. **多协议混合** - 不支持同一请求中的多种协议混合
3. **事件顺序保证** - 在高并发下可能出现事件乱序
4. **大事件处理** - 超大流式事件可能导致内存压力

### 🆕 Responses API 限制
1. **复杂工具调用** - 复杂的流式工具调用处理还在优化中
2. **多模态流式** - 图像和视频的流式处理支持有限
3. **长文本重建** - 超长响应的重建性能需要优化
4. **实时性** - 事件处理和响应重建的延迟问题

### 🔄 未来计划
1. **完整流式支持** - 实现完整的双向流式转换
2. **多协议统一** - 统一所有协议的流式处理逻辑
3. **实时优化** - 减少事件处理和响应重建的延迟
4. **智能缓冲** - 基于内容类型的智能缓冲策略
5. **协议扩展** - 支持更多 AI 协议的流式处理

## 🔧 扩展性

### 添加新的工作流类型
```typescript
// 新协议工作流实现
class NewProtocolWorkflow implements WorkflowModule {
  readonly type = 'new-protocol-workflow';
  readonly workflowType = 'new-protocol-processor';

  async processIncoming(request: any): Promise<any> {
    if (request._protocol === 'new-protocol') {
      return this.processNewProtocolStreaming(request);
    }
    return request;
  }

  private async processNewProtocolStreaming(request: any): Promise<any> {
    // 实现新协议的流式处理逻辑
    const events = this.extractNewProtocolEvents(request);
    return this.rebuildNewProtocolResponse(events);
  }
}
```

### 自定义事件处理器
```typescript
// 自定义事件处理器
class CustomEventProcessor {
  async processEvents(events: any[], processor: (event: any) => Promise<any>): Promise<any[]> {
    // 自定义事件处理逻辑
    const processedEvents = [];

    for (const event of events) {
      try {
        const processed = await processor(event);
        processedEvents.push(processed);
      } catch (error) {
        // 错误恢复策略
        processedEvents.push(this.createErrorEvent(event, error));
      }
    }

    return processedEvents;
  }
}
```

## 📈 版本信息

- **当前版本**: 2.0.0
- **新增特性**: Responses API 流式事件处理、智能错误恢复、性能监控
- **兼容性**: RouteCodex Pipeline >= 2.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-debugcenter**: 调试中心集成
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成
- **BaseModule**: 基础模块接口
- **StreamingEventProcessor**: 流式事件处理工具
- **ResponseRebuilder**: 响应重建工具

## 🔄 更新日志

### v2.0.0 (2025-10-17)
- ✨ 新增 Responses API 流式事件处理支持
- 🆕 实现完整的 SSE 事件解析和响应重建
- 🔄 增强的错误处理和恢复机制
- 📊 完善的性能监控和调试功能
- 🛡️ 改进的内存管理和缓冲策略
- 📚 更新文档，添加详细的使用示例和配置指南

### v1.5.0 (2025-01-22)
- 🔧 完善传统流式控制功能
- 📊 增加性能监控和日志记录
- 🛡️ 改进错误处理机制

### v1.0.0 (2025-01-22)
- 🎯 初始版本发布
- 🔄 基础的流式控制功能
- 📊 配置驱动的工作流处理

---

**最后更新**: 2025-10-17 - 全面更新 Workflow 模块文档，新增 Responses API 流式处理支持