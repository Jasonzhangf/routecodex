# V3 Hub Relay Fixed Pipeline Review

Canonical contract: [V3 Hub Relay Fixed Pipeline Contract](../../design/v3-hub-relay-fixed-pipeline-contract.md)

Implementation plan: [V3 Hub Relay Four-Worker Implementation Plan](../../goals/v3-hub-relay-four-worker-implementation-plan.md)

Static skeleton: [V3 Hub Pipeline Static Skeleton Review](v3-hub-pipeline-static-skeleton.md)

## One lifecycle

~~~mermaid
flowchart TD
  R1[V3HubReqInbound01ClientRaw] --> R2[V3HubReqInbound02Normalized]
  R2 --> R3[V3HubReqContinuation03Classified]
  R3 --> R4[V3HubReqChatProcess04Governed]
  R4 --> R5[V3HubReqExecution05Planned]
  R5 --> R6[V3HubReqTarget06Resolved]
  R6 --> R7[V3HubReqOutbound07ProviderSemantic]
  R7 --> R8[V3ProviderReqOutbound08WirePayload]
  R8 --> R9[V3ProviderReqOutbound09TransportRequest]
  R9 --> P1[V3ProviderRespInbound01Raw]
  P1 --> S2[V3HubRespInbound02Normalized]
  S2 --> S3[V3HubRespChatProcess03Governed]
  S3 --> S4[V3HubRespContinuation04Committed]
  S4 --> S5[V3HubRespOutbound05ClientSemantic]
  S5 --> S6[V3ServerRespOutbound06ClientFrame]
~~~

Relay, Direct, servertool followup, Dry Run, JSON, SSE, remote continuation, and local continuation
are typed branches or hook profiles inside this lifecycle. They are not separate pipelines.

## Worker split

| Worker | Claim ID | Owns | Must prove |
| --- | --- | --- | --- |
| A | `feature_id:v3.hub_relay_request_semantics` | Req01-Req07 request semantics and provider-facing request shape | no request shortcut, restore only at Req04, provider request blackbox |
| B | `feature_id:v3.hub_relay_response_semantics` | Resp01-Resp06 response semantics and client projection | one response exit, save only at Resp04, client JSON/SSE blackbox |
| C | `feature_id:v3.hub_relay_runtime_resources_hooks` | Config Manifest resources, static entry/exit hooks, servertool hook profile | no dynamic hooks, Runtime consumes Manifest only, resource isolation |
| D | `feature_id:v3.hub_relay_gate_review_surface` | maps, wiki, verification gates, red fixtures, migration control | queryable owners/gates, shortcut red tests, P6 freeze |

## Continuation lock

~~~mermaid
flowchart LR
  Finalize[V3HubRespChatProcess03Governed<br/>finalize response semantics]
  Save[V3HubRespContinuation04Committed<br/>save local context]
  Store[Immutable interval<br/>normalization/storage/scope only]
  Classify[V3HubReqContinuation03Classified<br/>scope lookup only]
  Restore[V3HubReqChatProcess04Governed<br/>restore local context]
  Finalize --> Save --> Store --> Classify --> Restore
~~~

Between save and restore, only semantic-equivalent normalization, serialization, scope validation,
storage/transport, expiry, and release are legal. Request/response processing, tool governance,
servertool, routing, provider adaptation, required_action inference, Debug replay, and fallback are
forbidden in the interval.

## Hook placement

Every node has:

- typed input and output;
- entry hook;
- owning node logic;
- exit hook;
- allowed resources;
- explicit Error chain path.

Servertool is a Chat Process hook profile:

- request side: `V3HubReqChatProcess04Governed`;
- response side: `V3HubRespChatProcess03Governed`;
- followup re-entry: `V3HubReqInbound01ClientRaw`;
- no dedicated response exit and no immutable-interval logic.

## Payload ownership

Relay is borrow-first and move-at-boundary:

- current-node classification, hook planning, Debug indexing, Error classification, and resource
  lookup borrow typed views instead of cloning full payloads;
- adjacent semantic conversions move ownership when the previous truth is consumed;
- provider transport and server frame are the normal serialization boundaries;
- Debug/snapshot artifacts are redacted or truncated side-channel copies, not live business truth;
- any full request, response, context, provider wire, SSE, or continuation copy requires an owner
  node, bounded size, release point, and gate.

## Current status

- Hub v1 skeleton and static registry: implemented as source-only H1.
- P6 Responses Direct: frozen and verified as migration baseline.
- Relay request semantics: source slice and Anthropic controlled integration verified; live Relay remains pending.
- Relay response semantics: source slice and Anthropic controlled integration verified; live Relay remains pending.
- Runtime resources and static hook resource config: declaration surface and controlled static-registry consumption verified; live Relay remains pending.
- Relay maps/gates/wiki: architecture review surface locked by the D gates below.
- Payload copy-budget source/red gates: verified for the controlled integration surface.
- Anthropic Relay controlled Runtime integration: `/v1/messages` Server-owned wrapper, fixed Req01-Req09,
  generic Responses transport, fixed Resp01-Resp06, Error01-06, and JSON/SSE client projection are
  connected and verified against the controlled loopback upstream.
- Live 5555 validation/cutover, remote/local continuation E2E, P6 deletion, global installation,
  restart, release, real-provider compatibility, and production replacement remain pending.

## Anthropic controlled Runtime evidence

- Feature: `v3.anthropic_relay_runtime_integration`.
- Stable fixture digest: `74e56c98d05ced968949acdd5d73a05d2a78330cc58a50cae5445a30f50ff50e`.
- Pre-change red state: `status=wiring_missing`, with the eight missing adjacent edges diagnosed.
- Green controlled cases: `json_thinking_tool_use`, `sse_thinking_tool_use`, `provider_error`, and
  `side_channel_isolation`.
- Every case requires exactly one captured `POST /v1/responses` request; provider error must enter
  Error01-06 without a successful response trace; provider/client normal payloads must contain no
  RouteCodex control, Debug, resource, or selected-target side channel.
- The controlled driver calls `routecodex-v3-server::execute_v3_anthropic_messages_request`; it does
  not read fixture expected request/response/trace fields and does not prove a live listener cutover.

## A/B/C merge checklist

- A request: `v3-hub-relay-req-01..03` only; Req03 classifies, Req04 restores/governs; no Req05,
  Provider, Server, response, or dynamic-hook shortcut. Run request focused test/verifier/red fixture
  plus shared architecture gates.
- B response: `v3-hub-relay-resp-01..03` only; Resp03 governs and Resp04 commits once; no Resp05,
  SSE, Server, store, second-exit, or post-save semantic repair. Run response focused
  test/verifier/red fixture plus shared architecture gates.
- C resources/hooks: Config declares all fixed node entry/exit hooks and resource access; Manifest
  compiles deterministic `priority -> order -> hook_id`; Runtime consumes Manifest only; servertool
  remains Req04/Resp03. Run static-hook/resource/config/compile-fail gates.
- Integration: preserve existing node IDs and P6 freeze, run all D gates, then review copy budget,
  immutable interval, Error chain, provider/client payload isolation, and forbidden completion
  claims. No worker slice alone proves live Relay.

## Payload-copy runtime probe surface

- Feature: `v3.hub_relay_payload_copy_runtime_probes`.
- `v3-hub-relay-copy-probe-01` proves Relay JSON remains semantically intact through Req04 while
  the source gate rejects full-payload clones and JSON serialization roundtrips.
- `v3-hub-relay-copy-probe-02` proves SSE keeps its transport intent, one shared canonical response
  payload, and the sole Server response exit; the gate rejects stream collection/materialization.
- `v3-hub-relay-copy-probe-03` proves local context survives lookup release through Req04 and is
  released with the governed outcome.
- `v3-hub-relay-copy-probe-04` proves servertool response governance commits one Resp04 canonical
  context and the following request restores before Req04 servertool governance.
- These are test/source gates only. They do not establish live Relay, continuation persistence, or
  servertool runtime execution.

## Required gates

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

The wiki is not runtime evidence. Live Relay remains pending until a later controlled-upstream replay
proves request and response execution through the fixed Hub v1 skeleton.
