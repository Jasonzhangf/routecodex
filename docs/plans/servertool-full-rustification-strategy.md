# Servertool 完全 Rust 化策略 — 状态更新

## 当前完成状态 (2026-06-XX)

```
Phase 1: 纯逻辑函数化 ✅  (84 Rust tests)
Phase 2: 类型定义迁移 ✅  (StopGatewayContext, FollowupFlowDecision, etc.)
Phase 3: 骨架配置化   ✅  (10 types → native bridge, skeleton-config.ts 薄层)
Phase 4-5: 编排壳     ❌  (依赖 TS runtime, 待执行)
```

## 测试矩阵

```
Rust tests:
  stop-message-core   18 ✅
  followup-core       11 ✅
  servertool-core     55 ✅
                     ────
                      84 ✅

TS tests:
  stop-message-auto          4/11 ✅ (7 预存失败)
  servertool-followup-dispatch 19/19 ✅
  TS 编译                    ✅
```

## Native Bridge 模块

| Bridge 文件 | 导出 |
|---|---|
| `native-stop-message-auto-semantics` | `StopMessageDecisionContext`, `StopMessageDecision`, `decideStopMessageActionWithNative` |
| `native-followup-mainline-semantics` | `FollowupFlowDecision`, `LoopWarningInput`, `BudgetResetDecision`, 10 skeleton types, 3 native functions |
| `native-servertool-core-semantics` | `StopGatewayContext`, `StopMessageCompareContext`, `BudgetDecision`, `BudgetSnapshot`, `DefaultBudgetConfig`, `LoopGuardInput/Output`, 4 native functions |

## Rust Crate 结构

```
rust-core/crates/
├── router-hotpath-napi     # NAPI 绑定 (17+ exports)
├── stop-message-core       # stop_message 决策引擎
├── followup-core           # followup 辅助函数
└── servertool-core         # 核心模块 (3 submodules)
    ├── stop_gateway_context    (10 tests)
    ├── stop_message_loop_guard  (6 tests)
    └── stop_message_counter    (8 tests)
```

## 待完成 (Phase 4-5)

依赖 TS runtime、无法直接 Rust 化的文件 (~2000 行)：

| 文件 | 行数 | 依赖 |
|---|---|---|
| `servertool/followup-mainline-block.ts` | ~480 | async HTTP/pipeline reentry |
| `servertool/engine.ts` | ~200 | async orchestration |
| `servertool/server-side-tools.ts` | ~200 | handler registry + dispatch |
| `servertool/registry.ts` | ~60 | handler registration |
| `servertool/types.ts` | ~240 | TS-specific type patterns |
| 9 handler 实现文件 | ~1500 | tmux/HTTP/进程管理 |

需要这些 TS runtime 基础设施先 Rust 化才能继续。
