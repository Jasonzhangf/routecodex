# LLMSwitch 模块

LLMSwitch 模块提供协议转换功能，专注于不同大语言模型API协议之间的转换，支持 OpenAI Chat、Anthropic Claude、Responses API 等多种协议的双向转换。

## 🎯 模块概述

LLMSwitch 模块是 RouteCodex 4层流水线架构的第 1 层（协议转换层），负责协议格式转换。注意：**动态路由分类现在由独立的Virtual Router模块处理**。

### 📋 核心职责
- **协议转换**: 在不同AI服务提供商协议间进行格式转换
- **双向支持**: 支持请求和响应的双向转换
- **格式标准化**: 确保请求符合目标协议的规范要求
- **元数据增强**: 为转换过程添加追踪和调试信息
- **工具调用适配**: 处理不同协议的工具调用格式差异
- **协议规范化**: 验证和标准化输入的协议格式

### 🏗️ 架构定位
```
┌─────────────────────────────────────────────────────────────┐
│                RouteCodex 4-Layer Pipeline            │
├─────────────────────────────────────────────────────────────┤
│ HTTP Request → Virtual Router → LLMSwitch → Compatibility → Provider → AI Service │
│     ↓             ↓                ↓            ↓            ↓           ↓          │
│  Request      Dynamic          Protocol      Format       Standard     Response    │
│  Analysis      Routing           Conversion     Transformation HTTP Server   Processing   │
└─────────────────────────────────────────────────────────────┘

                    ↑
              LLMSwitch 在此层工作
```

### 🔗 与其他模块的协作
- **Virtual Router**: 接收路由分类后的请求，负责协议转换
- **Compatibility**: 接收LLMSwitch转换后的请求，进行供应商特定适配
- **Provider**: 最终执行层，与外部AI服务通信

## 🔄 支持的协议转换

### 🔧 OpenAI → OpenAI 规范化
- **实现文件**: `llmswitch-openai-openai.ts`
- **类型**: `llmswitch-openai-openai`
- **协议**: `openai` → `openai`
- **功能**: OpenAI 协议规范化和验证
- **特性**:
  - 严格的 Chat Completions 格式验证
  - 工具调用参数标准化（JSON 字符串验证）
  - 函数名称与工具声明匹配验证
  - 消息格式规范化
  - 基于 `rcc-llmswitch-core` 的转换引擎
  - 请求/响应元数据添加
  - 调试和性能监控

### 🔄 Anthropic ↔ OpenAI 双向转换
- **实现文件**: `llmswitch-anthropic-openai.ts`
- **类型**: `llmswitch-anthropic-openai`
- **协议**: `anthropic` ↔ `openai`
- **功能**: Anthropic Claude API 与 OpenAI Chat API 互转
- **特性**:
  - 基于配置驱动的转换映射
  - 支持请求和响应双向转换
  - 智能协议检测和路由
  - 工具调用格式适配
  - 流式响应支持
  - 模型参数映射（temperature, max_tokens 等）
  - 转换上下文管理（按 requestId 记录入口协议）
  - 严格模式和信任模式（trustSchema）

### 🌐 Responses → Chat 转换
- **实现文件**: `llmswitch-response-chat.ts`
- **类型**: `llmswitch-response-chat`
- **协议**: `openai-responses` → `openai`
- **功能**: OpenAI Responses API 转换为 Chat Completions 格式
- **特性**:
  - 基于 `rcc-llmswitch-core/conversion` 的标准化转换
  - 请求上下文捕获和管理
  - 工具调用格式转换
  - 响应 ID 提取和追踪
  - 自动模式检测（自动选择最佳转换策略）

### 🔄 Responses Passthrough
- **实现文件**: `llmswitch-responses-passthrough.ts`
- **类型**: `llmswitch-responses-passthrough`
- **协议**: `openai-responses` → `openai-responses`
- **功能**: Responses API 直接透传，最小转换开销
- **特性**:
  - 基本的对象形状验证
  - 元数据标记和注入
  - 最小性能开销
  - 适用于原生 Responses API 支持

### 🛠️ 转换路由器
- **实现文件**: `llmswitch-conversion-router.ts`
- **类型**: `llmswitch-conversion-router`
- **协议**: 智能路由到其他 LLMSwitch 实现
- **功能**: 根据请求类型和配置智能路由到适当的转换器
- **特性**:
  - 动态转换器选择
  - 配置驱动的路由规则
  - 多协议支持
  - 回退机制

## 📁 文件结构

```
src/modules/pipeline/modules/llmswitch/
├── conversion/                     # 转换规则和配置
│   ├── anthropic-openai-config.ts   # Anthropic-OpenAI 转换配置
│   └── ...
├── converters/                     # 转换器实现
│   └── ...
├── utils/                         # 工具函数
│   └── ...
├── llmswitch-openai-openai.ts      # OpenAI 规范化实现
├── llmswitch-anthropic-openai.ts   # Anthropic-OpenAI 双向转换
├── llmswitch-response-chat.ts       # Responses → Chat 转换
├── llmswitch-responses-passthrough.ts # Responses 透传
├── llmswitch-conversion-router.ts   # 转换路由器
├── openai-normalizer.ts            # OpenAI 规范化工具
├── anthropic-openai-config.ts      # Anthropic 配置
├── anthropic-openai-converter.ts    # Anthropic 转换器
└── README.md                      # 本文档
```

## 🚀 使用示例

### OpenAI 规范化使用
```typescript
import { OpenAINormalizerLLMSwitch } from './llmswitch-openai-openai.js';

const llmSwitch = new OpenAINormalizerLLMSwitch({
  type: 'llmswitch-openai-openai',
  config: {
    enableValidation: true,
    enableMetadata: true
  }
}, dependencies);

await llmSwitch.initialize();

// 处理 OpenAI 请求，确保格式规范
const normalizedRequest = await llmSwitch.processIncoming({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Perform calculations',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string' }
          }
        }
      }
    }
  ]
});

// 结果: 格式规范化的请求，包含工具调用验证
```

### Anthropic-OpenAI 双向转换
```typescript
import { AnthropicOpenAIConverter } from './llmswitch-anthropic-openai.js';

const converter = new AnthropicOpenAIConverter({
  type: 'llmswitch-anthropic-openai',
  config: {
    enableStreaming: true,
    enableTools: true,
    trustSchema: true,
    conversionMappings: {
      // 自定义转换映射
      requestMappings: { /* ... */ },
      responseMappings: { /* ... */ }
    }
  }
}, dependencies);

await converter.initialize();

// Anthropic 格式请求
const anthropicRequest = {
  model: 'claude-3-sonnet',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  max_tokens: 1000,
  tools: [ /* Anthropic 工具格式 */ ]
};

// 自动检测并转换为 OpenAI 格式
const openAIRequest = await converter.processIncoming(anthropicRequest);
```

## ⚙️ 配置选项

### OpenAI 规范化配置
```typescript
interface OpenAINormalizerConfig {
  enableValidation?: boolean;        // 启用严格验证
  enableMetadata?: boolean;          // 启用元数据增强
  maxLogEntries?: number;           // 最大日志条目数
}
```

### Anthropic-OpenAI 转换配置
```typescript
interface AnthropicOpenAIConfig {
  enableStreaming?: boolean;         // 启用流式转换
  enableTools?: boolean;            // 启用工具转换
  trustSchema?: boolean;            // 信任模式（不重命名工具）
  conversionMappings?: {            // 自定义转换映射
    requestMappings?: any;
    responseMappings?: any;
  };
}
```

## 🔄 转换流程

### 协议检测和转换
```typescript
// 自动协议检测（注意：动态路由由Virtual Router处理）
function detectProtocol(request: any): 'openai' | 'anthropic' | 'responses' {
  if (request.messages) return 'openai';
  if (request.input) return 'responses';
  if (request.anthropic_version) return 'anthropic';
  return 'openai'; // 默认
}

// 协议转换
const converted = await converter.processIncoming(request);
```

### 元数据注入
```typescript
// 所有转换都会注入统一的元数据
const enhancedRequest = {
  ...convertedRequest,
  _metadata: {
    switchType: 'llmswitch-xxx',
    timestamp: Date.now(),
    entryProtocol: 'detected-protocol',
    targetProtocol: 'target-protocol',
    requestId: 'generated-or-preserved-id',
    conversionContext: { /* 转换上下文 */ }
  }
};
```

## 🌐 API 协议支持

### OpenAI Chat Completions API
- **端点**: `/v1/chat/completions`
- **请求格式**: `{ messages, model, tools, tool_calls, stream }`
- **响应格式**: `{ choices, usage, id, created }`
- **特性**: 工具调用、流式响应、多轮对话

### OpenAI Responses API
- **端点**: `/v1/responses`
- **请求格式**: `{ input, model, tools, stream }`
- **响应格式**: `{ output, usage, id, created }`
- **特性**: 新一代 API、简化格式、原生工具支持

### Anthropic Claude API
- **端点**: `/v1/messages`
- **请求格式**: `{ messages, model, max_tokens, tools }`
- **响应格式**: `{ content, usage, id, created }`
- **特性**: 系统提示、工具使用、思考内容

## 🔧 扩展性

### 添加新的协议转换
```typescript
class NewProtocolConverter implements LLMSwitchModule {
  readonly type = 'llmswitch-new-protocol';
  readonly protocol = 'new-protocol';

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    // 检测协议
    const detectedProtocol = this.detectProtocol(request.data);

    // 执行转换
    const converted = await this.convertProtocol(request.data, detectedProtocol, 'target');

    // 注入元数据
    return {
      ...request,
      data: {
        ...converted,
        _metadata: {
          switchType: this.type,
          timestamp: Date.now(),
          entryProtocol: detectedProtocol,
          targetProtocol: 'target'
        }
      }
    };
  }

  private detectProtocol(data: any): string {
    // 实现协议检测逻辑
  }

  private async convertProtocol(data: any, from: string, to: string): Promise<any> {
    // 实现协议转换逻辑
  }
}
```

## 📈 版本信息

- **当前版本**: 3.0.0
- **新增特性**:
  - Responses API 支持
  - Anthropic 双向转换
  - 智能转换路由
  - 基于 `rcc-llmswitch-core` 的标准化转换
  - 与Virtual Router模块集成
- **兼容性**: RouteCodex Pipeline >= 3.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-llmswitch-core**: 核心转换引擎和工具函数
- **PipelineDebugLogger**: 模块日志记录
- **BaseModule**: 基础模块接口
- **SharedPipelineRequest/Response**: 共享数据传输对象
- **Virtual Router**: 动态路由分类模块（上游）

## 🚨 已知限制

### 当前限制
1. **协议版本支持** - 主要支持 API v1 版本
2. **实时转换** - 流式协议转换存在延迟
3. **复杂工具链** - 多步骤工具调用转换可能不完整
4. **错误恢复** - 转换失败后的回退机制有限

### 未来计划
1. **更多协议支持** - Google Gemini、Cohere 等
2. **实时流式转换** - 零延迟流式协议转换
3. **智能协议检测** - 与Virtual Router更深度的集成
4. **转换规则学习** - 基于使用模式的智能优化

## 🔄 更新日志

### v3.0.0 (2025-10-24)
- ✨ 重构为4层流水线架构的第1层
- ✨ 与Virtual Router模块分离，专注协议转换
- ✨ 新增 Responses API 完整支持
- ✨ 新增 Anthropic ↔ OpenAI 双向转换
- 🔄 基于 `rcc-llmswitch-core` 的标准化重构
- 🛡️ 增强的工具调用验证和转换
- 📊 完善的性能监控和调试支持

### v2.0.0 (2025-01-22)
- 🔧 OpenAI 规范化功能增强
- 📊 性能监控功能完善
- 🛡️ 错误处理机制优化

### v1.0.0 (2025-01-15)
- 🎯 初始版本发布
- 🔄 基础的 OpenAI 透传功能
- 📊 简单的元数据注入

## 📞 技术支持

如有问题或建议，请：
1. 检查协议格式是否符合对应 API 规范
2. 验证转换配置是否正确
3. 查看转换日志了解详细信息
4. 检查目标协议的官方文档
5. 确认与Virtual Router的集成配置正确

---

**最后更新**: 2025-10-24 - 适配4层流水线架构，专注协议转换职责