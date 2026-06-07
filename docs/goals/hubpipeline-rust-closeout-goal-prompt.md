# /goal — HubPipeline Full Rust Runtime Closeout

**日期**: 2026-05-31  
**当前执行文档**: `docs/goals/hubpipeline-full-rust-closeout-plan.md`
**历史参考**: `docs/goals/hubpipeline-rust-closeout-master-plan.md`

---

## 目标

把 Hub Pipeline 从“Rust 语义真源 + TS 编排/壳层”收口为“Rust 唯一运行时真源”。TS 只保留必要启动、装配、NAPI/JSON/stream bridge 和外部 IO glue，禁用 fallback/降级/双路径。

---

## 实现文档

`docs/goals/hubpipeline-full-rust-closeout-plan.md`

当前阶段顺序、边界、验证与 DoD 以该文档为准；旧 master plan 仅作历史参考，不再作为 API 目标真源。

---

## 执行规范

- **总控入口锁定**：当前入口是 `executeHubPipelineJson` / `runHubPipelineLibJson`；旧 stage wrapper/API 已删除，禁止复活。
- **一个 slice 一个闭环**：红测 → Rust 实现 → TS 退化/删除 → 绿测 → build。
- **Control/Data 分离**：metadata、route、error、effect 只能进入 control/carrier；业务 payload 只能走 data。
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

1. Rust 拥有请求链、响应链、错误链、metadata carrier、effect/runtime state contract。
2. TS 不再解释 payload/tool/route/servertool/response effect 语义，只保留必要 bridge/glue。
3. 旧 TS 语义实现/fallback/重复 mapper/旧 wrapper 物理删除。
4. 黑盒红测先红后绿证据完整，Rust/Jest/build/install/live smoke 通过。
5. `MEMORY.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 更新。

---

## Slice 执行顺序

1. **Phase 0** — Dead code inventory + physical deletion
2. **Phase 1** — Rust runtime ownership baseline + control/data contracts
3. **Phase 2** — Request path Rust closeout
4. **Phase 3** — Response path + effect interpreter Rust closeout
5. **Phase 4** — Provider transport + HTTP runtime Rust closeout
6. **Phase 5** — TS runtime physical deletion
