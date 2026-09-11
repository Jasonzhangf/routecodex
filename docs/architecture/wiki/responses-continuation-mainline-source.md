# Responses Continuation Mainline Source

## Purpose

这页锁 `/v1/responses` continuation 的标准主线，回答三个问题：

1. continuation owner 在哪里判定
2. request / response 两侧 save / restore / materialize 顺序是什么
3. servertool hook 与 continuation 的正确边界是什么

Canonical sources:

- `docs/architecture/wiki/openai-responses-continuation-official-contract.md`
- `docs/architecture/wiki/continuation-standard-contract.md`
- `docs/design/responses-continuation-storage-ownership.md`
- `docs/architecture/wiki/responses-direct-relay-map.md`
- `docs/architecture/mainline-call-map.yml`

## Main Rule

`/v1/responses` continuation 的真相只允许来自两类显式 owner：

- `direct`: remote provider-owned continuation, anchored by explicit response id semantics
- `relay`: local owner materializes the next request from canonical saved truth

共同规则：

- continuation 不是 session 自动续接
- response 不是隐式 request truth 真源
- servertool hook 不拥有 continuation 判定权；外部 hooks 不属于 V3 continuation 链
- owner 归 `HubReqChatProcess03Governed` / `HubRespChatProcess03Governed` 的 Chat Process boundary block，固定 feature_id 为 `hub.chat_process_responses_continuation`
- request 侧位置钉死在 `HubReqInbound02Standardized` 结束后、`HubReqChatProcess03Governed` 开始前；response 侧位置钉死在 `HubRespChatProcess03Governed` 结束后、`HubRespOutbound04ClientSemantic` 开始前
- 工具治理、工具结果治理、servertool hook 只能在 Chat Process 内完成；Responses continuation 只是 `/v1/responses` protocol-specific save/restore glue，其他协议必须跳过这组 continuation block
- SSE 只属于 `ServerRespOutbound05ClientFrame` 传输层；它只能封装已经完成的 client semantic body，禁止承载 continuation save/restore、tool list injection、hook restore 或任何逻辑修复
- response closeout 只允许保留 canonical `response.id` continuation truth；router/provider attempt 等 transient request ids 必须在同一 closeout 清掉

## Immutable Save/Restore Interval

Continuation 只负责 `/v1/responses` 协议的保存与恢复，不负责转换请求历史或响应内容。

固定边界：

```text
HubRespChatProcess03Governed exit
  -> save canonical continuation truth
  -> immutable store interval
  -> restore canonical continuation truth
  -> HubReqChatProcess03Governed entry
```

在 `save` 之后到下一次 `restore` 之前，中间任何层都不得转换、清理、裁剪、重排、补偿或推导 request/response history。所有会改变历史、工具、tool output、servertool state、response body 的逻辑，只能发生在 response chat process 保存之前，或 request chat process 恢复之后。

`req_inbound` 只能做入口协议解析、raw evidence 捕获和非破坏性语义归一化；不得恢复历史、补工具结果、注入 servertool guidance 或重建 continuation payload。

`resp_outbound` 只能做 client protocol projection / frame handoff；不得保存 continuation、修 required_action、清理历史、准备下一轮 request data 或改写 response truth。

控制语义必须进入 `MetadataCenter`，不能进入 request/response payload 或 history。典型控制语义包括 continuation owner、protocol owner、routeHint、retry/provider pin、stream intent、port/group/request truth。payload、response body、normalized input、tool history mirror、request context 这类数据面对象不得写入 `MetadataCenter`。

## Standard Order

```mermaid
flowchart LR
  ChatProcReqContinuation01EntryEvidence["ChatProcReqContinuation01EntryEvidence<br/>explicit continuation evidence captured"]
  ChatProcReqContinuation02OwnerResolved["ChatProcReqContinuation02OwnerResolved<br/>direct vs relay ownership resolved"]
  ChatProcReqContinuation03CanonicalRestored["ChatProcReqContinuation03CanonicalRestored<br/>canonical request truth restored/materialized"]
  ChatProcReqContinuation04HookRestored["ChatProcReqContinuation04HookRestored<br/>request-side tool/servertool restore applied"]
  ChatProcReqContinuation05Governed["ChatProcReqContinuation05Governed<br/>normal request governance continues"]
  ChatProcRespContinuation06ResponseGoverned["ChatProcRespContinuation06ResponseGoverned<br/>response tool/servertool projection finalized"]
  ChatProcRespContinuation07CanonicalSaved["ChatProcRespContinuation07CanonicalSaved<br/>finalized canonical continuation truth saved"]
  ChatProcRespContinuation08Released["ChatProcRespContinuation08Released<br/>request/response closeout released"]

  ChatProcReqContinuation01EntryEvidence -->|rct-01| ChatProcReqContinuation02OwnerResolved
  ChatProcReqContinuation02OwnerResolved -->|rct-02| ChatProcReqContinuation03CanonicalRestored
  ChatProcReqContinuation03CanonicalRestored -->|rct-03| ChatProcReqContinuation04HookRestored
  ChatProcReqContinuation04HookRestored -->|rct-04| ChatProcReqContinuation05Governed
  ChatProcReqContinuation05Governed -->|rct-05| ChatProcRespContinuation06ResponseGoverned
  ChatProcRespContinuation06ResponseGoverned -->|rct-06| ChatProcRespContinuation07CanonicalSaved
  ChatProcRespContinuation07CanonicalSaved -->|rct-07| ChatProcRespContinuation08Released
```

## External Hooks Boundary

V3 continuation does not contain a Stopless or `reasoningStop` roundtrip. The
official Stop Hook, timer wakeup, update-goal wakeup, and future long-horizon
wakeup are owned by the external hooks daemon/codexapp. They observe Codex
running state and, when policy allows, send a normal message through the Codex
input interface. They do not modify continuation storage, provider payloads,
client projections, or SSE frames.

## Stage Meaning

| step | transition | legal owner action | forbidden action |
| --- | --- | --- | --- |
| `rct-01` | entry evidence -> owner resolved | inspect explicit continuation evidence from current request | auto-resume from session/scope-only hit |
| `rct-02` | owner resolved -> canonical restored | direct remote resume or relay local materialize | response-side guesswork |
| `rct-03` | canonical restored -> hook restored | restore current-turn tool result / servertool state on restored truth | restoring from stale pre-hook saved state |
| `rct-04` | hook restored -> governed | continue normal request governance | letting hook re-decide continuation ownership |
| `rct-05` | governed -> response governed | process normal response plus tool/servertool governance | saving pre-projection provider/raw state |
| `rct-06` | response governed -> canonical saved | persist finalized canonical continuation truth | save before servertool projection |
| `rct-07` | canonical saved -> released | keep canonical `response.id` continuation truth, release payload, and clear stale transient request ids | leaking request truth / metadata into next unrelated loop |

## Normalization / Conversion Fix Location

| problem | legal fix owner | forbidden fix owner |
| --- | --- | --- |
| request entry evidence capture wrong | `HubReqInbound02Standardized` / native req-inbound capture | handler-local continuation patch |
| continuation save/restore wrong | Chat Process continuation boundary / canonical store owner | SSE, resp_outbound, req_inbound history rewrite |
| provider raw SSE/body parse wrong | `ProviderRespInbound01Raw -> HubRespInbound02Parsed` Rust owner | handler/SSE frame repair |
| client JSON/SSE projection wrong | Rust response projection owner before server frame | `handler-response-sse.ts` business patch or restoring `responses-sse-bridge.ts` |
| tool/history/servertool semantics wrong | request/response Chat Process governance | continuation store mutation |
| control state missing | MetadataCenter owner / runtime-control family | payload/history/provider body field injection |

## Field Lock Matrix

The blackbox gate for continuation must lock semantic fields at each mainline stage, not transport frames.

| stage | must assert | must reject |
| --- | --- | --- |
| `ChatProcReqContinuation01EntryEvidence` | current request has explicit `responseId`/`previous_response_id`/`tool_outputs`; endpoint identity is known | session-only or scope-only continuation hit |
| `ChatProcReqContinuation02OwnerResolved` | `continuationOwner` is `relay` or `direct` from current evidence plus saved owner truth | hook code deciding owner |
| `ChatProcReqContinuation03CanonicalRestored` | relay restore returns `payload.input`, `payload.previous_response_id`, `payload.tools`, `context.input`, `context.toolsRaw`, port/group scope | restored payload missing tools or built from stale pre-hook response |
| `ChatProcReqContinuation04HookRestored` | current-turn tool/servertool result shape is restored from canonical truth | stale or payload-derived continuation state |
| `ChatProcReqContinuation05Governed` | provider request has normal client tools and no internal metadata carriers | provider request missing required client tool surface |
| `ChatProcRespContinuation06ResponseGoverned` | response tool/servertool governance is finalized before projection | raw internal control state leaking to client |
| `ChatProcRespContinuation07CanonicalSaved` | saved response body is the post-governed canonical response body with `response.id`, `required_action`, projected tool calls, and merged tool definitions | saving pre-projection provider/raw shell truth |
| `ChatProcRespContinuation08Released` | only legal continuation state remains retained for next explicit restore; stale router/provider request ids are cleared; live retained input items drop to zero while released prefix and merged tools remain restorable | request metadata/session truth leaking into unrelated turns |

Wrong tests to avoid:

- Tests that prove only SSE frame shape are not continuation semantic gates.
- Tests that stop at `payload.tools` existing do not prove request-side restore happened.
- Tests that mock projection output without asserting the pre-save canonical owner order do not prove the mainline contract.
- Tests that require a continuation fix inside `handler-response-sse.ts` or any SSE writer are wrong-owner tests; SSE tests may only assert transport framing, metadata isolation, and JSON/SSE equivalence for an already-finalized semantic body.

## Direct vs Relay

### direct

- explicit anchor is request-visible `previous_response_id` / remote continuation evidence
- owner truth is remote provider state
- RouteCodex may keep only minimal ownership metadata for legality/pin
- RouteCodex must not fake local materialize as remote resume

### relay

- owner truth is local canonical saved request/response truth
- next turn must be materialized into a standard `/v1/responses` request before governance
- tool/history/servertool modifications must survive through canonical saved truth
- relay restore must never depend on response-side fallback assembly

## Servertool Boundary

The servertool request/response hook pair is inside the continuation window, but
it is not the continuation owner:

1. continuation owner restores/materializes current request truth;
2. request-side servertool governance runs on that restored truth;
3. normal request governance continues;
4. response-side servertool governance finalizes client-visible semantics;
5. continuation owner saves finalized canonical truth.

Therefore:

- servertool restore must run after continuation restore;
- canonical save must run after response servertool projection;
- canonical save closeout must retain only the canonical `response.id` entry;
  stale router/provider request ids must be cleared in the same response-end
  owner block.

## Why Current Structural Error Happens

如果实现犯了以下任一错误，continuation 就会结构性错位：

1. 只在 response side 保存，request side没有对称 canonical request truth
2. save 发生在 response servertool projection 之前
3. restore 发生在 request-side tool restore 之后
4. handler/bridge 在 response side 临时拼 `responsesRequestContext`
5. 把 session 命中当 continuation owner 证据

这些错误的共同结果都是：

- 下一轮恢复出的 shape 不是当前轮真实 canonical truth
- 工具结果、schema feedback、servertool state 或 tool availability 被覆盖掉
- 恢复后的 `payload.tools` 或 `context.toolsRaw` 丢失，导致下一轮无法正常续轮或正常停止

## Review Checklist

- continuation owner 是否只基于当前请求显式证据判定。
- relay restore 是否先 materialize canonical request，再跑 request-side hook restore。
- response-side save 是否发生在 response servertool projection 之后。
- direct 与 relay 是否都没有 session-only 恢复路径。
- servertool 是否只消费 restored current-turn truth，而不是接管 continuation owner。
- saved context 是否只认 canonical `basePayload`，没有额外顶层 `tools` side-channel。
- blackbox 是否断言每个 stage 的 semantic fields，而不是只断言 transport/SSE 形态。
- SSE 是否保持 transport-only：不得在 SSE writer / SSE bridge / frame projector 中补 schema、补 tools、补 continuation owner 或补 save/restore 顺序。
