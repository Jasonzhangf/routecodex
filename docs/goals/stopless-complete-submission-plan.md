# Stopless Complete Submission Plan

## 1. Goal

交付一次可 review、可 commit、可 push、并且以 live/runtime 证据闭环的 stopless 完整功能提交，覆盖：

1. 停止判定正确。
2. stop schema 对用户透明，不直出 JSON/schema 控制字段。
3. `/v1/responses` 与 `/v1/responses/{id}/submit_tool_outputs` 多轮 stopless 行为一致。
4. 停止预算、reset、allow-stop、continue、needs_user_input、budget exhausted 都有本地测试与 5555 在线证据。

## 2. Acceptance

只有同时满足以下条件，才允许宣称“stopless 完整交付可提交”：

1. 停止设定只有唯一真源：
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
   - TS shell: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
2. 用户可见输出不出现 `stopreason`、`has_evidence`、`needs_user_input`、`schemaGuidance`、原始 stop schema JSON。
3. 非 allow-stop 条件下，不能一轮 stop 就结束，必须继续 stopless。
4. `needs_user_input=true` 时，只显示问题 markdown；无内容字段不显示空 section。
5. provided-schema 与 missing-schema 预算都按 Rust 真源 `3/3` 收敛，不允许旧的 `10` 轮口径回流。
6. `/submit_tool_outputs` 多轮恢复不丢累计历史，不退化成首轮 user-only payload。
7. 至少一条 5555 live 路径证明：
   - continue
   - resumed continue
   - allow-stop markdown
   - needs_user_input markdown
   - stream=true
8. 若 budget exhausted 当前受上游 provider 不稳定阻断，也必须给出明确 live 失败归因与首个失败契约节点，不能把 provider 可用性问题冒充 stopless 完成。
9. 最终交付包含：代码、测试、live 证据、`note.md`、必要的 `MEMORY.md`、review、commit、push。

## 3. Scope

### In Scope

1. stopless 停止判定与预算语义。
2. stopless CLI projection 与用户可见 summary。
3. `/v1/responses` 首轮 stopless。
4. `/v1/responses/{id}/submit_tool_outputs` 恢复轮次 stopless。
5. stream / non-stream 一致性。
6. 5555 live probe、日志、样本闭环。

### Out Of Scope

1. cooldown。
2. 非 stopless 的 direct/relay 架构问题，除非它直接阻断 stopless live 入口。
3. `vision_auto` / `web_search` 独立 servertool 语义。
4. UI polish 与 provider-specific 文案修补。

## 4. SSOT And Owner

### 4.1 Stop condition owner

- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`

负责：

1. stop schema 解析。
2. `skip` / `continue` / `allow_stop` / `budget_exhausted` 判定。
3. `used` / `left` / `maxRepeats` / reset reason。
4. `/submit_tool_outputs` 恢复轮次是否继续 eligible。

### 4.2 Projection shell owner

- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`

负责：

1. 调 Rust native gate。
2. 投影 `exec_command` CLI。
3. 组装用户可见 markdown summary。
4. 管理 request/session scoped stopless persisted state。

### 4.3 Resume chain owner

- Rust owners:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

负责：

1. `submit_tool_outputs` 恢复轮次累计历史。
2. 本轮 `exec_command` 和 tool output 保留。
3. 不退化成“第一轮重放”。
4. 禁止恢复已删除的 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts` TS owner。

### 4.4 Forbidden fixes

禁止：

1. 在 provider/runtime/direct/outbound 再写一套 stop 判定。
2. 用正则/字符串删除 schema JSON 冒充修复。
3. 为 `/submit_tool_outputs` 单独开旁路 stopless 逻辑。
4. 用 fallback/sanitizer/provider 特例掩盖 stopless 错误。

## 5. Stop Condition Truth Table

所有测试和 live 断言统一使用以下 contract，不使用口语“第几轮”：

1. `action`
   - `skip`
   - `continue`
   - `allow_stop`
   - `budget_exhausted`
2. `reason_code`
   - `stop_schema_missing`
   - `stop_schema_invalid`
   - `stop_schema_budget_exhausted`
   - `stop_schema_needs_user_input`
   - allow-stop 对应 summary reason
3. `used`
4. `left`
5. `maxRepeats`
6. `reset_reason`

### A. Skip

场景：

1. `finish_reason != stop`
2. `/goal active`
3. plan mode
4. direct path
5. 当前请求不符合 stopless 入口

预期：

1. 不返回 `exec_command`
2. 不改用户可见正文
3. 若本 stop 周期结束，按 Rust 真源 reset

### B. Continue

场景：

1. `stopreason=2`
2. schema 缺失
3. schema 非法
4. `needs_user_input=false` 且不满足 allow-stop

预期：

1. 返回 `requires_action + exec_command`
2. `/submit_tool_outputs` 恢复后再次 stop 时仍继续 eligible
3. 不向用户展示最终 stop summary

### C. Allow Stop

场景：

1. `stopreason=0` 且 `reason` 合法
2. `stopreason=1` 且 `reason` 合法
3. `needs_user_input=true` 且问题文本合法
4. budget exhausted

预期：

1. 返回 `completed`
2. 用户看到 markdown summary
3. 不泄漏 schema JSON
4. 本 stop 周期状态清理/reset

### D. Reset

触发：

1. 非 stop 正常响应
2. 真实工具调用
3. allow-stop
4. 新 stop 周期开始

预期：

1. 下一次 stop 从 `used=0` 开始
2. 历史 stop 状态不污染新请求

### E. Budget

锁定真相：

1. provided-schema 预算 = 3
2. missing-schema 预算 = 3
3. 非 stop / 工具调用 / allow-stop 后必须 reset
4. 所有断言都以 `used/left/maxRepeats/action` 为准，不用自然语言轮次替代

## 6. User-Visible Contract

### 6.1 allow-stop / blocked

必须输出 markdown summary，字段映射如下：

1. `reason`：必显
2. `evidence`：有值才显示
3. `issue_cause`：有值才显示
4. `excluded_factors`：有值才显示
5. `diagnostic_order`：有值才显示
6. `done_steps`：有值才显示
7. `next_step`：有值才显示
8. `learned`：有值才显示

禁止：

1. 空 section
2. 内部控制字段原文
3. schema JSON 原文

### 6.2 needs_user_input

必须只显示问题 markdown，例如：

```md
## 需要确认
请确认：...
```

禁止：

1. 拼回原 schema JSON
2. 拼回无关 stop summary 尾巴
3. 空 section

### 6.3 continue

必须返回 `exec_command`，不能直接 completed。

## 7. Test Matrix

### 7.1 Rust unit matrix

目标：锁唯一停止真源。

命令：

```bash
cargo test -p stop-message-core -- --nocapture
```

必测：

1. `skip_non_stop_response`
2. `skip_goal_active`
3. `skip_plan_mode`
4. `continue_missing_schema`
5. `continue_invalid_stopreason_type`
6. `continue_reason_missing_for_finished_or_blocked`
7. `continue_stopreason_2_with_next_step`
8. `allow_stop_finished`
9. `allow_stop_blocked`
10. `allow_stop_needs_user_input`
11. `budget_exhausted_after_three_invalid_or_continue`
12. `budget_exhausted_after_three_missing_schema`
13. `submit_tool_outputs_resume_is_still_eligible`
14. `reset_after_non_stop`
15. `reset_after_tool_response`
16. `reset_after_allow_stop`

断言：

1. `action`
2. `reason_code`
3. `used`
4. `left`
5. `maxRepeats`
6. `reset_reason`

### 7.2 TS/native focused matrix

目标：锁 TS shell 没有长出第二套语义。

命令：

```bash
npm run jest:run -- --runTestsByPath \
  tests/servertool/stop-message-native-decision.spec.ts \
  tests/servertool/stop-message-auto.spec.ts \
  tests/servertool/servertool-cli-projection.spec.ts \
  tests/servertool/servertool-cli-result-restore.spec.ts \
  --runInBand --forceExit
```

必测：

1. continue 生成 `exec_command`
2. CLI 命令固定为 `routecodex servertool run stop_message_auto --input-json ...`
3. `continuationPrompt` 带完整核对字段
4. visible summary 不泄漏 schema
5. `needs_user_input` 只显示问题 markdown
6. 无内容字段不显示空 section
7. allow-stop 输出 markdown summary
8. CLI result 恢复后不恢复内部 servertool identity
9. 恢复轮次 repeatCount 递增且不丢累计历史

### 7.3 HTTP blackbox matrix

目标：锁 Responses 整链 stopless 契约。

命令：

```bash
npm run jest:run -- --runTestsByPath \
  tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts \
  tests/sharedmodule/responses-continuation-store.spec.ts \
  --runInBand --forceExit
```

必测：

1. 首轮 `/v1/responses` continue
2. 第一轮 submit 后再次 continue
3. allow-stop completed + markdown
4. `needs_user_input` completed + only question markdown
5. third submit 历史不塌成首轮 user-only
6. budget exhausted 不无限继续
7. reset 后新 stop 周期重新计数

### 7.4 5555 live matrix

这是完成标准，不可用单测替代。

前置：

```bash
node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs
cd sharedmodule/llmswitch-core && npm run build -- --pretty false
ROUTECODEX_INSTALL_INPLACE_BUILD=1 npm run install:global
routecodex restart --port 5555
curl http://127.0.0.1:5555/health
```

固定规则：

1. 只使用 managed/relay 路径做 stopless 验证。
2. explicit `provider.model` 命中 direct 的样本不计入 stopless 验收。
3. 每个 case 必须保留 `request_id`、`response.id`、`tool_call_id`、sample 路径、日志时间段。

必跑 live case：

1. 首轮 continue
2. 第一轮 submit 后再次 continue
3. allow-stop markdown
4. `needs_user_input=true`
5. `stream=true`
6. reset 语义
7. budget exhausted
8. missing-schema budget exhausted

当前已知 live baseline（2026-06-09）：

1. 5555 上已有证据证明：
   - 首轮 continue
   - resumed continue
   - allow-stop markdown
   - `needs_user_input`
   - `stream=true`
2. 当前仍需补强：
   - 同一路径稳定 budget exhausted 成功闭环
   - provider 波动时的首个失败契约节点归因

## 8. Online Verification Evidence Pack

每个 live case 都要落证据包：

1. request body
2. response body / SSE terminal event
3. `~/.rcc/codex-samples/**/client-request*`
4. `~/.rcc/codex-samples/**/provider-request*`
5. `~/.rcc/codex-samples/**/provider-response*`
6. `~/.rcc/codex-samples/**/client-response*`
7. `~/.rcc/logs/server-5555.log` 对应日志窗口
8. 若失败，标明首个失败契约节点：
   - `req_inbound`
   - `req_chatprocess`
   - `virtual_router`
   - `req_outbound`
   - `provider_runtime`
   - `resp_inbound`
   - `resp_chatprocess`
   - `resp_outbound`

## 9. Implementation Sequence

1. 收敛唯一 owner 与唯一修改点。
2. 先补/修 Rust owner 单测。
3. 补/修 TS/native focused tests。
4. 补/修 HTTP blackbox 与 continuation history tests。
5. build native + build llmswitch-core。
6. 安装到真实运行体并重启 5555。
7. 跑 5555 live probe，先打通 managed stopless 入口。
8. 逐项收集 live 证据包。
9. 更新 `note.md`；只有 verified truth 才进 `MEMORY.md`。
10. 做 stopless 相关 diff review。
11. commit。
12. push。

## 10. Deliverables

必须一并交付：

1. stopless 代码修复
2. Rust/TS/HTTP 测试
3. 5555 live probe 脚本与样本证据
4. `note.md`
5. 必要时 `MEMORY.md`
6. review 结论
7. commit
8. push

## 11. Definition Of Done

只有满足以下 DoD，才允许结束：

1. 唯一 owner 修复完成。
2. 定向测试全绿。
3. 5555 live 证据证明 stopless 不会“一轮就停”，并且 allow-stop/needs_user_input 对用户透明。
4. `/submit_tool_outputs` 多轮恢复历史完整。
5. budget/reset 语义与 Rust 真源一致，或者若 live 仍被 provider 阻断，失败归因已经被完整锁到首个非-stopless 契约节点。
6. 交付已完成 review、commit、push。
