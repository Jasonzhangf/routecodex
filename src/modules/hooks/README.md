# 独立Hooks模块架构设计

## 模块概述

独立Hooks模块是一个可重用的、模块化的Hook系统，旨在为RouteCodex系统中的所有模块提供统一的Hook功能。该模块采用依赖注入和注册模式，支持快照记录、性能监控和灵活的Hook生命周期管理。

**与Provider v2的关系**: 本模块作为平台级Hook系统，Provider v2通过适配器模式集成，实现统一的Hook抽象和执行引擎。

## 设计原则

1. **独立性**: Hook系统完全独立，不依赖特定业务模块
2. **可重用性**: 提供统一接口，可在任何模块中注入和使用
3. **模块化**: 清晰的模块边界和职责分离
4. **可扩展性**: 支持自定义Hook类型和处理器
5. **性能友好**: 最小化对主要业务流程的影响
6. **对齐现有系统**: 与Provider v2的BidirectionalHookManager统一，避免重复实现
7. **快速死亡原则**: 核心路径错误fail fast，非关键路径错误ignore_and_continue

## 架构设计

### 核心架构层次

```
独立Hooks模块
├── Core (核心层)
│   ├── Hook接口定义
│   ├── Hook生命周期管理
│   ├── Hook执行引擎
│   └── 依赖注入容器
├── Service (服务层)
│   ├── 快照服务 (Snapshot)
│   ├── 指标服务 (Metrics)
│   └── 注册服务 (Registry)
├── Provider Adapters (适配器层)
│   ├── Provider适配器
│   ├── Pipeline适配器
│   └── 其他模块适配器
├── Types (类型定义)
│   ├── Hook接口类型
│   ├── 数据类型
│   └── 配置类型
└── Utils (工具层)
    ├── 序列化工具
    ├── 文件操作工具
    └── 调试工具
```

## 目录结构

```
src/modules/hooks/
├── README.md                    # 本文档
├── package.json                 # 模块依赖配置
├── tsconfig.json               # TypeScript配置
├── .gitignore                  # Git忽略规则
│
├── core/                       # 核心层
│   ├── index.ts               # 核心模块导出
│   ├── hook-manager.ts        # Hook管理器
│   ├── hook-interfaces.ts     # Hook接口定义
│   ├── hook-executor.ts       # Hook执行引擎
│   ├── dependency-injection.ts # 依赖注入容器
│   └── lifecycle-manager.ts   # 生命周期管理
│
├── service/                    # 服务层
│   ├── index.ts               # 服务层导出
│   │
│   ├── snapshot/              # 快照服务
│   │   ├── index.ts          # 快照服务导出
│   │   ├── snapshot-service.ts # 快照服务核心
│   │   ├── file-storage.ts   # 文件存储实现
│   │   ├── formatters/       # 格式化器
│   │   │   ├── index.ts     # 格式化器导出
│   │   │   ├── json-formatter.ts # JSON格式化
│   │   │   ├── structured-formatter.ts # 结构化格式
│   │   │   └── compact-formatter.ts # 紧凑格式
│   │   └── compressors/      # 压缩器
│   │       ├── index.ts     # 压缩器导出
│   │       ├── gzip-compressor.ts # Gzip压缩
│   │       └── lz4-compressor.ts # LZ4压缩
│   │
│   ├── metrics/              # 指标服务
│   │   ├── index.ts         # 指标服务导出
│   │   ├── metrics-service.ts # 指标服务核心
│   │   ├── collectors/      # 指标收集器
│   │   │   ├── index.ts   # 收集器导出
│   │   │   ├── performance-collector.ts # 性能指标
│   │   │   ├── hook-usage-collector.ts # Hook使用指标
│   │   │   └── error-collector.ts # 错误指标
│   │   └── aggregators/     # 指标聚合器
│   │       ├── index.ts   # 聚合器导出
│   │       ├── time-aggregator.ts # 时间窗口聚合
│   │       └── count-aggregator.ts # 计数聚合
│   │
│   └── registry/            # 注册服务
│       ├── index.ts        # 注册服务导出
│       ├── hook-registry.ts # Hook注册中心
│       ├── module-registry.ts # 模块注册中心
│       └── config-registry.ts # 配置注册中心
│
├── provider-adapters/        # 适配器层
│   ├── index.ts            # 适配器层导出
│   ├── base-adapter.ts     # 基础适配器
│   ├── provider-adapter.ts # Provider模块适配器
│   ├── pipeline-adapter.ts # Pipeline模块适配器
│   └── adapter-factory.ts  # 适配器工厂
│
├── types/                  # 类型定义
│   ├── index.ts           # 类型导出
│   ├── hook-types.ts      # Hook相关类型
│   ├── data-types.ts      # 数据类型
│   ├── config-types.ts    # 配置类型
│   └── provider-types.ts  # Provider类型
│
├── utils/                  # 工具层
│   ├── index.ts           # 工具导出
│   ├── serialization.ts   # 序列化工具
│   ├── file-utils.ts      # 文件操作工具
│   ├── debug-utils.ts     # 调试工具
│   └── validation.ts      # 验证工具
│
└── examples/              # 示例代码
    ├── provider-example.ts # Provider模块示例
    ├── custom-hooks.ts    # 自定义Hook示例
    └── integration-example.ts # 集成示例
```

## 核心组件说明

### 1. Core层

#### HookManager
- 统一的Hook管理器，负责Hook的注册、执行和生命周期管理
- 支持同步和异步Hook执行
- 提供Hook执行上下文管理

#### HookInterfaces
- 定义所有Hook接口和基础类型
- 包含BidirectionalHook、HookExecutionContext等核心接口

#### HookExecutor
- Hook执行引擎，负责按优先级和类型执行Hook
- 支持条件执行和错误处理

#### DependencyInjection
- 依赖注入容器，管理Hook系统内部组件依赖
- 支持单例和瞬态生命周期

### 2. Service层

#### SnapshotService
- 负责Hook执行数据的快照记录和管理
- 支持多种存储格式和压缩策略
- 按模块和端点组织快照数据

#### MetricsService
- 收集和管理Hook系统的性能指标
- 支持实时监控和历史数据分析
- 提供指标聚合和查询功能

#### RegistryService
- Hook和模块的注册中心
- 管理Hook的元数据和配置信息
- 支持动态注册和注销

### 3. Provider Adapters层

#### ProviderAdapter
- 专门为Provider模块设计的适配器
- 简化Provider模块集成Hook系统的复杂度
- 提供Provider特定的Hook类型和配置

#### BaseAdapter
- 所有适配器的基础类
- 定义通用的适配器接口和实现模式

## 集成方式

### 1. 模块集成

```typescript
// 在Provider模块中的集成示例
import { HooksModule } from '../hooks';
import { ProviderAdapter } from '../hooks/provider-adapters';

class OpenAIStandardProvider {
  private hooksModule: HooksModule;
  private adapter: ProviderAdapter;

  constructor(config: ProviderConfig) {
    // 初始化Hook系统
    this.hooksModule = new HooksModule({
      moduleId: 'provider',
      snapshotEnabled: true,
      metricsEnabled: true
    });

    // 创建适配器
    this.adapter = new ProviderAdapter(this.hooksModule);

    // 注册Provider特定的Hook
    this.registerProviderHooks();
  }

  private registerProviderHooks(): void {
    this.adapter.registerHook({
      name: 'request-preprocessing',
      stage: 'REQUEST_PREPROCESSING',
      target: 'request',
      handler: this.requestPreprocessingHook.bind(this),
      priority: 100
    });
  }
}
```

### 2. 快照配置

```typescript
// 快照服务配置
const snapshotConfig = {
  enabled: true,
  basePath: '~/.routecodex/hooks-snapshots',
  format: 'structured',
  compression: 'gzip',
  retention: {
    maxFiles: 100,
    maxAge: '7d'
  },
  organization: {
    byModule: true,
    byEndpoint: true,
    byDate: true
  }
};
```

### 3. 指标监控

```typescript
// 指标服务配置
const metricsConfig = {
  enabled: true,
  collectionInterval: 5000, // 5秒
  metrics: [
    'hook_execution_time',
    'hook_success_rate',
    'hook_error_count',
    'snapshot_file_size'
  ],
  aggregation: {
    timeWindow: '1m',
    functions: ['avg', 'sum', 'count']
  }
};
```

## 与Provider v2 Hook的对齐关系

### 统一Hook抽象层
- **平台层统一**: `src/modules/hooks/core/*` 提供统一的Hook接口和执行引擎
- **Provider v2适配**: `src/modules/hooks/provider-adapters/provider-adapter.ts` 桥接现有接口
- **其它模块适配**: Pipeline/Compatibility/Server通过各自适配器集成

### 三层统一架构
```
平台统一层 (src/modules/hooks/core/*)
    ↓ HookManager, HookExecutor, HookRegistry
Provider v2适配层 (provider-adapter.ts)
    ↓ 阶段枚举映射, 上下文转换
其它模块适配层 (pipeline-adapter.ts, etc.)
    ↓ 模块特定Hook注册和配置
```

### HookStage映射
```
Provider v2 HookStage → 平台统一HookStage
REQUEST_PREPROCESSING → REQUEST_PREPROCESSING
AUTHENTICATION → AUTHENTICATION
HTTP_REQUEST → HTTP_REQUEST
HTTP_RESPONSE → HTTP_RESPONSE
RESPONSE_VALIDATION → RESPONSE_VALIDATION
RESPONSE_POSTPROCESSING → RESPONSE_POSTPROCESSING
ERROR_HANDLING → ERROR_HANDLING
```

### 调用链接入点
- **Provider v2 onInitialize/onCleanup** → HookSystem生命周期
- **各阶段Hook执行** → 与现有HookStage一一映射
- **BidirectionalHookManager** → 迁移为HookManager的轻薄包装，对外API不变，内部实现统一

### 快照命名规范与遮蔽清单

#### 快照文件命名规范
```
~/.routecodex/codex-samples/<module-scope>/<requestId>_<stage>.json
```

#### 模块作用域标准化
- `provider-v2`: Provider模块v2
- `pipeline-compat`: Pipeline兼容层
- `server-chat`: Chat端点处理器
- `server-responses`: Responses端点处理器
- `llmswitch-core`: LLM切换核心

#### 敏感字段遮蔽策略
```typescript
const sensitiveFields = {
  // 认证相关
  'authorization': { type: 'header', mask: true,保留长度: 8 },
  'apikey': { type: 'field', mask: true, 保留长度: 4 },
  'token': { type: 'field', mask: true, 保留长度: 6 },
  'cookie': { type: 'header', mask: true, 保留长度: 10 },

  // 用户数据
  'password': { type: 'field', mask: true, 保留长度: 0 },
  'secret': { type: 'field', mask: true, 保留长度: 0 },

  // 可配置遮蔽
  'custom_fields': [] // 用户可扩展
};
```

### 采样/节流/阈值配置示例

#### 采样策略配置
```typescript
const samplingConfig = {
  enabled: true,
  defaultStrategy: 'adaptive',
  strategies: {
    // 基于请求ID的采样
    requestId: {
      enabled: true,
      sampleRate: 0.1, // 10%
      hashBased: true
    },
    // 基于模块的采样
    moduleScope: {
      'provider-v2': { sampleRate: 0.2 }, // Provider模块20%采样
      'pipeline-compat': { sampleRate: 0.05 }, // Pipeline模块5%采样
      'server-chat': { sampleRate: 0.1 } // Chat端点10%采样
    },
    // 热点路由白名单
    hotRoutes: {
      enabled: true,
      routes: [
        { pattern: '/v1/chat/completions', sampleRate: 0.5 },
        { pattern: '/v1/responses', sampleRate: 0.3 }
      ]
    }
  }
};
```

#### 节流配置
```typescript
const throttlingConfig = {
  enabled: true,
  maxWritesPerSecond: 10,
  maxWritesPerRequest: 3,
  timeWindowMs: 1000,
  burstCapacity: 5
};
```

### 常见观察的例子

#### 请求结构摘要
```json
{
  "request_summary": {
    "model": "qwen2.5-7b-instruct",
    "message_count": 5,
    "tool_count": 2,
    "estimated_tokens": 1200,
    "has_streaming": true
  }
}
```

#### 认证头摘要
```json
{
  "auth_summary": {
    "type": "Bearer",
    "token_length": 128,
    "token_prefix": "sk-ant-"
  }
}
```

#### 响应choices摘要
```json
{
  "response_summary": {
    "choice_count": 1,
    "finish_reason": "tool_calls",
    "has_content": true,
    "tool_call_count": 2,
    "usage": {
      "prompt_tokens": 150,
      "completion_tokens": 80,
      "total_tokens": 230
    }
  }
}
```

#### tool_calls摘要
```json
{
  "tool_calls_summary": {
    "count": 2,
    "functions": ["getCurrentWeather", "searchDatabase"],
    "total_arguments_length": 256,
    "execution_time_ms": 1250
  }
}
```

## 快照文件组织

### 目录结构

```
~/.routecodex/hooks-snapshots/
├── provider/                    # Provider模块快照
│   ├── openai-chat/            # OpenAI Chat端点
│   │   ├── 2025-11-01/        # 按日期组织
│   │   │   ├── hooks-snapshot-001.json.gz
│   │   │   ├── hooks-snapshot-002.json.gz
│   │   │   └── metadata.json
│   │   └── 2025-11-02/
│   ├── openai-responses/       # OpenAI Responses端点
│   └── anthropic-messages/     # Anthropic Messages端点
├── pipeline/                   # Pipeline模块快照
│   ├── request-processing/
│   ├── response-processing/
│   └── error-handling/
└── global/                     # 全局Hook数据
    ├── system-metrics/
    ├── error-logs/
    └── performance-data/
```

### 快照文件格式

```json
{
  "metadata": {
    "moduleId": "provider",
    "endpoint": "openai-chat",
    "timestamp": "2025-11-01T10:30:00.000Z",
    "snapshotId": "snapshot-001",
    "format": "structured",
    "compression": "gzip"
  },
  "executionContext": {
    "requestId": "req_12345",
    "startTime": 1698821400000,
    "hookStages": ["REQUEST_PREPROCESSING", "AUTHENTICATION", "HTTP_REQUEST"]
  },
  "hooks": [
    {
      "name": "request-monitoring",
      "stage": "REQUEST_PREPROCESSING",
      "target": "request",
      "executionTime": 15,
      "status": "success",
      "data": {
        "input": {...},
        "output": {...},
        "changes": [...],
        "observations": [...],
        "metrics": {...}
      }
    }
  ],
  "summary": {
    "totalHooks": 5,
    "successfulHooks": 5,
    "failedHooks": 0,
    "totalExecutionTime": 125,
    "dataSize": 2048
  }
}
```

## 性能考虑

### 1. 异步执行
- 所有Hook操作都是异步的，不阻塞主业务流程
- 使用Promise.all并行执行独立的Hook

### 2. 内存管理
- 快照数据及时序列化到文件，避免内存积累
- 使用对象池减少GC压力

### 3. 配置优化
- 支持选择性启用Hook功能
- 可配置的Hook执行优先级和条件

### 4. 错误隔离
- Hook执行错误不影响主业务流程
- 提供错误恢复和重试机制

## 扩展性设计

### 1. 自定义Hook类型
```typescript
interface CustomHook extends BidirectionalHook {
  customProperty: string;
  customMethod(): void;
}
```

### 2. 插件系统
- 支持第三方Hook插件
- 提供标准的插件接口和生命周期

### 3. 配置热更新
- 支持运行时修改Hook配置
- 提供配置变更通知机制

## 最佳实践

1. **Hook命名**: 使用描述性的Hook名称，避免歧义
2. **错误处理**: 在Hook中实现适当的错误处理和日志记录
3. **性能监控**: 定期检查Hook执行性能，优化慢Hook
4. **测试覆盖**: 为所有Hook编写单元测试和集成测试
5. **文档维护**: 保持Hook文档的及时更新

## 版本规划

### v1.0 (当前版本)
- 基础Hook系统实现
- Provider模块集成
- 快照服务支持

### v1.1 (计划中)
- Pipeline模块集成
- 性能优化
- 更多Hook类型支持

### v2.0 (未来版本)
- 分布式Hook支持
- 可视化监控界面
- 高级分析功能