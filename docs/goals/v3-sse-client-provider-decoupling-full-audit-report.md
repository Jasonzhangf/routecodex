# V3 SSE / client-provider decoupling full audit report

状态：`blocked_before_review`。本报告记录当前 `main` 的可复核证据，不代表完成；已完成最新 main 合并核对、安装、重启、health 与 Direct/Relay 在线 replay，但 Relay 语义帧未闭环，因此尚未 AGY Review、commit 或 push。

审计时间：2026-08-27 15:46 UTC 起

基线 commit：`d86f9aa5` (`main`；包含 `origin/main=aabccfe9`，当前工作树含其他 worker dirty/untracked，未覆盖)

## 1. 当前结论

当前项目已经有部分 SSE transport-only、Direct attempt commit 和 Error chain 实现，但尚未达到“全项目 Direct/Relay/client/provider 解耦并统一错误链”的交付条件。

当前已修复 source/map/gate 漂移与 SSE event 语义耦合，但仍有验证阻断；不是交付完成：

- `npm run verify:sse-architecture-boundary`：通过。
- `npm --prefix v3 run test:v3-sse-transport-core`：13/13 通过。
- `npm run verify:v3-direct-sse-full-attempt-commit`：通过。
- `npm run verify:v3-provider-action-gate`：通过，49 条 machine edges 与 source/map/manifest owner 一致。
- `npm run test:v3-provider-action-gate-red-fixtures`：通过，53/53 forbidden mutations rejected。
- `npm run test:v3-openai-chat-relay-runtime-integration`：通过，32/32 runtime tests；server controlled 子套件需单独补充明确终态证据。
- `cargo test -p routecodex-v3-runtime --test gemini_relay_runtime_integration -- --nocapture`：20/20 通过；从 repo root 调用旧 wrapper 会因 wrapper 相对路径错误找不到 `scripts/run-v3-cargo-test.mjs`，该 wrapper 问题与 Rust suite 结果分开记录。
- `npm run test:v3-hub-relay-runtime-closeout`：失败。并发运行 14/26；串行复跑 6/26；使用全新隔离 state 串行复跑为 7/26。首个可见偏离是 shared `V3ProviderActionGate` / provider health lifecycle 没有在完整测试进程内隔离，随后大量目标测试得到 `provider_key_health_cooldown|provider_cooldown_probe_pending` 或错误的 Error05/reselect 结果；另有 client JSON/SSE projection 与 retry-budget 断言失败。该回归涉及已占用的 provider-failure/SSE claims，未越权修改。
- 代表性单测试在全新进程和隔离 state 下通过：`responses_relay_client_json_request_projects_json_even_when_provider_returns_sse` 为 1/1；这证明不能用单测试替代整套 lifecycle gate，也进一步定位为 suite-level shared action/health state 生命周期问题。
- `cargo test -p routecodex-v3-runtime --test responses_direct_remote_continuation_integration -- --nocapture`：29/29 通过；覆盖 Direct JSON/SSE continuation、pre-commit failure、post-commit sealing、disconnect neutrality 与 Error01-06 polarity。
- root `npm run test:v3-responses-direct-remote-continuation`：通过；修正后的 root wrapper 已正确调用 `v3/scripts/run-v3-cargo-test.mjs`，末个 server filter 当前明确为 0 matched tests / 0 failed，不把空过滤器结果当作额外功能覆盖。
- root `npm run test:v3-gemini-relay-runtime-integration`：runtime 20/20 通过；server controlled 子套件仍失败于首个 Gemini SSE client chunk 未包含 provider `first` 内容，疑似 server keepalive/first-frame contract 断言不一致，尚未修复。
- `npm run verify:v3-architecture-docs`：通过，最终 `docs: 26`、`resources: 153`、`edges: 438`；此前 resource/mainline/source anchor 漂移已按当前 owner 修复，未恢复退役实现。
- `npm run verify:v3-resource-map`：通过；完整 source/map/manifest 一致性另由 `verify:v3-architecture-docs` 通过结果证明。

因此目前不能宣称：所有错误都已进入 ErrorErr01-06、Direct 与 Relay 已共享同一错误路径、完整 live 验证通过、AGY PASS、或可合并推送。

## 2. 当前状态与并发风险

当前 `main` 有大量未提交改动，涉及 runtime、server、error、provider-responses、target、WebUI、package lock 和运行产物；同时 SSE、Direct error channel、provider action gate、client SSE stream 等 claims 已被其他 runs 占用。

本轮 audit claim：`audit_id:v3_sse_client_provider_decoupling_full_20260827`。

在未完成 claim/source 对齐前，不得覆盖其他 worker 改动，不得用 reset、checkout、stash 或 broad cleanup 取得“干净”状态。

## 3. 目标拓扑审计基准

### Request / provider side

```text
client request
  -> server client boundary
  -> ReqInbound -> ReqChatProcess -> route/target -> ReqOutbound
  -> provider transport request
```

### Response / client side

```text
provider raw bytes
  -> SSE transport framing (opaque)
  -> provider JSON codec (typed semantic outcome)
  -> RespInbound -> RespChatProcess -> RespOutbound
  -> Direct buffered body OR Relay client stream
  -> client connection boundary
```

### Error side-channel

```text
ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

Transport facts（EOF、disconnect、abort、timeout、backpressure、frame error、body read error）可从 transport/client boundary 进入 Error01，但不能直接被当作成功、terminal、provider retry 或 client projection。provider 业务语义必须从 JSON codec typed outcome 进入错误/响应流程。

## 4. 已验证通过的部分

### 4.1 SSE transport crate

证据：`npm --prefix v3 run test:v3-sse-transport-core`。

13 个测试通过，覆盖：

- 空行与 frame boundary；
- colonless/data continuation；
- 多 chunk 与 buffer/frame limits；
- invalid UTF-8、unterminated frame；
- opaque `[DONE]`，不合成 terminal；
- backpressure pause/resume；
- success/failure close 与 release exactly once；
- transport error export。

这证明 transport crate 的局部合同成立，不证明所有调用者都保持 transport-only。

### 4.2 SSE architecture boundary

证据：`npm run verify:sse-architecture-boundary`。

当前 gate 通过，确认：

- `routecodex-v3-sse` 被视为 protocol-neutral；
- runtime roots 不导入已禁止的 TS SSE wrapper paths。

该 gate 不覆盖 runtime 内部是否重复读取 fields、`event:` 或 JSON 并做 semantic classification。

### 4.3 Direct full-attempt commit

证据：`npm run verify:v3-direct-sse-full-attempt-commit`。

当前 Direct attempt gate 通过，但该 gate 不能替代 provider-action gate，也不能证明所有 Direct provider failure 都经过统一 Error01-06。

## 5. 已确认 finding

### F-001：provider-action gate 与 source 漂移（P1，已修复；架构 docs 仍需收口）

证据：`npm run verify:v3-provider-action-gate`。

具体证据：

- gate 读取 `v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs`，当前 source 返回 ENOENT；
- gate 仍要求 `V3DirectSseProviderOutcome::record_failure`、`record_success`、`observe_chunk`、`observe_frame` 和 `wrap_direct_sse_provider_outcome_stream`；
- 当前 runtime 已将相关实现收敛到 `kernel/direct_sse_consumers.rs` / `kernel/direct_runtime_helpers_stream.rs`，但 gate/map 未同步；
- Responses action gate 仍要求 `observe_v3_runtime_responses_sse_transport_chunk` 与 `apply_v3_runtime_responses_semantic_event`，当前 source 使用不同 symbols；
- `package.json` 和 `.github/workflows/test.yml` 也未满足 gate 当前声明的 wiring contract。

根因：实现重构、mainline/manifest、gate 脚本、package/CI contract 没有同一 change set 原子收敛。不是通过增加别名或恢复旧文件解决；必须以当前真实 owner 重新绑定唯一边并删除死 contract。

唯一 owner 候选：provider-action gate / SSE protocol boundary 的 map-and-gate owner；具体 runtime owner 必须由 claim 现状确认后再修改。

最小修复：逐边核对真实 caller/callee/source，决定旧边是删除还是绑定当前 owner；同步 manifest、function/mainline/verification map 和 CI wiring；增加 source deletion/renamed-symbol reverse fixture。

状态：已修复并通过 provider-action gate；当前剩余阻断在 resource-relation edge lock 与全链 architecture docs，不再是 provider-action gate 的旧 source/symbol 漂移。

### F-002：SSE semantic classification 仍分散在多个 runtime 调用者（P1，需 owner 收敛）

证据：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs` 定义 `classify_v3_provider_sse_json_data`；
- `kernel/direct_sse_consumers.rs` 调用该分类并处理 provider failure；
- `kernel/direct_runtime_helpers_stream.rs` 调用该分类决定 `StartClientStream`、`Terminal`、`TerminalWithoutOutput`、`Failure`；
- `shared.rs` 调用该分类并根据 outcome 影响 handoff/terminal；
- `hub_v1/relay_runtime_core.rs` 调用该分类并决定 relay stream admission/terminal/failure；
- `gemini_relay_runtime.rs` 也直接消费该 enum 做 terminal/failure 分支。

这不等同于已证明架构错误：调用者可以消费 typed codec result；但当前 `V3ProviderResponsesJsonFrameOutcome` 同时承载 provider semantic outcome、client stream admission 和 lifecycle decision，需逐边证明哪些是 codec 产物、哪些是 execution decision，避免 runtime/kernel 重建 provider 语义。

审计要求：

- codec 只负责 JSON/protocol semantic typed result；
- runtime 只消费 typed result，决定本层 lifecycle/control；
- SSE transport 不读取或解释业务字段；
- Direct 与 Relay 不各自复制 provider classification；
- pre-commit/post-commit action 必须进入 Error04/05，不得直接在 stream helper 内生成 client error 或 reroute。

状态：待逐符号、逐边审计；不能仅凭 grep 结论。

### F-003：Direct/Relay client boundary 需要统一验证错误出口（P1，未闭环）

已见实现：

- `frame_builders.rs` 将 client stream item error 转为 SSE error frame；
- Direct 与 Relay 都有 console finalizer/client disconnect handling；
- Direct attempt buffer 在 terminal 前保持 provider frames，不直接 release；
- server response body stream 仍有 transport-level error-to-frame projection。

风险点：必须证明这些是 Error06 已完成后的 client projection，或明确属于 Error01 source capture；不能让 server/SSE body owner 重新分类 provider error，也不能让 stream error 通过 bare EOF 成功结束。

必须补的正反证据：

- pre-commit provider failure：进入 Error01-05，可重选，不产生错误 client frame；
- post-commit provider failure：不重选当前请求，进入 health/side-channel，客户端得到规定的终止结果；
- client disconnect：health-neutral，不投影 provider 502；
- body read/transport failure：显式进入错误链，不静默 EOF；
- clean terminal：只由 provider JSON semantic terminal 完成，不由 `[DONE]`/EOF 合成。

状态：未完成。

### F-004：`event:` 仍参与 provider JSON normalization（P1，语义耦合）

证据：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs:80-89` 暴露 `normalize_v3_provider_sse_json_data_for_event_name` 并读取 `event` field；
- 该函数读取 SSE fields 中的 `event`，并在 JSON 没有 `type` 时把 event name 写入 JSON `type`；
- `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`、`shared.rs` 和 relay runtime 调用该 normalization/classification 链；
- 当前 `event:` 与 JSON `type` 不一致时部分路径以 JSON 为准，但“JSON 缺 type 时由 event 补 type”仍使 transport metadata 成为 provider semantic 输入。

根因：provider compatibility normalization 把 SSE envelope metadata 与 JSON semantic document 合并，导致 opaque event contract 在 codec 边界前被破坏。

修复方向：由选定 provider codec 根据 JSON 内容决定是否为合法 semantic event；`event:` 只能保留为 transport metadata，不能写入、补全或选择 JSON semantic type。若某 provider wire 合同确实要求 event-only semantic，必须先登记 protocol codec contract、typed source inventory 和正反 fixture，不能在 generic SSE/runtime helper 中隐式恢复。

必须锁定：event/JSON mismatch、缺 JSON type、event-only frame、`[DONE]`、EOF without terminal、未知事件的正反测试；Direct 与 Relay 共享同一 codec owner。

状态：已修复 generic codec 语义入口：`event:` 不再补 provider JSON `type`；Direct/Relay 反向 fixtures 已通过对应定向测试。后续 caller 只消费 typed codec outcome，不得重新引入 event-name semantic fallback。

### F-005：OpenAI Chat Relay 将无 terminal 的 clean EOF 合成为成功（P1，错误链绕过）

证据：`v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs:431-452` 在 `terminal_seen == false` 时调用 `reducer.materialize_completion()`，并在无 tool call 时把缺失的 `finish_reason` 写成 `stop`；同文件 `:597-610` 的测试 `clean_eof_without_finish_reason_is_stop_without_tool_call` 明确把该行为定义为成功。

这直接违反本任务的 EOF 合同：EOF 是 transport outcome，不能制造 semantic terminal；没有 provider JSON terminal 时必须进入 Error01，并按 Error02-05 决定重试/切换，耗尽后才由 Error06 投影。

最小修复：删除 clean EOF → `finish_reason=stop` 的隐式成功路径；在 selected OpenAI Chat codec/reducer owner 生成 typed non-terminal/EOF failure，由统一 Error chain 消费。保留真正的 provider semantic terminal（例如 JSON `finish_reason=stop` 或合法 `[DONE]` 之后已有 terminal）的正常 closeout。将现有测试改为正反对：无 terminal EOF 必失败；已有 terminal 后 `[DONE]`/EOF 可正常结束。

状态：已修复；clean EOF/no semantic terminal 进入显式失败链，不再合成 `finish_reason=stop`；对应 OpenAI 32-test integration 已通过。

## 6. Gate 失败记录

### `verify:v3-provider-action-gate`

失败类型：source deletion drift、renamed symbol drift、manifest/map drift、package script drift、CI wiring missing。

影响：不能证明 provider action lane、post-commit failure、fresh request admission 和 Direct/Relay provider error path 已按当前 source 锁定。

### `verify:v3-architecture-docs`

失败首先出现在 `verify:v3-resource-relation-edge-lock`：

- provider global cooldown edges 缺 `resource_flow`；
- 部分 edge 的 from/to node 相同；
- side-channel fields 在 edge 外层而非 `resource_flow` 内；
- Direct full-attempt edge 引用了未声明 resource；
- 多个 build/front/SSE resources 没有 mainline edge 引用。

随后会进入 provider-action gate failures。该结果说明 architecture docs 不能作为当前闭环证据。

### `verify:v3-resource-map`

通过。它只证明 resource map 自身检查通过，不能抵消 mainline edge、manifest、symbol 和 CI gate 失败。

## 7. 需要继续的审计矩阵

| 场景 | Direct full-buffer | Relay stream | 必须进入 | 当前状态 |
|---|---|---|---|---|
| clean JSON terminal | buffer release after terminal | client stream close after terminal | typed semantic outcome | 部分有测试 |
| `[DONE]` before terminal | reject/fail | reject/fail | Error01-05 | transport covered; all callers pending |
| EOF without terminal | explicit failure | explicit failure | Error01-05 | caller-wide proof missing |
| malformed SSE | transport error | transport error | Error01 | local transport covered |
| malformed provider JSON | codec error | codec error | Error01-05 | provider codec tests exist; route parity pending |
| provider 401/403/429/5xx | precommit policy | precommit policy | Error04/05 | gate currently broken |
| provider failure after commit | close current stream, no reroute | close current stream, no reroute | health side-channel + Error chain | pending complete proof |
| client disconnect | release/cancel, health-neutral | release/cancel, health-neutral | typed client-disconnect source | pending complete proof |
| body read/write failure | explicit failure | explicit failure | Error01-06 as applicable | server projection needs proof |
| backpressure/idle timeout | typed transport fact | typed transport fact | Error01 if failure | transport local tests only |

## 8. 修复方案顺序

1. 先解决 claim/source ownership：不得在已有 SSE/provider-action worker 的路径上并行造第二份实现。
2. 以当前 source 为准重建 provider-action mainline edges；删除死的旧 file/symbol contract，不恢复死语义。
3. 将 provider JSON typed outcome、client commit state、transport outcome、Error01 source 和 Error05 execution decision 分成明确类型/边；禁止用一个 enum 跨多个拓扑节点代替相邻 contract。
4. 让 Direct full-buffer 与 Relay stream 共享 provider codec、Error chain 和 commit policy；仅保留交付策略差异。
5. 为 F-002/F-003 固化 red/green 正反测试，并接入实际 CI/build gate。
6. 同步 resource/function/mainline/verification maps、manifest、wiki/HTML 和 generated review surface。
7. 在 owner worktree 完成验证后，回当前 dirty main 做集成验证；再安装、`routecodex restart`、全端口 health、同入口 Direct/Relay live replay。
8. 最后执行 AGY Review；只有 PASS 才允许精确 stage、合并 main、commit、push。

## 9. 当前未完成与禁止结论

未完成：完整审计报告的所有入口矩阵、F-002/F-003 全边证明、全部修复、workspace build、安装/重启/live replay、AGY PASS、main merge/commit/push。

禁止结论：不能因为 SSE transport 13/13、局部门禁通过或 resource map 通过，就宣称整个项目已解耦或所有错误已进入 ErrorErr01-06。

## 10. 追加证据（2026-08-27）

- `npm --prefix v3 run test:v3-sse-transport-core`：13/13 passed。
- `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-error --test error_chain_contract -- --nocapture`：14/14 passed；expected panic test 通过，证明 `ProviderFailure` 不能携带内部错误码，且 Error01-06 的局部 projection contract 成立。
- Direct runtime cargo test 未形成可用完成证据：同一 V3 Cargo target 被另一个 canonical test/build 占用，且运行过程中 debug allocation 超过 2 GiB budget；该事实不能替代测试结果。
- `npm run verify:v3-provider-action-gate`：失败，详见 F-001。
- `npm run verify:v3-architecture-docs`：失败，详见第 6 节。

新增判断：现有 Error chain crate 的局部 contract 已有正反覆盖，但 provider action gate、Direct/Relay 调用边与 server client projection 的全链路绑定尚未通过。必须先解决 source/map/manifest/claim ownership，再进入运行时修复，不能用扩大测试或重新运行同一失败命令掩盖结构性漂移。

## 11. 追加证据（2026-08-27，F-005 修复）

- 在独立 owner worktree `/Users/fanzhang/Documents/github/routecodex/playground/v3-chat-eof-terminal-20260827` 先将 `clean_eof_without_finish_reason_is_stop_without_tool_call` 改为负向断言；精确测试先红，复现了原实现把无 terminal EOF 投影为 `finish_reason=stop` 的错误成功。
- 唯一 owner `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs` 已删除 `terminal_seen == false` 下的 completion materialization 和 `finish_reason=stop` 合成，改为 `ProviderResponseEventCodec("...EOF without a semantic terminal")` 显式失败。
- 同步将 `[DONE]` 前无 semantic terminal、完整 tool call 后 EOF 无 terminal 的测试改为失败合同；保留真实 semantic terminal 后 `[DONE]` 的成功正向测试。
- 定向验证：`cargo test -p routecodex-v3-runtime --lib hub_v1::responses_relay_runtime::provider_stream_materialization::tests:: -- --nocapture`，8/8 passed；`git diff --check` passed。
- 修复 commit：`e50dac630`；已精确 cherry-pick 到当前 `main`，生成 `355a4b6e3`。该 commit 只包含上述 runtime 文件，未带入其他 dirty 文件。

F-005 状态：已完成源码修复和局部正反测试；仍待在当前 dirty `main` 完成受影响 workspace 构建、全量架构 gates、安装、聚合重启、在线 Direct/Relay replay 和 AGY Review，因此不能据此宣称全任务完成。

## 12. 追加审计证据（2026-08-27，F-002/F-004 复核）

当前源码仍确认两项未闭环边界：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs:79-123` 的 `guard_relay_sse_first_frame` 直接调用 `normalize_v3_provider_sse_json_data_for_event_name` 和 `classify_v3_provider_sse_json_data`，并据 `V3ProviderResponsesJsonFrameOutcome` 判断首帧 admission、terminal、failure。该逻辑位于共享 relay runtime 骨架，不是 provider JSON codec 的单一 typed-outcome 消费边；需要 owner 重新绑定为相邻 typed contract，避免首帧 guard 复制 provider semantic。
- `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs:320-391`、`v3/crates/routecodex-v3-runtime/src/shared.rs:609-681` 和 `:1262-1302` 也直接做 normalization/classification；`gemini_relay_runtime.rs:717-735` 另行消费相同 outcome。该 caller inventory 证明 F-002 不是单个调用点问题，必须按 provider codec 唯一 owner 做全 caller 迁移和正反回归。
- `provider_sse_json_codec.rs:80-105` 的 `normalize_v3_provider_sse_json_data_for_event_name` 读取 `SseField::Named { name: "event", ... }`，并交由 `normalize_v3_provider_sse_json_data_with_event_name` 在缺少 JSON `type` 时补写 event name。F-004 仍是 confirmed，`event:` 仍会影响 provider semantic；该路径被上述 Direct/Relay callers 共同使用。

本轮未修改上述路径：对应 SSE protocol、provider-action 和 transient-failure claims 仍占用，且当前 gate/source/map 已发生结构性漂移。已写 owner escalation handoff，禁止并行新增第二套 codec、semantic classifier 或 server compensation。

## 13. 当前验证快照（2026-08-27）

- `npm run verify:sse-architecture-boundary`：通过。
- `npm run verify:v3-direct-sse-full-attempt-commit`：通过。
- `npm run verify:v3-direct-sse-accept-skeleton`：通过。
- `npm run test:v3-sse-transport-core`：13/13 通过。
- 在 `v3/` 目录执行 `CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-error --test error_chain_contract -- --nocapture`：14/14 通过，包含预期 panic、provider failure polarity、exhaustion-only Error06、client disconnect health-neutral。
- `npm run verify:v3-architecture-ci`：失败于已有 file-size ratchet 漂移，已通过 8/48 后停止；当前失败文件包括 `provider_failure_runtime_policy.rs`、`kernel.rs`、`health.rs` 等，不能作为本任务完成证据。
- `npm --prefix v3 run verify:v3-provider-action-gate`：失败；仍包含 deleted source、stale symbol、map/manifest drift、缺失 CI wiring 和当前 source caller 不匹配，详见 F-001。
- 从 repo root 执行 `npm run test:v3-error-contract` 会因 root script 指向不存在的 `scripts/run-v3-cargo-test.mjs` 失败；在正确的 `v3/` 工作目录执行已通过。该命令路径差异已记录，不能把 root wrapper 失败误报为 Error chain 代码失败，也不能把正确目录的局部通过扩大为全量通过。

## 14. 新增 client/SSE projection 风险（待 owner 闭环）

- `v3/crates/routecodex-v3-server/src/frame_builders.rs:674-777` 的 `v3_io_sse_body_for_protocol` 在 body stream error、panic 或 IO failure 时由 server SSE transport owner 调用 `raise_v3_sse_runtime_failure` 并直接构造 client error frame。当前代码注释称其为 Error06 projection，但仍需用 source/map/call-map 证明该错误已具有完整 Error01→05 decision，而不是 server transport 在 commit 后自行生成第二错误路径；同时需要正反测试证明 client disconnect 不进入该分支、body failure 不变成 EOF、post-commit 不 reroute。
- `v3/crates/routecodex-v3-server/src/endpoint_handlers.rs:14-25` 的 `v3_front_json_body_to_sse_frame` 对无法解析的错误 body 使用 `unwrap_or_else` 替换为固定 `front_json_error`。这属于潜在 silent fallback/错误信息覆盖；必须确认输入是否由 typed Error06 保证为合法 JSON。若不能证明，应在 owning boundary fail-fast 并进入统一错误链，不能由 client projection 猜测或替换错误。

以上两项暂不修改：前者属于 Direct/Relay client front owner，后者属于 server client projection owner，现有 claims 与本审计 run 之间存在路径交叠。已纳入报告和 owner escalation，不能用当前局部测试通过替代闭环证据。

追加运行证据：在当前 `main` 执行 `cargo +stable test --locked --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib provider_failure -- --nocapture` 时，6 个测试中 4 个并行失败，表现为 `V3ProviderHealthStore` 初始化期间 `provider cooldown startup probe reset failed: commit provider cooldown state: No such file or directory`。随后按项目 provider-action gate 要求加 `--test-threads=1` 重跑，6/6 通过；因此前次失败是共享持久化测试状态的并行竞争/临时路径问题，不能继续作为代码失败结论，但并行执行稳定性仍是剩余验证风险，需由 health/persistence owner 明确隔离或证明其可接受性。

同一当前 `main` 上 `cargo +stable test --locked --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib direct_stream -- --nocapture`：2/2 passed，证明现有 Direct Error06 SSE projection 的两个局部合同仍成立，但不能抵消 provider-failure 初始化失败和全链路 gate 失败。

## 15. 最新收口证据（2026-08-27）

- 通过 `npm run compile:v3-build-admission` 重新生成 admission view，避免 source map 与 build-contracts view 分叉；结果 `PASS files=496`。
- 通过 `npm run verify:v3-resource-relation-edge-lock`：`153 resources bound through 439 edge resource_flow payloads`。本次补齐了 provider cooldown、build/install、front client-frame、Anthropic SSE 资源边，并修正 Direct typed projection / hook catalog 的同节点边及 post-commit probe 的 resource-flow 层级。
- `npm run verify:v3-provider-action-gate`：通过，49 条 machine edges 与 source/map/manifest 一致。
- `npm run render:v3-mainline-caller-flow`：通过，已更新 Markdown 与 HTML review surface。
- `npm run verify:v3-mainline-caller-flow`：仍失败，但剩余仅为 3 个已锁定 chain 的 fingerprint 变化，要求 Jason manual authorization；不再有 wiki/html drift 或 resource-edge 结构错误。
- 为隔离 controlled integration helper 的测试间共享持久化污染，`execute_v3_responses_relay_runtime_with_retry_policy` 改用显式 `from_manifest_without_persistence`；生产 server 仍通过显式 provider health handle 进入持久化 owner。Hub closeout 隔离串行结果由此前 7/26 提升为 15/26，但仍有 11 项失败，未视为完成。
- 最新 Hub closeout 失败已不再主要表现为跨测试 cooldown 污染；剩余问题包括 request-compat reselect 状态码、response-decode/retry attempts、concurrent compat reselect、Error06 code-only message 断言以及 provider cooldown fixture 时间断言。相关 runtime/test 路径已有 active provider-failure owner，需按该 owner 的 Error04/05 合同继续收口。
- `cargo test -p routecodex-v3-runtime --test gemini_relay_runtime_integration -- --nocapture`：20/20 通过。
- `cargo test -p routecodex-v3-runtime --test responses_direct_remote_continuation_integration -- --nocapture`：29/29 通过。

当前仍禁止 install/restart/live replay/review/commit/push，原因是：

1. Hub closeout 尚未全绿；
2. `v3.hub_pipeline.v1.relay_response_source_slice`、`v3.provider_action_gate.mainline`、`v3.build_test_artifact_budget` 三个 audited locked chain 的 fingerprint 变化尚未有显式 manual authorization；
3. 所有 provider/client/SSE 全链路的运行版本一致性和在线真实样本证据尚未取得。

补充：`npm run test:v3-gemini-relay-runtime-integration` 的 runtime 子套件已通过，但 server controlled 子套件在首个 SSE body chunk 断言失败；该首 chunk 可能是 Server-owned keepalive，属于 client connection/keepalive owner 的合同问题，不能由 provider codec 或 SSE transport 猜测修复。`cargo fmt --manifest-path v3/Cargo.toml --all -- --check` 也受当前 main 中其他 worker 未格式化改动影响，未作为本任务绿证据。

## 16. 收口复核（2026-08-27，当前轮）

- 已登记本轮 Jason 授权并刷新三条 audited lock：`relay_response_source_slice`、`provider_action_gate.mainline`、`build_test_artifact_budget`；新 fingerprint 与 canonical caller map 一致。
- 修复 admission gate 的包边界：admission workspace 继续使用 V3 包作为工作区包，provider-action 校验器在 admission 环境使用对应相对脚本合同；根目录 gate 继续校验根包合同。`npm run verify:v3-mainline-caller-flow` 已通过。
- 该阶段曾因 `verify:v3-responses-session-admission` 的 canonical contract 漂移停止；随后已在本轮完成 async admission owner、map/manifest/wiki 同步并通过该 gate。
- 报告仍保持 `blocked_before_review`，当前真实 blocker 是 Hub closeout 15/26（11 failures）、Gemini server controlled keepalive/client-frame 合同，以及尚未完成的 workspace build、安装、重启、在线 replay、AGY Review、commit 和 push。

## 17. 收口复核（2026-08-27，本轮最新）

- `npm run compile:v3-build-admission`：通过，admission lockstep `files=496`。
- `npm --prefix v3 run render:v3-mainline-caller-flow`：通过，Markdown/HTML review surface 已按 canonical mainline map 重生成。
- `npm run verify:v3-architecture-docs`：通过；最终结果为 `docs: 26`、`resources: 153`、`edges: 438`。此前记录的 resource permission、invalid status、退役 `direct_sse_provider_outcome.rs` 和旧 caller symbol 阻断已完成 source/map/manifest 对齐，未恢复退役实现。
- `npm run verify:sse-architecture-boundary`：通过；SSE transport 保持 protocol-neutral，runtime roots 不导入 TS SSE wrapper。
- `npm run test:v3-provider-action-gate-red-fixtures`：通过，53 个 forbidden mutations rejected。
- `npm run test:v3-responses-session-admission-red-fixtures`：通过，18 个 forbidden mutations rejected。
- `npm run test:v3-runtime-timing-observability-red-fixtures`：通过，23 个 forbidden mutations rejected。
- 上述架构/红测通过不等于全任务完成。`hub_relay_runtime_closeout` 仍为 15/26，11 个失败仍归属 active provider-failure/session lifecycle owner；已写 handoff request，未越权修改该 owner scope。
- 由于 Hub closeout、server controlled Gemini keepalive/client-frame 合同、workspace/build/install/restart/live replay 尚未全部闭合，本报告继续保持 `blocked_before_review`；仍禁止 AGY Review、commit、push。

## 18. 当前轮 owner/根因复核（2026-08-27）

- 协作视图复核：`main` 与 `origin/main` 均为 `b62e7b877cc4348cee0e235a8099e24b2eb0a01b`；工作树仍含其他 worker 的 tracked/untracked 改动。本审计 run 未执行 reset、checkout、stash、broad cleanup 或 broad staging。
- `feature_id:v3.provider_failure_policy` 的 owner claim 仍为 active，owner run 为 `20260730T194230Z-Macstudio.local-sessoncooldown`，scope 覆盖 Hub Relay closeout 所需的 provider action/failure policy/runtime test 路径；当前只有 handoff request，没有 checked handoff，因此本 run 未修改该 scope。
- `gate_id:v3_silent_sse_restart_closeout_20260825` 与 Direct SSE keepalive 相关 claims 仍占用 server client-frame/keepalive owner；Gemini controlled test 的首 chunk 合同仍未获得 owner 结论，因此未让 provider codec 或 SSE transport 猜测、跳过或重写 keepalive。
- 新鲜 Hub closeout 输出 `/tmp/sse-hub-closeout-isolated-3.out` 的 11 个失败可归类为：
  - request-compat reselect 仍在 Error05 投影前得到 HTTP `598`，期望成功重选后的 `200`；
  - default-floor fixture 实际 attempts 为 `3`，测试期望 `5`，说明 manifest retry budget 与 fixture contract 不一致，不能直接改断言；
  - cooldown fixture 实际 `63000ms`，期望 `903000ms`，说明 provider health/backoff owner 与测试策略不一致；
  - response-decode/reselect 实际 provider capture 数量为 `4`，测试期望 `7`；
  - malformed SSE、body-read、missing-terminal、duplicate-tool 场景的错误消息断言与当前 typed Error06 code-only projection 不一致，必须先确认 canonical projection contract；
  - 并发 compat 场景实际仍把请求错误投影为 `598`，尚未证明 request-local reselect 与共享 action/health gate 的边界正确。
- 这些观察证明当前 blocker 是 Error04/05 provider-failure policy、health/backoff 生命周期与测试 manifest contract 的 owner-level 偏离，不是 SSE transport 可以补偿的 framing 问题；在 checked handoff 或 Jason 明确 owner authorization 前，继续禁止 install/restart/live replay/AGY review/commit/push。

## 19. 当前轮 source-level 首次偏离补证（2026-08-27）

- `git blame` 与历史 diff 确认 `v3/crates/routecodex-v3-server/src/endpoint_handlers.rs:15-24` 的首次偏离来自 commit `0863698b9`：`v3_front_json_body_to_sse_frame` 从原始 bytes framing 改为 `serde_json::from_slice(...).unwrap_or_else(...)`，在 client projection owner 内引入 `front_json_error` 替代路径，并由该层重新生成 `response.failed` JSON。该证据确认这是 server/client projection 边界的真实风险，不是单纯测试文案差异。
- 同一文件 `:143-146` 已将 transport-only `: keepalive\\n\\n` 排除出 `emitted_response_frame`，因此首个 body chunk 不含 provider 内容本身不能证明 provider 丢帧；当前必须由 server keepalive owner 明确“首 chunk 可为 transport keepalive”的合同，并由测试消费 transport frame 后再断言 provider semantic frame。
- `v3_front_sse_worker_panic_frame`、body-read failure、empty response 等路径均在 server layer调用 `raise_v3_sse_runtime_failure` 后再经 `v3_front_json_body_to_sse_frame`；在该 helper 对非法 JSON 仍 silent replacement 的前提下，Error06 typed body 的完整性尚未被证明。该问题保留为 owner finding，未在非授权 scope 内修复。

## 20. 当前轮集成验证（2026-08-28）

- 最新主线已核对：`git fetch origin` 后本地 `HEAD=origin/main=aabccfe9d3079498e0f5384d38c87ad0da987426`，ahead/behind 为 `0/0`。
- `hub_relay_runtime_closeout`：26/26 通过；provider key 默认冷却验证为 `3_000 + 900_000 = 903_000`，response codec/duplicate-tool/request-compat 重选与错误链测试均通过。
- 架构门禁通过：`compile:v3-build-admission`、mainline render、`verify:v3-architecture-docs`（26 docs/153 resources/438 edges）、provider action gate、responses session admission、runtime timing observability、SSE architecture boundary，以及对应 red fixtures（18/23；provider-action fixture 脚本当前无稳定 stdout/exit 证据，未计为通过）。
- V3 workspace build 通过；全局安装版本为 `rccv3 0.90.4681`。按要求只执行一次 `routecodex restart`，instance=`v3-5bf9213cfdaa3d44083e`；7777 与 4444 `/health` 均返回 `status=ok`、`manifest_version=3`。
- 在线同入口旧样本 replay：7777 `/v1/responses` 返回 HTTP 200 SSE 并收到 133337 bytes；4444 返回 HTTP 200 SSE headers，但 90s replay 期间只收到 390 bytes transport keepalive，未收到 provider/client semantic frame，不能判定 Relay 成功。该 live Relay 连接/终端收口问题是当前 blocker。
- 追加实时证据：4444 request record 显示旧样本实际选中 `qwen-q4-huihui-local:key1:Huihui-Qwen3.8-27B-abliterated-oQ4e-mtp`（`pool=search`，`execution_mode=relay`），之后仅保持 keepalive；同入口小请求在 `pool=thinking` 也未获得 header/body；显式 `deepseek-v4-flash` 与 `MiniMax-M3` 请求分别返回 `503 selected_target_exhausted`（11/1 candidates unavailable）。这证明当前 live blocker 是 configured provider availability/response completion，尚未证明 Relay semantic closeout；未修改路由或增加 fallback。
- `cargo fmt --check` 仍被其他 worker dirty 文件阻断，未执行 broad formatter；AGY Review、精确 staging、commit、push 均未执行。报告状态继续为 `blocked_before_review`。

## 21. 最新 main 合并后集成复测（2026-08-28）

- 已执行 `git fetch origin` 与 `git merge --ff-only origin/main`；结果 `Already up to date`。当前 `main` 为 `d86f9aa5`，包含最新 `origin/main=aabccfe9`，本地额外提交为其他已存在变更，未将其误归入本审计 change set。
- Provider action 反向红测重新取得稳定证据：53/53 forbidden mutations rejected。
- `hub_relay_runtime_closeout` 在该基线通过：26/26。V3 workspace build 通过；全局安装与聚合重启完成，运行版本 `rccv3 0.90.4682`，instance=`v3-5bf9213cfdaa3d44083e`。
- 重启后两个配置 listener health 均通过：7777 与 4444 均为 `status=ok`、`manifest_version=3`、`build_version=0.90.4682`。
- 同一旧 Responses 样本真实回放：7777 Direct 返回 HTTP 200、SSE、263692 bytes，并出现 `response.created`；4444 Relay 返回 HTTP 200 SSE headers，但 45 秒内仅收到 195 bytes keepalive，未收到 provider/client semantic frame，curl 以超时退出。该结果仍不能判定 Relay 成功。
- 4444 的 Relay live semantic closeout 仍是外部 managed provider response-completion blocker；未修改 provider、路由、health 状态或加入 fallback。由于 Relay 真实回放未闭环，状态继续为 `blocked_before_review`，禁止 AGY Review、精确 staging、commit 与 push。
