# Stopless Fence SSOT Plan

## 目标

把 stopless stop schema 收敛为唯一 fence 合同，并把“注入 / 解析 / 剥离”分别钉死到唯一 owner，先红测锁定，再改 Rust 真源，最后做 5555 live replay。

标准 fence：

```text
<rcc_stop_schema>
{"stopreason":2,"reason":"...","has_evidence":0,"evidence":"...","issue_cause":"...","excluded_factors":"...","diagnostic_order":"...","done_steps":"...","next_step":"...","next_suggested_path":"...","needs_user_input":false,"learned":"..."}
</rcc_stop_schema>
```

## 唯一 owner

### 1. 注入 owner

- 文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- 唯一职责：
  - stopless system instruction 注入
  - `reasoning.stop` tool description / JSON schema 注入
  - terminal trigger 后移除 stopless controls
- 本轮改动：
  - 抽出 canonical stop schema contract 常量
  - system instruction 与 tool description 同源渲染
  - 明确双注入合同：
    - 调用 `reasoning.stop` 时必须提供完整 schema
    - 若直接 `finish_reason=stop`，正文末尾必须输出 `<rcc_stop_schema>...</rcc_stop_schema>`
    - 没有 schema 不允许停止

### 2. 解析 owner

- 文件：`sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
- 唯一职责：
  - `evaluate_stop_schema_gate(...)` 解析 schema
  - 只允许两个来源：
    - `reasoning.stop.arguments`
    - assistant 正文末尾 `<rcc_stop_schema>...</rcc_stop_schema>`
- 本轮改动：
  - 优先解析 `reasoning.stop.arguments`
  - 无 arguments 时只解析 fence 内 JSON
  - fence 外 JSON 一律不收割
  - reason code 收敛：
    - 无 arguments 且无 fence：`stop_schema_missing`
    - fence/arguments 非法 JSON：`stop_schema_invalid_json`
    - fence/arguments 合法但缺字段：现有 partial/terminal missing 系列 reason code

### 3. 剥离 owner

- owner 面：沿现有 stop-message terminal visible payload builder 收口
- 现有 TS 薄壳位置：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- 规则：
  - 校验阶段保留原始 fence
  - terminal client-visible 输出剥离 fence
  - debug/sample side-channel 允许保留 raw schema
  - 禁止 client/bridge/TS 再做第二套 schema 清洗

## 红测先行

### Rust request governance 红测

- 文件：`router-hotpath-napi` request governance 相关 tests
- 新增断言：
  - system instruction 包含 `<rcc_stop_schema>` fence 示例
  - `reasoning.stop` tool description 包含“完整 schema 或 finish_reason=stop + fence”合同
  - system/tool 字段列表同源一致
  - terminal trigger=`budget_exhausted/schema_pass` 后，下一轮请求中不得再注入 `instructions + reasoning.stop + required tool_choice`

### Rust stop-message-core 红测

- 文件：`sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/tests/stop_schema_gate_closure.rs`
- 必补：
  - `reasoning.stop.arguments` 完整 schema -> `allow_stop`
  - `finish_reason=stop + <rcc_stop_schema>` 完整 schema -> `allow_stop`
  - 无 fence 的普通 stop 文本 -> `stop_schema_missing`
  - fence 外裸 JSON -> 不得误解析，仍 `stop_schema_missing`
  - fence 内非法 JSON -> `stop_schema_invalid_json`
  - fence 内缺字段 -> partial/terminal missing reason code

### TS thin-shell / lifecycle 红测

- 文件：
  - `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
  - `tests/servertool/stop-message-native-decision.spec.ts`
- 必补：
  - native gate 的新 fence-only 合同透出到 TS
  - terminal visible payload 不泄漏 `<rcc_stop_schema>`
  - followup/schemaFeedback 仍能回传正确 `reasonCode + missingFields`

## 实施顺序

1. 先补 Rust red tests，确认当前为红。
2. 改 `orchestrator.rs`，抽 canonical contract，完成双注入同源化。
3. 改 `stop-message-core/src/lib.rs`，完成 fence-only + arguments-priority 解析。
4. 改 terminal visible payload owner，确保 terminal 剥离 fence。
5. 跑 focused Rust/TS gates。
6. build/install/restart 5555。
7. live replay 旧 stopless probe，确认从 repeated invalid/missing 收敛到 `schema_pass` 或 `budget_exhausted` terminal。

## 验证栈

### Focused tests

- `cargo test -p stop-message-core --test stop_schema_gate_closure -- --nocapture`
- `cargo test -p router-hotpath-napi reasoning_stop_ -- --nocapture`
- `cargo test -p router-hotpath-napi execute_hub_pipeline_json_rewrites_stopless_cli_result_into_provider_guidance -- --nocapture`
- `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stop-schema-lifecycle-contract.spec.ts tests/servertool/stop-message-native-decision.spec.ts --runInBand`

### Build / install / live

- `npm run build:min`
- `npm run install:global`
- `routecodex restart --port 5555`
- `curl -sS http://127.0.0.1:5555/health`
- `node scripts/tests/stopless-5555-live-probe.mjs`

## 完成标准

- 请求侧 stopless 双注入都引用同一 fence contract。
- 解析侧只收 `reasoning.stop.arguments` 或 `<rcc_stop_schema>`；无 fence 不猜。
- terminal client-visible 输出不泄漏 fence。
- focused Rust/TS tests 绿。
- 5555 live replay 不再卡纯 missing/partial loop，能收敛为 `schema_pass` 或 `budget_exhausted` terminal 之一。
