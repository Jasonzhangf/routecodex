# SSE双向转换模块实现指南

## 📋 概述

本文档提供SSE双向转换模块的详细实现指南，包括代码组织、命名规范、核心实现要点和最佳实践。

## 🏗️ 代码组织和目录规划

### 目录结构
```
src/sse/
├── index.ts                           # 统一导出入口
├── README.md                          # 模块总览文档
├── ARCHITECTURE.md                    # 架构设计文档
├── IMPLEMENTATION_GUIDE.md            # 实现指南（本文档）
├── TEST_PLAN.md                       # 测试策略文档
├── ROADMAP.md                         # 发展路线图
├── DOCS_INDEX.md                      # 文档索引
├── types/                            # 类型定义目录
│   ├── index.ts                     # 统一类型导出
│   ├── chat-types.ts                # Chat协议专用类型
│   ├── responses-types.ts           # Responses协议专用类型
│   └── base-types.ts                # 基础类型定义
├── json-to-sse/                     # JSON→SSE转换器
│   ├── index.ts                     # JSON→SSE模块导出
│   ├── chat-json-to-sse-converter.ts    # Chat协议转换器
│   ├── responses-json-to-sse-converter.ts # Responses协议转换器
│   └── base-converter.ts            # 基础转换器抽象类
├── sse-to-json/                     # SSE→JSON转换器
│   ├── index.ts                     # SSE→JSON模块导出
│   ├── chat-sse-to-json-converter.ts     # Chat协议聚合器
│   ├── responses-sse-to-json-converter.ts # Responses协议聚合器
│   └── base-aggregator.ts           # 基础聚合器抽象类
├── shared/                          # 共享工具和组件
│   ├── index.ts                     # 共享模块导出
│   ├── serializers/                 # 事件序列化适配器
│   │   ├── index.ts
│   │   ├── base-serializer.ts
│   │   ├── chat-event-serializer.ts
│   │   └── responses-event-serializer.ts
│   ├── utils/                       # 工具函数
│   │   ├── index.ts
│   │   ├── time-utils.ts
│   │   ├── validation-utils.ts
│   │   └── error-utils.ts
│   ├── chat-utils.ts               # Chat协议专用工具
│   └── responses-utils.ts          # Responses协议专用工具
└── test/                           # 测试文件
    ├── index.ts
    ├── chat-converter.test.ts
    ├── responses-converter.test.ts
    ├── serializers.test.ts
    └── utils/
        ├── test-helpers.ts
        └── mock-data.ts
```

### 模块组织原则

1. **单一职责**: 每个模块只负责一个特定功能
2. **协议分离**: Chat和Responses协议完全分离
3. **层次清晰**: 分层架构，从抽象到具体
4. **依赖最小**: 最小化模块间依赖

## 📝 命名规范

### 文件命名
- **kebab-case**: 使用短横线分隔的小写命名
- **功能描述**: 文件名要清楚描述其功能
- **协议前缀**: 协议特定文件要包含协议标识

```
✅ 正确示例:
chat-json-to-sse-converter.ts
responses-sse-to-json-converter.ts
base-event-serializer.ts
validation-utils.ts

❌ 错误示例:
ChatToJsonSSEConverter.ts
converter.js
utils.ts
```

### 类命名
- **PascalCase**: 使用帕斯卡命名法
- **功能明确**: 类名要清楚表达其用途
- **后缀规范**: 使用统一的后缀标识类型

```typescript
✅ 正确示例:
class ChatJsonToSseConverter
class ResponsesSseToJsonConverter
class BaseEventSerializer
class ValidationUtils

❌ 错误示例:
class chatConverter
class JSONtoSSE
class Utils
```

### 方法命名
- **camelCase**: 使用驼峰命名法
- **动词开头**: 方法名以动词开头，表达行为
- **时态明确**: 区分同步和异步方法

```typescript
✅ 正确示例:
convertToJsonToSse()
serializeEvent()
validateInput()
processStream()

❌ 错误示例:
conversion()
event_serialization()
input_validation()
stream_processor()
```

### 变量命名
- **camelCase**: 使用驼峰命名法
- **语义明确**: 变量名要表达其含义
- **类型提示**: 使用TypeScript类型注解

```typescript
✅ 正确示例:
const sseStream: Readable<ChatSseEvent>
const requestOptions: ChatJsonToSseOptions
let isCompleted: boolean

❌ 错误示例:
const stream: any
const opts: object
let flag: boolean
```

## 🔧 核心实现要点

### 1. 最小增量与顺序控制

#### Chat协议增量策略
```typescript
// 严格按照时序生成事件
const chunkSize = options.chunkSize || 50; // 可配置分块大小

for (const choice of response.choices) {
  // 1. role事件
  await this.sendRoleChunk(choice, context, stream);

  // 2. content增量（分块）
  if (choice.message?.content) {
    const chunks = this.chunkText(choice.message.content, chunkSize);
    for (const chunk of chunks) {
      await this.sendContentChunk(chunk, context, stream);
    }
  }

  // 3. tool_calls增量
  if (choice.message?.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      await this.sendToolCallName(toolCall, context, stream);
      await this.sendToolCallArguments(toolCall, context, stream);
    }
  }

  // 4. finish_reason
  await this.sendFinishReason(choice.finish_reason, context, stream);
}
```

#### Responses协议增量策略
```typescript
// 严格按照事件生命周期
// 1. response.created
await this.sendResponseCreated(response, context, stream);

// 2. response.in_progress
await this.sendResponseInProgress(context, stream);

// 3. output_items（按顺序）
for (let i = 0; i < response.output.length; i++) {
  const item = response.output[i];

  // output_item.added
  await this.sendOutputItemAdded(item, i, context, stream);

  // content_parts（如果有）
  if (item.type === 'message' && item.content) {
    for (const part of item.content) {
      await this.sendContentPartAdded(part, i, context, stream);
      await this.sendContentPartDone(part, i, context, stream);
    }
  }

  // function_calls（如果有）
  if (item.type === 'function_call') {
    const chunks = this.chunkArguments(item.arguments, 20);
    for (const chunk of chunks) {
      await this.sendFunctionCallArgumentsDelta(chunk, i, context, stream);
    }
    await this.sendFunctionCallArgumentsDone(item.arguments, i, context, stream);
  }

  // output_item.done
  await this.sendOutputItemDone(i, context, stream);
}

// 4. 最终状态事件
if (response.status === 'requires_action') {
  await this.sendRequiredAction(response.output, context, stream);
} else {
  await this.sendResponseCompleted(response, context, stream);
}
```

### 2. 背压与流量控制

#### 背压检测
```typescript
private async writeWithBackpressure(
  stream: PassThrough,
  data: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    const success = stream.write(data);

    if (success) {
      resolve();
      return;
    }

    // 等待drain事件
    stream.once('drain', () => {
      resolve();
    });

    stream.once('error', (error) => {
      reject(error);
    });
  });
}
```

#### 流量控制配置
```typescript
interface FlowControlOptions {
  maxConcurrentEvents?: number;    // 最大并发事件数
  eventThrottleMs?: number;       // 事件间最小间隔
  bufferSize?: number;           // 缓冲区大小
  enableBackpressure?: boolean;   // 是否启用背压
}

class FlowControlManager {
  private eventQueue: Array<() => Promise<void>> = [];
  private processing = false;
  private concurrency = 0;

  async addEvent(eventProcessor: () => Promise<void>): Promise<void> {
    this.eventQueue.push(eventProcessor);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.concurrency >= this.maxConcurrent) {
      return;
    }

    this.processing = true;

    while (this.eventQueue.length > 0 && this.concurrency < this.maxConcurrent) {
      const processor = this.eventQueue.shift()!;
      this.concurrency++;

      processor()
        .finally(() => {
          this.concurrency--;
          this.processQueue();
        });
    }

    this.processing = false;
  }
}
```

### 3. 错误序列化统一

#### 统一错误格式
```typescript
interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: PlainJSON;
  timestamp: string;
  requestId?: string;
}

class ErrorSerializer {
  static serialize(error: Error, requestId?: string): SerializedError {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as any).code,
      details: this.extractSafeDetails(error),
      timestamp: new Date().toISOString(),
      requestId
    };
  }

  static deserialize(data: SerializedError): Error {
    const error = new Error(data.message);
    error.name = data.name;
    error.stack = data.stack;
    (error as any).code = data.code;
    return error;
  }

  private static extractSafeDetails(error: Error): PlainJSON {
    // 只提取安全的可序列化属性
    const safe: PlainJSON = {};

    for (const key in error) {
      if (typeof (error as any)[key] === 'string' ||
          typeof (error as any)[key] === 'number' ||
          typeof (error as any)[key] === 'boolean') {
        (safe as any)[key] = (error as any)[key];
      }
    }

    return safe;
  }
}
```

#### 错误处理策略
```typescript
class ErrorHandler {
  static async handleConversionError(
    error: Error,
    context: ConversionContext,
    stream: PassThrough
  ): Promise<void> {
    const serializedError = ErrorSerializer.serialize(error, context.requestId);

    // 发送错误事件
    const errorEvent = this.createErrorEvent(serializedError);
    await this.writeWithBackpressure(stream, errorEvent);

    // 记录错误统计
    context.eventStats.errorCount++;

    // 通知错误处理器
    context.options.onError?.(error);
  }

  static async handleStreamError(
    error: Error,
    stream: PassThrough
  ): Promise<void> {
    // 确保流被正确关闭
    if (!stream.destroyed) {
      stream.destroy(error);
    }

    // 记录错误日志
    console.error('Stream error:', error);
  }
}
```

### 4. 内存保护与窗口聚合

#### 内存窗口管理
```typescript
class MemoryWindow {
  private window: Map<string, any[]> = new Map();
  private maxSize: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30000); // 30秒清理一次
  }

  add(key: string, item: any): void {
    if (!this.window.has(key)) {
      this.window.set(key, []);
    }

    const items = this.window.get(key)!;
    items.push(item);

    // 检查大小限制
    if (items.length > this.maxSize) {
      items.shift(); // 移除最旧的项目
    }
  }

  get(key: string): any[] {
    return this.window.get(key) || [];
  }

  clear(key: string): void {
    this.window.delete(key);
  }

  private cleanup(): void {
    // 清理过期的窗口数据
    const now = Date.now();
    for (const [key, items] of this.window.entries()) {
      const recent = items.filter(item =>
        now - item.timestamp < 300000 // 5分钟内的数据
      );

      if (recent.length === 0) {
        this.window.delete(key);
      } else if (recent.length < items.length) {
        this.window.set(key, recent);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.window.clear();
  }
}
```

#### 聚合器内存优化
```typescript
class MemoryOptimizedAggregator {
  private window: MemoryWindow;
  private processedCount = 0;
  private batchSize = 100;

  constructor() {
    this.window = new MemoryWindow(this.batchSize * 2);
  }

  async processEvent(event: SSEEvent): Promise<void> {
    this.window.add('events', event);
    this.processedCount++;

    // 定期清理已处理的事件
    if (this.processedCount % this.batchSize === 0) {
      this.cleanupProcessedEvents();
    }
  }

  private cleanupProcessedEvents(): void {
    // 保留最近的事件用于错误恢复
    const events = this.window.get('events');
    if (events.length > this.batchSize) {
      const recent = events.slice(-this.batchSize);
      this.window.clear('events');
      recent.forEach(event => this.window.add('events', event));
    }
  }
}
```

### 5. 形状校验与严格模式

#### Schema验证
```typescript
import Ajv from 'ajv';

class SchemaValidator {
  private ajv = new Ajv({ allErrors: true });
  private chatSchema: object;
  private responsesSchema: object;

  constructor() {
    this.chatSchema = this.loadChatSchema();
    this.responsesSchema = this.loadResponsesSchema();
    this.ajv.addSchema(this.chatSchema, 'chat');
    this.ajv.addSchema(this.responsesSchema, 'responses');
  }

  validateChat(input: unknown): { valid: boolean; errors?: any[] } {
    const validate = this.ajv.getSchema('chat');
    if (!validate) {
      throw new Error('Chat schema not loaded');
    }

    const valid = validate(input);
    return {
      valid: !!valid,
      errors: valid ? undefined : validate.errors
    };
  }

  validateResponses(input: unknown): { valid: boolean; errors?: any[] } {
    const validate = this.ajv.getSchema('responses');
    if (!validate) {
      throw new Error('Responses schema not loaded');
    }

    const valid = validate(input);
    return {
      valid: !!valid,
      errors: valid ? undefined : validate.errors
    };
  }

  private loadChatSchema(): object {
    // 加载Chat协议的JSON Schema
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id', 'object', 'created', 'model', 'choices'],
      properties: {
        id: { type: 'string' },
        object: { type: 'string', const: 'chat.completion' },
        created: { type: 'number' },
        model: { type: 'string' },
        choices: {
          type: 'array',
          items: {
            type: 'object',
            required: ['index', 'message'],
            properties: {
              index: { type: 'number' },
              message: {
                type: 'object',
                required: ['role'],
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                  content: { type: ['string', 'null'] },
                  tool_calls: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'type'],
                      properties: {
                        id: { type: 'string' },
                        type: { type: 'string' },
                        function: {
                          type: 'object',
                          required: ['name'],
                          properties: {
                            name: { type: 'string' },
                            arguments: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                }
              },
              finish_reason: { type: 'string' }
            }
          }
        }
      }
    };
  }

  private loadResponsesSchema(): object {
    // 加载Responses协议的JSON Schema
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id', 'object', 'created', 'status', 'model', 'output'],
      properties: {
        id: { type: 'string' },
        object: { type: 'string', const: 'response' },
        created: { type: 'number' },
        status: { type: 'string', enum: ['in_progress', 'completed', 'requires_action', 'cancelled', 'failed', 'expired'] },
        model: { type: 'string' },
        output: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type', 'id'],
            properties: {
              type: { type: 'string', enum: ['message', 'function_call', 'file_search', 'computer_use'] },
              id: { type: 'string' },
              role: { type: 'string' },
              content: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['type'],
                  oneOf: [
                    { properties: { type: { const: 'output_text' }, text: { type: 'string' } } },
                    { properties: { type: { const: 'input_image' }, image_url: { type: 'string' } } }
                  ]
                }
              },
              name: { type: 'string' },
              arguments: { type: 'string' }
            }
          }
        }
      }
    };
  }
}
```

#### 严格模式控制
```typescript
interface StrictModeOptions {
  enableValidation?: boolean;
  enableTypeChecking?: boolean;
  enableFieldValidation?: boolean;
  rejectUnknownFields?: boolean;
  throwOnValidationError?: boolean;
}

class StrictModeController {
  private options: StrictModeOptions;
  private validator: SchemaValidator;

  constructor(options: StrictModeOptions = {}) {
    this.options = {
      enableValidation: true,
      enableTypeChecking: true,
      enableFieldValidation: true,
      rejectUnknownFields: true,
      throwOnValidationError: true,
      ...options
    };

    this.validator = new SchemaValidator();
  }

  validateInput<T>(input: unknown, protocol: 'chat' | 'responses'): T {
    if (!this.options.enableValidation) {
      return input as T;
    }

    const result = protocol === 'chat'
      ? this.validator.validateChat(input)
      : this.validator.validateResponses(input);

    if (!result.valid) {
      const error = new ValidationError('Input validation failed', result.errors);

      if (this.options.throwOnValidationError) {
        throw error;
      } else {
        console.warn('Validation failed:', error.message);
      }
    }

    return input as T;
  }

  validateOutput<T>(output: unknown, protocol: 'chat' | 'responses'): T {
    if (!this.options.enableValidation) {
      return output as T;
    }

    // 类似输入验证的逻辑
    return output as T;
  }
}
```

## ⚡ 性能优化要点

### 1. 事件处理优化
```typescript
// 使用对象池减少GC压力
class EventPool {
  private pool: ChatSseEvent[] = [];
  private maxSize = 100;

  acquire(): ChatSseEvent {
    return this.pool.pop() || this.createNew();
  }

  release(event: ChatSseEvent): void {
    if (this.pool.length < this.maxSize) {
      this.reset(event);
      this.pool.push(event);
    }
  }

  private createNew(): ChatSseEvent {
    return { type: 'chat_chunk', timestamp: '', data: '' };
  }

  private reset(event: ChatSseEvent): void {
    event.timestamp = '';
    event.data = '';
  }
}
```

### 2. 批量处理优化
```typescript
class BatchProcessor {
  private batchSize = 10;
  private batch: any[] = [];
  private timer: NodeJS.Timeout | null = null;

  async addItem(item: any): Promise<void> {
    this.batch.push(item);

    if (this.batch.length >= this.batchSize) {
      await this.processBatch();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.processBatch();
      }, 10);
    }
  }

  private async processBatch(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length === 0) {
      return;
    }

    const items = this.batch.splice(0);
    await this.processItems(items);
  }
}
```

## 🧪 测试友好的设计

### 1. 依赖注入
```typescript
interface ConverterDependencies {
  eventSerializer: EventSerializer<any>;
  validator: SchemaValidator;
  errorHandler: ErrorHandler;
  timeUtils: TimeUtils;
}

class ChatJsonToSseConverter {
  constructor(
    private config: ChatConfig,
    private deps: ConverterDependencies
  ) {}

  // 注入依赖使测试更容易
  async convertToJsonToSse(request: ChatCompletionRequest): Promise<ChatSseEventStream> {
    const context = this.createContext(request);
    const stream = new PassThrough({ objectMode: true });

    // 使用注入的依赖
    const validation = this.deps.validator.validateChat(request);
    if (!validation.valid) {
      throw new ValidationError('Invalid request', validation.errors);
    }

    return stream;
  }
}
```

### 2. 可测试的工具类
```typescript
export class TestTimeUtils implements TimeUtils {
  private currentTime: number = Date.now();

  now(): number {
    return this.currentTime;
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
  }

  advanceTime(ms: number): void {
    this.currentTime += ms;
  }
}

export class TestStream extends PassThrough {
  private events: any[] = [];

  _write(chunk: any, encoding?: string, callback?: Function): boolean {
    this.events.push(chunk);
    return super._write(chunk, encoding, callback);
  }

  getWrittenEvents(): any[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
  }
}
```

## 📋 检查清单

### ✅ 代码质量检查
- [ ] 遵循命名规范
- [ ] 完整的TypeScript类型注解
- [ ] 适当的错误处理
- [ ] 内存泄漏防护
- [ ] 性能优化考虑

### ✅ 功能完整性检查
- [ ] 事件生成顺序正确
- [ ] 背压控制实现
- [ ] 错误处理完整
- [ ] 内存管理合理
- [ ] 配置选项完整

### ✅ 测试覆盖检查
- [ ] 单元测试覆盖
- [ ] 集成测试验证
- [ ] 边界条件测试
- [ ] 性能基准测试
- [ ] 错误场景测试

---

**总结**: 本实现指南提供了SSE双向转换模块的详细实现规范，遵循这些指导原则可以确保代码质量、性能和可维护性。所有实现都应遵循"conversion只做形状映射，工具治理只在process"的核心约束。
