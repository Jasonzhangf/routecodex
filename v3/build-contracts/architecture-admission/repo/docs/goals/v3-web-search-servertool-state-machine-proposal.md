# V3 Web Search ServerTool State Machine Proposal

## Status

Proposal and architecture lock only. This document does not claim runtime implementation, installation, or live verification.

The current architecture-map entries for `v3.web_search_servertool_state_machine` remain `status: design`. They are target-state drawings, not active runtime truth.

## Problem

The reported 502 is an ownership mismatch:

```text
/v1/responses web_search declaration
  -> non-Responses OpenAI Chat target
  -> provider compat receives Responses-only search_content_types
  -> no registered OpenAI Chat wire projection
  -> UnmappedOutboundFields
```

`web_search` and `search_content_types` cannot be removed or silently ignored. ChatProcess must select a complete search execution contract before provider compat receives the request.

## V2 Findings

The V2 implementation at commit `74ddc4a44` used this semantic loop:

```text
model web_search call
  -> parse query/count/recency/engine
  -> select configured search engine
  -> execute search backend
  -> normalize summary/hits
  -> inject result under original tool_call_id
  -> continue the main model
```

V3 retains:

- interception of an actual model tool call;
- structured argument validation;
- one configured backend selected before execution;
- normalized search result data;
- exact original call-id pairing;
- explicit failure when search cannot execute.

V3 retires:

- TypeScript semantic ownership;
- V2 `reenterPipeline` main-model re-entry;
- provider-name/prefix capability detection;
- fallback-style engine iteration;
- control truth in generic context or normal payload;
- empty/malformed search output projected as success.

## Tool Selection And Two Execution Modes

`web_search` is the standard Responses hosted-search tool. Most non-GPT provider tool lists cannot carry it together with ordinary function tools, so the request must choose one tool surface before `ReqOutbound`.

The compiled route/capability manifest defines whether the current route has an eligible GPT-series native-search target. Runtime code must consume that typed fact; it must not add provider-prefix branches in Virtual Router or Hub Pipeline.

### Mode A: Native Remote Search

Use when the `web_search` route selects an eligible configured GPT-series target that explicitly supports the native search shape and ordinary-tool mix.

```text
current-turn search evidence
  -> route classification
  -> Virtual Router selects eligible configured target
  -> normal ReqOutbound/provider wire projection
  -> provider-native search result
```

Rules:

- `web_search` remains the standard hosted tool;
- the selected GPT-series target receives it directly through the normal Responses path;
- ordinary tools and requested search content types are preserved;
- no local `websearch` state or forced local dispatch is created;
- unsupported native semantics fail before provider send;
- provider compat only encodes the registered wire shape.

### Mode B: MetadataCenter-Governed Local Search

Use when no eligible GPT-series native-search target can be selected for the request. Before provider outbound construction, Req04 replaces the standard `web_search` declaration with the local `websearch` function tool. This replacement is a semantic projection, not removal: the local tool preserves the search intent and required arguments under a provider-compatible ordinary-tool surface.

```text
Req04 replaces web_search with local websearch
  -> normal provider emits websearch function call
  -> Resp03 validates and intercepts that actual call
  -> ServerToolCenter stores scoped websearch state in MetadataCenter
  -> force one websearch search request through the registered VR search route
  -> intercept the search response in Resp03
  -> normalize it to the Responses hosted web_search result shape
  -> return the result with the original tool-call identity
  -> normal Responses continuation proceeds without rebuilding entry payload
```

The forced request is one additional provider/search hop, not main-model re-entry. It uses the same MetadataCenter/ServerTool lifecycle infrastructure as Stopless, but a separate typed `websearch` state instance.

The extra hop is not an HTTP/ReqInbound replay. Resp03 builds a typed search request context from the already-canonical current turn, writes the forced `websearch` route decision to MetadataCenter, and re-enters the existing VR at its registered internal entry edge. It cannot rebuild the client entry payload or create a second router. The captured result is written to the scoped ServerToolCenter `websearch` instance.

## Activation Rules

A declared `web_search` tool is availability, not route evidence.

Native search routing may activate only from current-turn evidence:

- explicit latest-user-turn search intent accepted by the registered classifier; or
- a same-scope native search continuation already proven by the current lifecycle.

Local search execution activates only when Resp03 observes an actual canonical `websearch` function call while the same-turn ServerToolCenter `websearch` instance says the local tool surface was active.

The following never activate search by themselves:

- tool declaration or description;
- `/v1/models` capability metadata;
- an arbitrary provider/model name without the compiled route decision;
- existence of a search route pool;
- historical search text without current-turn evidence.

## ServerToolCenter Upgrade

Upgrade the existing StoplessCenter MetadataCenter resource into a generic ServerToolCenter. Stopless becomes one registered tool state machine inside that center; `websearch` becomes another. The lifecycle mechanism, scoped storage, Req04/Resp03 access pattern, cleanup, and gates are shared. Tool-specific phases and data remain separately typed and cannot be read across tools.

Minimum center key:

```text
entryProtocol + endpoint + serverId/port + routingGroup + sessionId
+ toolName + toolRunId
```

`sessionId` is the hard session-isolation boundary. Missing or blank session identity cannot start, resume, or consume a managed ServerTool run. `toolName` is the hard tool-isolation boundary: `stopless` cannot read or consume `websearch` state, and `websearch` cannot read or mutate `stopless` state. `conversationId`, request/response identity, and original tool call id are validation fields within the isolated tool instance, not substitutes for `sessionId + toolName`.

Minimum phases:

```text
Idle
  -> LocalToolSurfaceActive
  -> ToolCallObserved
  -> SearchDispatchPrepared
  -> SearchInFlight
  -> SearchResultCaptured
  -> HostedResultProjected
  -> MainModelContinuationPrepared
  -> Completed

Any non-terminal phase -> Failed
```

Minimum state data:

- phase and transition reason;
- execution budget;
- original tool call id;
- validated query/count/recency/content-type request;
- compiled backend binding identity;
- normalized search result or typed failure;
- last request/response identity.

The search result is internal ServerTool execution data owned by the isolated `websearch` tool instance until Resp03 projects the registered Responses hosted-search result. Routing, provider selection, retry, health, and continuation state remain separate control resources.

ServerToolCenter state cannot enter provider body, client normal payload, continuation store, handler/SSE state, or debug normal payload.

The center exposes generic operations only:

- register/load/store/transition/clear by typed `toolName + sessionId + scope`;
- enforce legal adjacent transitions and per-tool budgets;
- reject cross-tool and cross-session access;
- provide typed adapters to Req04 and Resp03.

It does not use one generic untyped state object. Each registered tool owns a distinct typed state schema and transition validator.

## Codex-Compatible Result Contract

The implementation should follow the standalone web-search behavior verified in `~/code/codex/codex-rs/app-server/tests/suite/v2/web_search.rs`:

1. The main-model request exposes an ordinary local search tool instead of the hosted `web_search` declaration. RouteCodex uses the single tool name `websearch`; Codex uses the equivalent namespaced `web.run`.
2. The model emits a function call carrying search commands such as `search_query`.
3. The search request includes the current canonical turn input and normalized commands, while route/provider/control truth remains in MetadataCenter.
4. The search endpoint returns typed result items such as `text_result` with stable reference ids.
5. The result is returned under the original function call id as canonical function-call output for the main-model continuation.
6. Client-visible lifecycle projection presents a hosted-search-equivalent item: started while the search is running, completed with query/action/results after capture.

The canonical V3 projection must therefore preserve two related views without mixing their ownership:

- provider continuation data: original call id plus normalized search output;
- client Responses view: `web_search_call`-equivalent lifecycle with `status`, normalized `action`, query/queries, and typed results/citations.

The internal `websearch` function name must not leak as the final Responses hosted-tool surface. Conversely, the projected `web_search_call` must not be used to reconstruct ServerToolCenter state.

## Search Dispatcher

The additional search hop needs one Rust owner registered before implementation.

Required contract:

```text
ServerToolCenter websearch::SearchDispatchPrepared
  -> typed WebSearchExecutionRequest
  -> one compiled backend binding
  -> registered backend transport owner
  -> typed WebSearchExecutionResult
  -> ServerToolCenter websearch::SearchResultCaptured
```

Rules:

- selects exactly one backend before execution;
- enters the existing VR through one registered internal search-dispatch edge;
- starts from typed canonical search context, not HTTP/ReqInbound or a reconstructed client entry payload;
- uses the normal selected-target -> ReqOutbound -> provider -> RespInbound path for the extra hop;
- does not create a second Virtual Router;
- does not iterate through fallback engines after failure;
- preserves query/count/recency/requested content types when supported;
- rejects unsupported semantics before dispatch;
- normalizes hits, citations, text, and content types into one canonical result.

Search-only provider behavior, including a configured MiniMax search-only target, is legal only after the forced `websearch` route has selected that target for the isolated search hop. Mixed-tool cleanup in the original main-model request, provider compat, handler, or SSE remains forbidden.

## Owner Split

### Config Compiler

`routecodex-v3-config` compiles explicit model search mode and exactly one local backend binding. Proposed model modes:

- `native_remote_search_tool_mix`;
- `metadata_center_local_search`;
- `none`.

### Request ChatProcess

Req04 owns the post-route tool-surface decision: preserve standard `web_search` for an eligible GPT native target, or replace it with local `websearch` when no such target is available. It also owns canonical result injection into the already-restored main-model context. It does not execute transport or rebuild the entry payload.

### Response ChatProcess

Resp03 owns same-turn activation checks, typed ServerToolCenter transitions, actual `websearch` call interception, argument validation, forced search-dispatch transition, search-response interception, and hosted-search result projection before continuation save.

### Web Search Dispatcher

The registered Rust dispatcher owns only the extra search execution hop and canonical backend result parsing. It consumes typed `websearch` instance execution input and returns typed execution output.

### Virtual Router

Virtual Router selects eligible targets after route classification. The forced local search dispatch provides the registered `route=websearch` control decision through MetadataCenter, but VR still only selects from that route. It cannot inspect tool schema text, mutate payload, execute ServerTools, or pair results.

### Provider Compat and Runtime

Provider compat/runtime only encode registered wire shapes. They cannot select search mode, silently remove `search_content_types`, start a ServerToolCenter run, or repair lifecycle state.

## Continuation Ordering

Required order for the local path:

```text
Resp03:
  intercept actual websearch call
  -> ServerToolCenter websearch transition
  -> construct search request from current canonical request context
  -> force VR websearch route through MetadataCenter
  -> execute and intercept the extra search hop
  -> project hosted web_search result + paired continuation data

Resp04:
  save finalized canonical response context

immutable interval:
  transport/projection/scope validation only

next Req04:
  restore continuation/local context
  -> read the scoped ServerToolCenter websearch instance
  -> validate original call-id pairing
  -> inject stored canonical search result without rebuilding entry payload
```

No web-search semantic mutation may occur in RespOutbound, SSE, handler, adapter transport, store transport, ReqInbound, or the immutable interval.

## Error Contract

- malformed function arguments fail before search dispatch;
- missing or ambiguous backend binding fails before transport;
- unsupported requested content types fail explicitly;
- backend HTTP/protocol/parse failure enters the typed Error chain;
- wrong toolName/session/port/protocol/toolRunId/call-id cannot consume state;
- missing or mismatched tool result does not reconstruct state from payload;
- failure cannot become empty search success, another engine attempt, provider fallback, or main-model re-entry.

## Architecture Map Changes Required First

The current `v3.web_search_servertool_state_machine` design map is not implementation-ready. Its internal secondary-dispatch/follow-up-marker edges must be replaced with:

1. Generic ServerToolCenter registry and typed per-tool/per-session state operations.
2. Existing stopless state migrated as the first isolated registered tool without behavior change.
3. Post-route GPT eligibility decision: preserve standard `web_search` or project it to local `websearch`.
4. Resp03 actual `websearch` call interception and typed ServerToolCenter transition.
5. ServerToolCenter `websearch` instance to forced VR `websearch` route edge.
6. Selected search target to the one-hop search request built from current canonical context.
7. Search response interception and result capture into the same `websearch` instance.
8. Responses hosted-search result projection plus original call-id continuation output.
9. Separate GPT native-search pass-through route/selection/wire edges.

Every edge must bind real adjacent symbols, allowed resources, forbidden paths, and required gates before feature status becomes active.

## Test Design

Red tests first:

1. Responses `search_content_types` reaches MiniMax/GLM OpenAI Chat compat and reproduces `UnmappedOutboundFields`.
2. A GPT native target is available but `web_search` is incorrectly replaced.
3. No GPT native target is available but `web_search` reaches non-GPT provider compat unchanged.
4. Resp03 intercepts `websearch` without same-turn ServerToolCenter activation.
5. Forced search route state is carried in normal payload instead of MetadataCenter.
6. Search result is returned with a new call id or loses typed result/citation fields.
7. Req04 rebuilds entry payload instead of using restored current context.
8. Wrong toolName/session/call id/scope consumes a stored result.

Positive gates:

1. Eligible configured GPT native target preserves native search, content types, and ordinary tools.
2. When no eligible GPT target exists, standard `web_search` is replaced exactly once by local `websearch`; ordinary tools remain unchanged.
3. An actual `websearch` call triggers exactly one forced VR `websearch` search hop.
4. The search request uses current canonical conversation input and MetadataCenter route control without rebuilding the entry payload.
5. Search result is stored only in the scoped ServerToolCenter `websearch` instance.
6. Resp03 projects the original call id as function output and a hosted `web_search_call`-equivalent completed result with query/action/typed results.
7. Main-model continuation proceeds through the normal path.

Negative gates:

1. Declaration alone does not execute search; it only participates in post-route tool-surface selection.
2. MiniMax/GLM OpenAI Chat wire never receives standard Responses `web_search` or unsupported `search_content_types`.
3. A non-eligible target cannot preserve standard `web_search`; an eligible configured GPT target cannot be forced through local `websearch`.
4. Wrong toolName or session cannot read, mutate, or consume another ServerToolCenter instance.
5. Control/result state cannot leak to provider/client/CLI/continuation payloads.
6. No private main-model re-entry, entry-payload rebuild, second Virtual Router, engine fallback, handler/SSE compensation, or silent strip exists.

## Completion Gates

Before implementation:

1. upgrade StoplessCenter into the generic ServerToolCenter resource and register typed per-tool/per-session operations in the resource map;
2. preserve stopless behavior as an isolated registered tool and add cross-tool/cross-session red gates;
3. register the one-hop Rust dispatcher owner and exact backend-binding resource;
4. replace the current design mainline with GPT native pass-through plus `websearch` forced-VR execution and hosted-result projection;
5. update function, verification, module, wiki, and manifest contracts;
6. record red evidence for both reported MiniMax/GLM 502 samples.

Implementation completion requires focused Rust positive/negative tests, architecture gates, V3 build, global install, one aggregate restart, all member-port health checks, exact same-entry live replay, proof of real search output and scope isolation, and Codex review after all runtime evidence passes.

Partial projection tests do not prove the lifecycle complete.
