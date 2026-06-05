# Responses Request Compat Rustification Plan

## 目标

把 `responses:c4m` / `responses:crs` 的 request compat、`instructions -> input` 重建、chat-style function tool normalization 全部锁定在 Rust `req_outbound_stage3_compat`，禁止在 TS runtime / provider / server 主链再长出第二份真相。

核心 contract：

- `responses:c4m` 负责：
  - 删除 `max_tokens/maxTokens/max_output_tokens/maxOutputTokens`
  - 将 `instructions` 转成首条 system `input_text`
  - 归一 chat-style function tools 为 Responses wire `type=function + top-level name + parameters`
  - 将 string / invalid `parameters` 归一成 object schema
- `responses:crs` 负责：
  - 删除 `temperature`
  - 归一 chat-style function tools 为 Responses wire
  - 将 string / invalid `parameters` 归一成 object schema
- 所有上述 compat 语义只能通过 Rust `runReqOutboundStage3CompatJson` 执行

## 当前真相

Rust 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs`

TS 允许存在的仅是 bridge / orchestration：

- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts`

## 收口规则

1. `responses:c4m` / `responses:crs` 的字段删改与工具归一只能在 Rust stage3 compat 实现。
2. TS 不得在 `src/providers/*`、`src/server/*`、`src/modules/llmswitch/*` 里重做：
   - `instructions -> input`
   - `max_tokens/max_output_tokens` 删改
   - `temperature` 删改
   - chat-style `tools[].function.name -> tool.name`
   - string / invalid `tool.parameters -> object schema`
3. TS 可保留：
   - native export required list
   - napi bridge / parse / orchestration shell
   - compat profile registry 与 profile id 解析

## 必备 gate

- `npm run verify:responses-request-compat-rust-only`
- `npm run verify:architecture-ci`

## 删除完成判据

满足以下条件才允许宣称这条线已 closeout：

1. request compat 真相只在 Rust `req_outbound_stage3_compat` 持有
2. TS 仅剩 `runReqOutboundStage3CompatJson` bridge / orchestration 壳
3. function-map / verification-map 可定位唯一 owner、canonical builders、required tests、required gates
4. 针对 `responses:c4m` / `responses:crs` 的 Rust 测试和 architecture gate 全绿

## 已拆出的共享 closeout 单元

- `responses.function_tool_normalization`
- `responses.tool_parameters_normalization`
- `responses.instructions_to_input_normalization`
- `responses.token_limit_field_normalization`
