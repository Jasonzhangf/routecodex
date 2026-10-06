# REQ02 Gemini / Anthropic 真实公开 Relay 消费者回归结果

## 结论

- 四项必需业务消费者测试全部编译并通过：Gemini JSON、Gemini SSE、Anthropic JSON、Anthropic SSE。
- 每项都从真实公开 Runtime HTTP 入口调用，使用本地 Axum 真实 HTTP peer，真实上游请求被捕获，客户端完整响应被收集，客户端与 provider wire 业务 sentinel 被断言，peer 与 aggregate server 都执行 gracefully shutdown 并 await。
- 本结果只证明四项公开入口 JSON/SSE 业务回归绿；不证明 REQ02 scope 生命周期绿，不声称修复或交付完成。
- 未修改产品代码、map、graph、配置源或既有测试；只新增本任务的测试、日志和结果文件。

## 基线

- worktree: `/Volumes/Intel/playground/routecodex/req02-protocol-scope-consumers-20261003`
- branch: `codex/req02-protocol-scope-consumers-20261003`
- HEAD: `688f7a1c6a15ecf45dfee12cc430148ae3c03898`
- test file: `v3/crates/routecodex-v3-server/tests/req02_protocol_relay_consumers.rs`
- test runner: `v3/scripts/run-v3-cargo-test.mjs`

## 执行命令与退出码

工作目录：

`/Volumes/Intel/playground/routecodex/req02-protocol-scope-consumers-20261003`

原始测试命令：

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_protocol_relay_consumers -- --nocapture
```

原始退出码：`0`

测试日志：

`docs/goals/req02-protocol-consumers-logs/req02_protocol_relay_consumers.cargo-test.log`

日志尾部结果：

```text
running 4 tests
test req02_anthropic_json_relay_public_entry_round_trips_real_http_upstream ... ok
test req02_anthropic_sse_relay_public_entry_round_trips_real_http_upstream ... ok
test req02_gemini_json_relay_public_entry_round_trips_real_http_upstream ... ok
test req02_gemini_sse_relay_public_entry_round_trips_real_http_upstream ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 16.57s
```

附加检查：

- `rustfmt --edition 2021 --check v3/crates/routecodex-v3-server/tests/req02_protocol_relay_consumers.rs` -> exit `0`
- `git diff --check` -> exit `0`

## 四项测试明细

| test ID | 公开入口 | 真实 HTTP upstream | 实际断言范围 | 结果 |
| --- | --- | --- | --- | --- |
| `req02_gemini_json_relay_public_entry_round_trips_real_http_upstream` | `POST /v1beta/models/gemini-client/generateContent`，`stream=false` | 本地 Axum `POST /v1beta/models/gemini-wire:generateContent` | provider 请求路径、Bearer 认证、provider wire `contents[0].parts[0].text` 精确 sentinel、无 `metadata_center`；客户端 `application/json`、合法 Gemini JSON、响应 sentinel、`finishReason=STOP`、usage；完整收集 body；peer/server shutdown await | PASS |
| `req02_gemini_sse_relay_public_entry_round_trips_real_http_upstream` | `POST /v1beta/models/gemini-client/generateContent`，`stream=true` | 本地 Axum `POST /v1beta/models/gemini-wire:streamGenerateContent` | provider 请求路径、Bearer 认证、provider wire 请求 sentinel、无 `metadata_center`；客户端 `text/event-stream`、合法 SSE JSON 事件、两个 sentinel、终态 `finishReason=STOP`、usage、无 Chat `[DONE]`；完整收集 body；peer/server shutdown await | PASS |
| `req02_anthropic_json_relay_public_entry_round_trips_real_http_upstream` | `POST /v1/messages`，`stream=false` | 本地 Axum `POST /v1/messages` | provider 请求路径、Bearer 认证、provider wire `model=anthropic-wire`、`stream=false`、message content 精确 sentinel、无 `metadata_center`；客户端 `application/json`、合法 Anthropic `type=message`、文本 sentinel、`stop_reason=end_turn`、usage；完整收集 body；peer/server shutdown await | PASS |
| `req02_anthropic_sse_relay_public_entry_round_trips_real_http_upstream` | `POST /v1/messages`，`stream=true` | 本地 Axum `POST /v1/messages` | provider 请求路径、Bearer 认证、provider wire `model=anthropic-wire`、`stream=true`、message content 精确 sentinel、无 `metadata_center`；客户端 `text/event-stream`、合法 Anthropic SSE 事件、`message_start`、文本 sentinel、`message_delta.stop_reason=end_turn`、最终 `message_stop`；完整收集 body；peer/server shutdown await | PASS |

## 证据哈希

| 证据 | SHA-256 |
| --- | --- |
| test source `v3/crates/routecodex-v3-server/tests/req02_protocol_relay_consumers.rs` | `77cfaed2c4dc1de527381d9dc21a32d6f79b2d7f6d42b331f516c9db41c49204` |
| test log `docs/goals/req02-protocol-consumers-logs/req02_protocol_relay_consumers.cargo-test.log` | `96dbcbd2bc4b81cbb8c369d600e904fc889168186b6635b89f35af214ecc9d06` |
| profile descriptor `docs/goals/req02-protocol-consumers-logs/profile.txt` | `f6a995a420260784117ad28e14b012848ad55575ba6a6537f0ec3f00060e9daf` |
| `v3/Cargo.toml` | `5c9145e1c2d5944402c101253c7cc9d03202f75440b564e22af017e5bc5eb8fe` |
| `v3/Cargo.lock` | `1017149b1d4c46642bfb11fe2901c21b411c383bdcd5d463cc072ba94faa0afb` |
| `v3/scripts/run-v3-cargo-test.mjs` | `722aa84d50030c5e7278424bd4317371813693ef93048ee163f83ec640ef4467` |

说明：`run-v3-cargo-test.mjs` 在测试结束后会删除本次测试可执行文件并清理 `test` profile，因此没有保留 compiled test binary digest；profile 证据以 `profile.txt`、manifest、lock 和 runner hash 绑定。

## 未覆盖的 scope 生命周期终点

公开入口无法传入同一个 `V3RequestExecutionControl`，也无法通过真实 HTTP 请求观察取消/EOF 后的 runtime release。当前基线证据：

- Anthropic server handler 只构造 `V3AnthropicRelayRuntimeInput` 并调用默认 runtime，入口没有 execution-control 参数：`v3/crates/routecodex-v3-server/src/endpoint_handlers.rs:632`。
- Anthropic runtime inner 在内部调用 `V3RequestExecutionControl::from_manifest`，调用方无法传入或观察同一个 control：`v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs:418`。
- Gemini runtime inner 调用 `execute_v3_relay_runtime_core` 时传入 `None`：`v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs:202`。
- Relay core 只在 `initial_request_execution_control=None` 时从 manifest 构造 control：`v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs:621`。
- `V3RequestExecutionControl::from_manifest` 是 `pub(crate)`，server integration test 不能构造同类型 control：`v3/crates/routecodex-v3-runtime/src/execution_control.rs:119`。
- server executor 的公开签名同样只接收 manifest 和 runtime input，不接收 request execution control：`v3/crates/routecodex-v3-server/src/executors.rs:31` 与 `v3/crates/routecodex-v3-server/src/executors.rs:58`。

最小 owner/API 需求：

- owner 是 Gemini/Anthropic Relay runtime entry 与 server endpoint/executor wiring，不是本测试文件。
- 为公开 server/runtime entry 增加显式 typed `Option<V3RequestExecutionControl>`（或等价的 opaque request-scope carrier）参数，并原样传入 `execute_v3_relay_runtime_core` / Anthropic inner；不得从 payload、metadata 或日志重建。
- 提供与 runtime completion、客户端取消和 EOF 绑定的可观察 release/dispose 边界，供真实公开入口测试断言同一个 request scope 已释放。

在这些 API 与真实入口可观察性存在前，本测试文件不添加伪造 control、手工 drop guard 或日志重建路径；四项业务绿不能替代 scope 生命周期证据。

## 边界与清理

- 新增：`v3/crates/routecodex-v3-server/tests/req02_protocol_relay_consumers.rs`
- 新增：`docs/goals/req02-protocol-consumers-logs/req02_protocol_relay_consumers.cargo-test.log`
- 新增：`docs/goals/req02-protocol-consumers-logs/profile.txt`
- 新增：本结果文件
- 未 commit、未 merge、未 push、未 install、未 restart、未访问 4444。
- 每个测试内自建 Axum peer 和 aggregate server 都执行 graceful shutdown；Axum peer task await 终止。未发现本任务遗留运行进程。
