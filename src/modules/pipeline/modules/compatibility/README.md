# Compatibility 模块

Compatibility 模块提供协议格式转换功能，将不同供应商的API格式进行相互转换，支持工具调用、字段映射和响应格式适配。

## 模块概述

Compatibility 模块是流水线架构的第 2 层，负责处理请求和响应的格式转换。它基于 JSON 配置文件驱动，支持灵活的转换规则定义，确保不同供应商之间的协议兼容性。

## 支持的兼容性模块

### 🔧 字段映射兼容性
- **实现文件**: `field-mapping.ts`
- **功能**: 通用字段映射和转换
- **特性**:
  - 基于 JSON 配置的转换规则
  - 支持多种转换类型（映射、重命名、结构转换等）
  - 条件转换支持
  - 错误处理和回退机制
  - 性能监控和统计

### 🎨 LM Studio 兼容性
- **实现文件**: `lmstudio-compatibility.ts`
- **功能**: LM Studio 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ LM Studio 格式转换
  - 工具调用 API 适配
  - 请求/响应格式标准化
  - 模型名称映射
  - 参数适配

### 🔗 Qwen 兼容性
- **实现文件**: `qwen-compatibility.ts`
- **功能**: Qwen 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ Qwen 格式转换
  - 模型名称映射（gpt-4 → qwen3-coder-plus）
  - 工具调用格式转换
  - 响应格式标准化
  - 错误码映射

### 🌐 iFlow 兼容性
- **实现文件**: `iflow-compatibility.ts`
- **功能**: iFlow 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ iFlow 格式转换
  - 温度参数映射
  - 最大 token 数映射
  - 响应结构适配

## 核心功能

### 🔄 转换类型支持
```typescript
type TransformType =
  | 'direct'                    // 直接映射
  | 'mapping'                   // 值映射
  | 'rename'                    // 重命名字段
  | 'structure'                 // 结构转换
  | 'array-transform'           // 数组转换
  | 'object-transform'          // 对象转换
  | 'conditional'               // 条件转换
  | 'function'                  // 自定义函数
  | 'lmstudio-tools'            // LM Studio工具调用转换
  | 'lmstudio-response'         // LM Studio响应格式转换
```

### 📋 配置驱动的转换
```typescript
// 转换规则配置
const transformationRule: TransformationRule = {
  id: 'model-name-mapping',
  transform: 'mapping',
  sourcePath: 'model',
  targetPath: 'model',
  mapping: {
    'gpt-4': 'qwen3-coder-plus',
    'gpt-3.5-turbo': 'qwen-turbo'
  },
  condition: {
    field: 'model',
    operator: 'exists',
    value: null
  }
};
```

### 🛡️ 错误处理
```typescript
// 转换错误处理
try {
  const result = await this.transformationEngine.transform(data, rules);
} catch (error) {
  if (this.config.config?.continueOnError) {
    // 继续处理，返回原始数据
    return data;
  } else {
    // 抛出错误
    throw error;
  }
}
```

### 📊 性能监控
```typescript
// 转换统计
const stats = await compatibility.getTransformationStats();
console.log({
  transformationCount: stats.transformationCount,
  successCount: stats.successCount,
  errorCount: stats.errorCount,
  averageTransformationTime: stats.averageTransformationTime
});
```

## 文件结构

```
src/modules/pipeline/modules/compatibility/
├── field-mapping.ts              # 通用字段映射实现
├── lmstudio-compatibility.ts     # LM Studio 兼容性实现
├── qwen-compatibility.ts         # Qwen 兼容性实现
├── iflow-compatibility.ts        # iFlow 兼容性实现
└── README.md                     # 本文档
```

## 使用示例

### 基本字段映射
```typescript
import { FieldMappingCompatibility } from './field-mapping.js';

const compatibility = new FieldMappingCompatibility({
  type: 'field-mapping',
  config: {
    rules: [
      {
        id: 'model-mapping',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-4': 'qwen3-coder-plus',
          'gpt-3.5-turbo': 'qwen-turbo'
        }
      }
    ]
  }
}, dependencies);

await compatibility.initialize();

const transformed = await compatibility.processIncoming({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
});
// 结果: { model: 'qwen3-coder-plus', messages: [...] }
```

### LM Studio 工具调用适配
```typescript
import { LMStudioCompatibility } from './lmstudio-compatibility.js';

const compatibility = new LMStudioCompatibility({
  type: 'lmstudio-compatibility',
  config: {
    toolsEnabled: true,
    customRules: [
      {
        id: 'tools-conversion',
        transform: 'lmstudio-tools',
        sourcePath: 'tools',
        targetPath: 'tools'
      }
    ]
  }
}, dependencies);

await compatibility.initialize();

const transformed = await compatibility.processIncoming({
  model: 'gpt-4',
  messages: [...],
  tools: [/* OpenAI 工具格式 */]
});
// 结果: 转换为 LM Studio 兼容的工具格式
```

### Qwen 响应格式转换
```typescript
import { QwenCompatibility } from './qwen-compatibility.js';

const compatibility = new QwenCompatibility({
  type: 'qwen-compatibility',
  config: {}
}, dependencies);

await compatibility.initialize();

const request = await compatibility.processIncoming(openAIRequest);
const providerResponse = await provider.processIncoming(request);
const finalResponse = await compatibility.processOutgoing(providerResponse);
// 结果: 转换回 OpenAI 响应格式
```

## 转换规则详解

### 1. 直接映射 (Direct Mapping)
```typescript
{
  id: 'direct-field',
  transform: 'direct',
  sourcePath: 'messages',
  targetPath: 'messages'
}
```

### 2. 值映射 (Value Mapping)
```typescript
{
  id: 'model-names',
  transform: 'mapping',
  sourcePath: 'model',
  targetPath: 'model',
  mapping: {
    'gpt-4': 'qwen-max',
    'gpt-3.5-turbo': 'qwen-turbo'
  }
}
```

### 3. 条件转换 (Conditional Transform)
```typescript
{
  id: 'conditional-transform',
  transform: 'conditional',
  sourcePath: 'temperature',
  targetPath: 'temperature',
  condition: {
    field: 'temperature',
    operator: 'greater_than',
    value: 1.0
  },
  defaultValue: 1.0
}
```

### 4. 结构转换 (Structure Transform)
```typescript
{
  id: 'structure-conversion',
  transform: 'structure',
  sourcePath: 'choices',
  targetPath: 'choices',
  structure: {
    'index': 'index',
    'message.role': 'delta.role',
    'message.content': 'delta.content'
  }
}
```

### 5. LM Studio 工具转换
```typescript
{
  id: 'lmstudio-tools',
  transform: 'lmstudio-tools',
  sourcePath: 'tools',
  targetPath: 'tools',
  condition: {
    field: 'tools',
    operator: 'exists',
    value: null
  }
}
```

## 配置选项

### 字段映射配置
```typescript
interface FieldMappingConfig {
  enableValidation?: boolean;     // 启用验证
  continueOnError?: boolean;      // 出错时继续
  maxTransformations?: number;    // 最大转换数
  rules: TransformationRule[];    // 转换规则
  responseMappings?: any[];       // 响应映射规则
}
```

### LM Studio 兼容性配置
```typescript
interface LMStudioCompatibilityConfig {
  toolsEnabled?: boolean;         // 启用工具转换
  customRules?: TransformationRule[]; // 自定义规则
  modelMappings?: Record<string, string>; // 模型映射
}
```

### Qwen 兼容性配置
```typescript
interface QwenCompatibilityConfig {
  customRules?: TransformationRule[]; // 自定义规则
  modelMappings?: Record<string, string>; // 模型映射
  enableResponseMapping?: boolean; // 启用响应映射
}
```

## 错误处理

### 转换错误类型
```typescript
type TransformationError =
  | 'rule_validation_error'      // 规则验证错误
  | 'path_resolution_error'      // 路径解析错误
  | 'mapping_not_found'          // 映射未找到
  | 'type_conversion_error'      // 类型转换错误
  | 'structure_mismatch'         // 结构不匹配
  | 'condition_evaluation_error' // 条件评估错误
```

### 错误处理策略
```typescript
// 验证模式
if (config.enableValidation) {
  this.validateTransformationRule(rule);
}

// 错误继续模式
if (config.continueOnError) {
  try {
    return await this.applyTransformations(data, rules);
  } catch (error) {
    // 返回原始数据
    return data;
  }
}
```

## 性能优化

### 缓存机制
```typescript
// 转换引擎缓存
await this.transformationEngine.initialize({
  enableCache: true,
  cacheSize: 1000,
  maxTimeMs: 5000
});
```

### 批量处理
```typescript
// 批量转换支持
const results = await Promise.all(
  requests.map(request => 
    compatibility.processIncoming(request)
  )
);
```

## 调试支持

### 转换日志
```typescript
// 详细的转换日志
logger.logTransformation(this.id, 'request-field-mapping', original, transformed);
logger.logTransformation(this.id, 'response-field-mapping', original, transformed);
```

### 转换统计
```typescript
// 转换统计信息
const stats = await compatibility.getTransformationStats();
console.log({
  ruleCount: stats.ruleCount,
  transformationCount: stats.transformationCount,
  successRate: stats.successCount / stats.transformationCount
});
```

## 扩展性

### 添加新的转换类型
```typescript
// 注册自定义转换器
this.transformationEngine.registerTransformer('custom-transform', {
  transform: (data: any, rule: TransformationRule) => {
    // 自定义转换逻辑
    return transformedData;
  }
});
```

### 添加新的兼容性模块
```typescript
class NewCompatibility implements CompatibilityModule {
  async processIncoming(request: any): Promise<any> {
    // 实现请求转换逻辑
  }

  async processOutgoing(response: any): Promise<any> {
    // 实现响应转换逻辑
  }
}
```

## 已知限制

### ❌ 当前限制
1. **嵌套转换性能** - 深层嵌套的 JSON 路径转换可能影响性能
2. **循环引用** - 不支持循环引用的数据结构转换
3. **大文件处理** - 大型 JSON 数据的内存处理限制
4. **实时转换** - 不支持流式数据的实时转换

### 🔄 计划改进
1. **流式转换** - 支持大型 JSON 文件的流式处理
2. **并行转换** - 多个转换规则的并行执行
3. **智能缓存** - 基于数据特征的智能缓存策略
4. **增量转换** - 支持部分数据的增量转换

## 版本信息

- **当前版本**: 1.0.0
- **兼容性**: RouteCodex Pipeline >= 1.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 最后更新

2025-01-22 - 完善转换规则文档和性能优化说明