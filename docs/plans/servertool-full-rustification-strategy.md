# Servertool 完全 Rust 化策略

目标：stopMessage / followup / servertool orchestration 全部 Rust 化，不留 TS。

## 现状

| 组件 | 文件 | 行数 | Rust 化进度 |
|---|---|---|---|
| 决策引擎 | `stop-message-core/` | 518 | ✅ 已完成 (18 tests) |
| 辅助函数 | `followup-core/` | 210 | ✅ 已完成 (11 tests) |
| NAPI 绑定 | `router-hotpath-napi` | 已集成 | ✅ 4 个 NAPI 导出 |
| 编排壳 | `followup-mainline-block.ts` | ~480 | ⏳ 辅助函数已替换，编排壳留 TS |
| Handler | `stop-message-auto.ts` | ~340 | ⏳ 决策已 Rust，收集/调度留 TS |
| **剩余 TS 代码** | ~30 个文件 | **~5000 行** | **❌ 待迁移** |

## 迁移原则

### 三层架构（已有模式）

```
┌─ Rust Core (pure Rust, no NAPI) ─────────────────────┐
│  Shared lib crates: 决策/校验/状态机                   │
│  → 可以独立 cargo test                                 │
└───────────────────────────────────────────────────────┘
        ↓ JSON
┌─ Rust Blocks (NAPI) ─────────────────────────────────┐
│  router-hotpath-napi 模块                             │
│  → 薄封装，只做序列化+转发                              │
└───────────────────────────────────────────────────────┘
        ↓ JS bridge
┌─ TS Shell ───────────────────────────────────────────┐
│  编排壳：if/else/loop + 调用 NAPI blocks              │
│  → 逐步收窄，最终全部消失                               │
└───────────────────────────────────────────────────────┘
```

### 分阶段策略

**Phase 1 — 决策函数化（当前）**
- 目标：所有 if/else/switch 逻辑 → Rust shared lib
- 已完成：stop-message 决策 + followup 辅助函数
- 下一批：`stop-gateway-context.ts`, `stop-message-loop-guard-block.ts`

**Phase 2 — 数据对象化**
- 目标：所有配置/状态结构体 → Rust struct (Serialize/Deserialize)
- 现有：`StopMessageDecisionContext`, `LoopWarningInput`, `BudgetResetDecision`, `ProviderPin`
- 待做：`ServerToolExecution`, `ServerToolHandlerPlan`, `FollowupPlan`, `StopMessageCompareContext`

**Phase 3 — 骨架配置化**
- 目标：servertool 执行计划（哪个 handler 跑什么、优先级、参数）→ Rust
- 已有：`servertool_skeleton_config.rs`（Rust 真源）
- 待做：flow policy profiles, autoHook queue, progress config

**Phase 4 — 编排 Rust 化**
- 目标：`runFollowupMainline` 的 async 编排逻辑 → Rust
- 最大挑战：TS `await` 链（HTTP 请求、进程管理）需要 Rust 异步 runtime
- 路径：先在 Rust 中实现同步编排（非 IO 部分），再逐步包裹 IO

**Phase 5 — Handler 注册 Rust 化**
- 目标：`registerServerToolHandler` / handler 注册机制 → Rust
- 挑战：当前注册是 TS import-time side effect
- 路径：配置驱动 → Rust 读取 skeleton config → 自动注册

## Phase 1 剩余工作

### 待迁移的纯逻辑函数

| 文件 | 函数 | 行数 | 复杂度 |
|---|---|---|---|
| `stop-gateway-context.ts` | `inspectStopGatewaySignal` | ~120 | **高** — 协议感知的 finish_reason 解析 |
| `stop-message-loop-guard-block.ts` | `evaluateStopMessageLoopGuard` | ~60 | **中** — 循环守卫 |
| `stop-message-counter.ts` | `applyStopMessageFinishReasonBudget` | ~90 | **中** — 预算计数 |
| `stop-message-compare-context.ts` | 全部 | ~60 | **低** — 纯数据 |
| `loop-state-block.ts` | `buildServerToolLoopState` | ~80 | **中** — 循环状态 |
| `followup-flow-policy.ts` | `resolveFollowupFlowDecision` | ~60 | **低** — skeleton config 查表 |
| `followup-runtime-block.ts` | `resolveLoopPayload`, `assertAutoLimitNotExceeded` | ~100 | **中** |

**小计：~570 行纯逻辑可立刻 Rust 化。**

### 依赖 TS Runtime 无法直接 Rust 化的（留到 Phase 4-5）

| 文件 | 依赖 |
|---|---|
| `followup-mainline-block.ts` 编排壳 | async HTTP/pipeline reentry |
| `client-inject-followup-block.ts` | tmux session + inject dispatch |
| `reenter-followup-block.ts` | async pipeline reentry |
| `bootstrap-followup-replay-block.ts` | async pipeline replay |
| `finalize-followup-block.ts` | response decoration |
| `server-side-tools.ts` | handler registry + tool call dispatch |
| `engine.ts` | async orchestration |

**小计：~2000 行编排壳（Phase 4-5）。**

## 建议执行顺序

```
Week 1-2: Phase 1 剩余
  └─ stop-gateway-context.rs  (高 ROI — 去掉协议特判)
  └─ stop-message-counter.rs   (预算逻辑)
  └─ stop-message-loop-guard.rs
  └─ followup-flow-policy.rs
  └─ followup-runtime-block.rs (纯函数部分)

Week 3-4: Phase 2 数据对象化
  └─ 所有 servertool 类型 → Rust struct
  └─ 删除 TS 类型定义文件

Week 5-6: Phase 3 骨架配置化
  └─ flow policy profiles → Rust 配置结构体
  └─ autoHook queue 注册 → Rust

Week 7-12: Phase 4-5 编排 + Handler 注册
  └─ 先同步编排逻辑
  └─ 再异步 IO 包裹
  └─ 最终删除全部 servertool TS 代码
```
