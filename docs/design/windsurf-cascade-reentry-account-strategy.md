# Windsurf Cascade 多轮调用对齐 & Account Strategy

## Scope

本文记录 Windsurf provider 当前要补齐的两个阶段：

1. 单账号先调通：对齐 Windsurf.app 的 Cascade 多轮调用行为，同一 session 能稳定续杯，不每轮重建 cascade。
2. 多账号再管理：保证 session 尽量绑定账号与 cascade，只用多账号承载并发，不把 busy 当账号失效。

权威协议细节仍以：

- `docs/providers/windsurf-chat-provider-design.md`
- `docs/design/windsurf-cascade-tool-protocol.md`
- `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`
- `/Volumes/extension/code/WindsurfAPI`

为准。本文只负责多轮调用对齐、busy、账号绑定策略。

## Terminology

### 多轮调用对齐（Cascade Continuation）

多轮调用对齐指对齐 Windsurf.app 的行为：用户在同一 session 中发送多条消息时，RouteCodex 应复用同一个 `cascadeId`，在同一个 Cascade 会话中续杯，不每轮 `StartCascade` 重建。

这是 RouteCodex 的主目标。

#### Reentry（实现细节）

`reentry` 指对同一个 `cascadeId` 再次调用 `SendUserCascadeMessage`，向同一个 Cascade 会话追加消息。这是多轮调用对齐的底层实现动作，不是目标本身。

多轮调用对齐的主目标是对齐 Windsurf.app 中同一个 Cascade 面板继续对话的行为。

### Rebuild

`rebuild` 指不复用旧 `cascadeId`，而是重新调用 `StartCascade` 获取新 cascade。

这是新建会话行为，不是续杯。

### Busy

`busy` 指账号或 Cascade runtime 当前不能接收新请求。

当前已验证的真实 LS busy 信号：

```text
executor is not idle: CASCADE_RUN_STATUS_RUNNING
```

该错误只表示同一个 cascade 的 executor 尚未 settle，不代表账号 auth/quota/runtime 失效。

## Verified Facts

真实 LS gRPC probe（2026-05-30，`ws-pro-1`，`gpt-5-4-medium`）验证：

1. 首次 `StartCascade` + `SendUserCascadeMessage` 成功。
2. `GetCascadeTrajectory.status=2` 后立即发第二条消息（多轮续杯），`SendUserCascadeMessage` 返回 `CASCADE_RUN_STATUS_RUNNING`。
3. `GetCascadeTrajectory.status=2` 不等价于 executor 可接收下一条消息。
4. 继续等待约 40 秒后，同 `cascadeId` 多轮续杯成功。
5. 新建第二个 session 的 `StartCascade` 返回不同 `cascadeId`，session isolation 成立。

结论：

- 多轮续杯能用，但需要 bounded wait/retry。
- 多轮续杯 busy 不能触发 cascade rebuild。
- 多轮续杯 busy 不能触发账号切换。
- 多轮续杯 busy 不能写入 auth/quota/runtime failure 状态。

## Gap vs Windsurf.app

### App Has Active Cascade Lifecycle

Windsurf.app 在发送后会维护 active Cascade lifecycle：

```text
markCascadeIdActive / setCascadeId
```

面板层知道当前 cascade 是否仍 active，用户继续对话天然落到同一个 cascade。

RouteCodex 当前是 HTTP bridge，没有 UI panel lifecycle，只能通过 `sessionKey -> cascadeId` 绑定模拟。

### App Can Wait UX-side

Windsurf.app 可以让 UI 等待 executor settle，再允许下一轮输入。

RouteCodex 是 API bridge，必须显式处理：

- cascade busy retry（多轮续杯遇到 executor busy 时的 bounded retry）
- retry timeout
- 对外错误码
- session/account binding

### App Is Single Visible Account

Windsurf.app 通常只操作当前登录账号。

RouteCodex 多账号只为并发，不应改变单 session 的语义连续性。

## Single-account Work

单账号目标：先保证一个账号、一个 LS runtime、一个 session 能稳定多轮调用，对齐 Windsurf.app 的 Cascade 多轮对话行为。

### Required Behavior

1. 首次请求：`StartCascade` 创建 `cascadeId`，绑定到 `sessionKey`。
2. 后续同 `sessionKey` 请求：优先复用同一个 `cascadeId`。
3. 若续杯时返回 `CASCADE_RUN_STATUS_RUNNING`：
   - 识别为 cascade busy。
   - 保留原 `cascadeId`。
   - 不 `StartCascade` 重建。
   - 不清除 session binding。
   - 不标记账号失败。
   - bounded wait/retry 同一个 `SendUserCascadeMessage`。
4. retry 成功后继续正常 poll trajectory。
5. retry 超时后 fail-fast 返回明确 busy 错误。
6. 仅在明确 cascade expired/panel missing/untrusted workspace 等不可继续错误时，才允许清 binding 并按设计处理。

### Required Tests

#### Unit Tests

1. Same session reuses same cascade.
2. `CASCADE_RUN_STATUS_RUNNING` triggers bounded retry, not rebuild.
3. Retry uses same `cascadeId` and same `sessionId`.
4. Retry success preserves `stepOffset` update.
5. Retry timeout returns explicit busy error.
6. Busy error does not call account failure methods.

#### Real LS Probe

1. `StartCascade` + first `SendUserCascadeMessage` succeeds.
2. Immediate second message returns `CASCADE_RUN_STATUS_RUNNING`.
3. Waiting/retrying same cascade eventually succeeds.
4. No new `StartCascade` happens during multi-turn retry.

### Acceptance Gate

单账号未达成前，不做多账号复杂管理。

单账号完成标准（多轮调用对齐 Windsurf.app）：

- 同 session 连续两轮不重建 cascade。
- 遇到 `CASCADE_RUN_STATUS_RUNNING` 后 bounded retry 成功。
- 超时路径 fail-fast，错误可观测。
- provider 不把 cascade busy 归类为 account failure。

## Multi-account Work

多账号目标：多账号只为并发扩容；同一 session 尽量绑定同一账号与同一 cascade，避免语义漂移与不必要重建。

### Required Behavior

1. `sessionKey` 首次命中某账号后，建立绑定：

```text
sessionKey -> accountAlias -> runtime -> cascadeId
```

2. 同 `sessionKey` 后续请求优先回到原 `accountAlias`。
3. 同 `sessionKey` 的 cascade busy：
   - 优先等待/返回 busy。
   - 不切到其他账号。
   - 不新建其他账号 cascade。
4. 不同 `sessionKey` 可以命中不同账号，实现并发。
5. 只有明确不可恢复错误才允许解除 session-account binding：
   - auth invalid
   - quota exhausted
   - runtime unavailable after verified failure
   - cascade expired/panel missing 且重建失败
6. 多账号选择只处理 capacity，不处理 Cascade 语义补偿。

### Required Tests

#### Unit Tests

1. `sessionA` 首次选 `account1`，后续仍选 `account1`。
2. `sessionB` 可选 `account2` 并发。
3. `sessionA` 的 `account1` cascade busy 时，不漂移到 `account2`。
4. `sessionA` busy 时返回 429/busy 或等待策略结果，而非重建/切号。
5. auth/quota fatal 才解除绑定并允许重选账号。
6. account busy 不写 quota cooldown，不写 auth invalid。

#### Router/Executor Tests

1. 每账号 `maxInFlight=1`。
2. 同账号并发超限返回明确 busy/429。
3. 不同账号可并发。
4. busy status 在 Virtual Router 与 provider error catalog 中保持可观测。

### Acceptance Gate

多账号完成标准：

- session affinity 稳定。
- busy 不触发账号失效。
- fatal 才解绑。
- 多账号只提升并发，不改变单 session 的 Cascade 连续性。

## Anti-patterns

禁止以下行为：

1. 遇到 `CASCADE_RUN_STATUS_RUNNING` 直接 `StartCascade` 新建。
2. 遇到 cascade busy 切账号。
3. 把 cascade busy 记为 quota/auth/runtime failure。
4. 为了降低延迟丢弃旧 cascade 语义。
5. 在 Hub Pipeline / Virtual Router 写 Windsurf provider 特例。
6. 用 fallback 双路径补偿 Cascade lifecycle。

## Next Implementation Order

1. 固化真实 LS probe 为可重复脚本。
2. 新增单账号多轮调用 bounded retry unit tests，先红。
3. 实现 provider 内同 cascade bounded retry。
4. 跑单账号真实 LS probe 验证多轮调用对齐。
5. 再新增多账号 session-account affinity tests。
6. 最后实现多账号 busy/affinity 管理。
