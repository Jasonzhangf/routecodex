# HubPipeline Rust Closeout Master Plan

**日期**: 2026-05-31  
**状态**: 历史参考；当前执行以 `docs/goals/hubpipeline-full-rust-closeout-plan.md` 为准
**目标路径**: `HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`

## 1. 目标与验收标准

### 主目标

把 RouteCodex Hub Pipeline 从当前的“TS 编排 + Rust native 函数群”收口为“Rust 总控 API + TS 最薄调用壳”。Hub Pipeline / Chat Process / req_process / resp_process / servertool followup orchestration 的业务语义、判定、修复、兼容、sanitize、tool list 注入与裁剪，唯一真源必须在 Rust。

### 验收标准

- Rust 提供稳定总控 API，TS 入口只负责 JSON serialize/deserialize、NAPI 调用、Node stream/HTTP/FS/provider runtime side effect glue。
- P0/P1 TS 语义残留完成收口：stage index 不再承载 payload/tool/route/metadata 语义判断。
- 每个迁移 slice 先有 HTTP blackbox 或等价 blackbox harness 红测，再改代码，最后红转绿。
- 禁止 fallback/降级/双路径补偿；旧 TS 语义迁出后必须物理删除，不保留“以防万一”重复实现。
- 定向 Jest/Rust 测试、native build、dev build、全局安装、restart smoke 均有证据。

## 2. 当前审计结论

### 已完成基础

- P0 fallback 清单已处理：`repairIncompleteToolCalls`、`fallbackId`、`build_request_js_fallback` 已物理删除。
- `sharedmodule/llmswitch-core/config/rustification-audit-current.json` 显示非 native LOC 从 baseline `58012` 降到当前 `56942`。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs` 已是薄 Rust 主文件，负责基础 struct、metadata 编排、NAPI function 群 re-export。
- `lib.rs` 已声明大量 Hub/Rust 模块，包含 `hub_pipeline`、`hub_pipeline_blocks`、`req_process_stage1_tool_governance`、`resp_process_stage1_tool_governance`、`resp_process_stage2_finalize`、`hub_req_*`、`hub_resp_*`、`chat_*`、`servertool_*` 等。

### 最大架构缺口

当前缺口不是“没有 Rust 函数”，而是“缺 Rust-owned 运行时总控”。旧 stage wrapper/API 已在后续 Phase 8E-2 删除；当前入口必须保持在 total HubPipeline path，不得复活 stage-level wrapper。

目标形态必须变成：

```text
TS HubPipeline shell
  -> serialize input
  -> executeHubPipelineJson / runHubPipelineLibJson
  -> execute returned EffectPlan only
  -> deserialize output
```

禁止形态：

```text
TS stage/orchestrator
  -> decide semantic branch
  -> call several native helpers
  -> merge metadata / repair payload / strip tool list
```

## 3. 范围与边界

### In Scope

- Rust 总控 API：`router-hotpath-napi/src/hub_pipeline_lib.rs` 或同等模块。
- Hub Pipeline TS shell 收缩：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`。
- Stage index 收缩：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/**/index.ts`。
- req_process / resp_process / chat_process / servertool followup orchestration 语义迁 Rust。
- operation-table / semantic-mappers / format-adapters 中协议语义最终收归 Rust mapper registry。
- 黑盒红测、Rust unit、Jest regression、build/restart smoke。

### Out of Scope

- Provider runtime transport/auth/retry 实现重写。
- Virtual Router selection policy 语义改动，除非红测证明是 Hub Pipeline Rust 化阻塞。
- Direct passthrough 换壳转换；direct path 必须保持 provider passthrough + hooks。
- 新增 TS 功能代码；TS 只能减薄。

## 4. 设计原则

1. **Rust 总控先行**：先补总控 API，再按模块把 TS 语义迁入 Rust，避免继续增加 native helper 碎片。
2. **一个模块一个闭环**：每个 slice 都必须红测 -> Rust 实现 -> TS 物理删除/退化 -> 绿测 -> build。
3. **EffectPlan 边界**：TS 可执行外部副作用，但不得决定语义；Rust 返回 `EffectPlan`，TS 只按 plan 调用 HTTP/FS/provider/servertool glue。
4. **无 fallback**：Rust path 失败必须显式错误；禁止 TS fallback 到旧实现。
5. **唯一真源**：迁出后旧 TS 语义必须删除，不允许并存双实现。
6. **黑盒优先**：涉及 HTTP入口、route、tool、servertool、stream 的行为必须有黑盒红测覆盖。

## 5. Rust 总控 API 设计

### 5.1 API 模块

历史计划曾建议新增/补齐：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib_types.rs`（可选，若类型膨胀）
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_effects.rs`（可选，effect plan 独立）

### 5.2 NAPI 函数

当前允许的 total entry 导出：

```rust
#[napi(js_name = "runHubPipelineLibJson")]
pub fn run_hub_pipeline_lib_json(input_json: String) -> NapiResult<String>

#[napi(js_name = "executeHubPipelineJson")]
pub fn execute_hub_pipeline_json(input_json: String) -> NapiResult<String>
```

禁止恢复 stage-level wrapper/export。关键是 TS 不再自己串联多个语义 helper，运行时主线必须进入 total HubPipeline entry。

### 5.3 输入 contract

`HubPipelineLibInput`：

- `requestId`
- `entryEndpoint`
- `targetEndpoint`
- `providerProtocol`
- `clientProtocol`
- `payload`
- `metadata`
- `stage`
- `direction`
- `streamIntent`
- `adapterContext`
- `runtimeCapabilities`
- `sideEffectState`（仅传入必要状态，不执行副作用）

### 5.4 输出 contract

`HubPipelineLibOutput`：

- `payload`
- `metadata`
- `nodeResults`
- `stageRecords`
- `diagnostics`
- `routeDecisionInput`
- `effectPlan[]`
- `error`（fail-fast structured error）

### 5.5 EffectPlan contract

TS 可执行的 effect 类型：

- `persistSnapshot`
- `captureConversation`
- `recordStageTiming`
- `invokeProvider`
- `runServerTool`
- `dispatchClientInject`
- `reenterPipeline`
- `writeSessionStore`

Rust 决定“要做什么以及为什么”；TS 只执行 effect，不改变 payload/tool/route 语义。

## 6. P0/P1 Closeout Slices

### Slice 0：总控 API 基座

目标：补齐 `hub_pipeline_lib` API 和 TS wrapper，先不大规模迁语义。

改动范围：

- Rust：`hub_pipeline_lib.rs`、`lib.rs` module/export wiring。
- TS wrapper：`src/native/router-hotpath/native-hub-pipeline-lib.ts` 或相邻 native wrapper。
- Tests：contract/unit tests。

验收：

- `runHubPipelineLibJson` 可处理当前最小 request/response stage input。
- TS wrapper 只做 JSON bridge 和 required export 检查。
- 不引入 fallback。

### Slice 1：resp_process.stage3 servertool orchestration（P0）

目标：把 servertool response orchestration 主线迁入 Rust plan。

当前残留：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`

目标形态：

```text
resp_process.stage3/index.ts
  -> total HubPipeline entry returns Rust-owned EffectPlan
  -> execute EffectPlan side effects only
  -> return Rust-produced payload/metadata/nodeResults
```

黑盒红测：

- `/v1/responses` tool_call -> servertool -> followup / reentry 正常。
- mixed tool calls 不被 TS 重新判定。
- stop_message / clientInjectOnly / backendInvoke 分支由 Rust plan 决定。
- 架构红测：stage3 不得 import/call `runServerToolOrchestration`。

删除/退化：

- TS stage3 只保留 wrapper + effect executor。
- 旧 TS orchestration 判定必须物理移除或移动到 Node side-effect executor（无语义）。

### Slice 2：req_process.stage1 tool governance 后处理（P0）

目标：TS 不再决定 tool 注入、web_search/servertool/builtin 工具治理。

当前残留：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts`

目标形态：

- Rust 返回完整 governed request + metadata + nodeResults。
- TS 只调用 native stage entry。

黑盒红测：

- 工具声明不触发 coding/web_search。
- read/update_plan/search 不继承历史 coding。
- 当前轮写操作才命中 coding。
- servertool/web_search/tool list 注入由 Rust 输出，TS 不可二次补偿。

### Slice 3：resp_process.stage2 finalize ProcessedRequest 组装（P0）

目标：`ProcessedRequest` 定义与组装迁 Rust。

当前残留：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts`
- `buildProcessedRequestFromChatResponse(...)` TS 组装。

目标形态：

- Rust finalize 返回完整 processed response/request envelope。
- TS 不再构造 `ProcessedRequest`。

黑盒红测：

- tool_calls finish_reason 保持。
- executed servertool calls strip 结果一致。
- Responses/Chat/Anthropic output shape 保持。

### Slice 4：hub-pipeline normalize-request 总控（P1，但本轮一起做）

目标：`hub-pipeline-normalize-request.ts` 语义迁 Rust 总控。

当前残留：

- `entryEndpoint`
- `providerProtocol`
- `processMode`
- `routeHint`
- `stream/shadowCompare`
- `clientConnectionState` 相关 semantic snapshot

目标形态：

- TS 只读取 Node runtime 输入，交给 Rust normalize。
- Rust 返回 normalized pipeline input + metadata + diagnostics。

黑盒红测：

- `/v1/responses` 和 `/v1/chat/completions` entryEndpoint/providerProtocol 正确。
- direct passthrough 不进入 conversion/chat-process/servertool。
- malformed protocol fail-fast，不走 TS fallback。

### Slice 5：operation-table / semantic-mappers / format-adapters（P1）

目标：协议语义映射迁入 Rust mapper registry。

当前残留：

- `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts`

目标形态：

- Rust mapper registry 根据 protocol/stage 执行 semantic map。
- TS adapter 只保留 type export 或删除。

黑盒红测：

- Chat -> Anthropic/Gemini/OpenAI payload 等价。
- Responses submit_tool_outputs id 不伪造。
- Provider-specific 差异不得进入 Hub/VR 通用层。

## 7. 黑盒红测矩阵

| 类别 | 测试入口 | 必须断言 |
|---|---|---|
| HTTP request routing | `/v1/responses` / `/v1/chat/completions` | status/body/log/stageRecords |
| req_process governance | HTTP blackbox + fake provider | 当前轮写操作命中 coding；read/search/update_plan 不继承历史 coding |
| tool declaration | HTTP blackbox | 工具声明不触发 coding/web_search |
| servertool orchestration | HTTP blackbox + fake tool/provider | Rust plan 决定 servertool/followup/reentry |
| response finalize | HTTP blackbox | tool_calls finish_reason 与 ProcessedRequest shape 稳定 |
| direct passthrough | HTTP blackbox | direct 不进入 conversion/chat-process/servertool |
| mapper parity | fixture/replay blackbox harness | before/after payload 等价 |
| architecture gate | static test | stage index 不 import 旧 TS orchestrator / semantic mapper |

## 8. 实施顺序

1. 新增总控 API contract 文档与 Rust struct。
2. 新增 `runHubPipelineLibJson` 最小可运行版本，TS wrapper 接入测试。
3. 为所有 P0/P1 slice 先补黑盒红测和架构红测，确认至少关键红测在旧路径下失败。
4. Slice 1：servertool orchestration Rust plan 化，TS stage3 退化。
5. Slice 2：req_process.stage1 后处理迁 Rust，TS stage1 退化。
6. Slice 3：resp_process.stage2 `ProcessedRequest` 组装迁 Rust。
7. Slice 4：normalize-request 总控迁 Rust。
8. Slice 5：operation-table/mapper/adapter 迁 Rust registry。
9. 删除旧 TS 语义实现与 imports，更新 docs/memory/skills。
10. 跑验证矩阵，dev build，全局安装，`routecodex restart --port 5555`，真实 smoke。

## 9. 风险与规避

| 风险 | 规避 |
|---|---|
| 总控 API 一次过大 | 先 stage-level API，再合并 full pipeline API |
| TS effect executor 偷回语义 | EffectPlan schema 明确：TS 只能执行，不可改 payload/metadata/tool semantics |
| mapper 迁移破坏 payload shape | 使用 replay fixture 和 JSON 等价断言 |
| servertool orchestration 牵涉副作用 | Rust 只返回 plan，TS 执行副作用；结果再回 Rust finalize |
| 黑盒红测不稳定 | fake provider/fake tool 固定输入输出，断言 HTTP body/log/stage records |

## 10. 验证命令建议

### Rust

```bash
cd sharedmodule/llmswitch-core/rust-core
cargo test -p router-hotpath-napi hub_pipeline -- --nocapture
cargo test -p router-hotpath-napi req_process -- --nocapture
cargo test -p router-hotpath-napi resp_process -- --nocapture
```

### Jest 定向

```bash
pnpm run jest:run -- tests/server/handlers/<new-blackbox>.spec.ts --no-coverage
pnpm run jest:run -- tests/servertool/resp-process-stage3-reentry.spec.ts --no-coverage
pnpm run jest:run -- tests/servertool/servertool-mixed-tools.spec.ts --no-coverage
pnpm run jest:run -- tests/servertool/stop-message-auto.spec.ts --no-coverage
```

### Build / install / restart

```bash
pnpm -C sharedmodule/llmswitch-core run build
pnpm run build:dev
pnpm run install:global
routecodex restart --port 5555
```

## 11. 完成定义（DoD）

- `executeHubPipelineJson` / `runHubPipelineLibJson` 是 Hub Pipeline total entry；legacy stage wrapper/export 不得复活。
- P0/P1 TS stage/index/orchestrator 文件只剩 wrapper/effect executor/Node glue。
- 旧 TS 语义实现、重复 mapper、fallback 分支物理删除。
- 黑盒红测先红后绿证据完整。
- Rust/Jest/build/install/restart/live smoke 通过。
- `MEMORY.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、相关 docs 更新。

## 12. 关联文档

- `docs/audit/hub-pipeline-rust-lib-analysis-2026-05-31.md`
- `docs/hubpipeline-migration/CLOSEOUT-PLAN-2026-05-21.md`
- `docs/goals/hubpipeline-rust-block-library-refactor-plan.md`
- `docs/goals/hubpipeline-rust-mainfile-closeout-checklist.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`
- `docs/hubpipeline-rust-boundary.md`
