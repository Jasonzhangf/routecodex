# Chat Process Continuation / State Contract

## 索引概要
- L1-L8 `purpose`：定义 chat process 统一 continuation/state 语义真源。
- L10-L28 `ssot`：唯一真源与边界。
- L30-L78 `schema`：统一语义 schema。
- L80-L112 `stage-ownership`：req/resp/inbound/outbound/router 各自职责。
- L114-L154 `migration`：Responses 专属字段向统一语义迁移表。
- L156-L183 `acceptance`：四协议矩阵验收口径。

## 目标

按 Jason 的要求，把所有协议的 continuation/state/tool-loop/response continuity 统一收口到 **chat process request + response**。

### 唯一真源

统一语义真源定义为：

- `ChatEnvelope.semantics.continuation`
- `ChatEnvelope.semantics.audit.protocolMapping`

### 边界规则

1. **inbound** 只做 `format_parse + semantic lift`，不得持有协议语义真源。
2. **req chat process** 是 request continuity/state 的唯一读写点。
3. **resp chat process** 是 response continuity/state 的唯一恢复点。
4. **outbound** 只做协议映射和显式 audit，不得新增协议专属状态机。
5. **router** 只能消费统一 continuation semantics，不得继续直接读取 `responsesResume` / `previous_response_id` 等协议私有键。
6. **host/provider** 可保留 transport/store 实现，但对 hub 暴露的只能是统一 continuation semantics，不得把协议私有状态继续向下游泄漏。

---

## 统一语义 Schema

## `chat.semantics.continuation`

```ts
{
  chainId?: string
  previousTurnId?: string
  resumeFrom?: {
    protocol?: string
    requestId?: string
    responseId?: string
    previousResponseId?: string
    turnId?: string
  }
  stickyScope?: 'request_chain' | 'session' | 'conversation' | 'request'
  stateOrigin?: 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'gemini-chat' | 'servertool-followup' | 'tool-loop' | 'unknown'
  restored?: boolean
  toolContinuation?: {
    mode?: 'required_action' | 'submit_tool_outputs' | 'tool_calls' | 'tool_outputs' | 'servertool_followup'
    pendingToolCallIds?: string[]
    submittedToolCallIds?: string[]
    resumeOutputs?: JsonValue[]
  }
  protocolHints?: JsonObject
}
```

### 语义要求

- `chainId`
  - 跨协议 continuation 的统一链路主键。
  - 目标：替代 Responses 特判 `previousRequestId -> stickyKey`。
- `previousTurnId`
  - 上一轮在 chat process 统一视角下的 turn 标识。
  - 不等同于某个协议专属 `response_id`。
- `resumeFrom`
  - 保存“从哪里恢复”的协议锚点。
  - 允许保留协议原始锚点，但只能作为 continuation 子字段，不得散落 metadata。
- `stickyScope`
  - router continuity 的统一口径。
  - 后续 router 只能读这个字段，而不是协议特判。
- `restored`
  - 表示本轮请求/响应是否由历史 continuation 恢复而来。
- `toolContinuation`
  - 表示当前 continuation 是否属于 tool loop / followup。
  - `resumeOutputs` 是统一工具结果面，不再要求协议侧各自保存一套恢复结构。
- `protocolHints`
  - 仅保留协议侧需要的最小恢复提示。
  - 不能成为协议语义第二真源。

## `chat.semantics.audit.protocolMapping`

```ts
{
  protocolMapping?: {
    preserved?: Array<{ field, disposition, reason, sourceProtocol?, targetProtocol?, source? }>
    lossy?: Array<{ ... }>
    dropped?: Array<{ ... }>
    unsupported?: Array<{ ... }>
  }
}
```

### 语义要求

- 所有协议转换导致的保留 / 有损 / 丢弃 / 不支持，都要进入统一 audit 面。
- 不允许再只有 Anthropic/Gemini 记录 dropped/lossy，而 OpenAI Chat / Responses 没痕迹。
- audit 是 **映射结果**，不是状态真源；只能由 inbound/outbound mapper 写入。

---

## Stage Ownership

## Request Path

### inbound
- 允许：
  - parse client protocol
  - lift protocol fields -> `semantics.continuation`
  - 记录 mapping audit
- 禁止：
  - 保存协议私有 continuation 状态为 router 真源
  - 继续把 `responsesResume` 等散落在 metadata 中供下游读取

### chat_process.req
- 唯一职责：
  - continuation/state/tool-loop 统一承接
  - route continuity 所需的统一字段装配
  - request side 保真恢复

## Response Path

### chat_process.resp
- 唯一职责：
  - 从 provider/compat/inbound 结果恢复统一 response continuity semantics
  - 将 required_action / tool_outputs / previous response continuity 统一到 chat 语义面

### outbound
- 允许：
  - 从统一语义恢复协议字段
  - 对无法等价恢复的字段写 audit
- 禁止：
  - 再持有协议专属 continuation/state 真源
  - 再新增 host/provider 侧语义补丁

## Router

- 只能读取：
  - `semantics.continuation.chainId`
  - `semantics.continuation.stickyScope`
  - `semantics.continuation.resumeFrom`
- 禁止直接读取：
  - `metadata.responsesResume`
  - `previous_response_id`
  - protocol-specific sticky 特判字段

---

## Responses → 统一语义迁移表

| 当前字段 | 目标字段 | 说明 |
|---|---|---|
| `metadata.responsesResume.previousRequestId` | `semantics.continuation.chainId` | Router continuity 统一主键 |
| `metadata.responsesResume.restoredFromResponseId` | `semantics.continuation.resumeFrom.responseId` | 恢复锚点 |
| `previous_response_id` | `semantics.continuation.resumeFrom.previousResponseId` | 保留协议锚点，但不再作全局真源 |
| `responsesResume` | `semantics.continuation + semantics.responses.resume` | 前者是跨协议统一层；后者保留协议专属补充 |
| `tool_outputs` / submit payload | `semantics.continuation.toolContinuation.resumeOutputs` + `chat.toolOutputs` | 统一工具结果面 |
| Responses sticky request-chain 特判 | `semantics.continuation.stickyScope='request_chain'` | 清掉 router 特判 |

### 迁移原则

1. `semantics.responses.*` 继续保留，但只作为 **Responses 协议专属补充**。
2. 跨协议共享能力必须优先进入 `semantics.continuation`。
3. 任何模块若继续直接读取 `responsesResume` 作为全局 continuation 真源，视为架构违规。

---

## 四协议矩阵验收口径

覆盖：

- `openai-responses`
- `openai-chat`
- `anthropic-messages`
- `gemini-chat`

每个方向至少验证：

1. **Request Continuation**
   - continuation fields 是否进入 `semantics.continuation`
2. **Response Continuation**
   - response continuity / tool required_action 是否能回到统一语义面
3. **Route Continuity**
   - sticky key 是否来自统一 continuation，而不是协议特判
4. **Mapping Audit**
   - preserved / lossy / dropped / unsupported 是否完整显式记录

### 通过标准

- chat process req/resp 两侧都能观察到统一 continuation semantics。
- inbound/outbound 不再承担协议语义真源。
- 无 audit 的协议降级视为失败。
- 非 Responses 协议即使不能 1:1 恢复协议私有字段，也必须明确标记为 `lossy` / `dropped` / `unsupported`，不能静默塌缩。
