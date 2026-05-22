# Windsurf Provider 响应链条审计报告

**审计时间**: 2026-05-22（第二阶段）
**审计范围**: RouteCodex `windsurf-chat-provider.ts` 响应解析链路 vs WindsurfAPI 真实响应协议
**审计性质**: 只读审计，无代码修改
**真源对齐**: `/Volumes/extension/code/WindsurfAPI`

---

## 1. 响应链路架构对比

### RouteCodex 当前链路（旧错误链路观察）
```
fetchWithTimeout (HTTP POST GetChatCompletions)
  → readFetchResponseBuffer → parseGetChatMessageResponse
    → buildCascadeCompletionFromOutput
      → HTTP server 层
```

### WindsurfAPI 真实链路（streaming）
```
client.rawGetChatMessage / client.cascadeChat
  → gRPC stream (HTTP/2)
    → parseRawResponse / parseTrajectorySteps
      → onChunk({ text, thinking, nativeToolCall, toolCalls })
        → SSE stream → chat.js → openAIToAnthropic / ChatCompletion chunk
```

**关键差异（2026-05-22 已升级为根因级判定）**:
- WindsurfAPI 真源主链使用 **StartCascade / SendUserCascadeMessage / GetCascadeTrajectorySteps**
- RouteCodex 此处审计的仍是旧 **GetChatCompletions** 分支
- 因此本报告以下内容只用于说明“旧错误链路的响应解析行为”，**不再表示该链路可继续保留或修补**

最黑盒结果已经证明：
- 当前优先问题是**路径错误**
- 不是继续在 `GetChatCompletions` 响应解析上做局部对齐

后续唯一正确方向是：
- request: `StartCascade -> SendUserCascadeMessage`
- response: `GetCascadeTrajectorySteps / poll` 真链收口

---

## 2. 响应 frame 解析审计（仅保留为旧错误链路取证）

### 2.1 HTTP response frame 格式

WindsurfAPI 的 HTTP/Connect 响应帧格式（`windsurf.js:parseRawResponse`）:
```javascript
// 每帧: [1-byte flags][4-byte length][payload]
```

RouteCodex 的 frame 解析（`parseGetChatMessageResponse`）:
```typescript
const flags = bytes[offset] ?? 0;
const length = bytes.readUInt32BE(offset + 1);
const payloadBytes = bytes.subarray(offset + 5, offset + 5 + length);
```

**评估**: 格式一致。✅ 对齐

### 2.2 delta 字段名兼容性

| 语义 | RouteCodex 接受 | WindsurfAPI 发送 | 状态 |
|------|---------------|----------------|------|
| text delta | `deltaText` / `delta_text` | `deltaText` | ✅ 对齐 |
| thinking delta | `deltaThinking` / `delta_thinking` | `deltaThinking` | ✅ 对齐 |
| tool call delta | `deltaToolCalls` / `delta_tool_calls` | `deltaToolCalls` | ✅ 对齐 |

**代码**:
```typescript
// RouteCodex
if (typeof payload.deltaText === 'string') { textPart += payload.deltaText; }
else if (typeof payload.delta_text === 'string') { textPart += String(payload.delta_text); }
```

**评估**: 双字段名兜底兼容，语义对齐。✅

### 2.3 usage 字段名兼容性

| 字段 | RouteCodex 接受 | WindsurfAPI 发送 | 状态 |
|------|---------------|----------------|------|
| input tokens | `inputTokens` / `input_tokens` | `inputTokens` | ✅ 对齐 |
| output tokens | `outputTokens` / `output_tokens` | `outputTokens` | ✅ 对齐 |
| cache read tokens | `cacheReadTokens` / `cache_read_tokens` | `cacheReadTokens` | ✅ 对齐 |

**评估**: 多字段名兜底兼容，语义对齐。✅

---

## 3. Tool call 解析审计

### 3.1 deltaToolCalls 子字段

WindsurfAPI 真实响应中 `deltaToolCalls` 条目字段:
- `id`: tool call id
- `name`: function name
- `argumentsJson`: JSON string of arguments

RouteCodex 接受多种别名:
```typescript
const argumentsJson = typeof row.argumentsJson === 'string'
  ? row.argumentsJson
  : typeof row.arguments_json === 'string'
    ? String(row.arguments_json)
    : typeof row.input === 'string'
      ? JSON.stringify({ input: row.input })
      : row.input && typeof row.input === 'object'
        ? stableStringify(row.input)
        : '{}';
```

**评估**: RouteCodex 接受更多别名（`arguments_json`, `input`），兼容性更宽。✅ 无 gap

---

## 4. 完成体构建审计

### 4.1 buildCascadeCompletionFromOutput

RouteCodex 输出:
```typescript
{
  id: `chatcmpl-${randomUUID()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: payload.model,
  choices: [{
    index: 0,
    message: parsed,  // { role: 'assistant', content, reasoning_content?, tool_calls? }
    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  }],
  usage: {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
  },
}
```

**WindsurfAPI (chat.js → nonStreamResponse)**:
```javascript
{
  id: `chatcmpl-${uuid()}`,
  object: 'chat.completion',
  created,
  model,
  choices: [{
    index: 0,
    message: { role: 'assistant', content: text, reasoning_content?, tool_calls? },
    finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
  }],
  usage: { prompt_tokens, completion_tokens, ... },
}
```

**评估**: shape 完全对齐。✅

---

## 5. SSE Streaming 路径审计

### 5.1 wantsUpstreamSse 实现

RouteCodex:
```typescript
protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
  if (request && typeof request === 'object') {
    const body = (request as Record<string, unknown>).body;
    if (body && typeof body === 'object' && (body as Record<string, unknown>).stream) return true;
    if ((request as Record<string, unknown>).stream) return true;
  }
  return super.wantsUpstreamSse(request, context);
}
```

**当前行为**: 当请求带 `stream: true` 时返回 true，但 `sendRequestInternal` 没有 SSE 处理分支，仍然走 non-stream 聚合路径。

### 5.2 Gap 分析（旧错误链路内部观察）

| 场景 | wantsUpstreamSse | 实际处理 | 状态 |
|------|-----------------|---------|------|
| `stream: false` | false | non-stream 聚合 | ✅ 正常 |
| `stream: true` | true | **仍走 non-stream** | ⚠️ gap |

**影响**: 客户端请求 SSE streaming 时，当前实现仍做聚合后返回单一完成体，而非 SSE 流。可能影响首 token 延迟，但功能上返回完整结果。

**是否需要修复**:
- 对旧 `GetChatCompletions` 链路本身，已不再是优先修复项；
- 只有在正确 `StartCascade / SendUserCascadeMessage / poll` 主链接回后，才有资格重新讨论 streaming 收口细节。

---

## 6. 错误分类审计（响应阶段）

### 6.1 响应阶段错误分类

| 错误类型 | RouteCodex | WindsurfAPI | 状态 |
|---------|-----------|------------|------|
| empty cascade candidate | ✅ `WINDSURF_RESPONSE_PARSE_FAILED` | ✅ `throw` | 对齐 |
| truncated connect frame | ✅ `WINDSURF_RESPONSE_PARSE_FAILED` | ✅ 校验 | 对齐 |
| invalid json payload | ✅ `WINDSURF_RESPONSE_PARSE_FAILED` | ✅ 校验 | 对齐 |
| upstream payload error | ✅ `classifyWindsurfUpstreamPayloadError` | ✅ 校验 | 对齐 |
| upstream transient | ✅ `WINDSURF_UPSTREAM_TRANSIENT` | ✅ `upstreamTransientErrorMessage` | **已对齐**（本轮补齐） |
| policy blocked | ✅ `WINDSURF_POLICY_BLOCKED` (451) | ✅ `isPolicyBlocked` | **已对齐**（本轮补齐） |

---

## 7. 审计结论汇总

### 7.1 已对齐项（✅）
1. HTTP response frame 格式（flags + length + payload）
2. delta 字段名兼容性（`deltaText`/`delta_text`）
3. thinking delta 字段名兼容性（`deltaThinking`/`delta_thinking`）
4. tool call delta 字段名兼容性（`deltaToolCalls`/`delta_tool_calls`）
5. usage 字段名兼容性（`inputTokens`/`input_tokens` 等）
6. deltaToolCalls 子字段解析（id/name/argumentsJson + 别名）
7. `buildCascadeCompletionFromOutput` 输出 shape
8. `maxTokens=32768`（本轮确认已修复）
9. `WINDSURF_UPSTREAM_TRANSIENT` error code（已补齐）
10. `WINDSURF_POLICY_BLOCKED` error code with 451 status（已补齐）
11. 响应阶段错误分类完整性

### 7.2 发现 gap（降级为旧链路观察项）

| # | Gap | 优先级 | 影响 | 说明 |
|---|-----|--------|------|------|
| 1 | SSE streaming 路径未实现 | 低 | stream: true 请求仍走聚合路径 | 旧 `GetChatCompletions` 链路已证伪，优先级低于移除整条错误路径 |

### 7.3 根因级更新
1. 本报告审计对象仍是 **旧 `GetChatCompletions` 响应链**。
2. 2026-05-22 最黑盒结论已确认：**旧链路必须物理移除**。
3. 因而这里记录的解析对齐项，只能作为删除旧链路前的取证材料；**不能再作为保留旧主链的依据**。

---

**审计人**: Codex agent
**文档路径**: `docs/audit/windsurf-request-shape-audit.md`（请求篇）, `docs/audit/windsurf-response-audit.md`（本篇）
