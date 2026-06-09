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
7. `/v1/responses/{id}/submit_tool_outputs` 恢复轮次不会丢失 `function_call_output` / tool output 历史，不会退化成“第一轮请求重放”。
8. 停止预算语义与 Rust 真源一致：provided schema 路径 3 次，missing schema 路径 3 次；旧的 missing-schema 10 次文档不得再作为测试依据。

## 3. Scope

### In Scope

1. `stop_message_auto` 停止设定。
2. Rust stop schema gate 的 continue / allow-stop / skip / budget-exhausted。
3. `submit_tool_outputs` 恢复轮次再次命中 stop 的处理。
4. stopless repeat budget 和 reset 规则。
5. 用户可见 markdown summary 投影。
6. stream=true 与 stream=false 的 stopless 行为一致性。
7. `submit_tool_outputs` 恢复链上下文完整性，特别是多轮 stopless 后仍能保留 prior `function_call_output` 历史。

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
  - provided-schema / missing-schema budget 阈值真源

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

### 4.4 Current live blocker to lock in tests

截至 2026-06-09，5555 live 已证明首轮 stopless 可触发、恢复轮次也可再次 `requires_action`；当前新 blocker 是更后续的 `/submit_tool_outputs` 恢复链上下文丢失：

1. 第三轮恢复请求的 `provider-request.json` 只剩首轮 user message。
2. prior `function_call_output` / tool output 历史未被带回 provider request。
3. 上游因此再次返回首轮 stop schema，最终可退化为 `EMPTY_ASSISTANT_RESPONSE`。

因此，停止设定测试不能只看“有没有再次 stopless”，还必须验证恢复链每一轮都保留完整上下文。

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

### E. Budget truth

当前测试设计必须锁定以下真相：

1. provided schema 路径与 missing schema 路径都按连续 3 次收敛。
2. missing schema 不是“无限继续”，也不是“10 次后再停”。
3. reason_code 必须能区分 `stop_schema_missing`、`stop_schema_invalid`、`stop_schema_budget_exhausted`，但预算上限已经统一为 3。
4. 非 stop 响应、真实工具调用、allow-stop 完成本轮后必须 reset。
5. 为避免“第 3 次还是第 4 次 exhausted”的自然语言歧义，所有测试与 live 断言必须统一使用 `used` / `maxRepeats` / `left` / `action` 作为真相，不允许只写“第几轮”。

### F. Assertion contract

所有层级测试统一按以下 contract 断言，不按口语轮次断言：

1. `action`
   - `skip`
   - `continue`
   - `allow_stop`
   - `budget_exhausted`
2. `reason_code`
   - `stop_schema_missing`
   - `stop_schema_invalid`
   - `stop_schema_budget_exhausted`
   - allow-stop 对应 summary/needs-user-input reason
3. `used`
   - 当前 stop 周期已消耗次数
4. `maxRepeats`
   - 当前 stop 周期预算上限
5. `left`
   - 剩余预算
6. `reset reason`
   - 非 stop
   - tool call
   - allow-stop
   - new request scope

如果单测、日志、live 样本三者对 `used/max/action` 的解释不一致，视为设计未闭环，不能进入 commit。

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
14. `budget_exhausted_after_three_missing_schema`
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
8. 连续多轮 `/submit_tool_outputs` 后，provider 入站语义仍包含前序 `function_call_output` 历史，而不是退化成首轮 user-only payload。
9. 第三轮及以后恢复若继续 stopless，不能因为历史丢失而回到“第一轮 stop schema”。

关键断言：

1. 不因历史 CLI result 直接跳过 stopless。
2. 恢复轮次能再次命中 stopless。
3. 恢复轮次每一轮都能从 conversation store 恢复完整历史。
4. 黑盒断言必须直接检查恢复后的 provider 请求语义或等价 canonical history，而不只检查最终 status。

### 6.4 5555 live matrix

目标：验证真实运行版本，而不是源码幻觉。

前置命令：

1. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
2. `cd sharedmodule/llmswitch-core && npm run build -- --pretty false`
3. 如需全局安装同步，先确认实际运行版本路径
4. `routecodex restart --port 5555`
5. `curl http://127.0.0.1:5555/health`

必跑 live case：

1. `continue` 首轮命中
   - 断言 `status=requires_action`
   - 断言 tool=`exec_command`
   - 保存 request id / response id / provider sample
2. `continue` 恢复轮次再次命中
   - 断言第二次 `/submit_tool_outputs` 仍是 `requires_action`
   - 断言 `used/max/action` 与日志一致
3. `allow_stop finished`
   - 断言 `completed`
   - 断言用户可见区是 markdown
   - 断言不含 `stopreason` / `has_evidence`
4. `allow_stop blocked`
   - 断言 `completed`
   - 断言标题/正文是阻塞说明，不含 schema
5. `needs_user_input=true`
   - 断言只显示问题文本
   - 无空 section，无 schema 原文
6. `budget exhausted`
   - 连续打到统一预算上限
   - 断言最终 `completed`
   - 断言不再生成新的 `exec_command`
7. `reset`
   - stopless 继续一次后插入一次非 stop 或真实工具调用
   - 再次命中 stop 时断言 `used` 回到初始态
8. `stream=true`
   - 断言终态与非流式一致
   - 保存 SSE terminal event
9. `third-round history preservation`
   - 连续多轮 `/submit_tool_outputs`
   - 直接检查 `~/.rcc/codex-samples/**/provider-request.json`
   - 断言仍包含 prior `function_call_output` / tool output 历史
   - 这是当前 blocker 的唯一 live 验收点，缺失即失败

live 证据包要求：

1. `requestId`
2. `responseId`
3. `tool_call_id` / `call_id`
4. 对应时间段 `~/.rcc/logs/server-5555.log` 或当前真实日志文件
5. `client-request.json`
6. `provider-request.json`
7. `provider-response.json`
8. `client-response.json` 或 SSE 抓包

### 6.5 Closeout gates

要进入最终 stopless 提交，除上面测试外还必须完成：

1. 代码 review，明确唯一 owner、删掉错误早退和重复判定。
2. `git diff --check`
3. 本次 stopless 文档与 `note.md` 已更新。
4. commit message 明确 stopless stop-condition / resume-history / user-visible summary 交付范围。
5. push 成功后，回报中必须附：
   - 改了什么
   - 哪些测试通过
   - 哪些 5555 live case 通过
   - 若仍有缺口，缺口在哪里，不能含糊写“基本没问题”

前置判定：

1. 先确认本次请求不是 `direct/direct`。
2. 显式 `provider.model` 目标（如 `mini27.MiniMax-M2.7`）若命中 `direct/direct`，该样本只可用于 direct path 证明，不能计入 stopless live 验证。
3. 若目标 provider 是 Codex 型/带 harness tools 的 managed target，则该样本可用于验证 `skip_goal_active` / `skip_plan_mode` / `no required_action`，但不适合用来验证“模型只输出 stop schema”的 allow-stop/continue-needed 渲染契约。
4. allow-stop / continue-needed / budget exhausted 必须优先选择非 Codex 型 managed provider；若 5555 当前只有 Codex 型 managed target 可达，必须明确记录这一环境边界，并补充可用端口/可用 managed target 的 live 证据。

必跑 case：

1. 首轮 continue
   - `/v1/responses`
   - 预期：`requires_action`
   - 预期：tool name = `exec_command`
2. 恢复轮次再次 continue
   - 执行 CLI 后 `/v1/responses/{id}/submit_tool_outputs`
   - 预期：再次 `requires_action`
   - 预期：日志有新的 stopless stage
   - 预期：对应 `provider-request.json` 含 prior `function_call_output` / tool outputs 历史
3. 恢复轮次 allow-stop
   - 预期：`completed`
   - 预期：最终内容为 markdown，不含 schema
4. invalid-schema budget exhausted
   - 连续制造 provided-schema invalid/continue
   - 预期：达到预算后 allow-stop
5. missing-schema budget exhausted
   - 连续制造 missing schema
   - 预期：前 2 次继续，第 3 次 budget exhausted 并返回最终用户可见 summary
6. reset case
   - stopless 一次 -> 非 stop 一次 -> 再 stop
   - 预期：repeatCount 重置
7. `needs_user_input=true`
   - 预期：只显示问题，不显示 schema
8. stream=true / stream=false 对照
   - 预期：停止判定与非流式一致；仅输出形态不同
9. 多轮恢复上下文完整性
   - 至少完成首轮 `/v1/responses` + 两轮 `submit_tool_outputs`
   - 预期：第 2、3 轮 provider request 都包含历史 tool output
   - 预期：不能出现“第三轮又像第一轮”的 provider response

证据要求：

1. 每个 case 都记录 `request_id`、`response_id`、`tool_call_id`。
2. 保存对应 `~/.rcc/codex-samples/**/client-request.json`、`provider-request.json`、`provider-response.json`、`client-response.json`。
3. 保存 `~/.rcc/logs/server-5555.log` 同时间窗日志。
4. 每个失败 case 都要标注首个出错契约节点：`RespInbound` / `RespChatProcess` / `RespOutbound` / `servertool adapter context` / `client projection`。
5. 多轮恢复 case 必须额外保留每轮 `provider-request.json`，逐轮比对 history 是否递增而不是归零。

## 7. Detailed Scenario Set

### 7.1 Gate skip scenarios

1. `goal active + finish_reason=stop`
   - 输入：RCC goal 指令已激活，当前轮正常 stop。
   - 预期：`skip`
   - 不变量：不能注入 `exec_command`，不能增加 repeat budget。
2. `plan mode + finish_reason=stop`
   - 输入：plan mode 指令。
   - 预期：`skip`
   - 不变量：响应直接 completed；stopless 不介入。
3. `direct path`
   - 输入：same-protocol direct / provider-direct。
   - 预期：`skip`
   - 不变量：direct 不改道 relay，不触发 stopless。
4. `finish_reason!=stop`
   - 输入：`tool_calls` / `length` / 普通 completed。
   - 预期：`skip_and_reset`
   - 不变量：历史 stop 状态清零。

### 7.2 Continue scenarios

1. `stopreason=2 + next_step 非空`
   - 预期：`continue`
   - 输出：`requires_action + exec_command`
2. `stopreason=2 + next_step 为空`
   - 预期：`continue`
   - 输出：要求继续目标或补完整 schema
3. 缺 schema
   - 预期：`continue_missing_schema`
   - 输出：再次 stopless，不回用户可见最终总结
4. `stopreason` 非数字 / 越界
   - 预期：`continue_invalid_schema`
   - 输出：再次 stopless，并计 provided-schema invalid budget
5. `stopreason=0|1` 但 `reason` 为空
   - 预期：`continue_invalid_schema`
   - 输出：禁止 allow-stop

### 7.3 Allow-stop scenarios

1. `stopreason=0 + reason 非空`
   - 预期：`allow_stop`
   - 输出：`completed + markdown`
2. `stopreason=1 + reason 非空`
   - 预期：`allow_stop`
   - 输出：`completed + markdown`
3. `needs_user_input=true`
   - 预期：`allow_stop`
   - 输出：仅显示用户需要回答的问题；不显示 schema
4. `budget_exhausted`
   - 预期：`allow_stop_by_budget`
   - 输出：停止继续投影，返回用户可读 markdown

### 7.4 Reset scenarios

1. continue 后接一轮普通 tool call
   - 预期：repeatCount reset
2. continue 后接一轮非 stop completed
   - 预期：repeatCount reset
3. allow-stop 完成本轮
   - 预期：persisted stop 状态释放
4. 新 request / 新 session
   - 预期：不继承旧 stop 状态

### 7.5 Resume-context-integrity scenarios

1. 第一轮 `requires_action`
   - 预期：conversation store 记录首轮 response 与 tool call
2. 第一次 `submit_tool_outputs` 后再次 `requires_action`
   - 预期：恢复 payload 含首轮 `function_call_output`
3. 第二次 `submit_tool_outputs` 后再次 `requires_action`
   - 预期：恢复 payload 同时包含前两轮 tool output 历史
4. 第三轮及以后 allow-stop / continue
   - 预期：provider request 仍基于累积历史，不退化为原始首轮 user-only payload
5. 若历史缺失
   - 判定：这不是 provider 随机性，而是 `responses conversation resume` 唯一 owner 缺陷，必须阻断交付

## 8. Test Execution Order

为了避免“单测绿但 live 不成立”，执行顺序固定如下：

1. 先补或确认 Rust owner 测试。
2. 再跑 TS/native focused 测试，证明薄壳未偏移。
3. 再跑 HTTP blackbox，证明整条 Responses 契约成立。
4. 重新 build native / build llmswitch-core / restart 5555。
5. 最后跑 5555 live matrix。
6. 对多轮恢复 case，必须额外核对每轮 sample 的 `provider-request.json` 历史递增性。

禁止倒序：

1. 禁止只做 live 试错而没有最小回归测试锁边界。
2. 禁止只跑单测就宣称 stopless 完整交付。
3. 禁止只记录成功响应，不保留 request/response/sample/log 证据。

## 9. Live Evidence Template

每个 5555 case 必须至少记录以下字段：

1. case 名称
2. endpoint
3. stream 开关
4. model / route
5. request_id
6. response_id
7. tool_call_id
8. 预期 action
9. 实际 action
10. client 可见内容摘要
11. sample 路径
12. 日志时间窗
13. 结论：PASS / FAIL
14. 若 FAIL，首个失真节点

建议产物位置：

- `/tmp/stopless_<case>_probe_result.json`

## 10. Delivery Gate For Final Commit

要达到“可以 review / commit / push”的 stopless 完整提交，必须同时满足：

1. `docs/goals/stopless-full-delivery-plan.md` 中的总交付项闭环。
2. 本文档第 6 节矩阵全部有对应测试或 live case。
3. 下面这些 live 条件全部在 5555 有成功证据：
   - 首轮 continue
   - submit_tool_outputs 恢复轮次再次 continue
   - allow-stop finished
   - allow-stop blocked 或 needs_user_input
   - invalid-schema budget exhausted
   - missing-schema budget exhausted
   - reset after non-stop/tool call
   - stream=true 对照
4. 用户可见响应中不出现：
   - `stopreason`
   - `has_evidence`
   - `needs_user_input`
   - 原始 schema JSON
   - `schemaGuidance`
5. review 结论不能存在 P0/P1 stopless 回归项。

## 11. Definition Of Done

只有同时满足以下条件，才允许产出最终 stopless 提交：

1. 唯一 owner 收敛完成。
2. 定向测试通过。
3. 5555 live 验证通过。
4. 文档、note、必要 memory 已更新。
5. commit 只包含 stopless 完整交付所需改动。

## 12. Required Verification Command Stack

最终交付前，验证命令栈至少包括：

1. Rust owner
   - `cargo test -p stop-message-core -- --nocapture`
2. TS/native focused
   - `npm run jest:run -- --runTestsByPath tests/servertool/stop-message-native-decision.spec.ts tests/servertool/stop-message-auto.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts --runInBand --forceExit`
3. HTTP blackbox
   - `npm run jest:run -- --runTestsByPath tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand --forceExit`
4. Build + runtime sync
   - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
   - `cd sharedmodule/llmswitch-core && npm run build -- --pretty false`
5. 5555 live
   - `routecodex restart --port 5555`
   - `curl -sS http://127.0.0.1:5555/health`
   - stopless live probe commands for continue / allow-stop / budget / reset / stream / resume-history matrix
6. Closeout
   - `git diff --check`
   - review diff + stage only stopless-related files + commit + push

禁止把其中任一层省略后宣称“完整 stopless 已交付”。

## 13. Final Submission Evidence Pack

最终回报必须一并给出：

1. 变更文件清单
2. 唯一 owner 与被删除的错误路径
3. 每条验证命令及 PASS 结果
4. 每个 5555 live case 的 request id / response id / sample 路径 / 日志时间窗
5. review 结论
6. commit hash
7. push 成功证据
