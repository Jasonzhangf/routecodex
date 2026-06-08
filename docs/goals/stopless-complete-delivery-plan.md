# Stopless Complete Delivery Plan

## 1. Goal

交付完整可上线的 stopless 功能闭环，覆盖：

- stopless 停止判定正确
- stop schema 不对用户直出
- stopless 结果对用户透明
- `/v1/responses` 与相关续杯链路在真实端口上可重复验证
- 修复后形成可提交、可推送、可回归的完整交付

## 2. Acceptance

完成必须同时满足以下验收：

1. 用户侧不再看到 stop schema JSON、`stopreason`、`has_evidence`、`needs_user_input` 等内部控制字段原文。
2. stopless 允许停止时，最终用户可见内容必须是 markdown summary；缺失字段不显示，不出现空标题。
3. stopless 不允许停止时，必须继续续杯；不得一轮 stop 就直接停住，除非命中明确 allow-stop 条件。
4. `needs_user_input=true` 时只向用户显示问题本身，不显示 schema 原文，不继续无意义续杯。
5. 连续 stop 预算、缺 schema、无效 schema、continue-needed、budget exhausted 的行为与设定一致。
6. 所有关键停止条件都必须完成 live/runtime 验证，不接受只靠单测宣称完成。
7. 完整功能提交必须包含：代码、定向测试、live 验证证据、note/MEMORY 更新、commit、push。

## 3. Scope

In scope:

- `stop_message_auto` 的 stop schema gate
- stopless CLI projection
- stopless CLI result 恢复/消费
- stopless 最终用户可见 summary 投影
- `/v1/responses` 正常 stopless 续杯
- `/v1/responses.submit_tool_outputs` stopless 恢复
- 流式与非流式 stopless
- live 端口验证脚本、样本、日志证据

Out of scope:

- 非 stopless 的普通 tool_call UI 格式优化
- 其他 servertool（`web_search` / `vision_auto`）的语义改造
- provider-specific 文案修补
- direct path 非 stopless 功能扩展

## 4. SSOT And Owner Boundaries

唯一真源按职责划分：

1. 停止判定真源
   - `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
   - 负责：schema 解析、allow_stop/followup/fail_fast、budget、needs_user_input、summary_prefix

2. stopless CLI contract 真源
   - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
   - 负责：`stop_message_auto` CLI 输入/输出 contract、schemaGuidance、CLI result validation

3. stopless response orchestration 真源
   - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
   - 仅允许作为 Rust gate + persisted IO + response shell 薄层；不得另写第二套停止语义

4. 用户可见最终 summary 投影 owner
   - stop-message-core 的 `summary_prefix`
   - 以及 stopless final projection 的唯一 shell
   - 负责把结构化 stop schema 变成 markdown summary，而不是原样返回 JSON

禁止：

- 在 provider/runtime/handler/outbound 各补一版 stop 判断
- 把 schema JSON 当 assistant text 直接返回
- 用 sanitizer/fallback 静默删字段冒充修复
- direct path 和 relay path 各自维护两套 stopless 停止规则

## 5. User-Visible Contract

### 5.1 Allow stop

允许停止时，用户可见输出必须是 markdown，至少按以下规则投影：

- `stopreason=0`:
  - 标题：`## 完成内容`
- `stopreason=1`:
  - 标题：`## 当前阻塞`
- `needs_user_input=true`:
  - 标题：`## 需要确认`
  - 正文仅显示问题本身

字段映射规则：

- `reason` -> 必显，作为首段摘要
- `evidence` -> 有值才显示 `## 证据`
- `issue_cause` -> 有值才显示 `## 问题原因`
- `excluded_factors` -> 有值才显示 `## 已排除因素`
- `diagnostic_order` -> 有值才显示 `## 排查顺序`
- `done_steps` -> 有值才显示 `## 已完成`
- `next_step` -> 有值才显示 `## 下一步`
- `learned` -> 有值才显示 `## 经验`
- `next_suggested_path` -> 仅在 `next_step` 为空且确需建议时显示

硬约束：

- 不显示 `stopreason` / `has_evidence` / `needs_user_input` / `schemaGuidance` / `requiredFields` / `stopreasonValues`
- 不显示空 section
- 不显示“停止原因”“schema”“stopless”“预算耗尽”等内部控制术语，除非用户主动问内部机制

### 5.2 Followup

不允许停止时：

- 必须触发后续续杯，不给用户返回最终 summary
- 当前轮应继续生成 `exec_command routecodex servertool run stop_message_auto ...`
- 不能一轮 stop 就结束

### 5.3 Budget exhausted

预算耗尽时：

- 允许停止
- 但仍必须输出用户可读 markdown summary
- 禁止回传 schema JSON

## 6. Stop Condition Matrix

### A. Skip / no stopless

1. 非 stop finish_reason
2. `/goal active`
3. plan mode
4. direct path
5. 无 stop_message snapshot

预期：

- 不触发 stopless followup
- 不计 stop budget
- 不改用户可见正文

### B. Missing schema

场景：

- assistant 停止文本没有 stop schema

预期：

- 触发 followup
- 不给最终 stop summary
- 按当前设定决定是否计 budget，且必须与 Rust gate 真源一致
- live 中必须继续到下一轮，不是一轮即停

### C. Invalid schema

场景：

1. `stopreason` 缺失
2. `stopreason` 非数字
3. `stopreason=0|1` 但 `reason` 为空
4. `stopreason=2` 且 `next_step` 非空
5. `needs_user_input=true` 但 `next_step` 为空

预期：

- 全部走 followup 或 fail-fast 的既定分支
- 不直接停
- 不向用户展示 schema 原文

### D. Continue-needed

场景：

1. `stopreason=2` + `next_step` 非空
2. `stopreason=2` + `next_step` 为空 + `next_suggested_path` 为空
3. `stopreason=2` + `needs_user_input=false`

预期：

- 继续执行或继续追问
- 不直接停止
- 下一轮预算按 Rust 设定推进

### E. Allow stop

场景：

1. `stopreason=0` + `reason` 非空
2. `stopreason=1` + `reason` 非空
3. `needs_user_input=true` + `next_step` 为问题文本
4. budget exhausted after repeated invalid/missing stop

预期：

- 返回 markdown summary
- 不显示 schema JSON
- 清理 stopless persisted state

## 7. Verification Matrix

### 7.1 Rust unit gates

必须覆盖：

1. `stop_schema_finished`
2. `stop_schema_blocked`
3. `stop_schema_missing`
4. `stop_schema_stopreason_missing_or_non_numeric`
5. `stop_schema_reason_missing`
6. `stop_schema_continue_next_step`
7. `stop_schema_next_step_missing`
8. `stop_schema_continue_without_next_step`
9. `stop_schema_needs_user_input`
10. `stop_schema_needs_user_input_missing_next_step`
11. budget exhausted
12. summary_prefix 不暴露 `stopreason` / schema 原文

命令：

- `cargo test -p stop-message-core -- --nocapture`

### 7.2 TS / bridge / blackbox gates

必须覆盖：

1. stopless CLI projection 仍输出 `exec_command`
2. stopless CLI result 不恢复旧 servertool identity
3. allow_stop 最终输出为 markdown，不含 schema 字段
4. missing/invalid schema 继续 followup，不一轮停止
5. `needs_user_input=true` 只向用户显示问题
6. stream=true / stream=false 都一致
7. `/v1/responses.submit_tool_outputs` 恢复链路一致

建议测试文件：

- `tests/servertool/stop-message-native-decision.spec.ts`
- `tests/servertool/servertool-cli-projection.spec.ts`
- `tests/servertool/servertool-cli-result-restore.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- 新增：
  - `tests/servertool/stop-message-user-visible-summary.spec.ts`
  - `tests/servertool/stop-message-budget-behavior.spec.ts`
  - `tests/server/handlers/responses-handler.stopless-live-shape.blackbox.spec.ts`

### 7.3 Live verification

这是验收主标准。

端口：

- 优先 `5555`
- 必要时补 `10000`

live case matrix：

1. 正常 allow_stop finished
2. 正常 allow_stop blocked
3. missing schema 第 1 轮
4. invalid schema 第 1 轮
5. continue-needed 第 1 轮
6. 连续 invalid/missing 直到 budget exhausted
7. needs_user_input=true
8. stream=true
9. stream=false
10. `/v1/responses/:id/submit_tool_outputs`

每个 case 必须收集：

1. request id
2. 命中端口/route/provider
3. client request sample
4. provider request sample
5. provider response sample
6. client response sample
7. server log 关键行
8. 最终用户可见内容截图或文本

判定标准：

- 没有新的 schema JSON 泄漏给用户
- 没有“第一轮就停”误停
- 命中 allow_stop 时确实能停
- 需继续时确实续杯
- budget exhausted 时输出 markdown final summary

## 8. Live Execution Procedure

1. 重启目标端口
   - `routecodex restart --port 5555`

2. 健康检查
   - `curl http://127.0.0.1:5555/health`

3. 逐 case 发送请求
   - 每个请求使用唯一时间戳
   - 固定保留 request id

4. 立即抓日志
   - `~/.rcc/logs/server-5520.log`

5. 立即抓样本
   - `~/.rcc/codex-samples/**`

6. 对比：
   - 当前轮 assistant stop 文本
   - schema gate 决策
   - followup 是否触发
   - 用户最终看到什么

7. 只在 live 证据齐全时宣称完成

## 9. Risks And Anti-Patterns

风险：

1. 只修 summary，不修 allow_stop/followup/budget，导致表面好看但停止逻辑仍错
2. 只修 TS 文本层，Rust gate 仍允许一轮停止
3. stream path 修了，non-stream path 没修
4. `/v1/responses` 修了，`submit_tool_outputs` 恢复链没修
5. 本地单测通过，但 global install/live dist 没吃到新代码

反模式：

1. 直接正则删掉 JSON 文本当修复
2. 在 provider 层补 stopless 特例
3. 在 client-visible shell 再写第二套 stop schema 解析
4. 不做 live probe 就宣称 stopless 完成

## 10. Implementation Order

1. 收敛当前 stopless 用户可见输出 owner
2. 修 allow_stop 用户可见 markdown 投影
3. 修 stop 判定过早停止 owner
4. 补定向测试
5. 重建/安装 live 运行版本
6. 跑 live matrix
7. 更新 `note.md` / `MEMORY.md`
8. review
9. commit
10. push

## 11. Done Definition

只有同时满足以下条件，才允许提交“完整功能 stopless”：

1. 代码改动已收敛到唯一 owner 点或明确 owner 组
2. 定向测试全部通过
3. live matrix 关键 case 完成
4. 新 request id 的日志、样本、用户可见结果均已留证
5. 不再出现 schema JSON 直出
6. 不再出现错误的一轮停止
7. 结果已写入 `note.md`
8. review 完成
9. 提交并推送完成
