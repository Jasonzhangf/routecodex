# Stopless 全链路审计（2026-06-15）

> 审计范围：当前 main 上 35 个脏文件 + 用户新增 5 个 untracked 文件（`stopless_prompt.rs`、
> `stopless-prompt.client-visible.spec.ts`、`stopless-vr-route-hint.spec.ts`、
> `stopless-client-invisible-route-plan.md`、`provider-error-chain-direct-relay-audit-2026-06-15.md` 等）。
> 本次只做只读审计，不修改任何代码。

## 1. 用户当前已经完成（untracked 但已落盘）

1. Rust 真源 `servertool-core/src/stopless_prompt.rs`（246 行，禁词表 19 个 token；三档 first/middle/final 模板；含 `assert_no_forbidden_token`）。
2. `servertool-core/src/lib.rs` 注册 `pub mod stopless_prompt;`。
3. `servertool-core/src/cli_contract.rs::build_stop_message_auto_run_output` 改走 `resolve_stopless_continuation_prompt`（行 5–6、184–192）。
4. `router-hotpath-napi/src/chat_servertool_orchestration.rs` 的 `run_stop_message_auto_handler_json` 改走 `resolve_stopless_continuation_prompt`（行 12–13、2182–2199），并强制 `assert_no_forbidden_token`。
5. 实现计划 `docs/goals/stopless-client-invisible-route-plan.md`（197 行 §1-§8，DoD 写明"客户端可见文案唯一真源"、"VR 走 thinking 不带 route_hint:tools"、"禁词表三层验证"）。
6. 单元测试 `tests/servertool/stopless-prompt.client-visible.spec.ts` 和 `tests/servertool/stopless-vr-route-hint.spec.ts`。

## 2. 用户那条现场输出暴露的根因（核心缺陷）

现场 3 个连续 chunk stdout 完全一致：
```
{"ok":true,"kind":"stop_message_auto","continuationPrompt":"继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。","repeatCount":1,"maxRepeats":3,...}
```

逐字段对照真源：

| 字段 | 实测 | 真源模板 | 命中 phase |
| --- | --- | --- | --- |
| `repeatCount` | 1 | 来自 `build_stop_message_auto_run_output(input.repeatCount)` | n/a |
| `maxRepeats` | 3 | 来自 `default_config.max_repeats` | n/a |
| `continuationPrompt` | "继续做下一步；…" | `Stop, first` 或 `NoSchema, first` 模板 | `used=0` |
| `input` | 只有 `flowId/repeatCount/maxRepeats` 3 个 key | `canonical_input` | OK |

→ **`used` 永远 = 0，三轮不变。** 真源模板 first/middle/final 选型逻辑是
`if used==0 {first} else if used==1 {middle} else {final}`，但调用方每轮都传 `repeatCount=1`，
CLI binary 内部算 `used = repeatCount - 1 = 0`，所以永远命中 first。

## 3. "used 不递增"的根因链路（按调用栈自上而下）

```
client 模型第 N 轮 stop
  → HubRespChatProcess03 触发 runStopMessageAutoHandlerWithNative
  → Rust run_stop_message_auto_handler_json:
      decision.used = persisted snapshot.used (假设=0)
      state_update.used = used + 1  (写回磁盘，OK)
      followup_text = resolve_stopless_continuation_prompt(used=0, ...)  // first 模板
  → TS shell 落地 persisted snapshot used=1 (OK)
  → VR 路由下一轮按 thinking
  → 模型再次 stop
  → runStopMessageAutoHandler 拿到 persisted snapshot.used = 1
  → 写 followup_text 时本应按 used=1 走 middle 模板
```

**关键缺失环节**：在用户的真实场景里，client 不是从普通 `submit_tool_outputs` 闭环
回来（也就是没走完 TS shell 的 `runStopMessageAutoHandler`），而是模型主动停止之后
`servertool_followup` 通道触发了 `routecodex-servertool run stop_message_auto` 客户端 CLI。
这条 CLI 入参没有 `sessionId` / `requestId`，所以 `build_stop_message_auto_run_output`
拿不到 session 持久化上下文，每次只能从命令参数 `repeatCount=1` 推断。

**两种可能根因**：
- **A. 真实链路是普通 chat / messages 入口**，不是 servertool followup 通道；
  那么"used 不递增"是因为 budget 写盘没生效（`applyStopMessageFinishReasonBudget` 未被调用，或 persist 失败被吞）。
- **B. 真实链路是 servertool followup 通道**，但 CLI binary 端没回写状态；
  Rust `run_stop_message_auto_handler_json::state_update` 是计划（plan），**真正落盘**由 TS shell 做。
  看一下 `stop-message-auto.ts` 第 530–566 行的 `runStopMessageAutoHandlerWithNative` 调用
  和后续 `planStopMessagePersistSnapshot` 链路，如果 `handlerResult.persistKeys` 为空或
  `lookup.stickyKey` 不是 `session:` 形式，state 就不会写回。

## 4. "对客户端无感"尚未完成的 3 个具体缺口

1. **`routecodex-servertool run stop_message_auto --input-json` 命令体仍然不含 `sessionId` / `requestId`**
   - 用户计划 §4.1 没把"CLI 入参必填 sessionId"列出来。
   - 物理结果：CLI binary 端无法回写 `used` 到正确 `session:<id>`。
2. **CLI binary 端 `recordStoplessContinuationStateSync` native binding 还没建**
   - 用户计划里只规划了"VR routeHint 处理 + prompt 真源"，**没规划 CLI binary 端的 persisted state 写回**。
3. **`is_persistent_sticky_key` 还包含 `tmux:` / `conversation:`**
   - `chat_servertool_orchestration.rs::is_persistent_sticky_key` 第 2109 行还接受 `tmux:` 与 `conversation:` 前缀。
   - 用户计划 §1.2 说"sessionId-only persisted lookup 不被破坏"，但没有强制收口到仅 `session:`。
   - 这意味着"完全相同"的两份 prompt 一份走 `tmux:foo`、一份走 `session:bar`，会跨键污染。

## 5. 用户计划文件 `stopless-client-invisible-route-plan.md` 自身的不一致

- §4.3 表里 `NoSchema used=0` 模板写的是"继续做下一步；拿不到证据就再试一次…"（plan 文），
  但实际 `stopless_prompt.rs:126` 写的是"继续做下一步；先把手头能确认的结果拿回来。"（代码），
  二者**不一致**。表里 `NoSchema used=1` / `used≥2` 的文案同样没在代码里。
- §4.3 表 `NoSchema used=0` 末尾还提到"想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。"，
  但实际 `stopless_prompt.rs` 没出现这句话。
- 也就是 plan 文本是"我想要的样子"，Rust 真源是"已经实现的样子"，两者没有对齐。

## 6. VR 路由的"stopless 本轮走 thinking" 已经隐式满足，但需要显式 force

- `virtual_router_engine/classifier.rs:127` `thinking_from_user = latest_message_from_user`
  且 `ROUTE_PRIORITY = [multimodal, web_search, thinking, coding, search, longcontext, tools, background, default]`。
  stopless followup 是 user text → `latest_message_from_user=true` → `thinking_from_user=true` →
  classifier 命中 `thinking:user-input`，自动在 `tools` 之前。
- 但用户日志 `reason=thinking:user-input|route_hint:tools` 里 `route_hint:tools` 来自 metadata
  携带的 `routeHint`，与 classifier 决策独立。`runStopMessageAutoHandler` 第 2235–2241 行
  已经有 `if routecodex_port_mode == "router" && route_hint.trim() != "tools" { insert routeHint }`，
  也就是 stopless 已经显式压住 `routeHint=tools`。**但**这条规则只在 `routecodexPortMode == "router"`
  生效；其他端口（gateway_priority_5555 之类）`routeHint=tools` 仍可能进入 VR。
- 用户计划 §4.4 要求"stopless followup + `routeHint=tools` → 强制 thinking + 清掉 routeHint"，
  应通过 `resolve_route_hint` 在 `serverToolFollowup=true` 时统一覆盖，而不是依赖 `routecodexPortMode`
  判断。

## 7. 风险与剩余缺口（按影响排序）

| 优先级 | 缺口 | 影响 | 修复点 |
| --- | --- | --- | --- |
| P0 | CLI 入参无 `sessionId` / `requestId` | 三轮 `used` 永远 0，话术永远 first | `build_stop_message_auto_run_output` 必填 sessionId；`servertool-cli` 增加 `--session-id` / `--request-id` |
| P0 | `recordStoplessContinuationStateSync` native binding 缺失 | CLI binary 端写不回 persisted state | 新增 `servertool_core_blocks::record_stopless_continuation_state_sync_json` |
| P0 | `is_persistent_sticky_key` 含 `tmux:` / `conversation:` | 跨键污染 stopless state | 收口到 `session:` 唯一（保留给非 stopless servertool 用的另立常量） |
| P1 | `stopless_prompt.rs` 与 plan §4.3 表文案不一致 | 文档 = 期望，代码 = 现状，二者二选一 | 修表或修代码，以代码为真源 |
| P1 | `runStopMessageAutoHandler` 仍构造 `append_user_text` injection | `requestIdSuffix=:stop_followup` 二次请求仍会进入服务日志 | 改 `flow = terminal_final` 或 `flow = cli_projection`，永不返回 followup |
| P1 | VR `resolve_route_hint` 未在 stopless 路径统一压 `routeHint=tools` | 非 router 端口仍可能 route_hint=tools | `route.rs::resolve_route_hint` 加 `serverToolFollowup=true` 分支 |
| P2 | `decide()` 的 `DEFAULT_EXECUTION_PROMPTS` 旧文案未删除 | `StopMessageDecision.followup_text` 仍可能带"用户目标" | 删除 `DEFAULT_EXECUTION_PROMPTS`，字段标 `#[serde(skip)]` |
| P2 | `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT = "继续执行"` 兜底分支仍存在 | `normalize_stop_message_followup_text` 命中"继续执行"时走老 prompt | 物理删除整个 legacy 分支 |
| P2 | `client_inject` 仍能进 client body | `requestIdSuffix=:stop_followup` 的 reenter 通道 | 阻断 `append_user_text` 输出 |

## 8. 用户最该做下一步（最少改动收口顺序）

1. **`is_persistent_sticky_key` 收口为 `session:` 唯一**（改 1 行 + 单元测试）。
2. **`build_stop_message_auto_run_output` 必填 `sessionId`**（改 Rust + 改 `servertool-cli` binary 的 clap + 改 TS shell 调用方传透）。
3. **新增 `recordStoplessContinuationStateSync` Rust 同步写盘函数**（新增 `persisted_lookup::record_stopless_continuation_state`，新增 `servertool_core_blocks::record_stopless_continuation_state_sync_json` napi binding，在 CLI binary 末尾调用）。
4. **`run_stop_message_auto_handler_json` 移除 `append_user_text` injection**，改返回 `flow = cli_projection` / `terminal_final`。
5. **`resolve_route_hint` 加 stopless 路径强制清 `routeHint=tools`**。
6. **删除 `DEFAULT_EXECUTION_PROMPTS` + `LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` 兜底**。
7. 跑 §4-§6 双向红测 + 5555 / 5520 live smoke。

## 9. 当前完成度评估

- Rust 真源层：90%（prompt 真源 + 禁词表已完成，CLI binary 端状态写回缺）。
- TS 薄壳层：70%（`runStopMessageAutoHandler` 走新真源已完成，`append_user_text` 抑制未完成）。
- VR 路由：80%（隐式满足 + 已知 plan 路径未实现）。
- 物理删除：30%（`LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT` / `DEFAULT_EXECUTION_PROMPTS` / `tmux:` 旧 sticky key 仍存在）。
- Live 验证：0%（`0.90.3071` 已 build 但没跑过 `repeatCount=1→2→3` 的端到端验证）。

## 10. 建议 /goal 优先级

按 P0 顺序：
1. CLI sessionId 收口 + native binding 写回（一次 commit）
2. `runStopMessageAutoHandler` 移除 `append_user_text`（一次 commit）
3. VR routeHint 收口（一次 commit）
4. 物理删除 legacy 兜底（一次 commit）
5. live smoke + 服务日志证据（独立 commit 或验证记录）
## 10a. 关键追加发现（2026-06-15 现场样本核对）

用户现场 3 个 chunk 的 `continuationPrompt` 字符串：
```
继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。
```

在当前源码 grep 结果：
- ❌ 不在 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_prompt.rs`（现有 first 模板是"继续做下一步；先把手头能确认的结果拿回来。"）
- ❌ 不在 `cli_contract.rs`
- ❌ 不在 `chat_servertool_orchestration.rs`
- ✅ **与 `docs/goals/stopless-client-invisible-route-plan.md` §4.3 表 `NoSchema used=0` 行描述一字不差**

**结论**：
1. live 二进制是**早于新 `stopless_prompt.rs` 落地** 的版本（plan 文档 §4.3 描述的是"过去/计划"那一份 prompt 真源，新 Rust 源码的 first 模板是"继续做下一步；先把手头能确认的结果拿回来。"，plan 文档与源码不一致）。
2. 即便补了 §8 的 P0 修复（CLI sessionId + recordStoplessContinuationStateSync），仍需要：
   - **build:min + 全局 reinstall + restart**，把新 `stopless_prompt.rs` 真正装到 live server；
   - **把 plan §4.3 文案与 `stopless_prompt.rs` 对齐**（推荐以代码为真源、修改 plan §4.3 表为代码实际字符串，避免继续误导后续维护者）。
3. 当前 live 没有反映 Rust 源码层的任何修改；本审计是基于源码 + plan 文档做的静态分析，**未对 live 0.90.3071 验证过新 prompt 真源是否生效**。

## 10. 建议 /goal 优先级
