# Stopless 闭环收口实现计划

## 目标
两条变更：
1. 状态匹配从 `T max_session scope` 改为严格按 `sessionId`（已实现，验证结论见本文档 §0）
2. stopless 对模型和客户端完全透明抹掉工具执行痕迹

## §0 sessionId 匹配验证结论

Rust `persisted_lookup.rs` 已实现严格 `session:<sessionId>` 匹配：
- `collect_stop_message_persisted_candidate_keys()` 只从 `record.sessionId` / `metadata.sessionId` 提取 key
- 禁止 `tmux:`、`conversation:`、`default` fallback
- live 样本 `codex:019ec4d3-e92c-7240-b6a5-153aaac6d806` 已确认 sessionId 传递正确

## 验收标准（模型无感）

| 标准 | 说明 |
|------|------|
| 模型看到的 prompt | 纯业务语言引导，不含"stopless"、"schema"、"hook"、"budget"、"第几次"、"已用完"等任何内部术语 |
| CLI stdout | 只含状态文本，`summary` 不含 `continuationPrompt`/`schemaGuidance` 内容 |
| schemaGuidance | 只在 CLI stdout JSON 内，不发给模型 |
| forcestop | 服务端内部逃生机制，模型不知道有这个字段 |
| budget 计数 | 服务端内部，不发模型，不发客户端 |
| 路由 | stopless turn 走 `routeHint=thinking` |

## 核心设计原则

**模型看到的一切 = 正常的业务引导**
**服务端内部的一切 = 客户端不可见，模型不可见**

## 技术方案

### 1. 系统提示词注入（Rust req_chatprocess）

**Owner**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_chatprocess_governance_blocks/stopless_prompt_injection.rs`（新建）

**触发条件**：session 有 `stopMessageState` 且 `stageMode=on`

**注入内容**（纯业务语言，不含任何内部术语）：
```
注意：如果本轮任务已完成或需要停止，请在回复末尾附上以下 JSON：
{"stopreason":0,"reason":"...","has_evidence":1,"evidence":"...","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"...","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}
```
- 不含 `forcestop` 字段（服务端内部用）
- 不含"第几次""还剩几次""budget""stopless"等任何内部术语
- 不含 schemaGuidance / continuationPrompt 内容

### 2. CLI stdout 净化（Rust）

**Owner**：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`

**`summary` 字段**：只允许状态文本
- `"stopless continuation ready"`（正常续杯）
- `"stopless final stop"`（正常停止）
- 不含 `continuationPrompt` 内容

**CLI stdout JSON**：完整包含 `schemaGuidance`/`continuationPrompt`，但这只是 **CLI tool result 本身**，不是发给模型的 prompt。客户端收到 tool result 后通过 `submit_tool_outputs` 闭环，下一轮进入 req_chatprocess 时注入的是业务语言引导，不是 JSON。

### 3. VR routeHint 注入（Rust）

**Owner**：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs`

**逻辑**：当 `stopMessageState.stageMode=on` 时，在 VR metadata 设置 `routeHint=thinking`，覆盖任何 `route_hint:tools`

### 4. Prompt 强度按轮次分化（Rust）

**Owner**：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_prompt.rs`

**逻辑**（服务端内部计数，模型只看到纯业务引导）：

| 服务端 used | 模型看到的 prompt |
|------------|-------------------|
| 0 | `"继续做下一步；先把手头能确认的结果拿回来。"` |
| 1 | `"继续推进；缺哪块结果就补哪块，别停在概述上。"` |
| 2 | `"这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。"` |

**关键**：服务端计数对模型完全隐藏，模型只看到纯业务引导文本。

### 5. forcestop 服务端内部逃生机制

**Owner**：服务端内部逻辑，不暴露给模型

**逻辑**：
- 当 `stopMessageUsed >= maxRepeats` 时，服务端强制 terminal_final，不再触发 CLI 续杯
- `forcestop` 字段是服务端内部 Budget 耗尽的逃生口，模型不需要知道这个字段存在
- 服务端解析 `forcestop=1` 时直接 terminal，不校验 reason 内容（但模型不知道这个字段）

### 6. 服务端 schema 校验与反馈

**Owner**：Rust `stopless_orchestration_contract.rs`

**逻辑**：
- 服务端校验模型提供的 schema 是否符合停止条件
- 不符合时，服务端注入下一轮业务引导 prompt（不是报错给模型）
- 模型看不到"schema 校验失败"这类内部反馈，只看到新一轮业务引导

## 风险与规避

- **风险**：prompt 注入让模型误以为必须 stop schema 导致过度停止
- **规避**：只在 `stageMode=on` 且 session 有 stopMessageState 时注入；正常任务进展时 `stageMode=off` 不注入
- **风险**：CLI stdout 含内部术语泄漏
- **规避**：`STOPLESS_PROMPT_FORBIDDEN_TOKENS` 已存在并持续扫描

## 测试计划

1. Rust unit：`cargo test -p servertool-core stopless --lib -- --nocapture`
2. Rust unit：`cargo test -p servertool-core cli_contract --lib -- --nocapture`
3. TS CLI continuation：`node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts --runInBand`
4. TS VR route hint：`node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
5. No reenter：`node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stop-message-auto-no-reenter.red.spec.ts --runInBand`
6. Gate：`npm run verify:servertool-rust-only && npm run verify:function-map-compile-gate`
7. Live probe：5555 stopless 三轮，观察模型是否主动提供 stop schema 且模型端看不到任何内部术语

## 实施步骤

1. 新建 `stopless_prompt_injection.rs`：req_chatprocess 阶段注入纯业务语言 schema 引导（不含内部术语）
2. 扩展 `stopless_prompt.rs`：纯业务语言 prompt，移除对模型暴露内部状态
3. 净化 `cli_contract.rs::build_stop_message_auto_run_output()`：`summary` 只含状态文本
4. 扩展 `stopless_decision_context_signals.rs`：添加 `routeHint=thinking` 逻辑
5. 更新 `stopless_vr_route_hint.spec.ts`：断言 stopless turn 走 `routeHint=thinking`
6. 编译构建全局安装
7. Live probe

## DoD

- 所有 gate PASS
- Live probe 证明：模型看到的是纯业务引导，CLI stdout 无内部术语，模型主动提供 stop schema，stopless turn 走 thinking 路由
