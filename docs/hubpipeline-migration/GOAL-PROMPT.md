/goal HubPipeline TS→Rust 迁移

## 目标
分阶段执行（详见 docs/hubpipeline-migration/DESIGN.md）

**Phase 0（已完成 ✅）**：
- ✅ P0-1 ~ P0-4 全部完成
- ✅ 验证: unified-hub-shadow diff=0, stopless-goal-state 2/2, goal-regression 4/5, build:min v0.90.1628

**Phase 1（需 Jason 决策）**：
- ⚠️ 关键发现：Rust `run_hub_pipeline` 当前仅 119 行 metadata 增强，不包含语义映射/tool governance/routing 核心逻辑
- ⚠️ Phase 1 真实工作 = 逐 stage 深化 Rust 实现，而非"接管道"
- 待 Jason 决策从哪个 Slice 开始（建议 Slice 1 或 Slice 3）

## 约束
- Rust 是唯一真源；TS 仅 thin wrapper
- 禁止 fallback / 降级 / 双路径常驻
- 真实 payload 不可裁剪或改写语义
- 每个 Slice：深化 Rust → same-shape replay 对比 TS → 物理删除 TS

## 验收标准
| 阶段 | 门 |
|------|------|
| Phase 0 | P0-1 ~ P0-4 完成 ✅ |
| Phase 1 each Slice | Rust stage 通过 same-shape replay；TS 功能代码删除 |
| 全局 | tsc + cargo check + build:min ✅ + unified-hub-shadow ✅ + 5520 live |

## 执行
按 DESIGN.md 分阶段执行，每阶段回报：变更+证据+缺口+下一步。
