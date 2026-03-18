# Heartbeat Session Execution State 设计

## 目标

为 heartbeat 注入建立一个 **tmux-scoped 执行状态真源**，在注入前判断目标 tmux 当前是否仍在执行任务；若仍在执行，则跳过本次 heartbeat，避免打扰。

本设计重点解决两个问题：

1. 不能再把 `client alive` 误判为 `session busy`。
2. 不能只看 executor 生命周期；流式 SSE 仍在输出时，必须视为仍在执行。

---

## 已确认可用的现有信号

### 1. tmux / session 绑定

来源：

- `src/server/runtime/http-server/executor-metadata.ts`
- `src/server/runtime/http-server/session-scope-resolution.ts`

当前可解析：

- `tmuxSessionId`
- `sessionId`
- `conversationId`
- `workdir`
- `clientType`

### 2. request 开始/结束

来源：

- `src/server/runtime/http-server/request-executor.ts`
- `src/server/runtime/http-server/request-activity-tracker.ts`

可用作“请求已发出”的信号，但 **不能单独作为流式执行态真源**，因为 `onRequestEnd` 发生在 executor `finally`，早于 SSE 真正结束。

### 3. SSE 生命周期与 finish_reason

来源：

- `src/server/handlers/handler-response-utils.ts`
- `src/server/utils/finish-reason.ts`

当前已经能识别：

- SSE stream start
- SSE end
- client close
- finish / terminal event
- `finish_reason`

这些信号目前主要停留在响应层日志，没有形成 tmux-scoped 共享运行态。

### 4. daemon alive / registry

来源：

- `src/server/runtime/http-server/session-client-registry.ts`

当前能说明：

- client daemon 是否仍在线
- 最近 heartbeat / inject 时间

但这 **不能说明 pane 当前是否 busy**。

---

## 核心判断原则

### A. 流式请求优先

若目标 tmux 当前存在 **未关闭的 SSE**，则直接判定为 **正在执行**，heartbeat 必须跳过。

### B. 非流式请求看最近 request/response 时间线

若最近一条事件是 request，且还未观察到对应 response：

- 在 timeout 窗口内：视为仍在等待响应，应跳过 heartbeat
- 超过 timeout：视为大概率已超时/断连，不应无限跳过 heartbeat

### C. 最近一条事件是 response 时，看 finish_reason

- `finish_reason=stop` 且之后没有新 request：视为空闲
- `finish_reason!=stop`：进入短暂 grace 窗口，避免刚结束 tool_calls / length 时立刻误判为空闲

---

## 建议新增的真源模块

建议新增：

- `src/server/runtime/http-server/session-execution-state.ts`

按 `tmuxSessionId` 维护最近执行态，至少记录：

- `state`
- `lastRequestId`
- `lastRequestAtMs`
- `lastRequestWasStream`
- `openSseCount`
- `lastSseOpenAtMs`
- `lastSseCloseAtMs`
- `lastResponseAtMs`
- `lastFinishReason`
- `lastTerminalAtMs`
- `lastClientCloseBeforeTerminal`

---

## 状态机

### 状态

- `IDLE`
- `WAITING_RESPONSE`
- `STREAMING_OPEN`
- `POST_RESPONSE_GRACE`
- `STALED`
- `UNKNOWN`

### 含义

#### `IDLE`

当前可注入 heartbeat。

#### `WAITING_RESPONSE`

已收到 request，但尚未观察到 response 完成；在 timeout 窗口内应跳过 heartbeat。

#### `STREAMING_OPEN`

流式请求的 SSE 仍未关闭；这是“仍在执行”的最高优先级判定。

#### `POST_RESPONSE_GRACE`

刚结束一个非 `stop` 的响应，例如 `tool_calls` / `length`，短时间内仍可能紧接下一轮请求。

#### `STALED`

最近一条是 request，但超过 timeout 仍无 response，视为超时或断连，不应再无限跳过 heartbeat。

#### `UNKNOWN`

当前没有足够的新执行态数据；只允许降级到 tmux pane heuristic，不允许把 daemon alive 直接当作 busy。

---

## 事件与转移

建议统一记录这些事件：

- `REQUEST_STARTED`
- `SSE_OPENED`
- `SSE_CLOSED`
- `RESPONSE_COMPLETED`
- `RESPONSE_CLIENT_CLOSED`
- `RESPONSE_ERROR`
- `TIMEOUT_EXPIRED`

主要转移：

- `IDLE -> WAITING_RESPONSE`：收到 request
- `WAITING_RESPONSE -> STREAMING_OPEN`：流式响应开始
- `WAITING_RESPONSE -> IDLE`：收到非流式终态且 `finish_reason=stop`
- `WAITING_RESPONSE -> POST_RESPONSE_GRACE`：收到非流式终态且 `finish_reason!=stop`
- `WAITING_RESPONSE -> STALED`：超时无响应
- `STREAMING_OPEN -> IDLE`：SSE 正常结束且 `finish_reason=stop`
- `STREAMING_OPEN -> POST_RESPONSE_GRACE`：SSE 正常结束且 `finish_reason!=stop`
- `STREAMING_OPEN -> STALED`：client close / 异常结束且没有正常终态
- `POST_RESPONSE_GRACE -> WAITING_RESPONSE`：grace 期间来了新 request
- `POST_RESPONSE_GRACE -> IDLE`：grace 到期且没有新 request
- `STALED -> WAITING_RESPONSE`：之后出现新的 request

---

## Heartbeat skip 决策顺序

推荐优先级：

1. **存在未关闭 SSE** → `skip`
2. **最新是 request，且仍在 timeout 窗口内** → `skip`
3. **最新是 response，`finish_reason=stop`，且之后无新 request** → `allow`
4. **最新是 request，但已超时无响应** → `allow`
5. **状态不足** → fallback 到 tmux pane heuristic

明确禁止：

- 仅因为 `registry.hasAliveTmuxSession()` 为真，就直接判定 busy

---

## 与现有 heartbeat 的关系

当前 heartbeat skip 逻辑里已有：

- tmux 存活检查
- request inflight 检查
- client daemon alive 检查
- tmux pane heuristic fallback

新方案应调整为：

1. execution-state tracker 为主真源
2. tmux pane heuristic 仅作 fallback
3. daemon alive 只表示“在线”，不表示“忙”

---

## 落地顺序建议

1. 新增 `session-execution-state.ts`
2. 在 request start 路径写入 `REQUEST_STARTED`
3. 在 JSON response 完成路径写入 `RESPONSE_COMPLETED`
4. 在 SSE 路径写入 `SSE_OPENED / SSE_CLOSED / RESPONSE_COMPLETED / RESPONSE_CLIENT_CLOSED`
5. heartbeat 决策改为优先读取 execution-state tracker
6. 在缺少状态时再回退到 tmux pane heuristic

---

## 备注

该设计上线后，只能对 **上线后的新请求** 逐步建立准确执行态。对上线前已在跑的老 session，短期内仍需依赖 tmux pane heuristic 兜底。
