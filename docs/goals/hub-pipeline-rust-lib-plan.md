# Hub Pipeline Rust Lib 化执行计划

## 目标与验收标准

目标：把 Hub Pipeline 从 TypeScript 编排 + 多个 native 语义碎片，收口为 Rust-owned 完整 lib；TypeScript 只保留 NAPI、Node runtime glue、HTTP/stream/fs/daemon/provider 外部副作用执行。

验收标准：
- `router-hotpath-napi` 内形成 Rust `HubPipelineEngine` / `hub_pipeline_lib` 总控入口。
- Hub request/response processing、chat_process、req_process、resp_process、servertool followup orchestration、tool governance、protocol semantic mapping 的业务语义只在 Rust。
- TS `HubPipeline` 不再决定 payload/tool/route/metadata 语义，只调用 Rust 总入口并执行 Rust 返回的 effect plan。
- 已被 Rust 替代的 TS semantic residue 被物理删除。
- Rust tests、NAPI coverage、Hub matrix、residue/delete gate 全绿。

## 范围与边界

In scope：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/**`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub*.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat*.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/**`

Out of scope：
- Provider runtime HTTP implementation rewrite。
- Clock/servertool daemon implementation rewrite。
- UI/CLI unrelated changes。
- Payload 裁剪式“性能优化”。真实传输 payload 必须语义等价。

## 设计原则

- Rust 是唯一业务语义真源；TS 只能是壳层和副作用执行器。
- 禁止 fallback、降级、双路径补偿；native 缺失或失败必须 fail-fast。
- Hub Pipeline / Virtual Router 禁止 provider-specific 特例；差异只能进入 Rust mapper registry / provider runtime。
- Rust 返回 effect plan；TS 执行 fs、stream、daemon、provider HTTP 等 Node 副作用。
- 先红测锁边界，再迁语义，再物理删除 TS residue。

## 技术方案

核心参考文档：`docs/audit/hub-pipeline-rust-lib-analysis-2026-05-31.md`。

建议 Rust 模块：

```text
sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/
  mod.rs
  engine.rs
  types.rs
  errors.rs
  stage_catalog.rs
  request.rs
  response.rs
  chat_process.rs
  req_process.rs
  resp_process.rs
  mapper_registry.rs
  effect_plan.rs
  diagnostics.rs
```

关键 API：
- `HubPipelineEngine::new(config)`
- `HubPipelineEngine::update_virtual_router_config(config)`
- `HubPipelineEngine::update_runtime_deps(deps)`
- `HubPipelineEngine::execute(request)`
- NAPI 总入口：`execute_hub_pipeline_json(input_json)`

TS 最终形态：
- `HubPipeline.execute()` serialize request → call native total entry → deserialize result → execute `effectPlan`。
- Stage/process/mapper TS 文件不再做业务判定；已替代者删除。

## 风险与规避

- 风险：Node side effect 被强行迁 Rust。规避：Rust 返回 effect plan，TS 只执行副作用。
- 风险：wrapper catch 后静默 fallback。规避：required native export gate + fail-fast error。
- 风险：provider 特例进入 Hub Pipeline。规避：Rust mapper registry + provider family allowlist red test。
- 风险：`.js` sibling shadow 继续生效。规避：active shadow audit + 删除影子路径。
- 风险：payload 语义被裁剪。规避：golden/equivalence tests 对真实传输 payload 做语义等价验证。

## 测试计划

Rust：
- `cargo test -p router-hotpath-napi hub_pipeline`
- `cargo test -p router-hotpath-napi req_process`
- `cargo test -p router-hotpath-napi resp_process`
- `cargo test -p router-hotpath-napi servertool`

NAPI/Hub coverage：
- req inbound / req process / req outbound coverage scripts。
- resp inbound / resp process / resp outbound coverage scripts。
- chat_process governance / servertool / clock / web-search coverage scripts。
- `hub-chain-equivalence.mjs`、`hub-equivalence.mjs`。

Residue gate：
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`

Build/matrix：
- `npm run build`
- `node scripts/tests/run-matrix-ci.mjs`

## 实施步骤

1. 冻结边界：补 residue audit red tests，禁止新增 TS payload/tool/route/metadata 语义。
2. 建 Rust typed contract：新增 `types.rs`、`errors.rs`、`effect_plan.rs` 与 serde tests。
3. 建 Rust 总控 skeleton：`HubPipelineEngine::execute()` 串联现有 Rust stage，不改行为。
4. 收口 req path：normalize、req_inbound、req_process、req_outbound 由 Rust engine 调度。
5. 收口 resp path：resp_inbound、resp_process、resp_outbound 由 Rust engine 调度，stream 只留 TS pipe glue。
6. chat_process effect plan 化：clock/web-search/servertool/governance/media/session usage 只消费 Rust plan。
7. mapper registry Rust 化：删除或薄化 TS semantic mapper。
8. 删除 TS residue：物理删除已替代文件/分支，更新 docs 与验证矩阵。

## 完成定义

- Rust `HubPipelineEngine` 是 Hub Pipeline 调用顺序与业务语义唯一真源。
- TS Hub Pipeline 只剩 NAPI / Node runtime glue。
- 所有已替代 TS semantic residue 已删除。
- Red/deletion gate、Rust tests、NAPI coverage、Hub matrix 全绿。
- `docs/hubpipeline-rust-boundary.md` 与审计文档同步更新。

## 进度记录

### 2026-05-31

- 已新增 Rust `hub_pipeline_lib` 骨架：`HubPipelineEngine`、typed request/result/config、`HubPipelineEffectPlan`、diagnostics、stage catalog。
- 已新增 NAPI 总入口：`executeHubPipelineJson`。
- 已新增 TS fail-fast wrapper：`executeHubPipelineWithNative`，并加入 `native-router-hotpath-required-exports.ts` required gate。
- 当前刻意未切 TS `HubPipeline.execute()` 主链；下一步需把 Rust engine 从 normalize skeleton 扩到 req path stage 调度，再切入口，避免半成品总入口形成第二运行路径。
- 验证：`cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi hub_pipeline_lib -- --nocapture` 通过；`npm run build`（`sharedmodule/llmswitch-core`）通过。
- 已新增 req path red gate：Rust lib engine 必须调用 Rust `parse_format_envelope` 与 `build_format_request`，不得通过 TS req stage shell；实现后 red gate 5/5 通过，Rust `hub_pipeline_lib` 3/3 通过，`sharedmodule/llmswitch-core` build 通过。
- 已把 req path semantic lift + route select 接入 Rust engine：engine 调用 Rust `apply_req_inbound_semantic_lift` 与 `apply_route_selection`，并对缺失 `config.virtualRouter.target` fail-fast；验证 red gate 5/5、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 req outbound compat 接入 Rust engine：engine 调用 Rust `run_req_outbound_stage3_compat`，adapter context 从 Rust route metadata 构建，payload 输出使用 compat result；验证 red gate 5/5、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 req outbound context merge 接入 Rust engine：engine 调用 Rust `apply_req_outbound_context_snapshot` 并记录 `ReqOutboundContextMerge`，从 route metadata snapshot 合并 `toolOutputs`/`tools`；验证 red gate 5/5、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 req inbound context capture 接入 Rust engine：engine 对 `openai-responses` 调用 Rust `capture_req_inbound_responses_context_snapshot`，并把 snapshot 写入 route metadata 供 outbound merge 消费；验证 red gate 5/5、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- root `npm run build` 当前仍被既有 llmswitch rustification baseline audit 阻断（new TS file `native-hub-pipeline-orchestration-semantics-semantic-gate.ts` / nonNativeLoc baseline），不是本阶段 Rust lib req path 改动引入。
