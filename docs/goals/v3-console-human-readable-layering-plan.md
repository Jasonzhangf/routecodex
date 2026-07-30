# V3 Console Human-Readable Layering — Implementation Plan

## Goal & DoD

V3 server console 输出的每个 routed 请求/响应都成「一层人类可读 headline + 空行 + 完整 dim 诊断」两层结构；其它控制台行（error / stopless / provider-failure / provider-switch / provider-unavailable / startup / health frame error）同样走 layered 形状；不再做 string reparsing；不破坏 request/response payload、routing、provider health、error policy、timing ownership。

DoD：
- Source closeout：console/server tests、Server+Runtime check、maps/manifests/gates 全绿，Codex review verdict PASS。
- Live closeout（单独一轮）：真实 5520 request 经 managed V3 install/restart 后看到 1 个 request block + 1 个 response block，两块都满足分层格式。
- 未执行 live closeout 前，只能声明 source closeout，不能声明 5520 已安装或视觉效果已在线生效。

## Scope

In scope：
- `v3/crates/routecodex-v3-server/src/lib.rs` console 投影与对应单测。
- `v3/crates/routecodex-v3-error/src/lib.rs` SSE closeout typed Error01 raise API 与正反测试；错误分类/链构造仍由 error crate 唯一拥有。
- 全局 + V3 function / resource / mainline / verification map、mainline manifest、`render:v3-mainline-caller-flow` 同步。
- 测试断言更新（`console_layering_keeps_request_debug_fields_off_human_headline`、`console_layering_promotes_human_scope_and_response_facts_before_debug_details`、provider-failure / error_projection / stopless 测试）。

Out of scope（保留 dirty worktree，不在本次清理）：
- `v3/crates/routecodex-v3-server/src/lib.rs` 的 `health()` 里 `build_version` 来自 `current_exe` 的 hunk。
- multi_listener_server 测试。
- routecodex-v3-runtime / provider-compat-core / anthropic_codec / route-classifier-core 改动。
- 全局 install / release（live closeout 单独一轮，受 stale global install claim 阻，必须先 resolve claim transfer）。

## 设计原则

1. **typed layered builder**：所有 console 行通过 `V3ConsoleLayeredBlock` 拼出 `[port:protocol][project][route:model] {headline}\n\n  [sessionID:{safe}] {debug}`；`headline` 和 `debug` 是独立 typed 字段，colorizer 绝不 split 渲染文本。
2. **typed headline fields**：routed request/response 的 headline 由调用方按 typed 字段（status / finish_reason / elapsedMs / transport / usage_in / usage_out / usage_cache / usage_total / time_i / time_e / time_t）拼出，不解析 dim content；`time_i/time_e` 只消费 Runtime 发布的 typed timing。成功响应缺 timing 时显式投影 observability contract failure，禁止显示 `unreported`，也禁止由 Server 合成数值。
3. **no fallback**：colorizer 看到空 headline 或 debug 直接 panic，绝不退回单行渲染。
4. **唯一 owner**：`routecodex-v3-server` 拥有 console 投影；runtime / virtual-router / provider-responses 不写 console，不写分层。
5. **no payload mutation**：metadata / request payload / response payload / SSE 字节不进 headline。
6. **真实 observability**：routed request/response block 当前只接 Responses Direct/Relay 的真实 runtime observability；Server 不为 OpenAI Chat / Anthropic / Gemini Relay 伪造 completed/relay/provider/model/usage/attempts。
7. **颜色与列宽**：完整 human line 使用 request/session color（错误红色、Stopless 橙色）；只有完整 diagnostic line 使用 dim。human 三列严格限制为 24/20/36 terminal display-width，超长 ASCII/CJK 中间截断；diagnostic session scope 宽 52。
8. **路由真相 fail-fast**：human prefix 与 headline 消费同一个 `V3ConsoleRouteProjection`；缺少 `pool_id` 与 `routing_group_id` 时 panic，不生成 `route:selected` 或其它成功态占位。
9. **错误链真实对象**：Relay 首次观察到 SSE failure 时把 observation 交给 error owner 的 `raise_v3_sse_provider_failure`；Direct 保留 provider stream 已给出的原始 typed Error01；client disconnect 在 `V3ServerRespOutbound06ClientFrame` 调用 error owner 的 `raise_v3_sse_client_disconnect`。HTTP/SSE 已提交后的 closeout 只能投影该 Error01 到 console 并让流显式失败，不能伪造 route/default exhaustion 或 Error06；只有请求仍可执行路由策略时，Runtime 才能基于真实 availability 生成 terminal Error05→Error06。Server 不拥有 Error builder/classifier，禁止 typed error 降成字符串后重建。Error01→Error06 的相邻错误链唯一归 `v3.debug_error_foundation.mainline`；Console 只消费已构造的 Error01 或 Error06。
10. **terminal output 资源**：stdout/stderr 是 Server-owned `v3.console.terminal_output`；startup 与 debug-sink failure 不得伪登记为 `v3.debug.artifact` 成功写入。

## 技术方案

### 1. typed layered builder

```rust
V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id)
```

plain/color renderer 都拼 human_prefix + headline + `\n\n  [sessionID:...] ` + debug。session_id 走 safe-label；超长值中间截断以保持列宽，并在 diagnostic 尾部保留 `sessionIDFull`。

`colorize_v3_layered_console_line(block, headline_color, debug_color)` 对完整 human line 和完整 diagnostic line 分层着色；缺 headline/debug 即 panic（fail-fast）。

### 2. routed request/response headline 字段构造

`emit_v3_request_start_console_line_for_observability` → headline fields：
- timestamp（用 `format_v3_console_timed_content` 内部生成的同一 `console_timestamp_hhmmss()`）
- `req={request_id}` → 进 debug
- headline 只显示 `▶ [/v1/responses]` + 时间戳 + `route={route_label}` + `target={provider_target}` + `reason={reason}`

`emit_v3_request_complete_console_line` → headline fields：
- timestamp + `✅ [/v1/responses]` + `status={status}` + `responseStatus={response_status}` + `finish_reason={finish_reason}` + `elapsedMs={elapsed_ms}` + Runtime 已发布的 numeric `usage_in/out/cache/total` + numeric `time_i/time_e` + `time_t` + `transport`
- debug 行保留完整原 content（status / finish_reason / reason / usage / typed timing availability / nodes / transport 等）；Server 只拥有 total elapsed，不声称 internal/external timing 真值

其它行（error / stopless / provider-failure / provider-switch / provider-unavailable / startup / frame error）→ typed block 内 headline/debug 独立传递（保持双层形状 + 完整诊断）。

### 3. 路径调度

- `pending_endpoint` 中已删 pre-route pending；Responses Direct/Relay routed request/response 由 `emit_v3_observability_console_lines` 消费真实 Runtime-owned `V3RuntimeObservability`。
- 原始 HTTP 入口仍由 debug ledger 记录 `V3Server03HttpRequestRaw/received`；人读 Console 不再额外打印 route/model 为 `-` 的 pre-route block。
- provider-request dry-run 不进入 routed console observability：Server 侧 synthetic `build_v3_foundation_console_observability` 已物理删除；若退役的 `pool_id=dry_run` / dry-run target path 意外进入 resolver，立即 panic。
- OpenAI Chat / Anthropic / Gemini Relay 不接 synthetic Server observability；等待各自 runtime owner 发布真实 observability 后再接。
- error 行：`emit_v3_error_console_line_*` 内部使用 typed layered block。
- SSE closeout error：Server 只报告首次观察到的 Relay provider failure 或 client disconnect，Error01 由 `routecodex-v3-error` 的专用 raise API 构造；Direct stream 原始 Error01 直接进入 `emit_v3_post_commit_sse_source_console_line_for_context`。closeout 不再制造 Error06 ledger；provider action gate 的后续请求与真正 terminal Error05 仍由 Runtime/Error owner 处理。
- provider-failure / provider-switch：保留 `format_v3_console_line_for_observability` → 内部改为新 layered helper。
- stopless：保留 `emit_v3_stopless_console_line` → 内部用新 layered helper。

### 4. 测试断言修复

- `console_layering_keeps_request_debug_fields_off_human_headline`：断言 headline 不含 `req=`, `event=`, `stream=`, `acceptsSse=`, `rawInputItems=`, `preparedInputItems=`, `plannedEntryMode=`；debug 行包含。
- `console_layering_promotes_human_scope_and_response_facts_before_debug_details`：断言 headline 含 `status=`, `responseStatus=`, `finish_reason=`, `elapsedMs=`, `transport=`；不含 `req=`, `event=`, `nodes=`（这些放 debug）。
- `provider_failure_console_content_exposes_red_error_and_switch`：断言 layered 形状（headline + `\n\n  [sessionID:...]` + debug）。
- `error_projection_appends_human_console_failure_line`：同上。
- `stopless_console_activation_requires_action_stop_and_uses_fixed_orange`：同上。
- 新增：`routed_observability_emits_exactly_one_request_block`，只锁当前真实 Responses observability。
- 新增：human prefix 24/20/36 固定 terminal width，oversized ASCII/CJK 中间截断；human line 不含 `ANSI_DEBUG_DIM`；short/UUID/oversized session 的 machine 字段列一致且保留 full id。
- 新增：缺失 route truth 必须 panic；禁止 `route:selected` 伪真相。
- 新增：退役 dry-run observability 必须 panic；成功响应缺 typed Runtime timing 时必须显式输出 observability contract failure，成功 headline 禁止 `time_i/time_e=unreported`。
- 新增：成功响应缺 `response_status` / `finish_reason` 时同样显式输出 observability contract failure；缺 usage 时人读 headline 省略 usage 字段，完整 machine/debug 行保留 `usage=unreported` 诊断，禁止在亮色人读行显示任何 `unreported`。
- 新增：Direct SSE transport failure 保留原始 Error01 kind/stage/code/message/links，流显式失败，且不会在缺少 route/default availability proof 时制造 Error06 ledger event。
- 新增：client disconnect 的 Error01 stage 固定为 `V3ServerRespOutbound06ClientFrame`，console status 为 499，不进入 provider health/action gate，也不制造 Error06。
- 新增：console mainline 只登记 Error01→Console 与 Error06→Console 投影；canonical adjacent `V3Error01SourceRaised`→`V3Error06ClientProjected` 由 `v3.debug_error_foundation.mainline` 唯一拥有；normal console edge 不伪读 debug artifact；所有直接 stdout/stderr emitter 登记为 `v3.console.terminal_output` writer。

### 5. 风险与规避

- **R1：panic 暴露到生产**：no-fallback 是有意设计；仅在 typed builder 输入不完整时触发，单元测试和 live closeout 必须覆盖。
- **R2：headline 字段遗漏**：用 `V3ConsoleRequestHeadline` / `V3ConsoleResponseHeadline` 保持 request/response headline 构造独立可测。
- **R3：dirty worktree 污染**：本轮只精确改上述文件，绝不 reset/checkout；CI gate 不该因为 dirty 工作区就 fail。
- **R4：global install stale claim**：`~/.rcc/install/current/dist/bin/rccv3` 与 `.agent-collab/claims/resource_id:v3.global_install.current/owner.json` 仍归 `20260728T073640Z` 旧 run，必须等 Jason 拍板做受控 claim transfer 才能 install/restart。
- **R5：伪造 observability truth**：Server synthetic observability builder 已物理删除，包括 provider-request dry-run；maps 和 tests 明确 routed block 当前只覆盖 Runtime-owned Responses Direct/Relay truth。

### 6. 验证矩阵

1. `cargo +stable fmt --manifest-path v3/Cargo.toml --all -- --check`
2. `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-server console --lib`
3. `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib`
4. `cargo +stable check --manifest-path v3/Cargo.toml -p routecodex-v3-server -p routecodex-v3-runtime`
5. `npm run render:v3-mainline-caller-flow`
6. `npm run verify:function-map-compile-gate`
7. `npm run verify:architecture-mainline-call-map`
8. `npm run verify:v3-architecture-docs`
9. `npm run verify:v3-rust-only`
10. `npm run verify:v3-module-boundaries`
11. Codex review continuation cycle → 明确语义 `VERDICT: PASS`
12. （live closeout）`RUSTUP_TOOLCHAIN=stable npm run install:v3` + `rccv3 restart -c /Volumes/extension/.rcc/config.v3.toml` + `curl -fsS localhost:5520/health` + 真实 5520 `/v1/responses` request + 抓 stdout 抓 human log，验证 1 request block + 1 response block

### 7. 实施步骤（顺序）

1. 在 `v3-server/src/lib.rs` 引入 `V3ConsoleLayeredBlock`、`V3ConsoleRequestHeadline`、`V3ConsoleResponseHeadline`；改 color/plain renderer 接收 typed block（缺 headline/debug panic）。
2. 改 `emit_v3_request_start_console_line_for_observability` / `emit_v3_request_complete_console_line` 调用 typed headline builder。
3. 改 error/provider-failure/switch/unavailable/stopless/startup/frame-error 投影 → 全部走 typed layered builder。
4. `cargo fmt` + console 单测 + full server lib + cargo check。
5. 修测试断言。
6. 同步全局 / V3 maps、`render:v3-mainline-caller-flow`。
7. 启动新的 Codex review continuation cycle；必须得到明确语义 `VERDICT: PASS`，FAIL 则按 finding 修复并复审（本 cycle 上限 5 轮）。
8. 报告本轮；live closeout 单独等 Jason 授权。

### 8. DoD 完成定义

- Source closeout：验证矩阵 1–11 通过。
- Codex review PASS。
- 全局 / V3 map + manifest + wiki HTML 同步，gate 全绿。
- dirty worktree 中与本任务无关的改动保持原样。
- Live closeout 保持独立：未运行第 12 项前不声称 installed/live。
