# RCC Debug Center

独立的调试中心模块，提供统一的流水线记录和调试协调功能，完全独立于BaseModule运行。

## Features

- **独立运行**: 不依赖任何其他RCC模块，可独立使用
- **统一流水线记录**: 提供一致的流水线操作记录格式
- **事件驱动架构**: 通过 DebugEventBus 实现模块间的解耦通信
- **会话管理**: 完整的流水线会话生命周期管理
- **多种导出格式**: 支持 JSON、CSV、NDJSON 格式导出
- **实时统计**: 提供详细的操作统计和性能指标
- **文件持久化**: 自动保存调试记录到文件系统
- **类型安全**: 完整的 TypeScript 类型定义

## Installation

```bash
npm install rcc-debugcenter
```

## Quick Start

### 独立使用

```typescript
import { DebugCenter } from 'rcc-debugcenter';

// 创建调试中心实例
const debugCenter = new DebugCenter({
  enabled: true,
  baseDirectory: '~/.rcc/debug',
  enableFileLogging: true
});

// 启动流水线会话
const sessionId = debugCenter.startPipelineSession(
  'my-pipeline',
  'My Pipeline',
  { version: '1.0.0' }
);

// 记录操作
debugCenter.recordOperation(
  sessionId,
  'data-processor',
  'process-data',
  { input: 'raw data' },
  { output: 'processed data' },
  'processMethod',
  true
);

// 结束会话
debugCenter.endPipelineSession(sessionId, true);

// 导出数据
const exportData = debugCenter.exportData({
  format: 'json',
  includeStats: true
});
console.log(exportData);
```

### 与BaseModule集成使用

```typescript
import { BaseModule } from 'rcc-basemodule';
import { DebugCenter, DebugEventBus } from 'rcc-debugcenter';

class MyModule extends BaseModule {
  constructor() {
    super({
      id: 'my-module',
      name: 'My Module',
      version: '1.0.0'
    });
  }

  async processData(data: any) {
    // 创建调试中心实例
    const debugCenter = new DebugCenter({
      enabled: true,
      baseDirectory: '~/.rcc/debug'
    });

    // 启动会话
    const sessionId = debugCenter.startPipelineSession('data-processing', 'Data Processing');

    // 设置外部调试处理器以接收BaseModule的调试事件
    this.setExternalDebugHandler((event) => {
      debugCenter.recordOperation(
        event.sessionId || sessionId,
        event.moduleId,
        event.operationId,
        event.data.input,
        event.data.output,
        event.data.method,
        event.type !== 'error'
      );
    });

    // 开始I/O跟踪
    this.startIOTracking('process-data', data, 'processData');

    try {
      const result = await this.actualProcessing(data);
      this.endIOTracking('process-data', result, true);
      return result;
    } catch (error) {
      this.endIOTracking('process-data', null, false, error.message);
      throw error;
    } finally {
      // 结束会话
      debugCenter.endPipelineSession(sessionId, true);
    }
  }
}
```

## API Reference

### DebugCenter

主要的调试中心类，用于管理调试操作和流水线记录。

#### Constructor

```typescript
constructor(config?: Partial<DebugCenterConfig>)
```

#### Methods

- `startPipelineSession(pipelineId, pipelineName?, metadata?)`: 启动新的流水线会话
- `endPipelineSession(sessionId, success?, error?)`: 结束流水线会话
- `recordOperation(sessionId, moduleId, operationId, input, output, method?, success?, error?, position?, context?)`: 记录模块操作
- `recordPipelineStart(sessionId, pipelineId, pipelineName?, input?, context?)`: 记录流水线启动
- `recordPipelineEnd(sessionId, pipelineId, pipelineName?, output?, success?, error?, context?)`: 记录流水线结束
- `getPipelineEntries(options?)`: 获取流水线记录，支持可选过滤
- `getActiveSession(sessionId)`: 根据ID获取活跃会话
- `getActiveSessions()`: 获取所有活跃会话
- `exportData(options)`: 以多种格式导出流水线数据
- `getStats()`: 获取记录统计信息
- `subscribe(eventType, callback)`: 订阅调试中心事件
- `updateConfig(updates)`: 更新配置
- `clear()`: 清除所有数据

### DebugEventBus

用于跨模块调试通信的事件总线。

#### Methods

- `publish(event)`: 发布调试事件
- `subscribe(eventType, callback)`: 订阅事件
- `unsubscribe(eventType, callback)`: 取消订阅事件
- `getRecentEvents(limit?, type?)`: 获取最近的事件
- `clear()`: 清除事件队列

## Configuration

```typescript
interface DebugCenterConfig {
  enabled: boolean;
  level: DebugLevel;
  recordStack: boolean;
  maxLogEntries: number;
  consoleOutput: boolean;
  trackDataFlow: boolean;
  enableFileLogging: boolean;
  maxFileSize: number;
  maxLogFiles: number;
  baseDirectory: string;
  pipelineIO: {
    enabled: boolean;
    autoRecordPipelineStart: boolean;
    autoRecordPipelineEnd: boolean;
    pipelineSessionFileName: string;
    pipelineDirectory: string;
    recordAllOperations: boolean;
    includeModuleContext: boolean;
    includeTimestamp: boolean;
    includeDuration: boolean;
    maxPipelineOperationsPerFile: number;
  };
  eventBus: {
    enabled: boolean;
    maxSubscribers: number;
    eventQueueSize: number;
  };
}
```

## 独立架构

DebugCenter采用完全独立的架构设计：

### 核心原则

1. **无外部依赖**: 除了Node.js核心模块和uuid包，不依赖任何其他RCC模块
2. **自包含**: 所有功能都在模块内部实现，包括事件总线、会话管理、文件存储等
3. **标准接口**: 提供清晰的API接口，便于集成到各种应用中
4. **类型安全**: 完整的TypeScript类型定义，确保类型安全

### 架构组件

```
DebugCenter
├── DebugEventBus          # 内部事件总线
├── SessionManager         # 会话管理
├── OperationRecorder      # 操作记录器
├── DataExporter          # 数据导出器
└── FileSystemManager     # 文件系统管理
```

### 与BaseModule的集成方式

通过标准的调试事件接口进行松耦合集成：

```typescript
// BaseModule端
baseModule.setExternalDebugHandler((event) => {
  // 将调试事件发送到DebugCenter
  debugCenter.processDebugEvent(event);
});

// DebugCenter端
debugCenter.processDebugEvent(event);
```

## Events

DebugCenter会发出以下事件：

- `pipelineEntry`: 当记录新的流水线条目时
- `sessionStart`: 当流水线会话启动时
- `sessionEnd`: 当流水线会话结束时
- `operationRecorded`: 当记录操作时

## 最佳实践

### 1. 独立使用场景

当需要简单的调试记录功能时，可以直接使用DebugCenter：

```typescript
import { DebugCenter } from 'rcc-debugcenter';

const debugCenter = new DebugCenter({
  enabled: true,
  baseDirectory: './debug-logs'
});

// 简单记录
debugCenter.recordOperation(
  'session-1',
  'my-module',
  'test-operation',
  { input: 'test' },
  { output: 'result' }
);
```

### 2. 与BaseModule集成

当需要在RCC生态系统中使用时，通过事件处理器集成：

```typescript
import { BaseModule } from 'rcc-basemodule';
import { DebugCenter } from 'rcc-debugcenter';

const debugCenter = new DebugCenter();
const baseModule = new BaseModule({ id: 'test', name: 'Test' });

// 连接BaseModule到DebugCenter
baseModule.setExternalDebugHandler((event) => {
  debugCenter.processDebugEvent(event);
});
```

### 3. 配置管理

建议使用环境变量或配置文件管理DebugCenter配置：

```typescript
const config = {
  enabled: process.env.DEBUG_ENABLED === 'true',
  baseDirectory: process.env.DEBUG_DIR || './debug',
  enableFileLogging: process.env.DEBUG_FILE_LOGGING !== 'false'
};

const debugCenter = new DebugCenter(config);
```

## 性能考虑

- **内存使用**: DebugCenter使用内存缓存活跃会话，建议定期清理旧会话
- **文件存储**: 启用文件日志时，注意监控磁盘使用情况
- **事件队列**: 事件队列有最大大小限制，超出后会丢弃最旧的事件

## License

MIT