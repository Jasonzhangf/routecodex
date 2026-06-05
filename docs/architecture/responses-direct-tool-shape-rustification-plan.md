# Responses Direct Tool Shape Rustification Plan

## 目标

把 `responses.direct_tool_shape_contract` 从当前 **TS 校验 + Rust 主链混合**，收口到 **Rust 唯一语义真源 + TS 薄壳 transport**。

核心 contract：

- `openai-responses` direct payload 禁止 chat-style `tools[].function.name`
- Responses wire `type="function"` 工具必须使用 top-level `tool.name`
- direct payload 与 provider runtime 必须在 transport 前 fail-fast
- 同一类错误必须保持统一错误语义，禁止一条链路放行、另一条链路拒绝

## 当前真相

当前 Rust 已成为唯一 validator 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`

当前 TS 仅保留桥接与 transport 壳：

- `src/server/runtime/http-server/direct-passthrough-payload.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.ts`

当前 direct routeParams override 真源：

- `apply_responses_direct_route_params_override_json`
- 同时覆盖 server direct 与 provider direct 的 `model` / `reasoning_effort` 覆写
- TS 不再各自持有两套 mutation 逻辑

当前 direct raw replay / stream lift 真源：

- `resolve_responses_direct_payload_json`
- 统一处理 `metadata.__raw_request_body` 优先级、`metadata` fail-fast、`stream=true` 注入
- TS 不再本地判断 replay raw 与 stream flag 合成

## Rust-only 收口阶段

### Phase 1：锁 contract，不再扩散

- 通过 `function-map.yml` / `verification-map.yml` 把 feature 显式登记
- 通过 `verify:responses-direct-tool-shape-contract` + `test:ci:jest` 锁住 direct regression
- route-level same-protocol direct relay regressions (`direct-passthrough-route-level.spec.ts`) 也必须进 `test:ci:jest`，避免 custom `apply_patch` / servertool mode 再次从 direct path 泄漏。
- 2026-06-05 phase7 closeout: moved same-protocol direct `apply_patch` declaration detection from `src/server/runtime/http-server/index.ts` into Rust helper `has_declared_apply_patch_tool_json`; `index.ts` now only bridges the relay-required decision.
- 2026-06-05 phase8 closeout: merged direct `providerWireValid` + `requiresHubRelay` decision into Rust helper `evaluate_responses_direct_route_decision_json`; `index.ts` now consumes one canonical decision instead of composing local contract + relay checks.
- 2026-06-05 phase9 closeout: shrank `direct-passthrough-payload.ts` surface so `checkDirectPayloadContract` becomes a thin wrapper over `evaluateDirectRouteDecision`; removed direct local `hasDeclaredApplyPatchToolInPayload` export to avoid TS-side split owner drift.
- 禁止新增第二套 TS 校验实现

### Phase 2：Rust 引入唯一 validator

在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/` 增加唯一语义入口，目标命名：

- `assert_responses_direct_tool_shape_contract`
- `assert_no_chat_style_function_tools_in_responses_wire`

要求：

- 输入为 direct responses payload / provider semantic payload
- 输出为 pass / fail-fast error
- 错误文案与现有 TS contract 对齐，迁移期允许通过 shadow compare 校准

### Phase 3：TS 改为薄壳调用 Rust

TS 仅保留：

- transport/auth/header shell
- bridge / napi 调用
- typed projection / error rethrow

TS 不再保留工具 shape 语义判定分支。

### Phase 4：anti-regression gate

当前执行方式：

- direct/provider 两条入口都只调 Rust validator
- gate 锁：
  - rust-first
  - native-availability
  - no-ts-fallback

### Phase 5：物理删除 TS 语义

当前状态：

- `src/server/runtime/http-server/direct-passthrough-payload.ts` 内重复 TS shape helper 已删除
- `src/providers/core/runtime/responses-provider.ts` 只保留 Rust validator 调用与 unavailable fail-fast
- direct routeParams `model/reasoning_effort` 覆写已并到 Rust helper，server/provider 共用一条 bridge

保留：

- minimal transport shell
- Rust bridge call

## 必备 gate

- `npm run verify:responses-direct-tool-shape-contract`
- `npm run verify:responses-direct-tool-shape-rust-first`
- `npm run verify:responses-direct-tool-shape-native-availability`
- `npm run verify:responses-direct-tool-shape-no-ts-fallback`
- `npm run test:ci:jest`

## 删除完成判据

满足以下条件才允许宣称 TS 删除完成：

1. Rust validator 成为唯一真源
2. TS 仅剩桥接与 transport，不再判断工具 wire shape
3. direct payload / provider runtime 两条入口统一调用 Rust contract
4. no-ts-fallback gate 持续通过
5. 旧 TS 语义分支已物理删除
- 2026-06-05 phase5 closeout: moved provider-local direct passthrough body build (`stripInternalKeysDeep`, top-level `metadata` rejection, trimmed `model` requirement) into Rust NAPI helper `build_responses_direct_passthrough_body_json`; `responses-provider.ts` now only bridges to native owner.
