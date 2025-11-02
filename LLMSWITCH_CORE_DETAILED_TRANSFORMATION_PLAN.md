# LLMSwitch-Core 详细改造计划（基于现有Hooks系统）

## 🎯 改造目标

基于现有Hooks系统实现LLMSwitch-Core的架构升级，满足以下核心需求：

### 系统特征要求
1. **三个端点输入共存** - Chat、Responses、Messages端点独立处理
2. **协议隔离但共享逻辑** - 遵循"哪里来哪里回"原则
3. **SSE统一处理** - 积累完毕后转换协议为目标协议
4. **工具处理统一** - 统一为OpenAI Chat格式后共享处理逻辑
5. **系统Hooks集成** - 每个转换节点前后都有hooks，支持快照记录
6. **路径隔离快照** - 通过入口端点区分路径，剔除老快照系统

## 📋 现有Hooks系统分析

### ✅ 现有优势
- **完整的Hook管理器** - `HookManager`支持注册、执行、生命周期管理
- **统一的Hook阶段** - `UnifiedHookStage`包含完整的阶段定义
- **快照服务** - `SnapshotService`支持快照记录、存储和管理
- **Provider适配器** - `ProviderAdapter`兼容现有Provider v2
- **双向Hook接口** - `IBidirectionalHook`支持读取、写入、转换操作

### 🔧 需要扩展的部分
- **LLMSwitch专用阶段** - 需要扩展`UnifiedHookStage`支持LLMSwitch特定阶段
- **端点隔离支持** - 需要在Hook上下文中增加端点信息
- **SSE处理Hook** - 需要专门的SSE处理阶段和Hook
- **协议转换Hook** - 需要协议转换前后的Hook支持

## 🏗️ 新架构设计（基于现有Hooks）

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    LLMSwitch-Core v2.0 (集成现有Hooks)          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┬─────────────────┬─────────────────────────┐  │
│  │  Chat Endpoint  │ Responses Endpoint │ Messages Endpoint   │  │
│  │                 │                     │                     │  │
│  │ • OpenAI Protocol │ • OpenAI Protocol  │ • Anthropic Protocol │  │
│  │ • Hook: ENDPOINT_PROCESSING_PRE                        │  │
│  │ • Hook: ENDPOINT_PROCESSING_POST                       │  │
│  └─────────────────┴─────────────────┴─────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    现有Hooks系统                            │  │
│  │                                                             │  │
│  │  🔹 HookManager 🔹 SnapshotService 🔹 ProviderAdapter   │  │
│  │  🔹 扩展LLMSwitch专用阶段                                   │  │
│  │  🔹 端点隔离支持                                            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    SSE处理层                                │  │
│  │                                                             │  │
│  │  🔹 Hook: SSE_COLLECTING_PRE                              │  │
│  │  🔹 SSE收集器 🔹 事件解析器 🔹 积累器                     │  │
│  │  🔹 Hook: SSE_COLLECTING_POST                             │  │
│  │  🔹 Hook: SSE_ACCUMULATING_PRE                            │  │
│  │  🔹 Hook: SSE_ACCUMULATING_POST                           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    协议转换层                                │  │
│  │                                                             │  │
│  │  🔹 Hook: PROTOCOL_CONVERSION_PRE                         │  │
│  │  🔹 OpenAI Codec 🔹 Anthropic Codec 🔹 Responses Bridge  │  │
│  │  🔹 Hook: PROTOCOL_CONVERSION_POST                        │  │
│  │  🔹 统一转换为OpenAI Chat格式                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    工具处理层                                │  │
│  │                                                             │  │
│  │  🔹 Hook: TOOL_PROCESSING_PRE                              │  │
│  │  🔹 工具提取器 🔹 请求整理器 🔹 结果整理器                │  │
│  │  🔹 Hook: TOOL_PROCESSING_POST                             │  │
│  │  🔹 非流式请求发出                                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    响应处理层                                │  │
│  │                                                             │  │
│  │  🔹 Hook: RESPONSE_PROCESSING_PRE                         │  │
│  │  🔹 工具提取预检查 🔹 工具提取 🔹 工具修补              │  │
│  │  🔹 Hook: RESPONSE_PROCESSING_POST                        │  │
│  │  🔹 Hook: PROTOCOL_RETURN_PRE                             │  │
│  │  🔹 协议转换回原始格式                                      │  │
│  │  🔹 Hook: PROTOCOL_RETURN_POST                            │  │
│  │  🔹 SSE合成返回                                            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    现有快照系统                              │  │
│  │                                                             │  │
│  │  🔹 SnapshotService 🔹 端点路径隔离                       │  │
│  │  🔹 JSON格式存储 🔹 自动清理                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 📋 详细改造分阶段计划

### 阶段1: 扩展Hooks系统支持LLMSwitch (Week 1-2)

#### 1.1 扩展UnifiedHookStage
```typescript
// 在现有hook-types.ts中扩展
export enum UnifiedHookStage {
  // ... 现有阶段保持不变

  // LLMSwitch专用阶段
  ENDPOINT_PROCESSING_PRE = 'endpoint_processing_pre',
  ENDPOINT_PROCESSING_POST = 'endpoint_processing_post',

  SSE_COLLECTING_PRE = 'sse_collecting_pre',
  SSE_COLLECTING_POST = 'sse_collecting_post',
  SSE_ACCUMULATING_PRE = 'sse_accumulating_pre',
  SSE_ACCUMULATING_POST = 'sse_accumulating_post',

  PROTOCOL_CONVERSION_PRE = 'protocol_conversion_pre',
  PROTOCOL_CONVERSION_POST = 'protocol_conversion_post',

  TOOL_PROCESSING_PRE = 'tool_processing_pre',
  TOOL_PROCESSING_POST = 'tool_processing_post',

  RESPONSE_PROCESSING_PRE = 'response_processing_pre',
  RESPONSE_PROCESSING_POST = 'response_processing_post',

  PROTOCOL_RETURN_PRE = 'protocol_return_pre',
  PROTOCOL_RETURN_POST = 'protocol_return_post'
}
```

#### 1.2 扩展HookExecutionContext支持端点隔离
```typescript
// 在现有hook-types.ts中扩展
export interface HookExecutionContext {
  readonly executionId: string;
  readonly stage: UnifiedHookStage;
  readonly startTime: number;
  readonly requestId?: string;
  readonly moduleId?: string;
  readonly metadata?: Record<string, any>;

  // 新增：LLMSwitch专用字段
  readonly endpoint?: 'chat' | 'responses' | 'messages';
  readonly originalProtocol?: string;
  readonly targetProtocol?: string;
  readonly pathIdentifier?: string; // 用于快照路径隔离
}
```

#### 1.3 创建LLMSwitch专用Hook类型
```typescript
// 新文件：src/modules/hooks/types/llmswitch-hook-types.ts
export interface LLMSwitchHookContext extends HookExecutionContext {
  endpoint: 'chat' | 'responses' | 'messages';
  originalProtocol: string;
  targetProtocol: string;
  pathIdentifier: string;
}

export interface SSEHookData {
  events: Array<{
    id?: string;
    event?: string;
    data: string;
    timestamp: number;
  }>;
  isComplete: boolean;
  accumulationTime: number;
}

export interface ProtocolConversionData {
  sourceProtocol: string;
  targetProtocol: string;
  payload: any;
  conversionRules?: Record<string, any>;
}

export interface ToolProcessingData {
  tools: any[];
  toolCalls: any[];
  executionMode: 'streaming' | 'non-streaming';
  requestId: string;
}
```

#### 1.4 扩展SnapshotService支持端点隔离
```typescript
// 扩展现有的SnapshotServiceConfig
export interface LLMSwitchSnapshotConfig extends SnapshotServiceConfig {
  // 覆盖basePath以支持端点隔离
  basePath: string;

  // LLMSwitch专用配置
  endpointIsolation: {
    enabled: boolean;
    pathStructure: 'endpoint/date' | 'endpoint/request' | 'endpoint/timestamp';
  };

  // 快照路径生成策略
  pathGeneration: {
    includeRequestId: boolean;
    includeStage: boolean;
    includeTimestamp: boolean;
  };
}

// 新文件：src/modules/hooks/service/snapshot/llmswitch-snapshot-service.ts
export class LLMSwitchSnapshotService extends SnapshotService {
  constructor(config: LLMSwitchSnapshotConfig) {
    super(config);
  }

  // 重写路径生成逻辑以支持端点隔离
  protected generatePath(context: LLMSwitchHookContext): string {
    const { endpoint, pathIdentifier, stage } = context;

    if (this.config.endpointIsolation.enabled) {
      const basePath = join(this.config.basePath, endpoint);

      switch (this.config.endpointIsolation.pathStructure) {
        case 'endpoint/date':
          return join(basePath, this.formatDate(new Date()), `${stage}.json`);
        case 'endpoint/request':
          return join(basePath, pathIdentifier, `${stage}.json`);
        case 'endpoint/timestamp':
          return join(basePath, `${Date.now()}_${stage}.json`);
        default:
          return join(basePath, `${stage}.json`);
      }
    }

    return super.generatePath(context);
  }
}
```

### 阶段2: 端点处理器架构 (Week 3-4)

#### 2.1 创建端点处理器基类
```typescript
// 新文件：src/modules/pipeline/llmswitch/endpoint/base-endpoint-handler.ts
export abstract class BaseEndpointHandler {
  protected endpoint: EndpointType;
  protected hooksManager: IHookManager;
  protected snapshotService: LLMSwitchSnapshotService;

  constructor(
    endpoint: EndpointType,
    hooksManager: IHookManager,
    snapshotService: LLMSwitchSnapshotService
  ) {
    this.endpoint = endpoint;
    this.hooksManager = hooksManager;
    this.snapshotService = snapshotService;
  }

  async handleRequest(request: any, context: Partial<LLMSwitchHookContext>): Promise<any> {
    const hookContext: LLMSwitchHookContext = {
      executionId: this.generateExecutionId(),
      stage: UnifiedHookStage.ENDPOINT_PROCESSING_PRE,
      startTime: Date.now(),
      requestId: context.requestId,
      moduleId: 'llmswitch-core',
      endpoint: this.endpoint,
      originalProtocol: this.getOriginalProtocol(),
      targetProtocol: 'openai-chat',
      pathIdentifier: this.generatePathIdentifier(context.requestId),
      metadata: context.metadata
    };

    // Hook: endpoint_processing_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.ENDPOINT_PROCESSING_PRE,
      'request',
      request,
      hookContext
    );

    // 应用Hook结果
    let processedRequest = this.applyHookResults(request, preResults);

    // 端点特定处理
    processedRequest = await this.processEndpointSpecific(processedRequest, hookContext);

    // Hook: endpoint_processing_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.ENDPOINT_PROCESSING_POST,
      'request',
      processedRequest,
      { ...hookContext, stage: UnifiedHookStage.ENDPOINT_PROCESSING_POST }
    );

    return this.applyHookResults(processedRequest, postResults);
  }

  protected abstract getOriginalProtocol(): string;
  protected abstract processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any>;

  private generateExecutionId(): string {
    return `${this.endpoint}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generatePathIdentifier(requestId?: string): string {
    return requestId || `${this.endpoint}-${Date.now()}`;
  }

  private applyHookResults(data: any, results: HookExecutionResult[]): any {
    return results.reduce((acc, result) => {
      if (result.success && result.data) {
        return result.data;
      }
      return acc;
    }, data);
  }
}
```

#### 2.2 实现具体端点处理器
```typescript
// 新文件：src/modules/pipeline/llmswitch/endpoint/chat-endpoint-handler.ts
export class ChatEndpointHandler extends BaseEndpointHandler {
  constructor(hooksManager: IHookManager, snapshotService: LLMSwitchSnapshotService) {
    super('chat', hooksManager, snapshotService);
  }

  protected getOriginalProtocol(): string {
    return 'openai-chat';
  }

  protected async processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Chat端点特定处理逻辑
    // 1. 验证OpenAI Chat格式
    // 2. 处理streaming标志
    // 3. 预处理工具调用
    return request;
  }

  async handleResponse(response: any, context: LLMSwitchHookContext): Promise<any> {
    // Hook: response_processing_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.RESPONSE_PROCESSING_PRE,
      'response',
      response,
      { ...context, stage: UnifiedHookStage.RESPONSE_PROCESSING_PRE }
    );

    // 处理响应
    let processedResponse = this.applyHookResults(response, preResults);

    // Hook: response_processing_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.RESPONSE_PROCESSING_POST,
      'response',
      processedResponse,
      { ...context, stage: UnifiedHookStage.RESPONSE_PROCESSING_POST }
    );

    return this.applyHookResults(processedResponse, postResults);
  }
}

// 新文件：src/modules/pipeline/llmswitch/endpoint/responses-endpoint-handler.ts
export class ResponsesEndpointHandler extends BaseEndpointHandler {
  protected getOriginalProtocol(): string {
    return 'openai-responses';
  }

  protected async processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Responses端点特定处理逻辑
    // 1. 转换Responses格式到标准格式
    // 2. 处理特殊的Responses字段
    return request;
  }
}

// 新文件：src/modules/pipeline/llmswitch/endpoint/messages-endpoint-handler.ts
export class MessagesEndpointHandler extends BaseEndpointHandler {
  protected getOriginalProtocol(): string {
    return 'anthropic-messages';
  }

  protected async processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Messages端点特定处理逻辑
    // 1. 处理Anthropic Messages格式
    // 2. 转换系统消息格式
    return request;
  }
}
```

#### 2.3 创建端点路由器
```typescript
// 新文件：src/modules/pipeline/llmswitch/endpoint/endpoint-router.ts
export class EndpointRouter {
  private handlers: Map<EndpointType, BaseEndpointHandler> = new Map();

  registerHandler(endpoint: EndpointType, handler: BaseEndpointHandler): void {
    this.handlers.set(endpoint, handler);
  }

  async routeRequest(
    request: any,
    endpoint: EndpointType,
    context?: Partial<LLMSwitchHookContext>
  ): Promise<any> {
    const handler = this.handlers.get(endpoint);
    if (!handler) {
      throw new Error(`No handler registered for endpoint: ${endpoint}`);
    }

    return await handler.handleRequest(request, context || {});
  }

  async routeResponse(
    response: any,
    endpoint: EndpointType,
    context: LLMSwitchHookContext
  ): Promise<any> {
    const handler = this.handlers.get(endpoint);
    if (!handler) {
      throw new Error(`No handler registered for endpoint: ${endpoint}`);
    }

    if (handler instanceof ChatEndpointHandler) {
      return await handler.handleResponse(response, context);
    }

    // 其他端点的响应处理逻辑
    return response;
  }

  detectEndpoint(request: any): EndpointType {
    // 自动检测端点类型
    if (request.model && request.messages && request.stream !== undefined) {
      return 'chat';
    } else if (request.instructions || request.tools) {
      return 'responses';
    } else if (request.messages && request.max_tokens !== undefined) {
      return 'messages';
    }

    throw new Error('Unable to detect endpoint type');
  }
}
```

### 阶段3: SSE处理统一化 (Week 5-6)

#### 3.1 创建SSE处理器
```typescript
// 新文件：src/modules/pipeline/llmswitch/sse/sse-processor.ts
export class SSEProcessor {
  private hooksManager: IHookManager;
  private snapshotService: LLMSwitchSnapshotService;

  constructor(hooksManager: IHookManager, snapshotService: LLMSwitchSnapshotService) {
    this.hooksManager = hooksManager;
    this.snapshotService = snapshotService;
  }

  async processSSEStream(
    sseStream: AsyncIterable<SSEEvent>,
    context: LLMSwitchHookContext
  ): Promise<SSEHookData> {
    // Hook: sse_collecting_pre
    await this.hooksManager.executeHooks(
      UnifiedHookStage.SSE_COLLECTING_PRE,
      'sse',
      { stream: true },
      { ...context, stage: UnifiedHookStage.SSE_COLLECTING_PRE }
    );

    const events: SSEEvent[] = [];
    const startTime = Date.now();

    // 收集SSE事件
    for await (const event of sseStream) {
      events.push({
        ...event,
        timestamp: Date.now()
      });

      // 快照收集过程
      await this.snapshotService.createSnapshot(
        { ...context, stage: UnifiedHookStage.SSE_COLLECTING_POST },
        { events: events.slice(), collectedAt: Date.now() }
      );
    }

    // Hook: sse_accumulating_pre
    await this.hooksManager.executeHooks(
      UnifiedHookStage.SSE_ACCUMULATING_PRE,
      'sse',
      { events, collectedCount: events.length },
      { ...context, stage: UnifiedHookStage.SSE_ACCUMULATING_PRE }
    );

    // 积累和处理
    const accumulatedData: SSEHookData = {
      events,
      isComplete: this.isStreamComplete(events),
      accumulationTime: Date.now() - startTime
    };

    // Hook: sse_accumulating_post
    await this.hooksManager.executeHooks(
      UnifiedHookStage.SSE_ACCUMULATING_POST,
      'sse',
      accumulatedData,
      { ...context, stage: UnifiedHookStage.SSE_ACCUMULATING_POST }
    );

    return accumulatedData;
  }

  private isStreamComplete(events: SSEEvent[]): boolean {
    // 检查流是否完成
    return events.some(event =>
      event.event === 'done' ||
      (event.data && event.data.includes('[DONE]'))
    );
  }
}

// 新文件：src/modules/pipeline/llmswitch/sse/sse-event.ts
export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
  timestamp?: number;
}
```

#### 3.2 集成SSE处理器到端点处理器
```typescript
// 修改BaseEndpointHandler
export abstract class BaseEndpointHandler {
  // ... 现有代码

  protected sseProcessor: SSEProcessor;

  constructor(
    endpoint: EndpointType,
    hooksManager: IHookManager,
    snapshotService: LLMSwitchSnapshotService
  ) {
    this.endpoint = endpoint;
    this.hooksManager = hooksManager;
    this.snapshotService = snapshotService;
    this.sseProcessor = new SSEProcessor(hooksManager, snapshotService);
  }

  protected async processStreamingRequest(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    if (!request.stream) {
      return request;
    }

    // 处理流式请求
    const sseData = await this.sseProcessor.processSSEStream(
      this.extractSSEStream(request),
      context
    );

    // 转换为标准格式
    return this.convertSSEToStandardFormat(sseData, context);
  }

  protected abstract extractSSEStream(request: any): AsyncIterable<SSEEvent>;
  protected abstract convertSSEToStandardFormat(
    sseData: SSEHookData,
    context: LLMSwitchHookContext
  ): any;
}
```

### 阶段4: 协议转换引擎 (Week 7-8)

#### 4.1 创建统一协议转换器
```typescript
// 新文件：src/modules/pipeline/llmswitch/protocol/unified-protocol-converter.ts
export class UnifiedProtocolConverter {
  private hooksManager: IHookManager;
  private snapshotService: LLMSwitchSnapshotService;
  private codecs: Map<string, any> = new Map();

  constructor(hooksManager: IHookManager, snapshotService: LLMSwitchSnapshotService) {
    this.hooksManager = hooksManager;
    this.snapshotService = snapshotService;
    this.initializeCodecs();
  }

  async convertToOpenAIChat(
    payload: any,
    sourceProtocol: string,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Hook: protocol_conversion_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.PROTOCOL_CONVERSION_PRE,
      'protocol',
      { sourceProtocol, targetProtocol: 'openai-chat', payload },
      { ...context, stage: UnifiedHookStage.PROTOCOL_CONVERSION_PRE }
    );

    // 应用预转换Hook结果
    let processedPayload = this.applyHookResults(payload, preResults);

    // 执行协议转换
    const codec = this.codecs.get(`${sourceProtocol}-to-openai-chat`);
    if (!codec) {
      throw new Error(`No codec found for ${sourceProtocol} to openai-chat`);
    }

    const convertedPayload = await codec.encode(processedPayload);

    // Hook: protocol_conversion_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.PROTOCOL_CONVERSION_POST,
      'protocol',
      { sourceProtocol, targetProtocol: 'openai-chat', payload: convertedPayload },
      { ...context, stage: UnifiedHookStage.PROTOCOL_CONVERSION_POST }
    );

    return this.applyHookResults(convertedPayload, postResults);
  }

  async convertFromOpenAIChat(
    openaiChatResponse: any,
    targetProtocol: string,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Hook: protocol_return_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.PROTOCOL_RETURN_PRE,
      'protocol',
      { sourceProtocol: 'openai-chat', targetProtocol, payload: openaiChatResponse },
      { ...context, stage: UnifiedHookStage.PROTOCOL_RETURN_PRE }
    );

    let processedResponse = this.applyHookResults(openaiChatResponse, preResults);

    // 执行协议转换
    const codec = this.codecs.get(`openai-chat-to-${targetProtocol}`);
    if (!codec) {
      throw new Error(`No codec found for openai-chat to ${targetProtocol}`);
    }

    const convertedResponse = await codec.decode(processedResponse);

    // Hook: protocol_return_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.PROTOCOL_RETURN_POST,
      'protocol',
      { sourceProtocol: 'openai-chat', targetProtocol, payload: convertedResponse },
      { ...context, stage: UnifiedHookStage.PROTOCOL_RETURN_POST }
    );

    return this.applyHookResults(convertedResponse, postResults);
  }

  private initializeCodecs(): void {
    // 初始化现有的编解码器
    import('../../conversion/codecs/openai-openai-codec.js').then(({ OpenAIOpenAIConversionCodec }) => {
      this.codecs.set('openai-chat-to-openai-chat', new OpenAIOpenAIConversionCodec());
    });

    import('../../conversion/codecs/anthropic-openai-codec.js').then(({ AnthropicOpenAIConversionCodec }) => {
      this.codecs.set('anthropic-messages-to-openai-chat', new AnthropicOpenAIConversionCodec());
      this.codecs.set('openai-chat-to-anthropic-messages', new AnthropicOpenAIConversionCodec());
    });

    import('../../conversion/codecs/responses-openai-codec.js').then(({ ResponsesOpenAIConversionCodec }) => {
      this.codecs.set('openai-responses-to-openai-chat', new ResponsesOpenAIConversionCodec());
      this.codecs.set('openai-chat-to-openai-responses', new ResponsesOpenAIConversionCodec());
    });
  }

  private applyHookResults(data: any, results: HookExecutionResult[]): any {
    return results.reduce((acc, result) => {
      if (result.success && result.data) {
        return result.data;
      }
      return acc;
    }, data);
  }
}
```

#### 4.2 集成协议转换器到端点处理器
```typescript
// 修改BaseEndpointHandler
export abstract class BaseEndpointHandler {
  // ... 现有属性
  protected protocolConverter: UnifiedProtocolConverter;

  constructor(
    endpoint: EndpointType,
    hooksManager: IHookManager,
    snapshotService: LLMSwitchSnapshotService
  ) {
    // ... 现有初始化
    this.protocolConverter = new UnifiedProtocolConverter(hooksManager, snapshotService);
  }

  protected async processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // 1. 端点特定预处理
    let processedRequest = await this.preprocessRequest(request, context);

    // 2. 处理流式请求
    if (processedRequest.stream) {
      processedRequest = await this.processStreamingRequest(processedRequest, context);
    }

    // 3. 协议转换到OpenAI Chat
    const openaiChatRequest = await this.protocolConverter.convertToOpenAIChat(
      processedRequest,
      context.originalProtocol,
      context
    );

    return openaiChatRequest;
  }

  protected abstract preprocessRequest(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any>;
}
```

### 阶段5: 工具处理流水线 (Week 9-10)

#### 5.1 创建工具处理流水线
```typescript
// 新文件：src/modules/pipeline/llmswitch/tools/tool-processing-pipeline.ts
export class ToolProcessingPipeline {
  private hooksManager: IHookManager;
  private snapshotService: LLMSwitchSnapshotService;

  constructor(hooksManager: IHookManager, snapshotService: LLMSwitchSnapshotService) {
    this.hooksManager = hooksManager;
    this.snapshotService = snapshotService;
  }

  async processToolRequests(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Hook: tool_processing_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.TOOL_PROCESSING_PRE,
      'tools',
      { tools: request.tools, toolCalls: request.toolCalls },
      { ...context, stage: UnifiedHookStage.TOOL_PROCESSING_PRE }
    );

    // 应用预处理Hook结果
    let processedRequest = this.applyHookResults(request, preResults);

    // 1. 工具请求整理
    const organizedRequest = await this.organizeToolRequest(processedRequest, context);

    // 2. 转换为非流式请求
    const nonStreamingRequest = await this.convertToNonStreaming(organizedRequest, context);

    return nonStreamingRequest;
  }

  async processToolResults(
    response: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Hook: tool_processing_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.TOOL_PROCESSING_POST,
      'tools',
      response,
      { ...context, stage: UnifiedHookStage.TOOL_PROCESSING_POST }
    );

    return this.applyHookResults(response, postResults);
  }

  private async organizeToolRequest(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // 整理工具请求逻辑
    return {
      ...request,
      tools: this.normalizeToolDefinitions(request.tools),
      toolCalls: this.normalizeToolCalls(request.toolCalls)
    };
  }

  private async convertToNonStreaming(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // 转换为非流式请求
    return {
      ...request,
      stream: false // 强制非流式
    };
  }

  private normalizeToolDefinitions(tools: any[]): any[] {
    // 标准化工具定义
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name || tool.function?.name,
        description: tool.description || tool.function?.description,
        parameters: tool.parameters || tool.function?.parameters
      }
    }));
  }

  private normalizeToolCalls(toolCalls: any[]): any[] {
    // 标准化工具调用
    return toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.function?.name,
        arguments: typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments)
      }
    }));
  }

  private applyHookResults(data: any, results: HookExecutionResult[]): any {
    return results.reduce((acc, result) => {
      if (result.success && result.data) {
        return result.data;
      }
      return acc;
    }, data);
  }
}
```

#### 5.2 集成工具处理流水线
```typescript
// 修改BaseEndpointHandler
export abstract class BaseEndpointHandler {
  // ... 现有属性
  protected toolPipeline: ToolProcessingPipeline;

  constructor(
    endpoint: EndpointType,
    hooksManager: IHookManager,
    snapshotService: LLMSwitchSnapshotService
  ) {
    // ... 现有初始化
    this.toolPipeline = new ToolProcessingPipeline(hooksManager, snapshotService);
  }

  protected async processEndpointSpecific(
    request: any,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // 1. 端点特定预处理
    let processedRequest = await this.preprocessRequest(request, context);

    // 2. 处理流式请求
    if (processedRequest.stream) {
      processedRequest = await this.processStreamingRequest(processedRequest, context);
    }

    // 3. 协议转换到OpenAI Chat
    const openaiChatRequest = await this.protocolConverter.convertToOpenAIChat(
      processedRequest,
      context.originalProtocol,
      context
    );

    // 4. 工具处理
    const toolProcessedRequest = await this.toolPipeline.processToolRequests(
      openaiChatRequest,
      context
    );

    return toolProcessedRequest;
  }
}
```

### 阶段6: 主LLMSwitch引擎集成 (Week 11-12)

#### 6.1 创建LLMSwitch引擎
```typescript
// 新文件：src/modules/pipeline/llmswitch/llmswitch-engine.ts
export class LLMSwitchEngine {
  private hooksManager: IHookManager;
  private snapshotService: LLMSwitchSnapshotService;
  private endpointRouter: EndpointRouter;
  private protocolConverter: UnifiedProtocolConverter;
  private toolPipeline: ToolProcessingPipeline;

  constructor(hooksSystem: any) {
    this.hooksManager = hooksSystem.hookManager;

    // 创建LLMSwitch专用快照服务
    this.snapshotService = new LLMSwitchSnapshotService({
      ...hooksSystem.snapshotService.config,
      endpointIsolation: {
        enabled: true,
        pathStructure: 'endpoint/request'
      },
      pathGeneration: {
        includeRequestId: true,
        includeStage: true,
        includeTimestamp: true
      }
    });

    this.endpointRouter = new EndpointRouter();
    this.protocolConverter = new UnifiedProtocolConverter(this.hooksManager, this.snapshotService);
    this.toolPipeline = new ToolProcessingPipeline(this.hooksManager, this.snapshotService);

    this.initializeEndpointHandlers();
  }

  async processRequest(
    request: any,
    endpoint?: EndpointType,
    context?: Partial<LLMSwitchHookContext>
  ): Promise<any> {
    // 自动检测端点
    const detectedEndpoint = endpoint || this.endpointRouter.detectEndpoint(request);

    const hookContext: LLMSwitchHookContext = {
      executionId: this.generateExecutionId(),
      stage: UnifiedHookStage.LLM_SWITCH_PROCESSING,
      startTime: Date.now(),
      requestId: context?.requestId,
      moduleId: 'llmswitch-core',
      endpoint: detectedEndpoint,
      originalProtocol: this.getProtocolForEndpoint(detectedEndpoint),
      targetProtocol: 'openai-chat',
      pathIdentifier: this.generatePathIdentifier(context?.requestId),
      metadata: context?.metadata
    };

    // 路由到对应的端点处理器
    const processedRequest = await this.endpointRouter.routeRequest(
      request,
      detectedEndpoint,
      hookContext
    );

    return processedRequest;
  }

  async processResponse(
    response: any,
    originalEndpoint: EndpointType,
    context: LLMSwitchHookContext
  ): Promise<any> {
    // Hook: response_processing_pre
    const preResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.RESPONSE_PROCESSING_PRE,
      'response',
      response,
      { ...context, stage: UnifiedHookStage.RESPONSE_PROCESSING_PRE }
    );

    let processedResponse = this.applyHookResults(response, preResults);

    // 工具结果处理
    processedResponse = await this.toolPipeline.processToolResults(processedResponse, context);

    // Hook: response_processing_post
    const postResults = await this.hooksManager.executeHooks(
      UnifiedHookStage.RESPONSE_PROCESSING_POST,
      'response',
      processedResponse,
      { ...context, stage: UnifiedHookStage.RESPONSE_PROCESSING_POST }
    );

    processedResponse = this.applyHookResults(processedResponse, postResults);

    // 协议转换回原始格式
    const finalResponse = await this.endpointRouter.routeResponse(
      processedResponse,
      originalEndpoint,
      context
    );

    return finalResponse;
  }

  private initializeEndpointHandlers(): void {
    // 注册端点处理器
    this.endpointRouter.registerHandler(
      'chat',
      new ChatEndpointHandler(this.hooksManager, this.snapshotService)
    );
    this.endpointRouter.registerHandler(
      'responses',
      new ResponsesEndpointHandler(this.hooksManager, this.snapshotService)
    );
    this.endpointRouter.registerHandler(
      'messages',
      new MessagesEndpointHandler(this.hooksManager, this.snapshotService)
    );
  }

  private generateExecutionId(): string {
    return `llmswitch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generatePathIdentifier(requestId?: string): string {
    return requestId || `llmswitch-${Date.now()}`;
  }

  private getProtocolForEndpoint(endpoint: EndpointType): string {
    const protocolMap = {
      chat: 'openai-chat',
      responses: 'openai-responses',
      messages: 'anthropic-messages'
    };
    return protocolMap[endpoint];
  }

  private applyHookResults(data: any, results: HookExecutionResult[]): any {
    return results.reduce((acc, result) => {
      if (result.success && result.data) {
        return result.data;
      }
      return acc;
    }, data);
  }
}
```

#### 6.2 更新主入口文件
```typescript
// 修改：sharedmodule/llmswitch-core/src/index.ts
export * from './conversion/index.js';
export * from './llmswitch/index.js';
export * from './tools/index.js';
export * from './guidance/index.js';

// 新增：LLMSwitch v2.0引擎
export { LLMSwitchEngine } from './llmswitch/llmswitch-engine.js';
export { EndpointRouter } from './llmswitch/endpoint/endpoint-router.js';
export { UnifiedProtocolConverter } from './llmswitch/protocol/unified-protocol-converter.js';

// 工厂函数
export function createLLMSwitchEngine(hooksSystem: any): LLMSwitchEngine {
  return new LLMSwitchEngine(hooksSystem);
}
```

## 🗂️ 新文件结构

```
sharedmodule/llmswitch-core/src/
├── llmswitch/                           # 新增：LLMSwitch v2.0核心
│   ├── llmswitch-engine.ts              # 主引擎
│   ├── endpoint/                        # 端点处理器
│   │   ├── base-endpoint-handler.ts
│   │   ├── chat-endpoint-handler.ts
│   │   ├── responses-endpoint-handler.ts
│   │   ├── messages-endpoint-handler.ts
│   │   └── endpoint-router.ts
│   ├── sse/                            # SSE处理
│   │   ├── sse-processor.ts
│   │   └── sse-event.ts
│   ├── protocol/                       # 协议转换
│   │   └── unified-protocol-converter.ts
│   ├── tools/                          # 工具处理
│   │   └── tool-processing-pipeline.ts
│   └── types.ts                        # LLMSwitch专用类型
├── conversion/                          # 保持现有：转换核心
├── hooks-integration/                   # 新增：Hooks集成
│   ├── llmswitch-hook-types.ts          # 扩展Hook类型
│   ├── llmswitch-snapshot-service.ts    # 扩展快照服务
│   └── hooks-adapter.ts                 # Hooks适配器
├── config/                             # 扩展：配置管理
│   └── llmswitch-v2-config.json         # v2.0配置
└── index.ts                            # 更新：主入口
```

## 📊 配置文件设计

### 新的LLMSwitch v2.0配置
```json
{
  "version": "2.0",
  "hooks": {
    "enabled": true,
    "stages": [
      "endpoint_processing_pre",
      "endpoint_processing_post",
      "sse_collecting_pre",
      "sse_collecting_post",
      "sse_accumulating_pre",
      "sse_accumulating_post",
      "protocol_conversion_pre",
      "protocol_conversion_post",
      "tool_processing_pre",
      "tool_processing_post",
      "response_processing_pre",
      "response_processing_post",
      "protocol_return_pre",
      "protocol_return_post"
    ],
    "snapshot": {
      "enabled": true,
      "basePath": "~/.routecodex/snapshots/llmswitch-core",
      "endpointIsolation": {
        "enabled": true,
        "pathStructure": "endpoint/request"
      },
      "pathGeneration": {
        "includeRequestId": true,
        "includeStage": true,
        "includeTimestamp": true
      },
      "format": "json",
      "compression": "gzip",
      "retention": {
        "maxFiles": 1000,
        "maxAge": 86400000
      }
    }
  },
  "endpoints": {
    "chat": {
      "protocol": "openai-chat",
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
      "protocol": "anthropic-messages",
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
      "timeout": 30000,
      "forceNonStreaming": true
    },
    "protocolConversion": {
      "autoDetect": true,
      "fallbackToOriginal": true
    }
  }
}
```

## 🎯 实施优先级和时间安排

### 高优先级 (Week 1-6)
1. **Week 1-2**: 扩展Hooks系统支持LLMSwitch
2. **Week 3-4**: 端点处理器架构
3. **Week 5-6**: SSE处理统一化

### 中优先级 (Week 7-10)
1. **Week 7-8**: 协议转换引擎
2. **Week 9-10**: 工具处理流水线

### 最终集成 (Week 11-12)
1. **Week 11-12**: 主LLMSwitch引擎集成

## ⚠️ 风险评估和缓解策略

### 技术风险
- **Hooks系统复杂性**: 新的Hook阶段可能影响现有系统
  - **缓解**: 保持向后兼容，新阶段独立于现有阶段
- **性能影响**: 多个Hook可能影响处理性能
  - **缓解**: Hook并行执行，性能监控和优化
- **端点隔离复杂性**: 确保端点间完全隔离
  - **缓解**: 严格的路径隔离，完整的测试覆盖

### 实施风险
- **向后兼容性**: 确保现有API不受影响
  - **缓解**: 渐进式迁移，保持现有接口
- **测试覆盖**: 新功能需要完整测试
  - **缓解**: 分阶段测试，集成测试验证

## 📋 验收标准

### 功能验收
- ✅ 三个端点独立处理且隔离
- ✅ 每个转换节点都有Hooks支持
- ✅ 快照系统按端点路径隔离
- ✅ 协议转换正确性验证
- ✅ 工具处理统一性验证
- ✅ SSE处理统一化验证

### 性能验收
- ✅ 处理延迟不超过现有系统的130%
- ✅ 内存使用不超过现有系统的160%
- ✅ 并发处理能力不降低
- ✅ Hook执行时间 < 10ms per hook

### 质量验收
- ✅ 代码覆盖率 > 90%
- ✅ 集成测试通过率 100%
- ✅ 端点隔离测试通过
- ✅ 快照路径隔离验证
- ✅ 文档完整性检查通过

---

## 🚀 下一步行动

**请您审批此详细改造计划。该计划基于现有的Hooks系统，最大化利用现有基础设施，同时满足您的所有需求。**

**计划亮点**:
- ✅ 完全基于现有Hooks系统，无需重新开发
- ✅ 保持向后兼容，渐进式迁移
- ✅ 支持端点隔离和路径分离
- ✅ 统一的SSE和工具处理
- ✅ 完整的快照系统改造

**确认后，我将开始实施第一阶段：扩展Hooks系统支持LLMSwitch专用阶段。** 🚀