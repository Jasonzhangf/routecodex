# stopless 自动续轮

本文定义当前唯一有效的 stopless 语义：严格按 `sessionId` 匹配状态，并通过 CLI 闭环继续执行；不得再走透明 reenter 注入。

## 1. 默认行为

- 默认开启，默认最大连续 stop 次数为 `3`。
- stopless managed relay 回合必须无条件注入完整 system stop schema，并声明 exactly-one provider-facing/model-visible internal `reasoningStop` function tool；direct/provider-direct 不得注入 stopless guidance 或 `reasoningStop`。
- 状态 key 只能是 `session:<sessionId>`；若调用方缺失稳定 `sessionId`，stopless/CLI/runtime 必须 fail-fast，禁止自行补会话身份后继续伪闭环。
- 禁止用 `tmuxSessionId`、`conversationId`、`default`、`stopMessageClientInject*` 作为 stopless 状态 fallback。
- 当 stopless 触发时，服务端必须投影一个客户端可见 `exec_command`；不得直接 `reenterPipeline`。
- CLI command/stdout 只允许承载状态和控制字段；不得承载 provider-facing continuationPrompt/schemaGuidance/raw prompt text。
- schema 引导只存在于 system prompt；下一轮 provider user prompt 由 ReqChatProcess 直接生成。
- 泛化 servertool CLI projection 仍可服务非 stopless 的 client-exec 路径，例如 `servertool_fixture`；stopless 使用同一 CLI 投影总线，但拥有独立 gate。

## 2. 触发规则

当本轮响应 `finish_reason=stop` 时：

- `/goal active` 和 plan mode 跳过 stopless gate，按普通响应返回。
- 其他请求进入 Rust stop gate / stop schema gate。
- 缺失 schema 时，触发 zero-arg CLI stop hook，要求补 schema。
- schema 非法、参数非法、`stopreason=2` 或其他不满足停止条件时，触发带 schema 入参的 CLI stop hook；hook 返回里必须明确给出解析结果、错误字段/错误值、以及模型下一次需要如何修正 schema。
- `stopreason=0|1` 且 schema 满足停止条件时允许最终停止；这条不要求模型必须先主动调用 hook，只要求 schema 合法。
- 同一 session 连续第 1、2 次 missing/invalid schema stop 时拦截并投影 CLI，`repeatCount` 分别为 `1`、`2`。
- 同一 session 连续第 3 次 missing/invalid schema stop 达到上限时不再拦截、不再投影 CLI，也不合成 terminal summary；必须把本轮原始 `finish_reason=stop` 响应直接放行给客户端。
- CLI/手工入口收到 `repeatCount >= maxRepeats` 必须 fail-fast；禁止 clamp 或伪造 `budget_exhausted` 成功输出。

## 3. 状态与次数控制

- 状态持久化只以 `session:<sessionId>` 为 sticky key。
- `stopMessageText`、`stopMessageMaxRepeats`、`stopMessageUsed` 只在对应 session scope 内有效。
- 非 stop 响应、出现合法 schema、出现有效主动 stop hook、或正常工具进展时必须 reset 连续 stop 计数。
- provided-schema 与 missing-schema 都按当前 Rust 真源收敛，不允许 TS 另建计数语义。
- 连续 3 次 `finish_reason=stop + missing/invalid schema` 时，第 3 次直接放行原始 stop；这是 loop guard passthrough，不是 schema-pass stop，也不是 RouteCodex 合成的 terminal response。
- 任何非 stop 正常进展、普通工具调用、合法 terminal schema、`simple_question=true` 或 session 变化都会把连续计数归零；之后再遇到 missing/invalid schema stop 必须从 `repeatCount=1` 重算。

## 4. 透明续轮契约

CLI 续轮的唯一行为是向客户端投影公共命令，执行结果经正常 `submit_tool_outputs` 回来后被 ReqChatProcess 私下消费：

```text
Provider response
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> Rust stopless/stop schema decision
  -> stopless action = cli_projection
  -> client-visible exec_command(routecodex hook run reasoningStop --input-json status/control)
  -> client submits ordinary exec_command output
  -> ReqChatProcess reads current responsesResume/MetadataCenter truth
  -> stopless call/result pair is removed
  -> provider receives one ordinary user prompt plus the system schema
  -> normal request chain
```

约束：

- `StoplessOrchestrationAction` 只能是 `terminal_final` 或 `cli_projection`。
- TS `engine.ts` 只能消费 Rust plan，并调用 CLI projection 或 terminal side effect；不得重建 scope、fallback、reenter、projection seed 或 stop schema 判断。
- stop schema guidance 只能存在于 system prompt 和 managed relay 的 fresh internal `reasoningStop` tool schema；不得存在于 CLI 命令、CLI stdout 或 provider-facing shell/tool history。
- missing/invalid schema 时，下一轮 provider user prompt 使用固定透明提示；`stopreason=2 + next_step` 时使用 `next_step` 原文。
- 自动 stopless CLI 的 call/result pair 必须在下一轮 provider projection 前物理移除，不得恢复成内部工具配对。
- 最新真实 user turn 是硬清零边界：如果真实 user 位于历史 stopless pair 之后，所有 inbound normalization、continuation-history collapse 和 provider codec 都必须保留该 user 原文，删除更早的 stopless pair，且不得重建透明续轮提示。
- `/v1/responses` bridge 使用 embedded `responsesContext.toolsNormalized` 时必须剥离旧的 `reasoningStop`、`reasoning_stop`、`stop_message_auto` 内部工具声明，同时保留 `exec_command` 等正常客户端工具；managed relay 的 fresh internal `reasoningStop` 只能由 ReqChatProcess 本轮重新注入 exactly once。

## 5. Stop Schema

模型尝试停止时必须在回复末尾提供 JSON：

```json
{
  "stopreason": 0,
  "simple_question": false,
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

- `simple_question=true`: 当前用户输入只是非常简单的问题时允许自然停止；此时不要求 `stopreason`、证据或下一步字段，停止信号直接发给客户端。
- `simple_question=false` 或缺省时，`stopreason` 是唯一无条件必填字段，`0=finished`、`1=blocked`、`2=continue_needed`。`0|1` 都是停止条件，`2` 是继续条件。
- `stopreason=0` 表示任务完成；必须 `has_evidence=1` 且 `evidence` 非空。证据内容只检查存在性，不判断真假。
- `stopreason=1` 表示阻塞/无法继续；必须 `reason` 非空，提供 reason 即可停止。
- `has_evidence=1` 时 `evidence` 必填；诊断字段按真实情况填写，不是全局必填。
- `stopreason=2` 必须填写 `next_step`；下一轮模型续跑文本必须只执行 `next_step` 的内容。
- `needs_user_input=true` 只用于缺少会影响目标、权限、实际成本或不可逆风险的用户专属决策；此时 `next_step` 必须直接写要问用户的问题，并允许以 `finish_reason=stop` 停止等待用户决策。“是否继续/要不要继续”不是有效用户决策。

## 6. 真源文件

- Rust orchestration owner: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`
- Rust persisted lookup / session scope owner: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- Stopless loop state owner: request-scoped MetadataCenter `runtime_control.stopless` plus current request tool output; goal state is removed.
- NAPI bridge: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- Host bridge call surface: owner-specific `src/modules/llmswitch/bridge/*-host.ts` shells; `src/modules/llmswitch/bridge/native-exports.ts` remains a private loader only and must not be used as the servertool semantic owner surface.
- Runtime side effects: Rust effect plans plus Host IO execution; old `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts` and `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts` are deleted and must not be restored.
- Focused tests: `tests/servertool/stopless-cli-continuation.spec.ts`

## 7. 验证

必跑 gates：

- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p servertool-core persisted_lookup --lib -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/execution-stage-shell.spec.ts --runInBand`
- `npm run verify:stopless-contract-blackbox`
- `npm run verify:stopless-invalid-schema-blackbox`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

Live probe 必须证明：

- 请求带稳定 `sessionId`。
- 客户端响应含 `exec_command(routecodex hook run reasoningStop ...)`，但命令参数/stdout 不含 provider-facing continuationPrompt/schemaGuidance/raw prompt text。
- dry-run 最终 `providerRequest.body` 含完整 system stop schema、普通 user prompt、以及 managed relay fresh internal `reasoningStop` tool exactly once；不含 stopless shell artifact、旧工具历史或控制 marker。
- 服务端日志不再出现 stopless `reenterPipeline`。
- 不同 `sessionId` 不共享 stopless state。
