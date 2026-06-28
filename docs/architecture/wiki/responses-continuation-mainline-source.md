# Responses Continuation Mainline Source

## Purpose

这页锁 `/v1/responses` continuation 的标准主线，回答三个问题：

1. continuation owner 在哪里判定
2. request / response 两侧 save / restore / materialize 顺序是什么
3. servertool hook / stopless 与 continuation 的正确边界是什么

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
- hook/stopless 不拥有 continuation 判定权
- owner 归 `HubReqChatProcess03Governed` / `HubRespChatProcess03Governed` 的 Chat Process boundary block，固定 feature_id 为 `hub.chat_process_responses_continuation`
- request 侧位置钉死在 `HubReqInbound02Standardized` 结束后、`HubReqChatProcess03Governed` 开始前；response 侧位置钉死在 `HubRespChatProcess03Governed` 结束后、`HubRespOutbound04ClientSemantic` 开始前
- 工具治理、工具结果治理、stopless hook restore/projection 只能在 Chat Process 内完成；Responses continuation 只是 `/v1/responses` protocol-specific save/restore glue，其他协议必须跳过这组 continuation block
- SSE 只属于 `ServerRespOutbound05ClientFrame` 传输层；它只能封装已经完成的 client semantic body，禁止承载 stopless schema judgment、continuation save/restore、tool list injection、hook restore 或任何逻辑修复
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

在 `save` 之后到下一次 `restore` 之前，中间任何层都不得转换、清理、裁剪、重排、补偿或推导 request/response history。所有会改变历史、工具、tool output、stopless guidance、servertool state、response body 的逻辑，只能发生在 response chat process 保存之前，或 request chat process 恢复之后。

`req_inbound` 只能做入口协议解析、raw evidence 捕获和非破坏性语义归一化；不得恢复历史、补工具结果、注入 stopless/servertool guidance 或重建 continuation payload。

`resp_outbound` 只能做 client protocol projection / frame handoff；不得保存 continuation、修 required_action、清理历史、准备下一轮 request data 或改写 response truth。

控制语义必须进入 `MetadataCenter`，不能进入 request/response payload 或 history。典型控制语义包括 continuation owner、protocol owner、routeHint、retry/provider pin、stream intent、port/group/request truth。payload、response body、normalized input、tool history mirror、request context 这类数据面对象不得写入 `MetadataCenter`。

## Standard Order

```mermaid
flowchart LR
  ChatProcReqContinuation01EntryEvidence["ChatProcReqContinuation01EntryEvidence<br/>explicit continuation evidence captured"]
  ChatProcReqContinuation02OwnerResolved["ChatProcReqContinuation02OwnerResolved<br/>direct vs relay ownership resolved"]
  ChatProcReqContinuation03CanonicalRestored["ChatProcReqContinuation03CanonicalRestored<br/>canonical request truth restored/materialized"]
  ChatProcReqContinuation04HookRestored["ChatProcReqContinuation04HookRestored<br/>request-side tool/hook restore applied"]
  ChatProcReqContinuation05Governed["ChatProcReqContinuation05Governed<br/>normal request governance continues"]
  ChatProcRespContinuation06ResponseGoverned["ChatProcRespContinuation06ResponseGoverned<br/>response hook/stopless projection finalized"]
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

## Stopless Two-Round Contract

Stopless inside `/v1/responses` is a two-owner protocol. Responses continuation owns restore/save. Stopless hook governance owns schema judgment and shell projection/restore. Neither side may do the other side's job.

Round 1 request side:

1. Every stopless-managed request must already contain the two server-owned stop
   guidance surfaces before provider dispatch:
   - system stop-summary/schema guidance for the `finish_reason=stop` path;
   - model-facing internal `reasoningStop` tool declaration for the tool-call stop path.
2. These are servertool/chat-process injections, not client-supplied payload.
3. They repeat on every stopless-managed request, not just the initial turn.
4. The normal client tool surface, including `exec_command`, must still remain
   available and must not be dropped because `reasoningStop` is present.

Round 1 response side:

1. Provider request must already contain the stop contract guidance and the model-visible `reasoningStop` tool when stopless is active.
2. If provider returns `finish_reason=stop`, response governance evaluates the stop schema from assistant text (`<rcc_stop_schema>...</rcc_stop_schema>` or accepted fenced schema).
3. If provider returns tool calls, response governance evaluates `reasoningStop.arguments` as the stop schema source.
4. Missing, empty, malformed, invalid, or non-terminal schema must be converted into the client-visible shell projection: `required_action.submit_tool_outputs.tool_calls[].name=exec_command`, with command `routecodex hook run reasoningStop ...`.
5. Valid terminal schema may pass terminal response projection without forcing the shell projection.
6. Continuation save must happen after the response hook/projection has produced the canonical client-visible response truth. Saving raw pre-hook `reasoningStop` as the canonical client continuation truth is invalid.
7. Client delivery happens after that save point; save belongs to chat-process closeout, not SSE.

Round 2 request side:

1. `/v1/responses/{responseId}/submit_tool_outputs` is first resolved by Responses continuation owner using explicit current request evidence.
2. Relay continuation restore/materialize must produce canonical current request truth before stopless request hook restore runs.
3. The submitted client `exec_command` output from `routecodex hook run reasoningStop ...` must be restored into model-visible stopless truth.
4. That restored truth must be paired back to internal `reasoningStop` call/result semantics for the model-facing request, while the CLI stdout is rewritten into model-visible guidance.
5. Provider-facing request must then contain the restored `reasoningStop` semantics, updated schema guidance, and the normal client tool surface required for the next turn.
6. Request-side hook restore must not decide continuation owner, and continuation restore must not parse stopless schema.

Round 3 loop guard:

1. The third consecutive `no_schema` round is the only extra terminal rule.
2. Once `no_schema` has reached 3, stopless must stop converting another
   `finish_reason=stop` into shell projection.
3. This loop guard belongs to stopless governance, not continuation owner, and
   not SSE.

## Stage Meaning

| step | transition | legal owner action | forbidden action |
| --- | --- | --- | --- |
| `rct-01` | entry evidence -> owner resolved | inspect explicit continuation evidence from current request | auto-resume from session/scope-only hit |
| `rct-02` | owner resolved -> canonical restored | direct remote resume or relay local materialize | response-side guesswork |
| `rct-03` | canonical restored -> hook restored | restore current-turn tool result / shell rewrite on restored truth | restoring from stale pre-hook saved shell |
| `rct-04` | hook restored -> governed | continue normal request governance | letting hook re-decide continuation ownership |
| `rct-05` | governed -> response governed | process normal response plus tool/stopless governance | saving pre-projection provider/raw shell |
| `rct-06` | response governed -> canonical saved | persist finalized canonical continuation truth | save before hook/stopless projection |
| `rct-07` | canonical saved -> released | keep canonical `response.id` continuation truth, release payload, and clear stale transient request ids | leaking request truth / metadata into next unrelated loop |

## Normalization / Conversion Fix Location

| problem | legal fix owner | forbidden fix owner |
| --- | --- | --- |
| request entry evidence capture wrong | `HubReqInbound02Standardized` / native req-inbound capture | handler-local continuation patch |
| continuation save/restore wrong | Chat Process continuation boundary / canonical store owner | SSE, resp_outbound, req_inbound history rewrite |
| provider raw SSE/body parse wrong | `ProviderRespInbound01Raw -> HubRespInbound02Parsed` Rust owner | handler/SSE frame repair |
| client JSON/SSE projection wrong | Rust response projection owner before server frame | `handler-response-sse.ts` / `responses-sse-bridge.ts` business patch |
| tool/history/stopless semantics wrong | request/response Chat Process governance | continuation store mutation |
| control state missing | MetadataCenter owner / runtime-control family | payload/history/provider body field injection |

## Field Lock Matrix

The blackbox gate for stopless continuation must lock semantic fields at each mainline stage, not transport frames.

| stage | must assert | must reject |
| --- | --- | --- |
| `ChatProcReqContinuation01EntryEvidence` | current request has explicit `responseId`/`previous_response_id`/`tool_outputs`; endpoint identity is known | session-only or scope-only continuation hit |
| `ChatProcReqContinuation02OwnerResolved` | `continuationOwner` is `relay` or `direct` from current evidence plus saved owner truth | hook/stopless code deciding owner |
| `ChatProcReqContinuation03CanonicalRestored` | relay restore returns `payload.input`, `payload.previous_response_id`, `payload.tools`, `context.input`, `context.toolsRaw`, port/group scope | restored payload missing tools or built from stale pre-hook response |
| `ChatProcReqContinuation04HookRestored` | stopless CLI output becomes model-visible `reasoningStop` history/guidance for the current turn | raw `exec_command` shell transcript becoming model truth |
| `ChatProcReqContinuation05Governed` | provider request has stop guidance, `reasoningStop` tool when active, normal client tools, and no internal metadata carriers | provider request missing stop contract or missing client tool surface |
| `ChatProcRespContinuation06ResponseGoverned` | response hook has evaluated `finish_reason=stop` schema text or `reasoningStop.arguments`; denied stop is projected to client `exec_command` | raw internal `reasoningStop` leaking to client as executable tool |
| `ChatProcRespContinuation07CanonicalSaved` | saved response body is the post-governed canonical response body with `response.id`, `required_action`, projected tool calls, and merged tool definitions | saving pre-projection provider/raw shell truth |
| `ChatProcRespContinuation08Released` | only legal continuation state remains retained for next explicit restore; stale router/provider request ids are cleared; live retained input items drop to zero while released prefix and merged tools remain restorable | request metadata/session truth leaking into unrelated turns |

Wrong tests to avoid:

- Tests that prove only SSE frame shape are not stopless/continuation semantic gates.
- Tests that stop at `payload.tools` existing do not prove request-side stopless restore happened.
- Tests that mock projection output without asserting the pre-save canonical owner order do not prove the mainline contract.
- Tests that require a stopless/continuation fix inside `handler-response-sse.ts` or any SSE writer are wrong-owner tests; SSE tests may only assert transport framing, metadata isolation, and JSON/SSE equivalence for an already-finalized semantic body.

## Direct vs Relay

### direct

- explicit anchor is request-visible `previous_response_id` / remote continuation evidence
- owner truth is remote provider state
- RouteCodex may keep only minimal ownership metadata for legality/pin
- RouteCodex must not fake local materialize as remote resume

### relay

- owner truth is local canonical saved request/response truth
- next turn must be materialized into a standard `/v1/responses` request before governance
- tool/history/stopless modifications must survive through canonical saved truth
- relay restore must never depend on response-side fallback assembly

## Hook And Stopless Boundary

request/response hook pair is inside the continuation window, but not the owner:

1. continuation owner restores/materializes current request truth
2. request-side hook restores current-turn tool result shape
3. request governance continues
4. response-side hook/stopless projects final client-visible shape
5. continuation owner saves finalized canonical truth

Therefore:

- hook restore must run after continuation restore
- canonical save must run after response hook/stopless projection
- canonical save closeout must retain only the canonical `response.id` entry; stale router/provider request ids must be cleared in the same response-end owner block
- stopless no-schema guard runs on restored current-turn truth, not stale stored shell

## Why Current Structural Error Happens

如果实现犯了以下任一错误，continuation 就会结构性错位：

1. 只在 response side 保存，request side没有对称 canonical request truth
2. save 发生在 response hook / stopless projection 之前
3. restore 发生在 request-side tool restore 之后
4. handler/bridge 在 response side 临时拼 `responsesRequestContext`
5. 把 session 命中当 continuation owner 证据

这些错误的共同结果都是：

- 下一轮恢复出的 shape 不是当前轮真实 canonical truth
- 工具结果、schema feedback、stopless guidance 或 tool availability 被覆盖掉
- 恢复后的 `payload.tools` 或 `context.toolsRaw` 丢失，导致下一轮无法正常续轮或正常停止

## Review Checklist

- continuation owner 是否只基于当前请求显式证据判定。
- relay restore 是否先 materialize canonical request，再跑 request-side hook restore。
- response-side save 是否发生在 hook/stopless projection 之后。
- direct 与 relay 是否都没有 session-only 恢复路径。
- stopless 是否只消费 restored current-turn truth，而不是接管 continuation owner。
- saved context 是否只认 canonical `basePayload`，没有额外顶层 `tools` side-channel。
- store resume 是否只保留 raw stopless pair，而把 guidance rewrite 留给 request-side restore。
- blackbox 是否断言每个 stage 的 semantic fields，而不是只断言 transport/SSE 形态。
- SSE 是否保持 transport-only：不得在 SSE writer / SSE bridge / frame projector 中补 schema、补 tools、补 continuation owner、补 save/restore 顺序或重判 stopless。
