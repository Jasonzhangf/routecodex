# Hub Pipeline Shared Library Simplification Plan

## 目标与验收标准

目标：在不改功能、不裁剪真实 payload、不引入 fallback 的前提下，审计并收口 Hub Pipeline / bridge / Rust hotpath 周边重复实现，把共享语义下沉到唯一函数库或 block owner，让编排层只负责编排，TS host bridge 只保留 IO、native-call、MetadataCenter commit 等薄壳职责。

验收标准：
- 完成重复实现审计，输出每个候选项的 owner、允许路径、禁止路径、是否可收口、验证 gate。
- 新增或复用共享函数库，物理删除已确认重复 helper / wrapper / DTO / local invoker。
- Hub Pipeline / Chat Process / servertool followup / tool governance 语义仍以 Rust 为唯一真源。
- TS 不新增功能语义，只允许 host IO、native NAPI 调用壳、请求级 side-channel commit。
- 每个收口 slice 都有红测或 architecture gate 证明重复实现会被拦住。
- 验证通过后同步 function map、mainline call map、verification map、wiki/manifest、note/MEMORY。

## 范围与边界

## In Scope

- `src/modules/llmswitch/bridge/**` 中重复 native JSON invoker、local wrapper、JSON stringify/parse/record assert helper。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**` 中重复 XML/CDATA/JSON scan/tool canonicalization/tool args helper。
- Hub Pipeline / req_chatprocess / resp_chatprocess / servertool followup 周边大文件的 “shared functions -> blocks -> orchestration” 结构化收口。
- 对应 function map、mainline call map、verification map、architecture gate、red fixture、package script。

## Out of Scope

- 不改 provider runtime 协议差异。
- 不改 Virtual Router selection / health / quota 策略。
- 不做 direct passthrough 壳转换或 response conversion 重入。
- 不做运行时功能新增、payload 语义裁剪、fallback/兼容双路径。
- 不把 Rust 语义迁回 TS。

## 设计原则

1. 唯一 owner：同一 helper / wrapper / canonicalization 只允许一个 owning module。
2. 函数库优先：新增 helper 前先查现有 shared module；可复用则下沉，不在编排层局部复制。
3. Rust 语义真源：Hub Pipeline / Chat Process / servertool followup 的语义判定只在 Rust；TS 只做薄壳。
4. 相邻边界：请求链、响应链、错误链只允许相邻节点转换；禁止 shortcut 和同义 DTO。
5. 红测先行：每个 slice 先加 failing fixture / architecture deny gate，再重构到绿。
6. 物理删除：确认重复实现后删除旧 helper，不保留 idle 代码或注释备用。

## 技术方案

## Slice A: TS Host Bridge Native JSON Invoker Singleton

目标：把 TS bridge 中重复的 native binding lookup、JSON.stringify、native call、JSON.parse、record/array assert 统一到一个 host bridge helper。

候选 owner：
- `src/modules/llmswitch/bridge/native-json-invoker.ts`

候选收口文件：
- `src/modules/llmswitch/bridge/provider-response-converter-host.ts`
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `src/modules/llmswitch/bridge/snapshot-recorder.ts`
- `src/modules/llmswitch/bridge/config-integrations.ts`
- `src/modules/llmswitch/bridge/native-exports.ts`

要求：
- helper 只处理 host/native JSON call mechanics，不承载 provider、routing、pipeline 业务语义。
- missing native function、empty invalid output、native error object、stringify/parse failure 必须 fail-fast。
- 支持 raw string arg、pre-encoded arg、void return、object/array assert。
- snapshot 当前特殊行为必须显式建模或延后，不允许靠 fallback 保持表面绿。

需要新增 gate：
- `scripts/architecture/verify-hub-bridge-native-json-invoker-singleton.mjs`
- `scripts/tests/hub-bridge-native-json-invoker-singleton-red-fixtures.mjs`
- `package.json` scripts:
  - `verify:hub-bridge-native-json-invoker-singleton`
  - `test:hub-bridge-native-json-invoker-singleton-red-fixtures`

## Slice B: Rust Shared Helper Closeout

### Slice B1: Rust NAPI JSON Wrapper Helper

目标：收口 `router-hotpath-napi/src/lib.rs` 中重复的 `serde_json::from_str -> call -> serde_json::to_string -> NapiResult` 包装。

候选 owner：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/napi_json.rs`

要求：
- 只统一 parse/serialize/error projection mechanics。
- 不改变 public NAPI capability 名称。
- 不改变 builder/facade 语义，不合并 feature owner。
- 不把 payload 语义、provider 差异、routing/tool governance 判断塞进 helper。

需要新增 gate：
- `scripts/architecture/verify-rust-napi-json-wrapper-helper.mjs`
- `scripts/tests/rust-napi-json-wrapper-helper-red-fixtures.mjs`
- package scripts:
  - `verify:rust-napi-json-wrapper-helper`
  - `test:rust-napi-json-wrapper-helper-red-fixtures`
- focused Rust test:
  - `npm run test:rust-napi-json-wrapper-helper-cargo`

## Slice B2: Rust Shared Helper Closeout

目标：收口 Rust hotpath 周边重复 XML / CDATA / JSON scan / tool name canonicalization / args mapping helper。

优先归宿：
- `shared_json_utils.rs`
- `shared_tooling.rs`
- `shared_tool_mapping.rs`
- `shared_args_mapping.rs`

候选来源：
- `hub_reasoning_tool_normalizer.rs`
- `hub_text_markup_normalizer.rs`
- `tool_harvester.rs`
- `streaming_tool_extractor.rs`
- `hub_bridge_actions/history.rs`

要求：
- shared module 只接纯函数；带 stage context、payload mutation、tool governance 决策的逻辑留在对应 block。
- tool canonical name / alias 只保留一个真源。
- 迁移前后用 fixture 证明 JSON shape / tool call semantics 等价。

## Slice C: Hub Pipeline Blocks And Orchestration Slimming

目标：把大文件按 block owner 拆成 “shared helper + stage block + orchestrator”，不改变 NAPI public JSON contract。

候选 block：
- `servertool_core_blocks.rs` JSON parse/stringify bridge wrappers
- `hub_pipeline_lib/engine.rs`
- `resp_process_stage1_tool_governance/harvest.rs`
- `resp_process_stage1_tool_governance/apply_patch.rs`
- `resp_process_stage1_tool_governance/display.rs`
- `resp_process_stage1_tool_governance/exec_shape.rs`
- `req_process_stage1_tool_governance/apply_patch_schema.rs`
- `req_process_stage1_tool_governance/servertool_orchestration.rs`
- `hub_pipeline/metadata.rs`
- `hub_pipeline/passthrough.rs`
- `hub_pipeline/responses_resume.rs`
- `hub_pipeline/stop_message.rs`
- `hub_pipeline/sse_mode.rs`
- `hub_resp_outbound_client_semantics/openai_chat.rs`
- `hub_resp_outbound_client_semantics/openai_responses.rs`
- `hub_resp_outbound_client_semantics/anthropic.rs`

要求：
- root stage 文件只保留 orchestrator、public/NAPI entry、error propagation。
- public function 名称和 JSON contract 不变。
- 旧位置重复代码物理删除。

## 风险与规避

- 风险：shared helper 抽象过宽变成新垃圾桶。
  - 规避：只收纯函数；每个 helper 写 owner、调用方和 forbidden duplicate pattern。
- 风险：TS helper 意外承载语义。
  - 规避：gate 禁止 provider / routing / pipeline semantic branch 进入 `native-json-invoker.ts`。
- 风险：搬迁改变 payload shape。
  - 规避：红测 + equivalence fixture + stage public JSON test。
- 风险：并行 worker 冲突。
  - 规避：按 `.agent-collab/PROTOCOL.md` claim `feature_id` / `gate_id`，只改 claim 允许路径。
- 风险：只删代码不锁复活。
  - 规避：每个删除项必须有 architecture gate 或 focused red fixture。

## 测试计划

每个 slice 至少执行：
- 红测：重复 helper / forbidden local wrapper / non-adjacent shortcut 能被 gate 拦住。
- 绿测：对应 focused unit / integration tests。
- 架构 gate：function map、mainline call map、verification map、thin-wrapper、rustification audit。
- Build：`npm run build:base` 或当前项目映射要求的 build gate。
- Diff hygiene：`git diff --check`。

Slice A 最小验证：
- `npm run test:hub-bridge-native-json-invoker-singleton-red-fixtures`
- `npm run verify:hub-bridge-native-json-invoker-singleton`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-thin-wrapper-only`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`
- `git diff --check`

Slice B/C 追加验证：
- Rust focused tests for touched modules。
- `cargo test` / native build gate 按当前 project script 执行。
- 对应 Hub Pipeline req/resp/servertool fixture。
- 必要时真实入口 smoke；仅在 runtime 行为受影响且已有定向测试通过后执行。

## 实施步骤

1. 刷新 MemoryPalace、resource map、function map、mainline call map、verification map、mainline source、`.agent-collab` claim。
2. 为当前 slice 写测试设计和 architecture red fixture，先证明当前重复实现会被拦住。
3. 补 function map / verification map / package script / gate wiring。
4. 实现共享 helper 或 block owner。
5. 替换调用方并物理删除旧 local duplicate。
6. 运行 slice 最小验证栈。
7. 更新 wiki/manifest/map/note/MEMORY/skill 中可复用规则。
8. 进入下一 slice；禁止跨 slice 顺手改无关语义。

## 完成定义

- Hub Pipeline 相关重复 helper / wrapper 有清单、有 owner、有 gate。
- 已收口 slice 的旧 helper 物理删除，复活会红。
- TS host bridge 保持薄壳，不新增 Hub Pipeline 语义。
- Rust shared library / block owner 清晰，orchestrator 不再承载重复 helper。
- function map、mainline call map、verification map、wiki/manifest 与代码一致。
- 所有声明完成项都有命令证据；未完成 slice 明确列出剩余风险。
