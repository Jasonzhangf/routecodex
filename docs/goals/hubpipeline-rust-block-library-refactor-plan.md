# HubPipeline Rust Block/Library Refactor Plan

## 目标与验收标准

目标：把 Rust HubPipeline 相关大文件整理为“通用函数库 + 函数调用 blocks + 纯编排”的结构，保持 Rust-only 语义真源，移除 stage 文件内的职责混杂。

验收标准：
- Hub Pipeline / Chat Process / req_process / resp_process / servertool followup orchestration 的语义只在 Rust。
- stage root 只保留 orchestrator、public/NAPI 入口和错误传播，不承载具体 normalize/harvest/repair 逻辑。
- 通用纯函数沉淀到 shared library；阶段语义沉淀到明确 block。
- 不新增 TS 功能代码，不新增 fallback/双路径/降级逻辑。
- 原有行为通过 red test、目标单测、build、真实入口 smoke 验证。

## 范围与边界

In Scope：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`
- 必要的 `shared_*` Rust helper 模块与 `lib.rs` module wiring。

Out of Scope：
- TS runtime 重写或 TS fallback。
- Provider routing 策略改动。
- apply_patch/servertool 行为语义新增。
- stopless/backoff/quota 独立策略改动，除非现有测试证明受本次结构迁移破坏。

## 设计原则

- Rust-only：Hub Pipeline 语义真源只在 Rust。
- 不猜语义：只搬迁已存在的确定逻辑；不从文本关键词推断用户意图。
- No fallback：迁移后只有一个执行路径；旧重复实现必须物理删除。
- 先红测：每个迁移 block 先补或确认 failing-shape/behavior-preserving 测试，再改代码。
- 最小拆分：按职责边界拆，不为目录漂亮做无意义抽象。

## 技术方案

### 1. 通用函数库

候选模块：
- `shared_json_utils.rs`：JSON object/array/string/bool 读取、safe insert、lenient parse 中与业务无关的部分。
- `shared_tool_args.rs`：tool arguments 的 parse/serialize/shape-preserving normalize 通用逻辑。
- `shared_text_shape_utils.rs`：纯文本 fence/window/marker/preview 处理，不含工具语义判断。

迁移规则：
- 只放无 stage 状态、无 payload mutation 副作用的纯函数。
- 若函数依赖 request/response stage 上下文，不能放 shared，应放 block。

### 2. Response tool governance blocks

建议目录：`resp_process_stage1_tool_governance/`
- `orchestrator.rs`：保留 `govern_response` / `govern_response_json` 主流程。
- `harvest.rs`：text tool call harvest、wrapper harvest、payload text scan。
- `apply_patch.rs`：apply_patch canonical args、line-edit shape、native/fence mask 修形。
- `display.rs`：display text strip、tool markup 清理。
- `exec_shape.rs`：exec command 形状修复，仅修形状不猜语义。
- `payload_prepare.rs`：prepare payload、internal governance state copy/strip。

### 3. Request tool governance blocks

建议目录：`req_process_stage1_tool_governance/`
- `orchestrator.rs`：保留 `apply_req_process_tool_governance` 主流程。
- `apply_patch_schema.rs`：servertool mode 下 provider-facing schema 注入。
- `servertool_orchestration.rs`：clock/servertool bundle plan 与工具注入。
- `marker_sanitizer.rs`：request marker strip。
- `hub_operations.rs`：hub operation application。

### 4. Hub pipeline blocks

建议目录：`hub_pipeline/`
- `orchestrator.rs`：保留 `run_hub_pipeline` 与 stage ordering。
- `metadata.rs`：endpoint/protocol/stream/processMode/direction/stage metadata 构造。
- `passthrough.rs`：passthrough audit 与 skip annotation。
- `responses_resume.rs`：Responses resume/continuation synthesis。
- `stop_message.rs`：stop-message instruction normalization 与 router metadata。
- `sse_mode.rs`：SSE protocol/stream mode resolve。
- `napi_bindings.rs`：JSON NAPI wrappers，薄壳 parse -> call -> serialize。

### 5. Outbound client semantics blocks

建议目录：`hub_resp_outbound_client_semantics/`
- `orchestrator.rs`：client outbound semantics 主编排。
- `openai_chat.rs`
- `openai_responses.rs`
- `anthropic.rs`
- `usage.rs`
- `tool_calls.rs`

## 风险与规避

- 风险：搬迁时改变 payload shape。
  - 规避：迁移前后 snapshot/fixture assert JSON 等价。
- 风险：shared helper 变成新的垃圾桶。
  - 规避：shared 只接收纯函数；带 stage 语义的留在 block。
- 风险：NAPI 导出路径破坏 TS 薄壳。
  - 规避：保持 public function 名称和 JSON contract 不变。
- 风险：测试 helper 引入 fallback 掩盖真实问题。
  - 规避：测试 helper fail-fast，不做兼容桥。

## 测试计划

每个 block 迁移至少覆盖：
- Red test：迁移前定位的 failing-shape 或 behavior fixture。
- Equivalence test：迁移前后同输入 JSON 输出等价。
- Unit test：block 纯函数或 block contract。
- Integration test：对应 stage public JSON function。
- Build：Rust native build / `npm run build:min` 按项目当前门禁执行。
- Live smoke：只打允许的真实入口；不做无界线上压力测试。

重点回归：
- apply_patch canonical args 不泄露旧 schema。
- servertool followup tool_call/result 对齐。
- stop/tool_calls finish_reason 不被结构迁移影响。
- passthrough/direct 只在正确协议路径保持 identity。

## 实施步骤

1. 建立现有行为 fixture 和 red/equivalence tests。
2. 先拆 `resp_process_stage1_tool_governance.rs`：harvest/apply_patch/display/exec_shape/payload_prepare。
3. 再拆 `hub_pipeline.rs`：metadata/passthrough/responses_resume/stop_message/sse_mode/napi_bindings。
4. 再拆 `req_process_stage1_tool_governance.rs`：schema/servertool/marker/hub operations。
5. 最后拆 `hub_resp_outbound_client_semantics.rs`：OpenAI Chat/Responses/Anthropic/tool usage blocks。
6. 每一步删除旧位置重复代码，保持唯一真源。
7. 跑目标测试、build、真实入口 smoke。

## 完成定义

- 目标大文件只剩 orchestrator + stable exports。
- block 文件职责单一，可独立测试。
- shared 库只含纯函数。
- 没有 TS 功能新增、没有 fallback、没有重复语义实现。
- 验证证据完整记录到任务总结。
