/goal HubPipeline Rust-only 收口

**目标**：基于修正后的审计报告，完成剩余优化项

**设计文档**：
- `docs/hubpipeline-migration/AUDIT-RUST-ONLY.md`（修正版审计报告）
- `docs/hubpipeline-migration/DESIGN.md`（设计基线）

**当前状态**：
- 12/16 stages ✅ Rust 真源
- 4/16 stages ⚠️ 混合可优化
- 0/16 stages ❌ 无纯 TS 阻塞

**执行规范**：
- Rust 唯一真源，TS 仅 thin wrapper
- 禁止 fallback/双路径常驻
- 物理删除 TS（若有残留）
- same-shape replay diff=0

**验证**：
- build:min ✅
- unified-hub-shadow diff=0
- slice replay diff=0

**完成标准**：
- P1 优化项完成（SSE timeout、流提取等）
- TS 残留物理删除
- ⚠️ NOT VERIFIED 标注未 live 项
