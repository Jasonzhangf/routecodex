# Pipeline Module Architecture

## 概述

RouteCodex Pipeline模块采用分层模块化架构，将复杂的请求处理流程分解为可组合的处理阶段。每个阶段都有明确的职责边界和标准化接口，支持灵活的配置和扩展。

## 核心设计理念

### 1. 分层处理
```
Request → LLMSwitch → Workflow → Compatibility → Provider → Response
           ↑            ↑            ↑           ↑
        协议转换     流式控制     字段适配    服务实现
```

### 2. 预创建流水线
- **初始化阶段**: 创建所有配置的流水线实例
- **路由阶段**: 根据provider.model组合选择流水线
- **处理阶段**: 直接使用选中的流水线处理请求

### 3. 配置驱动
- Provider配置中直接指定Compatibility规则
- 基于JSON配置的字段转换
- 统一的转换表格式和处理引擎

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Pipeline System                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ PipelineManager │  │PipelineRegistry │  │ PipelineConfig  │  │
│  │                 │  │                 │  │                 │  │
│  │  • 预创建流水线  │  │  • 模块注册      │  │  • 配置管理      │  │
│  │  • 流水线选择    │  │  • 实例查找      │  │  • 验证规则      │  │
│  │  • 生命周期管理  │  │  • 版本控制      │  │  • 热重载支持    │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │         │
│           └─────────────────────┼─────────────────────┘         │
│                                 │                               │
│           ┌─────────────────────────────────────────────────────────┐  │
│           │                   BasePipeline                          │  │
│           │                                                     │  │
│           │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────┐  │  │
│           │  │   LLMSwitch     │  │   Workflow      │  │Compat  │  │  │
│           │  │                 │  │                 │  │ibility │  │  │
│           │  │  • 协议转换      │  │  • 流式控制      │  │ • 字段  │  │  │
│           │  │  • 透传处理      │  │  • 缓冲管理      │  │ • 转换  │  │  │
│           │  │  • 路由逻辑      │  │  • 格式转换      │  │ • 适配  │  │  │
│           │  └─────────────────┘  └─────────────────┘  └─────────┘  │  │
│           │           │                     │           │         │  │
│           │           └─────────────────────┼───────────┘         │  │
│           │                                 │                     │  │
│           │  ┌─────────────────────────────────────────────────┐  │  │
│           │  │                  Provider                        │  │  │
│           │  │                                                 │  │  │
│           │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────┐ │  │  │
│           │  │  │   AuthManager  │  │  HTTPClient     │  │Error│ │  │  │
│           │  │  │                 │  │                 │  │Handler│ │  │  │
│           │  │  │  • 认证管理      │  │  • 请求处理      │  │ • 错误│ │  │  │
│           │  │  │  • Token刷新     │  │  • 连接池        │  │ • 恢复 │ │  │  │
│           │  │  │  • 凭据存储      │  │  • 超时控制      │  │ • 重试 │ │  │  │
│           │  │  └─────────────────┘  └─────────────────┘  └─────┘ │  │  │
│           │  │                                                 │  │  │
│           │  └─────────────────────────────────────────────────┘  │  │
│           │                                                     │  │
│           └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 模块层次详解

### 1. PipelineManager（流水线管理器）

**职责**:
- 系统初始化时预创建所有流水线
- 根据路由请求选择合适的流水线
- 管理流水线生命周期

**关键特性**:
```typescript
class PipelineManager {
  private pipelines: Map<string, BasePipeline> = new Map();

  async initialize(config: PipelineManagerConfig): Promise<void> {
    // 预创建所有流水线
  }

  selectPipeline(routeRequest: RouteRequest): BasePipeline {
    // 基于provider.model选择流水线
  }
}
```

### 2. BasePipeline（基础流水线）

**职责**:
- 定义统一的流水线处理接口
- 集成DebugCenter和ErrorHandling
- 协调各个处理模块

**处理流程**:
```typescript
class BasePipeline {
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    // 1. LLMSwitch: 协议转换
    // 2. Workflow: 流式控制
    // 3. Compatibility: 字段转换
    // 4. Provider: 服务处理
    // 5. 响应转换链
  }
}
```

### 3. LLMSwitch（协议转换层）

**职责**:
- 处理不同协议间的转换
- 目前专注OpenAI透传
- 支持未来扩展其他协议

**OpenAI透传实现**:
```typescript
class OpenAIPassthroughLLMSwitch {
  async transformRequest(request: any): Promise<any> {
    // 直接透传，添加元数据
    return { ...request, _metadata: { switchType: 'passthrough' } };
  }
}
```

### 4. Workflow（流式控制层）

**职责**:
- 处理流式/非流式转换
- 管理请求/响应缓冲
- 控制数据流格式

**流式转换逻辑**:
```typescript
class StreamingControlWorkflow {
  async processIncomingRequest(request: any): Promise<any> {
    if (request.stream === true) {
      // 流式请求转非流式
      return { ...request, stream: false, originalStream: true };
    }
    return request;
  }

  async processOutgoingResponse(response: any): Promise<any> {
    if (response.originalStream === true) {
      // 非流式响应转流式
      return this.convertToStreaming(response);
    }
    return response;
  }
}
```

### 5. Compatibility（字段适配层）

**职责**:
- 基于JSON配置的字段转换
- 工具调用格式适配
- 响应格式标准化

**配置驱动转换**:
```typescript
class FieldMappingCompatibility {
  async transformRequest(request: any, mappings: TransformationRule[]): Promise<any> {
    return this.applyFieldMapping(request, mappings);
  }
}
```

### 6. Provider（服务实现层）

**职责**:
- 具体的HTTP请求处理
- 认证管理（APIKey/OAuth）
- 错误处理和重试

**Provider实现**:
```typescript
class APIKeyProvider {
  async sendRequest(request: any): Promise<any> {
    // APIKey认证 + HTTP请求
  }
}

class OAuthProvider {
  async sendRequest(request: any): Promise<any> {
    // OAuth认证 + 自动刷新 + HTTP请求
  }
}
```

## 数据流架构

### 请求处理流程

```
1. 原始请求
   ↓
2. PipelineManager.selectPipeline()
   ↓
3. BasePipeline.processRequest()
   ↓
4. LLMSwitch.transformRequest() → 协议转换
   ↓
5. Workflow.processIncomingRequest() → 流式控制
   ↓
6. Compatibility.transformRequest() → 字段转换
   ↓
7. Provider.sendRequest() → 服务处理
   ↓
8. Compatibility.transformResponse() → 响应转换
   ↓
9. Workflow.processOutgoingResponse() → 流式响应
   ↓
10. LLMSwitch.transformResponse() → 协议转换
   ↓
11. 最终响应
```

### 配置驱动设计

**Provider配置结构**:
```json
{
  "id": "qwen-provider",
  "type": "qwen",
  "protocol": "openai",
  "compatibility": {
    "enabled": true,
    "requestMappings": [
      {
        "sourcePath": "model",
        "targetPath": "model",
        "transform": "mapping",
        "mapping": {
          "gpt-4": "qwen3-coder-plus"
        }
      }
    ],
    "responseMappings": [...],
    "toolAdaptation": true
  },
  "config": {
    "baseUrl": "https://portal.qwen.ai/v1",
    "auth": {
      "type": "apikey",
      "apiKey": "${QWEN_API_KEY}"
    }
  }
}
```

## 错误处理架构

### 错误处理流程

```
1. 模块错误捕获
   ↓
2. PipelineErrorIntegration.handleModuleError()
   ↓
3. 错误分类和上下文收集
   ↓
4. ErrorHandlingCenter.handleError()
   ↓
5. 错误恢复决策（重试/降级/失败）
   ↓
6. DebugCenter记录错误信息
   ↓
7. 返回错误响应
```

### 认证错误处理

**APIKey失效**:
```
1. 检测到401/403错误
   ↓
2. 直接标记认证失败
   ↓
3. 返回错误响应
```

**OAuth过期**:
```
1. 检测到token过期
   ↓
2. 自动刷新token
   ↓
3. 如果刷新失败，触发浏览器认证
   ↓
4. 认证成功后重试请求
```

## 调试支持架构

### 日志记录层次

```
1. request.original - 原始请求
2. llm-switch.transform - 协议转换后
3. workflow.incoming - 流式控制后
4. compatibility.request - 字段转换后
5. provider.request - 发送到Provider
6. provider.response - Provider响应
7. compatibility.response - 响应转换后
8. workflow.outgoing - 流式处理后
9. llm-switch.response - 协议转换后
10. response.final - 最终响应
```

### 调试信息结构

```typescript
interface DebugLogEntry {
  pipeline: string;           // 流水线ID
  stage: string;             // 处理阶段
  timestamp: string;         // 时间戳
  data: any;                 // 处理的数据
  metadata: {
    requestId: string;       // 请求ID
    duration: number;        // 处理耗时
    transformRules: string[]; // 应用的转换规则
    error?: string;          // 错误信息
  };
}
```

## 扩展点设计

### 1. 新LLMSwitch实现
```typescript
class CustomLLMSwitch implements LLMSwitchModule {
  async transformRequest(request: any): Promise<any> {
    // 自定义协议转换逻辑
  }
}
```

### 2. 新Provider实现
```typescript
class CustomProvider extends BaseProvider {
  async sendRequest(request: any): Promise<any> {
    // 自定义服务处理逻辑
  }
}
```

### 3. 新转换类型
```typescript
interface CustomTransformationRule extends TransformationRule {
  transform: 'custom';
  customFunction: (data: any) => Promise<any>;
}
```

## 性能考虑

### 1. 预创建优化
- 避免运行时创建开销
- 模块实例复用
- 配置预加载

### 2. 并行处理
- 支持多个请求并行处理
- 模块间异步处理
- 非阻塞IO操作

### 3. 内存管理
- 及时清理中间数据
- 对象池复用
- 垃圾回收优化

这个架构设计确保了Pipeline模块的可扩展性、可维护性和高性能，同时保持了配置驱动的灵活性。