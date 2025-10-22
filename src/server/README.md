# RouteCodex HTTP 服务器模块

RouteCodex HTTP 服务器模块提供完整的 OpenAI 兼容 API 路由与流式（SSE）桥接功能，支持 Chat Completions、Responses API 等多种协议，集成错误处理、预心跳机制和智能路由。

## 🎯 模块概述

HTTP 服务器模块是 RouteCodex 系统的核心组件，负责处理所有传入的 HTTP 请求，包括：
- **多协议支持**: OpenAI Chat Completions、Responses API、兼容格式
- **智能路由**: 基于协议类型的请求路由和流水线选择
- **流式处理**: Server-Sent Events (SSE) 流式响应桥接
- **错误处理**: 统一的错误格式和智能错误恢复
- **监控集成**: 请求追踪、性能监控和调试支持

## 🔄 支持的 API 端点

### 📡 Chat Completions API
- **端点**: `POST /v1/chat/completions`
- **协议**: OpenAI Chat Completions
- **功能**: 标准聊天对话，支持流式响应、工具调用、多轮对话
- **流水线**: `llmswitch-openai-openai` → `streaming-control` → `compatibility` → `provider`

### 🆕 Responses API ⭐（配置驱动的转换 + 解耦的流式）
- **端点**: `POST /v1/responses`
- **协议**: OpenAI Responses API
- **能力**:
  - 请求侧：按配置将 Responses 形状（instructions + input[] 的嵌套 message/content 块）合成为 OpenAI Chat messages（非扁平展开，递归解析）
  - 响应侧：Provider 的 Chat 响应按配置回转为 Responses JSON（文本、工具调用、usage）
  - 流式：SSE 仅读取已规范化的 Responses 对象发事件（可选消息生命周期/required_action/心跳），与转换逻辑彻底解耦
- **流水线**: `llmswitch-response-chat`（可配） → Provider（默认非流） → Responses 正规化 → SSE 重放
- **配置文件**:
  - `config/modules.json` → `responses` 模块（总开关）
  - `config/responses-conversion.json`（字段映射与展开规则）
  - 环境变量覆盖：`ROUTECODEX_RESP_*`

#### 配置要点
- `config/modules.json` 示例（节选）
```json
{
  "modules": {
    "responses": {
      "enabled": true,
      "config": {
        "moduleType": "responses",
        "conversion": {
          "useLlmswitch": true,
          "fallbackEnabled": true,
          "forceProviderStream": true
        },
        "sse": {
          "heartbeatMs": 5000,
          "emitTextItemLifecycle": true,
          "emitRequiredAction": true
        }
      }
    }
  }
}
```

- `config/responses-conversion.json` 控制“非扁平展开”和“文本/工具提取”：
```json
{
  "request": {
    "instructionsPaths": ["instructions"],
    "inputBlocks": {
      "wrapperType": "message",
      "typeKey": "type",
      "roleKey": "role",
      "blocksKey": "content",
      "textKey": "text",
      "allowedContentTypes": ["input_text", "text", "output_text"]
    },
    "fallback": { "useRawMessages": true, "rawMessagesPath": "messages", "pickLastUser": true }
  },
  "response": {
    "textPaths": ["output_text", "choices[0].message.content"],
    "textArrayTextKey": "text",
    "contentBlocksKey": "content",
    "messageWrapperType": "message"
  },
  "tools": {
    "toolCallTypes": ["tool_call", "function_call"],
    "functionArgsPaths": ["arguments", "tool_call.function.arguments"],
    "emitRequiredAction": true
  }
}
```

#### 行为覆盖的环境变量
- `ROUTECODEX_RESP_CONVERT_LLMSWITCH=1|0`：启用/关闭 llmswitch 转换
- `ROUTECODEX_RESP_CONVERT_FALLBACK=1|0`：启用/关闭兜底转换
- `ROUTECODEX_RESP_PROVIDER_NONSTREAM=1|0`：Provider 侧强制非流（默认 1）
- `ROUTECODEX_RESP_SSE_LIFECYCLE=1|0`：是否发送 output_item.added/content_part.added/item.done（默认 1）
- `ROUTECODEX_RESP_SSE_REQUIRED_ACTION=1|0`：是否发 required_action（默认 1）
- `ROUTECODEX_RESPONSES_HEARTBEAT_MS=0|N`：SSE 心跳（0 关闭）

### 🔧 其他兼容端点
- **端点**: `POST /v1/completions`
- **端点**: `POST /v1/embeddings`
- **功能**: 传统文本补全和嵌入接口兼容支持

## 🌟 核心功能

### 🔄 协议检测与路由
```typescript
// 自动协议检测和路由选择
async handleRequest(req: Request, res: Response): Promise<void> {
  const protocol = this.detectProtocol(req);
  const routeHandler = this.getRouteHandler(protocol);

  switch (protocol) {
    case 'chat-completions':
      await this.handleChatCompletions(req, res);
      break;
    case 'responses':
      await this.handleResponses(req, res);
      break;
    default:
      await this.handleTransparentPassthrough(req, res);
  }
}
```

### 📡 流式响应处理
```typescript
// 智能流式响应处理
class StreamingResponseHandler {
  async handleStreamingResponse(response: any, res: Response): Promise<void> {
    // 预心跳机制 - 早期错误可见性
    await this.startPreHeartbeat(res);

    // 流式数据桥接
    for await (const chunk of response.data) {
      if (this.shouldSendErrorChunk(chunk)) {
        await this.sendErrorChunk(res, chunk);
      } else {
        await this.sendStreamChunk(res, chunk);
      }
    }

    await this.sendDoneMarker(res);
  }
}
```

### 🛡️ 错误处理策略
```typescript
// 智能错误处理
class ErrorHandler {
  async handleError(error: any, req: Request, res: Response): Promise<void> {
    // 优先返回 JSON 错误（SSE 未启动时）
    if (!res.headersSent && req.body?.stream) {
      return this.sendJsonError(res, error);
    }

    // SSE 错误块（SSE 已启动时）
    if (res.headersSent) {
      return this.sendStreamingError(res, error);
    }

    // 标准 HTTP 错误
    return this.sendHttpError(res, error);
  }
}
```

## ⚙️ 配置选项

### 🌐 服务器配置
```typescript
interface ServerConfig {
  port?: number;                    // 服务器端口（默认: 5506）
  host?: string;                    // 绑定地址（默认: 0.0.0.0）
  maxConnections?: number;          // 最大连接数
  requestTimeout?: number;          // 请求超时（毫秒）
  enableCors?: boolean;             // 启用 CORS
  corsOrigin?: string;              // CORS 允许源
}
```

### 📡 流式配置
```typescript
interface StreamingConfig {
  preSseHeartbeatDelayMs?: number;  // 预心跳延迟（默认: 800ms）
  preSseHeartbeatMs?: number;       // 预心跳间隔（默认: 3000ms）
  sseHeartbeatMs?: number;          // SSE 心跳间隔（默认: 15000ms）
  sseHeartbeatMode?: 'chunk' | 'comment'; // 心跳模式
  sseHeartbeatUseReasoning?: boolean; // 是否使用 reasoning_content
}
```

### 🛡️ 错误处理配置
```typescript
interface ErrorHandlingConfig {
  enableDetailedErrors?: boolean;   // 启用详细错误信息
  includeStackTrace?: boolean;      // 包含错误堆栈
  maxErrorDetailLength?: number;    // 最大错误详情长度
  logErrorsToConsole?: boolean;     // 控制台错误日志
}
```

## 🔧 环境变量

### 🌐 服务器配置
- `ROUTECODEX_PORT` - 服务器端口（默认: 5506）
- `ROUTECODEX_HOST` - 绑定地址（默认: 0.0.0.0）
- `ROUTECODEX_MAX_CONNECTIONS` - 最大连接数（默认: 1000）

### 📡 流式处理
- `ROUTECODEX_PRE_SSE_HEARTBEAT_DELAY_MS` - 预心跳延迟（默认: 800）
- `ROUTECODEX_PRE_SSE_HEARTBEAT_MS` - 预心跳间隔（默认: 3000）
- `ROUTECODEX_SSE_HEARTBEAT_MS` - SSE 心跳间隔（默认: 15000）
- `ROUTECODEX_SSE_HEARTBEAT_MODE` - 心跳模式：`chunk|comment`（默认: chunk）
- `ROUTECODEX_SSE_HEARTBEAT_USE_REASONING` - 使用 reasoning_content（默认: 0）

### 🛡️ 错误处理
- `ROUTECODEX_ENABLE_DETAILED_ERRORS` - 启用详细错误（默认: 1）
- `ROUTECODEX_INCLUDE_STACK_TRACE` - 包含堆栈信息（默认: 0）
- `ROUTECODEX_MAX_ERROR_DETAIL_LENGTH` - 最大错误详情长度（默认: 500）

## 🚀 使用示例

### 基本服务器启动
```typescript
import { RouteCodexServer } from './http-server.js';

const server = new RouteCodexServer({
  port: 5506,
  host: '0.0.0.0',
  enableCors: true,
  corsOrigin: '*'
});

await server.start();
console.log('RouteCodex Server running on port 5506');
```

### Chat Completions 请求
```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": true
  }'
```

### Responses API 请求 ⭐
```bash
curl -X POST http://localhost:5506/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "instructions": "You are a helpful assistant.",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          {"type": "input_text", "text": "Explain quantum computing"}
        ]
      }
    ],
    "tools": [
      {
        "type": "function",
        "name": "calculate",
        "description": "Perform calculations",
        "parameters": {
          "type": "object",
          "properties": {
            "expression": {"type": "string"}
          }
        }
      }
    ],
    "stream": true
  }'
```

### Responses SSE 实现细节（关键约定）
- 事件顺序（工具优先常见路径）：
  1) `response.created` → 2) `response.in_progress`
  3) `response.output_item.added`(reasoning, `output_index=0`)
  4) `response.reasoning_summary_part.added`(summary_index=0)
  5) 多个 `response.reasoning_summary_text.delta`（含 `obfuscation` 占位）
  6) `response.reasoning_summary_text.done` → `response.reasoning_summary_part.done`
  7) 重复 4–6（summary_index=1）
  8) `response.output_item.added`(function_call, `output_index=2`)
  9) `response.content_part.added`(input_json)
  10) 多个 `response.function_call_arguments.delta`
  11) `response.function_call_arguments.done`
  12) `response.output_item.done`(function_call)
  13) `response.completed`

- 事件顺序（文本优先）：在 reasoning 之后、function_call 之前插入 message 文本生命周期：
  - `response.output_item.added`(message, `output_index=1`) → `response.content_part.added` → 多个 `response.output_text.delta` → `response.output_text.done` → `response.content_part.done` → `response.output_item.done`(message)

- 必备字段与索引（与上游对齐）：
  - 全事件携带 `sequence_number`，从 0 起每次 +1。
  - `created_at`（秒）用于 `response.{created|in_progress|completed}.response.created_at`。
  - `output_index` 固定映射：`0=reasoning`、`1=message`、`2=function_call`。`content_index` 目前恒为 0。
  - reasoning：
    - `response.output_item.added`(reasoning) → `item` 含 `{ id, type: "reasoning", encrypted_content, summary: [] }`。
    - `response.reasoning_summary_part.added/done`、`response.reasoning_summary_text.delta/done`：均含 `item_id/output_index/summary_index`；`delta` 伴随 `obfuscation`（占位即可）。
  - message：
    - `response.output_item.added`(message) → `item` 含 `{ id, type: "message", role: "assistant", status: "in_progress", content: [] }`。
    - `response.content_part.added`(message) → `part: { type: "output_text", annotations: [], logprobs: [], text: "" }`。
    - `response.output_text.delta/done` 必带 `item_id/output_index/content_index/logprobs`（空数组可接受）。
  - function_call：
    - `response.output_item.added`(function_call) → `item` 含 `{ id, type: "function_call", call_id, name, status: "in_progress", arguments: "" }`。
    - `response.content_part.added`(function_call) → `part: { type: "input_json", partial_json: "" }`。
    - `response.function_call_arguments.delta` → `item_id/output_index/delta`；`done` → `item_id/output_index/arguments/name`。
    - `response.output_item.done`(function_call) → 回填 `{ status: "completed", arguments, call_id, name }`。
  - `response.completed`：`response` 内包含 `output` 数组（按顺序聚合 reasoning/message/function_call）与 `usage.input_tokens|output_tokens|total_tokens`。无顶层 usage/required_action。

- 文本生命周期的发送策略（防止“空消息重发”）：
  - 仅当确有文本增量时才发送 message 文本生命周期（有 `output_text.delta` 才会出现 message 的 added/done）。
  - 工具优先判定同时识别 `function_call/tool_call/tool_use`，避免漏判导致“空消息骨架”。

- 不发送的事件：
  - 不发送 `response.required_action`（Responses SSE 中不使用该事件）。

- 工具执行策略：
  - 服务器端不执行任何工具；工具由客户端执行并决定是否发起下一轮请求。

- 心跳：
  - 可通过 `responses.sse.heartbeatMs`（或 `ROUTECODEX_RESPONSES_HEARTBEAT_MS`）配置。>0 时以 SSE 注释方式发送心跳保持连接；默认 5000ms。

- 映射与配置：
  - 请求映射：`responses` → `chat` 由 `llmswitch-response-chat` 与 `config/responses-conversion.json` 驱动，做 instructions→system、input[] 非扁平展开与工具萃取。
  - 响应映射：`chat` → `responses` 统一输出 `created_at`、`function_call`，并在 SSE 层按上述事件族规范化重放。
  - 相关实现位置：
    - 事件重放：`src/server/handlers/responses.ts`
    - 请求/响应映射：`src/modules/pipeline/modules/llmswitch/llmswitch-response-chat.ts`、`src/server/conversion/responses-mapper.ts`
    - 配置：`config/responses-conversion.json`、`src/server/config/responses-config.ts`

> 提示：若迁移旧客户端，务必检查其是否依赖 `response.required_action` 或非 0 起始的 `sequence_number`。本实现严格按 Responses 规范与上游抓包对齐。

## 📊 监控与调试

### 请求追踪
```typescript
// 自动请求追踪
server.on('request', (req, res, requestId) => {
  console.log(`[${requestId}] ${req.method} ${req.url}`);
});

server.on('response', (req, res, requestId, responseTime) => {
  console.log(`[${requestId}] Completed in ${responseTime}ms`);
});
```

### 错误监控
```typescript
// 错误事件监听
server.on('error', (error, req, requestId) => {
  console.error(`[${requestId}] Error:`, error);

  // 发送到监控系统
  monitoringService.recordError(error, {
    requestId,
    endpoint: req.url,
    method: req.method
  });
});
```

### 性能指标
```typescript
// 性能监控
const metrics = server.getMetrics();
console.log({
  totalRequests: metrics.totalRequests,
  activeConnections: metrics.activeConnections,
  averageResponseTime: metrics.averageResponseTime,
  errorRate: metrics.errorRate,
  streamingRequests: metrics.streamingRequests
});
```

## 🛡️ 错误映射

### 统一错误格式
```typescript
interface OpenAIErrorResponse {
  error: {
    message: string;           // 错误信息
    type: string;             // 错误类型
    code: string;             // 错误代码
    details?: {               // 调试详情
      requestId: string;
      provider: string;
      upstreamStatus: number;
      pipelineError?: string;
    };
  };
}
```

### 错误类型映射
- `invalid_request_error` - 请求格式错误
- `authentication_error` - 认证失败
- `permission_denied_error` - 权限不足
- `not_found_error` - 资源不存在
- `rate_limit_error` - 请求频率限制
- `api_error` - API 内部错误
- `overloaded_error` - 服务过载
- `server_error` - 服务器内部错误

## 🔄 近期更新

### v2.0.0 (2025-10-17) - Responses API 支持
- ✨ 新增 `/v1/responses` 端点完整支持
- 🆕 实现 Responses → Chat 协议转换流水线
- 📡 增强流式事件处理和响应重建
- 🛡️ 改进错误处理和预心跳机制
- 📊 完善监控和调试功能

### v1.5.0 - 错误可见性优化
- 🔄 优先返回 JSON 错误策略
- 📡 SSE 错误块格式优化
- ⏱️ 预心跳延迟窗口
- 🛡️ 智能错误路径选择

## 🚨 已知限制

### 当前限制
1. **协议混合** - 不支持单个请求中的多协议混合
2. **并发流式** - 大量并发流式连接可能影响性能
3. **大文件上传** - 大型请求体的内存处理限制
4. **WebSocket** - 当前不支持 WebSocket 连接

### 计划改进
1. **连接池管理** - 优化连接复用和资源管理
2. **协议扩展** - 支持更多 AI 协议
3. **实时优化** - 减少流式响应延迟
4. **负载均衡** - 多实例负载均衡支持

## 🔧 扩展性

### 添加新的 API 端点
```typescript
// 自定义端点处理器
class CustomEndpointHandler implements EndpointHandler {
  async handleRequest(req: Request, res: Response): Promise<void> {
    // 实现自定义端点逻辑
    const protocol = this.detectCustomProtocol(req);
    const response = await this.processCustomRequest(req, protocol);

    await this.sendResponse(res, response);
  }
}

// 注册新端点
server.registerEndpoint('/v1/custom', new CustomEndpointHandler());
```

### 自定义中间件
```typescript
// 请求中间件
server.use(async (req, res, next) => {
  // 请求预处理
  req.startTime = Date.now();
  req.requestId = generateRequestId();

  await next();
});

// 响应中间件
server.use(async (req, res, next) => {
  // 响应后处理
  const responseTime = Date.now() - req.startTime;
  console.log(`Request ${req.requestId} completed in ${responseTime}ms`);

  await next();
});
```

## 📈 性能优化建议

### 📡 流式响应优化
- **预心跳延迟**: 适当增加延迟以提升错误可见性
- **心跳间隔**: 根据网络条件调整心跳频率
- **缓冲策略**: 使用合适的缓冲区大小

### 🛡️ 错误处理优化
- **快速失败**: 在早期阶段检测和返回错误
- **错误缓存**: 避免重复错误处理
- **监控集成**: 及时发送错误指标到监控系统

### 🌐 服务器优化
- **连接管理**: 设置合适的连接数限制
- **超时配置**: 根据业务需求调整超时时间
- **资源清理**: 定期清理无效连接和缓存

## 🔗 依赖关系

- **Express.js**: HTTP 服务器框架
- **RouteCodex Pipeline**: 请求处理流水线
- **Protocol Handler**: 协议处理和路由
- **Error Handling Center**: 错误处理集成
- **Monitoring System**: 监控和指标收集
- **Logging System**: 日志记录和调试

---

**最后更新**: 2025-10-17 - 全面更新 HTTP 服务器模块文档，新增 Responses API 支持和完整的协议路由说明
