# Responses Direct Tool Shape Rustification Plan

## 目标

记录 `responses.direct_tool_shape_contract` 在 2026-06-07 后的收口结论：direct 不是请求构造/校验/修复链路，只是 same-protocol provider passthrough + hooks。

核心 contract：

- direct 使用当前请求 body 对象本身；禁止 clone / structuredClone / jsonClone / deep copy。
- direct 不读取 `metadata.__raw_request_body`、snapshot、context 或 history 来恢复请求体。
- direct 不调用 direct body builder、provider outbound sanitizer、Responses/chat-style tool validator、history repair、protocol conversion。
- direct 只允许在当前请求对象上做明确的最小 runtime 覆盖；router-direct 不得用 `providerPayload` 重建或覆盖 request body。
- direct 最小覆盖只能作用当前 request/delta 顶层，不得重写 `input/messages/history` 中既有历史条目，避免 cached history 被污染后重复命中。
- relay/Responses continuation 只能基于合法 persisted prefix 追加当前 incoming delta；不得修改 persisted prefix/basePayload，不得把 route/model 覆盖回写 cached history。
- RouteCodex 自己生成/持久化的 Responses history 必须在 Hub/Responses conversation store owner 保证合法；direct 不负责清洗历史。

## 当前真相

当前真相：

- `src/server/runtime/http-server/direct-passthrough-payload.ts`：只返回当前 body 对象并做最小覆盖；不 clone、不 raw replay、不 validator。
- `src/server/runtime/http-server/router-direct-pipeline.ts`：same-protocol direct 只把当前 requestPayload 传给 `processIncomingDirect`；audit context 不克隆 payload。
- `src/providers/core/runtime/responses-provider.ts`：direct 走 `processIncomingDirect(request)`，不进 Hub Pipeline，不走 provider outbound sanitizer。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`：Responses 历史合法化 owner，持久化/恢复的 tools 与 function_call/function_call_output 必须是 Responses 合法 shape。
- `materialize_responses_continuation_payload`：relay continuation 只在 incoming 是纯 delta 时 materialize；route/model 等当前请求字段只进入新 payload 顶层，不回写 cached prefix/history。

已纠正的错误实现：

- `metadata.__raw_request_body` 作为 live direct body 来源：已移除。
- direct body builder / Rust direct payload builder：已移除 direct live path 使用。
- direct runtime 拦截 chat-style function tool：已移除；客户端非法请求由 provider 返回错误。
- router-direct 使用 `providerPayload` 覆盖 model：已废弃并通过测试改为 requestPayload identity passthrough。

## Rust-only 收口阶段

### Phase 1：锁 contract，不再扩散

- 通过 `function-map.yml` / `verification-map.yml` 把 feature 显式登记
- 通过 `verify:responses-direct-tool-shape-contract` + `test:ci:jest` 锁住 direct regression
- route-level same-protocol direct relay regressions (`direct-passthrough-route-level.spec.ts`) 也必须进 `test:ci:jest`，避免 custom `apply_patch` / servertool mode 再次从 direct path 泄漏。
- 2026-06-05 phase7 closeout: moved same-protocol direct `apply_patch` declaration detection from `src/server/runtime/http-server/index.ts` into Rust helper `has_declared_apply_patch_tool_json`; `index.ts` now only bridges the relay-required decision.
- 2026-06-05 phase8 closeout: merged direct `providerWireValid` + `requiresHubRelay` decision into Rust helper `evaluate_responses_direct_route_decision_json`; `index.ts` now consumes one canonical decision instead of composing local contract + relay checks.
- 2026-06-05 phase9 closeout: shrank `direct-passthrough-payload.ts` surface so `checkDirectPayloadContract` becomes a thin wrapper over `evaluateDirectRouteDecision`; removed direct local `hasDeclaredApplyPatchToolInPayload` export to avoid TS-side split owner drift.
- 禁止新增第二套 TS 校验实现

### Phase 2：历史合法化 owner

Responses history/tool shape 的唯一修复点是 Hub/Responses conversation store owner。新增或修复能力必须落在 Rust history/conversation owner，不得在 direct/provider runtime 中补 sanitizer。

### Phase 3：TS 保持薄壳

TS 仅保留：

- transport/auth/header shell
- current body object handoff
- typed projection / error rethrow

TS 不得保留 direct 工具 shape 语义判定、raw replay 或 builder 分支。

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

1. direct 入口没有 clone / raw replay / builder / sanitizer / validator。
2. provider-request snapshot 不含 `metadata` / `__raw_request_body` / `requestMetadata` / `contextSnapshot`。
3. Responses history tests 证明持久化/恢复 tools 与 function_call/function_call_output 是合法 Responses shape。
4. direct focused Jest + Rust history contract gate 持续通过。
5. 旧 direct builder、raw metadata 入口、providerPayload model override 期望已物理删除。
6. direct/relay 回归测试证明 current delta 覆盖不改 cached history/persisted prefix。
