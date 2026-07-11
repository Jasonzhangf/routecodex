# Responses Request Compat Rustification Plan

## 目标

把 `responses:crs` request compat、`instructions -> input` 重建、chat-style function tool normalization 全部锁定在 Rust `req_outbound_stage3_compat`，禁止在 TS runtime / provider / server 主链再长出第二份真相。

核心 contract：

- `responses:crs` 负责：
  - 删除 `temperature`
  - 归一 chat-style function tools 为 Responses wire
  - 将 string / invalid `parameters` 归一成 object schema
- 通用 Responses outbound builder 负责：
  - 将 `instructions` 转成首条 system `input_text`
  - 归一 chat-style function tools 为 Responses wire `type=function + top-level name + parameters`
  - 将 string / invalid `parameters` 归一成 object schema
- 所有上述 compat 语义只能通过 Rust `runReqOutboundStage3CompatJson` 执行

## 当前真相

Rust 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs`

TS 允许存在的仅是 Host N-API 调用壳和测试 helper；历史 llmswitch-core TS bridge / orchestration 已删除，不能作为当前入口恢复：

- 已删除：`sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts`
- 已删除：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts`
- 当前 Host bridge surface：`src/modules/llmswitch/bridge/native-exports.ts`
- 当前 direct native test helper：`tests/sharedmodule/helpers/compat-engine-direct-native.ts`

## 收口规则

1. `responses:crs` 的字段删改与工具归一只能在 Rust stage3 compat 实现。
2. TS 不得在 `src/providers/*`、`src/server/*`、`src/modules/llmswitch/*` 里重做：
   - `instructions -> input`
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
4. 针对 `responses:crs` 与通用 Responses normalization 的 Rust 测试和 architecture gate 全绿

## 已拆出的共享 closeout 单元

- `responses.function_tool_normalization`
- `responses.tool_parameters_normalization`
- `responses.instructions_to_input_normalization`
