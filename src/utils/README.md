# 工具模块 (Utils Module)

## 功能概述

工具模块提供RouteCodex项目的通用工具函数和辅助类，包括日志记录、错误处理、负载均衡、故障转移、模型字段转换等核心功能。

## 核心特性

### 🛠️ 通用工具
- **日志记录**: 基于RCC DebugCenter的日志系统
- **错误处理**: 统一的错误处理和传播机制
- **负载均衡**: 多种负载均衡策略支持
- **故障转移**: 自动故障切换和健康检查

### 🔧 高级工具
- **模型字段转换**: 智能请求/响应字段映射
- **文件监控**: 配置文件变更监控
- **调试工具**: 调试会话管理
- **健康监控**: 流水线健康状态管理

## 文件结构

### 核心工具文件

#### `logger.ts`
**用途**: 日志记录工具
**功能**:
- 基于RCC DebugCenter实现
- 支持ESM模块导入
- 多级别日志记录
- 结构化日志输出

#### `error-handler.ts` & `error-handler-registry.ts`
**用途**: 错误处理系统
**功能**:
- 基于RCC ErrorHandling实现
- 支持ESM错误传播
- 错误注册表管理
- 错误链路追踪

#### `load-balancer.ts`
**用途**: 负载均衡器
**功能**:
- 多种负载均衡策略（轮询、权重、最少连接）
- 动态权重调整
- 健康状态感知
- 性能统计

#### `failover.ts`
**用途**: 故障转移器
**功能**:
- Provider故障自动切换
- 健康检查机制
- 重试策略管理
- 故障恢复检测

#### `key-429-tracker.ts`
**用途**: API密钥429状态追踪
**功能**:
- 密钥限流状态监控
- 自动密钥切换
- 限流时间跟踪
- 密钥健康状态管理

### 模型字段转换系统

#### `model-field-converter/`
**用途**: 智能模型字段转换
**功能**:
- 请求/响应字段映射
- 模型名称转换
- 字段类型转换
- 兼容性处理

**子文件**:
- `index.ts`: 模块导出和入口
- `model-field-converter.ts`: 主转换器实现
- `request-transformer.ts`: 请求转换器
- `field-mapping-rules.ts`: 字段映射规则
- `types.ts`: 转换相关类型定义

### 系统工具

#### `debug-utils.ts`
**用途**: 调试工具集
**功能**:
- 调试会话管理
- 调试事件记录
- 性能监控
- 错误追踪

#### `file-watcher.ts`
**用途**: 文件监控工具
**功能**:
- 配置文件变更监控
- 热重载触发
- 文件系统事件处理
- 变更通知机制

#### `module-config-reader.ts`
**用途**: 模块配置读取器
**功能**:
- 模块配置解析
- 配置验证
- 环境变量处理
- 配置合并策略

#### `pipeline-health-manager.ts`
**用途**: 流水线健康管理器
**功能**:
- 流水线健康监控
- 性能指标收集
- 故障检测和报警
- 健康状态报告

#### `error-handling-utils.ts`
**用途**: 错误处理工具集
**功能**:
- 错误分类和处理
- 错误恢复策略
- 错误统计和分析
- 错误报告生成

## 依赖关系

```
utils/
├── 依赖 rcc-debugcenter - 日志记录
├── 依赖 rcc-errorhandling - 错误处理
├── 依赖 types/ - 类型定义
├── 依赖 config/ - 配置类型
├── 被 core/ 调用 - 核心业务逻辑
├── 被 modules/ 调用 - 模块系统
├── 被 providers/ 调用 - Provider管理
└── 被 server/ 调用 - 服务器功能
```

## 使用示例

### 基础工具使用
```typescript
import { Logger } from './logger';
import { ErrorHandler } from './error-handler';
import { LoadBalancer } from './load-balancer';
import { Failover } from './failover';

// 日志记录
const logger = new Logger('my-module');
logger.info('System started', { version: '1.0.0' });

// 错误处理
const errorHandler = new ErrorHandler();
try {
  // 业务逻辑
} catch (error) {
  await errorHandler.handleError(error, { context: 'my-module' });
}

// 负载均衡
const loadBalancer = new LoadBalancer();
const provider = await loadBalancer.selectProvider(providers);

// 故障转移
const failover = new Failover();
await failover.handleFailure(provider, error);
```

### 模型字段转换使用
```typescript
import { ModelFieldConverter } from './model-field-converter';

const converter = new ModelFieldConverter();

// 转换请求
const transformedRequest = await converter.transformRequest({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
}, {
  modelMappings: {
    'gpt-4': 'qwen3-coder-plus',
    'gpt-3.5-turbo': 'qwen3-coder'
  }
});

// 转换响应
const transformedResponse = await converter.transformResponse(response, {
  responseMappings: {
    'content': 'text',
    'role': 'speaker'
  }
});
```

### 文件监控使用
```typescript
import { FileWatcher } from './file-watcher';

const watcher = new FileWatcher();

// 监控配置文件变更
await watcher.watch('./config.json', (event) => {
  console.log('Config changed:', event);
  // 触发热重载
});

// 停止监控
await watcher.unwatch('./config.json');
```

### 健康监控使用
```typescript
import { PipelineHealthManager } from './pipeline-health-manager';

const healthManager = new PipelineHealthManager();

// 注册流水线健康检查
healthManager.registerPipeline('main-pipeline', {
  checkInterval: 30000,
  timeoutThreshold: 5000
});

// 获取健康状态
const health = await healthManager.getHealthStatus('main-pipeline');
console.log('Pipeline health:', health);

// 监听健康事件
healthManager.on('health-change', (event) => {
  console.log('Health status changed:', event);
});
```

## 配置选项

### 负载均衡配置
```typescript
interface LoadBalancerConfig {
  strategy: 'round-robin' | 'weighted' | 'least-connections';
  healthCheck: {
    interval: number;
    timeout: number;
    retries: number;
  };
  weights: Record<string, number>;
}
```

### 故障转移配置
```typescript
interface FailoverConfig {
  retryAttempts: number;
  retryDelay: number;
  healthCheckInterval: number;
  recoveryCheckInterval: number;
}
```

### 模型转换配置
```typescript
interface ModelConverterConfig {
  modelMappings: Record<string, string>;
  fieldMappings: Array<{
    sourcePath: string;
    targetPath: string;
    transform: 'mapping' | 'function';
  }>;
  strictMode: boolean;
}
```

## 最佳实践

### 1. 工具使用原则
- **单一职责**: 每个工具只负责一个特定功能
- **可配置**: 支持灵活的配置选项
- **可测试**: 提供测试接口和模拟数据
- **可扩展**: 支持插件和扩展机制

### 2. 错误处理
- **统一错误处理**: 使用统一的错误处理机制
- **错误传播**: 确保错误能够正确传播到上层
- **错误恢复**: 提供自动错误恢复机制
- **错误日志**: 记录详细的错误信息

### 3. 性能优化
- **缓存策略**: 合理使用缓存提高性能
- **资源管理**: 正确管理资源生命周期
- **并发控制**: 控制并发操作数量
- **监控指标**: 收集性能监控指标

## 扩展开发

### 添加新工具
```typescript
// 1. 创建工具文件
// utils/my-tool.ts
export class MyTool {
  constructor(config: MyToolConfig) {
    // 初始化配置
  }

  async execute(input: MyToolInput): Promise<MyToolOutput> {
    // 实现工具逻辑
    return result;
  }
}

// 2. 在index.ts中导出
export { MyTool } from './my-tool';

// 3. 添加类型定义
// types/tool-types.ts
export interface MyToolConfig {
  /* 配置项 */
}

export interface MyToolInput {
  /* 输入类型 */
}

export interface MyToolOutput {
  /* 输出类型 */
}
```

### 添加转换规则
```typescript
// model-field-converter/custom-rules.ts
export const customRules = [
  {
    id: 'custom-mapping',
    sourcePath: 'custom.field',
    targetPath: 'target.field',
    transform: 'mapping',
    mapping: {
      'value1': 'mappedValue1',
      'value2': 'mappedValue2'
    }
  }
];
```

## 版本信息
- **当前版本**: v2.1 (增强工具集)
- **构建状态**: ✅ ESM兼容，✅ 测试通过，✅ 生产就绪
- **工具数量**: 18个核心工具
- **性能评级**: ⚡ 优秀 (低开销，高并发支持)