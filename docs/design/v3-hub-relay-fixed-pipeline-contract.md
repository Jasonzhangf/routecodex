# V3 Hub Relay Fixed Pipeline Contract

## Status

This document is the Relay execution contract for the already-frozen Hub v1 skeleton. Relay is not a
second lifecycle, a server-handler path, or a provider-specific branch. Relay is one execution mode
inside the fixed Hub v1 request and response chains defined in
[V3 Hub Pipeline Static Skeleton Contract](v3-hub-pipeline-static-skeleton-contract.md).

The contract in this file is source and planning truth only. Runtime implementation, live Relay,
continuation runtime, servertool runtime hooks, and provider protocol expansion remain pending until
their worker gates pass.

## Relay lifecycle invariant

Every Relay request and response must traverse the same fixed nodes as Direct:

~~~text
V3HubReqInbound01ClientRaw
  -> V3HubReqInbound02Normalized
  -> V3HubReqContinuation03Classified
  -> V3HubReqChatProcess04Governed
  -> V3HubReqExecution05Planned
  -> V3HubReqTarget06Resolved
  -> V3HubReqOutbound07ProviderSemantic
  -> V3ProviderReqOutbound08WirePayload
  -> V3ProviderReqOutbound09TransportRequest
  -> V3ProviderRespInbound01Raw
  -> V3HubRespInbound02Normalized
  -> V3HubRespChatProcess03Governed
  -> V3HubRespContinuation04Committed
  -> V3HubRespOutbound05ClientSemantic
  -> V3ServerRespOutbound06ClientFrame
~~~

No request path can short-circuit around Chat Process, Virtual Router/Target, Provider wire build,
response Chat Process, continuation commit, client projection, or the global Error chain. A branch
with no current semantic work returns an explicit typed no-op result for that node.

## Four parallel implementation sections

Relay implementation is split into four parallel workstreams. Each worker owns a contract slice and
must keep the fixed node IDs unchanged.

| Worker | Claim ID | Scope | Primary nodes | Required output |
| --- | --- | --- | --- | --- |
| A Request semantic chain | `feature_id:v3.hub_relay_request_semantics` | Entry protocol normalization, continuation classification, request Chat Process, execution plan, target resolution, provider semantic request | Req01-Req07 | Rust node contracts, request hooks, request whitebox and provider-facing blackbox gates |
| B Response semantic chain | `feature_id:v3.hub_relay_response_semantics` | Provider raw normalization, response Chat Process, continuation commit, client semantic projection, server frame handoff | Resp01-Resp06 | Rust node contracts, response hooks, client-facing blackbox gates |
| C Runtime resources and hook registry | `feature_id:v3.hub_relay_runtime_resources_hooks` | Config-published runtime resources, deterministic manifest, static entry/exit hook registry, servertool hook profile | All nodes as hook slots | Config/resources/hooks compile gates, no dynamic hook discovery |
| D Maps, gates, wiki, migration control | `feature_id:v3.hub_relay_gate_review_surface` | Resource map, function map, mainline map, verification map, wiki, red fixtures, P6 freeze and deletion guard | Documentation and architecture gates | Queryable owner/gate surface and red tests that reject shortcuts |

The four workers may edit their own claimed Rust/docs/gate surfaces, but must not insert new Hub
nodes, renumber nodes, create a second response exit, switch live server entry, delete P6, mutate
`~/.rcc`, restart live servers, or add TypeScript business semantics.

## Request-side contract

Relay request processing is:

~~~text
client protocol request
  -> V3HubReqInbound02Normalized: lossless entry normalization
  -> V3HubReqContinuation03Classified: classify new / remote / local continuation ownership
  -> V3HubReqChatProcess04Governed: restore local context if owned by RouteCodex, then run tools,
     history, servertool request hooks, and request logic
  -> V3HubReqExecution05Planned: choose Relay execution mode from Manifest facts and current request
  -> V3HubReqTarget06Resolved: route or validate pinned target through the standard target node
  -> V3HubReqOutbound07ProviderSemantic: normalize Chat semantics to provider-neutral outbound intent
  -> V3ProviderReqOutbound08WirePayload: adapt to the selected provider wire protocol
  -> V3ProviderReqOutbound09TransportRequest: build the standard provider transport request
~~~

Allowed request work:

- Req01/Req02 may preserve raw request evidence, syntax, entry endpoint, and round-trip-equivalent
  normalization only.
- Req03 may classify continuation ownership and scope, but it must not restore or repair history.
- Req04 is the only request-side owner for local continuation restore, request tool governance,
  servertool request hooks, history/context governance, and Relay request logic.
- Req05 may plan Direct/Relay and target-resolution mode; it does not touch normal payload.
- Req06 may perform routed or pinned target resolution and target-local selection only.
- Req07/Req08 may convert current Chat semantics to provider semantic and wire shapes; no tool or
  history governance is allowed there.
- Req09 may build auth/transport only; provider health mutation remains inside Provider runtime.

Forbidden request work:

- inferring Direct from same protocol or GPT family;
- restoring context in Req02, Req03, Server, handler, SSE, store transport, Provider, or Debug;
- repairing tool_call/tool_output order outside Req04;
- using Debug snapshots or raw captures as request truth;
- routing again after a pinned continuation or after target exhaustion has entered Error chain;
- copying internal metadata into provider wire payload.

## Response-side contract

Relay response processing is the reverse semantic path:

~~~text
provider raw response
  -> V3HubRespInbound02Normalized: parse provider raw response to Hub response semantic
  -> V3HubRespChatProcess03Governed: run response tool harvest, servertool response hooks,
     response logic, and final semantic governance
  -> V3HubRespContinuation04Committed: commit none / remote binding / local context truth
  -> V3HubRespOutbound05ClientSemantic: project finalized Hub response to entry protocol semantics
  -> V3ServerRespOutbound06ClientFrame: HTTP JSON/SSE frame transport only
~~~

Allowed response work:

- Resp01/Resp02 may parse provider JSON/SSE/raw bodies into canonical response semantics.
- Resp03 is the only response-side owner for tool harvest, servertool response hooks, response
  business logic, terminal/non-terminal semantic judgment, and finalization before save.
- Resp04 is the only owner for continuation commit.
- Resp05 may project finalized semantics to the original entry protocol.
- Resp06 may frame JSON/SSE and handle transport closeout only.

Forbidden response work:

- saving continuation in Resp05, Resp06, Server, SSE, handler, adapter, or store transport;
- inferring required_action, repairing tool calls, or rebuilding history after Resp03;
- creating a servertool-specific response exit;
- putting internal metadata/debug/error carriers into the client normal response body;
- using provider family or model prefix branches in Hub/VR/Server;
- wrapping provider/runtime errors into success.

## Continuation immutable interval

For local continuation, save and restore are the only semantic continuation operations:

~~~text
V3HubRespChatProcess03Governed
  -> V3HubRespContinuation04Committed(LocalContext save)
  -> immutable interval
  -> V3HubReqContinuation03Classified(scope lookup only)
  -> V3HubReqChatProcess04Governed(LocalContext restore)
~~~

Between save and restore, the system may only perform semantic-equivalent normalization,
lossless serialization/deserialization, scope validation, storage, transport, expiry, and release.
The required invariant is:

~~~text
restore(normalize(save(context))) == context
~~~

The interval must not run request processing, response processing, Chat Process logic, tool
governance, servertool hooks, required_action inference, request rebuild, response repair, target
selection, provider adaptation, Debug replay, snapshot recovery, fallback, or error-to-success
wrapping. If any operation would change the context that restore later sees, it belongs before
response-side save or after request-side restore.

Remote/provider-owned continuation stores only the remote locator, owner, entry protocol,
server/port/group/session scope, provider/model/auth pin, capability revision, and expiry. It does
not save local Chat Process context and cannot silently become Relay/local continuation.

## Static hook contract

Every fixed node has entry and exit hooks. Hook IDs are static Rust symbols compiled into the
binary and selected only through the compiled Manifest.

Hook execution shape:

~~~text
node entry hook(s)
  -> owning node logic
  -> node exit hook(s)
  -> adjacent next node
~~~

Hook rules:

- hook input and output are the current node's typed contract only;
- hook effects must declare allowed runtime resources before startup;
- required hook missing/failure/invalid output is fail-fast;
- optional hook disabled returns a typed no-op event;
- hook ordering is deterministic: `priority -> order -> hook_id`;
- duplicate hook IDs, unknown hook IDs, incompatible node pairs, or dynamic discovery fail config
  compilation/startup;
- hooks cannot call a later node, create a lifecycle, write business payload from side-channel
  metadata, or bypass Error01-06.

Servertool is a Chat Process hook profile:

- request-side servertool hooks run inside `V3HubReqChatProcess04Governed` after legal local
  continuation restore and before provider semantic projection;
- response-side servertool hooks run inside `V3HubRespChatProcess03Governed` before continuation
  commit;
- servertool followup re-enters `V3HubReqInbound01ClientRaw` as a typed invocation source and uses
  the same lifecycle;
- servertool never owns a dedicated response projection or a lifecycle inserted between save and
  restore.

## Runtime resource configuration

Runtime resources are declared in `config.v3.toml`, validated by `routecodex-v3-config`, compiled
into deterministic Manifest resources, and consumed by Runtime. Runtime must not read config files
or directories directly.

Config may declare:

- hook sets and static hook IDs;
- protocol capabilities;
- allowed execution modes;
- continuation owner policies and scope keys;
- servertool hook profiles;
- debug/snapshot/dry-run resource policies;
- provider/model capabilities and target resources.

Config may not declare:

- request-specific selected execution mode;
- selected continuation owner;
- selected provider target for a concrete request;
- resolved secrets;
- dynamic hook code;
- alternate lifecycle nodes;
- provider/client payload patches.

Resource scopes must be explicit: `server`, `listener`, `routing_group`, `session`, `request`,
`provider`, `hook`, or `debug`. Side-channel resources may never enter provider body or client
normal body unless their resource map explicitly permits it.

Relay live-path payload copy budget is a startup and architecture contract, not a later performance
optimization; unbounded deep copy of request, response, context, continuation, or provider-wire
truth is forbidden. Full SSE materialize for hook planning, governance, Debug, snapshot, retry, or
continuation is forbidden. Debug/snapshot copy is bounded, redacted side-channel evidence only and
must never become business truth, restore truth, or a substitute for the current typed node value.
Any intentionally retained full payload must declare its unique owner node, byte/item bound,
release point, and required gate; absence of any declaration is fail-fast.

## Worker gates

Each worker must include positive and negative gates.

Minimum shared gates:

- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-static-hook-registry`
- `npm run test:v3-hub-skeleton-doc-red-fixtures`
- `npm run test:v3-compile-fail`
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `npm run test:v3-workspace`

Additional gate intent:

- Worker A locks request nodes, no request shortcut, no context restore outside Req04, and
  provider-facing wire equivalence.
- Worker B locks response nodes, no second response exit, no continuation save after Resp04, and
  client-facing projection equivalence.
- Worker C locks config/resource/hook manifest determinism, no dynamic hooks, servertool placement,
  and immutable-interval resource isolation.
- Worker D locks maps/wiki/red fixtures, no P6 extension, no second lifecycle, and no unqueryable
  owner or gate.

## Completion rule

This phase is complete only when the Relay request/response/resource/gate contracts are queryable in
the design docs, maps, wiki, and verification surface, and architecture gates prove that worker
outputs cannot add shortcuts or independent lifecycles.

Do not claim live Relay, usable continuation runtime, servertool runtime hooks, Hub v1 cutover,
additional protocols, P6 deletion, production replacement, global install, or real provider
compatibility from this contract phase.
