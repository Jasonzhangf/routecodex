# Stopless 客户端无感 + VR thinking 路由收口计划

## 1. 目标与验收标准

### 1.1 目标

收口两件事：

1. stopless 续轮对模型呈现为"普通用户在自然追问"，不再暴露内部流程词
   （schema / hook / stopless / servertool / 第一轮-第三轮 / 必须调用工具 等）。
2. stopless followup 本轮 VR 路由走 thinking，不再残留 `route_hint:tools`。

### 1.2 验收标准

- `routecodex hook run stop_message_auto` stdout 的 `continuationPrompt` 字段
  全部由新的 Rust 真源 `resolve_stopless_continuation_prompt` 生成。
- 客户端可见文案命中禁词表任一项即视为红测失败。
- `:stop_followup` request-side `append_user_text` 文本同样由该真源生成。
- stopless followup metadata 不再携带会强制 `route_hint:tools` 的 routeHint，
  且 VR log 中 stopless followup 本轮稳定走 thinking 路由。
- sessionId-only persisted lookup 不被破坏。
- 所有现有 stopless / CLI projection 红测保持绿或更新到新真源后保持绿。

## 2. 范围与边界

### 2.1 In Scope

- Rust 真源：
  - `servertool-core/src/cli_contract.rs::default_stop_message_cli_prompt`
  - `router-hotpath-napi/src/chat_servertool_orchestration.rs::default_stop_message_execution_prompt`
  - `router-hotpath-napi/src/chat_servertool_orchestration.rs::normalize_stop_message_followup_text`
  - 新增 `servertool-core/src/stopless_prompt.rs` 作为唯一真源
  - VR routeHint 处理：`virtual_router_engine/engine/route.rs::resolve_route_hint`
- Rust 单元测试：
  - `servertool-core/src/stopless_prompt.rs::tests`
  - `router-hotpath-napi/src/chat_servertool_orchestration.rs` 既有 stop_message_auto 测试
- TS 端不动业务逻辑；只更新断言使用新真源文本。

### 2.2 Out of Scope

- 通用 `resolve_servertool_state_key` 的多段 fallback 收口（独立目标）。
- 移除 `clientInjectText` 注入（`continue_execution` noop 路径，与 stopless 不同）。
- 任何 TS 端的 stopless 文案重写、routeHint 重写、routeDecision 重写。
- CLI projection shell、bridge、native wrapper 逻辑变更。

## 3. 设计原则

1. 客户端可见文本唯一真源 = `servertool-core::stopless_prompt::resolve_stopless_continuation_prompt`。
2. 输入 = `StoplessContinuationPromptInput { used: u32, trigger_reason: StoplessContinuationTriggerReason }`。
   `trigger_reason` = `Stop | NoSchema | InvalidSchema | NonTerminalSchema | SchemaPass`。
3. 输出 = `StoplessContinuationPrompt { client_visible_text: String, internal_hints: Option<...> }`。
   `client_visible_text` 禁止命中禁词表。
4. 客户端可见文案与 `schemaGuidance` 必须解耦：客户端只能看到 `client_visible_text`。
5. VR routeHint 在 stopless followup 中清空或覆盖为 `thinking`，
   由 `resolve_route_hint` 增加 `serverToolFollowup` 检查分支实现。

## 4. 技术方案

### 4.1 文件清单

#### Rust 真源

- 新增 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_prompt.rs`
- 修改 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- 修改 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
  删除 `default_stop_message_cli_prompt` 数组；改为调用 `stopless_prompt::resolve_stopless_continuation_prompt`。
- 修改 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  删除 `default_stop_message_execution_prompt` 与 `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` 升级路径；
  改为调用 `stopless_prompt::resolve_stopless_continuation_prompt`。
- 修改 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs::resolve_route_hint`
  增加 `serverToolFollowup == true` 时跳过非 thinking routeHint 的逻辑（仍允许 search/coding 显式保留，
  但 stopless followup 不应携带 `route_hint:tools`）。

#### 测试

- 新增 `tests/servertool/stopless-prompt.client-visible.spec.ts`
- 修改 `tests/servertool/stopless-cli-continuation.spec.ts`
- 修改 `tests/servertool/servertool-cli-result-restore.spec.ts`
- 修改 `tests/servertool/servertool-cli-native-bridge.spec.ts`
- 修改 `tests/cli/servertool-command.spec.ts`
- 修改 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- 新增 `tests/servertool/stopless-vr-route-hint.spec.ts`
- 新增 Rust 红测：
  - `servertool-core/src/stopless_prompt.rs::tests`
  - `router-hotpath-napi/src/chat_servertool_orchestration.rs` stop_message_auto 既有测试更新到新真源
  - `router-hotpath-napi/src/virtual_router_engine/engine/route.rs::tests` 增加 stopless followup routeHint 测试

#### 文档 / maps

- `docs/agent-routing/30-servertool-lifecycle-routing.md` "stopless 生命周期" 段增加
  客户端可见文案唯一真源条款。
- `docs/stop-message-auto.md` §1 + §4 增加"客户端可见文案"段落，引用新真源。
- `docs/architecture/function-map.yml`：
  - `hub.servertool_stopless_cli_continuation.notes` 增加禁词表与 Rust 真源引用
  - `hub.servertool_cli_projection.notes` 同步
- `docs/architecture/verification-map.yml`：对应 verification 增加新测试条目。

### 4.2 禁词表（Rust 常量）

`STOPLESS_PROMPT_FORBIDDEN_TOKENS` = `[ "schema", "hook", "stopless", "servertool", "stop_message_auto", "第一轮", "第二轮", "第三轮", "必须调用", "必须调用可用工具", "必须直接调用工具", "必须主动调用停止 hook", "stop schema", "stop reason", "证据不足", "用户目标", "已排除因素", "排查顺序" ]`。

> 精确匹配策略：trim 后按 `tokens.contains(...)` 子串判定，含空格分隔时不要求整词匹配；
> 命中即返回 `StoplessPromptError::ForbiddenToken` 并在测试中失败。

### 4.3 客户端可见文案策略

文案采用三档语气模板（Rust 中 `StoplessContinuationPrompt::render`），
按 `(trigger_reason, used)` 选择：

| trigger_reason | used | 模板 |
| --- | --- | --- |
| NoSchema | 0 | "继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。" |
| NoSchema | 1 | "还在等你推进；缺什么证据就再补一次；想停就告诉我'做完了'或'卡住了'。" |
| NoSchema | ≥2 | "再补最后一轮证据；如果可以收尾，就直接给一句'做完了'。" |
| InvalidSchema | 任意 | "刚才那一段没法读懂；按你看到的真实情况再说一遍就行，不用按格式。" |
| NonTerminalSchema | 任意 | "继续往下做；想停就告诉我'做完了'或'卡住了，需要你拍板'。" |
| SchemaPass | 任意 | ""（不再注入追加文本） |

> 模板由真源持有，TS 端禁止重写。
> `used >= max_repeats` 时统一降级为"再补最后一轮证据；如果可以收尾，就直接给一句'做完了'。"。

### 4.4 VR routeHint 处理

`resolve_route_hint(meta_route_03)` 在 `serverToolFollowup == true` 时：
- 若 `routeHint == "tools"`，忽略并返回 `None`。
- 若 `routeHint` 为其他非 thinking 路由且 stopless 当前轮的 classifier 命中 `thinking`，
  走 `thinking` 路由（routeHint 被覆盖为 None 即可，因为 classify 优先级本就 thinking > coding > tools）。
- 若 `routeHint` 为 `search` / `coding` / `web_search`，保持不变（用户显式意图优先）。

## 5. 风险与规避

- 风险 1：客户端 hook 已实现期望"必须主动调用停止 hook"。
  - 规避：把 hook 期望搬到 `internal_hints.require_stop_hook_call` 字段，
    由客户端 hook 在 shell 层使用，绝不进入 `client_visible_text`。
- 风险 2：客户端测试 `tests/cli/servertool-command.spec.ts` 还在断言
  `expect(String(payload.continuationPrompt ?? '')).toContain('必须主动调用停止 hook')`。
  - 规避：更新为断言 `continuationPrompt` 不含禁词，且 `payload.continuationPrompt` 非空。
- 风险 3：黑盒脚本 `scripts/tests/stopless-followup-blackbox.mjs` 还在断言旧关键字。
  - 规避：脚本里改为断言非禁词；执行前先 grep 整个仓的禁词暴露点。
- 风险 4：VR routeHint 改动可能影响普通 servertool followup（非 stopless）。
  - 规避：只在 `flowId == "stop_message_flow"` 或 `__rt.serverToolLoopState.flowId == "stop_message_flow"`
    才覆盖 routeHint；其他路径保持原行为。

## 6. 测试计划

### 6.1 Rust 单元

- `cargo test -p servertool-core stopless_prompt --lib`
  - 三档 trigger_reason × 多 used 组合
  - 禁词表子串匹配测试
  - `SchemaPass` 不再生成追加文本
  - `used >= max_repeats` 降级
- `cargo test -p router-hotpath-napi chat_servertool_orchestration --lib`
  - `plan_servertool_stop_message_followup` 使用新真源
  - 移除 `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` 升级路径
- `cargo test -p router-hotpath-napi virtual_router_engine --lib`
  - stopless followup + `routeHint=tools` → classifier 命中 thinking 且无 `route_hint:tools`
  - 普通 followup 保持原行为

### 6.2 Jest

- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/stopless-prompt.client-visible.spec.ts tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/cli/servertool-command.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand`

### 6.3 静态 + build

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run verify:function-map-compile-gate`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run verify:servertool-rust-only`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run build:min`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`

### 6.4 live

- 5555 / 5520 `/v1/responses` smoke：
  - 黑盒脚本 `scripts/tests/stopless-followup-blackbox.mjs` PASS
  - stdout `continuationPrompt` 不含禁词
  - server log 中 `[virtual-router-hit] ... reason=thinking:user-input` 不再出现 `route_hint:tools`

## 7. 实施步骤

1. 落实现文档（本文档）。
2. 新增 `servertool-core/src/stopless_prompt.rs` 与红测。
3. 修改 `cli_contract.rs` 与 `chat_servertool_orchestration.rs` 调用新真源。
4. 修改 `virtual_router_engine/engine/route.rs::resolve_route_hint`。
5. 更新 Jest 用例断言（业务断言从"必须包含关键字"改为"禁止包含禁词"）。
6. 跑 §6.1-6.3 验证全部 PASS。
7. live smoke + log 证据。

## 8. 完成定义（DoD）

- stopless 续轮客户端可见文案完全由 `resolve_stopless_continuation_prompt` 生成。
- 禁词表对所有 stopless 客户端可见文案生效（单元 + Jest + live 三层验证）。
- VR log 中 stopless followup 本轮 reason 为 `thinking:user-input` 且不再携带 `route_hint:tools`。
- 现有所有 stopless / CLI projection 红测保持绿。
- build:min + verify gates PASS。
- sessionId-only persisted scope 未被破坏。
