# RouteCodex 调试可视化系统设计文档

## 1. 系统概述

### 1.1 设计目标
基于现有的RouteCodex基础设施，构建一个完整的调试和可视化系统，用于：
- 实时监控模块内部IO数据流
- 统一错误信息展示格式
- 提供Web界面可视化调试信息
- 支持渐进式模块增强

### 1.2 核心设计原则
- **最小侵入性**：利用现有DebugEventBus和ErrorHandlingCenter，不重建基础设施
- **适配器模式**：通过ModuleDebugAdapter扩展现有模块，避免直接修改
- **渐进式增强**：支持一个模块一个模块地逐步改造
- **标准化格式**：统一所有模块的调试信息格式
- **实时可视化**：通过WebSocket提供实时数据流展示

### 1.3 系统架构图
```
┌─────────────────────────────────────────────────────────────────┐
│                    RouteCodex 调试可视化系统                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐│
│  │   HttpServer    │    │  PipelineMgr    │    │   Other Modules  ││
│  │   (已集成)      │    │   (待增强)       │    │   (待增强)       ││
│  └─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘│
│            │                      │                      │       │
│            ▼                      ▼                      ▼       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐│
│  │ModuleDebugAdapter│    │ModuleDebugAdapter│    │ModuleDebugAdapter││
│  │   (已实现)       │    │   (待实现)       │    │   (待实现)       ││
│  └─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘│
│            │                      │                      │       │
│            └──────────┬───────────┘                      │       │
│                       │                                  │       │
│                       ▼                                  ▼       │
│            ┌─────────────────────────────────────────────────────┐│
│            │           DebugEventBus (现有)                     ││
│            └─────────────────────┬───────────────────────────────┘│
│                                  │                               │
│                                  ▼                               │
│            ┌─────────────────────────────────────────────────────┐│
│            │            DebugAPIExtension                         ││
│            │          (API端点 & WebSocket)                      ││
│            └─────────────────────┬───────────────────────────────┘│
│                                  │                               │
│                                  ▼                               │
│            ┌─────────────────────────────────────────────────────┐│
│            │              Web 可视化界面                          ││
│            │          (实时数据流 & 错误展示)                     ││
│            └─────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 技术架构设计

### 2.1 核心组件

#### 2.1.1 EnhancedDebugEvent（扩展事件类型）
```typescript
interface EnhancedDebugEvent extends DebugEvent {
  // 扩展字段
  moduleId: string;
  operationId: string;
  data: {
    // 输入输出数据
    input?: any;
    output?: any;
    // 错误信息
    error?: {
      message: string;
      stack?: string;
      context?: any;
    };
    // 性能指标
    performance?: {
      startTime: number;
      endTime: number;
      duration: number;
    };
    // 模块特定信息
    moduleSpecific?: any;
  };
}
```

#### 2.1.2 ModuleDebugAdapter（模块调试适配器）
```typescript
abstract class ModuleDebugAdapter {
  protected moduleId: string;
  protected debugEventBus: DebugEventBus;
  protected enabled: boolean;

  constructor(moduleId: string, enabled: boolean = true) {
    this.moduleId = moduleId;
    this.debugEventBus = DebugEventBus.getInstance();
    this.enabled = enabled;
  }

  // 核心方法
  abstract wrapModuleMethods(): void;
  abstract getModuleStatus(): ModuleStatus;

  // 统一事件发布
  protected publishEvent(operationId: string, type: 'start' | 'end' | 'error', data: any): void {
    if (!this.enabled) return;

    const event: EnhancedDebugEvent = {
      sessionId: generateSessionId(),
      moduleId: this.moduleId,
      operationId,
      timestamp: Date.now(),
      type,
      position: type === 'start' ? 'start' : type === 'end' ? 'end' : 'middle',
      data
    };

    this.debugEventBus.publish(event);
  }

  // 统一错误处理
  protected handleError(error: Error, operationId: string, context?: any): void {
    this.publishEvent(operationId, 'error', {
      error: {
        message: error.message,
        stack: error.stack,
        context
      }
    });
  }
}
```

#### 2.1.3 DebugAPIExtension（调试API扩展）
```typescript
class DebugAPIExtension {
  private app: Express;
  private debugEventBus: DebugEventBus;
  private wsServer: WebSocket.Server;
  private clients: Set<WebSocket> = new Set();

  constructor(app: Express, server: http.Server) {
    this.app = app;
    this.debugEventBus = DebugEventBus.getInstance();
    this.wsServer = new WebSocket.Server({ server });
    this.setupEventHandlers();
    this.setupAPIRoutes();
  }

  // 设置事件订阅
  private setupEventHandlers(): void {
    this.debugEventBus.subscribe((event: EnhancedDebugEvent) => {
      this.broadcastToClients(event);
    });
  }

  // WebSocket广播
  private broadcastToClients(event: EnhancedDebugEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // REST API端点
  private setupAPIRoutes(): void {
    // 获取模块状态
    this.app.get('/api/debug/modules', async (req, res) => {
      const modules = await this.getAllModuleStatuses();
      res.json(modules);
    });

    // 获取事件历史
    this.app.get('/api/debug/events', async (req, res) => {
      const { moduleId, startTime, endTime } = req.query;
      const events = await this.getEventHistory(moduleId as string, {
        startTime: startTime ? Number(startTime) : undefined,
        endTime: endTime ? Number(endTime) : undefined
      });
      res.json(events);
    });

    // 控制调试开关
    this.app.post('/api/debug/modules/:moduleId/enable', (req, res) => {
      const { moduleId } = req.params;
      this.setModuleDebugEnabled(moduleId, true);
      res.json({ success: true });
    });

    this.app.post('/api/debug/modules/:moduleId/disable', (req, res) => {
      const { moduleId } = req.params;
      this.setModuleDebugEnabled(moduleId, false);
      res.json({ success: true });
    });
  }
}
```

### 2.2 模块增强模式

#### 2.2.1 HttpServer增强示例
```typescript
class HttpServerDebugAdapter extends ModuleDebugAdapter {
  constructor(private httpServer: HttpServer) {
    super('http-server', true);
    this.wrapModuleMethods();
  }

  wrapModuleMethods(): void {
    const originalStart = this.httpServer.start.bind(this.httpServer);
    const originalHandleRequest = this.httpServer.handleRequest.bind(this.httpServer);

    // 包装start方法
    this.httpServer.start = async () => {
      this.publishEvent('server-start', 'start', { port: this.httpServer.port });

      try {
        const result = await originalStart();
        this.publishEvent('server-start', 'end', {
          success: true,
          port: this.httpServer.port
        });
        return result;
      } catch (error) {
        this.handleError(error, 'server-start');
        throw error;
      }
    };

    // 包装请求处理方法
    this.httpServer.handleRequest = async (req, res) => {
      const requestId = generateRequestId();
      this.publishEvent('request-start', 'start', {
        requestId,
        method: req.method,
        url: req.url,
        headers: req.headers
      });

      try {
        const startTime = Date.now();
        await originalHandleRequest(req, res);
        const duration = Date.now() - startTime;

        this.publishEvent('request-end', 'end', {
          requestId,
          duration,
          statusCode: res.statusCode
        });
      } catch (error) {
        this.handleError(error, 'request-handle', { requestId });
        throw error;
      }
    };
  }

  getModuleStatus(): ModuleStatus {
    return {
      moduleId: this.moduleId,
      enabled: this.enabled,
      isActive: this.httpServer.isRunning(),
      stats: {
        requestsHandled: this.httpServer.getStats().requestCount,
        averageResponseTime: this.httpServer.getStats().avgResponseTime
      }
    };
  }
}
```

#### 2.2.2 PipelineManager增强示例
```typescript
class PipelineManagerDebugAdapter extends ModuleDebugAdapter {
  constructor(private pipelineManager: PipelineManager) {
    super('pipeline-manager', true);
    this.wrapModuleMethods();
  }

  wrapModuleMethods(): void {
    const originalProcessRequest = this.pipelineManager.processRequest.bind(this.pipelineManager);
    const originalSelectPipeline = this.pipelineManager.selectPipeline.bind(this.pipelineManager);

    // 包装请求处理方法
    this.pipelineManager.processRequest = async (request: PipelineRequest) => {
      this.publishEvent('pipeline-request-start', 'start', {
        requestId: request.route.requestId,
        providerId: request.route.providerId,
        modelId: request.route.modelId
      });

      try {
        const startTime = Date.now();
        const response = await originalProcessRequest(request);
        const duration = Date.now() - startTime;

        this.publishEvent('pipeline-request-end', 'end', {
          requestId: request.route.requestId,
          duration,
          pipelineId: response.metadata.pipelineId,
          processingTime: response.metadata.processingTime
        });

        return response;
      } catch (error) {
        this.handleError(error, 'pipeline-request', {
          requestId: request.route.requestId
        });
        throw error;
      }
    };

    // 包装流水线选择方法
    this.pipelineManager.selectPipeline = (routeRequest: RouteRequest) => {
      this.publishEvent('pipeline-select', 'start', {
        providerId: routeRequest.providerId,
        modelId: routeRequest.modelId,
        requestId: routeRequest.requestId
      });

      try {
        const pipeline = originalSelectPipeline(routeRequest);
        this.publishEvent('pipeline-select', 'end', {
          pipelineId: pipeline.pipelineId,
          success: true
        });

        return pipeline;
      } catch (error) {
        this.handleError(error, 'pipeline-select', {
          providerId: routeRequest.providerId,
          modelId: routeRequest.modelId
        });
        throw error;
      }
    };
  }

  getModuleStatus(): ModuleStatus {
    return {
      moduleId: this.moduleId,
      enabled: this.enabled,
      isActive: this.pipelineManager.getStatus().isInitialized,
      stats: {
        pipelineCount: this.pipelineManager.getStatus().pipelineCount,
        requestsProcessed: this.pipelineManager.getStatus().statistics?.totalRequests || 0
      }
    };
  }
}
```

### 2.3 数据格式标准化

#### 2.3.1 统一事件格式
```typescript
interface StandardDebugEvent {
  // 基础信息
  sessionId: string;
  moduleId: string;
  operationId: string;
  timestamp: number;
  type: 'start' | 'end' | 'error' | 'data';
  position: 'start' | 'middle' | 'end';

  // 数据内容
  data: {
    // 输入输出数据
    input?: any;
    output?: any;

    // 错误信息（仅error类型）
    error?: {
      message: string;
      stack?: string;
      code?: string;
      context?: any;
    };

    // 性能指标
    performance?: {
      startTime: number;
      endTime: number;
      duration: number;
      memoryUsage?: NodeJS.MemoryUsage;
    };

    // 模块特定信息
    moduleSpecific?: any;

    // 请求追踪
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
  };
}
```

#### 2.3.2 模块状态格式
```typescript
interface ModuleStatus {
  moduleId: string;
  enabled: boolean;
  isActive: boolean;
  lastActivity: number;
  stats: {
    [key: string]: any;
  };
  health: 'healthy' | 'warning' | 'error';
  version?: string;
}
```

## 3. 实现计划

### 3.1 第一阶段：基础设施（1-2天）
**目标**：建立调试系统的基础设施

#### 3.1.1 核心接口和类型定义
- 创建 `src/types/debug-extensions.ts` - 扩展类型定义
- 创建 `src/utils/debug-constants.ts` - 调试常量
- 创建 `src/utils/session-utils.ts` - 会话和追踪工具

#### 3.1.2 基础适配器类
- 创建 `src/debug/module-debug-adapter.ts` - 基础适配器类
- 创建 `src/debug/debug-api-extension.ts` - API扩展类
- 创建 `src/debug/debug-websocket-server.ts` - WebSocket服务器

#### 3.1.3 工具函数
- 创建 `src/utils/event-formatters.ts` - 事件格式化工具
- 创建 `src/utils/performance-tracker.ts` - 性能追踪工具
- 创建 `src/utils/error-context-builder.ts` - 错误上下文构建工具

### 3.2 第二阶段：API和WebSocket（1-2天）
**目标**：实现API端点和WebSocket通信

#### 3.2.1 REST API端点
- 实现 `/api/debug/modules` - 获取模块状态
- 实现 `/api/debug/events` - 获取事件历史
- 实现 `/api/debug/modules/:moduleId/control` - 控制调试开关

#### 3.2.2 WebSocket服务
- 实现实时事件推送
- 实现客户端连接管理
- 实现消息广播机制

#### 3.2.3 事件存储
- 实现内存事件存储
- 实现事件查询接口
- 实现事件清理机制

### 3.3 第三阶段：HttpServer集成（1天）
**目标**：完成HttpServer的调试集成作为示例

#### 3.3.1 HttpServer适配器
- 创建 `src/debug/adapters/http-server-adapter.ts`
- 包装HttpServer的关键方法
- 实现请求级别的调试追踪

#### 3.3.2 集成到主应用
- 修改HttpServer类以支持调试适配器
- 添加调试模式配置开关
- 实现条件性调试功能

### 3.4 第四阶段：PipelineManager集成（1-2天）
**目标**：完成PipelineManager的调试集成

#### 3.4.1 PipelineManager适配器
- 创建 `src/debug/adapters/pipeline-manager-adapter.ts`
- 包装流水线处理方法
- 实现流水线级别的调试追踪

#### 3.4.2 模块级别集成
- 为每个流水线模块创建适配器
- 实现模块间的数据流追踪
- 集成错误处理和性能监控

### 3.5 第五阶段：Web界面（2-3天）
**目标**：创建可视化Web界面

#### 3.5.1 前端框架搭建
- 使用React或Vue.js搭建前端项目
- 集成WebSocket客户端
- 实现基础布局和导航

#### 3.5.2 核心组件
- 实时事件流组件
- 模块状态监控组件
- 错误展示组件
- 性能图表组件

#### 3.5.3 交互功能
- 事件过滤和搜索
- 时间轴展示
- 错误详情查看
- 调试开关控制

## 4. 技术实现细节

### 4.1 目录结构
```
src/
├── debug/
│   ├── module-debug-adapter.ts          # 基础适配器类
│   ├── debug-api-extension.ts           # API扩展
│   ├── debug-websocket-server.ts        # WebSocket服务器
│   └── adapters/                        # 具体模块适配器
│       ├── http-server-adapter.ts       # HttpServer适配器
│       ├── pipeline-manager-adapter.ts  # PipelineManager适配器
│       └── ...                          # 其他模块适配器
├── types/
│   ├── debug-extensions.ts              # 扩展类型定义
│   └── debug-events.ts                  # 调试事件类型
├── utils/
│   ├── debug-constants.ts               # 调试常量
│   ├── session-utils.ts                 # 会话工具
│   ├── event-formatters.ts              # 事件格式化
│   ├── performance-tracker.ts           # 性能追踪
│   └── error-context-builder.ts         # 错误上下文
└── web/
    ├── public/                           # 静态资源
    └── src/                             # 前端源码
        ├── components/                   # React组件
        ├── hooks/                        # 自定义hooks
        ├── utils/                        # 前端工具
        └── pages/                        # 页面组件
```

### 4.2 配置管理
```typescript
interface DebugConfig {
  // 全局开关
  enabled: boolean;

  // 模块级别配置
  modules: {
    [moduleId: string]: {
      enabled: boolean;
      level: 'basic' | 'detailed' | 'verbose';
      events: string[];
    };
  };

  // 事件存储配置
  storage: {
    type: 'memory' | 'file' | 'database';
    maxEvents: number;
    retentionPeriod: number; // 毫秒
  };

  // WebSocket配置
  websocket: {
    enabled: boolean;
    port: number;
    path: string;
  };

  // 性能追踪配置
  performance: {
    enabled: boolean;
    samplingRate: number;
    thresholds: {
      warning: number;
      error: number;
    };
  };
}
```

### 4.3 错误处理策略

#### 4.3.1 分层错误处理
1. **模块层**：捕获模块内部错误，发布到DebugEventBus
2. **适配器层**：包装模块方法，统一错误格式
3. **API层**：处理API调用错误，返回标准错误响应
4. **WebSocket层**：处理连接和消息错误，记录日志

#### 4.3.2 错误恢复机制
- 自动重连WebSocket连接
- 失败事件重试机制
- 降级模式（关闭调试功能）
- 内存泄漏防护

### 4.4 性能优化

#### 4.4.1 事件处理优化
- 事件批处理减少系统调用
- 惰性初始化调试组件
- 条件性事件发布（根据配置级别）
- 内存事件循环缓冲区

#### 4.4.2 内存管理
- 事件历史大小限制
- 定期清理过期事件
- 对象池模式减少GC压力
- 弱引用管理客户端连接

## 5. 测试策略

### 5.1 单元测试
- 测试适配器方法包装功能
- 测试事件发布和格式化
- 测试API端点响应
- 测试WebSocket消息处理

### 5.2 集成测试
- 测试完整的调试事件流
- 测试模块间数据追踪
- 测试错误处理链路
- 测试配置热更新

### 5.3 性能测试
- 高并发事件处理测试
- 长时间运行稳定性测试
- 内存泄漏检测
- WebSocket连接压力测试

## 6. 部署和运维

### 6.1 部署配置
```json
{
  "debug": {
    "enabled": true,
    "modules": {
      "http-server": {
        "enabled": true,
        "level": "detailed"
      },
      "pipeline-manager": {
        "enabled": true,
        "level": "verbose"
      }
    },
    "storage": {
      "type": "memory",
      "maxEvents": 10000,
      "retentionPeriod": 3600000
    },
    "websocket": {
      "enabled": true,
      "port": 8080
    }
  }
}
```

### 6.2 监控指标
- 事件处理速率
- WebSocket连接数
- 内存使用情况
- 错误率统计
- 响应时间分布

### 6.3 日志管理
- 调试事件日志
- 系统错误日志
- 性能指标日志
- 配置变更日志

## 7. 扩展性考虑

### 7.1 模块扩展
- 支持第三方模块适配器
- 插件式调试功能
- 自定义事件类型
- 模块特定数据格式

### 7.2 功能扩展
- 分布式追踪支持
- 性能分析工具
- 自动化测试集成
- 告警和通知系统

### 7.3 集成扩展
- 外部监控系统集成
- 日志聚合平台集成
- APM工具集成
- CI/CD流程集成

## 8. 风险评估和缓解

### 8.1 技术风险
- **内存泄漏**：通过事件大小限制和定期清理缓解
- **性能影响**：通过条件性调试和批处理缓解
- **系统复杂性**：通过模块化设计和清晰接口缓解

### 8.2 运维风险
- **配置错误**：通过配置验证和默认值缓解
- **依赖冲突**：通过版本锁定和兼容性测试缓解
- **监控盲点**：通过全面监控和告警缓解

## 9. 成功标准

### 9.1 功能标准
- ✅ 所有模块的IO数据流可监控
- ✅ 错误信息统一格式展示
- ✅ 实时Web界面可视化
- ✅ 渐进式模块增强支持

### 9.2 性能标准
- ✅ 调试功能关闭时零性能影响
- ✅ 调试功能开启时<5%性能开销
- ✅ 支持1000+并发WebSocket连接
- ✅ 事件处理延迟<10ms

### 9.3 可用性标准
- ✅ 99.9%系统可用性
- ✅ 1分钟内故障检测
- ✅ 5分钟内故障恢复
- ✅ 完整的监控和告警

## 10. 总结

本设计文档提供了一个完整的RouteCodex调试可视化系统方案，基于现有基础设施，采用最小侵入性的适配器模式，支持渐进式模块增强。系统将提供：

1. **统一的调试信息格式**：所有模块使用标准化的调试事件格式
2. **实时可视化界面**：通过WebSocket提供实时数据流展示
3. **渐进式增强**：可以一个模块一个模块地逐步集成
4. **最小性能影响**：通过条件性调试和优化设计降低性能开销
5. **高度可扩展**：支持第三方模块和自定义功能扩展

该方案将显著提升RouteCodex系统的可观测性和调试效率，为系统维护和问题排查提供强有力的工具支持。

---

**文档版本**：v1.0
**创建时间**：2025-01-17
**预计完成时间**：7-10天
**技术栈**：TypeScript, Express, WebSocket, React