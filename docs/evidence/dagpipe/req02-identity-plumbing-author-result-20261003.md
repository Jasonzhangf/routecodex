# REQ02 Runtime 请求身份及实际资源搬运 · 结果

状态：**INCOMPLETE**（1 个残留终点，见「边界缺口」；其余完成 iff 项均已达成并验证）

- 合同：`/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002/docs/goals/req02-identity-plumbing-worker-20261003.md`
- 设计依据：父树 `docs/design/v3-req02-cutover-consumer-contract.md`
- 独占 worktree：`/Volumes/Intel/playground/routecodex/req02-identity-plumbing-20261003`
- 基线：`origin/main = 75cab8267`（本树未 commit/merge/push/install/restart，符合合同）
- 本树结果：仅落盘，不接共享 4444，不创建下层任务，不重复全库审计

## 达成项

1. **唯一有身份 factory**：`V3RequestExecutionControl::new(manifest, server_id, request_id, entry_protocol)`
   在首次 planning 前用真实 `request_id`/`entry_protocol` 创建同一个 request-local
   `V3RequestContextHandle`，并立即取出唯一非 Clone `V3RequestFinalizerGuard`。
   原无身份 `from_manifest` 已删除；本树 `rg V3RequestExecutionControl::from_manifest` 为空。
2. **同 scope 传递**：`request_context()` 返回同 scope 引用；Direct/Relay handoff 只搬运
   同一个 `V3RequestExecutionControl`，不重建 pair。`same_scope` 用 `Arc::ptr_eq` 判定。
3. **guard 只 take 一次**：`take_request_finalizer()` 由 `Arc<Mutex<Option<..>>>` 保证；
   普通 handle/control clone 共享同一 guard，clone 的 Drop 不 finalize。
4. **真实输出终态释放（Direct Responses 路径）**：
   - Runtime 在 Direct 终态输出把 guard 移入 `V3ResponsesDirectRuntimeOutput.request_finalizer`。
   - Server `execute_responses_direct_server_outcome` 是唯一 Server 侧 take 点：
     CommittedSse 用 `stream.observe(on_terminal)` 把 guard 移进终态观察器，
     在 **EOF(Completed)/Drop(Dropped)** 释放；LiveSse 用
     `V3RequestFinalizerLiveSseStream` 持有到 stream Drop；JSON/Bytes 在帧构造后立即释放。
   - RelayOutput：Server 在把 `handoff.request_execution_control` 交给 Relay 前保留一个 clone，
     Relay 终态后从 clone take guard，并绑到 `client_body` 的 CommittedSse 终态观察器（JSON 立即释放）。
   - 取消 / future drop / 断连：未到达输出终态时，control 最后一个 clone Drop 仍按
     attempt→request 释放（`V3RequestFinalizerGuard::Drop`）。
5. **范围内旧无身份调用迁移**：`hub_v1/{web_search_hook_request.rs,web_search_sidecar.rs,`
   `responses_relay_runtime_tests.rs}`、`tests/support/{kernel_unit.rs,`
   `openai_chat_relay_runtime_unit.rs}` 全部改为显式 `new(..., request_id, protocol)`，
   无 dummy/default 兜底。
6. **公开回归 + 受影响开发测试 exit 0**（原始回执见下）。

## 逐文件变更（作者改动）

完整 unified diff：`docs/goals/req02-identity-plumbing-20261003-logs/req02-candidate.diff`（567 行，
sha256 `88ca1c1a44e8dda9baf2f7784262b4cf45947aa5ff07984f770540905b884f65`，仅含 tracked 改动；
新增未跟踪测试文件 `server/tests/req02_request_scope_lifecycle.rs` 另列 hash）。
父提供只读依赖（`operation_runner/mod.rs`、`request_context_store.rs`、`operators/*`、
`docs/architecture/*` map/graph/profile）未由本任务修改，仅在下方列 hash 供集成核对。

| 文件 | 改动 |
| --- | --- |
| `runtime/src/execution_control.rs` | `V3RequestExecutionControl` 增 `request_context` + `Arc<Mutex<Option<guard>>>`；`from_manifest`→`new(manifest,server_id,request_id,entry_protocol)`；增 `request_context()`/`take_request_finalizer()` |
| `runtime/src/nodes.rs` | `pub use crate::operation_runner::{V3RequestContextHandle, V3RequestFinalizerGuard};` |
| `runtime/src/kernel.rs` | factory 传真实 `standardized.request_id` + `"responses"`；Direct 终态 take guard 入输出 |
| `runtime/src/kernel/direct_execution_control.rs` | `resolve_v3_direct_request_execution_control` 增 `request_id`/`entry_protocol` 参数并转发 factory |
| `runtime/src/kernel/v3_direct_core.rs` | factory 传 `C::request_id`/`C::ENTRY_PROTOCOL`；Direct 终态 take guard 入输出 |
| `runtime/src/kernel/direct_state.rs` | `V3ResponsesDirectRuntimeOutput` 增 `pub request_finalizer: Option<V3RequestFinalizerGuard>`（必要 Runtime 输出字段） |
| `runtime/src/kernel/direct_runtime_helpers_stream.rs` | 修正 handoff/error 输出 initializer（handoff 不 take，guard 留在 control 内） |
| `runtime/src/hub_v1/{relay_runtime_core.rs,responses_relay_runtime_inner.rs,anthropic_relay_runtime.rs}` | factory 参数改为真实 `request_id` + entry protocol（仅参数，不改协议投影/治理/归一化） |
| `runtime/src/hub_v1/{responses_relay_runtime_tests.rs,web_search_hook_request.rs,web_search_sidecar.rs}`、`runtime/tests/support/{kernel_unit.rs,openai_chat_relay_runtime_unit.rs}` | 测试/support 迁移到显式 factory 身份 |
| `server/src/responses_direct_server_outcome.rs` | Server 侧唯一 guard take 点；`attach_v3_direct_frame_request_finalizer` / `attach_v3_relay_output_request_finalizer` / `V3RequestFinalizerLiveSseStream` |
| `server/src/tests/mod.rs` | 三处 `V3ResponsesDirectRuntimeOutput` 字面量补 `request_finalizer: None` |
| `server/tests/req02_request_scope_lifecycle.rs` | 新增公开 consumer 回归（8 例） |

## 边界缺口（INCOMPLETE）

**残留终点：Relay 自建 control 的 SSE 终态未绑定 observe。**

- 首个确切 caller：`routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs:122`
  （`initial_request_execution_control == None` 分支，由 `server/src/endpoint_handlers.rs`
  Relay 模式 / `server/src/websocket.rs::execute_responses_relay_websocket_output` /
  `server/src/executors.rs` openai_chat/anthropic/gemini 入口触发）。
- 现象：这些路径由 Relay 内部创建 control，guard 在 Relay 函数返回时随 control Drop
  释放（请求终态成立，但发生在 Relay 完成而非客户端 SSE EOF/Drop）。
- 必需接口：`V3ResponsesRelayRuntimeOutput` / `V3OpenAiChatRelayRuntimeOutput` /
  `V3AnthropicRelayRuntimeOutput` / `V3GeminiRelayRuntimeOutput` 需带
  `request_finalizer: Option<V3RequestFinalizerGuard>`，并在 Relay 终态 take；
  或 Server 在 Relay 模式显式用 `V3RequestExecutionControl::new(...)` 建 control、
  保留 clone，终态 take 后绑到 `client_body` 的 CommittedSse 观察器。
- 最小拟改文件（超出本任务允许集，故未擅自扩大）：`responses_relay_types.rs`、
  `openai_chat_relay_runtime.rs`、`anthropic_relay_runtime_helpers.rs`、
  `gemini_relay_runtime.rs`、`live_snapshot.rs::finalize_v3_responses_relay_server_output`、
  `endpoint_handlers.rs`/`websocket.rs` Relay 分支、`executors.rs` 的
  `*_relay_output_response` 签名。把 guard 搬到 Relay SSE 终态观察器即可闭合，
  不影响现有 4444 候选（本树未安装）。

## 原始退出回执

全部使用合同指定命令、`CARGO_NET_OFFLINE=true`、项目 wrapper、显式本独占 workdir。

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_request_scope_lifecycle -- --nocapture` | 0 | `docs/goals/req02-identity-plumbing-20261003-logs/req02_request_scope_lifecycle.log` |
| `node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib execution_control -- --nocapture` | 0 | `docs/goals/req02-identity-plumbing-20261003-logs/runtime_execution_control.log` |
| `node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture` | 0 | `docs/goals/req02-identity-plumbing-20261003-logs/runtime_operation_runner.log` |

关键结果行：

```text
req02_request_scope_lifecycle: test result: ok. 8 passed; 0 failed; 0 ignored
runtime execution_control:     test result: ok. 22 passed; 0 failed; 0 ignored
runtime operation_runner:      test result: ok. 51 passed; 0 failed; 0 ignored
```

补充编译验证（非合同命令，作者自检）：

```text
CARGO_NET_OFFLINE=true cargo check -p routecodex-v3-runtime --tests    -> exit 0 (no error)
CARGO_NET_OFFLINE=true cargo check -p routecodex-v3-server --all-targets -> exit 0 (no error)
```

## Hash（sha256）

作者改动源/测试：

```text
553e93429ec7eb311607508a957c2016c0ce4d0a6285d6e513fd71abf2e80119  runtime/src/execution_control.rs
e87712b4d13f5f1335bfc3925fa49233edb9887583b0367d9b708b6a268e77a6  runtime/src/nodes.rs
f460740e45e3f171460ebc12a9aac7b39d14d4bea1289f818367b8b5c2ab8710  runtime/src/kernel.rs
01973e1b1b55035aa66212f1dd1a16f8e36ca43a3231ed4ed84f8d25b19382dd  runtime/src/kernel/direct_execution_control.rs
423c09dff85637b0f949cc63cd6c207ccb335654f573c43c457fe4686da51e5f  runtime/src/kernel/v3_direct_core.rs
73b9853f8eec5376ed71e426a52a83e0fe15f9224d9e7695de196bf22671e3dd  runtime/src/kernel/direct_state.rs
a80642d92de365e002fb8d2d3db4685ab2f8bc910f30d59becb31b5221b88b9b  runtime/src/kernel/direct_runtime_helpers_stream.rs
a8bdbe938649bc1dc4bfddfd8bc3ca03d48553f3497e102da610dafb8e169309  runtime/src/hub_v1/relay_runtime_core.rs
0b26ddc4ebe125225124797d13687c550604a4b80eb52ee365a9f3feb8ea5711  runtime/src/hub_v1/responses_relay_runtime_inner.rs
e5317d45c61bf4e1aa71fe8ae86a6d32e383acaedd59311094b6beb855d54968  runtime/src/hub_v1/anthropic_relay_runtime.rs
45861eef831e3fc3a297aa680b3e9dd4a9f3f043c7612edc2847244b12f57256  server/src/responses_direct_server_outcome.rs
e91ac9980bf8335efdd09a05dcec71fab6e6707a521133ef6e3a950b86428d4f  server/src/tests/mod.rs
f8d5527d38a72c9b8e639086c2a818a0f1ae50c3829e42e1366655ef69c250bc  server/tests/req02_request_scope_lifecycle.rs
```

父提供只读依赖（集成核对用，未由本任务修改）：

```text
bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35  runtime/src/operation_runner/request_context_store.rs
2694d90f655083996d2f72fb3c30546f66c2c9d17d247c502e7a10a85fab1686  runtime/src/operation_runner/mod.rs
d4e6365c265793468fde1f17409e87aa84e9597fd78fbbdfef5cad290386ec8f  docs/architecture/dagpipe/v3.operation_runner.request.graph.json
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
```

## 未做（合同非目标）

- 无 commit / merge / push / install / restart；未接共享 4444。
- 未改 `req_inbound_02_normalized.rs`、`req_chat_process_04_governed.rs`、REQ06 公共投影、
  Provider 及 SSE 协议投影。
- 未新增第二套 factory、无身份 fallback、dummy ID 或 default context。
