# 对称架构设计文档：统一适配器接口

## 概述

本文档详细描述了llmswitch-core项目的对称架构设计，实现输入输出的统一适配器接口，支持SSE和JSON格式的双向转换，并确保请求和响应的对称处理流程。

## 🎯 设计目标

### 核心原则
1. **对称接口**: 输入和输出使用相同的适配器接口
2. **双向转换**: 适配器支持双向转换（SSE↔JSON）
3. **路径保持**: 请求和响应走相同的转换路径
4. **协议感知**: 适配器能检测并处理不同协议格式
5. **解耦合**: 输入输出可选，与Conversion核心处理层解耦

### 架构目标
- 输入端：SSE/JSON可选输入 → InputAdapter → Process Chat
- 处理端：Process Chat（纯JSON核心处理）
- 输出端：Process Chat → OutputAdapter → SSE/JSON可选输出
- 响应端：对称的反向处理，原路返回

## 🏗️ 完整对称架构

### 整体流程图
```
请求端流程:
SSE/JSON Input → InputAdapter → Process Chat → OutputAdapter → SSE/JSON Output
                                                    ↓
响应端流程:
SSE/JSON Input ← InputAdapter ← Process Chat ← OutputAdapter ← SSE/JSON Output
                                                    ↑
                                         原路返回（对称路径）
```

### 分层架构
```
┌─────────────────────────────────────────────────────────────────┐
│                    对称适配器层                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Chat       │  │  Responses  │  │    Anthropic           │ │
│  │  Adapter    │  │  Adapter    │  │      Adapter            │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│           ↓              ↓              ↓                      │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              UniversalAdapter Interface                   │ │
│  │  • detectFormat()  • toJson()  • fromJson()              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
           ↓                      ↓                      ↓
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  请求输入节点     │  │  响应输入节点     │  │  适配器工厂       │
│ RequestInputNode │  │ ResponseInputNode│  │ AdapterFactory  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
           ↓                      ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Process Chat 核心层                          │
│                    (纯JSON处理)                                  │
└─────────────────────────────────────────────────────────────────┘
           ↓                      ↓
┌─────────────────┐  ┌─────────────────┐
│  请求输出节点     │  │  响应输出节点     │
│RequestOutputNode │  │ResponseOutputNode│
└─────────────────┘  └─────────────────┘
```

## 📋 核心接口设计

### 1. UniversalAdapter 统一适配器接口

```typescript
// 双向适配器接口（对称设计）
interface UniversalAdapter {
  // 格式检测
  detectFormat(input: unknown): InputFormat;

  // 请求方向：输入 → JSON（进入Process Chat）
  toJson(input: unknown): Promise<JsonPayload>;

  // 响应方向：JSON → 输出（离开Process Chat）
  fromJson(json: JsonPayload, targetFormat: OutputFormat): Promise<unknown>;

  // 支持的格式
  supportedFormats(): Format[];

  // 协议类型
  protocol: StreamProtocol;
}

// 格式类型定义
type InputFormat = 'sse-stream' | 'json-object' | 'raw-text';
type OutputFormat = 'sse-stream' | 'json-object' | 'raw-text';

interface Format {
  protocol: 'chat' | 'responses' | 'anthropic';
  encoding: 'sse' | 'json';
  features?: string[]; // 'tool-calls', 'streaming', etc.
}

interface JsonPayload {
  [key: string]: unknown;
  // 标准化的JSON载荷格式
}
```

### 2. 协议特定适配器接口

```typescript
// Chat协议适配器
interface ChatAdapter extends UniversalAdapter {
  protocol: 'chat';

  // Chat特定的工具调用处理
  extractToolCalls?(input: unknown): ToolCall[];
  normalizeToolCalls?(toolCalls: ToolCall[]): ToolCall[];

  // Chat特定的内容处理
  extractContent?(input: unknown): ContentFragment[];
  normalizeContent?(content: ContentFragment[]): ContentFragment[];
}

// Responses协议适配器
interface ResponsesAdapter extends UniversalAdapter {
  protocol: 'responses';

  // Responses特定的输入结构处理
  extractInput?(input: unknown): ResponsesInput;
  normalizeInput?(input: ResponsesInput): ResponsesInput;

  // Responses特定的工具调用处理
  extractTools?(input: unknown): Tool[];
  normalizeTools?(tools: Tool[]): Tool[];
}

// Anthropic协议适配器
interface AnthropicAdapter extends UniversalAdapter {
  protocol: 'anthropic';

  // Anthropic特定的消息处理
  extractMessages?(input: unknown): Message[];
  normalizeMessages?(messages: Message[]): Message[];

  // Anthropic特定的系统提示处理
  extractSystemPrompt?(input: unknown): SystemPrompt;
  normalizeSystemPrompt?(prompt: SystemPrompt): SystemPrompt;
}
```

### 3. 适配器工厂接口

```typescript
class AdapterFactory {
  private adapters = new Map<string, UniversalAdapter>();

  constructor() {
    this.registerDefaultAdapters();
  }

  // 注册适配器
  register(protocol: string, adapter: UniversalAdapter): void;

  // 创建适配器
  create(protocol: string): UniversalAdapter;

  // 自动检测协议
  detectProtocol(input: unknown): string;

  // 获取所有支持的协议
  getSupportedProtocols(): string[];

  private registerDefaultAdapters(): void {
    this.register('chat', new ChatAdapterImpl());
    this.register('responses', new ResponsesAdapterImpl());
    this.register('anthropic', new AnthropicAdapterImpl());
  }
}
```

## 🔧 节点实现设计

### 1. 对称输入节点

```typescript
// 请求输入节点：处理进入的请求
class SymmetricInputNode implements BaseInputNode {
  constructor(
    private adapterFactory: AdapterFactory
  ) {}

  async process(input: unknown): Promise<JsonPayload> {
    // 1. 检测协议类型
    const protocol = this.adapterFactory.detectProtocol(input);

    // 2. 创建对应适配器
    const adapter = this.adapterFactory.create(protocol);

    // 3. 检测输入格式
    const format = adapter.detectFormat(input);

    // 4. 转换为JSON进入Process Chat
    const jsonPayload = await adapter.toJson(input);

    // 5. 记录原始格式信息供响应使用
    jsonPayload._meta = {
      originalFormat: format,
      protocol,
      requestId: this.generateRequestId()
    };

    return jsonPayload;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// 响应输入节点：处理返回的响应（对称设计）
class ResponseInputNode implements BaseInputNode {
  constructor(
    private adapterFactory: AdapterFactory
  ) {}

  async process(response: unknown): Promise<JsonPayload> {
    // 对称处理：检测响应格式并转换为JSON
    const protocol = this.adapterFactory.detectProtocol(response);
    const adapter = this.adapterFactory.create(protocol);
    const format = adapter.detectFormat(response);

    return adapter.toJson(response);
  }
}
```

### 2. 对称输出节点

```typescript
// 请求输出节点：处理出去的请求
class SymmetricOutputNode implements BaseOutputNode {
  constructor(
    private adapterFactory: AdapterFactory
  ) {}

  async process(
    json: JsonPayload,
    targetFormat: OutputFormat = 'json-object'
  ): Promise<unknown> {
    // 1. 从元数据中获取协议信息
    const protocol = json._meta?.protocol || this.detectProtocolFromJson(json);

    // 2. 创建对应适配器
    const adapter = this.adapterFactory.create(protocol);

    // 3. 从JSON转换为指定格式输出
    return adapter.fromJson(json, targetFormat);
  }

  private detectProtocolFromJson(json: JsonPayload): string {
    if (json.messages) return 'chat';
    if (json.input) return 'responses';
    if (json.max_tokens !== undefined) return 'anthropic';
    return 'chat'; // 默认
  }
}

// 响应输出节点：处理返回给客户端的响应（对称设计）
class ResponseOutputNode implements BaseOutputNode {
  constructor(
    private adapterFactory: AdapterFactory
  ) {}

  async process(
    json: JsonPayload,
    originalRequestFormat: OutputFormat
  ): Promise<unknown> {
    // 原路返回：使用请求时的格式
    const protocol = json._meta?.protocol || this.detectProtocolFromJson(json);
    const adapter = this.adapterFactory.create(protocol);

    return adapter.fromJson(json, originalRequestFormat);
  }
}
```

## 🎯 适配器实现示例

### Chat协议适配器实现

```typescript
class ChatAdapterImpl implements ChatAdapter {
  protocol: 'chat' = 'chat';

  detectFormat(input: unknown): InputFormat {
    // 检测是否是SSE流
    if (input && typeof input === 'object' && 'readable' in input) {
      return 'sse-stream';
    }

    // 检测是否是JSON对象
    if (input && typeof input === 'object' &&
        ('messages' in input || 'model' in input)) {
      return 'json-object';
    }

    return 'json-object'; // 默认
  }

  async toJson(input: unknown): Promise<JsonPayload> {
    const format = this.detectFormat(input);

    switch (format) {
      case 'sse-stream':
        return this.parseSSEToJSON(input as Readable);

      case 'json-object':
        return this.normalizeChatJSON(input as Record<string, unknown>);

      default:
        throw new Error(`Unsupported input format: ${format}`);
    }
  }

  async fromJson(json: JsonPayload, targetFormat: OutputFormat): Promise<unknown> {
    switch (targetFormat) {
      case 'sse-stream':
        return this.jsonToSSE(json);

      case 'json-object':
        return json;

      default:
        throw new Error(`Unsupported output format: ${targetFormat}`);
    }
  }

  supportedFormats(): Format[] {
    return [
      { protocol: 'chat', encoding: 'sse', features: ['streaming', 'tool-calls'] },
      { protocol: 'chat', encoding: 'json', features: ['tool-calls'] }
    ];
  }

  private async parseSSEToJSON(stream: Readable): Promise<JsonPayload> {
    // 使用现有的OpenAISSEParser解析SSE流
    let accumulatedJson: any = {};

    const parser = new OpenAISSEParser(
      stream,
      (chunk) => {
        // 累积SSE解析的chunk到最终JSON
        accumulatedJson = this.mergeChunk(accumulatedJson, chunk);
      },
      () => {
        // SSE流结束，accumulatedJson就是完整的JSON
      }
    );

    parser.start();

    // 等待解析完成
    return new Promise((resolve, reject) => {
      parser.onDone = () => resolve(this.normalizeChatJSON(accumulatedJson));
      parser.onError = reject;
    });
  }

  private async jsonToSSE(json: JsonPayload): Promise<Readable> {
    // 使用现有的JSON to SSE转换器
    // 复用 json-to-chat-sse.ts 中的逻辑
    return createChatSSEStreamFromChatJson(json);
  }

  private normalizeChatJSON(input: Record<string, unknown>): JsonPayload {
    // 标准化Chat JSON格式
    return {
      model: input.model || 'gpt-3.5-turbo',
      messages: input.messages || [],
      tools: input.tools || [],
      temperature: input.temperature,
      ...input
    };
  }

  private mergeChunk(accumulated: any, chunk: any): any {
    // 合并SSE chunk到累积的JSON对象
    // 处理增量内容、工具调用等
    return { ...accumulated, ...chunk };
  }
}
```

## 📊 完整调用关系

### 请求端调用流程
```
1. 客户端请求
   ↓
2. SymmetricInputNode.process()
   ├─ AdapterFactory.detectProtocol() → 'chat'
   ├─ AdapterFactory.create('chat') → ChatAdapter
   ├─ ChatAdapter.detectFormat() → 'sse-stream'
   └─ ChatAdapter.toJson() → 解析SSE → 标准化JSON
   ↓
3. Process Chat (纯JSON处理)
   ↓
4. SymmetricOutputNode.process()
   ├─ json._meta.protocol → 'chat'
   ├─ AdapterFactory.create('chat') → ChatAdapter
   └─ ChatAdapter.fromJson() → JSON → SSE流
   ↓
5. 发送到服务端
```

### 响应端调用流程（对称返回）
```
1. 服务端响应
   ↓
2. ResponseInputNode.process()
   ├─ AdapterFactory.detectProtocol() → 'responses'
   ├─ AdapterFactory.create('responses') → ResponsesAdapter
   ├─ ResponsesAdapter.detectFormat() → 'sse-stream'
   └─ ResponsesAdapter.toJson() → 解析SSE → 标准化JSON
   ↓
3. Process Chat (纯JSON处理)
   ↓
4. ResponseOutputNode.process()
   ├─ json._meta.originalFormat → 'sse-stream'
   ├─ AdapterFactory.create('responses') → ResponsesAdapter
   └─ ResponsesAdapter.fromJson() → JSON → SSE流
   ↓
5. 返回给客户端（原路返回）
```

## 🚀 实施计划

### 第一阶段：核心接口实现 (3-5天)
1. 实现 `UniversalAdapter` 接口和基础类型
2. 实现 `AdapterFactory` 工厂类
3. 创建协议检测逻辑

### 第二阶段：Chat协议适配器 (5-7天)
1. 实现 `ChatAdapterImpl` 完整功能
2. 集成现有的 `OpenAISSEParser` 和 `json-to-chat-sse.ts`
3. 测试Chat协议的SSE↔JSON双向转换

### 第三阶段：对称节点实现 (3-5天)
1. 实现 `SymmetricInputNode` 和 `SymmetricOutputNode`
2. 实现 `ResponseInputNode` 和 `ResponseOutputNode`
3. 集成到现有的Pipeline框架

### 第四阶段：其他协议适配器 (7-10天)
1. 实现 `ResponsesAdapterImpl`
2. 实现 `AnthropicAdapterImpl`
3. 测试所有协议的对称转换

### 第五阶段：集成和优化 (3-5天)
1. 替换现有的输入输出节点
2. 性能优化和内存管理
3. 错误处理和调试支持
4. 文档更新和测试覆盖

## ✅ 设计优势

### 1. 架构优势
- **对称性**: 请求响应完全对称，降低复杂度
- **统一性**: 所有协议使用相同的适配器接口
- **可扩展性**: 新增协议只需实现适配器接口
- **解耦合**: 输入输出与核心处理层完全解耦

### 2. 功能优势
- **格式可选**: 支持SSE和JSON格式的灵活选择
- **协议感知**: 自动检测和处理不同协议特性
- **路径保持**: 响应自动使用请求时的格式
- **双向转换**: 统一接口支持SSE↔JSON双向转换

### 3. 维护优势
- **代码复用**: 消除重复的SSE转换实现
- **一致性**: 所有协议使用相同的转换逻辑
- **可测试性**: 每个适配器可独立测试
- **可调试性**: 统一的错误处理和日志记录

## 📝 配置示例

### 适配器配置
```typescript
// 配置文件：adapter-config.json
{
  "adapters": {
    "chat": {
      "enabled": true,
      "features": ["streaming", "tool-calls"],
      "sseParser": "openai",
      "jsonSerializer": "chat"
    },
    "responses": {
      "enabled": true,
      "features": ["streaming", "tool-calls"],
      "sseParser": "responses",
      "jsonSerializer": "responses"
    },
    "anthropic": {
      "enabled": true,
      "features": ["streaming", "tool-calls"],
      "sseParser": "anthropic",
      "jsonSerializer": "anthropic"
    }
  },
  "defaults": {
    "protocol": "chat",
    "inputFormat": "json-object",
    "outputFormat": "json-object"
  }
}
```

## 🔍 调试和监控

### 诊断接口
```typescript
interface DiagnosticsChannel {
  // 格式检测日志
  logFormatDetection(input: unknown, format: InputFormat): void;

  // 转换过程日志
  logConversion(from: string, to: string, duration: number): void;

  // 错误追踪
  logError(error: Error, context: Record<string, unknown>): void;

  // 性能指标
  recordMetric(name: string, value: number): void;
}
```

---

*文档版本: v1.0*
*创建时间: 2025-11-23*
*维护者: V3架构团队*