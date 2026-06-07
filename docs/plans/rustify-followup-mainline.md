# Plan: Rustify backend-route-mainline-block.ts (P0)

Architecture: shared lib (decision-only) → NAPI blocks → TS orchestration shell

## 文件

| Layer | File | Lines |
|---|---|---|
| Source | `servertool/backend-route-mainline-block.ts` | 484 |
| Shared lib | `rust-core/crates/followup-core/src/` (new crate) | — |
| NAPI blocks | `rust-core/crates/router-hotpath-napi/src/followup_mainline_blocks.rs` | ~150 |
| TS shell | `servertool/backend-route-mainline-block.ts` → ~250 | — |

## 当前结构

```
runFollowupMainline (360 行)
├── 决策: resolveFollowupFlowDecision            → backend-route-flow-policy.ts
├── 决策: isStopMessageFlow, followupPlan        → 简单派生
├── 入参组装: loopPayload, loopState, metadata   → backend-route-runtime-block.ts
├── 入参组装: followupInjectionPlan, executionMode → backend-route-runtime-block.ts
├── 副作用: assertAutoLimitNotExceeded           → backend-route-runtime-block.ts
├── 副作用: evaluateStopMessageLoopGuard         → stop-message-loop-guard-block.ts
├── 副作用: appendLoopWarning                   → 本文件 ~8 行
├── 副作用: applyFollowupRuntimeMetadata         → backend-route-runtime-block.ts
├── 副作用: applyFollowupDeltaPlan               → backend-route-origin-delta.ts
├── 编排: runClientInjectOnlyFollowup            → client-inject-followup-block.ts
├── 编排: runReenterFollowup                    → backend-route-reenter-block.ts
├── 编排: maybeRunTransparentBootstrapReplay     → bootstrap-followup-replay-block.ts
├── 编排: decorateFinalChatWithServerToolContext → finalize-followup-block.ts
└── 后处理: resetStopMessageBudgetAfterNonStopFollowup → 本文件 ~13 行
```

## 本文件中的四种函数

### A. 纯逻辑/决策（Rustify 高 ROI）
```typescript
function buildFollowupRequestId(...)        // 8 行 — 字符串拼接
function appendLoopWarning(...)             // 8 行 — payload 修改
function resetStopMessageBudgetAfterNonStopFollowup(...) // 13 行 — 预算重置
```

### B. 副作用（Rustify 中 ROI）
```typescript
function disableStopMessageAfterFailedFollowup(...) // 24 行 — disk I/O + state write
```

### C. 编排壳（留 TS）
```typescript
runFollowupMainline(...)                    // 360 行 — 主编排
```
这个函数是 async，调了 10+ 个子函数，最内层有 `await` 和复杂 if/else/throw 流。Rust 化编排壳 ROI 低（编译慢 + 测试周期长）。

### D. 子 block（留 TS）
```
client-inject-followup, reenter-followup, bootstrap-replay 等
```
与 TS runtime 深度耦合（HTTP 请求、进程管理）。

## 迁移计划

### Step 1: Shared Lib (followup-core)

纯 Rust 库，无 NAPI 依赖。覆盖 A 类函数。

```rust
// 请求 ID 构建
pub fn build_followup_request_id(base: &str, suffix: Option<&str>) -> String;

// 循环警告注入
pub struct LoopWarningInput {
    pub messages: Vec<Message>,
    pub repeat_count: u32,
    pub warn_threshold: u32,
    pub fail_threshold: u32,
}
pub fn inject_loop_warning(input: LoopWarningInput) -> Vec<Message>;

// 预算重置判定
pub struct BudgetResetDecision {
    pub should_reset: bool,       // observed && !eligible → 递增
    pub next_used: u32,
}
pub fn decide_budget_reset(
    stop_observed: bool,
    stop_eligible: bool,
    current_used: u32,
    current_max: u32,
) -> BudgetResetDecision;
```

### Step 2: NAPI 绑定

```rust
// followup_mainline_blocks.rs
#[napi]
pub fn build_followup_request_id_with_native(base: String, suffix: Option<String>) -> String;

#[napi]
pub fn inject_loop_warning_with_native(input_json: String) -> String;

#[napi]
pub fn decide_budget_reset_with_native(current_used: u32, current_max: u32, stop_observed: bool, stop_eligible: bool) -> String;
```

### Step 3: TS 调用替换

```typescript
// 替换前
const followupRequestId = buildFollowupRequestId(args.requestId, suffix);
// 替换后
const followupRequestId = buildFollowupRequestIdWithNative(args.requestId, suffix ?? null);
```

## 为什么留编排壳在 TS

`runFollowupMainline` 的核心是：
```
if (decision === 'skip' || noFollowup) → return
if (isStopMessageFlow) → evaluateLoopGuard
if (clientInjectOnly) → runClientInject
if (reenter) → runReenter + retry loop
if (transparentReplay) → bootstrapReplay
→ finalize + return
```

这是典型的 **async orchestrator**——顺序执行、错误传播、超时控制。在 TS 中这是 `await` + try/catch 的线性代码，可读性高、修改成本低。移到 Rust 意味着把整个 `Promise` 链用 Rust future 重写，编译时间暴涨，调试流程变长。

**架构原则**：编排壳留 TS，逻辑函数移 Rust，数据对象共享通过 JSON 序列化。

## 工作量估计

| 步骤 | 估计工时 | 产出 |
|---|---|---|
| Step 1: Shared lib + 测试 | 4h | `followup-core/src/lib.rs` ~200 行 |
| Step 2: NAPI 绑定 | 2h | `followup_mainline_blocks.rs` ~80 行 |
| Step 3: TS 调用替换 | 1h | TS 文件从 484 → ~300 行 |
| **合计** | **7h** | |
