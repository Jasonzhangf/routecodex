# GLM兼容模块

## 概述

GLM兼容模块实现OpenAI格式与GLM格式之间的双向转换，遵循RouteCodex架构原则。

## 架构设计

### 整体流程
```
Incoming请求流：
1. LLM Switch →
2. Hook: incoming_preprocessing (GLM工具清洗) →
3. 标准字段映射 (JSON配置驱动) →
4. Hook: incoming_validation (标准字段校验) →
5. Provider

Outgoing响应流：
1. Provider →
2. 标准字段映射 (JSON配置驱动) →
3. Hook: outgoing_validation (响应字段校验) →
4. Hook: outgoing_postprocessing (GLM响应标准化) →
5. LLM Switch
```

### 模块结构
```
glm/
├── glm-compatibility.ts              # 主兼容模块
├── index.ts                          # 模块导出
├── filters/
│   └── glm-shape-filter.ts           # 形状过滤器（基于 JSON 配置）
├── field-mapping/
│   └── field-mapping-processor.ts    # 字段映射处理器
├── hooks/
│   ├── base-hook.ts                  # Hook基类
│   ├── glm-tool-cleaning-hook.ts     # 工具清洗Hook
│   ├── glm-request-validation-hook.ts # 请求校验Hook
│   ├── glm-response-validation-hook.ts # 响应校验Hook
│   └── glm-response-normalization-hook.ts # 响应标准化Hook
└── config/
    ├── field-mappings.json           # 字段映射配置
    └── shape-filters.json            # 形状过滤配置（GLM 请求/响应白名单 + 约束）
```

## 核心功能

### 1. 工具清洗 (incoming_preprocessing)
- 清洗最后一条role=tool消息内容 (512B截断 + 噪声去除)
- 处理assistant消息中的大段工具结果回灌
- 强制串化tool_calls.function.arguments
- 移除tools[].function.strict字段
- 扁平化content数组
- reasoning段落拆分由 llmswitch-core conversion 骨架处理，此处不再涉入

### 2. 标准字段映射
- usage字段标准化: input_tokens ↔ prompt_tokens
- 时间戳字段: created_at ↔ created
- 模型名称标准化（其余引导信息由 conversion 骨架维护）

### 2.5. 形状过滤（基于 JSON 配置）
- 配置文件：`config/shape-filters.json`
- 请求侧：
  - 仅保留文档允许的顶层字段
  - messages：限定角色集合；assistant 含 tool_calls 时 content=null；tool 角色内容拍平为非空字符串
  - assistant.tool_calls.function.arguments 强制为 JSON 对象
  - tools：统一为 {type:'function',function:{name,description,parameters(对象)}}；存在 tools 时强制 tool_choice='auto'
- 响应侧：
  - 仅保留 GLM 文档定义的顶层字段
  - choices[*].message：content 在 tool_calls 存在时置 null；tool_calls.function.arguments 统一为对象；role 缺省为 assistant
  - finish_reason 缺省按是否存在 tool_calls 设为 'tool_calls'

### 3. 请求校验 (incoming_validation)
- 检查必须字段: model, messages
- 校验messages数组结构和内容
- 校验参数范围: temperature, max_tokens等
- 条件校验: 非tool角色的content不能为空

### 4. 响应校验 (outgoing_validation)
- 校验基础响应字段: id, object, created, model
- 校验choices结构和内容
- 校验tool_calls的完整性和有效性
- 校验usage字段的一致性

### 5. 响应标准化 (outgoing_postprocessing)
- 标准化GLM特有的响应格式
- 标准化finish_reason值
- 确保字段格式一致性；reasoning_content 已由 Hub Pipeline 生成

## 配置驱动

### 字段映射配置 (field-mappings.json)
```json
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

### 形状过滤配置 (shape-filters.json)
```json
{
  "request": {
    "allowTopLevel": ["model", "messages", "stream", "thinking", "do_sample", "temperature", "top_p", "max_tokens", "tool_stream", "tools", "tool_choice", "stop", "response_format", "request_id", "user_id"],
    "messages": {
      "allowedRoles": ["system", "user", "assistant", "tool"],
      "assistantWithToolCallsContentNull": true,
      "toolContentStringify": true
    },
    "tools": { "normalize": true, "forceToolChoiceAuto": true },
    "assistantToolCalls": { "functionArgumentsType": "object" }
  },
  "response": {
    "allowTopLevel": ["id", "request_id", "created", "model", "choices", "usage", "video_result", "web_search", "content_filter"],
    "choices": {
      "required": true,
      "message": {
        "allow": ["role", "content", "reasoning_content", "audio", "tool_calls"],
        "roleDefault": "assistant",
        "contentNullWhenToolCalls": true,
        "tool_calls": { "function": { "nameRequired": true, "argumentsType": "object" } }
      },
      "finish_reason": ["stop", "tool_calls", "length", "sensitive", "network_error"]
    },
    "usage": { "allow": ["prompt_tokens", "completion_tokens", "prompt_tokens_details", "total_tokens"] }
  }
}
```

## 使用示例

### 方式1：使用标准兼容性API（推荐）

```typescript
import { createCompatibilityAPI } from '../index.js';

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
  context
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

### 方式2：直接使用GLM模块

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

## 架构合规性

- ✅ **原则2**: 兼容层职责范围限制
- ✅ **原则4**: 快速死亡原则
- ✅ **原则6**: 清晰解决原则
- ✅ **原则7**: 功能分离原则
- ✅ **原则8**: 配置驱动原则

## 特性

- **类型安全**: 完整的TypeScript类型定义
- **配置驱动**: JSON配置文件控制所有映射规则
- **错误处理**: 详细的错误信息和日志记录
- **性能优化**: 最小化处理开销
- **模块化**: 每个组件职责明确，易于测试和维护
