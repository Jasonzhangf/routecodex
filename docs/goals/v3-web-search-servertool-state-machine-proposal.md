# V3 Web Search ServerTool State Machine Proposal

## Status

Proposal and architecture lock only. This document does not change runtime code, provider config, install state, or live servers.

## Corrected Requirement

V3 web search must separate two axes that are currently conflated:

1. **Route activation source**: whether the current turn actually needs web search.
2. **Provider execution mode**: how the selected search provider can execute web search.

A declared `web_search` tool in the request/tool list is not a route activation source. It is only a tool surface available to the model. Declared tools, tool descriptions, model capability metadata, or `/v1/models` fields must never by themselves route a request to `web_search`.

## Route Activation Rule

The `web_search` route may activate only from current-turn evidence:

1. **Actual tool call**: the model emits a current assistant tool call to the canonical RouteCodex `web_search` server tool.
2. **Explicit search intent**: the latest user turn has obvious fresh/search/current/web intent and policy chooses proactive search.
3. **Active web-search continuation**: a current-turn provider-native web-search call/result must be paired by the ServerTool state machine.

Non-triggers:

- request merely declares a `web_search` tool;
- normal tools are present;
- model/provider says it supports search;
- historical turns mention search without current-turn activation;
- route pool contains a search-capable provider.

## Provider Execution Modes

### Mode A — Native Remote Search + Tool Mixing

Example: GPT-family providers that can receive provider-native web search and ordinary tools together.

Behavior:

1. If current-turn evidence activates `web_search`, Virtual Router may select a Mode A target from the `web_search` route.
2. RouteCodex does not start a local ServerTool web-search state run.
3. RouteCodex forwards the request through the normal provider wire path and preserves provider-native search semantics.
4. Result/state persistence follows the provider/direct lifecycle already owned by that provider path.

This is a route-and-pass-through path. It is not ServerTool execution.

### Mode B — Native Remote Search, Search-Only / No Ordinary Tool Mixing

Example: MiniMax, per current project truth: MiniMax supports remote search, but cannot mix that search surface with ordinary tools.

Behavior for explicit search intent:

1. Current-turn search evidence activates `web_search`.
2. V3 ServerTool state manager starts a `web_search` state run.
3. Request ChatProcess prepares a search dispatch request by stripping non-search tools only inside this controlled search dispatch.
4. The provider request keeps only the provider-compatible remote-search surface needed by MiniMax.
5. Response ChatProcess captures the search result before final client projection.
6. The state manager records the result and emits/requires a controlled client-visible marker/echo, analogous to Stopless but owned by ServerTool.
7. On the next request, Request ChatProcess consumes the marker, injects the paired canonical tool result into conversation state, and resumes the normal main-model path.

This is remote search executed through a ServerTool internal state machine. It is not direct passthrough repair and not provider-compat lifecycle ownership.

### Mode C — Canonical RouteCodex ServerTool Search Call

Used when the normal main model has a canonical RouteCodex `web_search` server tool and chooses to call it.

Behavior:

1. Normal request remains on the normal route/provider. Merely injecting or declaring the server tool does not select the `web_search` route.
2. Response ChatProcess intercepts an actual current assistant `web_search` tool call.
3. ServerTool state manager starts a `web_search` run and dispatches a secondary search request through the `web_search` route.
4. The selected backend may be Mode A or Mode B, but the ServerTool state manager owns call/result pairing.
5. The captured search result is paired to the original tool call id and injected into the next governed request.

This preserves the V2 construction idea — model calls a server-side `web_search` tool and RouteCodex performs the search — but replaces V2 re-enter orchestration with a V3 internal state machine.

### Mode D — No Search

Providers without usable remote search stay normal model targets. They do not receive search-only shaping and do not trigger web-search execution.

## ServerTool State Manager

Introduce a generic V3 ServerTool state manager, modeled after Stopless isolation but independent from Stopless and continuation.

Responsibilities:

1. Classify the tool: `web_search` first, future server tools later.
2. Own the tool-specific state machine and transitions.
3. Own internal state keys, budgets, terminal cleanup, and failure state.
4. Coordinate Request ChatProcess and Response ChatProcess hooks without requiring Server/SSE/Virtual Router ownership.

Isolation key material:

- entry protocol / endpoint;
- server id / port / routing group;
- session id / conversation id;
- request id / response id where applicable;
- server tool run id;
- original tool call id for call/result pairing.

State is internal control-plane state only. It must not enter provider request body, provider SDK options, client response body, debug sample normal payload, or continuation store as semantic truth.

## `web_search` Tool State Machine

Initial states:

1. `Idle`
2. `TriggeredByIntent`
3. `TriggeredByToolCall`
4. `SearchDispatchPrepared`
5. `SearchProviderInFlight`
6. `SearchResultCaptured`
7. `FollowupMarkerProjected`
8. `FollowupMarkerConsumed`
9. `ToolResultInjected`
10. `Completed`
11. `Failed`

Key transitions:

- `Idle -> TriggeredByIntent`: latest user turn has explicit search intent.
- `Idle -> TriggeredByToolCall`: current assistant response calls canonical `web_search`.
- `Triggered* -> SearchDispatchPrepared`: Request ChatProcess builds provider-specific search dispatch.
- `SearchDispatchPrepared -> SearchProviderInFlight`: normal provider runtime sends the search request.
- `SearchProviderInFlight -> SearchResultCaptured`: Response ChatProcess captures a provider-native search result or normalized search answer.
- `SearchResultCaptured -> FollowupMarkerProjected`: client-visible marker/echo is projected so the next request can prove execution without leaking private state.
- `FollowupMarkerProjected -> FollowupMarkerConsumed`: Request ChatProcess validates marker scope and consumes it.
- `FollowupMarkerConsumed -> ToolResultInjected`: canonical tool result is injected under the original call id.
- `ToolResultInjected -> Completed`: main-model continuation proceeds normally.
- Any state -> `Failed`: provider/runtime/validation error enters Error01-Error06; no silent success.

## Hook Ordering

The state machine must live outside Responses continuation semantic mutation while preserving ordering:

- Request side: after valid continuation restore, before normal provider outbound governance where search dispatch/tool stripping is planned.
- Response side: before continuation save and before RespOutbound projection.
- Follow-up consume: next Request ChatProcess consumes marker before provider wire build.

This means ServerTool does not depend on continuation. It only respects the save/restore ordering boundary so it cannot mutate the immutable interval.

## Provider Wire Ownership

Provider compat/runtime may only encode provider-specific search wire shapes:

- MiniMax Mode B: build/search-only provider surface and reject mixed ordinary tools outside ServerTool-managed search dispatch.
- GPT Mode A: preserve native provider search + ordinary tool mix.
- Other providers: encode only their own declared wire protocol.

Provider compat must not decide route activation, start state runs, synthesize tool ids, execute lifecycle follow-up, or treat missing lifecycle state as provider-specific fallback.

## Virtual Router Ownership

Virtual Router only selects targets after route classification.

Allowed:

- consume a current-turn route decision such as `route=web_search`;
- choose a target from the route pool by configured priority and health/action policy.

Forbidden:

- using declared tools as route evidence;
- inspecting tool schema text as search intent;
- repairing mixed-tool provider payloads;
- executing server tools;
- pairing search results.

## Required Manifest / Config Concept

Search execution mode must be explicit in compiled provider/model capability truth, not inferred from provider name:

- `native_remote_search_tool_mix`
- `native_remote_search_search_only`
- `servertool_search_backend`
- `none`

MiniMax is `native_remote_search_search_only`.
GPT-family native search targets are `native_remote_search_tool_mix` when their provider protocol actually supports mixed tools plus remote search.

Only `web_search` and multimodal/vision are model capabilities that affect provider eligibility. “Thinking”, “longcontext”, “coding”, “default”, etc. remain routes, not capabilities.

## Implementation Phases

### Phase 0 — Lock Contract and Red Tests

1. Update function map / mainline call map / verification map for `v3.web_search_servertool_state_machine`.
2. Add red fixtures proving current broken behavior:
   - declared `web_search` tool routes incorrectly;
   - MiniMax receives mixed ordinary tools during search;
   - provider compat requires original Responses surface instead of ChatProcess-owned search dispatch;
   - search result cannot be paired without state-machine scope.

### Phase 1 — Route Trigger Classification

1. Move `web_search` route trigger to current-turn evidence only.
2. Add explicit search intent classifier fixtures.
3. Add negative tests for declared-tool-only requests.

### Phase 2 — Generic ServerTool State Manager

1. Add Rust-owned state manager in the ServerTool/ChatProcess owner area.
2. Add scope keys, lifecycle budget, terminal cleanup, and failure projection hooks.
3. Add positive/negative isolation tests by port/session/protocol/toolRunId.

### Phase 3 — `web_search` Tool State Machine

1. Implement `web_search` states and transitions.
2. Implement canonical servertool-call capture in Response ChatProcess.
3. Implement follow-up marker projection and marker consume in Request ChatProcess.
4. Inject paired tool result under the original tool call id.

### Phase 4 — Mode B Search-Only Provider Dispatch

1. Add provider search execution mode to compiled config/manifest.
2. For MiniMax search dispatch, strip ordinary tools only inside the state-machine-owned dispatch request.
3. Preserve the provider-native remote search surface.
4. Fail-fast if required non-search tool semantics would be lost outside the controlled dispatch.

### Phase 5 — Mode A Native Path

1. Ensure GPT-family/native tool-mix search path does not create ServerTool state.
2. Verify routing passes through normally and provider-native search semantics are preserved.

### Phase 6 — Live Validation

After red/green tests and build/install/restart:

1. MiniMax explicit search on 5520: enters `web_search`, strips ordinary tools in search dispatch, no `hosted web-search call input query is required`.
2. Declared search tool without intent/call: stays default/normal route.
3. GPT/native tool-mix search: routes to search-capable target without ServerTool state.
4. ServerTool call path: main model calls `web_search`, state manager dispatches secondary search, result pairs to original call id.
5. No codex-samples writes unless `--snap` or `--snapall` authorizes them.

## Tests / Gates

Required test categories:

1. Positive route activation: explicit user search intent.
2. Positive route activation: current assistant `web_search` tool call.
3. Negative route activation: declared tool only.
4. Mode A: no ServerTool state, no tool stripping.
5. Mode B: ServerTool state exists, ordinary tools stripped only during search dispatch.
6. Canonical servertool call: result pairs to original call id.
7. Isolation: wrong session/port/protocol/toolRunId cannot consume state.
8. Payload isolation: no ServerTool state leaks to provider/client/debug normal payload.
9. Error path: provider failure enters Error01-Error06 and does not become success.
10. Ordering: ServerTool hooks remain outside continuation immutable interval.

## Why This Matches V3 Architecture

- Route classification remains route classification; capabilities only gate eligibility for search/multimodal.
- Virtual Router selects targets and does not mutate payloads.
- Provider compat owns provider wire shape only.
- Request/Response ChatProcess owns tool governance, result pairing, and lifecycle hooks.
- State stays in an internal ServerTool control-plane resource, not provider/client payload.
- The design removes V2-style re-enter lifecycle ownership while preserving V2's semantic model: `web_search` is a server-side tool whose result is returned as a tool result.
