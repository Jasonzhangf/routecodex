# V3 Four Major Missing Modules Worker Goals

本文档把下一批 V3 大模块拆成四个可并行 worker goal。详细实现计划复用各自 canonical goal 文档；这里仅保留分发给 worker 的 `/goal` 提示词。

## 选择依据

- `v3.hub_relay_runtime_closeout`：已有 request/response/resource/copy-probe slices，但还需要受控 Relay E2E 收口，证明 local continuation、servertool hook、one-response-exit。
- `v3.gemini_relay_runtime_integration`：Gemini codec 已有 characterization，但 `/v1beta/models/:model/generateContent` 仍需要进入 controlled Relay Runtime。
- `v3.responses_inbound_websocket_proxy`：provider/upstream WebSocket transport 已有 owner，但 client-facing `/v1/responses` WebSocket inbound proxy 仍缺独立 Server transport shell。
- `v3.virtual_router_full_function`：当前 V3 路由仍需完成完整 pool-match/default-floor/one-shot target handoff，避免后续 provider availability、筛选和默认池语义继续靠临时实现。

## 并行规则

- 每个 worker 开工前必须刷新 `.agent-collab/PROTOCOL.md`，按 `feature_id:*` claim，写 `actor.json`、`heartbeat.json`、`events.jsonl`、`evidence.jsonl`。
- 只改自己 goal 允许的 owner surface；共享 map/wiki/package/scripts 先查 active claim，冲突时走 handoff/merge-queue。
- 不碰 V2、`~/.rcc`、live config、install/restart/release、凭据、P6 deletion，除非 Jason 后续明确授权。
- Hub/Relay/Chat Process 语义 Rust-first；TS 只允许薄 shell/IO/诊断。
- 先红后绿；没有 focused gate + red fixture + architecture gate 证据，不宣称完成。

## Worker A — Hub Relay runtime closeout

```text
/goal
目标：完成 `v3.hub_relay_runtime_closeout`，把已完成 request/response/resource/copy-probe slices 合并成 controlled Relay E2E，覆盖 local continuation、servertool runtime hook、Error01-06 和 one-response-exit。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-hub-relay-runtime-closeout-plan.md

执行规范：
- 先刷新 `.agent-collab` 并 claim `feature_id:v3.hub_relay_runtime_closeout`；发现 active owner 时先避让或 handoff。
- 只做 Relay closeout edge/harness/gate，不重写 Gemini/OpenAI/Responses/lifecycle owner。
- continuation 只允许 Resp04 save、下一轮 Req03/Req04 restore；servertool 不得生成第二 response exit。
- 禁止 fallback、dynamic hook、P6 shortcut、full payload/SSE materialization、metadata/debug/control payload 泄漏。

验证：
- `npm run test:v3-hub-relay-runtime-closeout`
- `npm run verify:v3-hub-relay-runtime-closeout`
- `npm run test:v3-hub-relay-runtime-closeout-red-fixtures`
- Relay copy-budget、resource/map/module/Rust-only/static-hook/fmt/clippy/workspace/diff gates

完成标准：
- Controlled Relay JSON/SSE E2E 经过固定 Req01-Req09 + Resp01-Resp06。
- local continuation + servertool hook roundtrip 可用且只有一个 client response exit。
- P6 deletion/live cutover/global install/restart 仍明确 pending，等待 Jason 另行授权。
```

## Worker B — Gemini Relay runtime integration

```text
/goal
目标：完成 `v3.gemini_relay_runtime_integration`，把 Gemini `/v1beta/models/:model/generateContent` 从 explicit pending 推进到唯一 Hub v1 Relay controlled Runtime JSON/SSE/error/isolation 闭环。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-gemini-relay-runtime-integration-plan.md

执行规范：
- 先刷新 `.agent-collab` 并 claim `feature_id:v3.gemini_relay_runtime_integration`。
- Gemini 差异只写在 Gemini codec/provider runtime owner；Hub/VR/Server 禁 provider-specific 分支。
- Server 只消费 entry binding registry；Gemini endpoint 从 `pending_not_implemented` 变更必须有红测和 controlled runtime 证据。
- 禁止 fallback、Responses Direct 混入、SSE materialize、history/tool repair、metadata/debug/control payload 泄漏。

验证：
- Gemini focused Runtime JSON/SSE/error/isolation tests
- Server endpoint binding controlled test
- `verify:v3-gemini-relay-runtime-integration` 与对应 red fixtures
- V3 architecture/resource/module/Rust-only/fmt/clippy/workspace/diff gates

完成标准：
- Gemini endpoint 进入唯一 Hub v1 Relay mainline，controlled JSON/SSE/error/isolation 全绿。
- map/manifest/wiki/package gate 全同步。
- 不声明 live provider/global production 可用。
```

## Worker C — Responses inbound WebSocket proxy

```text
/goal
目标：完成 `v3.responses_inbound_websocket_proxy`，补齐 client-facing `/v1/responses` WebSocket inbound proxy，让 Codex Responses WebSocket mode 能从客户端连入 RouteCodex 并进入既有 V3 Runtime/Provider path。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-responses-inbound-websocket-proxy-plan.md

执行规范：
- 先刷新 `.agent-collab` 并 claim `feature_id:v3.responses_inbound_websocket_proxy`。
- Server 只拥有客户端 WebSocket upgrade/framing shell；provider/upstream socket state 仍归 `v3.responses_websocket_v2_transport_hardening`。
- WebSocket 失败不得 HTTP fallback；Server 不恢复 continuation/history/tool，不创建第二 Runtime kernel。
- 禁止 full event materialization、provider socket state 写进 Server、metadata/debug/control payload 泄漏。

验证：
- inbound WebSocket handshake/client event controlled tests
- JSON/SSE/tool/error/disconnect/cancel matrix
- `verify:v3-responses-inbound-websocket-proxy` 与对应 red fixtures
- V3 architecture/resource/module/Rust-only/fmt/clippy/workspace/diff gates

完成标准：
- Controlled client WebSocket `/v1/responses` path 可用，并进入唯一 V3 Runtime/Provider owner。
- Provider WebSocket transport owner 保持独立。
- 不改 live config、凭据、global install/restart，不声明 production cutover。
```

## Worker D — Virtual Router full function

```text
/goal
目标：完成 `v3.virtual_router_full_function`，把 V3 Virtual Router 收口到完整 route-pool match、mandatory default floor、one-shot opaque target handoff 和 Target-local continuation/exhaustion 语义。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-virtual-router-full-function-plan.md

执行规范：
- 先刷新 `.agent-collab` 并 claim `feature_id:v3.virtual_router_full_function`；若 Config pool-match schema 有 active owner，先 handoff。
- VR 只消费 typed request facts + published manifest，产出一个 immutable selection plan 和一个 opaque target handoff。
- default pool 是声明内的 routing floor，不是 fallback；provider failure 后不得 re-enter VR。
- VR 禁读 provider health/error/retry/transport/expanded forwarder；Target 才能解释 target 与做 target-local reselection。

验证：
- VR match/precedence/default/priority/weight/round-robin/one-shot unit tests
- Target/Runtime integration：success、provider failure、optional exhaustion、default continuation、total exhaustion
- compile/source red fixtures：second VR hit、VR health import、Target -> VR reentry、Server route selection、provider-specific branch
- V3 architecture/resource/module/Rust-only/fmt/clippy/workspace/CLI routing/diff gates

完成标准：
- 每个请求只产生一次 VR hit，初始 plan 同时包含 matched optional tier 和 mandatory default floor。
- Target 内部负责 expansion、availability projection、target-local reselection 和 full exhaustion。
- Hub/VR 无 provider-specific 条件、无 fallback、无二次路由入口。
```
