# SSE双向转换模块架构设计

## 🏛️ 统一抽象与分层架构

SSE双向转换模块采用分层架构设计，将Chat和Responses协议统一到相同的抽象框架下，实现协议无关的转换逻辑。

### 架构层次

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层 (Application Layer)                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Chat API      │  │ Responses API   │  │  Protocol    │ │
│  │   Interface     │  │   Interface     │  │  Bridge      │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                协议适配层 (Protocol Adapter Layer)          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Chat Protocol   │  │ Responses       │  │  Event       │ │
│  │ Adapter         │  │ Protocol        │  │  Serializer  │ │
│  │                 │  │ Adapter         │  │              │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                对象事件层 (Object Event Layer)              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Chat Events     │  │ Responses       │  │  Universal   │ │
│  │ (ChatSseEvent)  │  │ Events          │  │  Event Base  │ │
│  │                 │  │ (ResponsesSse   │  │              │ │
│  │                 │  │ Event)          │  │              │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│              Wire序列化层 (Wire Serialization Layer)        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ SSE Wire Format │  │ SSE Wire Format │  │  Format      │ │
│  │ (Chat)          │  │ (Responses)     │  │  Validator   │ │
│  │                 │  │                 │  │              │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 核心接口设计

### 1. 转换引擎接口

#### JsonToSseEngine
```typescript
interface JsonToSseEngine<TInput, TEvent, TOptions> {
  convertToJsonToSse(
    input: TInput,
    options: TOptions
  ): Promise<Readable<TEvent>>;

  // 转换统计和监控
  getStats?(): ConversionStats;
  resetStats?(): void;
}
```

#### SseToJsonEngine
```typescript
interface SseToJsonEngine<TEvent, TOutput, TOptions> {
  convertSseToJson(
    sseStream: Readable<TEvent>,
    options: TOptions
  ): Promise<TOutput>;

  // 聚合器控制
  pauseAggregation?(): void;
  resumeAggregation?(): void;
  getAggregationState?(): AggregationState;
}
```

### 2. 事件序列化接口

#### EventSerializer
```typescript
interface EventSerializer<TEvent> {
  serializeToWire(event: TEvent): string;
  deserializeFromWire(wireData: string): TEvent;
  validateWireFormat(wireData: string): boolean;
}
```

#### 协议特定序列化器
```typescript
// Chat协议序列化器
interface ChatEventSerializer extends EventSerializer<ChatSseEvent> {
  serializeChatEvent(event: ChatSseEvent): string;
}

// Responses协议序列化器
interface ResponsesEventSerializer extends EventSerializer<ResponsesSseEvent> {
  serializeResponsesEvent(event: ResponsesSseEvent): string;
}
```

### 3. 协议适配器接口

#### ProtocolAdapter
```typescript
interface ProtocolAdapter<TInput, TOutput> {
  canAdapt(input: unknown): input is TInput;
  adapt(input: TInput): TOutput;
  getProtocolInfo(): ProtocolInfo;
}

interface ProtocolInfo {
  name: string;
  version: string;
  supportedEventTypes: string[];
  capabilities: ProtocolCapabilities;
}
```

## 🏢 注册中心设计

### Registry模式
```typescript
class ConversionRegistry {
  private jsonToSseEngines = new Map<string, JsonToSseEngine<any, any, any>>();
  private sseToJsonEngines = new Map<string, SseToJsonEngine<any, any, any>>();
  private serializers = new Map<string, EventSerializer<any>>();
  private adapters = new Map<string, ProtocolAdapter<any, any>>();

  // 注册引擎
  registerJsonToSseEngine<T>(protocol: string, engine: JsonToSseEngine<T, any, any>): void;
  registerSseToJsonEngine<T>(protocol: string, engine: SseToJsonEngine<any, T, any>): void;

  // 注册序列化器
  registerSerializer<T>(protocol: string, serializer: EventSerializer<T>): void;

  // 注册适配器
  registerAdapter<TInput, TOutput>(protocol: string, adapter: ProtocolAdapter<TInput, TOutput>): void;

  // 获取转换器
  getJsonToSseEngine<T>(protocol: string): JsonToSseEngine<T, any, any> | undefined;
  getSseToJsonEngine<T>(protocol: string): SseToJsonEngine<any, T, any> | undefined;

  // 自动协议检测
  detectProtocol(input: unknown): string | null;
}
```

## 📋 核心设计约束

### 1. Conversion节点职责约束
- ✅ **仅做形状映射**: Conversion节点只负责数据格式转换，不处理业务逻辑
- ✅ **协议无关**: 核心转换逻辑与具体协议解耦
- ✅ **状态无关**: 每次转换都是独立的，不依赖全局状态
- ❌ **工具治理**: 工具调用处理只能在Process节点完成

### 2. 事件粒度与时序约束
- ✅ **最小增量**: 事件分片粒度可配置，支持细粒度传输
- ✅ **时序保证**: 严格按照事件的时间顺序处理
- ✅ **工具调用序列**:
  - Chat: `name → arguments.delta* → finish_reason`
  - Responses: `required_action → submit_tool_outputs → completed`
- ✅ **心跳机制**: 可配置的心跳事件，维持连接活跃

### 3. 错误处理约束
- ✅ **统一错误格式**: 所有错误都转换为标准错误格式
- ✅ **错误传播**: 错误信息在转换链中完整传播
- ✅ **恢复机制**: 支持从中断状态恢复
- ❌ **静默失败**: 禁止静默吞没错误

## 🎯 设计模式应用

### 1. 策略模式 (Strategy Pattern)
```typescript
class ConversionStrategy {
  constructor(private strategy: ConversionAlgorithm) {}

  convert(input: any, options: any): any {
    return this.strategy.execute(input, options);
  }
}

// 不同协议的转换策略
class ChatConversionStrategy implements ConversionAlgorithm { }
class ResponsesConversionStrategy implements ConversionAlgorithm { }
```

### 2. 工厂模式 (Factory Pattern)
```typescript
class ConverterFactory {
  static createJsonToSseConverter(protocol: string): JsonToSseEngine {
    switch (protocol) {
      case 'chat':
        return new ChatJsonToSseConverter();
      case 'responses':
        return new ResponsesJsonToSseConverter();
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}
```

### 3. 观察者模式 (Observer Pattern)
```typescript
interface ConversionObserver {
  onEvent(event: ConversionEvent): void;
  onError(error: ConversionError): void;
  onComplete(stats: ConversionStats): void;
}

class ConversionObservable {
  private observers: ConversionObserver[] = [];

  addObserver(observer: ConversionObserver): void;
  removeObserver(observer: ConversionObserver): void;
  notifyObservers(event: ConversionEvent): void;
}
```

### 4. 责任链模式 (Chain of Responsibility)
```typescript
abstract class ConversionHandler {
  protected nextHandler?: ConversionHandler;

  setNext(handler: ConversionHandler): ConversionHandler {
    this.nextHandler = handler;
    return handler;
  }

  handle(request: ConversionRequest): ConversionResponse {
    if (this.canHandle(request)) {
      return this.doHandle(request);
    } else if (this.nextHandler) {
      return this.nextHandler.handle(request);
    }
    throw new Error('No handler found');
  }

  protected abstract canHandle(request: ConversionRequest): boolean;
  protected abstract doHandle(request: ConversionRequest): ConversionResponse;
}
```

## 🔄 数据流设计

### 转换流程
```
Input JSON
    │
    ▼
┌─────────────────┐    ┌─────────────────┐
│  Protocol       │───▶│  Object Event    │
│  Detection      │    │  Generation      │
└─────────────────┘    └─────────────────┘
    │                        │
    ▼                        ▼
┌─────────────────┐    ┌─────────────────┐
│  Protocol       │    │  Event           │
│  Adaptation      │    │  Serialization  │
└─────────────────┘    └─────────────────┘
    │                        │
    ▼                        ▼
┌─────────────────┐    ┌─────────────────┐
│  Format         │    │  SSE Wire        │
│  Validation     │    │  Stream          │
└─────────────────┘    └─────────────────┘
                              │
                              ▼
                        SSE Stream Output
```

### 回环测试流程
```
Original JSON
    │
    ▼
JSON → SSE Conversion
    │
    ▼
SSE → JSON Conversion
    │
    ▼
Reconstructed JSON
    │
    ▼
Equality Validation
```

## 📊 性能与可扩展性设计

### 1. 内存管理
- **流式处理**: 避免大对象在内存中累积
- **窗口化聚合**: 定期清理已处理的聚合数据
- **对象池**: 重用事件对象，减少GC压力

### 2. 并发处理
- **独立转换器**: 每个转换器实例独立运行
- **背压控制**: 根据下游处理能力调节上游速度
- **资源限制**: 限制并发转换数量，防止资源耗尽

### 3. 可扩展性
- **插件机制**: 支持动态加载新的协议适配器
- **配置驱动**: 通过配置文件控制转换行为
- **版本兼容**: 支持多版本协议共存

## 🛡️ 安全与可靠性

### 1. 输入验证
- **Schema验证**: 严格验证输入数据格式
- **类型安全**: 完整的TypeScript类型检查
- **边界检查**: 防止数组越界和空指针访问

### 2. 错误隔离
- **异常边界**: 捕获并处理所有异常
- **状态保护**: 确保异常不会破坏内部状态
- **优雅降级**: 在部分功能失败时提供基本服务

### 3. 监控与诊断
- **详细日志**: 记录转换过程中的关键信息
- **性能指标**: 监控转换延迟和吞吐量
- **健康检查**: 定期检查系统健康状态

## 🔧 与V2系统的关系

### 集成策略
- **Feature Flag**: 通过配置开关控制新旧实现
- **渐进迁移**: 逐步替换V2实现，保证平滑过渡
- **行为对齐**: 确保新实现与V2行为完全一致

### 兼容性保证
- **接口兼容**: 保持现有API接口不变
- **数据兼容**: 支持V2格式的输入输出数据
- **行为兼容**: 处理逻辑与V2保持一致

### 迁移路径
1. **并行运行**: 新旧系统并行运行一段时间
2. **灰度发布**: 逐步将流量切换到新系统
3. **全量切换**: 完全切换到新系统，保留V2作为备份
4. **清理阶段**: 移除V2相关代码和配置

---

**总结**: 本架构设计通过统一的抽象框架和分层结构，实现了Chat和Responses协议的高效转换，同时保证了系统的可扩展性、可维护性和可靠性。所有设计都遵循"conversion只做形状映射，工具治理只在process"的核心约束。