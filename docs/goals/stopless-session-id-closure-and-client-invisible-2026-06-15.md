# Stopless 收口审计与实现：sessionId 收口 + 对客户端无感（2026-06-15）

> Status: 审计完成，待实施。文档路径 `docs/goals/stopless-session-id-closure-and-client-invisible-2026-06-15.md`。
> Owner 链：Rust `servertool-core` / `router-hotpath-napi` / `stop-message-core`（唯一真源）；TS 仅留 I/O 薄壳与 CLI bridge。
> 本文档遵循 `AGENTS.md` §24（正向 + 反向测试成对）、§17（Pipeline 唯一类型锁定）、§18（错误链唯一入口锁）。

## 1. 目标

1. **scope 收口**：stopless 持久化键从"过去的 `t_max_session_scope`/conversation/tmux/default fallback"全部收口到 `session:<sessionId>`，禁止任何 fallback。
2. **对客户端无感**：把 `routecodex-servertool run stop_message_auto` 的工具执行副作用从客户端可见路径抹掉。客户端只能看到一条 status-only 的 `exec_command`（`routecodex hook run stop_message_auto --input-json {"flowId","repeatCount","maxRepeats"}`），**所有 continuationPrompt / schemaGuidance / raw prompt text / raw schema 文本**都只能出现在 CLI stdout，**绝不能进入 client 可见响应 body 或对外的 prompt 注入**。
3. **话术升级**：stopless 默认三轮，前两轮保持中性自然人话，最后一轮必须激进引导模型去补证据或直接完成。三轮模板集中在 Rust `servertool-core::stopless_prompt` 唯一真源，并加 `STOPLESS_PROMPT_FORBIDDEN_TOKENS` 阻断 `schema/hook/stopless/servertool/stop_message_auto/第一轮/第二轮/第三轮/必须调用/已排除因素/排查顺序/用户目标` 等内部词。

## 2. 当前真源与已完成项

### 2.1 已收口（无需改代码）

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs::collect_stop_message_persisted_candidate_keys` 已只接受 `direct_record.sessionId` + `metadata.sessionId`，没有 `tmuxSessionId / conversationId / default` fallback。
- `STOP_MESSAGE_PERSISTED_LOOKUP_POLICY = "strict_session_only"`，`STOP_MESSAGE_FOLLOWUP_FLOW_ID = "stop_message_flow"`。
- `is_persistent_sticky_key` 在 `chat_servertool_orchestration.rs` 限制为 `tmux: | session: | conversation:`，但 stopless sticky key 现在唯一真源是 `session:`。
- 完全没有 `t_max_session_scope` / `max_session_scope` / `maxSessionScope` 关键字面量（grep 全仓 0 命中）。

### 2.2 对客户端无感已实现（无需改代码）

- `build_client_exec_cli_projection_output` 强制 `stop_message_auto` 的 input 只剩 `flowId / repeatCount / maxRepeats`，命令体不含 `continuationPrompt / schemaGuidance / raw prompt`。
- `validate_no_internal_carrier` 拒收 `metadata / metaCarrier / __rt / serverToolFollowup / providerInvoker / reenterPipeline / snapshot / debugCarrier / restoration handle / restoration store`。
- `continuation_prompt` 与 `schema_guidance` 仅出现在 CLI stdout（`ServertoolCliRunOutput.continuation_prompt`）和 `stopless_prompt::client_visible_text`，绝不进入 client body。

### 2.3 仍然存在的根因缺陷（**必须修复**）

- **根因 A：CLI stdout 里的 `used` 永远不会递增。**
  - 用户现场 3 个 chunk stdout 完全一致：`repeatCount=1, maxRepeats=3, continuationPrompt="继续做下一步…"`。
  - 路径：`runStopMessageAutoHandler` → `run_stop_message_auto_handler_json` → `state_update.used = used + 1` 是真写的，但**`build_stop_message_auto_run_output` 的入参 `repeatCount` 完全来自 CLI 调用方**，而 CLI bridge `buildClientExecCliProjectionOutputWithNative({ repeatCount: 0, maxRepeats: 0 })` 在 `cli-projection.ts::buildServertoolCliProjectionForToolCall` 第 36–37 行写死 0。
  - 但 `plan_client_exec_cli_projection_output` 走的是 `repeatCount = input.repeatCount ?? read_u32(payload, "repeatCount")`；当 input 是从 `servertool-cli` Rust binary 进程外的 stdin / RPC 调用时，**没有任何地方把 session 持久化的 `stopMessageUsed` 写进下一次 client CLI 的 input**，于是每轮都重新传 `repeatCount=1`（client 端行为）或 `repeatCount=0`（TS 端默认）。
  - 物理结果：`stopless_prompt.resolve_stopless_continuation_prompt(used=0, max=3, trigger=NoSchema)` 永远命中 `"继续做下一步；…"`（first 模板），三轮不变。
- **根因 B：CLI 命令体不携带会话身份。**
  - `routecodex hook run stop_message_auto --input-json {"flowId","repeatCount","maxRepeats"}` 没有任何 `sessionId` / `requestId` 字段，**CLI binary 拿不到会话身份**，所以它无法回查 persisted `stopMessageUsed`，只能依赖调用方传 `repeatCount` ——而调用方永远传 1。
- **根因 C：TS 默认 prompt 兜底还残留 legacy。**
  - `cli_contract.rs::build_stop_message_auto_run_output` 的 `continuation_prompt` 现在全部走 `resolve_stopless_continuation_prompt`，正确。
  - 但 `chat_servertool_orchestration.rs::normalize_stop_message_followup_text` 第 36–46 行在 `text == "继续执行"` 时降级走老 Rust prompt（`DEFAULT_EXECUTION_PROMPTS[used]`），含"用户目标 / 排查 / 缺字段"等内部措辞，与"自然人话"原则冲突。`runStopMessageAutoHandler` 的 `followup_text` 实际来源是 `resolve_stopless_continuation_prompt`，不会进 legacy 兜底；但 stop-message-core 的 `decide()` 自身在 `used < 3` 时仍可能输出 `DEFAULT_EXECUTION_PROMPTS[used]`（"继续当前用户目标…"），需在 `runStopMessageAutoHandler` 路径上**完全压制** `decision.followup_text`。
- **根因 D：VR 路由的"stopless 本轮走 thinking" 缺失。**
  - 用户明确要求"stopless 路由本轮走 thinking"——目前 `virtual_router_engine/classifier.rs::classify` 仅在 `latest_message_from_user && !reached_long_context` 时把 `thinking_from_user` 设为 true。stopless followup 是 `client_inject` 形式的 user text（"继续做下一步…"），`latest_message_from_user = true` 会命中 `thinking:user-input`——但**还需要保证 `tools:last-tool-other` 不在前一轮命中后还在这一轮命中**。当前 `tools_continuation` 判定为 `!latest_message_from_user && features.has_tool_call_responses`（classifier.rs:88-89），stopless followup 是 user text，所以 `tools_continuation = false`，优先级排序里 `thinking` 在 `tools` 之前（`ROUTE_PRIORITY[2]="thinking"`、`ROUTE_PRIORITY[6]="tools"`），**理论上已经自动走 thinking**。但用户在日志里看到 `reason=thinking:user-input|route_hint:tools`——`route_hint=tools` 是 metadata 携带的，不是 classifier 决策，所以逻辑没坏；不过**为减少歧义需要把 stopless 路径显式 force route=thinking，并在 metadata 里清掉 routeHint=tools**。
- **根因 E：`runStopMessageAutoHandler` 的 followup 仍然显式打 `append_user_text` 注入。**
  - `chat_servertool_orchestration.rs::run_stop_message_auto_handler_json` 第 2280–2293 行仍然构造 `"ops": [{"op": "append_user_text", "text": followup_text}, ...]` 的 injection；这是 servertool followup 通道，会让客户端日志里出现 `requestIdSuffix=:stop_followup` 的二次请求。**目标"对客户端无感"**要求彻底去掉这种 reenter 注入，统一走"client 看到 `exec_command` + 客户端执行 CLI + 走普通 `submit_tool_outputs`"链路。

## 3. 真源修复

### 3.1 Rust `servertool-core` （唯一 prompt 真源）

- `src/stopless_prompt.rs`：
  - 三个 phase 模板（first / middle / final），已经是"自然人话"，**但需要把"最后一次激进引导"做得更显性**：final 模板必须要求模型在本轮给出"文件路径 + 行号 / 日志片段 / 命令输出 / 测试结果"或显式 `做完了 / 卡住了`；middle 模板允许一句"你还有 N 步就停，可以现在就给我结论"；first 模板维持现状。
  - 加 `STOPLESS_PROMPT_FORBIDDEN_TOKENS` 已经在，必须保留。
  - `assert_no_forbidden_token` 已经在 `build_stop_message_auto_run_output` 调用，**必须**在 `run_stop_message_auto_handler_json` 的 followup_text 解析时也调用（修复根因 C）。
- `src/cli_contract.rs::build_stop_message_auto_run_output`：
  - 入参 `ServertoolCliRunInput` 必须新增必填字段 `session_id: String` 与 `request_id: String`；拒收缺失/空白。
  - `canonical_input` 增加 `sessionId` 与 `requestId`（不放入命令体字符串，仅作为输出字段，方便调试/审计；**不进 `--input-json`**）。
  - 通过 `session_id` 调 `persisted_lookup::resolve_runtime_stop_message_state_from_adapter_context` 或 `resolve_runtime_stop_message_state`，拿到真 `used`，再算 phase。
  - **状态写回**：CLI 二进制结束后必须把 `used + 1` 写回对应 `session:<sessionId>` 键的 `RoutingInstructionState`（新增 native binding `recordStoplessContinuationStateSync`，或在 CLI binary 内部用 `load/save RoutingInstructionState` 同步 I/O）。**Rust 端同步落盘，不依赖 TS shell**。
- `src/persisted_lookup.rs`：
  - 新增 `record_stopless_continuation_state(adapter_context, session_id, used, max_repeats, text) -> PersistAction` Rust 同步写盘函数。**这是唯一写盘 owner**。
  - 校验 `session_id` 严格匹配 `session:<id>` 模板，禁止任何 fallback。

### 3.2 Rust `router-hotpath-napi`

- `src/chat_servertool_orchestration.rs::run_stop_message_auto_handler_json`：
  - **移除** `decision.followup_text` 的旧 Rust 模板使用（用 `resolve_stopless_continuation_prompt` 覆盖，并通过 `assert_no_forbidden_token` 校验）。
  - **移除** `followup = append_user_text` 的 injection ops，改为 `flow = terminal_final`（如果是 schema pass）或 `flow = cli_projection`（其他情况），**不返回任何 followup**，让上层 `runFollowupMainline` 走 CLI projection 总线。
  - persist_keys / state_update 必须以 `session:<sessionId>` 为唯一真源（已经在做，但需要把 `is_persistent_sticky_key` 从 `tmux/session/conversation` 收口到 `session:` 唯一）。
- 新增 native binding `record_stopless_continuation_state_sync_json(input_json: String) -> String`，TS shell 用它在 stopless CLI 结束后回写状态。

### 3.3 Rust `stop-message-core`

- `src/lib.rs::decide`：
  - 移除 `DEFAULT_EXECUTION_PROMPTS` 旧 `继续当前用户目标…` 模板的 `followup_text` 字段（保留 `action = trigger` 判定）。`StopMessageDecision.followup_text` 字段标记为 `#[serde(skip)]` 或 `Option<String>` 默认 `None`。
  - 或更安全：保留字段但写 `None`，让 `run_stop_message_auto_handler_json` 强制覆盖。

### 3.4 TS 薄壳

- `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts::buildServertoolCliProjectionForToolCall` / `buildServertoolCliProjectionForAutoFlow`：
  - 调用 `buildClientExecCliProjectionOutputWithNative` 时**必须传** `sessionId` / `requestId`（从 `options` 透传）；如果上游未提供，必须报错（fail-fast），**禁止静默默认**。
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`：
  - 第 530 行 `runStopMessageAutoHandlerWithNative` 调用后，如果 `handlerResult.followup` 不为 null，**必须 fail-fast**（不再做 servertool followup 注入）。
  - 必须新增 `recordStoplessContinuationStateSyncWithNative` 调用，把 `decision.used + 1` 写回 `session:<sessionId>` 状态文件。CLI binary 端也写一份作为兜底（双写一致）。
- `sharedmodule/llmswitch-core/src/servertool/engine.ts::runServerSideToolEngine`：
  - 在 trigger stopless 时，**强制** `routeHint=thinking`（覆盖上一轮 `tools`），并把 `assignedModelId` 与 `target.modelId` 固定为 thinking-friendly 模型（如果用户当前在 tools 端口，需在 adapter_context 中提示 VR 切到 thinking route）。

### 3.5 VR classifier

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`：
  - `classify` 入口增加 `is_stopless_followup: bool` 信号（来自 `runtime.serverToolLoopState.flowId == "stop_message_flow"` 或 `clientInjectSource == "servertool.stop_message"`）。
  - 当 `is_stopless_followup = true`：
    - 强制 `route_name = "thinking"`；
    - `reasoning` 包含 `"stopless:force-thinking"`；
    - 不参与 `longcontext` / `tools` / `coding` / `web_search` 候选（即使命中也压住）。
  - 删除 `ROUTE_PRIORITY` 中 `tools` 对应的"上一轮 last-tool-other"逻辑在 stopless followup 的覆盖（已经在 `latest_message_from_user=true` 时 `tools_continuation=false`，无需改），仅在 stopless followup 显式短路。

## 4. 验收（按 AGENTS.md §24：正向 + 反向成对）

### 4.1 正向

- `cargo test -p servertool-core stopless_prompt --lib`：三轮模板都自然人话、无 forbidden token、final 包含具体证据引导语。
- `cargo test -p servertool-core cli_contract --lib`：CLI 输出不带 `continuationPrompt / schemaGuidance / raw prompt` 到 `input`，**`continuation_prompt` 在 stdout**；`sessionId` 出现在 `output.sessionId` 但**不在** `output.input`。
- `cargo test -p servertool-core persisted_lookup --lib`：`session:<id>` 唯一命中；缺 sessionId 报错。
- `cargo test -p router-hotpath-napi run_stop_message_auto_handler --lib`：`followup` 永远 `null`；`followup_text` 通过 `assert_no_forbidden_token`。
- `cargo test -p router-hotpath-napi stopless_force_thinking --lib`：stopless followup 强制 route=thinking。
- Jest `tests/servertool/stopless-cli-continuation.spec.ts`：CLI output 仅 status-only；`input` 字段只含 4 个 key。
- Jest `tests/servertool/stopless-prompt.client-visible.spec.ts`：新增三套反例覆盖 first/middle/final 模板。
- Jest `tests/servertool/stop-message-flow-followup-reentry.spec.ts`（反向）：**禁止** `runStopMessageAutoHandler` 再产生 `append_user_text` injection。

### 4.2 反向

- `tests/red-tests/stopless_no_reenter_injection.red.spec.ts`：连续 3 轮 stopless 触发后，**禁止**日志里出现 `requestIdSuffix=:stop_followup` 二次请求；禁止 `client_inject` 文本进入 client 响应。
- `tests/red-tests/stopless_cli_input_never_leaks_prompt.red.spec.ts`：CLI 输出的 `input` JSON 字符串**绝不能**包含 `continuationPrompt` / `schemaGuidance` / `第一轮` / `第二轮` / `必须调用` / `用户目标` / `排查` / `证据` 之一。
- `tests/red-tests/stopless_session_scope_strict.red.spec.ts`：
  - 两个不同 `sessionId` 共享同一 prompt 但 `used` 互不污染；
  - 缺 `sessionId` 必须 fail-fast，禁止退回 conversation/tmux/default。
- `tests/red-tests/stopless_force_thinking.red.spec.ts`：stopless followup 期间即便上一轮 `last_tool_category=other`，VR 也必须 route=thinking、reasoning 含 `stopless:force-thinking`。
- `tests/red-tests/stopless_three_round_escalation.red.spec.ts`：单 `sessionId` 连续三次 stopless，第三次必须命中 final 模板（含"文件 / 日志 / 命令 / 卡点"），前两次命中 first / middle。

## 5. Live 验证（不可少）

- `routecodex --version` + 健康检查三端口。
- 单 `sessionId` 连续 3 次触发 stopless：第一次 CLI stdout 含 `continuationPrompt` 是 first 模板，第二次 middle，第三次 final；服务端日志 `used=0/1/2` 自增；下一轮 VR 路由 `route_name=thinking, reasoning=stopless:force-thinking`。
- 不同 `sessionId` 互不污染 `used`。
- 服务端日志**不出现** `requestIdSuffix=:stop_followup` 的二次请求。
- 客户端响应**不出现** `continuationPrompt / schemaGuidance / schema / hook / stopless` 内部词。
- `routecodex servertool run stop_message_auto --input-json '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3,"sessionId":"<id>","requestId":"<id>"}'` 单独跑一次 stdout 含 `continuationPrompt` + `output.sessionId`，但 `output.input` 只有 4 个 key。

## 6. 禁止项（AGENTS.md §10 物理删除）

- 删除 `chat_servertool_orchestration.rs::normalize_stop_message_followup_text` 里的 `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` 兜底（保留行级常量，标记为 `#[allow(dead_code)]` 不合适，必须物理删除"老 default text 分支"——只保留 default `resolve_stopless_continuation_prompt` 单路径）。
- 删除 `stop-message-core::DEFAULT_EXECUTION_PROMPTS` 三个老 prompt 字符串（保留 `STOP_SCHEMA_JSON_EXAMPLE` 等 schema 解释）。
- 删除 `cli_contract.rs::validate_cli_run_input` 里 `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` 的字符串分支。
- 删除 `is_persistent_sticky_key` 中 `tmux:` / `conversation:` 分支（stopless 唯一 `session:`），但保留 `chat_servertool_orchestration.rs` 中 `tmux/conversation` 旧 persistent sticky key 给非 stopless servertool flow 使用。
