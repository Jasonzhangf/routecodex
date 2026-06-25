# stopless 自动续轮

本文定义当前唯一有效的 stopless 语义：严格按 `sessionId` 匹配状态，并通过 CLI 闭环继续执行；不得再走透明 reenter 注入。

## 1. 默认行为

- 默认开启，默认最大连续 stop 次数为 `3`。
- stop hook 在 stopless 管理回合中必须无条件注入并持续存在；优先路径始终是模型主动调用 `reasoningStop` function tool 并携带完整 schema；如果注入丢失，不能期待模型主动调用，只能依赖 3 次自动停止护栏收口。
- 状态 key 只能是 `session:<sessionId>`；如果调用方没传 `sessionId/requestId`，CLI/runtime 必须自己补齐，但补出来的 session 只保证本次工具执行可闭环，不代表后续 turn 会命中同一个稳定会话状态。
- 禁止用 `tmuxSessionId`、`conversationId`、`default`、`stopMessageClientInject*` 作为 stopless 状态 fallback。
- 当 stopless 触发时，服务端必须投影一个客户端可见 `exec_command`；不得直接 `reenterPipeline`。
- CLI command 只允许承载 `flowId`、`repeatCount`、`maxRepeats`；不得暴露 continuationPrompt/schemaGuidance/raw prompt text。
- CLI stdout 必须返回 continuationPrompt 和 schemaGuidance，供下一轮工具结果闭环使用；continuationPrompt 必须明确说明“若要停止，模型必须主动调用停止 hook 并附完整 schema”。
- 泛化 servertool CLI projection 仍可服务非 stopless 的 client-exec 路径，例如 `servertool_fixture`；stopless 使用同一 CLI 投影总线，但拥有独立 gate。

## 2. 触发规则

当本轮响应 `finish_reason=stop` 时：

- `/goal active` 和 plan mode 跳过 stopless gate，按普通响应返回。
- 其他请求进入 Rust stop gate / stop schema gate。
- 缺失 schema 时，触发 zero-arg CLI stop hook，要求补 schema。
- schema 非法、参数非法、`stopreason=2` 或其他不满足停止条件时，触发带 schema 入参的 CLI stop hook；hook 返回里必须明确给出解析结果、错误字段/错误值、以及模型下一次需要如何修正 schema。
- `stopreason=0|1` 且 schema 满足停止条件时允许最终停止；这条不要求模型必须先主动调用 hook，只要求 schema 合法。
- budget exhausted 时返回最终 stop summary，不再循环。

## 3. 状态与次数控制

- 状态持久化只以 `session:<sessionId>` 为 sticky key。
- `stopMessageText`、`stopMessageMaxRepeats`、`stopMessageUsed` 只在对应 session scope 内有效。
- 非 stop 响应、出现合法 schema、出现有效主动 stop hook、或正常工具进展时必须 reset 连续 stop 计数。
- provided-schema 与 missing-schema 都按当前 Rust 真源收敛，不允许 TS 另建计数语义。
- 连续 3 次 `finish_reason=stop + 无 schema + 无有效闭环` 时直接停止；这是 loop guard stop，不是 schema-pass stop。

## 4. 透明续轮契约

CLI 续轮的唯一行为是把下一步要求封装进 stopless CLI 结果，再由正常 `submit_tool_outputs` 进入下一轮：

```text
Provider response
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> Rust stopless/stop schema decision
  -> stopless action = cli_projection
  -> client-visible exec_command(routecodex hook run stop_message_auto --input-json {"flowId","repeatCount","maxRepeats"})
  -> client submits ordinary exec_command output
  -> normal request chain
```

约束：

- `StoplessOrchestrationAction` 只能是 `terminal_final` 或 `cli_projection`。
- TS `engine.ts` 只能消费 Rust plan，并调用 CLI projection 或 terminal side effect；不得重建 scope、fallback、reenter、projection seed 或 stop schema 判断。
- continuation prompt / stop schema guidance 只能存在于 stopless CLI result，不得存在于命令参数字符串。
- 前置注入与续轮注入必须使用同一个停止 hook 语义：模型在想停止时必须主动调用该 hook；若本轮未调用而直接 stop，系统只允许补打一轮同一 hook，并在结果中再次要求模型下一轮自己调用。
- 如果系统自动补打了 stop hook，则该 hook 结果在下一轮请求中必须被玻璃化为文本输入；只有模型主动发起的 stop hook 才保留为真实 tool call/tool result 历史。

## 5. Stop Schema

模型尝试停止时必须在回复末尾提供 JSON：

```json
{
  "stopreason": 0,
  "reason": "finished/blocked reason",
  "has_evidence": 1,
  "evidence": "file/log/command output/test evidence",
  "issue_cause": "problem cause or empty string",
  "excluded_factors": "ruled-out factors or empty string",
  "diagnostic_order": "diagnostic order already executed",
  "done_steps": "completed steps or empty string",
  "next_step": "next step to execute immediately or empty string",
  "next_suggested_path": "suggested path or empty string",
  "needs_user_input": false,
  "learned": "learned fact or empty string"
}
```

- `stopreason`: `0=finished`、`1=blocked`、`2=continue_needed`。
- `has_evidence` 只能是 `0|1`。
- `needs_user_input=true` 只用于确实需要问用户一个简单问题；否则应继续执行或最终停止。

## 6. 真源文件

- Rust orchestration owner: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`
- Rust persisted lookup / session scope owner: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- Stopless loop state owner: request-scoped MetadataCenter `runtime_control.stopless` plus current request tool output; goal state is removed.
- NAPI bridge: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- TS native thin wrapper: `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- TS execution shell: `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- Focused tests: `tests/servertool/stopless-cli-continuation.spec.ts`

## 7. 验证

必跑 gates：

- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p servertool-core persisted_lookup --lib -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts --runInBand`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

Live probe 必须证明：

- 请求带稳定 `sessionId`。
- 客户端响应含 `exec_command(routecodex hook run stop_message_auto ...)`，但命令参数不含 continuationPrompt/schemaGuidance/raw prompt text。
- CLI stdout 含 continuationPrompt/schemaGuidance，且下一轮使用普通 tool result 闭环。
- 服务端日志不再出现 stopless `reenterPipeline`。
- 不同 `sessionId` 不共享 stopless state。
