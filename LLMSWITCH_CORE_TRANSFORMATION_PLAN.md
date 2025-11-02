# LLMSwitch-Core 系统Hooks集成改造计划

## 🎯 改造目标

基于您的需求，LLMSwitch-Core需要进行架构升级，实现以下核心特征：

### 1. 系统Hooks集成
- 每个转换节点前后都要有hooks
- 支持快照记录功能
- 通过入口端点区分路径
- 剔除老快照系统

### 2. 多端点处理架构
- 三个端点输入共存（Chat、Responses、Messages）
- 不同端点采用不同协议
- 遵循"哪里来哪里回"原则
- 多协议逻辑隔离但共享底层处理

### 3. 流程架构
- **SSE处理模块** → 协议转换 → OpenAI Chat统一
- **工具执行整理** → 工具请求整理 → 非流式请求
- **多协议共享逻辑** → 工具提取处理 → 协议转换返回
- **SSE合成返回**

## 📋 现状分析（基于Sysmem分析）

### 当前架构优势
- ✅ 已有SwitchOrchestrator作为转换调度中心
- ✅ 支持多种协议编解码器（OpenAI、Anthropic、Responses）
- ✅ 有ConversionProfile配置系统
- ✅ 工具调用标准化机制

### 当前架构问题
- ❌ 缺乏系统Hooks集成点
- ❌ 没有统一的快照系统
- ❌ 端点间隔离不够清晰
- ❌ SSE处理分散在不同编解码器中
- ❌ 工具处理逻辑不够统一

## 🏗️ 新架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    LLMSwitch-Core v2.0                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┬─────────────────┬─────────────────────────┐  │
│  │  Chat Endpoint  │ Responses Endpoint │ Messages Endpoint   │  │
│  │                 │                     │                     │  │
│  │ • OpenAI Protocol │ • OpenAI Protocol  │ • Anthropic Protocol │  │
│  │ • Streaming Support │ • Streaming Support │ • Streaming Support │  │
│  └─────────────────┴─────────────────┴─────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    System Hooks Manager                    │  │
│  │                                                             │  │
│  │  🔹 Endpoint Hooks 🔹 Protocol Hooks 🔹 Processing Hooks │  │
│  │  🔹 Snapshot Hooks 🔹 Validation Hooks 🔹 Transform Hooks │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    SSE Processing Layer                    │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   SSE       │   Event      │      Buffer             │  │  │
│  │  │   Collector │   Parser     │      Accumulator        │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                Protocol Conversion Engine                  │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   OpenAI    │  Anthropic   │      Responses          │  │  │
│  │  │   Codec     │   Codec      │      Bridge             │  │  │
│  │  │             │              │                          │  │  │
│  │  │ → OpenAI Chat Standard ←                          │  │  │
│  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                Unified Processing Layer                    │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   Tool      │   Request    │      Response           │  │  │
│  │  │   Extraction │   Normalizer │      Processor          │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                Protocol Return Engine                       │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   Response  │   SSE        │      Format              │  │  │
│  │  │   Converter │   Composer   │      Validator           │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                   Snapshot Manager                         │  │
│  │                                                             │  │
│  │  🔹 Endpoint-based Directory Structure                     │  │
│  │  🔹 JSON Snapshot Storage                                   │  │
│  │  🔹 Automatic Cleanup                                       │  │
│  │  🔹 Path Isolation                                          │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 📋 改造分阶段计划

### 阶段1: 系统Hooks基础架构 (Week 1-2)

#### 1.1 Hooks Manager 设计
```typescript
interface HookContext {
  endpoint: 'chat' | 'responses' | 'messages';
  requestId: string;
  stage: ProcessingStage;
  metadata: Record<string, any>;
}

interface HookResult {
  success: boolean;
  data?: any;
  error?: Error;
  shouldContinue: boolean;
}

abstract class BaseHook {
  abstract execute(context: HookContext, data: any): Promise<HookResult>;
}

class SystemHooksManager {
  private hooks: Map<HookType, BaseHook[]> = new Map();

  registerHook(type: HookType, hook: BaseHook): void;
  executeHooks(type: HookType, context: HookContext, data: any): Promise<any>;
}
```

#### 1.2 Hook类型定义
```typescript
enum HookType {
  // 端点级别
  ENDPOINT_INCOMING = 'endpoint_incoming',
  ENDPOINT_OUTGOING = 'endpoint_outgoing',

  // SSE处理
  SSE_COLLECTING = 'sse_collecting',
  SSE_ACCUMULATING = 'sse_accumulating',

  // 协议转换
  PROTOCOL_CONVERSION_PRE = 'protocol_conversion_pre',
  PROTOCOL_CONVERSION_POST = 'protocol_conversion_post',

  // 工具处理
  TOOL_EXTRACTION_PRE = 'tool_extraction_pre',
  TOOL_EXTRACTION_POST = 'tool_extraction_post',
  TOOL_PROCESSING_PRE = 'tool_processing_pre',
  TOOL_PROCESSING_POST = 'tool_processing_post',

  // 响应处理
  RESPONSE_FORMATTING_PRE = 'response_formatting_pre',
  RESPONSE_FORMATTING_POST = 'response_formatting_post',

  // 快照处理
  SNAPSHOT_PRE = 'snapshot_pre',
  SNAPSHOT_POST = 'snapshot_post'
}
```

#### 1.3 快照系统设计
```typescript
interface SnapshotConfig {
  enabled: boolean;
  baseDirectory: string;
  pathStrategy: 'endpoint' | 'request' | 'timestamp';
  retentionPolicy: {
    maxAge: number;
    maxSize: number;
  };
}

interface Snapshot {
  id: string;
  timestamp: string;
  endpoint: string;
  stage: string;
  data: any;
  metadata: {
    requestId: string;
    processingTime: number;
    dataSize: number;
  };
}

class SnapshotManager {
  constructor(private config: SnapshotConfig) {}

  async createSnapshot(context: HookContext, data: any): Promise<string>;
  async getSnapshot(id: string): Promise<Snapshot | null>;
  async cleanup(): Promise<void>;
  private generatePath(context: HookContext): string;
}
```

### 阶段2: 多端点隔离架构 (Week 3-4)

#### 2.1 端点处理器设计
```typescript
abstract class BaseEndpointHandler {
  protected endpoint: EndpointType;
  protected hooksManager: SystemHooksManager;
  protected snapshotManager: SnapshotManager;

  abstract handleRequest(request: any, context: RequestContext): Promise<any>;
  abstract handleResponse(response: any, context: RequestContext): Promise<any>;
}

class ChatEndpointHandler extends BaseEndpointHandler {
  async handleRequest(request: any): Promise<any> {
    // Chat特有处理逻辑
    const context = this.createContext('chat');

    // Hook: endpoint_incoming
    await this.hooksManager.executeHooks(
      HookType.ENDPOINT_INCOMING,
      context,
      request
    );

    // SSE处理
    const sseData = await this.processSSE(request, context);

    // 协议转换到OpenAI Chat
    const openaiChatRequest = await this.convertToOpenAIChat(sseData, context);

    return openaiChatRequest;
  }
}

class ResponsesEndpointHandler extends BaseEndpointHandler {
  // 类似的实现，但针对Responses API的特定逻辑
}

class MessagesEndpointHandler extends BaseEndpointHandler {
  // 类似的实现，但针对Anthropic Messages API的特定逻辑
}
```

#### 2.2 路由管理器
```typescript
class EndpointRouter {
  private handlers: Map<EndpointType, BaseEndpointHandler> = new Map();

  registerHandler(endpoint: EndpointType, handler: BaseEndpointHandler): void;
  async route(request: any, endpoint: EndpointType): Promise<any>;
  private detectEndpoint(request: any): EndpointType;
}
```

### 阶段3: SSE处理统一化 (Week 5-6)

#### 3.1 SSE处理引擎
```typescript
interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

interface SSEAccumulator {
  buffer: SSEEvent[];
  startTime: number;
  isComplete: boolean;
}

class SSEProcessor {
  private accumulators: Map<string, SSEAccumulator> = new Map();

  async processSSEStream(
    sseStream: AsyncIterable<SSEEvent>,
    context: HookContext
  ): Promise<any>;

  private accumulateEvents(
    requestId: string,
    events: SSEEvent[]
  ): SSEAccumulator;

  private isStreamComplete(events: SSEEvent[]): boolean;
  private convertToPayload(events: SSEEvent[]): any;
}
```

#### 3.2 协议转换增强
```typescript
class UnifiedProtocolConverter {
  async convertToOpenAIChat(
    payload: any,
    sourceProtocol: string,
    context: HookContext
  ): Promise<OpenAIChatRequest>;

  async convertFromOpenAIChat(
    openaiChatResponse: any,
    targetProtocol: string,
    context: HookContext
  ): Promise<any>;
}
```

### 阶段4: 工具处理统一化 (Week 7-8)

#### 4.1 工具处理流水线
```typescript
interface ToolProcessingContext {
  endpoint: string;
  requestId: string;
  tools: ToolDefinition[];
  toolCalls: ToolCall[];
}

class ToolProcessingPipeline {
  async processToolRequests(
    context: ToolProcessingContext
  ): Promise<ToolProcessingResult>;

  async processToolResults(
    results: ToolResult[],
    context: ToolProcessingContext
  ): Promise<any>;

  private extractToolCalls(payload: any): ToolCall[];
  private normalizeToolDefinitions(tools: any[]): ToolDefinition[];
  private validateToolCalls(calls: ToolCall[]): boolean;
}
```

### 阶段5: 响应处理和返回 (Week 9-10)

#### 5.1 响应处理器
```typescript
class ResponseProcessor {
  async processResponse(
    response: any,
    originalEndpoint: EndpointType,
    context: HookContext
  ): Promise<any> {

    // Hook: response_formatting_pre
    await this.hooksManager.executeHooks(
      HookType.RESPONSE_FORMATTING_PRE,
      context,
      response
    );

    // 工具提取和处理
    const processedResponse = await this.processToolExtraction(response, context);

    // 协议转换回原始格式
    const finalResponse = await this.convertToOriginalProtocol(
      processedResponse,
      originalEndpoint,
      context
    );

    // SSE合成（如果是流式响应）
    if (context.stream) {
      return await this.composeSSE(finalResponse, context);
    }

    // Hook: response_formatting_post
    await this.hooksManager.executeHooks(
      HookType.RESPONSE_FORMATTING_POST,
      context,
      finalResponse
    );

    return finalResponse;
  }
}
```

## 🗂️ 新文件结构

```
sharedmodule/llmswitch-core/src/
├── hooks/                           # 新增：系统Hooks
│   ├── base-hook.ts
│   ├── hooks-manager.ts
│   ├── types.ts
│   └── implementations/
│       ├── snapshot-hook.ts
│       ├── validation-hook.ts
│       ├── logging-hook.ts
│       └── metrics-hook.ts
├── endpoints/                       # 新增：端点处理器
│   ├── base-endpoint-handler.ts
│   ├── chat-endpoint-handler.ts
│   ├── responses-endpoint-handler.ts
│   ├── messages-endpoint-handler.ts
│   └── endpoint-router.ts
├── sse/                            # 新增：SSE处理
│   ├── sse-processor.ts
│   ├── sse-accumulator.ts
│   ├── sse-parser.ts
│   └── sse-composer.ts
├── snapshots/                       # 新增：快照系统
│   ├── snapshot-manager.ts
│   ├── snapshot-storage.ts
│   ├── snapshot-cleanup.ts
│   └── types.ts
├── protocols/                       # 重构：协议转换
│   ├── unified-converter.ts
│   ├── openai-chat-standard.ts
│   ├── protocol-detector.ts
│   └── codecs/
│       ├── openai-codec.ts
│       ├── anthropic-codec.ts
│       └── responses-codec.ts
├── tools/                           # 重构：工具处理
│   ├── tool-processing-pipeline.ts
│   ├── tool-extractor.ts
│   ├── tool-normalizer.ts
│   └── tool-validator.ts
├── core/                            # 新增：核心协调器
│   ├── llmswitch-engine.ts
│   ├── request-context.ts
│   ├── processing-flow.ts
│   └── types.ts
├── config/                          # 重构：配置管理
│   ├── hooks-config.ts
│   ├── endpoints-config.ts
│   ├── snapshots-config.ts
│   └── llmswitch-profiles-v2.json
└── index.ts                         # 重构：主入口
```

## 📊 配置文件设计

### 新的LLMSwitch配置文件结构
```json
{
  "version": "2.0",
  "hooks": {
    "enabled": true,
    "snapshot": {
      "enabled": true,
      "baseDirectory": "~/.routecodex/snapshots/llmswitch-core",
      "pathStrategy": "endpoint",
      "retentionPolicy": {
        "maxAge": 86400000,
        "maxSize": "100MB"
      }
    },
    "hooks": [
      {
        "type": "snapshot",
        "stages": ["protocol_conversion_pre", "tool_extraction_post"],
        "config": {}
      },
      {
        "type": "validation",
        "stages": ["endpoint_incoming", "tool_processing_pre"],
        "config": {}
      }
    ]
  },
  "endpoints": {
    "chat": {
      "protocol": "openai",
      "handler": "ChatEndpointHandler",
      "sse": {
        "enabled": true,
        "accumulateMs": 1000
      }
    },
    "responses": {
      "protocol": "openai-responses",
      "handler": "ResponsesEndpointHandler",
      "sse": {
        "enabled": true,
        "accumulateMs": 1000
      }
    },
    "messages": {
      "protocol": "anthropic",
      "handler": "MessagesEndpointHandler",
      "sse": {
        "enabled": true,
        "accumulateMs": 1000
      }
    }
  },
  "processing": {
    "unifiedProtocol": "openai-chat",
    "toolProcessing": {
      "enabled": true,
      "maxToolCalls": 32,
      "timeout": 30000
    }
  }
}
```

## 🎯 实施优先级

### 高优先级 (必须实现)
1. **系统Hooks基础架构** - 整个改造的核心基础
2. **快照系统** - 新的调试和监控需求
3. **端点隔离** - 满足"哪里来哪里回"原则
4. **SSE统一处理** - 解决当前分散的SSE处理逻辑

### 中优先级 (重要功能)
1. **协议转换增强** - 支持更好的多协议处理
2. **工具处理流水线** - 统一工具调用处理
3. **配置管理升级** - 支持新的配置需求

### 低优先级 (优化功能)
1. **性能优化** - Hook执行性能优化
2. **监控集成** - 与现有监控系统集成
3. **错误处理增强** - 更好的错误恢复机制

## ⚠️ 风险评估

### 技术风险
- **复杂性增加**: 新架构可能增加系统复杂性
- **性能影响**: Hook系统可能影响处理性能
- **向后兼容**: 需要确保现有API的向后兼容性

### 缓解策略
- **渐进式迁移**: 分阶段实施，每阶段充分测试
- **性能基准**: 建立性能基准，监控性能影响
- **兼容性测试**: 建立完整的兼容性测试套件

## 📋 验收标准

### 功能验收
- ✅ 支持三个端点独立处理
- ✅ 每个转换节点都有Hooks
- ✅ 快照系统正常工作
- ✅ 协议转换正确性
- ✅ 工具处理统一性

### 性能验收
- ✅ 处理延迟不超过现有系统的120%
- ✅ 内存使用不超过现有系统的150%
- ✅ 支持并发处理能力不降低

### 质量验收
- ✅ 代码覆盖率 > 90%
- ✅ 集成测试通过率 100%
- ✅ 文档完整性检查通过

---

## 🚀 下一步行动

**请您审批此改造计划，确认后我将开始实施第一阶段：系统Hooks基础架构的设计和实现。**

整个改造预计需要10周时间，分5个阶段进行。每个阶段都会有明确的交付物和验收标准。