# Stopless Stop Condition Verification Plan

## 1. Objective

把 stopless 的“停止设定”验证收敛为一套可执行、可上线验证、可直接驱动提交的测试设计，覆盖：

1. stopless 什么时候必须继续。
2. stopless 什么时候允许停止。
3. stopless 预算如何消耗、何时耗尽、何时重置。
4. `/v1/responses` 与 `/v1/responses/{id}/submit_tool_outputs` 是否遵循同一停止设定。
5. 用户可见输出是否始终保持透明，不泄漏 stop schema。

关联总交付文档：

- `docs/goals/stopless-full-delivery-plan.md`
- `docs/goals/stopless-complete-delivery-plan.md`

## 2. Acceptance

只有同时满足以下条件，才允许宣称“stopless 停止设定验证完成”：

1. 停止判定只存在唯一真源，不存在第二套 TS/handler/provider 级停止语义。
2. 所有关键停止条件都在测试矩阵中有覆盖。
3. 所有关键停止条件都至少有一条 5555 live 证据。
4. live 证据能证明 continue / allow-stop / budget-exhausted / reset 与预期一致。
5. 用户可见内容中不出现 stop schema JSON 和控制字段原文。
6. 结果能直接支撑一次完整 stopless 提交：review、commit、push。

## 3. Scope

### In Scope

1. `stop_message_auto` 停止设定。
2. Rust stop schema gate 的 continue / allow-stop / skip / budget-exhausted。
3. `submit_tool_outputs` 恢复轮次再次命中 stop 的处理。
4. stopless repeat budget 和 reset 规则。
5. 用户可见 markdown summary 投影。
6. stream=true 与 stream=false 的 stopless 行为一致性。

### Out Of Scope

1. cooldown、direct relay、5555 其他路由问题。
2. `vision_auto` / `web_search` 的独立 servertool 语义。
3. provider-specific 文案或 UI polish。

## 4. SSOT And Owner Mapping

### 4.1 Stop condition owner

- Rust 真源：
  - `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
- 负责：
  - schema 解析
  - continue / allow-stop / skip / budget-exhausted 判定
  - repeat budget / reset reason
  - resume eligibility

### 4.2 CLI projection owner

- TS 薄壳：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- 负责：
  - 调 Rust gate
  - 投影 `exec_command`
  - 维护 request-scoped persisted state
  - 用户可见 summary 壳层投影

### 4.3 Forbidden fixes

禁止以下修法：

1. 在 provider/runtime/outbound 再写一套 stop 规则。
2. 靠字符串正则删 schema JSON 冒充修复。
3. 在 `/submit_tool_outputs` 单独开旁路逻辑。
4. 通过 fallback 或 provider 特例掩盖 stop 条件错误。

## 5. Stop Condition Truth Table

### A. Skip

场景：

1. 非 stop 终止。
2. 当前请求不符合 stopless 入口条件。
3. 显式 goal active / plan mode。
4. direct path。

预期：

1. 不触发 stopless。
2. 不返回 `exec_command`。
3. 若之前有 repeat state，应按 Rust 规则 reset。

### B. Continue

场景：

1. `stopreason=2` 且仍需继续。
2. schema 缺失。
3. schema 无效。
4. `needs_user_input=false` 且未达到 allow-stop 条件。

预期：

1. 必须再次投影 `exec_command`。
2. `/submit_tool_outputs` 恢复轮次遇到同样条件时也必须再次 stopless。
3. 用户不可见最终总结正文。

### C. Allow stop

场景：

1. `stopreason=0` 且 `reason` 合法。
2. `stopreason=1` 且 `reason` 合法。
3. `needs_user_input=true` 且问题文本合法。
4. budget exhausted。

预期：

1. 返回最终用户可见 markdown summary。
2. 不能暴露 schema JSON。
3. repeat state 清理或重置到下一次新 stop 周期。

### D. Reset

触发：

1. 非 stop 正常响应。
2. 普通 tool 调用链路。
3. 已 allow-stop。
4. 当前 stop 周期结束。

预期：

1. 下一次 stop 的 `repeatCount` 从初始值重新开始。
2. 不允许历史 stop 状态污染新请求。

## 6. Test Matrix

### 6.1 Rust unit matrix

目标：验证唯一停止真源。

建议命令：

- `cargo test -p stop-message-core -- --nocapture`

必测 case：

1. `skip_non_stop_response`
2. `skip_goal_active`
3. `skip_plan_mode`
4. `continue_missing_schema`
5. `continue_invalid_stopreason_type`
6. `continue_reason_missing_for_stopreason_0`
7. `continue_reason_missing_for_stopreason_1`
8. `continue_stopreason_2_with_next_step`
9. `continue_stopreason_2_without_next_step`
10. `allow_stop_finished`
11. `allow_stop_blocked`
12. `allow_stop_needs_user_input`
13. `budget_exhausted_after_three_invalid_or_continue`
14. `budget_exhausted_after_ten_missing_schema`
15. `submit_tool_outputs_resume_is_still_eligible`
16. `reset_after_non_stop`
17. `reset_after_tool_response`
18. `reset_after_allow_stop`

关键断言：

1. action 精确等于 `skip` / `continue` / `allow_stop` / `budget_exhausted`。
2. repeat budget 增减与 reset reason 可断言。
3. resume 轮次不允许被无条件 skip。

### 6.2 TS/native focused matrix

目标：验证 stopless 薄壳没有二次语义偏移。

建议命令：

- `npm run jest:run -- --runTestsByPath tests/servertool/stop-message-native-decision.spec.ts tests/servertool/stop-message-auto.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts --runInBand --forceExit`

必测 case：

1. continue 时生成 `exec_command`。
2. CLI 命令固定为 `routecodex servertool run stop_message_auto --input-json ...`。
3. `continuationPrompt` 带完整核对字段。
4. 用户可见 `content` / `text` / `output_text` 不泄漏 schema。
5. 用户可见 `reasoning_text` / `reasoning_content` / `reasoning.summary[*].text` 不泄漏 schema。
6. allow-stop 时输出 markdown summary。
7. 没有内容字段时不显示空 section。
8. CLI result 恢复后不恢复内部 servertool identity。
9. 恢复轮次再次 continue 时 repeatCount 递增。

关键断言：

1. CLI input 和 visible summary 分离。
2. TS 只消费 Rust 判定，不重写第二套 stop 逻辑。

### 6.3 HTTP blackbox matrix

目标：验证 Responses 整链路契约。

建议命令：

- `npm run jest:run -- --runTestsByPath tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand --forceExit`

必测 case：

1. 首轮 `/v1/responses` continue -> `requires_action + exec_command`。
2. 首轮 `/v1/responses` allow-stop -> `completed + markdown summary`。
3. `/submit_tool_outputs` 恢复轮次再次 continue -> 再次 `requires_action`。
4. `/submit_tool_outputs` 恢复轮次 allow-stop -> `completed + cleaned summary`。
5. `/submit_tool_outputs` 历史已有 CLI result 但本轮仍应 stopless，禁止 passthrough 早退。
6. 非 stop 响应后再 stop，repeatCount reset。
7. stream=true 与 stream=false 输出契约一致。

关键断言：

1. 不因历史 CLI result 直接跳过 stopless。
2. 恢复轮次能再次命中 stopless。

### 6.4 5555 live matrix

目标：验证真实运行版本，而不是源码幻觉。

前置命令：

1. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
2. `cd sharedmodule/llmswitch-core && npm run build -- --pretty false`
3. 如需全局安装同步，先确认实际运行版本路径
4. `routecodex restart --port 5555`
5. `curl http://127.0.0.1:5555/health`

必跑 case：

1. 首轮 continue
   - `/v1/responses`
   - 预期：`requires_action`
   - 预期：tool name = `exec_command`
2. 恢复轮次再次 continue
   - 执行 CLI 后 `/v1/responses/{id}/submit_tool_outputs`
   - 预期：再次 `requires_action`
   - 预期：日志有新的 stopless stage
3. 恢复轮次 allow-stop
   - 预期：`completed`
   - 预期：最终内容为 markdown，不含 schema
4. invalid-schema budget exhausted
   - 连续制造 provided-schema invalid/continue
   - 预期：达到预算后 allow-stop
5. missing-schema budget exhausted
   - 连续制造 missing schema
   - 预期：前 9 次继续，第 10 次 allow-stop
6. reset case
   - stopless 一次 -> 非 stop 一次 -> 再 stop
   - 预期：repeatCount 重置
7. `needs_user_input=true`
   - 预期：只显示问题，不显示 schema
8. stream=true / stream=false 对照
   - 预期：两条路径 stop 判定一致

每个 live case 的必留证据：

1. request id
2. response id
3. route/provider
4. `client-request` sample
5. `provider-request` sample
6. `provider-response` sample
7. `client-response` sample
8. `~/.rcc/logs/server-5555.log` 对应时间段
9. 最终用户可见文本

## 7. Failure Classification

如果 live 失败，必须归类到以下之一：

1. Rust stop gate 判定错误。
2. TS shell 投影错误。
3. `/submit_tool_outputs` 恢复轮次被错误早退。
4. 用户可见 summary 清洗槽位不完整。
5. live 版本未吃到新构建。

要求：

1. 标出首个出错 request id。
2. 标出首个出错契约节点。
3. 禁止只写“没作用”或“线上没好”。

## 8. Delivery Gate

只有以下全部满足，才允许做 stopless 提交：

1. Rust + TS/native + blackbox 全绿。
2. 5555 live matrix 关键 case 全部有证据。
3. repeat budget / reset / allow-stop / continue 行为一致。
4. 用户可见输出无 schema 泄漏。
5. review 完成。
6. `note.md` 已补过程线索。
7. `MEMORY.md` 只追加已线上证实结论。
8. commit 完成并 push。

## 9. Recommended Execution Order

1. 先补或校正 Rust owner 测试。
2. 再补 TS/native focused tests。
3. 再补 HTTP blackbox。
4. rebuild + restart 5555。
5. 跑 live matrix。
6. 失败则回到唯一 owner 修复。
7. live 全绿后再 review / commit / push。
