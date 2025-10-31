# Server Module

HTTP 服务与协议适配入口，承载 OpenAI/Anthropic 形状的 Chat 与 Responses 端点、SSE 流式传输等。

## 🚨 核心职责边界

### **Server模块职责范围**
- ✅ **HTTP协议处理**: 请求解析、响应格式化、状态码管理
- ✅ **认证授权**: API key验证、权限检查、访问控制
- ✅ **流式传输**: SSE事件管理、分块传输、连接控制
- ✅ **错误处理**: HTTP错误响应、异常捕获、日志记录
- ✅ **路由分发**: 请求路由到相应处理器的逻辑

### **严格禁止的职责**
- ❌ **工具调用处理**: 不实现任何工具转换或收割逻辑
- ❌ **数据格式转换**: 不修改请求/响应的业务数据格式
- ❌ **Provider适配**: 不处理provider特定的字段映射
- ❌ **业务逻辑**: 不实现AI相关的业务处理逻辑

### **正确实现模式**
```typescript
// ✅ 正确：端点只做协议处理
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // 1. HTTP协议层处理
    const authResult = await authenticateRequest(req);
    if (!authResult.success) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // 2. 直接委托给pipeline/llmswitch-core
    const result = await pipelineManager.processRequest(req.body);

    // 3. HTTP响应格式化
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ❌ 错误：端点不应处理工具逻辑
app.post('/v1/chat/completions', (req, res) => {
  // 不要这样做！工具处理应该在llmswitch-core
  if (req.messages.some(m => m.content.includes('tool_call'))) {
    req.tool_calls = extractToolCalls(req.messages);
  }

  // 应该直接透传给下游处理
  processRequest(req);
});
```

## 主要职责
- 路由到 Pipeline/Provider，整合 LLMSwitch 转换
- Chat 与 Responses 端点统一：委托llmswitch-core进行工具调用标准化
- 流式管理与连接生命周期控制

## 目录概览
- `handlers/`：请求处理器（chat-completions.ts、responses.ts 等）
- `streaming/`：SSE/分块传输管理
- `conversion/`：与 llmswitch-core 的桥接
- `utils/`：请求/响应工具

