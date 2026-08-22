# Web Search Server-side Tool 第三跳修复

**修复日期:** 2025-12-30  
**影响范围:** `src/server/runtime/http-server/request-executor.ts`  
**问题类型:** Server-side tool 第三跳请求构建错误

---

## 问题描述

在实现 `web_search` server-side tool 时,第三跳(将搜索结果返回给主模型)的请求构建不正确,导致:
- 消息历史混乱
- 工具执行结果配对失败
- 主模型无法正确处理搜索结果

### 正确的三跳流程

1. **第一跳 (主模型调用):**
   - 用户请求 → Chat Process → 主模型
   - 主模型识别需要 web_search → 返回 tool_call

2. **第二跳 (执行 web_search):**
   - 拦截 tool_call → 调用搜索后端(如 GLM)
   - **单独执行**(不带原始请求上下文,走特殊通道)
   - 返回搜索结果

3. **第三跳 (返回主模型):**
   - **在 Chat Process 层面**显式组装:
     - 原始用户请求(来自 `__chat_process_raw`)
     - + Assistant 的 tool_call 消息
     - + Tool 执行结果
   - 重新发送到虚拟路由器 → 主模型生成最终答案

---

## 根本原因

### 1. **原始请求克隆位置错误**

**错误实现:**
```typescript
// 在 Chat Process 循环中克隆 input.body
const originalRequestSnapshot = this.cloneRequestPayload(input.body);
```

**问题:**
- `input.body` 已经被预处理过(如注入系统提示词)
- 不是"干净"的 chat 协议版本请求
- 导致第三跳重复应用修改

### 2. **缺少 Chat Process Raw 的概念**

需要区分两个不同的"原始请求":
- `__raw_request_body`: handler 入口的原始协议(chat/responses/messages)
- **`__chat_process_raw`**: Chat Process 入口已转换为 **chat 协议** 的请求 ← **新增**

### 3. **第三跳消息组装逻辑不完整**

**错误实现:**
```typescript
// 直接使用 core 返回的 body,没有显式控制消息历史
body: reenterOpts.body
```

**问题:**
- 依赖 `llmswitch-core` 内部逻辑组装 messages
- 如果 core 的实现有问题或使用了错误的 base,第三跳就会出错
- 没有显式保证"原始消息 + tool_call + tool_result"的顺序

---

## 修复方案

### 改动 1: 在 Chat Process 入口克隆 `__chat_process_raw`

**位置:** `HubRequestExecutor.execute()` 循环开始处

**实现:**
```typescript
// 在第一次迭代时克隆 chat 协议版本的请求
if (attempt === 0 && !iterationMetadata.__chat_process_raw) {
  const isChatEndpoint = 
    input.entryEndpoint.includes('/v1/chat/completions') ||
    input.entryEndpoint.includes('/v1/responses') ||
    input.entryEndpoint.includes('/v1/messages');
  
  if (isChatEndpoint) {
    // 克隆当前的 input.body (此时已经是 inbound 转换后的 chat 协议格式)
    iterationMetadata.__chat_process_raw = this.cloneRequestPayload(input.body);
    this.logStage('chat.process.raw.cloned', providerRequestId, {
      endpoint: input.entryEndpoint,
      hasMessages: Boolean(input.body && typeof input.body === 'object' && 'messages' in input.body)
    });
  }
}

// 获取原始请求快照 (优先使用 chat_process_raw)
const originalRequestSnapshot = iterationMetadata.__chat_process_raw && 
  typeof iterationMetadata.__chat_process_raw === 'object'
    ? (iterationMetadata.__chat_process_raw as Record<string, unknown>)
    : this.cloneRequestPayload(input.body);
```

**关键点:**
- ✅ 只在 **第一次迭代** (`attempt === 0`) 克隆
- ✅ 只对 chat 相关端点生效
- ✅ 克隆的是 **inbound 转换后的 chat 协议格式**
- ✅ 通过 `iterationMetadata` 传递,支持多轮循环

### 改动 2: 第三跳显式组装消息历史 (仅 chat 协议)

**位置:** `convertProviderResponseIfNeeded()` 内的 `reenterPipeline` 回调

**实现:**
```typescript
const reenterPipeline = async (reenterOpts) => {
  const targetEndpoint = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
  const isChatEndpoint = targetEndpoint.includes('/v1/chat/completions');
  
  let finalBody = reenterOpts.body;
  
  // Chat 协议的第三跳显式组装逻辑
  if (isChatEndpoint) {
    const chatProcessRaw = metadataBag?.__chat_process_raw;
    
    if (chatProcessRaw && typeof chatProcessRaw === 'object') {
      const rawRequest = chatProcessRaw as Record<string, unknown>;
      const incomingBody = reenterOpts.body;
      
      // 从 core 返回的 body 中提取 assistant 和 tool 消息
      const incomingMessages = Array.isArray(incomingBody?.messages)
        ? incomingBody.messages : [];
      
      const assistantMessages = incomingMessages.filter(
        (msg: any) => msg && msg.role === 'assistant' && msg.tool_calls
      );
      const toolMessages = incomingMessages.filter(
        (msg: any) => msg && msg.role === 'tool'
      );
      
      const originalMessages = Array.isArray(rawRequest.messages)
        ? rawRequest.messages : [];
      
      // 重新组装: 原始消息 + assistant tool_call + tool result
      const reconstructedMessages = [
        ...originalMessages,
        ...assistantMessages,
        ...toolMessages
      ];
      
      // 构建第三跳的请求体(基于 chat_process_raw)
      finalBody = {
        ...rawRequest,  // 保留原始的 model 等字段
        messages: reconstructedMessages
      };
      
      this.logStage('chat.process.hop3.assembled', reenterOpts.requestId, {
        originalMessageCount: originalMessages.length,
        assistantMessageCount: assistantMessages.length,
        toolMessageCount: toolMessages.length,
        finalMessageCount: reconstructedMessages.length
      });
    }
  }
  
  // 传递 __chat_process_raw 到下一跳,支持多轮 tool 调用
  const nestedMetadata = {
    ...metadataBag,
    ...reenterOpts.metadata,
    serverToolFollowup: true,
    __chat_process_raw: metadataBag?.__chat_process_raw
  };
  
  return await this.execute({
    ...nestedInput,
    body: finalBody  // 使用显式组装的 body
  });
};
```

**关键点:**
- ✅ **仅对 `/v1/chat/completions` 生效**(其他协议走标准转换)
- ✅ 基于 `__chat_process_raw` 重新组装完整消息历史
- ✅ 明确提取 assistant tool_call 和 tool result
- ✅ 保留原始请求的其他字段(如 `model`)
- ✅ 传递 `__chat_process_raw` 到下一跳,支持多轮工具调用

---

## 新增日志

### `chat.process.raw.cloned`
- **触发时机:** Chat Process 第一次迭代,成功克隆 chat_process_raw
- **用途:** 确认克隆时机和内容
- **字段:**
  - `endpoint`: 入口端点
  - `hasMessages`: 是否包含 messages 字段

### `chat.process.hop3.assembled`
- **触发时机:** 第三跳成功组装消息历史
- **用途:** 验证消息组装正确性
- **字段:**
  - `originalMessageCount`: 原始用户消息数量
  - `assistantMessageCount`: assistant tool_call 消息数量
  - `toolMessageCount`: tool result 消息数量
  - `finalMessageCount`: 最终消息总数

### `chat.process.hop3.fallback`
- **触发时机:** 缺少 `__chat_process_raw`,降级使用 core 提供的 body
- **用途:** 诊断异常情况
- **字段:**
  - `reason`: 降级原因(如 `missing_chat_process_raw`)

---

## 验证要点

### 1. 检查日志顺序
正常流程应该看到:
```
[chat.process.raw.cloned] endpoint=/v1/chat/completions hasMessages=true
[chat.process.hop3.assembled] originalMessageCount=1 assistantMessageCount=1 toolMessageCount=1 finalMessageCount=3
```

### 2. 验证第三跳请求
- messages[0]: 原始用户请求(role=user)
- messages[1]: assistant tool_call(role=assistant, 包含 tool_calls)
- messages[2]: tool result(role=tool, tool_call_id 匹配)

### 3. 确认协议隔离
- `/v1/chat/completions`: 走显式组装逻辑
- `/v1/responses`, `/v1/messages`: 走标准 inbound/outbound 转换

---

## 影响范围

### ✅ 修复的场景
- `/v1/chat/completions` 端点的 `web_search` 工具调用
- 多轮工具调用场景(连续的 tool_call)

### ⚠️ 不受影响的场景
- `/v1/responses` 端点(依赖 llmswitch-core 的标准转换)
- `/v1/messages` (Anthropic) 端点(依赖标准转换)
- 客户端侧工具调用(submit_tool_outputs)

---

## 后续优化建议

1. **扩展到其他端点:**
   - 考虑为 `/v1/responses` 实现类似的显式组装逻辑
   - 需要适配 responses 协议的消息历史格式

2. **增强错误处理:**
   - 如果第三跳组装失败,记录详细的诊断信息
   - 提供降级机制,避免整个请求失败

3. **性能优化:**
   - `__chat_process_raw` 的克隆可以惰性执行(只在检测到 tool_call 时克隆)
   - 减少不必要的 JSON 序列化/反序列化

4. **单元测试:**
   - 添加第三跳消息组装的单元测试
   - 覆盖边界情况(如空消息、多个 tool_call 等)
