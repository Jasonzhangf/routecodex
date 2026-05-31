# /goal — HubPipeline Rust 总控 API Closeout

**日期**: 2026-05-31  
**文档**: `docs/goals/hubpipeline-rust-closeout-master-plan.md`

---

## 目标

把 Hub Pipeline 收口为 Rust 总控 API + TS 最薄调用壳。语义真源唯一，TS 只做 wrapper/effect executor/Node glue，禁用 fallback/降级/双路径。

---

## 实现文档

`docs/goals/hubpipeline-rust-closeout-master-plan.md`

详细设计、技术方案、文件清单、测试矩阵、风险规避均在文档中。执行前必须读。

---

## 执行规范

- **总控 API 先行**：先补 `hub_pipeline_lib.rs` / `runHubPipelineLibJson` / `runHubPipelineStageJson`，再按 slice 迁语义。
- **一个 slice 一个闭环**：红测 → Rust 实现 → TS 退化/删除 → 绿测 → build。
- **EffectPlan 边界**：TS 可执行 HTTP/FS/provider/servertool side effects，不得决定 payload/tool/route 语义。
- **无 fallback**：Rust path 失败必须显式 structured error；禁止 TS 回退旧实现。
- **物理删除**：迁出后旧 TS 语义实现必须删除，不允许“以防万一”并存。

---

## 验证

- **架构红测**：stage index 不得 import/call 旧 TS orchestrator / semantic mapper。
- **黑盒红测**：HTTP `/v1/responses` + fake provider/tool，断言 Rust plan 决定 servertool/followup/reentry、tool_calls finish_reason、coding 只命中当前轮写操作。
- **Rust unit**：`cargo test -p router-hotpath-napi hub_pipeline -- --nocapture`
- **Jest 定向**：`pnpm run jest:run -- tests/servertool/resp-process-stage3-reentry.spec.ts --no-coverage`
- **Build / install**：`pnpm -C sharedmodule/llmswitch-core run build && pnpm run build:dev && pnpm run install:global`
- **Live smoke**：`routecodex restart --port 5555`，日志含 `▶ [/v1/responses]` 和 `[virtual-router-hit]`

---

## 完成标准

1. `runHubPipelineLibJson` / `runHubPipelineStageJson` 成为 Hub Pipeline 语义总控入口。
2. P0/P1 TS stage/index 只剩 wrapper + effect executor + Node glue。
3. 旧 TS 语义实现/fallback/重复 mapper 物理删除。
4. 黑盒红测先红后绿证据完整，Rust/Jest/build/install/live smoke 通过。
5. `MEMORY.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 更新。

---

## Slice 执行顺序

1. **Slice 0** — 总控 API 基座：`hub_pipeline_lib.rs` + TS wrapper
2. **Slice 1** — resp_process.stage3 servertool orchestration
3. **Slice 2** — req_process.stage1 tool governance 后处理
4. **Slice 3** — resp_process.stage2 finalize ProcessedRequest 组装
5. **Slice 4** — hub-pipeline normalize-request 总控
6. **Slice 5** — operation-table / semantic-mappers / format-adapters
