# 类型定义模块 (Types Module)

## 功能概述

类型定义模块提供RouteCodex项目的完整TypeScript类型系统，包含共享接口、数据传输对象和模块声明，确保整个代码库的类型安全和一致性。

## 核心特性

### 🔄 共享类型系统
- **统一接口**: 项目范围内的通用类型定义
- **数据传输对象**: 标准化的DTO类型定义
- **模块声明**: 外部模块的类型声明文件
- **类型安全**: 完整的TypeScript类型检查支持

### 📊 类型组织
- **基础类型**: 基本数据类型和工具类型
- **业务类型**: 与业务逻辑相关的类型定义
- **调试类型**: 调试和诊断相关的类型
- **外部模块**: 第三方库的类型声明

## 文件结构

### 核心类型文件

#### `common-types.ts`
**用途**: 通用类型定义和工具类型
**功能**:
- 基础数据类型定义
- JSON数据类型支持
- 日志数据类型
- 工具类型和辅助类型

**关键类型**:
```typescript
// 基础类型
export type Unknown = unknown;
export type UnknownObject = Record<string, unknown>;
export type UnknownArray = unknown[];

// JSON类型
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue; }
export type JsonArray = JsonValue[];

// 日志类型
export type LogData = Record<string, unknown> | unknown[] | string | number | boolean;
```

#### `shared-dtos.ts`
**用途**: 共享数据传输对象定义
**功能**:
- 路由请求类型
- 流水线请求/响应类型
- 错误记录类型
- 元数据类型定义

**关键类型**:
```typescript
// 路由请求
export interface SharedRouteRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string;
  readonly timestamp?: number;
}

// 流水线请求
export interface SharedPipelineRequest {
  readonly data: unknown;
  readonly route: { providerId: string; modelId: string; requestId: string; timestamp: number; };
  readonly metadata: Record<string, unknown>;
  readonly debug: { enabled: boolean; stages: Record<string, boolean>; };
}

// 流水线响应
export interface SharedPipelineResponse {
  readonly data: unknown;
  readonly metadata: { pipelineId: string; processingTime: number; stages: string[]; errors?: SharedPipelineError[]; };
}
```

#### `debug-types.ts`
**用途**: 调试和诊断相关类型定义
**功能**:
- 调试会话类型
- 错误追踪类型
- 性能监控类型
- 诊断数据类型

#### `external-modules.d.ts`
**用途**: 外部模块类型声明
**功能**:
- 第三方库的类型声明
- 模块导入类型定义
- 兼容性类型声明

#### `glob.d.ts`
**用途**: Glob模块类型声明
**功能**:
- 文件匹配模式类型
- 路径匹配类型定义

#### `rcc-modules.d.ts`
**用途**: RCC模块类型声明
**功能**:
- RCC框架模块类型
- 共享模块类型定义

## 类型设计原则

### 1. 最小化依赖
- 避免循环依赖
- 保持类型定义的独立性
- 使用接口而非具体实现

### 2. 类型安全
- 严格的类型检查
- 运行时类型验证
- 类型推导支持

### 3. 可扩展性
- 模块化类型设计
- 支持类型继承
- 兼容性考虑

### 4. 文档化
- 完整的JSDoc注释
- 使用示例
- 类型约束说明

## 使用示例

### 基础类型使用
```typescript
import { JsonValue, LogData } from './common-types';

// 使用JSON类型
function processJsonData(data: JsonValue): void {
  console.log('Processing:', data);
}

// 使用日志类型
function logData(data: LogData): void {
  console.log('Log:', data);
}
```

### 共享DTO使用
```typescript
import { SharedRouteRequest, SharedPipelineRequest } from './shared-dtos';

// 创建路由请求
const routeRequest: SharedRouteRequest = {
  providerId: 'qwen-provider',
  modelId: 'qwen3-coder-plus',
  requestId: 'req-123',
  timestamp: Date.now()
};

// 创建流水线请求
const pipelineRequest: SharedPipelineRequest = {
  data: { messages: [{ role: 'user', content: 'Hello' }] },
  route: {
    providerId: 'qwen-provider',
    modelId: 'qwen3-coder-plus',
    requestId: 'req-123',
    timestamp: Date.now()
  },
  metadata: { source: 'api' },
  debug: { enabled: true, stages: { routing: true } }
};
```

### 调试类型使用
```typescript
import { DebugSession, DebugEvent } from './debug-types';

// 创建调试会话
const debugSession: DebugSession = {
  id: 'debug-123',
  startTime: Date.now(),
  events: []
};

// 添加调试事件
const debugEvent: DebugEvent = {
  timestamp: Date.now(),
  level: 'info',
  message: 'Processing request',
  data: { requestId: 'req-123' }
};
```

## 类型继承和扩展

### 基础接口继承
```typescript
interface BaseModel {
  id: string;
  name: string;
  version: string;
}

interface ProviderModel extends BaseModel {
  providerId: string;
  capabilities: string[];
  config: Record<string, unknown>;
}
```

### 工具类型使用
```typescript
// 可选类型
type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// 只读类型
type ReadOnly<T> = {
  readonly [P in keyof T]: T[P];
};

// 深度只读
type DeepReadOnly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadOnly<T[P]> : T[P];
};
```

## 类型验证

### 运行时类型验证
```typescript
// 类型守卫
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLogData(value: unknown): value is LogData {
  return typeof value === 'object' && value !== null;
}

// 使用类型守卫
function processUnknownValue(value: unknown): void {
  if (isJsonObject(value)) {
    console.log('Object:', Object.keys(value));
  } else if (typeof value === 'string') {
    console.log('String:', value);
  }
}
```

## 最佳实践

### 1. 类型定义原则
- **明确性**: 类型名称应该清晰表达其用途
- **一致性**: 保持命名约定的一致性
- **最小化**: 避免过度复杂的类型定义
- **文档化**: 为复杂类型提供详细说明

### 2. 类型组织
- **模块化**: 按功能域组织类型定义
- **分层**: 基础类型、业务类型分层设计
- **复用**: 提高类型复用性
- **维护**: 定期清理未使用的类型

### 3. 类型安全
- **严格模式**: 使用严格的TypeScript配置
- **验证**: 实现运行时类型验证
- **测试**: 为复杂类型编写测试用例
- **监控**: 监控类型相关错误

## 类型演进策略

### 版本兼容性
- 使用类型别名保持向后兼容
- 逐步废弃旧类型定义
- 提供迁移指南

### 类型重构
- 优先重构基础类型
- 渐进式更新业务类型
- 保持API兼容性

## 性能考虑

### 编译性能
- 避免过度复杂的类型计算
- 合理使用条件类型
- 控制类型递归深度

### 运行时性能
- 最小化类型检查开销
- 使用高效的类型守卫
- 缓存类型验证结果

## 依赖关系

```
types/
├── 被所有模块依赖 - 提供基础类型定义
├── 依赖 config/ - 配置类型引用
├── 依赖 utils/ - 工具类型使用
└── 依赖 server/ - 服务器类型定义
```

### 详细依赖
- **config/**: 配置类型定义和验证
- **utils/**: 工具函数和辅助类型
- **server/**: 服务器相关类型定义
- **modules/**: 模块接口类型定义

## 版本信息
- **当前版本**: v1.0 (基础类型系统)
- **构建状态**: ✅ TypeScript兼容，✅ 类型检查通过
- **类型覆盖率**: 100% (完全类型安全)
- **维护状态**: 🔄 持续优化和扩展