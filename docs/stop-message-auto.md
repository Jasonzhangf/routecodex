# stopless 自动续轮

本文定义当前唯一有效的 stopless 语义。

## 1. 默认行为

- 默认开启。
- 默认最大次数：`3`。
- 不再通过 tmux `clientInjectOnly` 或私有 followup/reenter 执行。
- 当 stopless 触发时，响应投影为客户端可见的 `exec_command`：
  - `routecodex servertool run stop_message_auto --input-json <json>`
  - 客户端按普通工具调用执行 CLI，并按普通 `exec_command` 工具结果回传。
- 被拦截的 assistant stop 文本必须投影到 Responses `reasoning` / Chat `reasoning_*` 字段，避免客户端看不到 summary。
- CLI input 必须包含 `repeatCount`、`maxRepeats`、`continuationPrompt`。
- `continuationPrompt` 不得只是固定 `继续执行`；必须是启发式多段核对提示，覆盖当前用户目标、已完成步骤、是否完成/阻塞、建议下一步、证据核验、问题根因、已排除因素、排查顺序、learned。

## 2. 触发规则

当本轮响应 `finish_reason=stop` 时：

### 2.1 `/goal` 模式

- 若 `goal.status = active`：**什么都不做**
- 若 `goal.status != active`：投影 `stop_message_auto` CLI 工具调用，并携带启发式核对提示。

### 2.2 非 `/goal` 模式

- 投影 `stop_message_auto` CLI 工具调用，并携带启发式核对提示。

## 3. 次数控制

- 状态记录在 runtime/followup metadata scope 下：
  - `stopMessageText`
  - `stopMessageMaxRepeats`
  - `stopMessageUsed`
- CLI input 中 `repeatCount` / `maxRepeats` 必须始终存在，缺 runtime state 时使用 `repeatCount=0`、`maxRepeats=3`。
- 当前 Rust 真源中，provided schema 与 missing schema 都按连续 3 次 stop 收敛；旧的 missing-schema 10 次文档已过期。
- 非连续 stop、工具调用或正常进展必须 reset 连续 stop 计数。

## 4. 当前明确移除的旧复杂语义

以下旧 stopless / stopMessage 魔块不再是当前真相：

- AI/reviewer followup 生成
- approved/done marker 审批链
- 非 `/goal` no-progress 计数器
- `stopless_goal_guard` 第二自动决策面
- 固定 `继续执行` 文案作为最终注入文本。

## 5. 真源文件

- 自动续轮 owner：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- goal state 读取：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.ts`
- stopMessage 状态持久化：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/routing-state.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`

## 6. 配置

配置文件：

- `~/.rcc/config/stop-message.json`

最简配置示例：

```json
{
  "default": {
    "enabled": true,
    "text": "继续执行",
    "maxRepeats": 2
  }
}
```
