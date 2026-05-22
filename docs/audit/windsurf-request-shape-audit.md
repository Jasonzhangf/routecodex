# Windsurf Provider 请求形状审计报告

**审计时间**: 2026-05-22
**审计范围**: RouteCodex `windsurf-chat-provider.ts` vs WindsurfAPI 真实请求链路
**审计性质**: 只读审计，无代码修改
**真源对齐**: `/Volumes/extension/code/WindsurfAPI`

---

## 1. 请求链路架构对比

### RouteCodex 当前链路（已证实为错误链路）
```
preprocessRequest → semanticConversation / tools_preamble 观察面（旧 GetChatCompletions 主链已删除，不再作为发送契约）
                   → parseGetChatMessageResponse → buildCascadeCompletionFromOutput
```

### WindsurfAPI 真实链路
```
原始 OpenAI body
  → handleChatCompletions (chat.js)
    → shouldUseNativeBridge / partitionTools (cascade-native-bridge.js)
    → buildToolPreambleForProto / buildCompactToolPreambleForProto (tool-emulation.js)
    → normalizeMessagesForCascade (tool-emulation.js)
    → buildSendCascadeMessageRequest (windsurf.js)
      → SendUserCascadeMessageRequest (protobuf over HTTP/2)
```

**关键差异（已黑盒证实为根因级差异）**:
- WindsurfAPI 真链：`StartCascade -> SendUserCascadeMessageRequest`（protobuf / HTTP2 / poll）
- RouteCodex 旧链：`GetChatCompletions`（JSON）

这不是“协议层不同但语义等价”的小差异，而是**请求路径族不同**。
2026-05-22 已用同一份带 tools/history 的输入做最黑盒对比，结果显示：
- RouteCodex 最终出站为 `metadata/chatMessagePrompts/systemPrompt/completionsRequest`
- WindsurfAPI 最终出站为 `normalizeMessagesForCascade -> text history replay + toolPreamble -> SendUserCascadeMessageRequest`

因此当前 live 问题优先判定为：**路径问题 > 形状问题**。
后续实现必须物理移除 `GetChatCompletions` 错误主链，只保留 `StartCascade -> SendUserCascadeMessage -> poll` 真链。

---

## 2. 请求体 shape 审计（仅保留为旧错误链路取证）

> 本节以下内容只用于说明旧 `GetChatCompletions` 链路内部曾有哪些字段差异，
> **不再表示该链路可继续修补使用**。
> 2026-05-22 最黑盒结论已经确认：即使 model/modelUid 来源对齐 `WindsurfAPI/src/models.js`，只要仍发 `GetChatCompletions`，问题仍首先属于**路径族错误**。

### 2.1 metadata 字段（已对齐）

| 字段 | RouteCodex | WindsurfAPI | 状态 |
|------|-----------|------------|------|
| `apiKey` | ✅ | ✅ | 对齐 |
| `extensionId` | ✅ | ✅ | 对齐 |
| `workspaceDirectory` | ✅ | ✅ | 对齐 |

### 2.2 completionsRequest.configuration（部分对齐）

| 字段 | RouteCodex | WindsurfAPI | 状态 | 说明 |
|------|-----------|------------|------|------|
| `numCompletions` | ✅ `1` | ✅ `1` | 已对齐 | 静态 |
| `maxTokens` | ✅ `4096` | ❌ 应为 `32768` | **gap** | 见 2.2.1 |
| `temperature` | ✅ `0` | ✅ `0` | 已对齐 | |

#### 2.2.1 maxTokens 缺口（旧错误链路内部差异）

**真源** (`windsurf.js:567`):
```javascript
// max_output_tokens (field 6) — real IDE sends 16384/32768.
// Missing this causes truncated long responses.
plannerParts.push(writeVarintField(6, 32768));
```

**当前 RouteCodex**:
```typescript
configuration: {
  numCompletions: 1,
  maxTokens: 4096,    // ← 硬编码为 4096，远低于真实值 32768
  temperature: 0,
},
```

**影响**: 若仍错误地沿用旧 JSON 链，会导致长响应更易截断；但这已不是当前最高优先级，优先级低于“移除整条错误路径”。

---

### 2.3 systemPrompt vs toolPreamble 字段名（旧错误链路观察）

| 场景 | RouteCodex | WindsurfAPI | 状态 |
|------|-----------|------------|------|
| 有工具 | `systemPrompt` | `additional_instructions_section` (proto 内部) | 语义对齐 |
| 无工具 | `systemPrompt` (空时不发) | `noToolAdditional` 覆盖 | 对齐 |

RouteCodex 在 `toolPreamble` 非空时输出 `systemPrompt` 字段，符合 WindsurfAPI 在 `additional_instructions_section` 注入工具 preamble 的语义。

---

### 2.4 tool_choice 裁剪（已对齐）

**真源** (`messages.js:pruneToolChoice`):
```javascript
const pruneToolChoice = (toolChoice, forwardedTools) => {
  if (!toolChoice || !forwardedTools.length) return undefined;
  if (toolChoice.type === 'function') {
    const names = new Set(forwardedTools.map(t => t.function?.name).filter(Boolean));
    return names.has(toolChoice.function?.name) ? toolChoice : undefined;
  }
  return toolChoice;
};
```

**RouteCodex**: `preprocessRequest` 已将 `body.tool_choice` 复制到 `body.windsurf_tool_choice` 后删除原字段。**✅ 已对齐**。

---

## 3. 消息语义转换审计

### 3.1 tool_result 序列化

**WindsurfAPI** (`tool-emulation.js:normalizeMessagesForCascade`):
```javascript
if (m.role === 'tool') {
  out.push({
    role: 'user',
    content: `<tool_result tool_call_id="${id}">\n${content}\n</tool_result>`,
  });
}
```

**RouteCodex** (`buildChatMessagePromptsFromSemanticConversation`):
```typescript
return {
  messageId: `tool-${index}`,
  source: WINDSURF_SOURCE_TOOL,
  prompt: turn.output,
  toolCallId: turn.call_id,
  toolResultIsError: false,
};
```

**评估**: WindsurfAPI 转换为 user 角色；RouteCodex 使用 proto 原生 tool role。**两者语义等价。✅ 无 gap**。

---

### 3.2 assistant tool_calls 序列化

**WindsurfAPI**: 将 tool_calls 内联到 text content 中作为 XML 字符串。

**RouteCodex**: 使用 proto 原生 `toolCalls[]` 字段。

**评估**: 两者在各自协议层均正确。**✅ 无 gap**。

---

## 4. Tool Preamble 构建审计

### 4.1 preamble tier 策略

**WindsurfAPI** (`chat.js`): 根据工具数量动态选择:
- `buildToolPreambleForProto`: 完整 preamble
- `buildCompactToolPreambleForProto`: 仅工具名列表
- `buildSchemaCompactToolPreambleForProto`: schema 精简
- `buildSkinnyToolPreambleForProto`: 极简签名

**RouteCodex**: 仅实现单一 preamble 构建逻辑，无 tier 分级。

**影响**: 若工具数量过多可能导致 payload 超限。**潜在风险**。

---

## 5. Tool 映射审计

### 5.1 TOOL_MAP 对比

| 工具名 | RouteCodex | WindsurfAPI | 状态 |
|--------|-----------|------------|------|
| `read_file` / `Read` | ✅ → `view_file` | ✅ → `view_file` | 对齐 |
| `exec_command` / `run_command` / `bash` / `shell` | ✅ → `run_command` | ⚠️ passthrough 无映射 | 见说明 |
| `shell_command` | ✅ → `run_command` | ✅ → `run_command` | 对齐 |
| `list_dir` / `list_directory` | ✅ → `list_directory` | ✅ → `list_directory` | 对齐 |
| `find` / `glob` | ✅ → `find` | ⚠️ `glob` 无映射 | 见说明 |
| `grep` / `grep_search` / `grep_search_v2` | ✅ → `grep_search_v2` | ⚠️ `grep`/`grep_search` 无映射 | 见说明 |
| `write` / `write_to_file` | ✅ → `write_to_file` | ⚠️ `write` 无映射 | 见说明 |
| `websearch` / `web_search` / `toolsearch` | ✅ → `search_web` | ⚠️ 多名无映射 | 见说明 |
| `webfetch` / `read_url_content` | ✅ → `read_url_content` | ✅ → `read_url_content` | 对齐 |

**说明**:
- RouteCodex 的映射是 WindsurfAPI 的超集（覆盖 Claude Code TitleCase 工具 + 更多别名）
- WindsurfAPI 某些 passthrough 工具（如 `exec_command`）在 RouteCodex 中被显式映射，语义一致
- **无功能损失**。

---

## 6. 错误分类审计

| 错误类型 | RouteCodex | WindsurfAPI | 状态 |
|---------|-----------|------------|------|
| weekly quota exhausted | ✅ | ✅ | 对齐 |
| resource exhausted / rate limit | ✅ | ✅ | 对齐 |
| auth failure | ✅ | ✅ | 对齐 |
| parse failure | ✅ | ✅ | 对齐 |
| service unreachable | ✅ | ✅ | 对齐 |
| upstream transient | ❌ 无专有 code | ✅ | **gap** |
| IP-level rate limit burst | ❌ 无检测 | ✅ RL_BURST=3 | **gap** |
| policy blocked | ❌ 无检测 | ✅ | **gap** |

---

## 7. 审计结论汇总

### 7.0 根因级结论（2026-05-22 更新）
1. **WindsurfAPI 真源主发送链不是 `GetChatCompletions`。**
2. **RouteCodex 当前 `GetChatCompletions` 主链属于错误链路，必须物理删除。**
3. **后续唯一正确实现方向**：
   - `preprocess/chat-normalize`
   - `StartCascade`
   - `SendUserCascadeMessage`
   - `GetCascadeTrajectorySteps / poll`
4. 因而本报告中剩余的 `maxTokens / preamble tier / error code` 等 gap，全部降级为：
   - **仅当正确 cascade 主链接回后** 才有继续对齐意义。

### 7.1 已对齐项（✅）
1. metadata 字段完整性
2. `numCompletions=1`, `temperature=0`
3. tool_choice 影子字段清理
4. tool_result / assistant tool_calls 语义转换
5. cascade tool kind 映射（RouteCodex 是 WindsurfAPI 的超集）
6. 错误分类核心路径（quota / auth / parse / unreachable）

### 7.2 发现 gap（按优先级）

| # | Gap | 优先级 | 影响 |
|---|-----|--------|------|
| 1 | `maxTokens=4096` 应为 `32768` | **高** | 长响应被截断 |
| 2 | 无 preamble tier 策略 | 中 | 工具过多时可能超 payload 上限 |
| 3 | 无 upstream transient 专有 error code | 中 | 瞬态错误反馈不够精确 |
| 4 | 无 IP-level rate limit burst 检测 | 中 | 连续失败时耗尽账号池 |
| 5 | 无 policy blocked 分类 | 中 | policy violation 被归为 service unreachable |

---

**审计人**: Codex agent
**文档路径**: `docs/audit/windsurf-request-shape-audit.md`
