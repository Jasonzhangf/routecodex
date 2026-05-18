# stopless 自动续轮（最简版）

本文定义当前唯一有效的 stopless 语义。

## 1. 默认行为

- 默认开启。
- 默认注入文本：`继续执行`
- 默认最大次数：`2`
- 通过 tmux `clientInjectOnly` 注入，不走 reenter followup。

## 2. 触发规则

当本轮响应 `finish_reason=stop` 时：

### 2.1 `/goal` 模式

- 若 `goal.status = active`：**什么都不做**
- 若 `goal.status != active`：**自动注入一次 `继续执行`**

### 2.2 非 `/goal` 模式

- 直接自动注入一次 `继续执行`

## 3. 次数控制

- 状态记录在 sticky/tmux scope 下：
  - `stopMessageText`
  - `stopMessageMaxRepeats`
  - `stopMessageUsed`
- 达到 `maxRepeats` 后自动清理状态，不再继续注入。

## 4. 当前明确移除的旧复杂语义

以下旧 stopless / stopMessage 魔块不再是当前真相：

- AI/reviewer followup 生成
- approved/done marker 审批链
- 非 `/goal` no-progress 计数器
- `stopless_goal_guard` 第二自动决策面
- “复杂继续执行提示词追加”

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
  },
  "aiFollowup": {
    "enabled": false
  }
}
```
