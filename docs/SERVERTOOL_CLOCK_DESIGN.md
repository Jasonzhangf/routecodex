# ServerTool: `clock`（Time + Alarm）详细设计（Draft）

> 目标：在不引入“旁路”执行路径的前提下，为每个 session 提供可持久化的 **定时提醒（Alarm）**，并提供可机器读取的 **当前时间（Time）** 能力给 MCP/模型使用。
> 本文是**详细设计**，用于约束行为与契约（实现细节以源码为准）。

## 0. 背景与约束

- 单执行路径：所有模型调用仍必须走 `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`。
- llmswitch-core 拥有工具语义与路由：Host/Provider 不得自行修复 tool calls、重写参数或决定路由，只能注入依赖与 IO。
- Provider 层只做 transport（auth/http/retry/compat），不得理解 payload 语义。
- `clock` 的存储根目录由运行时环境变量 `ROUTECODEX_SESSION_DIR` 提供；所有持久化均落在该目录下。
- “过期删除”与“过期也算触发”必须统一：保留期（retention）默认 **20 分钟**（`retentionMs = 20 * 60 * 1000`）。
- 所有 “注入（messages/tools）/工具 schema/工具配对” 必须在 llmswitch-core 内完成；Host/Provider 不得做补丁式修复。

## 1. 需求澄清（本设计采纳的语义）

### 1.1 工具注入

- 配置开启后：**每次请求都注入 `clock` tool schema** 到工具列表（全局开关）。
- 仅当请求能够解析出 `sessionId` 时，`clock` 的调度结果才会落到 session 作用域；缺失 `sessionId` 时拒绝调度（返回工具错误）。

### 1.2 调度与触发窗口

- 模型通过调用 `clock` 工具创建任务，形成 `{dueAt, task, tool?, arguments?}` 列表，写入持久化（按 session 作用域）。
- 每次请求到来时（对该请求的 session）检查任务是否“到达触发阈值”：
  - 触发窗口定义为：`now >= dueAt - 60s` 即视为到达（“差一分钟到也算，过期也算”）。
  - 过期任务并不立即删除；仅当 `now > dueAt + retentionMs` 才删除。

### 1.3 投递与离线问题

**重要现实约束：没有客户端请求就无法把提醒推送给客户端**（系统当前没有反向推送通道）。

- 本设计的默认投递语义：提醒以 `"[scheduled task:\"...\"]"` 的形式**注入到下一次该 session 的请求**中。
- 本设计的 best-effort：在 stop/length 场景下允许“短暂 hold + followup”，以便在触发窗口到达时立刻续轮注入提醒（减少“必须等下一次请求”的延迟）。
  - 默认 **stream/SSE** 与 **非流式（JSON）** 都允许 hold（长轮询/阻塞返回），但必须满足 `holdMaxMs` 上限（默认 60000ms），客户端可随时断开连接取消等待。
  - 如需关闭非流式 hold（改回“仅下一次请求注入”语义），可在 `virtualrouter.clock` 中设置：
    - `holdNonStreaming=false`
    - `holdMaxMs=<ms>`（仍用于限制单次 hold 最长等待）

另外，为避免“同一 HTTP 请求内的二跳/三跳 followup”导致的死循环：

- 当 `schedule` 的目标时间已经落入触发窗口（`dueAt <= now + dueWindowMs`）时，会给任务写入 `notBeforeRequestId=<当前请求 requestId>`。
- 注入提醒时会把 `notBeforeRequestId` 视为“请求链前缀屏蔽”，即 `requestId === notBeforeRequestId` 或 `requestId` 以 `notBeforeRequestId + ":"` 开头（例如 `:clock_followup`）时，都不会在该请求链内投递提醒。

### 1.4 与 `stopMessage` 的优先级与交互（必须）

本项目内存在一个更高优先级的 stop 续轮机制：`stopMessage`（用于在模型 `finish_reason=stop` 时继续推进工作流）。

本设计明确规定优先级与行为：

1. **`stopMessage` 优先级更高**：当一次响应 `finish_reason=stop` 时，如果当前 session 命中可用的 `stopMessage`（尚未超次数、且本次需要触发），则先走 `stopMessage` 的续轮发送逻辑，并在触发后按既定规则**清零/计数并持久化刷新**。
2. **只有当 `stopMessage` 未触发（或不存在）时，才允许 `clock hold`**：即 `clock` 的 hold 仅作为 stop 状态下的“定时续轮兜底”，不能抢占 `stopMessage` 的推进能力。
3. **触发 `stopMessage` 后不再 hold `clock`**：因为续轮已被 `stopMessage` 推进，`clock` 的提醒应按“下一次请求注入/或在后续 stop 决策时再评估”的方式处理，避免两个机制互相拉扯造成不可控长连接。

## 2. `clock` 工具协议（对模型可见）

### 2.1 工具名与动作

采用单工具名 + action，避免模型在多个工具名间迷路：

- 工具名：`clock`
- action：
  - `get`：获取当前时间（UTC + local）与 NTP 校时状态（机器可解析；同时作为“clock 激活”信号）
  - `schedule`：创建/覆盖任务
  - `list`：列出本 session 未过期任务
  - `cancel`：取消指定任务
  - `clear`：清空本 session 所有任务

另外提供一个**用户指令**（非模型工具调用）用于直接清理当前会话定时：

- `<**clock:clear**>`：清空当前 `sessionId` 的全部 `clock` 任务（立即写盘）。

### 2.2 Schema（建议）

```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["get", "schedule", "list", "cancel", "clear"] },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "dueAt": {
            "type": "string",
            "description": "ISO8601 时间（含时区）。例如 2026-01-21T20:30:00-08:00"
          },
          "task": {
            "type": "string",
            "description": "提醒文本（建议包含要调用的工具/动作）。"
          },
          "tool": {
            "type": "string",
            "description": "可选：建议要调用的工具名（仅用于提示，不做强制执行）。"
          },
          "arguments": {
            "type": "string",
            "description": "可选：建议工具参数（仅用于提示）。JSON string（例如 \"{}\"），避免 strict schema 下的任意 object 结构。",
            "default": "{}"
          }
        },
        "required": ["dueAt", "task", "tool", "arguments"]
      }
    },
    "taskId": { "type": "string", "description": "cancel 时使用" }
  },
  "required": ["action", "items", "taskId"]
}
```

> 说明：当前实现采用 `strict: true` 的函数工具 schema（对齐 OpenAI Responses 的严格校验），因此 `required` 需要覆盖 `properties` 的全部字段；
> 对不适用的 action，可使用空数组/空字符串占位（例如 `get` 使用 `items=[]`、`taskId=""`）。

### 2.3 工具返回（建议）

`clock` 工具返回必须可机器解析，便于模型后续自查：

- `get`：返回 `{ ok, action:"get", active:true, nowMs, utc, local, timezone, ntp:{...} }`
- `schedule`：返回 `{ ok, scheduled: [{ taskId, dueAt, task }] }`
- `list`：返回 `{ ok, items: [{ taskId, dueAt, task, deliveredAt? }] }`
- `cancel`：返回 `{ ok, removed: taskId }`
- `clear`：返回 `{ ok, removedCount }`

## 3. 状态模型（daemon 内部存储）

### 3.1 Task 结构

```ts
type ClockTask = {
  taskId: string;          // uuid
  sessionId: string;
  dueAtMs: number;         // 毫秒时间戳
  createdAtMs: number;
  updatedAtMs: number;
  task: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  deliveredAtMs?: number;  // 成功“注入到某次请求并 commit”后写入
  deliveryCount: number;   // 注入/投递计数（至少 1 次）
  notBeforeRequestId?: string; // 防死循环：窗口内设置的任务，本 requestId 不允许触发注入
};
```

### 3.2 Session 存储结构

```ts
type ClockSessionState = {
  version: 1;
  sessionId: string;
  tasks: ClockTask[];
  updatedAtMs: number;
};
```

## 4. 持久化与隔离策略（必须）

### 4.1 存储位置

- 统一放在 `ROUTECODEX_SESSION_DIR` 下：
  - 闹钟任务：`$ROUTECODEX_SESSION_DIR/clock/<sessionId>.json`
  - NTP 校时状态（server-wide）：`$ROUTECODEX_SESSION_DIR/clock/ntp-state.json`

### 4.2 加载/写入策略

- **设置（schedule/cancel/clear）时立即解析并持久化**：
  - 解析 `dueAt`（ISO8601）失败：立即返回工具错误，模型立刻知道设置失败。
  - 写盘失败：返回工具错误（fail fast）。
- **内存缓存可选**（session 级 LRU），但任何写操作必须同步刷新持久化（write-through），避免你在 stopMessage 上遇到的“内存更新但盘没刷”的错觉。

## 5. 请求注入与投递一致性（reservation/commit）

### 5.1 注入点

在 Hub Pipeline 的 canonicalization 完成后、路由/上游调用前执行注入（属于 llmswitch-core 的职责）。

注入包括两部分：

1) Time tag（每次请求）：
   - 在 messages 末尾追加一条新的 `role:user`，内容为 markdown time tag（inline code）：
     - `[Time/Date]: utc=\`...\` local=\`...\` tz=\`...\` nowMs=\`...\` ntpOffsetMs=\`...\``
   - 设计意图：避免引入额外 tool-call 语义，减少模型把“时间注入”当作必须响应/执行的工具回合，从而分散注意力或打断会话结构。

2) Alarm due reminders（仅当本次有到期任务）：
   - 在请求末尾追加一条 `role:user` 提醒文本，包含到期任务列表，并明确提示：
     - “你可以调用 tools 完成这些任务；如果 tools 不全，系统会补齐标准工具列表。”

### 5.2 触发判定

对每个任务：

- `isDue = nowMs >= (dueAtMs - 60_000)`
- `isExpired = nowMs > (dueAtMs + retentionMs)`
- `shouldInject = isDue && !isExpired && deliveredAtMs == null`

其中 `retentionMs = 20 * 60_000`：任务过期后 20 分钟内仍可触发注入；超过 20 分钟才清理。

### 5.3 Reservation/Commit 语义（防丢/防重）

为避免“注入了提醒但上游失败/客户端断开导致任务被提前标记已投递”，采用两阶段：

1. Reservation（仅内存）：
   - 计算本次请求会注入哪些 `taskId`，形成 `reservationId`（例如 `${requestId}:clock`）。
   - 将 `(reservationId → [taskId...])` 挂在本次 request context 上（非持久化）。
2. Commit（持久化写盘）：
   - 当本次响应进入 `response.dispatch`（至少已经开始向客户端发送）时 commit：
     - 对每个被注入的任务：`deliveredAtMs = nowMs; deliveryCount += 1`
   - 若上游报错/未进入 dispatch：rollback（不修改 deliveredAt/deliveryCount）。

> 说明：严格意义上“客户端一定收到”很难保证（客户端可能在 dispatch 后立刻断开）。
> 本设计把“进入 dispatch”作为 commit 边界，与 stopMessage 的行为保持一致即可；如需更严格可引入“客户端 ack”协议，但会改变客户端/协议层。

## 6. Daemon 行为（定时清理 + 启动扫描）

### 6.1 启动扫描

daemon 启动时扫描 `~/.routecodex/sessions/<serverId>/clock/`：

- 对每个 task：
  - 若 `nowMs > dueAtMs + retentionMs`：删除
  - 否则保留（即便已到期但未投递，也必须保留，等待下一次注入机会）

### 6.2 Tick 清理

- 周期：例如每 60s 扫描一次（可配置）。
- 清理规则同启动扫描。

## 7. 可观测性（日志/审计）

建议新增统一日志（debug/info 两档）：

- schedule/list/cancel/clear：打印 `sessionId`、任务数、最早 dueAt、写盘结果。
- 注入阶段：打印 `requestId`、`sessionId`、注入任务数与 taskId 列表（注意脱敏 task 文本，避免泄漏）。
- commit：打印 `requestId`、commit 任务数、deliveryCount 更新。

## 8. 失败与边界情况

- 缺失 `sessionId`：
  - `schedule/cancel/clear`：返回工具错误（不落盘）
  - 注入：跳过（无 session 无法关联任务）
- `dueAt` 解析失败：工具错误（fail fast）
- 写盘失败：工具错误（fail fast）
- 同一 session 大量任务：上限策略可后续再加；本设计先不设硬上限（但要有 O(n) 扫描的性能告警/日志）

## 10. NTP 校时（Time 校验与偏移）

- `clock` 在启用后会进行 best-effort NTP 校时（SNTP/UDP 123）：
  - 维护 `ntpOffsetMs`，用于计算 `correctedNowMs = Date.now() + ntpOffsetMs`。
  - 失败不阻断请求/不影响闹钟功能；仅更新 `ntp.status=error` 与 `lastError`。
- 校时状态持久化到 `$ROUTECODEX_SESSION_DIR/clock/ntp-state.json`，用于进程重启恢复。

## 11. 防死循环规则（窗口内设置不在当前请求激发）

当 `schedule` 设置的 `dueAt` 已经落入触发窗口（例如 `dueAt <= now + dueWindowMs`）时：

- 本次请求不注入/不激发提醒（防止同 requestId / followup 路径产生逻辑死循环）。
- 任务仍会被持久化保存，但写入 `notBeforeRequestId=<currentRequestId>` 作为 guard。
- 下一次请求（requestId 不同）到来时，会立即满足注入条件并注入一次，然后正常 commit 为 delivered。

## 9. 与“fake 请求/hold”相关的实验结论（必须先对齐现实）

- 单纯由 server 主动发起一条“fake /v1/responses 请求”，其响应只会返回给**发起该 HTTP 请求的客户端连接**。
- 如果你的真实客户端没有同时发起请求/没有订阅推送通道，它不会“自动看到”这条 fake 请求的结果。
- 因此，“用户离线仍能收到提醒”需要客户端配合（心跳/轮询/订阅）或引入新的推送通道；否则只能做到“下一次用户回来发请求时注入提醒”。
