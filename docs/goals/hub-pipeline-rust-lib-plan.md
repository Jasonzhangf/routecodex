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
- 已把 req_process tool governance 接入 Rust engine：engine 调用 Rust `apply_req_process_tool_governance`，route stage 消费 governed `processed_request`；验证 red gate 5/5、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 resp inbound format parse 接入 Rust engine：`direction == "response"` 分支调用 Rust `parse_resp_format_envelope` 并记录 `RespInboundFormatParse`；验证 red gate 6/6、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 resp_process finalize 接入 Rust engine：response path 调用 Rust `finalize_chat_response` 并记录 `RespProcessFinalize`，输出 finalized payload；验证 red gate 6/6、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 resp_process tool governance 接入 Rust engine：response path 调用 Rust `govern_response` 并记录 `RespProcessToolGovernance`，governed payload 再进入 Rust finalize；验证 red gate 6/6、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 resp outbound client remap 接入 Rust engine：response path 对 `openai-chat`/`anthropic-messages`/`openai-responses` 调用 Rust client semantics builders 并记录 `RespOutboundClientRemap`；验证 red gate 6/6、Rust `hub_pipeline_lib` 3/3、`sharedmodule/llmswitch-core` build 均通过。
- 已把 resp outbound SSE stream decision 接入 Rust engine：response path 在 client remap 后调用 Rust `process_sse_stream` 并记录 `RespOutboundSseStream`；未知/缺失 client protocol fail-fast，TS 后续只保留 SSE 编码副作用；验证 red gate 6/6、Rust `hub_pipeline_lib` 3/3、Rust `hub_resp_outbound_sse_stream` 15/15、`sharedmodule/llmswitch-core` build 均通过。
- 已把 response stream 输出计划纳入 Rust `effectPlan`：流式响应返回 `StreamPipe` effect（codec/requestId/payload/body），非流式保持空 effect plan，为 TS 退化成 stream codec 副作用执行器铺路；验证 red gate 6/6、Rust `hub_pipeline_lib` 4/4、`sharedmodule/llmswitch-core` build 均通过。
- 已把 TS `resp_outbound_stage2_sse_stream` 收缩为 Rust effect executor：新增 Rust `plan_sse_stream_effect_json`，TS 只消费 `streamPipe` effect 并执行 SSE codec 编码；移除 TS stream decision / protocol normalization，未知 protocol fail-fast；验证 residue+monitoring 27/27、Rust SSE 15/15、Rust lib 4/4、`build-core`、`sharedmodule/llmswitch-core` build 均通过。
- 已开始把 provider-response 主链接入 Rust total entry：非 servertool/runtime-side-effect 路径执行 `executeHubPipelineWithNative` 并把 `effectPlan`/diagnostics 存到 `context.__nativeResponsePlan`；有 providerInvoker/reenter/clientInject 或 servertool/clock/webSearch runtime 标记的路径暂不 probe，避免绕过 TS 副作用执行；验证 residue+monitoring 28/28、Rust lib 4/4、`sharedmodule/llmswitch-core` build 通过。
- 已让 provider-response 无副作用路径消费 Rust native response plan：有 `nativeResponsePlan` 时直接执行 `executeProviderResponseNativeOutboundEffects`，非流式返回 Rust payload，流式只执行 `streamPipe` SSE codec 副作用，跳过 TS client remap/SSE decision；新增黑盒 `provider-response-rust-plan`，验证 29/29、Rust lib 4/4、`sharedmodule/llmswitch-core` build 通过。
- root `npm run build` 当前仍被既有 llmswitch rustification baseline audit 阻断（new TS file `native-hub-pipeline-orchestration-semantics-semantic-gate.ts` / nonNativeLoc baseline），不是本阶段 Rust lib req path 改动引入。
- 2026-05-31 stage: provider-response streaming native plan 黑盒加固。新增 `provider-response-rust-plan.spec.ts` 流式用例：`wantsStream=true` 时要求 `context.__nativeResponsePlan.effectPlan.effects[0].kind === streamPipe`，payload/requestId/codec 与 Rust plan 一致，并实际读取 `__sse_responses` 验证 SSE bytes 包含 `data:`、正文与 `[DONE]`。验证：`npm run jest:run -- --runTestsByPath tests/sharedmodule/provider-response-rust-plan.spec.ts --runInBand --forceExit` 2/2 passed；首次不带 `--forceExit` 业务通过但 Jest open handle 挂起，已只终止明确 PID 87514。
- 2026-05-31 stage: provider-response runtime side-effect plan 初步接入 Rust effect plan。Rust `HubPipelineEngine` response path 现在除 `streamPipe` 外总是发 `runtimeStateWrite`，payload 包含 `requestId`、`clientProtocol`、client payload、usage、`keepForSubmitToolOutputs` 与 openai-responses responseRecord；TS native path 不再假设单 effect，只按 kind fail-fast 执行：`streamPipe` 做 SSE codec，`runtimeStateWrite` 做 conversation retention/response record/clock commit/session usage 等 Node runtime 副作用。验证：provider-response rust plan 2/2 passed；Rust `hub_pipeline_lib` 4/4 passed；已重建 native binding `node scripts/build-core.mjs`。
- 2026-05-31 stage: provider-response clock runtime guard 收缩。新增黑盒 `does not bypass Rust native response plan for clock runtime metadata`：`__rt.clock` 存在时仍必须产生 `context.__nativeResponsePlan` 与 `runtimeStateWrite`，只由 TS 执行 clock/runtime state 副作用；`shouldRunProviderResponseRustHubPipeline` 不再因 `runtime.clock` 退回 TS resp_process。Residue gate 禁止重新出现 `runtime.clock` guard。验证：provider-response rust plan + residue + resp outbound monitoring 31/31 passed；Rust `hub_pipeline_lib` 4/4 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response webSearch config guard 收缩。新增黑盒 `does not bypass Rust native response plan for webSearch runtime config without executors`：仅有 `__rt.webSearch` 配置但无 provider/servertool callbacks 时仍走 Rust `executeHubPipelineWithNative` 并产出 `runtimeStateWrite`；保留 `providerInvoker/reenterPipeline/clientInjectDispatch` 与 `serverToolFollowup/servertool` guard，避免绕过实际工具执行副作用。Residue gate 禁止重新出现 `runtime.webSearch` guard。验证：provider-response rust plan + residue + resp outbound monitoring 32/32 passed；Rust `hub_pipeline_lib` 4/4 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response executor callback guard 改为 Rust stop-gateway payload 感知。新增黑盒：callbacks 存在但 response `finish_reason=length`/无工具动作时必须仍走 Rust native response plan；stop-eligible callback path 仍不得走 native plan，防止绕过 servertool followup。实现 `shouldRunProviderResponseRustHubPipeline` 调用 Rust `inspectStopGatewaySignalWithNative`，只在 `eligible`/tool calls/required_action 或未观测时保留 TS servertool path。验证：provider-response rust plan + residue + resp outbound monitoring 34/34 passed；Rust `hub_pipeline_lib` 4/4 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response servertool stop followup fail-fast 接入 Rust effect plan。Rust `HubPipelineEngine` 在 `runtimeEffects` 有执行器且 stop-gateway eligible 时发 `servertoolRuntimeAction { action: requireReenterPipeline, reason: stop_eligible_followup }`；TS native path 支持该 effect 并 fail-fast 抛 `ProviderProtocolError(SERVERTOOL_FOLLOWUP_FAILED)`，不再先进入 TS `runRespProcessStage3ServerToolOrchestration` 才发现缺 reenter。新增 Rust unit 与黑盒；residue gate 要求 `servertoolRuntimeAction`/`executeProviderResponseNativeServertoolEffects`。验证：provider-response rust plan + residue + resp outbound monitoring 36/36 passed；Rust `hub_pipeline_lib` 5/5 passed；`sharedmodule/llmswitch-core npm run build` passed；`node scripts/build-core.mjs` 已重建 native binding。
- 2026-05-31 stage: provider-response inert `runtime.servertool` guard 收缩。新增黑盒 `does not bypass Rust native response plan for inert servertool runtime config`：仅有 `__rt.servertool` 配置但无 followup/工具动作时必须仍走 Rust native response plan 并产出 `runtimeStateWrite`；`shouldRunProviderResponseRustHubPipeline` 只保留 `serverToolFollowup` 阻断。Residue gate 禁止重新出现 `runtime.servertool` guard。验证：provider-response rust plan + residue + resp outbound monitoring 35/35 passed；Rust `hub_pipeline_lib` 5/5 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response inert `serverToolFollowup` guard 移除。新增黑盒 `does not bypass Rust native response plan for inert serverToolFollowup metadata`：followup metadata 存在但 response 无工具/stop 动作时必须走 Rust native response plan 并产出 `runtimeStateWrite`；`shouldRunProviderResponseRustHubPipeline` 不再按 `runtime.serverToolFollowup` 粗暴阻断，只在 callbacks 存在且 Rust stop-gateway 未观测时保留 TS path。Residue gate 禁止重新出现 `runtime.serverToolFollowup` guard。验证：provider-response rust plan + residue + resp outbound monitoring 36/36 passed；Rust `hub_pipeline_lib` 5/5 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response tool_call callback path 接入 Rust `servertoolRuntimeAction` effect。新增黑盒：callbacks 存在且 response 带 `tool_calls` 时不得普通返回 client payload，必须产出 `servertoolRuntimeAction { action: requireRuntimeExecutor, reason: tool_call_dispatch }` 并由 TS effect executor fail-fast；Rust engine 新增 `response_has_tool_calls` 与 unit `response_tool_call_with_runtime_callbacks_returns_servertool_executor_effect_plan`。验证：provider-response rust plan + residue + resp outbound monitoring 37/37 passed；Rust `hub_pipeline_lib` 6/6 passed；`sharedmodule/llmswitch-core npm run build` passed；`node scripts/build-core.mjs` 已重建 native binding。
- 2026-05-31 stage: provider-response unobservable callback shape fail-fast。新增黑盒 `fails fast instead of falling back to TS path when callback response shape is not Rust-observable`：callbacks 存在且 provider response 不是 Rust 可观测 OpenAI chat shape 时，禁止回 TS path，必须由 Rust response path fail-fast。实现：Rust `parse_openai_chat_response` 校验 object + 非空 `choices` array；未知 response protocol 删除 generic envelope fallback；`execute_hub_pipeline_json` 把 engine execution error 序列化为 `success:false + error`，让 TS native wrapper 保持 response-path error 面。Residue gate 禁止 `return false;` 重新进入 `shouldRunProviderResponseRustHubPipeline`。验证：provider-response rust plan + residue + resp outbound monitoring 38/38 passed；Rust `hub_resp_inbound_format_parse` 13/13 passed；Rust `hub_pipeline_lib` 7/7 passed；`node scripts/build-core.mjs` 与 `sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response TS semantic residue physical deletion。`convertProviderResponse` 不再存在 `shouldRunProviderResponseRustHubPipeline` 或旧 TS resp pipeline fallback，直接调用 Rust `executeHubPipelineWithNative` 并执行 native `effectPlan`；物理删除 TS resp inbound semantic map / resp_process governance/finalize/servertool orchestration / resp outbound remap 旧路径与 response mapper registry 引用。Residue gate 先红后绿，禁止上述 TS stage import/调用重新出现。验证：provider-response rust plan + residue + resp outbound monitoring 38/38 passed；Rust `hub_pipeline_lib` 7/7 passed；`sharedmodule/llmswitch-core npm run build` passed。
- 2026-05-31 stage: provider-response helper mapper/canonicalization residue deletion。`provider-response-helpers.ts` 仅保留 native context signal 解析与 clock reservation side effect glue；物理删除 `response-mappers` type import、`ProviderResponsePlan`、`normalizeClientPayloadToCanonicalChatCompletionOrThrow`、TS shape detection/canonicalization/business-error parser。Residue gate 先红后绿，禁止 helper 重新引入 TS response mapper/canonicalization。验证：provider-response rust plan + residue + resp outbound monitoring 39/39 passed；Rust `hub_pipeline_lib` 7/7 passed；`sharedmodule/llmswitch-core npm run build` passed。
