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
