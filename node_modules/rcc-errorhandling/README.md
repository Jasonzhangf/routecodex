# RCC ErrorHandling Center

[![npm version](https://badge.fury.io/js/rcc-errorhandling.svg)](https://badge.fury.io/js/rcc-errorhandling)
[![npm](https://img.shields.io/npm/v/rcc-errorhandling.svg)](https://www.npmjs.com/package/rcc-errorhandling)
[![Build Status](https://github.com/rcc/rcc-errorhandling/actions/workflows/build.yml/badge.svg)](https://github.com/rcc/rcc-errorhandling/actions/workflows/build.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A comprehensive error handling and response management system for RCC modular applications.

## Features

- **Centralized Error Management**: Single entry point for all error handling operations
- **Modular Architecture**: Clean separation of concerns with specialized components
- **Asynchronous Processing**: Support for both blocking and non-blocking error handling
- **Priority-based Queue**: Intelligent error queuing with priority management
- **Flexible Routing**: Configurable error routing based on type, severity, and custom rules
- **Template System**: Standardized response templates with dynamic content support
- **Policy Engine**: Configurable retry, fallback, and recovery strategies
- **Module Registry**: Dynamic module registration and lifecycle management

## 项目架构

### 文件结构详解

```
rcc-errorhandling/
├── src/                          # 源代码目录
│   ├── components/               # 核心组件实现
│   │   ├── ErrorInterfaceGateway.ts     # 错误接口网关 - 主要入口点
│   │   ├── ErrorQueueManager.ts         # 错误队列管理器 - 优先级队列处理
│   │   ├── ResponseRouterEngine.ts      # 响应路由引擎 - 错误路由分发
│   │   ├── ErrorClassifier.ts           # 错误分类器 - 错误类型和严重性分类
│   │   ├── ResponseExecutor.ts           # 响应执行器 - 错误响应执行
│   │   ├── ResponseTemplateManager.ts    # 响应模板管理器 - 模板系统管理
│   │   ├── ModuleRegistryManager.ts      # 模块注册管理器 - 模块生命周期管理
│   │   └── PolicyEngine.ts              # 策略引擎 - 错误处理策略
│   ├── types/                     # 类型定义
│   │   └── index.ts                 # 完整类型定义系统
│   └── index.ts                    # 模块导出入口
├── dist/                         # 构建输出目录
├── __test__/                     # 测试目录
├── package.json                  # 项目配置
├── tsconfig.json                 # TypeScript配置
└── README.md                     # 项目文档
```

### 核心架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层 (Applications)                     │
├─────────────────────────────────────────────────────────────┤
│                 错误接口层 (Error Interface)                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           ErrorInterfaceGateway                        │ │
│  │  • handleError()     • handleErrorAsync()             │ │
│  │  • handleBatchErrors() • registerModule()              │ │
│  └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                 处理层 (Processing)                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ErrorQueueManager│  │ResponseRouter   │  │ErrorClassifier│ │
│  │                 │  │Engine           │  │             │ │
│  │ • 优先级队列     │  │ • 智能路由       │  │ • 错误分类   │ │
│  │ • 批量处理       │  │ • 条件匹配       │  │ • 严重性判定 │ │
│  │ • 异步处理       │  │ • 模块分发       │  │ • 影响评估   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                 执行层 (Execution)                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ResponseExecutor│  │TemplateManager  │  │PolicyEngine │ │
│  │                 │  │                 │  │             │ │
│  │ • 响应执行       │  │ • 模板管理       │  │ • 重试策略   │ │
│  │ • 动作执行       │  │ • 动态加载       │  │ • 熔断机制   │ │
│  │ • 结果收集       │  │ • 模块定制       │  │ • 恢复策略   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                 管理层 (Management)                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              ModuleRegistryManager                        │ │
│  │  • 模块注册  • 生命周期管理  • 能力管理  • 配置管理     │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件详解

#### 1. ErrorInterfaceGateway (错误接口网关)
- **职责**: 系统的主要入口点，处理所有错误处理请求
- **功能**:
  - 同步和异步错误处理
  - 批量错误处理
  - 模块注册管理
  - 系统生命周期管理

#### 2. ErrorQueueManager (错误队列管理器)
- **职责**: 管理错误队列和优先级处理
- **功能**:
  - 优先级队列管理
  - 批量处理优化
  - 异步处理支持
  - 队列状态监控

#### 3. ResponseRouterEngine (响应路由引擎)
- **职责**: 将错误路由到合适的处理器
- **功能**:
  - 智能路由分发
  - 条件匹配算法
  - 模块能力匹配
  - 负载均衡

#### 4. ErrorClassifier (错误分类器)
- **职责**: 对错误进行分类和严重性评估
- **功能**:
  - 错误类型分类
  - 严重性判定
  - 影响范围评估
  - 可恢复性分析

#### 5. ResponseExecutor (响应执行器)
- **职责**: 执行错误响应动作
- **功能**:
  - 响应执行引擎
  - 动作执行跟踪
  - 结果收集整理
  - 执行状态管理

#### 6. ResponseTemplateManager (响应模板管理器)
- **职责**: 管理标准化响应模板
- **功能**:
  - 默认模板管理
  - 模块定制模板
  - 动态模板加载
  - 模板缓存优化

#### 7. ModuleRegistryManager (模块注册管理器)
- **职责**: 管理模块注册和生命周期
- **功能**:
  - 模块注册管理
  - 生命周期控制
  - 能力管理
  - 配置管理

#### 8. PolicyEngine (策略引擎)
- **职责**: 执行错误处理策略
- **功能**:
  - 重试策略管理
  - 熔断机制
  - 恢复策略
  - 策略优化

## Components

### Core Components

- **ErrorInterfaceGateway**: Main entry point for external error requests
- **ErrorQueueManager**: Manages error queue and priority processing
- **ResponseRouterEngine**: Routes errors to appropriate handlers
- **ErrorClassifier**: Classifies errors by type and severity
- **ResponseExecutor**: Executes error response actions
- **ResponseTemplateManager**: Manages response templates
- **ModuleRegistryManager**: Manages module registration
- **PolicyEngine**: Enforces error handling policies

## Installation

```bash
npm install rcc-errorhandling
```

## Usage

### Basic Usage

```typescript
import { ErrorInterfaceGateway, ErrorQueueManager, ResponseRouterEngine } from 'rcc-errorhandling';

// Initialize components
const queueManager = new ErrorQueueManager();
const routerEngine = new ResponseRouterEngine();
const errorGateway = new ErrorInterfaceGateway(queueManager, routerEngine);

// Initialize the system
await errorGateway.initialize();

// Handle an error
const errorContext = {
  errorId: 'error-123',
  error: new Error('Something went wrong'),
  timestamp: new Date(),
  source: {
    moduleId: 'my-module',
    moduleName: 'MyModule',
    version: '1.0.0'
  },
  classification: {
    source: 'module' as any,
    type: 'technical' as any,
    severity: 'medium' as any,
    impact: 'single_module' as any,
    recoverability: 'recoverable' as any
  },
  data: {},
  config: {}
};

// Blocking error handling
const response = await errorGateway.handleError(errorContext);

// Non-blocking error handling
errorGateway.handleErrorAsync(errorContext);
```

### Module Registration

```typescript
import { ModuleRegistration } from 'rcc-errorhandling';

const moduleRegistration: ModuleRegistration = {
  moduleId: 'my-module',
  moduleName: 'MyModule',
  moduleType: 'business',
  version: '1.0.0',
  config: {
    enableLogging: true,
    enableMetrics: true
  },
  capabilities: ['error-handling', 'business-logic'],
  responseHandler: {
    handleId: 'my-module-handler',
    name: 'MyModule Handler',
    priority: 100,
    isEnabled: true,
    conditions: [],
    execute: async (error) => {
      // Custom error handling logic
      return {
        responseId: `response_${error.errorId}`,
        errorId: error.errorId,
        result: {
          status: 'success' as any,
          message: 'Error handled by MyModule',
          details: 'Custom error processing completed',
          code: 'CUSTOM_HANDLED'
        },
        timestamp: new Date(),
        processingTime: 0,
        data: {
          moduleName: 'MyModule',
          moduleId: 'my-module',
          response: { message: 'Custom response' },
          config: error.config,
          metadata: { customHandler: true }
        },
        actions: [],
        annotations: []
      };
    }
  }
};

// Register module
errorGateway.registerModule(moduleRegistration);
```

## API Reference

### ErrorInterfaceGateway

Main interface for error handling operations.

#### Methods

- `initialize(): Promise<void>` - Initialize the error handling system
- `handleError(error: ErrorContext): Promise<ErrorResponse>` - Handle error in blocking mode
- `handleErrorAsync(error: ErrorContext): void` - Handle error in non-blocking mode
- `handleBatchErrors(errors: ErrorContext[]): Promise<ErrorResponse[]>` - Handle multiple errors
- `registerModule(module: ModuleRegistration): void` - Register a module
- `unregisterModule(moduleId: string): void` - Unregister a module
- `shutdown(): Promise<void>` - Shutdown the system

### ErrorContext

Interface for error context information.

```typescript
interface ErrorContext {
  errorId: string;
  error: Error;
  timestamp: Date;
  source: ModuleSource;
  classification: ErrorClassification;
  data: Record<string, any>;
  config: ErrorHandlingConfig;
  callback?: (response: ErrorResponse) => void;
}
```

### ErrorResponse

Interface for error response information.

```typescript
interface ErrorResponse {
  responseId: string;
  errorId: string;
  result: HandlingResult;
  timestamp: Date;
  processingTime: number;
  data: ResponseData;
  actions: Action[];
  annotations: ModuleAnnotation[];
}
```

## Configuration

### Error Handling Configuration

```typescript
const config: ErrorHandlingConfig = {
  queueSize: 1000,
  flushInterval: 5000,
  enableBatchProcessing: true,
  maxBatchSize: 50,
  enableCompression: false,
  enableMetrics: true,
  enableLogging: true,
  logLevel: 'info',
  retryPolicy: {
    maxRetries: 3,
    retryDelay: 1000,
    backoffMultiplier: 2,
    maxRetryDelay: 10000
  },
  circuitBreaker: {
    failureThreshold: 5,
    recoveryTime: 30000,
    requestVolumeThreshold: 10
  }
};
```

## 已知问题和待改进项

### 🚨 需要UnderConstruction模块替换的TODO项目

#### 1. 动态模板加载功能未实现
**位置**: `src/components/ResponseTemplateManager.ts`
**状态**: 动态模板加载功能未实现
```typescript
// 当前代码:
// Placeholder for dynamic template loading
if (this.enableMetrics) {
  console.log('Dynamic template loading not implemented');
}

// 应该使用UnderConstruction声明:
import { underConstruction } from 'rcc-underconstruction';

underConstruction.callUnderConstructionFeature('dynamic-template-loading', {
  caller: 'ResponseTemplateManager.loadDynamicTemplates',
  parameters: { enableMetrics: this.enableMetrics },
  purpose: '动态模板加载功能，支持从外部源加载和缓存响应模板'
});
```

#### 2. 动态加载器初始化未实现
**位置**: `src/components/ResponseTemplateManager.ts`
**状态**: 动态加载器初始化被注释掉
```typescript
// 当前代码:
// Initialize dynamic loader if available
// this.dynamicLoader = new DynamicTemplateLoader();
// await this.dynamicLoader.initialize();

// 应该使用UnderConstruction声明:
underConstruction.callUnderConstructionFeature('dynamic-loader-initialization', {
  caller: 'ResponseTemplateManager.initialize',
  parameters: {},
  purpose: '动态模板加载器的完整初始化和配置功能'
});
```

### ⚠️ 潜在架构改进点

#### 1. 错误分类算法优化
当前的错误分类算法相对基础，可以引入更智能的机器学习分类算法。

#### 2. 响应模板系统增强
可以增加更强大的模板系统，支持条件模板、嵌套模板和模板继承。

#### 3. 策略引擎扩展
策略引擎可以支持更复杂的策略组合和动态策略调整。

#### 4. 性能监控和指标
可以增加更详细的性能监控和指标收集功能。

### 📋 集成改进机会

#### 1. 与RCC基础模块的深度集成
可以更好地与rcc-basemodule的调试和日志系统集成。

#### 2. 与配置系统的集成
可以支持从配置系统动态加载错误处理策略。

## 开发标准合规性

### ✅ 已符合的开发标准

1. **模块化架构**: 严格遵循RCC模块化架构原则
2. **类型安全**: 完整的TypeScript类型定义
3. **错误处理**: 完整的错误处理和恢复机制
4. **异步处理**: 支持同步和异步处理模式
5. **扩展性**: 支持动态模块注册和扩展

### 🔄 需要改进的方面

1. **UnderConstruction模块集成**: 需要替换未实现功能的占位符
2. **动态功能实现**: 需要实现动态模板加载等功能
3. **测试覆盖率**: 需要增加集成测试和边缘情况测试

### 📝 UnderConstruction使用标准

所有未完成功能必须使用UnderConstruction模块显式声明：

```typescript
import { underConstruction } from 'rcc-underconstruction';

// 标准使用模式
underConstruction.callUnderConstructionFeature('feature-identifier', {
  caller: 'ClassName.methodName',
  parameters: { /* 相关参数 */ },
  purpose: '功能的具体目的和预期行为'
});
```

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
npm run test:coverage
```

### Linting

```bash
npm run lint
npm run lint:fix
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Support

For issues and questions, please use the [GitHub Issues](https://github.com/rcc/rcc-errorhandling/issues) page.