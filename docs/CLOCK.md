# `clock`（Time + Alarm）概览

本项目的 `clock` 是 llmswitch-core 的 ServerTool，用于给模型/MCP提供两类能力：

1. **获取时间**：可通过工具调用 `clock(action="get")` 获取机器可解析的当前时间（UTC + 本地时间）与 NTP 校时状态。
2. **设置闹钟/提醒**：可通过工具调用 `clock(action="schedule")` 写入持久化的 session 级任务；到点后在后续请求中注入提醒文本，提示模型进行工具调用。

更详细的设计/语义说明见：`docs/SERVERTOOL_CLOCK_DESIGN.md`。

## 1) 时间从哪里来？（System + NTP）

`clock` 的“当前时间”以 `nowMs` 为基准：

- **系统时间**：`Date.now()`（毫秒）
- **NTP 校时**（可选）：后台通过 SNTP（UDP/123）向 NTP 服务器获取偏移量 `ntpOffsetMs`，并用 `nowMs = Date.now() + ntpOffsetMs` 作为“校正后的当前时间”

默认 NTP server 列表（可通过环境变量覆盖）：

- `time.google.com`
- `time.cloudflare.com`
- `pool.ntp.org`

相关环境变量：

- `ROUTECODEX_CLOCK_NTP=0|false|off`：禁用 NTP
- `ROUTECODEX_CLOCK_NTP_SERVERS=host1,host2,...`：自定义 NTP servers
- `ROUTECODEX_CLOCK_NTP_STALE_AFTER_MS=<ms>`：NTP 状态多久后视为 `stale`（默认 6h）

NTP 状态持久化路径（落在运行时 session 根目录下）：

- `$ROUTECODEX_SESSION_DIR/clock/ntp-state.json`

## 2) 时间输出格式（Time Tag）

当 `clock` 功能启用后，Hub Pipeline 会在每次请求的 messages 末尾追加一条 **`role=user`** 的时间标签（Time Tag），格式如下：

```
[Time/Date]: timeRef=`now` utc=`2026-02-02T21:22:38.229Z` local=`2026-02-02 13:22:38.229 -08:00` tz=`America/Los_Angeles` nowMs=`1770038558229` ntpOffsetMs=`-12`
```

字段含义：

- `timeRef`：时间锚点，固定为 `now`（表示“当前时刻快照”）
- `utc`：ISO8601 UTC 时间
- `local`：本地时间字符串（含毫秒 + 时区偏移）
- `tz`：服务端 `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `nowMs`：校正后的毫秒时间戳
- `ntpOffsetMs`：当前使用的 NTP 偏移（毫秒）

注意：

- `Time Tag` 是“提示信息”，不改变系统消息。
- 内部 servertool followup hops（`serverToolFollowup=true`）会跳过注入，避免死循环/噪声。

## 3) 闹钟/提醒如何工作？（Schedule → Persist → Inject）

### 3.1 `clock` 工具动作

工具名固定为 `clock`，通过 `action` 区分：

- `get`：获取当前时间与 NTP 状态（无需 sessionId）
- `schedule`：创建提醒任务（需要 sessionId）
- `list`：列出任务（需要 sessionId）
- `cancel`：取消指定任务（需要 sessionId）
- `clear`：清空全部任务（需要 sessionId）

### 3.2 `schedule` 入参（核心字段）

`schedule` 使用 `items` 数组，每项包含：

- `dueAt`：ISO8601（含时区），例如 `2026-01-21T20:30:00-08:00`
- `task`：提醒文本（建议写清楚“要调用哪个工具、做什么”）
- `tool`：可选建议工具名（提示用，不强制）
- `arguments`：可选建议工具参数（JSON 字符串；不用时传 `"{}"`）

### 3.3 持久化位置

每个 session 的任务持久化在：

- `$ROUTECODEX_SESSION_DIR/clock/<sessionId>.json`（`sessionId` 会做安全字符清洗）

### 3.4 触发窗口与“避免同请求死循环”

- 触发窗口：当 `now >= dueAt - dueWindowMs` 视为“到点需要提醒”（默认 60s）
- 为避免“在同一次 HTTP 请求链里 schedule 后立刻触发”导致死循环：
  - 若 `schedule` 的 `dueAt` 已经落在触发窗口（`dueAt <= now + dueWindowMs`），系统会为任务写入 `notBeforeRequestId=<当前请求 requestId>`
  - 在同一请求链（例如 `requestId` 或 `requestId:clock_followup`）内不会投递该任务；必须等到下一次独立请求才会投递

## 4) MCP 如何获取时间/设置闹钟？

两种方式：

1. **主动工具调用**：MCP/模型调用 `clock(action="get")` 或 `clock(action="schedule")`
2. **被动注入**：每次请求都会看到 `Time Tag`；到点的提醒会被注入为 `role=user` 的提示文本（建议进行工具调用）


## 5) 推荐使用方式（强约束）

### 5.1 凡是“不知道要等多久”的异步任务，都应该配一个 `clock`

强烈建议：**只要任务进入异步等待阶段，且你不知道它会在几秒、几分钟还是更久后完成，就不要只靠记忆或手动回头查看，而要立刻设计一个 `clock` 提醒。**

典型场景包括：

- 后台 terminal 命令 / shell 任务
- daemon / service 启动后等待稳定
- 长时间构建 / 打包 / 测试
- 远程接口轮询 / 外部任务完成
- 任何“先放着，等会回来检查”的任务

原则：

1. **启动异步任务后立刻设置 reminder**
2. reminder 文案要写清楚回来时要检查什么
3. 如果任务仍未完成，需要继续设置下一次 reminder
4. 不要假设自己会“记得回来”

### 5.2 后台 terminal 任务示例

例如你刚启动了一个后台 terminal 任务：

- 启动 dev server
- 跑一个可能要很久的测试
- 跑构建 / 发布脚本
- 跑抓取 / 索引 / 编译任务

此时推荐立刻创建一个 clock reminder，内容类似：

```
5 分钟后提醒我检查后台 terminal 任务是否完成；查看日志输出、退出码或产物是否已生成；如果完成就继续下一步，如果未完成则再次设置 reminder。
```

如果你预计它可能更快结束，也可以先设一个更短的提醒，例如 2 分钟；如果任务仍在运行，再追加下一次 reminder。

### 5.3 推荐提醒文案模板

```
请检查之前启动的后台任务是否完成：
- 看 terminal / 日志 / 退出码
- 看目标产物是否已生成
- 如果完成，继续执行后续步骤
- 如果未完成，再设置下一次 clock reminder
```

这条规则的核心不是“为了提醒而提醒”，而是：**把异步等待变成可恢复、可追踪、不会遗忘的流程。**
