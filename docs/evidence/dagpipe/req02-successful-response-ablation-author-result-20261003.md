# REQ02 成功attempt响应候选定点消融结果

日期：2026-10-03

状态：两处最小消融完成；全部指定验证真实通过；未 commit/merge/push/install/restart，未触碰4444。

## 基线

- 工作树：`/Volumes/Intel/playground/routecodex/req02-successful-response-view-20261003`
- branch：`codex/req02-successful-response-view-20261003`
- HEAD：`688f7a1c6a15ecf45dfee12cc430148ae3c03898`
- 本结果只覆盖本树 dirty 候选中的上述两处消融，不替代父编排的逐文件组合、review 或 REQ02 生产交付。

## 消融与唯一owner

1. 成功attempt身份投影的唯一owner收敛为 `V3AnthropicResponsesProjectionContext::successful_attempt_tool_identities`。
   - `from_successful_attempt_with_business_context` 不再创建 `custom_tool_names`、`namespaced_custom_tool_identities`、`mcp_tool_identities` 三个 legacy map 局部变量，也不再按 `custom`/`function` 重复 match 回填。
   - 该 constructor 中三个 legacy 字段显式初始化为空；metadata、reasoning policy、recordId 到 emitted name 的关联以及 namespace 缺省/null/string 均保留。
   - `from_chat_canonical_request` 及其真实 legacy callers 未改；未新增相等校验、拒绝层或第二 mapper。
   - 投影 consumer `anthropic_codec_tool_projection.rs` 继续优先使用单一 `successful_attempt_tool_identity`。

2. 删除无真实 consumer 的 Responses-only 包装。
   - 删除 `materialize_v3_responses_provider_sse_as_canonical_response_with_context`。
   - 删除其在 `responses_relay_runtime.rs` 的 export。
   - 保留通用 protocol 的 `materialize_v3_provider_sse_as_canonical_response_with_context`，继续委托既有 materializer；SSE reducer 与协议语义未改。

## 指定验证

每条命令均在工作树中独立执行，stdout/stderr 直接重定向到对应日志；下列退出码为命令进程原始退出码。

```text
env CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_cross_kind -- --nocapture
exit 0; 2 passed, 0 failed
log: docs/goals/req02-response-ablation-logs/req02-cross-kind.log

env CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_view -- --nocapture
exit 0; 6 passed, 0 failed
log: docs/goals/req02-response-ablation-logs/req02-view.log

env CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib anthropic_codec -- --nocapture
exit 0; 25 passed, 0 failed
log: docs/goals/req02-response-ablation-logs/req02-runtime-anthropic-codec.log

env CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture
exit 0; 51 passed, 0 failed
log: docs/goals/req02-response-ablation-logs/req02-runtime-operation-runner.log

git diff --check
exit 0; empty output
log: docs/goals/req02-response-ablation-logs/req02-git-diff-check.log
```

`req02_successful_response_view` 的 6 个通过用例包含真实 provider SSE consumer 路径；`operation_runner` 日志中的 poison 相关 panic 文本由测试自身捕获断言，最终结果为 `51 passed; 0 failed`。

## SHA256

源码：

```text
37af7138ebb856de7e767b8f6a7c7f92882e8e8e848b822b35b4e2be02227533  v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/projection_context.rs
2e1424fa1da0dcbd95ffca0d2499fe9a66dfd8c5f0e07353f834c6eace3babd0  v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs
b1ed520f85e9158e835440f94998a943657f371cd0158ea36da0f7c07891eb1a  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs
ff619e9e277984e22cd1c70411223d4ec7d6f0ad1033d9fcf807a591e6b2de25  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs
b1fce25bd34f8a047df6cbe00520837bcd6e1bb51672dffbb99523a383bae7ba  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
```

测试：

```text
eab890b2c7c15c0118f401c67b6746fe2df49b01054d47112a163739481f6d02  v3/crates/routecodex-v3-server/tests/req02_successful_response_cross_kind.rs
1fc0c4fd44ccfa64d80b3c3deb13d8e9a9b990270488f19c0e6da9ccef7eba5e  v3/crates/routecodex-v3-server/tests/req02_successful_response_view.rs
```

profile：

```text
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
```

日志：

```text
6fdd9d54dc26cc4f8a4217752373fd3a672c64905c08630e6234d9925a39e03e  docs/goals/req02-response-ablation-logs/req02-cross-kind.log
b9bef863a4f882534cd4867488a2a0cbfc3b3e84cc1201e11b47cb9b610ae398  docs/goals/req02-response-ablation-logs/req02-view.log
f3df55483bf1fb174f3f576883045b0174414b52a87b0ad9362b5b9dcfe538a9  docs/goals/req02-response-ablation-logs/req02-runtime-anthropic-codec.log
0aebab4ee7f2d6320f67d5914f777142bffad6950d93f5d7aa759e789c0271cb  docs/goals/req02-response-ablation-logs/req02-runtime-operation-runner.log
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  docs/goals/req02-response-ablation-logs/req02-git-diff-check.log
```

两份测试文件哈希与既有 correction result 记录一致，本任务未修改原测试。

## 未接线边界

- Runtime 实际 caller 与 REQ06 producer 未修改；当前只保留通用 typed provider SSE `with_context` 薄委托入口。
- 未安装、未重启、未 replay 4444、未创建 review/commit/merge/push/OTA 证据。
- 本结果只证明本树 dirty 候选的两处消融及指定定向验证通过，不证明 REQ02 生产交付完成。
