# V3 Responses Direct Remote Continuation Integration Plan

## 1. 目标与验收标准

把现有 Rust remote continuation locator/store/codec 接入 V3 Responses Direct 固定流水线，使 provider-owned `response_id/previous_response_id` 在下一轮 tool output 请求中按原 provider/model/auth pin 续接，并通过受控 upstream 与真实 5555 同入口验证。

验收标准：

- 只在 `V3HubRespContinuation04Committed` commit，只在下一轮 `V3HubReqContinuation03Classified` load，并在 `V3HubReqTarget06Resolved` 执行 exact pin。
- direct continuation 不进入 Relay/local materialization，不重新选 provider，不回到 Virtual Router。
- entry/owner/session/conversation/port/group/provider/model/auth/capability revision 全量隔离。
- success、failure、still-running、already-terminal 正反状态闭环；错误显式进入 V3 Error01-06。

## 2. 范围与边界

In scope：

- 接线 `v3.continuation.remote_binding` 的 Resp04 commit、Req03 load/classify、Req06 pinned resolution、release/expiry。
- `/v1/responses` remote continuation 与 tool-output 请求的 JSON/SSE controlled replay。
- continuation pin 不可用、过期、scope mismatch、owner mismatch 的显式错误。
- maps、manifest、wiki、test design、red mutation gates。

Out of scope：

- Relay/local continuation materialization、Anthropic entry、servertool followup。
- SSE transport core 内部实现。
- Provider 特例、跨 provider reselection、fallback。
- V2 修改、provider credential/config 修改、global install/release。

Claim：`feature_id:v3.responses_direct_remote_continuation_integration`

## 3. 设计原则

- continuation immutable interval：Resp04 save 到下一轮 Req03/Req04 restore 之间只允许 codec、scope 校验、存储、expiry、release。
- bridge/handler/provider transport 不恢复 history/tool/context，不推断 owner。
- provider pin 是 runtime/control truth，不进入 provider/client normal payload。
- Direct owner 必须保持 Direct；任何缺失/冲突真相 fail-fast。
- 不复制 P6 或创建第二 Runtime kernel/response exit。

## 4. 技术方案与文件清单

基线文档：

- `docs/goals/v3-h4-remote-continuation-contract-store-test-design.md`
- `docs/goals/v3-hub-h2-p6-responses-direct-characterization.md`
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- V3 resource/function/mainline/verification maps 与 wiki

候选实现：

- `v3/crates/routecodex-v3-runtime/`：唯一 Hub wiring 与 store owner
- `v3/crates/routecodex-v3-target/`：只消费已验证 exact pin
- `v3/crates/routecodex-v3-provider-responses/`：只做同 provider Responses wire/transport
- `v3/crates/routecodex-v3-server/`：HTTP IO 薄壳，不做 continuation 语义
- controlled-upstream fixtures/harness、source/red gates、maps/wiki

先通过 map 锁真实 symbol；禁止在计划中伪造 caller/callee。若 1-2 次找不到唯一边，先补 map/contract。

## 5. 风险与规避

- direct 续接误入 Relay：entry+owner typed gate 与 negative fixture。
- pin 失效后重新选 provider：Target gate 禁止 VR reentry/reselection。
- store/handler 修改 payload：immutable interval source gate。
- `store:false` 丢失 pending tool continuation：以响应 pending tool truth 驱动最小 remote locator，测试锁定。
- providerKey 泄漏 payload：provider/client payload isolation gate。

## 6. 测试计划

- 红测：当前 store 已存在但 Hub binding pending；先证明真实两轮请求未接线。
- 正向 JSON/SSE：首轮 function_call -> commit remote locator -> 次轮 function_call_output + previous_response_id -> same provider pin -> terminal success。
- 反向：普通 chat/messages、relay owner、session/port/group mismatch、pin mismatch、expiry、provider unavailable、missing locator、duplicate commit、already terminal、still-running。
- 证明 VR 只命中首轮一次，续接不重新选 target。
- 证明 request/response/debug/error/metadata 均不泄漏 auth/provider control truth。
- focused Rust、controlled replay、P6 freeze/equivalence、architecture/resource/module/rust-only/fmt/clippy/workspace gates。
- 在所有离线门通过后，才可使用当前 5555 做 Jason 已授权范围内的真实 `/v1/responses` 两轮重放；不得改 live 配置或凭据。

## 7. 实施步骤

1. 刷新 `.agent-collab` 并 claim；查 MemoryPalace/maps/mainline/source。
2. 写两轮生命周期测试设计与 failing controlled replay。
3. 接 Resp04 commit 与 release/expiry。
4. 接 Req03 load/classify 和 Req06 exact pin；禁止 VR reentry。
5. 接 provider wire 的原样 `previous_response_id`/tool output 数据面。
6. 绿化正反测试，同步 maps/wiki/manifest/gates。
7. controlled replay 后进行 5555 同入口真实重放，检查日志、node trace 与 payload isolation。
8. architecture review，确认无 fallback、Relay 混入、immutable interval 越界。

## 8. 完成定义

- Remote continuation 从 Resp04 到下一轮 Req03/Req06 的真实绑定 anchored 且有 gate。
- JSON/SSE 两轮 controlled replay 与 5555 同入口真实重放成功。
- 所有隔离、pin、状态机和错误负测通过；无跨 owner、fallback、payload 泄漏。

## 9. Managed 5555 live finding（2026-07-15）

当前 managed 5555 已证明第一轮与 V3 内部 continuation 生命周期正常，但尚未证明真实两轮成功：

- JSON 第一轮与 SSE 第一轮均返回真实 provider-owned response ID、call ID 和 function call。
- continuation 轮日志证明 Virtual Router 命中为 0、Req03 locator load 为 1、Req06 exact pin 为 1。
- JSON/SSE continuation 轮都在 provider transport 返回 502；Error01-06 正确投影到客户端。
- 将相同两轮请求直接发给当前 upstream HTTP `/responses`，第二轮返回 HTTP 400，明确说明
  `previous_response_id` 只支持 Responses WebSocket v2；`store=true` 与 `store=false` 结果相同。

因此当前缺口不是 locator、scope、Router、pin、terminal release 或 HTTP error projection。唯一未完成的
runtime owner 是 Provider-owned Responses WebSocket v2 transport。`live_5555_pending` 必须保留到真实
JSON/SSE 两轮均成功。

## 10. Provider Responses WebSocket v2 slice

官方 WebSocket Mode 合同：连接 `/v1/responses`，每轮发送一个 `response.create` JSON event；续接轮只发送
新的 input items 与 `previous_response_id`。`stream` 和 `background` 是 HTTP transport 字段，不进入
WebSocket event。server events 与 Responses streaming event model 同序；同一连接一次只允许一个 in-flight
response。`store=false` 的 continuation state 只存在于当前连接内，ID 不在连接缓存时返回
`previous_response_not_found`；4xx/5xx 会驱逐被引用的缓存状态。

实现边界：

- Config/Manifest 必须显式声明 provider Responses transport：`http` 或 `websocket_v2`，以及 WS endpoint。
- `remote_continuation` 只能在 provider transport 为 `websocket_v2` 时发布；HTTP-only provider 宣告该能力
  必须在 Config compile 阶段 fail-fast。
- 第一次可能产生 provider-owned continuation 的请求与后续请求必须使用同一 provider/model/auth/transport
  pin；不能先走 HTTP 再为第二轮新建 WebSocket。
- WebSocket connection/cache 是 Provider Runtime resource。Hub、Server、continuation store 只能持有 opaque
  transport pin，不拥有 socket，不恢复 history/tool/context。
- JSON client intent 从 terminal `response.completed.response` 投影；SSE client intent 将每个 WebSocket
  server event按 Responses SSE framing 等价投影，业务事件语义仍由现有 response pipeline 消费。
- SSE 返回必须持有单连接 owner guard 并逐帧读取/投影；首帧不得等待 `response.completed`。只有完整消费
  terminal event 与 `[DONE]` 后连接才可复用，提前 drop、协议错误或 client disconnect 必须丢弃该连接。
- handshake/auth/protocol/provider error/client disconnect 必须进入唯一 Error01-06；禁止 HTTP retry、Relay、
  local materialization、full-history rebuild 或跨 provider reselection。

实施顺序：

1. 先补 resource/function/mainline/verification map 和本测试设计中的 transport-bound contract。
2. 写 Config compile red tests 与 controlled WebSocket handshake/event/state red tests。
3. 在 `routecodex-v3-provider-responses` 实现唯一 WebSocket v2 connection owner、event parser、correlation、
   cancellation 和 terminal projection。
4. 将 existing Provider transport request 扩展为 typed HTTP/WebSocket request；Hub 固定主线与 Resp04/Req03/
   Req06 生命周期保持不变。
5. 绿化 focused/full gates 后，仅使用经过 Config compile 的现有 managed profile 做 live replay；不得改 provider
   credential。若当前 provider 未提供可握手的 WS endpoint，保留 live pending 并报告外部 transport 缺口。

官方合同来源：<https://developers.openai.com/api/docs/guides/websocket-mode>。

## 11. Managed 5555 capability-gate finding（2026-07-16）

当前全局安装面已可用，`routecodex --version` 为 `0.90.3935`，`routecodex-v3 --help` 可用，5555 health
返回 V3 manifest server `responses_v3_5555`，模型目录只发布 `gpt-5.6-sol` / provider `cc_sol`。

本轮只读 live probe 未改 provider credential、live config、global install 或 restart。证据目录：
`.agent-collab/runs/20260716T021947Z-Macstudio.local-71025-2and3/logs/live-5555-20260716T022108Z/`。

结果：

- controlled owner gate `npm run test:v3-responses-direct-remote-continuation` 通过。
- JSON live 首轮在 `V3HubRespContinuation04Committed` 投影 HTTP 500：
  `provider cc_sol model gpt-5.6-sol lacks required remote_continuation capability`。
- client WebSocket live handshake 成功，但首轮返回 runtime error event：
  `provider cc_sol model gpt-5.6-sol lacks required remote_continuation capability`。
- node trace 仍显示 provider transport 为 `V3Transport13ResponsesHttpRequest`，当前 profile 未发布
  WebSocket v2 remote continuation capability；因此未进入可证明同 provider/model/auth/transport pin 的两轮成功路径。

结论：source/controlled closeout 仍有效，但 live 5555 closeout 继续 pending。按本目标约束，启用
`remote_continuation` / WebSocket v2 provider transport 需要 live config 与 restart 变更，必须等待 Jason 明确授权后再执行。

## 12. Current-state audit（2026-07-16）

当前 source/controlled 状态已从 WebSocket v2 binding pending 推进为 controlled JSON/SSE/WebSocket-v2 replay
verified：`npm run test:v3-responses-direct-remote-continuation`、direct verifier、direct red fixtures、
WebSocket v2 hardening verifier 与 red fixtures均通过。controlled coverage 已包含 Config transport-bound
capability、provider WebSocket v2 lifecycle、Runtime JSON/SSE continuation、Server JSON/SSE two-turn replay、
Req03 load、Req06 exact pin、续接轮 Router hit=0、no Relay/local materialization、no provider reselection。

当前 live 状态仍未满足完成标准：`~/.rcc/config.v3.toml` 与
`/Volumes/extension/.rcc/config.v3.toml` 的 `cc_sol` 仍声明
`responses = { process = "chat", streaming = "always", transport = "http" }`，模型能力仍只有
`text/reasoning/tools/streaming`，未发布 `remote_continuation` / `tool_outputs`，且当前
`routecodex-v3 server status --config ~/.rcc/config.v3.toml` 显示 `state="stopped"`、5555 无 listener。
按本目标执行规范，live config / credential / restart 仍需 Jason 明确授权后才能执行真实 JSON/SSE/client-WS
两轮 replay。
