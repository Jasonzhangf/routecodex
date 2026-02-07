# Routing Instructions (路由指令系统)

## 概述

RouteCodex 支持通过用户消息中的特殊指令 `<**...**>` 来动态控制路由行为。这些指令可以在运行时修改 provider/model/key 的选择策略，而无需修改配置文件。

## 语法格式

指令格式为 `<**<type><target>**>`，其中：
- `<type>`：指令类型（可选 `!`、`#`、`@` 或省略）
- `<target>`：目标标识，可以是 provider、provider.model、provider.key 或 provider.key.model

## 指令类型

### 1. 强制指定（单次）

**语法：** `<**provider.model**>` 或 `<**provider.key.model**>`

**效果：** 仅对当前请求强制使用指定的 provider/model

**示例：**
```
<**glm.glm-4.7**>
请帮我写一段代码
```

另外，针对「整个 provider」可以使用简写：

**语法：** `<**provider**>`（无 `!`、无 `.`）

**效果：**
- 将当前会话的 provider 白名单重置为仅包含该 provider，等价于 `<**!provider**>`；
- 之后的路由只会命中当前 routing 中配置了该 provider 的池子，且池子内部只会选用该 provider 的模型/key；
- 可以与其它 sticky/禁用规则叠加使用。

**示例：**
```text
<**antigravity**>
（当前会话仅使用 antigravity 相关的所有模型/key）
```

### 2. 粘性指定（持续 sticky）

**语法：**
- `<**!provider.model**>`
- `<**!provider.keyAlias.model**>`
- `<**!provider.N**>`（N 为正整数，代表第 N 个 key）

**效果（当前实现）：**
- 针对当前会话（session / conversation）设置「粘性目标」，所有状态按 `stickyKey`（sessionId / conversationId / resume 链）隔离：
  - `!provider.model`：锁定该 provider 下**该模型的所有 key/token**，形成一个 sticky key 池（在这个池子里轮询，默认遵循 round‑robin + 健康检查，不再被限定为某一个 token）；
  - `!provider.keyAlias.model` 或 `!provider.N`：锁定到指定 alias / 指定序号的**单个 key**（不会在 alias 之间轮询，只对这一个 runtimeKey 做 sticky）。
- 之后的请求（除 vision/web_search/longcontext 显式命中外）优先走「粘性路由阶段」，只使用粘性目标对应的 providerKey 集合：
  - 对于 `!provider.model`：会在所有包含该 provider.model 的路由中，把这些路由里的 **所有 sticky key** 视为一个统一的候选池，并在其中轮询；
  - 对于 `!provider.keyAlias.model` / `!provider.N`：直接视为对某个具体 providerKey 的硬绑定。
- 熔断与健康：
  - 任意 sticky key（某个具体 token / apiKey / OAuth 实例）发生 429 / QUOTA_EXHAUSTED 或其它致命错误时，只会让**该 key** 进入熔断或失败状态，从 sticky key 池中移除；
  - 只要 sticky key 池里仍有其它可用 key，就继续在这些 key 之间轮询，不会因为某一个 token 掉线就「卡死整个对话」；
  - 仅当粘性目标的**所有 key** 都因健康/禁用/熔断等原因不可用时，路由器才会自动清除 sticky 状态（等价于隐式执行了一次 `clear`），后续请求恢复正常路由。

**路由优先级（有 sticky 时）：**
1. 若当前请求显式命中 `vision` / `web_search` / `longcontext`，优先尝试这些专用路由（不受 sticky 限制）；
2. 然后进入「粘性路由阶段」：在所有 **包含粘性 provider/model 的路由** 中，仅使用 sticky 对应的 providerKey 进行选择；
   - 这一步会覆盖原本的 `coding` / `thinking` / `tools` / `search` 等 route_hint，实际命中的 routeName 由路由表中真正包含粘性 provider/model 的路由决定（例如你把 `antigravity.claude-sonnet-4-5-thinking` 配在 `thinking`，后续 coding/tools 请求也会命中 `thinking` 路由）；
   - 在这个阶段，优先级等价于：`vision / web_search / longcontext / (所有 sticky 相关路由) / default`，并且在 sticky key 池耗尽之前**不会落到 default 中的非 sticky provider**；
3. 如果上述 sticky 阶段完全找不到可用的 provider（所有粘性 key 熔断/禁用），则自动清除 sticky，之后按正常路由表行为执行。

> **临时跳出 sticky**：Host 可在 metadata 中设置 `disableStickyRoutes: true`（仅对当前请求生效），虚拟路由会在该次路由决策前忽略 `stickyTarget`，按常规 routing 再选 provider，但不会删除原 sticky 状态。

**示例：**
```text
<**!antigravity.claude-sonnet-4-5-thinking**>
解决 CI 问题的话先提交 github
```
（后续同一会话里，即便 classifier 给出 `coding` / `tools`，也会优先在实际包含 `antigravity.claude-sonnet-4-5-thinking` 的路由里选，比如命中 `thinking` 路由，并在该模型的多 token 之间轮询。）

```text
<**!antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking**>
```
（严格粘在 antigravity 的 `geetasamodgeetasamoda` 这一条 key 上，不再轮询其它 alias。）

### 3. 允许筛选（provider 白名单）

**语法：** `<**!provider**>` 或 `<**!providerA,providerB**>`（注意：**无 `.` 时才是白名单语义**）

**效果：**
- 仅对当前会话生效；
- 将可用 provider 限制到给定集合（`allowedProviders`），所有不在白名单中的 provider 及其 key 都不会参与路由；
- 新的 `<**! ...**>` 会覆盖该会话先前设置的白名单；如需允许多个 provider，请在同一条指令中用逗号写在同一条里；
- 白名单本身不改变路由优先级，只是过滤候选 provider 集合，可以与 sticky/禁用规则叠加。

**示例：**
```text
<**!glm**>
（当前会话只允许 glm provider 的所有 key 命中，禁用其他 provider）

<**!glm,openai**>
（当前会话只允许 glm 和 openai 两个 provider 命中，其他全部过滤）
```

### 4. 禁用目标

**语法：** `<**#provider**>`、`<**#provider.N**>` 或 `<**#provider.key**>`（支持用逗号声明多个禁用对象）

**效果：**
- 所有禁用状态只影响当前 session
- 新的 `<**# ...**>` 会覆盖该 session 之前的禁用列表；使用逗号可一次写入多个 provider/key
- `<**#provider**>`：禁用该 provider 的所有 key
- `<**#provider.N**>`：禁用该 provider 的第 N 个 auth key（序号从 1 开始，N 可以是任意正整数）
- `<**#provider.key**>`：禁用该 provider 的指定 keyAlias

**示例：**
```
<**#glm**>
（禁用 glm provider 的所有 key）

<**#openai.1**>
（禁用 openai provider 的第 1 个 auth key）

<**#openai.3**>
（禁用 openai provider 的第 3 个 auth key）

<**#anthropic.primary**>
（禁用 anthropic provider 的 keyAlias 为 "primary" 的 key）

<**#glm,openai.1**>
（当前 session 禁用 glm 的所有 key，并禁用 openai 的第 1 个 key）
```

### 5. 启用目标

**语法：** `<**@provider**>`、`<**@provider.N**>` 或 `<**@provider.key**>`

**效果：** 解除对应目标的禁用状态

**示例：**
```
<**@glm**>
（启用 glm provider 的所有 key）

<**@openai.1**>
（启用 openai provider 的第 1 个 auth key）

<**@openai.2**>
（启用 openai provider 的第 2 个 auth key）
```

### 6. 清除所有指令

**语法：** `<**clear**>`

**效果：** 清除所有强制、粘性、允许和禁用状态，恢复默认路由行为

**示例：**
```
<**clear**>
恢复正常路由
```

### 7. 自动续写 stopMessage（基于 sticky 状态）

> 仅当 RouteCodex 内置的 `stop_message_auto` servertool 启用时生效。

**语法：**

- 启用 / 更新自动续写：
  - `<**stopMessage:"继续"**>` → 默认最多自动续写 10 次；
  - `<**stopMessage:"继续",3**>` → 最多自动续写 3 次；
  - `<**stopMessage:<file://stopMessage/message1.md>**>` → 读取 `~/.routecodex/stopMessage/message1.md` 作为 stopMessage 文案（设置时读取并缓存到内存）；
- 清理 stopMessage 状态：
  - `<**stopMessage:clear**>`

**行为：**

- 标签只在路由层解析，不会透传给上游模型；
- 解析后写入当前 sticky session 状态：
  - `stopMessageText`：自动补发的用户消息内容；
  - `stopMessageMaxRepeats`：允许自动续写的最大次数（>=1）；
  - `stopMessageUsed`：已执行次数（从 0 开始计数）；
- stopMessage 阶段策略的 BD 状态判定：默认优先尝试真实命令查询（`bd --no-db list/ready --json`），命令失败时回退到历史消息启发式；
  - 可用 `ROUTECODEX_STOPMESSAGE_BD_MODE=auto|runtime|heuristic` 控制（默认 `auto`）；
  - 可用 `ROUTECODEX_STOPMESSAGE_BD_TIMEOUT_MS`、`ROUTECODEX_STOPMESSAGE_BD_CACHE_TTL_MS`、`ROUTECODEX_STOPMESSAGE_BD_WORKDIR` 调整运行参数；
- 当满足以下条件时，servertool 会自动发起后续请求：
  - 当前响应的 `choices[0].finish_reason === "stop"`；
  - 当前轮没有工具调用（`tool_calls` 为空）；
  - `stopMessageUsed < stopMessageMaxRepeats`；
  - 客户端仍处于连接状态（HTTP 层会在断连时设置 `clientDisconnected=true`，servertool 检测到后停止自动续写）；
- 自动续写时：
  - 以保存的原始 Chat 请求（`capturedChatRequest`）为基础，复制 `model/messages/tools/parameters`；
  - 在消息末尾追加一条 `{ role: "user", content: stopMessageText }`；
  - 自增 `stopMessageUsed` 并写回 sticky 存储；
  - 通过内部 `reenterPipeline` 再发起一次 /v1/chat/completions（对客户端透明，对 Responses / Chat / Gemini 协议统一生效）。

**示例：**

```text
<**stopMessage:"继续",3**>
帮我把这个项目的架构分 3 步讲完，每一步结束后我会说“继续”。
```

在该会话中：
- 当模型先给出第 1 段回答并以 `finish_reason=stop` 结束时，服务器会自动追加一条用户消息 `继续` 并发起第 2 轮；
- 若第 2 轮仍以 `stop` 结束且客户端仍连接，则再次自动补一条 `继续` 并发起第 3 轮；
- 使用次数达到 `maxRepeats` 后自动停止，不再继续补发。

## 目标标识格式

| 格式 | 含义 | 示例 |
|------|------|------|
| `provider` | Provider ID | `glm`, `openai`, `anthropic` |
| `provider.model` | Provider + 模型 | `glm.glm-4.7`, `openai.gpt-4` |
| `provider.key` | Provider + KeyAlias | `anthropic.primary`, `glm.backup` |
| `provider.N` | Provider + Key序号（从1开始，N为正整数） | `openai.1`, `glm.2`, `anthropic.3` |
| `provider.key.model` | 完整指定 | `openai.primary.gpt-4`, `glm.backup.glm-4.7` |

## 优先级规则

1. **单次强制（force）** > **粘性指定（sticky）** > **白名单（allow）** > **默认路由**
2. **禁用规则（disable）** 在所有优先级之上（任何被禁用的目标都无法被选中）
3. 多个指令在同一消息中时，按从左到右的顺序应用；
4. 有 sticky 时：
   - 除 `vision` / `web_search` / `longcontext` 显式命中之外，其它 route_hint（`coding` / `thinking` / `tools` / `search` 等）会被“粘性路由阶段”覆盖，优先命中真正包含粘性 provider/model 的路由；
   - 当粘性 provider 的所有 key 不可用时，自动清除 sticky，再按正常路由继续。

## 状态管理

### 持久化

路由指令状态按 `stickyKey` 隔离存储，`stickyKey` 的解析顺序为：
1. 对 Responses 协议（`providerProtocol === 'openai-responses'`）：
   - 若存在 Responses Resume 语义：`metadata.responsesResume.previousRequestId`；
   - 否则使用当前 `metadata.requestId`（仅在该条请求链路内生效）。
2. 对其它协议：
   - 优先使用 `metadata.sessionId`（如果存在）；
   - 否则 `metadata.conversationId`；
   - 否则回退为当前 `metadata.requestId`。

因此：
- Chat/Anthropic/Gemini 等协议下，同一 `sessionId` 或同一 `conversationId` 下的请求共享 sticky / allow / disable 状态；
- Responses 自动粘滞仅在单个 requestId/resume 链内生效，不会把 provider 选择粘到整个会话；
- 没有显式会话信息时，会退化为“按 requestId（以及 Resume 的 previousRequestId）维持的短期状态。

### Daemon 管理

通过 daemon 可以观察和修改当前的路由指令状态：

```bash
# 查看当前状态
routecodex daemon status routing

# 设置全局粘性目标
routecodex daemon set routing --sticky !glm.glm-4.7

# 禁用指定 key（序号）
routecodex daemon set routing --disable openai.1

# 禁用指定 key（alias）
routecodex daemon set routing --disable anthropic.primary

# 启用指定 provider
routecodex daemon set routing --enable glm

# 清除所有指令
routecodex daemon set routing --clear

# 查看指定 server 的状态
routecodex daemon status routing --server <server-id>
```

**Daemon 修改规则：**
- 修改后的状态需要指定影响的活动 server
- 未指定 server 时影响所有 server
- 修改立即生效，无需重启

## 错误处理

### 禁用错误

当请求的目标被禁用时，返回明确的错误信息：

```json
{
  "error": "Requested provider glm is disabled",
  "code": "PROVIDER_NOT_AVAILABLE",
  "details": {
    "provider": "glm",
    "reason": "disabled"
  }
}
```

### 不存在错误

当请求的目标不存在于配置中时：

```json
{
  "error": "Requested provider not.found not found in provider registry",
  "code": "PROVIDER_NOT_AVAILABLE",
  "details": {
    "provider": "not.found"
  }
}
```

### 健康检查失败

当请求的目标存在但健康检查失败时：

```json
{
  "error": "Requested provider glm is not available (health check failed)",
  "code": "PROVIDER_NOT_AVAILABLE",
  "details": {
    "provider": "glm",
    "reason": "unhealthy"
  }
}
```

## 使用场景

### 场景 1：临时切换到指定模型

```
<**glm.glm-4.7**>
帮我分析这段代码
```

### 场景 2：持续使用某个 provider

```
<**!openai**>
（后续对话都使用 openai）
...
<**clear**>
恢复正常
```

### 场景 3：禁用某个 key 避免限流

```
<**#openai.1**>
（禁用 openai 的第1个 key）
```

### 场景 4：只允许特定 provider（白名单）

```
<**!glm**>
（只允许 glm provider）
```

### 场景 5：多 key 轮换场景

配置了 3 个 openai key，遇到限流时：

```
<**#openai.1**>
（禁用第1个 key，自动使用第2、3个）

<**#openai.2**>
（继续禁用第2个，只使用第3个）

<**@openai.1**>
（第1个 key 恢复后重新启用）
```

### 场景 6：按序号禁用/启用

```
<**#anthropic.1**>
（禁用第1个 key）

<**#anthropic.2**>
（禁用第2个 key）

<**@anthropic.1**>
（启用第1个 key）
```

## 注意事项

1. **消息清理**：指令标签 `<**...**>` 会被自动从用户消息中移除，不会发送给上游 AI
2. **大小写敏感**：provider ID、keyAlias 等标识符区分大小写
3. **序号从1开始**：`<**provider.1**>` 表示第1个 key，不是从0开始，序号可以是任意正整数
4. **stickyKey 隔离**：不同会话的状态互不影响，使用 daemon 修改时需要指定 server
5. **健康检查**：即使指定了目标，如果目标处于不健康状态，路由仍会失败
6. **序号动态性**：key 序号是动态的，基于配置文件中 auth 数组的顺序

## 参考实现

- 解析逻辑：`sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.ts`
- 类型定义：`sharedmodule/llmswitch-core/src/router/virtual-router/types.ts`
- 集成位置：`sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts`
- Daemon 接口：`src/daemon/`（待实现）
