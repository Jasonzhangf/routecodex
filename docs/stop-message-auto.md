# stopMessage 自动续写设计（servertool 版）

本设计为 `<**stopMessage:"…",N**>` / `<**stopMessage:clear**>` 语法的统一方案，基于 llmswitch-core 的虚拟路由 + servertool 机制，实现「在 finish_reason=stop 时自动追加一条用户消息并继续对话」的能力。

目标：

- 语法与现有 `<**!glm**>` / `<**#glm**>` 一致：只在路由层解析，provider 不看到标签。
- 所有自动续写逻辑通过 **servertool** 实现，与 `vision_auto` / `gemini_empty_reply_continue` 保持一致。
- 状态通过 sticky session 持久化；支持清理与覆盖。
- stopMessage 文案建议使用“执行导向”措辞（例如“立即执行待处理任务”），避免模型只做任务查看不执行。
- 客户端真实断开（HTTP aborted/close 未写完）后不会继续自动请求，避免后台无限回环；正常完成不会被误判。

## 1. 语法与状态

### 1.1 语法

支持三种形式：

- 启用 / 更新：`<**stopMessage:"立即执行待处理任务",3**>`
  - `"立即执行待处理任务"`：自动补发的用户消息内容，要求模型直接执行而非查看状态。内部如需引号，用 `\"` 转义。
  - `3`：本会话最多自动续写 3 轮；省略时默认 `10`。
- 仅设置文案（默认 10 次）：`<**stopMessage:"立即执行待处理任务，如有未完成任务直接完成并提交结果"**>` → `maxRepeats = 10`。
- 清理：`<**stopMessage:clear**>` → 清空本会话 stopMessage 状态。

> 注意：这些标签仅用于路由与 servertool，不应出现在发给 provider 的文本中。

### 1.2 sticky 状态结构

在虚拟路由的 sticky session state 中新增字段（由 `sticky-session-store` 维护）：

- `stopMessageText?: string` — 自动续写的用户文本。
- `stopMessageMaxRepeats?: number` — 最多自动续写次数（>=1）。
- `stopMessageUsed: number` — 已执行的自动续写次数，初始为 `0`。
- `stopMessageUpdatedAt?: number` — 最近一次解析 `<**stopMessage:"..."**>` 指令的时间戳。
- `stopMessageLastUsedAt?: number` — 最近一次 servertool 自动补发 stopMessage 的时间戳。
- BD 状态判断默认走真实命令（`bd --no-db list/ready --json`），失败时回退到消息启发式；可通过 `ROUTECODEX_STOPMESSAGE_BD_MODE=auto|runtime|heuristic` 配置。

行为：

- 解析到 `stopMessage:"...",N`：
  - `stopMessageText = text`
  - `stopMessageMaxRepeats = N || 10`
  - `stopMessageUsed = 0`
  - `stopMessageUpdatedAt = Date.now()`，`stopMessageLastUsedAt = undefined`
- 解析到 `stopMessage:clear`：
  - 删除上述所有字段。
- **会话标识要求**  
  - sticky state 依赖 `sessionId` / `conversationId`。`/v1/chat` 与 `/v1/responses` 默认通过请求头即可提供；`/v1/messages` 需要确保请求体中的 `metadata.user_id` 含有 `session_<uuid>` 片段（Claude/Antigravity 默认行为）。llmswitch-core 会在缺少 header/metadata.sessionId 时回退解析 `metadata.__raw_request_body.metadata.user_id`，自动恢复 sessionId 并写入 sticky 文件。若缺失上述字段，stopMessage 无法跨请求记忆次数。
  - compaction 保护：当捕获到的上一跳请求被判定为“compaction 请求”时，stopMessage 不会触发（避免 compaction 流程被 stopMessage 反复续写干扰）。判定逻辑只对 **payload 起始处**的 sentinel 生效；在对话历史中粘贴包含 “Handoff Summary …” 等字样的文本，不应再误伤 stopMessage。

## 2. 路由层解析与指令清理

### 2.1 解析入口

在 `llmswitch-core/src/router/virtual-router/routing-instructions.ts` 中扩展现有 `<**...**>` 解析流程：

1. 扫描 user 消息，从最后一条带 `<**...**>` 的 user 消息中提取指令字符串（复用现有逻辑）。
2. 对每个 `<**...**>` token：
   - 若前缀为 `stopMessage:`，进入 stopMessage 解析分支：
     - `stopMessage:"...",N`
     - `stopMessage:"..."`
     - `stopMessage:clear`
   - 解析结果不进入 provider 路由选择，而是写入 sticky session state。

### 2.2 消息清理

为确保 provider 完全看不到控制标签，在标准化 Chat 请求前做统一清理：

- 在 chat inbound 处理链路中（Chat → StandardizedMessage 期间），对 user 文本执行：
  - 用正则移除所有 `<**...**>` 片段（包括 `!glm` / `#glm` / `stopMessage` 等）。
  - 保持其余文本内容不变。

这样可保证：

- 路由与工具治理仍能看到完整指令。
- provider 收到的 `messages[].content` 不含任何 `<**...**>` 控制标记。

## 3. servertool：stop_message_auto

### 3.1 位置与注册

- 新增文件：`llmswitch-core/src/servertool/handlers/stop-message-auto.ts`。
- 在 `server-side-tools.ts` 中 import 并注册：

```ts
import './handlers/stop-message-auto.js';
// ...
registerServerToolHandler('stop_message_auto', handler, { trigger: 'auto' });
```

### 3.2 触发条件

handler 签名：`ServerToolHandler`，在 servertool orchestrator 中自动触发。伪代码：

```ts
const handler: ServerToolHandler = async (ctx) => {
  if (!ctx.options.reenterPipeline) return null;

  // 避免在 followup 请求中再次触发（防循环）
  const record = ctx.adapterContext as {
    serverToolFollowup?: unknown;
    clientDisconnected?: unknown;
    clientConnectionState?: { disconnected?: boolean };
  };
  if (record.serverToolFollowup === true || String(record.serverToolFollowup).toLowerCase() === 'true') {
    return null;
  }

  // 客户端已断开：不再自动续写，避免后台死循环
  if (record.clientConnectionState?.disconnected === true ||
      record.clientDisconnected === true ||
      String(record.clientDisconnected).toLowerCase() === 'true') {
    return null;
  }

  // 从 sticky session state 读取 stopMessage 状态（通过已有 helper）
  const state = readStickySessionState(ctx.adapterContext);
  if (!state?.stopMessageText || !state.stopMessageMaxRepeats) return null;
  if (state.stopMessageUsed >= state.stopMessageMaxRepeats) return null;

  // 检查当前响应 finish_reason
  if (!isStopFinishReason(ctx.base)) return null;

  // 更新计数并持久化
  state.stopMessageUsed += 1;
  state.stopMessageLastUsedAt = Date.now();
  writeStickySessionState(ctx.adapterContext, state);

  const captured = getCapturedRequest(ctx.adapterContext);
  if (!captured) return null;
  const followupPayload = buildStopMessageFollowupPayload(captured, state.stopMessageText);
  if (!followupPayload) return null;

  return {
    chatResponse: ctx.base,
    execution: {
      flowId: 'stop_message_flow',
      followup: {
        requestIdSuffix: ':stop_followup',
        payload: followupPayload,
        metadata: {
          serverToolFollowup: true,
          stream: false,
          preserveRouteHint: false,
          disableStickyRoutes: true,
          clientConnectionState: record.clientConnectionState
        }
      }
    }
  };
};
```

要点：

- 不关心入口 endpoint（`/v1/responses`、`/v1/chat/completions` 等），由 servertool orchestrator 统一挂载。
- 是否继续完全由：
  - sticky state（有无 stopMessage、次数是否已用完）；
  - 当前响应 finish_reason 是否为 `"stop"`；
  - client 是否 still connected；
  三者共同决定。
- followup 请求默认沿用最初的入口 endpoint（`/v1/chat/completions`、`/v1/responses` 等），从而复用相同的 Virtual Router 路径与工具治理；如需特殊入口可在 handler 的 `followup.entryEndpoint` 中显式指定。

### 3.3 finish_reason 判断

实现辅助函数 `isStopFinishReason(base: JsonObject): boolean`：

- 对 OpenAI Chat 形状：
  - `base.choices[0].finish_reason === 'stop'`。
- 对 OpenAI Responses 形状（如需要）：
  - 映射到内部标准字段后，检查对应 finish_reason 是否为 `stop`。

为避免过度耦合，可先只在 Chat 路径上启用，Responses 配置另行评估。

### 3.4 followup payload 构造

与 vision / gemini-continue 相同思路：

```ts
function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  const ctx = adapterContext as { capturedChatRequest?: unknown };
  const captured = ctx?.capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null;
  return captured as JsonObject;
}

function buildStopMessageFollowupPayload(source: JsonObject, text: string): JsonObject | null {
  if (!source || typeof source !== 'object') return null;
  const payload: Record<string, unknown> = {};
  if (typeof source.model === 'string' && source.model.trim()) {
    payload.model = source.model.trim();
  }
  const rawMessages = (source as { messages?: unknown }).messages;
  const messages = Array.isArray(rawMessages) ? cloneJson(rawMessages) : [];
  messages.push({ role: 'user', content: text } as JsonObject);
  payload.messages = messages;

  if (Array.isArray((source as { tools?: unknown }).tools)) {
    payload.tools = cloneJson((source as { tools: unknown[] }).tools);
  }
  const parameters = (source as { parameters?: unknown }).parameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    Object.assign(payload, cloneJson(parameters as Record<string, unknown>));
  }
  return payload as JsonObject;
}
```

## 4. 行为对齐检查

对照需求逐条确认：

1. **`<**stopMessage:"",3**>` 语法**  
   - 已支持字符串 + 次数；解析后写入 sticky state，provider 看不到标签。
2. **`<**stopMessage:clear**>` 清理状态**  
   - 在 routing 指令解析阶段将三项字段全部删除，后续 servertool 将不再触发。
3. **状态持久化**  
   - 依赖 sticky session store；状态挂在 session state 上，通过 `conversation_id` / `session_id` 恢复，可跨进程保持，同时记录 `stopMessageUpdatedAt/stopMessageLastUsedAt` 便于排查。
4. **不设额外全局上限**  
   - servertool 只检查 `stopMessageUsed < stopMessageMaxRepeats`，次数由指令数字完全决定，不再额外 clamp。
5. **客户端断开后停止**  
   - HTTP server 为每个请求追踪 `clientConnectionState.disconnected`，servertool 与 orchestrator 在该 flag 为 true 时立即终止，避免错误追加；
   - 正常返回（`res.writableFinished === true`）不会触发断线判定。
6. **与 gemini 自动继续的统一性**  
   - 同样通过 servertool (`*_auto` handler) + `reenterPipeline` 实现；
   - 行为统一：从 `capturedChatRequest` 构造 followup payload，在 Virtual Router 入口再次进入 pipeline。

该设计仅约束 llmswitch-core 的行为，Host / Provider 层不需要感知 stopMessage 语义，符合「工具与路由逻辑统一放在 core」的约定。*** End Patch***Eassistant to=functions.apply_patch_ENTRIES_JSON娱乐主管 to=functions.apply_patch_TYPING_JSON  재assistant통령 to=functions.apply_patch VerifiedJson Input Correction to=functions.apply_patch բուժ to=functions.apply_patch ***!
