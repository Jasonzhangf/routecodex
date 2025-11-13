# Usage数据处理完整分析报告

## 概述

本文档详细分析了RouteCodex项目中的Usage数据处理机制，包括claude-code-router的Usage代理处理和RouteCodex自身的Usage生成机制。

---

## Part 1: claude-code-router Usage处理机制

### 架构概述

（更新）已移除 `@musistudio/llms` 依赖与相关通路，统一由 RouteCodex 与 llmswitch-core 直接对齐客户端/上游协议形状：

```
客户端请求 → RouteCodex → AI服务提供商
```

### Usage数据结构

```typescript
interface Usage {
  input_tokens: number;  // 输入token数
  output_tokens: number; // 输出token数
}
```

### Usage数据收集机制

#### 1. 流式响应处理（RouteCodex 直接处理）

**位置**: `src/index.ts:272-291`

```typescript
// 复制响应流用于监控usage
const [originalStream, clonedStream] = payload.tee();

// 监听SSE流中的usage数据
const read = async (stream: ReadableStream) => {
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const dataStr = new TextDecoder().decode(value);
    if (!dataStr.startsWith("event: message_delta")) {
      continue;
    }
    
    // 提取usage数据并缓存
    const str = dataStr.slice(27); // 移除 "event: message_delta" 前缀
    try {
      const message = JSON.parse(str);
      sessionUsageCache.put(req.sessionId, message.usage);
    } catch {}
  }
};

read(clonedStream);
return originalStream; // 返回原始流给客户端
```

#### 2. 非流式响应处理

**位置**: `src/index.ts:293`

```typescript
// 直接从响应payload获取usage并缓存
sessionUsageCache.put(req.sessionId, payload.usage);
return payload; // 返回完整响应给客户端
```

### 缓存机制

**位置**: `src/utils/cache.ts`

```typescript
export const sessionUsageCache = new LRUCache<string, Usage>(100);
```

- **类型**: LRU缓存
- **容量**: 100个会话
- **键**: sessionId
- **值**: Usage对象

### Usage数据应用场景

#### 1. 智能模型选择

**位置**: `src/utils/router.ts:87-103`

```typescript
const longContextThreshold = config.Router.longContextThreshold || 60000;
const lastUsageThreshold = 
  lastUsage && 
  lastUsage.input_tokens > longContextThreshold && 
  tokenCount > 20000;

// 根据上一次使用情况决定是否使用长上下文模型
if ((lastUsageThreshold || tokenCountThreshold) && config.Router.longContext) {
  return config.Router.longContext;
}
```

#### 2. 状态栏显示

**位置**: `src/utils/statusline.ts:474-475`

```typescript
if (message.message.usage) {
  inputTokens = message.message.usage.input_tokens;
  outputTokens = message.message.usage.output_tokens;
}
```

#### 3. 使用量格式化显示

**位置**: `src/utils/statusline.ts:302-309`

```typescript
function formatUsage(input_tokens: number, output_tokens: number): string {
  if (input_tokens > 1000 || output_tokens > 1000) {
    const inputFormatted = input_tokens > 1000 ? `${(input_tokens / 1000).toFixed(1)}k` : `${input_tokens}`;
    const outputFormatted = output_tokens > 1000 ? `${(output_tokens / 1000).toFixed(1)}k` : `${output_tokens}`;
    return `${inputFormatted} ${outputFormatted}`;
  }
  return `${input_tokens} ${output_tokens}`;
}
```

### 关键发现

#### Usage数据流向

1. **RouteCodex → @musistudio/llms**: 响应中包含usage数据
2. **@musistudio/llms → claude-code-router**: 通过payload传递
3. **claude-code-router**: 监控和缓存usage，**不修改原始响应**
4. **客户端**: 收到完整的原始响应，包括usage数据

#### Stream TEE机制

```typescript
const [originalStream, clonedStream] = payload.tee();
```

- **originalStream**: 返回给客户端（包含usage）
- **clonedStream**: 用于内部监控usage数据

#### 结论

**claude-code-router完全保持了usage数据的完整性**：
1. **透传机制**: usage数据通过原始响应流完整返回给客户端
2. **无损处理**: TEE机制确保原始流不被修改
3. **额外功能**: 内部缓存usage用于智能路由决策
4. **格式保持**: 客户端收到的usage格式与RouteCodex返回的完全一致

---

## Part 2: RouteCodex Usage生成机制

### Chat端点Usage处理

#### 路由定义

**位置**: `src/server/http-server.ts:62`

```typescript
this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  await this.handlePipelineRequest(req, res, '/v1/chat/completions');
});
```

#### SSE流中的Usage输出

**位置**: `src/server/http-server.ts:284-296`

```typescript
// Always emit completed with usage normalization
try {
  const base: any = finalJson ?? { id: respId, object: 'response', created_at, model, status: 'completed' };
  const u: any = (base as any).usage || {};
  const iu = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
  const ou = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
  const tt = typeof u.total_tokens === 'number' ? u.total_tokens : (iu + ou);
  base.usage = { input_tokens: iu, output_tokens: ou, total_tokens: tt };
  write({ type: 'response.completed', response: base });
  completed = true;
} catch {}
```

#### Responses端点Usage处理

**位置**: `src/server/http-server.ts:314-318`

```typescript
const u: any = (finalJson as any)?.usage || {};
const iu = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
const ou = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
const tt = typeof u.total_tokens === 'number' ? u.total_tokens : (iu + ou);
const base: any = { id: respId, object: 'response', created_at, model, status: 'completed', usage: { input_tokens: iu, output_tokens: ou, total_tokens: tt } };
```

### Usage数据标准化

RouteCodex实现了usage数据的标准化处理：

```typescript
// 支持多种usage格式并标准化为统一格式
const iu = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
const ou = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
const tt = typeof u.total_tokens === 'number' ? u.total_tokens : (iu + ou);
```

### llmswitch-core中的Usage类型定义

**位置**: `sharedmodule/llmswitch-core/src/v2/api/llmswitch-types.ts:58-95`

```typescript
// Chat Completion类型
usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

// Messages API类型
usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
```

---

## Part 3: 完整数据流分析

### Chat端点完整流程

```
客户端请求 (/v1/chat/completions)
    ↓
RouteCodex V1 Pipeline
    ↓
llmswitch-core处理
    ↓
Provider层 (OpenAI/Anthropic等)
    ↓
AI服务提供商响应 (含usage)
    ↓
RouteCodex标准化usage
    ↓
SSE流输出 (含usage)
    ↓
claude-code-router监听和缓存
    ↓
原始流返回客户端 (含usage)
```

### Usage数据格式兼容性

#### OpenAI格式
```json
{
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 80,
    "total_tokens": 230
  }
}
```

#### Anthropic格式  
```json
{
  "usage": {
    "input_tokens": 150,
    "output_tokens": 80
  }
}
```

#### RouteCodex标准化格式
```json
{
  "usage": {
    "input_tokens": 150,
    "output_tokens": 80,
    "total_tokens": 230
  }
}
```

---

## Part 4: 关键发现和建议

### 关键发现

1. **Chat端点支持Usage返回**: RouteCodex的`/v1/chat/completions`端点完全支持usage数据返回
2. **格式标准化**: RouteCodex将不同提供商的usage格式标准化为统一格式
3. **无损代理**: claude-code-router通过TEE机制确保usage数据无损传递给客户端
4. **智能缓存**: claude-code-router使用usage缓存进行智能模型选择

### 技术优势

1. **兼容性**: 支持多种usage格式并自动标准化
2. **透明性**: usage数据完整透传，客户端无感知
3. **智能化**: 基于历史usage数据进行路由决策
4. **可靠性**: LRU缓存机制防止内存泄漏

### 性能特点

1. **流式处理**: 实时usage数据处理，无需等待完整响应
2. **内存优化**: 100个会话的LRU缓存，平衡性能和内存使用
3. **异步处理**: usage监听与主请求流并行，不阻塞响应

---

## 总结

RouteCodex和claude-code-router形成了一个完整的usage数据处理生态系统：

- **RouteCodex**: 负责usage数据生成、标准化和SSE流输出
- **claude-code-router**: 负责usage数据监听、缓存和智能路由
- **客户端**: 接收到完整的usage数据，与直接调用RouteCodex体验一致

这个架构确保了usage数据的完整性、透明性和智能化处理，为用户提供了无缝的token使用量跟踪和模型优化能力。

---

**生成时间**: $(date)
**分析范围**: RouteCodex V1/V2架构 + claude-code-router代理机制
**文档版本**: 1.0
