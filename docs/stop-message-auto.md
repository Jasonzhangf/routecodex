# sm 自动续轮设计（servertool）

本文描述 RouteCodex 在 `finish_reason=stop` 时的 stopMessage 自动推进机制，重点覆盖：

- 指令语法（`sm`）
- marker 生命周期（lifecycle）
- 错误管理（error handling）
- tmux 注入路径与状态更新规则

## 1. 指令语法

### 1.1 `sm`（默认 review 模式）

- 目标 + 轮次：
  - `<**sm:"补齐交付证据",30**>`
- 只有目标（持续执行直到目标达成）：
  - `<**sm:"补齐交付证据"**>`
- 模式 + 轮次（无显式目标时使用默认目标“继续执行”）：
  - `<**sm:on/30**>`
- 仅轮次（等价于 on + 轮次）：
  - `<**sm:30**>`
- 关闭（等价 clear）：
  - `<**sm:off**>`

`sm` 默认语义：

- `stopMessageAiMode = on`（review followup）
- 未提供轮次时使用“长轮次上限”实现持续推进语义
- review followup 必须先按请求真实核验代码（文件/测试/命令证据）再给建议，禁止只给抽象建议

## 2. 状态模型（sticky / tmux scope）

stopMessage 相关状态挂在 sticky session state（tmux 作用域）：

- `stopMessageText?: string`
- `stopMessageMaxRepeats?: number`
- `stopMessageUsed?: number`
- `stopMessageUpdatedAt?: number`
- `stopMessageLastUsedAt?: number`
- `stopMessageStageMode?: 'on' | 'off' | 'auto'`
- `stopMessageAiMode?: 'on' | 'off'`
- `stopMessageAiSeedPrompt?: string`
- `stopMessageAiHistory?: Array<Record<string, unknown>>`

## 3. Marker 生命周期（Lifecycle）

### 3.1 生效范围

- 只解析**最新一条 user 消息**中的 `<**...**>` marker。
- 旧消息 marker 不会被重复重放。

### 3.2 同轮优先级

同一条消息里多个 `sm` marker 的规则：

1. 若存在 `sm:off`，最终以 clear 为准。
2. 若无 clear，最后一个 `sm` 指令生效。

### 3.3 运行期推进

当满足触发条件（stop finish + scope 可注入 + 状态有效）时：

1. 生成下一步 followup 文本（`ai:on` 时由 reviewer 流程生成）。
2. 使用 `clientInjectOnly` 路径向 tmux 客户端注入。
3. 成功后 `stopMessageUsed += 1` 并持久化。
4. 达到 `stopMessageMaxRepeats` 后自动停用（清理激活态）。

## 4. 错误管理（Error Handling）

### 4.1 解析错误

- 非法 marker（如 `sm:on/not-a-number`）按 fail-closed 处理：
  - 忽略该 marker
  - 不改写当前有效状态
  - 主请求继续

### 4.2 文件引用错误

- `file://` 无法解析或读取失败时：
  - 不设置新 stopMessage 状态
  - 主请求继续

### 4.3 注入错误

- tmux 注入失败时：
  - 清理当前 tmux scope 的 stopMessage 激活状态
  - 不让坏状态持续触发循环
  - 主请求仍按正常响应完成（不因 stopMessage 注入失败硬失败）

### 4.4 followup 生成错误

- AI followup 子流程失败会记录可观测日志与进度事件；
- 不允许静默吞错导致“看起来成功但状态不一致”。

## 5. 实现锚点（当前代码）

- 指令解析：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_instruction.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/parse/parse_targets.rs`
- 状态应用：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_actions.rs`
- 自动处理器：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`

## 6. 验证要点

建议最少覆盖以下回归用例：

1. `sm:"目标",30` 解析为 `stopMessageSet` 且 `ai:on`。
2. `sm:off` 清理状态。
3. `sm:on/not-a-number` 被忽略且不污染状态。
4. 同轮 `sm:"目标",30 + sm:off` 以 clear 生效。
5. 注入失败后状态被清理，下一轮不应自循环触发。
