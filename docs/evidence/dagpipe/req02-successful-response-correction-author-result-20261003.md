# REQ02 成功attempt响应consumer作者纠正结果

日期：2026-10-03

状态：作者定向验证通过；未接线，未 commit/merge/push/install/restart，未触碰4444。

## 结论

- 父只读公开回归从红转绿：
  - `req02_successful_response_cross_kind`：红 `exit 101`，0 passed / 2 failed；绿 `exit 0`，2 passed / 0 failed。
  - `req02_successful_response_view`：红 `exit 101`，3 passed / 2 failed；绿 `exit 0`，6 passed / 0 failed。
- 成功attempt的反向恢复不再要求 `emitted_kind/emitted_namespace == original.kind/original.namespace`；关联只依据 `declaration_record_id`，emitted identity 仅用于索引 provider wire name。
- 所有已映射工具都建立“emitted name -> original kind/name/namespace presence”逆映射；namespace 缺省/null/string 分别保留，not guessed。
- function 改名恢复 `original_name`；custom 可跨 kind 恢复 `custom_tool_call`、原 namespace/name，并保留 raw/free-text input 与 call_id。
- 无映射工具仍走既有 legacy/factory 路径；未新增第二 response mapper。
- 成功attempt view 的业务 `metadata` 与 `reasoning_summary_policy` 通过显式数据面参数 `from_successful_attempt_with_business_context` 保留；未复制进 typed control slots。
- 真实 Anthropic provider SSE events 经既有 `provider_stream_materialization` 消费同一 typed context；测试未用 JSON 后重新 frame 冒充 provider SSE。

## 修改路径

- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/projection_context.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`
- `v3/crates/routecodex-v3-server/tests/req02_successful_response_view.rs`

父测试 `v3/crates/routecodex-v3-server/tests/req02_successful_response_cross_kind.rs` 只读且未修改。Runtime actual caller、REQ06、Provider、factory/lifecycle、field/profile/maps/graph 均未修改。

## 源码、测试与 profile 哈希

```text
f92e0b0ea930d6ff63e0b225647980af0f4e097670e2486ff25751c21a479eb7  v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/projection_context.rs
2e1424fa1da0dcbd95ffca0d2499fe9a66dfd8c5f0e07353f834c6eace3babd0  v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs
296f8f54e66015148acfa94de33e63fd4ae3d04b6679e70c78c7f13dc678e0ec  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs
2e9181af23ca7d6fa798672a3a320a77b6a1bd46635ba6556bd9dfb5cc41316c  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs
1fc0c4fd44ccfa64d80b3c3deb13d8e9a9b990270488f19c0e6da9ccef7eba5e  v3/crates/routecodex-v3-server/tests/req02_successful_response_view.rs
eab890b2c7c15c0118f401c67b6746fe2df49b01054d47112a163739481f6d02  v3/crates/routecodex-v3-server/tests/req02_successful_response_cross_kind.rs
b1fce25bd34f8a047df6cbe00520837bcd6e1bb51672dffbb99523a383bae7ba  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
```

## 红绿证据

原始命令均直接重定向日志，工具返回原退出码。

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_cross_kind -- --nocapture
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_view -- --nocapture
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib anthropic_codec -- --nocapture
git diff --check
```

```text
fde724a1aa689e30387f355ece8c0936d431e1fd8d914fe0fd577fca18b43048  docs/goals/req02-response-correction-logs/req02-cross-kind-red.log (exit 101)
21a94b26a01012ddf23bddb5b20b8a5d625260c12ce53b6a8e7ecb8569040c67  docs/goals/req02-response-correction-logs/req02-view-red.log (exit 101)
20f4e8f13f0279dfa1beb1257d79acc87869cd45a191e21e77053a8f1f8533c3  docs/goals/req02-response-correction-logs/req02-cross-kind-green.log (exit 0; 2 passed, 0 failed)
d25e2672fdce66a9316b8b5d8f6a048f85a5374be0e925ab4e5ee4a3b3914650  docs/goals/req02-response-correction-logs/req02-view-green.log (exit 0; 6 passed, 0 failed)
5cdb1200ceedbb689f115b3c2100a74ddee888ed11d291a893536cb79b81018d  docs/goals/req02-response-correction-logs/req02-runtime-operation-runner.log (exit 0; 51 passed, 0 failed)
0e5cb88db3f7b2fd6eb0215f1a7f9fd56586c3eb6893359f3a38977fb0d251ad  docs/goals/req02-response-correction-logs/req02-runtime-anthropic-codec.log (exit 0; 25 passed, 0 failed)
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  docs/goals/req02-response-correction-logs/req02-git-diff-check.log (exit 0)
```

额外格式检查：`rustfmt --edition 2021 --check` 对本任务 5 个改动文件 exit 0，日志 `docs/goals/req02-response-correction-logs/req02-rustfmt-check.log`。

## 未接线边界

- Runtime 实际 caller 和 REQ06 producer 未修改；当前只提供公开 typed view/context 与 provider SSE `with_context` 薄委托入口。
- 旧 `from_chat_canonical_request` factory 保留给未迁移 caller；新业务 context 不调用旧 factory 从 governed tools 重建映射。
- 未安装、未重启、未 replay 4444、未创建 review/commit/merge/push/OTA 证据；本结果只证明本树作者定向公开测试通过。
