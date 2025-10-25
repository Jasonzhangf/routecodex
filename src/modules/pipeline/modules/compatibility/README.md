# Compatibility 模块

Compatibility 模块提供协议格式转换功能，将不同供应商的API格式进行相互转换，支持工具调用、字段映射和响应格式适配。作为 RouteCodex 4层流水线架构的第 2 层，它专注于处理供应商特定的格式差异。

## 🎯 模块概述

Compatibility 模块是流水线架构的第 2 层（格式转换层），负责处理请求和响应的格式转换。它专注于处理供应商特定的格式差异，确保不同供应商之间的协议兼容性。

### 🏗️ 架构定位
```
┌─────────────────────────────────────────────────────────┐
│                RouteCodex 4-Layer Pipeline            │
├─────────────────────────────────────────────────────────────┤
│ HTTP Request → Virtual Router → LLMSwitch → Compatibility → Provider → AI Service │
│     ↓             ↓                ↓            ↓            ↓           ↓          │
│  Request      Dynamic          Protocol      Format       Standard     Response    │
│  Analysis      Routing           Conversion     Transformation HTTP Server   Processing   │
└─────────────────────────────────────────────────────────────┘

                              ↑
                        Compatibility 在此层工作
```

### 🔗 与其他模块的协作
- **LLMSwitch**: 接收协议转换后的请求，进行供应商特定格式适配
- **Provider**: 接收格式标准化后的请求，发送给外部AI服务
- **Virtual Router**: 提供动态路由分类（上游）
- **AI Service**: 外部AI服务提供商（目标转换对象）

### 🎯 设计原则
- **专注格式转换**: 只处理供应商特定的格式差异，不负责协议转换
- **配置驱动**: 基于 JSON 配置的转换规则
- **模块化设计**: 每个供应商有独立的 Compatibility 实现

### 📋 核心职责
- **格式转换**: 供应商特定的请求/响应格式转换
- **工具适配**: 工具调用格式的标准化处理
- **字段映射**: 字段名称和结构的映射转换
- **参数适配**: 供应商特定参数的标准化

## 🔄 支持的兼容性模块

### 🔧 字段映射兼容性
- **实现文件**: `field-mapping.ts`
- **功能**: 通用字段映射和转换
- **特性**:
  - 基于 JSON 配置的转换规则
  - 支持多种转换类型（映射、重命名、结构转换等）
  - 条件转换支持
  - 错误处理和回退机制
  - 性能监控和统计

### 🏠 LM Studio 兼容性
- **实现文件**: `lmstudio-compatibility.ts`
- **功能**: LM Studio 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ LM Studio 格式转换
  - 工具调用 API 适配
  - 请求/响应格式标准化
  - 模型名称映射
  - 参数适配

### 🔍 Qwen 兼容性
- **实现文件**: `qwen-compatibility.ts`
- **功能**: Qwen 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ Qwen 格式转换
  - 模型名称映射（gpt-4 → qwen3-coder-plus）
  - 工具调用格式转换
  - 响应格式标准化
  - 错误码映射
  - 思考内容处理

### 🟢 GLM 兼容性
- **实现文件**: `glm-compatibility.ts`
- **功能**: GLM 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ GLM 格式转换
  - 思考内容（thinking）处理
  - 工具调用兼容性优化
  - 模型参数适配
  - 1210 错误兼容性

### 🌊 iFlow 兼容性
- **实现文件**: `iflow-compatibility.ts`
- **功能**: iFlow 特定的格式转换
- **特性**:
  - OpenAI 格式 ↔ iFlow 格式转换
  - 温度参数映射
  - 最大 token 数映射
  - 响应结构适配
  - 用户代理头注入

### 🔄 Passthrough 兼容性
- **实现文件**: `passthrough-compatibility.ts`
- **功能**: 直接透传，无格式转换
- **特性**:
  - 保持原始请求/响应格式不变
  - 最小的性能开销
  - 适用于格式完全兼容的场景

## 🌟 核心功能

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
  | 'glm-thinking'              // GLM 思考内容处理
  | 'iflow-headers'             // iFlow 请求头注入
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

## 📁 文件结构

```
src/modules/pipeline/modules/compatibility/
├── field-mapping.ts              # 通用字段映射实现
├── lmstudio-compatibility.ts     # LM Studio 兼容性实现
├── glm-compatibility.ts          # GLM 兼容性实现
├── qwen-compatibility.ts         # Qwen 兼容性实现
├── iflow-compatibility.ts        # iFlow 兼容性实现
├── passthrough-compatibility.ts   # Passthrough 兼容性实现
└── README.md                     # 本文档
```

## 🚀 使用示例

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

### GLM 思考内容处理
```typescript
import { GLMCompatibility } from './glm-compatibility.js';

const compatibility = new GLMCompatibility({
  type: 'glm-compatibility',
  config: {
    forceDisableThinking: false,
    useMappingConfig: true
  }
}, dependencies);

await compatibility.initialize();

// 处理包含思考内容的请求
const transformed = await compatibility.processIncoming({
  model: 'glm-4',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'Let me think about this step by step...'
    },
    { role: 'user', content: 'Calculate 15 * 25' }
  ]
});
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

## 🔄 转换规则详解

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

### 5. GLM 思考内容转换
```typescript
{
  id: 'glm-thinking-extraction',
  transform: 'glm-thinking',
  sourcePath: 'messages',
  targetPath: 'messages',
  preserveThinking: true
}
```

### 6. iFlow 请求头注入
```typescript
{
  id: 'iflow-headers',
  transform: 'iflow-headers',
  headers: {
    'User-Agent': 'iflow-cli/2.0',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  }
}
```

## ⚙️ 配置选项

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

### GLM 兼容性配置
```typescript
interface GLMCompatibilityConfig {
  forceDisableThinking?: boolean;   // 强制禁用思考功能
  useMappingConfig?: boolean;       // 使用映射配置
}
```

### iFlow 兼容性配置
```typescript
interface iFlowCompatibilityConfig {
  injectHeaders?: boolean;          // 注入请求头
  customHeaders?: Record<string, string>; // 自定义请求头
  temperatureMapping?: Record<number, number>; // 温度映射
}
```

## 🔄 工具调用转换

### OpenAI → LM Studio 工具格式
```typescript
// OpenAI 格式
{
  "type": "function",
  "function": {
    "name": "calculate",
    "description": "Perform mathematical calculations",
    "parameters": {
      "type": "object",
      "properties": {
        "expression": { "type": "string" }
      }
    }
  }
}

// 转换为 LM Studio 格式
{
  "type": "function",
  "name": "calculate",
  "description": "Perform mathematical calculations",
  "parameters": {
    "type": "object",
    "properties": {
      "expression": { "type": "string" }
    }
  }
}
```

### 工具调用响应转换
```typescript
// Chat 格式响应
{
  "choices": [{
    "message": {
      "tool_calls": [{
        "id": "call_123",
        "type": "function",
        "function": {
          "name": "calculate",
          "arguments": "{\"expression\":\"15*25\"}"
        }
      }]
    }
  }]
}

// 转换为标准化格式
const standardizedResponse = {
  tool_calls: [{
    id: "call_123",
    name: "calculate",
    arguments: "{\"expression\":\"15*25\"}"
  }]
};
```

## 🛡️ 错误处理

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

## 📊 性能优化

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

## 🔍 调试支持

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

## 🌐 API 协议支持

### OpenAI 协议
- **请求格式**: `/v1/chat/completions`
- **响应格式**: 标准化 OpenAI 响应
- **工具调用**: 支持所有 OpenAI 工具调用格式

### OpenAI 兼容协议
- **Provider**: LM Studio, Qwen, GLM, iFlow
- **请求转换**: 通过 Compatibility 层进行格式适配
- **响应转换**: 转换回标准 OpenAI 格式

### Responses 协议
- **请求路径**: `/v1/responses` → LLM Switch → Chat → Compatibility
- **响应路径**: Chat → Compatibility → Responses
- **格式支持**: 通过多层转换实现完整兼容

## 🔧 扩展性

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
  readonly type = 'new-compatibility';
  readonly protocol = 'new-protocol';

  async processIncoming(request: any): Promise<any> {
    // 实现请求转换逻辑
    const transformed = this.transformRequest(request);
    return {
      ...transformed,
      _metadata: {
        compatibilityType: this.type,
        timestamp: Date.now(),
        originalProtocol: this.detectProtocol(request),
        targetProtocol: 'openai'
      }
    };
  }

  async processOutgoing(response: any): Promise<any> {
    // 实现响应转换逻辑
    return this.transformResponse(response);
  }

  private transformRequest(request: any): any {
    // 自定义请求转换逻辑
  }

  private transformResponse(response: any): any {
    // 自定义响应转换逻辑
  }
}
```

## 📈 版本信息

- **当前版本**: 2.0.0
- **新增特性**: GLM 兼容性增强、Responses 支持
- **兼容性**: RouteCodex Pipeline >= 2.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-debugcenter**: 调试中心集成
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成
- **BaseModule**: 基础模块接口

## 🚨 已知限制

### 当前限制
1. **嵌套转换性能** - 深层嵌套的 JSON 路径转换可能影响性能
2. **循环引用** - 不支持循环引用的数据结构转换
3. **大文件处理** - 大型 JSON 数据的内存处理限制
4. **实时转换** - 不支持流式数据的实时转换

### 计划改进
1. **流式转换** - 支持大型 JSON 文件的流式处理
2. **并行转换** - 多个转换规则的并行执行
3. **智能缓存** - 基于数据特征的智能缓存策略
4. **增量转换** - 支持部分数据的增量转换

## 🔄 更新日志

### v2.0.0 (2025-10-17)
- ✨ 新增 GLM 兼容性完整支持
- 🌐 完善 Responses API 转换路径文档
- 🔄 增强的工具调用转换支持
- 📊 详细的性能监控和调试功能
- 🛡️ 改进的错误处理和恢复机制

### v1.5.0 (2025-01-22)
- 🔧 完善字段映射和转换规则
- 📊 性能监控功能增强
- 🛡️ 错误处理机制优化

### v1.0.0 (2025-01-22)
- 🎯 初始版本发布
- 🔄 基础的字段映射功能
- 📊 配置驱动的转换引擎

## 📞 技术支持

如有问题或建议，请：
1. 检查转换规则配置是否正确
2. 验证输入数据格式是否符合预期
3. 查看转换日志了解详细信息
4. 检查目标 Provider 的 API 文档

---

**最后更新**: 2025-10-17 - 全面更新 Compatibility 模块文档，新增 GLM 和 Responses 支持