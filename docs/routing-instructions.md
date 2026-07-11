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
- 可以与禁用规则叠加使用。

**示例：**
```text
<**antigravity**>
（当前会话仅使用 antigravity 相关的所有模型/key）
```

### 2. Provider 粘性路由（已废弃）

provider pinning fields have been physically removed from Virtual Router semantics.

- `<**sticky:provider.model**>` 不再是路由 primitive，会被忽略。
- `<**!provider.model**>` 不再表示持续粘性；带模型/alias/key 的 `!` 指令按 prefer/allow 过滤语义处理，不产生跨轮 provider pin。
- 普通路由只看当前最新请求。历史工具调用、工具声明和上轮 route 不参与当前轮 route decision。
- Continuation 不是 sticky：direct/remote continuation 恢复原 provider key；local/relay continuation 只恢复本地上下文，不 pin provider。

### 3. 允许筛选（provider 白名单）

**语法：** `<**!provider**>` 或 `<**!providerA,providerB**>`（注意：**无 `.` 时才是白名单语义**）

**效果：**
- 仅对当前会话生效；
- 将可用 provider 限制到给定集合（`allowedProviders`），所有不在白名单中的 provider 及其 key 都不会参与路由；
- 新的 `<**! ...**>` 会覆盖该会话先前设置的白名单；如需允许多个 provider，请在同一条指令中用逗号写在同一条里；
- 白名单本身不改变路由优先级，只是过滤候选 provider 集合，可以与禁用规则叠加。

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

**效果：** 清除所有强制、允许和禁用状态，恢复默认路由行为

**示例：**
```
<**clear**>
恢复正常路由
```

### 7. 自动续写 stopMessage（基于 routing state）

> 仅当 RouteCodex 内置的 `stop_message_auto` servertool 启用时生效。

**语法（仅 `sm`）：**

- `<**sm:"补齐交付证据",30**>` → 目标 + 轮次；
- `<**sm:"补齐交付证据"**>` → 只有目标（持续执行直到目标达成）；
- `<**sm:on/30**>` / `<**sm:30**>` → 无显式目标时使用默认目标“继续执行”；
- `<**sm:<file://stopMessage/message1.md>**>` → 读取 `~/.rcc/stopMessage/message1.md` 作为 stopMessage 文案；
- `<**sm:off**>` → 清理 stopMessage 状态。

**行为：**

- 标签只在路由层解析，不会透传给上游模型；
- 解析后写入当前 routing-state session 状态：
  - `stopMessageText`：自动补发的用户消息内容；
  - `stopMessageMaxRepeats`：允许自动续写的最大次数（>=1）；
  - `stopMessageUsed`：已执行次数（从 0 开始计数）；
- marker 生命周期规则：
  - 只以最新一条 user 消息为准；
  - 同条消息中存在多个 `sm` 时，`off` 优先；否则最后一条生效；
  - 注入成功后 `stopMessageUsed += 1`，达到上限后自动停用；
- stopMessage 阶段策略的 BD 状态判定：默认优先尝试真实命令查询（`bd --no-db list/ready --json`），命令失败时直接报错不降级；
  - 可用 `ROUTECODEX_STOPMESSAGE_BD_MODE=runtime` 控制（仅允许真实命令查询，`auto`/`heuristic` 废弃）；
  - 可用 `ROUTECODEX_STOPMESSAGE_BD_TIMEOUT_MS`、`ROUTECODEX_STOPMESSAGE_BD_CACHE_TTL_MS`、`ROUTECODEX_STOPMESSAGE_BD_WORKDIR` 调整运行参数；
- 当满足以下条件时，servertool 会自动发起后续请求：
  - 当前响应的 `choices[0].finish_reason === "stop"`；
  - 当前轮没有工具调用（`tool_calls` 为空）；
  - `stopMessageUsed < stopMessageMaxRepeats`；
  - 客户端仍处于连接状态（HTTP 层会在断连时设置 `clientDisconnected=true`，servertool 检测到后停止自动续写）；
- 自动续写时：
  - 生成下一步 followup 文本（默认 review 模式，`ai:on`）；
  - 通过 `clientInjectOnly` 路径向绑定 tmux 客户端注入文本（不走嵌套 reenter 请求）；
  - 自增 `stopMessageUsed` 并写回 routing-state 存储；
  - 注入失败时清理 stopMessage 激活状态并保留主请求完成。
- 错误管理：
  - 非法 marker（如 `sm:on/not-a-number`）忽略且不改写状态；
  - 无法解析的 `file://` marker 不生效，但主请求继续；
- 注入失败会清理 stopMessage 激活状态，避免坏状态自循环。

**示例：**

```text
<**sm:"继续",3**>
帮我把这个项目的架构分 3 步讲完，每一步结束后我会说“继续”。
```

在该会话中：
- 当模型先给出第 1 段回答并以 `finish_reason=stop` 结束时，服务器会自动追加一条用户消息 `继续` 并发起第 2 轮；
- 若第 2 轮仍以 `stop` 结束且客户端仍连接，则再次自动补一条 `继续` 并发起第 3 轮；
- 使用次数达到 `maxRepeats` 后自动停止，不再继续补发。

### 8. `stopless`（RCC 目标生命周期）

**唯一语法：**

```text
<**rcc**>
stopless start
<goal body>
</rcc**>
```

同一套 RCC fence 还承载：

- `stopless pause`
- `stopless resume`
- `stopless stop`
- `stopless done`

**效果：**

- 只解析最新 user turn 中的 `<**rcc**> ... </rcc**>` block；
- parser 真源在 Rust hotpath；
- `stopless start` 的 body 作为目标正文透传上游；不再写入本地 goal/routing state；
- `pause/resume/stop/done` 不再维护本地目标状态；
- stopless 是否继续只看当前请求闭环的 MetadataCenter `runtime_control.stopless` 与 tool output，不再读取 goal state。

**唯一状态：**

- `idle`
- `active`
- `paused`
- `stopped`
- `completed`

**实现锚点：**

- `docs/design/rcc-unified-fence-marker-spec.md`

## 目标标识格式

| 格式 | 含义 | 示例 |
|------|------|------|
| `provider` | Provider ID | `glm`, `openai`, `anthropic` |
| `provider.model` | Provider + 模型 | `glm.glm-4.7`, `openai.gpt-4` |
| `provider.key` | Provider + KeyAlias | `anthropic.primary`, `glm.backup` |
| `provider.N` | Provider + Key序号（从1开始，N为正整数） | `openai.1`, `glm.2`, `anthropic.3` |
| `provider.key.model` | 完整指定 | `openai.primary.gpt-4`, `glm.backup.glm-4.7` |

## 优先级规则

1. **单次强制（force）** > **白名单（allow）** > **默认路由**
2. **禁用规则（disable）** 在所有优先级之上（任何被禁用的目标都无法被选中）。
3. 多个指令在同一消息中时，按从左到右的顺序应用。
4. provider 粘性路由已废弃；普通路由只按当前最新请求重新判断。Continuation 只做上下文恢复：direct/remote 恢复原 provider key，local/relay 不 pin provider。

## 状态管理

### 持久化

路由指令状态按 routing-state key 隔离存储，解析顺序为：
1. 对 Responses 协议（`providerProtocol === 'openai-responses'`）：
   - 若存在 Responses Resume 语义：`metadata.responsesResume.previousRequestId`；
   - 否则使用当前 `metadata.requestId`（仅在该条请求链路内生效）。
2. 对其它协议：
   - 优先使用 `metadata.sessionId`（如果存在）；
   - 否则 `metadata.conversationId`；
   - 否则回退为当前 `metadata.requestId`。

因此：
- Chat/Anthropic/Gemini 等协议下，同一 `sessionId` 或同一 `conversationId` 下的请求共享 allow / disable / stopMessage / stopless 本地状态；
- Responses continuation 只恢复对应 request chain 的上下文，不把普通 provider 选择粘到整个会话；
- 没有显式会话信息时，会退化为按 requestId（以及 Resume 的 previousRequestId）维持的短期状态。

### Daemon 管理

通过 daemon 可以观察和修改当前的路由指令状态：

```bash
# 查看当前状态
routecodex daemon status routing

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
4. **routing-state key 隔离**：不同会话的状态互不影响，使用 daemon 修改时需要指定 server
5. **健康检查**：即使指定了目标，如果目标处于不健康状态，路由仍会失败
6. **序号动态性**：key 序号是动态的，基于配置文件中 auth 数组的顺序

## 参考实现

- 解析逻辑：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/parse.rs`
- 类型定义：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/types.rs`；历史 TS `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts` 已删除，不得恢复为 source-side binding contract
- 集成位置：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine`
- Daemon 接口：`src/daemon/`（待实现）
