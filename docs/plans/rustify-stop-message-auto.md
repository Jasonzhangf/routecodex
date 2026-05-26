# Plan: Rustify stop-message-auto.ts (P0)

Architecture: shared lib (no NAPI dep) → NAPI blocks → thin TS shell

## 文件

| Layer | File | Lines |
|---|---|---|
| Source | `servertool/handlers/stop-message-auto.ts` | 682 |
| Shared lib | `rust-core/crates/stop-message-core/src/` (new crate) | — |
| NAPI blocks | `rust-core/crates/router-hotpath-napi/src/stop_message_auto_blocks.rs` | ~200 |
| TS shell | `servertool/handlers/stop-message-auto.ts` → ~120 | — |

## 当前依赖链

```
stop-message-auto.ts (682 行)
├── runtime-utils.ts        — persisted lookup, snapshot resolve (TS)
├── routing-state.ts        — snapshot apply/clear/normalize (TS)
├── config.ts               — stop-message.json config read (TS)
├── stop-gateway-context.ts — isStopEligible (TS)
├── stopless-goal-state.ts  — goal state read (TS)
├── sticky-session-store.ts — disk I/O (TS)
├── followup-sanitize.ts    — text sanitize (TS)
├── registry.ts             — handler registration (TS)
└── compaction-detect.ts    — compaction detect (TS)
```

## Step 1: 提取 Shared Lib (stop-message-core)

新建 `rust-core/crates/stop-message-core/`，纯 Rust 库，**不依赖 NAPI**。

### 函数面

```rust
// 决策核心 — 对应 handler 的 ~300 行条件判断
pub fn decide_stop_message_action(
    ctx: &StopMessageDecisionContext,
) -> StopMessageDecision
```

**`StopMessageDecisionContext`** 包含所有输入：

```rust
pub struct StopMessageDecisionContext {
    // 状态
    pub has_persisted_snapshot: bool,
    pub snapshot_text: Option<String>,
    pub snapshot_max_repeats: u32,
    pub snapshot_used: u32,
    pub snapshot_stage_mode: StageMode,        // on/off/auto
    pub snapshot_source: SnapshotSource,       // explicit/persisted/default

    // 运行时
    pub stop_eligible: bool,                    // finish_reason=stop?
    pub has_managed_goal: bool,
    pub goal_status: GoalStatus,               // idle/active/paused/stopped/completed
    pub followup_flow_id: Option<String>,       // servertool followup context
    pub port_stop_message_disabled: bool,
    pub empty_reply_continue_local: bool,

    // 默认配置
    pub default_enabled: bool,
    pub default_max_repeats: u32,
    pub default_text: String,

    // 计数
    pub used: u32,
    pub max_repeats: u32,
}

pub enum StopMessageDecision {
    Skip { reason: SkipReason },
    Trigger {
        followup_text: String,
        provider_pin: Option<ProviderPin>,
        injected_used: u32,
    },
}

pub enum SkipReason {
    PortDisabled,
    ServertoolFollowupHop,
    ResponsesSubmitToolOutputsResume,
    ExplicitModeOff,
    ExplicitModeWithoutSnapshot,
    GoalDefaultExhausted,
    NoSnapshot,
    ModeOff,
    EmptyText,
    InvalidRepeats,
    NotStopFinishReason,
    ReachedMaxRepeats,
    GoalActive,
}

pub struct ProviderPin {
    pub provider_key: Option<String>,
    pub model_id: Option<String>,
    pub routecodex_port_mode: Option<String>,
}
```

**`StopMessageDecision`** 作为纯数据返回——TS shell 读这个结果来调度 followup，不包含业务逻辑。

### 测试

`stop-message-core/` 自带 Rust 单元测试，覆盖：

- 有 persisted snapshot 时正常触发
- 无 snapshot + DEFAULT_ENABLED=false → skip
- 无 snapshot + 无 followupFlowId → skip（当前 bug 修复）
- 无 snapshot + 有 followupFlowId + DEFAULT_ENABLED=true → 触发（default 续杯）
- goal active → skip
- used >= maxRepeats → skip_reached_max
- port disabled → skip
- 空 text → skip

## Step 2: NAPI 绑定 (stop-message-auto-blocks)

新建 `router-hotpath-napi/src/stop_message_auto_blocks.rs`：

```rust
#[napi]
pub fn decide_stop_message_action_with_native(
    ctx_json: String,
) -> String  // JSON 序列化的 StopMessageDecision
```

TS 侧调用：

```typescript
import { decideStopMessageActionWithNative } from '../engine-selection/native-stop-message-auto-semantics.js';
```

## Step 3: TS Shell 收口

stop-message-auto.ts 从 682 行收缩到 ~120 行：

```typescript
const handler: ServerToolHandler = async (ctx) => {
    // 1. 收集输入
    const ctx = buildDecisionContext(adapterContext, rt, ...);

    // 2. 调用 Rust 决策
    const decision = decideStopMessageActionWithNative(ctx);

    // 3. 根据决策执行
    if (decision === 'skip') return null;
    if (decision === 'trigger') return buildFollowupPlan(decision);
};
```

仅剩的 TS 逻辑：
- 构建 `StopMessageDecisionContext`（从 adapterContext/rt 读字段）
- consume 决策结果 → 调用 `registerServerToolHandler`
- 日志/compare context

## 工作量估计

| 步骤 | 估计工时 | 产出 |
|---|---|---|
| Step 1: Shared lib + 测试 | 6h | `stop-message-core/src/lib.rs` ~400 行 |
| Step 2: NAPI 绑定 | 2h | `stop_message_auto_blocks.rs` ~80 行 + TS 封装 30 行 |
| Step 3: TS shell 收口 | 1h | `stop-message-auto.ts` 从 682 → ~120 行 |
| CI/构建集成 | 1h | Cargo.toml, build.rs |
| **合计** | **10h** | |
