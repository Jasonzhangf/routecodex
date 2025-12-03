# 兼容性模块使用示例

## 概述

兼容性模块提供统一的API接口，支持多种Provider的格式转换。目前支持GLM兼容模块，架构可扩展支持更多Provider。

## 标准API使用方式

### 1. 基础使用

```typescript
import { createCompatibilityAPI } from './index.js';

// 创建兼容性API实例
const compatibilityAPI = createCompatibilityAPI(dependencies);

// 初始化
await compatibilityAPI.initialize();

// 创建GLM兼容模块
const moduleId = await compatibilityAPI.createModule({
  id: 'glm-compatibility-1',
  type: 'glm',
  providerType: 'glm',
  config: {}
});

// 处理请求
const processedRequest = await compatibilityAPI.processRequest(
  moduleId,
  originalRequest,
  {
    compatibilityId: 'glm-compatibility-1',
    profileId: 'glm-standard',
    providerType: 'glm',
    direction: 'incoming',
    stage: 'processing',
    requestId: 'req-123',
    executionId: 'exec-456',
    timestamp: Date.now(),
    startTime: Date.now(),
    metadata: {
      dataSize: JSON.stringify(originalRequest).length,
      dataKeys: Object.keys(originalRequest)
    }
  }
);

// 处理响应
const processedResponse = await compatibilityAPI.processResponse(
  moduleId,
  originalResponse,
  context
);

// 清理
await compatibilityAPI.cleanup();
```

### 2. 直接使用GLM模块

```typescript
import { createGLMCompatibilityModule } from './glm/index.js';

// 创建GLM兼容模块
const { module, initialize, processIncoming, processOutgoing, cleanup } =
  createGLMCompatibilityModule(dependencies);

// 初始化
await initialize();

// 处理请求和响应
const processedRequest = await processIncoming(request, context);
const processedResponse = await processOutgoing(response, context);

// 清理
await cleanup();
```

### 3. 批量处理多个模块

```typescript
import { CompatibilityManager } from './compatibility-manager.js';
import { CompatibilityModuleFactory } from './compatibility-factory.js';

// 创建管理器
const manager = new CompatibilityManager(dependencies);
await manager.initialize();

// 创建多个不同类型的模块
const glmModuleId = await manager.createModule({
  id: 'glm-1',
  type: 'glm',
  providerType: 'glm',
  config: {}
});

const qwenModuleId = await manager.createModule({
  id: 'qwen-1',
  type: 'qwen',
  providerType: 'qwen',
  config: {}
});

// 根据Provider类型获取模块
const glmModules = manager.getModulesByProviderType('glm');

// 批量处理
for (const request of requests) {
  const moduleId = getModuleIdForProvider(request.provider);
  const processed = await manager.processRequest(moduleId, request, context);
  // 处理结果...
}

// 清理
await manager.cleanup();
```

## API接口规范

### CompatibilityAPI 核心接口

```typescript
interface CompatibilityAPI {
  initialize(): Promise<void>;
  createModule(config: CompatibilityModuleConfig): Promise<string>;
  processRequest(moduleId: string, request: any, context: CompatibilityContext): Promise<any>;
  processResponse(moduleId: string, response: any, context: CompatibilityContext): Promise<any>;
  getModule(moduleId: string): CompatibilityModule | undefined;
  getStats(): object;
  cleanup(): Promise<void>;
}
```

### CompatibilityModule 标准接口

```typescript
interface CompatibilityModule {
  readonly id: string;
  readonly type: string;
  readonly providerType?: string;

  initialize(): Promise<void>;
  processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;
  processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;
  cleanup(): Promise<void>;
}
```

### CompatibilityContext 上下文接口

```typescript
interface CompatibilityContext {
  compatibilityId: string;
  profileId: string;
  providerType: string;
  direction: 'incoming' | 'outgoing';
  stage: string;
  requestId: string;
  executionId: string;
  timestamp: number;
  startTime: number;
  metadata: {
    dataSize: number;
    dataKeys: string[];
    [key: string]: any;
  };
}
```

## 扩展新的Provider

### 1. 创建新Provider模块

```typescript
// 创建 qwen-compatibility.ts
export class QwenCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'qwen';
  readonly providerType = 'qwen';

  constructor(dependencies: ModuleDependencies) {
    this.id = `qwen-compatibility-${Date.now()}`;
  }

  async initialize(): Promise<void> {
    // 初始化逻辑
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    // 请求处理逻辑
    return processedRequest;
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    // 响应处理逻辑
    return processedResponse;
  }

  async cleanup(): Promise<void> {
    // 清理逻辑
  }
}
```

### 2. 注册到工厂

```typescript
// 在 qwen/index.ts 中
import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { QwenCompatibility } from './qwen-compatibility.js';

// 注册模块类型
CompatibilityModuleFactory.registerModuleType('qwen', QwenCompatibility);

export { QwenCompatibility };
export function createQwenCompatibilityModule(dependencies: ModuleDependencies) {
  return new QwenCompatibility(dependencies);
}
```

### 3. 配置驱动的字段映射

```json
// qwen/config/field-mappings.json
{
  "incomingMappings": [
    {
      "sourcePath": "usage.prompt_tokens",
      "targetPath": "usage.input_tokens",
      "type": "number",
      "direction": "incoming"
    }
  ],
  "outgoingMappings": [
    {
      "sourcePath": "usage.input_tokens",
      "targetPath": "usage.prompt_tokens",
      "type": "number",
      "direction": "outgoing"
    }
  ]
}
```

## 最佳实践

### 1. 模块生命周期管理
- 确保在应用启动时初始化兼容性API
- 在应用关闭时调用cleanup清理资源
- 使用try-catch处理模块初始化和运行时错误

### 2. 错误处理
```typescript
try {
  const processed = await compatibilityAPI.processRequest(moduleId, request, context);
  return processed;
} catch (error) {
  // 记录错误日志
  // 返回原始请求或错误响应
  // 根据业务需求决定是否降级处理
}
```

### 3. 性能监控
```typescript
// 获取模块统计信息
const stats = compatibilityAPI.getStats();
console.log('模块统计:', stats);

// 监控处理时间
const startTime = Date.now();
const result = await compatibilityAPI.processRequest(moduleId, request, context);
const duration = Date.now() - startTime;
```

### 4. 配置管理
- 使用环境变量控制模块配置
- 支持热更新配置
- 为不同环境提供不同的配置文件

## 故障排除

### 常见问题

1. **模块未注册错误**
   - 确保导入了Provider模块的index.ts文件
   - 检查模块类型是否正确注册到工厂

2. **初始化失败**
   - 检查dependencies参数是否完整
   - 查看日志中的详细错误信息

3. **处理请求失败**
   - 检查CompatibilityContext是否完整
   - 验证请求格式是否符合预期

4. **内存泄漏**
   - 确保在适当时机调用cleanup方法
   - 避免创建过多的模块实例