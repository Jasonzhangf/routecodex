# /goal — HubPipeline Full Rustification Closeout

**日期**: 2026-05-31  
**当前执行文档**: `docs/goals/hubpipeline-full-rust-closeout-plan.md`
**历史参考**: `docs/goals/hubpipeline-rust-closeout-master-plan.md`

---

## 目标

把 RouteCodex Hub Pipeline / Chat Process / servertool followup orchestration 的剩余 TS 语义逐 slice Rust 化，最终收口为 Rust 唯一运行时真源。TS 只保留必要启动、装配、NAPI/JSON/stream bridge 和外部 IO glue，禁用 fallback/降级/双路径。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

---

## 实现文档

`docs/goals/hubpipeline-full-rust-closeout-plan.md`

当前执行合同以该文档第 9 节 `2026-07-03 Execution Contract: Full Rustification Goal` 为准；旧 master plan 仅作历史参考，不再作为 API 目标真源。

---

## 执行规范

- **总控入口锁定**：当前入口是 `executeHubPipelineJson` / `runHubPipelineLibJson`；旧 stage wrapper/API 已删除，禁止复活。
- **一个 slice 一个闭环**：owner lock → residue inventory → test design → red evidence → Rust 实现 → TS 删除/薄壳化 → green evidence → live replay → architecture review。
- **Control/Data 分离**：metadata、route、error、effect 只能进入 control/carrier；业务 payload 只能走 data。
- **无 fallback**：Rust path 失败必须显式 structured error；禁止 TS 回退旧实现。
- **物理删除**：迁出后旧 TS 语义实现必须删除，不允许“以防万一”并存。
- **Map 先行**：每个 slice 修改前必须查 `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml` 和 wiki/manifest；找不到唯一 owner/边界先补 map，不改实现。

---

## 验证

- **白盒覆盖**：Rust owner unit/error tests、NAPI bridge tests、TS residue audit tests、function/mainline/verification map gates。
- **黑盒覆盖**：module blackbox、HTTP `/v1/responses` / `/v1/chat/completions` / `/v1/messages` same-entry samples、provider/client metadata isolation、ErrorErr chain、continuation/servertool lifecycle。
- **全局 gate**：`npm run verify:function-map-compile-gate`、`npm run verify:architecture-mainline-call-map`、`npm run verify:architecture-mainline-manifest-sync`、`npm run verify:architecture-mainline-mermaid-sync`、`npm run verify:llmswitch-rustification-audit`、`npm run verify:servertool-rust-only`。
- **Rust/build**：`cargo check --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi`、`npm run build:base`。
- **Live closeout**：影响 runtime behavior 的阶段必须 `npm run pack:rcc`、`npm run verify:rcc-release-install`、`routecodex restart --port <managed-port>`、`/health`、同入口旧失败样本或真实样本 replay。

---

## 完成标准

1. Rust 拥有请求链、响应链、错误链、metadata carrier、effect/runtime state contract。
2. TS 不再解释 payload/tool/route/servertool/response effect 语义，只保留必要 bridge/glue。
3. 旧 TS 语义实现/fallback/重复 mapper/旧 wrapper 物理删除。
4. 每个 P0 slice 都有白盒、模块黑盒、HTTP/project 黑盒、错误链黑盒、live replay 证据。
5. `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml`、wiki/manifest 与代码 owner 一致。
6. `MEMORY.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 或相关 rustification skill 已沉淀确证流程与反模式。

---

## Slice 执行顺序

1. **P0-1** — `servertool.followup_orchestration`
2. **P0-2** — `hub.req_chatprocess.tool_governance`
3. **P0-3** — `hub.resp_chatprocess.tool_governance`
4. **P0-4** — `conversion.responses.store`
5. **P0-5** — `conversion.shared.anthropic`
6. **Final** — TS runtime physical deletion + global rustification/live closeout
