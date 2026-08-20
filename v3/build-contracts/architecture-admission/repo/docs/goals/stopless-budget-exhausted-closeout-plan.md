# stopless budget exhausted 优雅停 + 动态 guidance 收口

## 问题描述

### Bug 1: budget 打满报错，不优雅停

**当前行为**（live `0.90.3072`）：

```
$ routecodex hook run stop_message_auto --input-json '{"flowId":"stop_message_flow","repeatCount":3,"maxRepeats":3}'
SERVERTOOL_CLI_INVALID_FIELD: repeatCount/maxRepeats
```

**期望行为**：返回 `ok=true` JSON，`summary="stopless budget exhausted"`，`continuation_prompt` 说明"停止选项 / forcestop / 填写 schema"。

### Bug 2: guidance 静态不变，不反馈上一轮缺了什么

**当前行为**：每轮 guidance 文本相同（字段列表 + 通用说明），模型只知道"要填 schema"，不知道"上一轮哪个字段填错了 / 缺了什么 / 怎么停"。

**期望行为**：每轮 guidance 动态包含：
- 上一轮触发原因（无 schema / schema 无效 / schema 非终态 / 已打满）
- 本轮可选停止方案（正常收尾 / 强制停止）
- 必填字段和如何填（针对当前触发原因）
- forcestop 作为最后手段的使用说明

## 修改点

唯一 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`

### 1. 修复 budget exhausted 返回

**当前代码**（约第 217 行）：

```rust
if next_max_repeats == 0 || next_repeat_count > next_max_repeats {
    return Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"));
}
```

**改为**：

```rust
if next_max_repeats == 0 || next_repeat_count > next_max_repeats {
    // 打满后优雅停止，不报错
    let session_id = session_id;
    let request_id = request_id;
    let prompt = resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
        used: next_max_repeats.saturating_sub(1),
        max_repeats: next_max_repeats,
        trigger: StoplessContinuationTrigger::BudgetExhausted,
    })
    .expect("prompt");
    return Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless budget exhausted".to_string(),
        tool_name: "stop_message_auto".to_string(),
        flow_id: "stop_message_flow".to_string(),
        continuation_prompt: prompt.client_visible_text,
        repeat_count: next_max_repeats,
        max_repeats: next_max_repeats,
        session_id: Some(session_id),
        request_id: Some(request_id),
        schema_guidance: Some(stopless_schema_guidance()),
        injected_prompt_preview: None,
        input: serde_json::json!({
            "flowId": "stop_message_flow",
            "repeatCount": next_max_repeats,
            "maxRepeats": next_max_repeats
        }),
    });
}
```

### 2. 动态 guidance 文本

**当前** `render_stopless_schema_guidance_text`：纯字段列表 + 静态说明。

**改为** 接受 `trigger: StoplessContinuationTrigger` 参数，动态生成：

```rust
pub fn render_stopless_schema_guidance_text(
    guidance: &StoplessSchemaGuidance,
    trigger: StoplessContinuationTrigger,
    used: u32,
    max_repeats: u32,
) -> String {
    let fields = guidance.required_fields.join(", ");
    let base = format!(
        "停止 schema 字段：{fields}\nstopreason 取值：0=finished，1=blocked，2=continue_needed。\n"
    );

    match trigger {
        StoplessContinuationTrigger::NoSchema => format!(
            "{base}上一轮你直接说了 stop，但没有附上 schema。\
            如果真的做完了，把 stopreason=0 + reason 写上就行，不用等完美收尾。\
            如果卡住了，必须写 stopreason=1 + reason + issue_cause，说明卡在哪一步。\
            如果还在推进中，写 stopreason=2 + next_step。\
            forcestop=1 是最后手段，只有在反复循环无法继续时才用，必须写 reason。"
        ),
        StoplessContinuationTrigger::InvalidSchema => format!(
            "{base}上一轮的 schema 格式有问题（字段缺失或 stopreason 值不对）。\
            重新写一遍：stopreason=0+reason（做完时）或 stopreason=1+reason+issue_cause（卡住时），\
            其余字段按真实情况填，没有就写'无'，不要空着。\
            forcestop=1 作为最后手段。"
        ),
        StoplessContinuationTrigger::NonTerminalSchema => format!(
            "{base}上一轮你给了 schema，但 stopreason=2（还要继续）。\
            如果现在可以停了，直接改 stopreason=0 + reason 重新提交。\
            如果仍需推进，写 stopreason=2 + next_step 继续执行。\
            不用每轮都重新说'要填 schema'，按当前状态选一个 stopreason 就行。"
        ),
        StoplessContinuationTrigger::BudgetExhausted => format!(
            "{base}你已经用完了 {max_repeats} 次 stopless 重试机会（本轮第 {used} 次）。\
            现在必须做一个最终决定：\
            1) 正常收尾：stopreason=0 + reason + done_steps，把能做的东西交付出来；\
            2) 阻塞说明：stopreason=1 + reason + issue_cause，说明卡在哪一步；\
            3) 最后手段：forcestop=1 + reason，不要求完美，但必须说明为什么必须停。\
            其余字段可不填，但不建议留空。"
        ),
        StoplessContinuationTrigger::Stop | StoplessContinuationTrigger::SchemaPass => base,
    }
}
```

同时 `build_stop_message_auto_run_output` 在构造 `schema_guidance` 时需要把 `trigger` 信息传入（通过一个内部 helper 或直接在 stdout JSON 里加一个 `trigger` 字段）。

### 3. schemaGuidance JSON 也带 trigger 上下文

`StoplessSchemaGuidance` 不变，但 `ServertoolCliRunOutput` 加一个可选字段：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessSchemaGuidance {
    pub required_fields: Vec<String>,
    pub stopreason_values: StopreasonValues,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_hint: Option<String>,   // 新增
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_missing: Option<String>, // 新增
}
```

`render_stopless_schema_guidance_text` 同时写这两个字段，TS 端 `stop_hook_guidance_text_appends_schema_guidance_from_cli_output` 测试需要同步更新断言。

### 4. 红测补强

**必须新增**：

1. `cli_contract.rs` 测试：`budget_exhausted_returns_ok_not_error`
   - `repeatCount=3, maxRepeats=3` → `ok=true, summary="stopless budget exhausted"`
   - continuation_prompt 非空且含"停止"关键词

2. `cli_contract.rs` 测试：`renders_trigger_specific_guidance_for_each_trigger`
   - `NoSchema` guidance 含"上一轮你直接说了 stop"
   - `InvalidSchema` guidance 含"格式有问题"
   - `BudgetExhausted` guidance 含"用完了 X 次重试机会"

3. `stopless_prompt.rs` 测试：`resolve_stopless_continuation_prompt_budget_exhausted_uses_final_guard_template`
   - 确认 `BudgetExhausted` 走 final 模板，不是 NoSchema middle

## 验证命令

```bash
# 1. Rust unit
cargo test -p servertool-core budget_exhausted_returns_ok_not_error --lib -- --nocapture
cargo test -p servertool-core renders_trigger_specific_guidance_for_each_trigger --lib -- --nocapture
cargo test -p servertool-core stopless --lib -- --nocapture

# 2. stop-message-core
cargo test -p stop-message-core forcestop --lib -- --nocapture

# 3. TS Jest
node --experimental-vm-modules ./node_modules/.bin/jest \
  tests/servertool/stopless-prompt.client-visible.spec.ts \
  tests/servertool/stopless-cli-continuation.spec.ts \
  tests/servertool/servertool-cli-projection.spec.ts \
  --runInBand

# 4. 编译 + 全局安装 + 重启
PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs
PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 \
  ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh

# 5. live 验证
routecodex --version
# 同一 session 连跑 4 次，第 4 次应该 ok=true 不报错
SESSION=test-budget-$$ CODEX_THREAD_ID=test-budget-$$ \
  routecodex hook run stop_message_auto \
    --input-json '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}'
SESSION=test-budget-$$ CODEX_THREAD_ID=test-budget-$$ \
  routecodex hook run stop_message_auto \
    --input-json '{"flowId":"stop_message_flow","repeatCount":2,"maxRepeats":3}'
SESSION=test-budget-$$ CODEX_THREAD_ID=test-budget-$$ \
  routecodex hook run stop_message_auto \
    --input-json '{"flowId":"stop_message_flow","repeatCount":3,"maxRepeats":3}'
# 第 4 次，打满，期望 ok=true 不报错
SESSION=test-budget-$$ CODEX_THREAD_ID=test-budget-$$ \
  routecodex hook run stop_message_auto \
    --input-json '{"flowId":"stop_message_flow","repeatCount":4,"maxRepeats":3"}'

# 6. 健康检查
curl -s http://127.0.0.1:5555/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('status')=='ok' else 'FAIL')"
curl -s http://127.0.0.1:5520/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('status')=='ok' else 'FAIL')"
```

## DoD

- [ ] `repeatCount=3/maxRepeats=3` → `ok=true`，不报 `SERVERTOOL_CLI_INVALID_FIELD`
- [ ] `continuation_prompt` 包含停止选项说明（正常收尾 / 阻塞说明 / forcestop）
- [ ] guidance 文本根据 trigger 动态变化，NoSchema/InvalidSchema/BudgetExhausted 各有不同说明
- [ ] `schemaGuidance` JSON 含 `trigger_hint` 和 `previous_missing`
- [ ] 红测 `budget_exhausted_returns_ok_not_error` + `renders_trigger_specific_guidance_for_each_trigger` 转绿
- [ ] `cargo test -p servertool-core stopless --lib -- --nocapture` 全部 PASS
- [ ] live 同一 session 连跑 4 次第 4 次不报错
- [ ] `routecodex --version` 健康，三端口 /health 全绿
- [ ] `git diff --check`
