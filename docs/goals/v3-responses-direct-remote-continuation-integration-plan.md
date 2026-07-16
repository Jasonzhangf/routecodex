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

当前全局安装面已可用，`routecodex --version` 为 `0.90.3935`，V3 CLI help 可用，5555 health
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
`text/reasoning/tools/streaming`，未发布 `remote_continuation` / `tool_outputs`。后续 managed lifecycle
release rollover 已把 5555 拉回 running，普通 HTTP JSON/SSE smoke 可用，但这只证明 terminal
HTTP 请求可用，不证明 provider-owned remote continuation 两轮成功。按本目标执行规范，live config /
credential / restart 仍需 Jason 明确授权后才能执行真实 JSON/SSE/client-WS 两轮 remote-continuation replay。

## 13. V2 TOML transport projection audit（2026-07-16）

当前 5555 live 已切到 `/Volumes/extension/.rcc/config.5555.v2.toml` 经 V3 config store 显式编译，
因此 remote-continuation live gap 的配置入口从 `config.v3.toml` 变为 V2 root +
`provider/<id>/config.v2.toml`。Config owner 必须投影 V2 `[provider.responses]` 的
`transport` 与 `websocket_v2_url`，而不是在 Runtime 或 Provider transport 里猜测 HTTP/WS。

本轮 source 修复边界：

- V2 responses provider 未声明 `transport` 时仍发布 HTTP transport。
- V2 responses provider 声明 `transport = "websocket_v2"` 时发布 WebSocket v2 transport，并保留
  `websocket_v2_url` / `websocketV2Url` 到 V3 manifest。
- V2 model capabilities 中 `remote_continuation` / `tool_outputs` 原样进入 V3 compile gate；HTTP-only
  remote continuation、WebSocket v2 缺 endpoint 仍 fail-fast。
- 不改 live provider credential、不写真实 `~/.rcc/provider/*/config.v2.toml`、不猜测 AnyInt WebSocket endpoint。

Live 5555 现状（只读、已脱敏）：`cc-sol` provider 仍只有
`[provider.responses] process="chat", streaming="always"`，模型 capability 缺
`remote_continuation` / `tool_outputs`，且没有 `websocket_v2_url`。因此 source 能读取 V2 WS 声明后，
真实两轮 live closeout 仍取决于 provider 侧给出可验证 WebSocket v2 endpoint 与 Jason 授权配置/restart。

## 14. Config A live execution audit after authorization（2026-07-16）

Jason 已授权 V3 5555 非生产环境的 connection/config/restart/live replay。本轮从配置侧重新执行 A，但未做持久 live config mutation，因为唯一缺口不只是 TOML 字段，而是 provider WebSocket v2 endpoint 仍未验证可用。

证据目录：`.agent-collab/runs/20260716T124105Z-Macstudio.local-23864-6eb355fe/`。

已验证事实：

- `rccv3 config check --config /Volumes/extension/.rcc/config.5555.v2.toml` 通过，5555 `/health` 为 V3 running。
- `/Volumes/extension/.rcc/provider/cc-sol/config.v2.toml` 与 `~/.rcc/provider/cc-sol/config.v2.toml` 仍只声明 `[provider.responses] process="chat", streaming="always"`；`gpt-5.6-sol` capabilities 仍缺 `remote_continuation` / `tool_outputs`，且无 `websocket_v2_url`。
- `/v1/models` 中 `gpt-5.6-sol` 的 Codex capability 字段齐全，但 `prefer_websockets=false`，不能作为 remote continuation 能力证据。
- 使用现有 `cc-sol` auth 对 `wss://api.anyint.ai/openai/v1/responses` 与 query 变体执行 Responses WebSocket v2 handshake probe，均在 opening handshake 阶段 8s timeout，未打开连接、未收到 terminal event。
- 对同路径发普通 HTTPS 请求能返回 401/404 形状；加 WebSocket Upgrade 后同样 8s timeout。这说明 HTTP endpoint 可达，但当前 provider/proxy 对 WebSocket Upgrade 未给出可验证响应。

结论：A 的 Config source 支持已经完成；live 5555 不应只靠猜测写入 `transport="websocket_v2"` 和 `websocket_v2_url`。真实两轮 remote continuation/tool_outputs closeout 仍需要 provider 侧给出可握手的 WebSocket v2 endpoint，或换成已验证支持 Responses WebSocket v2 的 provider profile 后再做持久配置、managed restart、两轮 replay。

## 15. Configured provider WebSocket v2 matrix probe（2026-07-16）

Section 14 只覆盖当前 5555 主用 `cc-sol` profile。本轮继续把同一验证口径扩展到当前已配置的 Responses provider 列表，避免把“只有主 provider 缺 endpoint”误判成可以通过切换现有 profile 解决。

证据：

- Summary：`.agent-collab/runs/20260716T125019Z-Macstudio-75061-1d19c963/provider-ws-upgrade-summary.json`
- Per-candidate JSONL：`.agent-collab/runs/20260716T125019Z-Macstudio-75061-1d19c963/provider-ws-upgrade-probe.jsonl`
- Evidence log：`.agent-collab/runs/20260716T125019Z-Macstudio-75061-1d19c963/evidence.jsonl`

Probe contract：

- 读取 `/Volumes/extension/.rcc/provider` 和 `~/.rcc/provider` 中已配置的 `type="responses"` provider，按 provider id 去重，secret 只在内存用于握手，不写入输出。
- 对每个 provider 派生 4 个候选 WebSocket endpoint：`/responses`、`/responses/ws`、`/responses/websocket`、`/realtime`。
- 使用真实 WebSocket Upgrade、配置 auth（若存在）和 `OpenAI-Beta: responses_websockets=2026-02-06`。
- 成功条件唯一是 HTTP `101 Switching Protocols`；HTTP 200/400/401/403/404/405、connection refused、timeout 都不是 provider Responses WebSocket v2 availability。

结果：

- Providers：13。
- Candidates：52。
- HTTP 101 opened：0。
- Status/error counts：`200=6`、`400=2`、`401=4`、`403=1`、`404=25`、`405=1`、`ConnectionRefusedError=2`、`TimeoutError=11`。
- Inventory 断言：13 个 provider 都没有声明 `websocket_v2_url`；声明 transport 均为空或 HTTP；模型能力均未声明 `remote_continuation` 和 `tool_outputs`。

结论：当前已配置 provider 集合里没有可验证 provider Responses WebSocket v2 endpoint，live two-turn remote continuation/tool_outputs exact-pin replay 继续 blocked。此时不应对任何现有 provider 写入猜测的 `transport="websocket_v2"` / `websocket_v2_url`，也不应重启 5555 去制造必然失败的 live profile。下一步只能是拿到 provider 侧确认可握手的 WebSocket v2 endpoint，或新增/切换到已验证支持该 endpoint 的 provider profile 后，再做持久配置、managed restart、JSON/SSE/client-WS 两轮 exact-pin replay。

## 15. Provider WS v2 discovery pass（2026-07-16）

Continuation of Config A after the live cc-sol endpoint timeout broadened the probe to all configured
Responses provider profiles that had a locally resolvable auth secret, without printing secrets and without
mutating provider config.

Evidence directory: `.agent-collab/runs/20260716T130144Z-Macstudio.local-68215-f53975df/`.

Findings:

- Authenticated WebSocket v2 handshake scan covered the locally resolvable Responses providers `55ai`,
  `cc`, `cc-sol`, `llmgate`, `llmtoken`, and `xl` across their Config-derived `/responses` endpoints and
  standard `/v1/responses` / `/openai/v1/responses` discovery variants. Result: `opened=0`.
- Providers with env-referenced or missing auth in the current agent shell were skipped as unresolved local
  evidence, not marked failed: `1token`, `asxs`, `dibittai`, `grok`, `lmstudio`, `sdfv`, and `ykk`.
- Official `wss://api.openai.com/v1/responses` was also probed using the current `OPENAI_API_KEY` environment
  variable. The authenticated WebSocket upgrade returned `invalid_api_key`; it therefore cannot serve as the
  live provider for this closeout without credential replacement, which is out of scope for this task.

Conclusion: the blocker is now stronger than a single `cc-sol` config omission. The current local runtime
configuration has no provider-verified Responses WebSocket v2 endpoint available for a real two-turn
`function_call_output` replay. Do not persist a WebSocket v2 config mutation until one provider profile can
first prove a successful `101` upgrade and terminal `response.completed` event with the same auth source.
