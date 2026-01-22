# ServerTool: `clock`（定时提醒）详细设计（Draft）

> 目标：在不引入“旁路”执行路径的前提下，为每个 session 提供可持久化的定时提醒能力，并在后续请求中把提醒注入到模型上下文里。
> 本文是**详细设计**，不包含实现。

## 0. 背景与约束

- 单执行路径：所有模型调用仍必须走 `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`。
- llmswitch-core 拥有工具语义与路由：Host/Provider 不得自行修复 tool calls、重写参数或决定路由，只能注入依赖与 IO。
- Provider 层只做 transport（auth/http/retry/compat），不得理解 payload 语义。
- 时钟任务必须 **serverId + sessionId** 作用域隔离，避免跨 server 串读（stopMessage 的坑不能再踩）。
- “过期删除”与“过期也算触发”必须统一：保留期（retention）设为 **20 分钟**（`retentionMs = 20 * 60 * 1000`）。

## 1. 需求澄清（本设计采纳的语义）

### 1.1 工具注入

- 配置开启后：**每次请求都注入 `clock` tool schema** 到工具列表（全局开关）。
- 仅当请求能够解析出 `sessionId` 时，`clock` 的调度结果才会落到 session 作用域；缺失 `sessionId` 时拒绝调度（返回工具错误）。

### 1.2 调度与触发窗口

- 模型通过调用 `clock` 工具创建任务，形成 `{dueAt, task}` 列表，写入 daemon（持久化）。
- 每次请求到来时（对该请求的 session）检查任务是否“到达触发阈值”：
  - 触发窗口定义为：`now >= dueAt - 60s` 即视为到达（“差一分钟到也算，过期也算”）。
  - 过期任务并不立即删除；仅当 `now > dueAt + retentionMs` 才删除。

### 1.3 投递与离线问题

**重要现实约束：没有客户端请求就无法把提醒推送给客户端**（系统当前没有反向推送通道）。

- 本设计的默认投递语义：提醒以 `"[scheduled task:\"...\"]"` 的形式**注入到下一次该 session 的请求**中。
- “finish_reason=stop 且时间没到就 hold 等待”会把 HTTP 变成长连接并引发代理/超时/资源占用等风险；但在当前需求中**明确要求 hold 且不限制时间**：
  - 当响应 `finish_reason=stop` 且存在未到达触发窗口的最近任务 `nextDueAtMs`，server 可以保持连接，直到 `now >= nextDueAtMs - 60s` 再继续执行注入/续轮。
  - 若客户端在 hold 期间断开：server 无法把“同一条响应”推送回客户端；此时任务保持在 daemon 持久化中，**在下一次同 session 的请求到来时**（只要未超过 20 分钟 retention）依然会被判定为 due 并注入提醒。
  - 若需要“用户完全离线仍能收到提醒”，必须补齐客户端侧机制（例如：客户端定期发起心跳/拉取请求，或新增事件订阅/长轮询 endpoint）。单纯 server 侧 fake 请求给模型不会自动出现在既有客户端 UI 上。

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
    "action": { "type": "string", "enum": ["schedule", "list", "cancel", "clear"] },
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
            "type": "object",
            "description": "可选：建议工具参数（仅用于提示）。",
            "additionalProperties": true
          }
        },
        "required": ["dueAt", "task"]
      }
    },
    "taskId": { "type": "string", "description": "cancel 时使用" }
  },
  "required": ["action"]
}
```

### 2.3 工具返回（建议）

`clock` 工具返回必须可机器解析，便于模型后续自查：

- `schedule`：返回 `{ ok, scheduled: [{ taskId, dueAt, task }] }`
- `list`：返回 `{ ok, items: [{ taskId, dueAt, task, deliveredAt? }] }`
- `cancel`：返回 `{ ok, removed: taskId }`
- `clear`：返回 `{ ok, removedCount }`

## 3. 状态模型（daemon 内部存储）

### 3.1 Task 结构

```ts
type ClockTask = {
  taskId: string;          // uuid
  serverId: string;        // 当前 server 实例稳定标识（用于路径隔离）
  sessionId: string;
  dueAtMs: number;         // 毫秒时间戳
  createdAtMs: number;
  updatedAtMs: number;
  task: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  deliveredAtMs?: number;  // 成功“注入到某次请求并 commit”后写入
  deliveryCount: number;   // 注入/投递计数（至少 1 次）
};
```

### 3.2 Session 存储结构

```ts
type ClockSessionState = {
  version: 1;
  serverId: string;
  sessionId: string;
  tasks: ClockTask[];
  updatedAtMs: number;
};
```

## 4. 持久化与隔离策略（必须）

### 4.1 存储位置

- 统一放在 server-scoped session dir 下，避免跨 server 串读：
  - 根目录：`~/.routecodex/sessions/<serverId>/`
- Clock 子目录建议：
  - `~/.routecodex/sessions/<serverId>/clock/<sessionId>.json`

### 4.2 加载/写入策略

- **设置（schedule/cancel/clear）时立即解析并持久化**：
  - 解析 `dueAt`（ISO8601）失败：立即返回工具错误，模型立刻知道设置失败。
  - 写盘失败：返回工具错误（fail fast）。
- **内存缓存可选**（session 级 LRU），但任何写操作必须同步刷新持久化（write-through），避免你在 stopMessage 上遇到的“内存更新但盘没刷”的错觉。

## 5. 请求注入与投递一致性（reservation/commit）

### 5.1 注入点

在 Hub Pipeline 的 canonicalization 完成后、路由/上游调用前执行注入（属于 llmswitch-core 的职责）。

注入格式（最小实现）：

- 在请求末尾追加一段系统文本（或 user 文本，二选一，建议 system）：
  - `"[scheduled task:\"<task>\" tool=<tool?> args=<json?> dueAt=<iso>]"`（字符串格式固定，方便可观测）

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

## 9. 与“fake 请求/hold”相关的实验结论（必须先对齐现实）

- 单纯由 server 主动发起一条“fake /v1/responses 请求”，其响应只会返回给**发起该 HTTP 请求的客户端连接**。
- 如果你的真实客户端没有同时发起请求/没有订阅推送通道，它不会“自动看到”这条 fake 请求的结果。
- 因此，“用户离线仍能收到提醒”需要客户端配合（心跳/轮询/订阅）或引入新的推送通道；否则只能做到“下一次用户回来发请求时注入提醒”。
