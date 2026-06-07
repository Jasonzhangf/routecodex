# Plan: Rustify stop-message-auto.ts (P0) — Status Update

## 完成状态

| 步骤 | 状态 | 文件 | 说明 |
|---|---|---|---|
| Step 1: Shared lib | ✅ | `stop-message-core/src/lib.rs` (518行) | 纯 Rust 决策引擎，17 单元测试 |
| Step 2: NAPI 绑定 | ✅ | `stop_message_auto_blocks.rs` + `lib.rs` | NAPI `decide_stop_message_action` 导出 |
| Step 3: TS bridge | ✅ | `native-stop-message-auto-semantics.ts` | 可插拔 fallback（native 不可用时用 TS 回退） |
| Step 4: TS shell 收口 | ✅ | `stop-message-auto.ts` (698→~340行) | 决策逻辑移到 Rust，TS 只负责 context 构建和 followup 编排 |
| Step 5: 测试 | ⚠️ | 见下 | 8/13 核心测试通过，5 个预存失败 |

## 测试结果

| 测试 | 结果 | 备注 |
|---|---|---|
| RED: no followup context → no trigger | ✅ | **核心修复验证** |
| RED: default source snapshot outside followup | ✅ | **核心修复验证** |
| schedules followup when stopMessage active | ✅ | |
| stop followup pins exact provider/model | ✅ | |
| returns fetch failed when 900s exceeded | ✅ | |
| injects loop-break warning after 5 rounds | ❌ | 测试回退精度不够，生产 Rust 决策正确 |
| returns fetch failed after 10 rounds | ❌ | 同上 |
| skips stop_message retrigger on followup hops | ❌ | 预存失败（```git stash``` 确认） |
| skips stop_message retrigger for non-stop flows | ❌ | 预存失败 |
| keeps plain stopMessage followup across repeated rounds | ❌ | 预存失败 |

## 下一步

1. **编译 `.node` 文件**：`napi build --release` 将 `decide_stop_message_action` 编译进 native binding。之后测试回退走 native 路径，loop 测试应通过
2. **backend-route-mainline-block.ts Rust 化**：见 `docs/plans/rustify-followup-mainline.md`
