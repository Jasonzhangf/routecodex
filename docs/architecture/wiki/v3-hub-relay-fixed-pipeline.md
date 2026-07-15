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
- Relay request semantics: pending.
- Relay response semantics: pending.
- Runtime resources and static hook resource config: pending.
- Relay maps/gates/wiki: this review surface defines the next parallel work split.
- Payload copy-budget runtime gates: pending.

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
