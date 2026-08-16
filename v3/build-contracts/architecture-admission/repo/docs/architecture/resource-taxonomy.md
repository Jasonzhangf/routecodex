# Resource Taxonomy

## Purpose

This document defines the RouteCodex resource model used to converge request and response operations without creating a global mutable request/response object.

The machine-readable owner and gate source is `docs/architecture/resource-operation-map.yml`. This page explains the taxonomy and the invariants enforced by resource gates.

## Core Rule

RouteCodex request handling is a lifecycle of typed resources:

```text
client request
  -> request resources
  -> route resources
  -> provider wire resources
  -> provider response resources
  -> response resources
  -> client frame resources
```

Side-channel resources such as metadata, errors, continuation, dry-run, snapshot, and provider runtime observation must remain outside normal request/response payloads.

Unique resource identity does not mean one global mutable object. Each resource has a unique owner, allowed readers, allowed writers, lifecycle nodes, and forbidden crossings.

## Resource Classes

### `request.normal_payload`

Client-visible request payload after entry parsing and non-destructive normalization.

- Identity: `requestId`, `pipelineId`, `entryEndpoint`, `portScope`.
- Canonical writer: server entry / Hub request inbound owners.
- Forbidden: response stages, provider response converters, SSE handlers.
- Boundary: must not carry internal metadata, debug, snapshot, or error carriers.

### `request.protocol_context`

Entry protocol facts such as endpoint, request path, headers, stream intent, client originator, and route-local scope.

- Identity: current request lifecycle only.
- Canonical writer: server inbound / handler bridge.
- Forbidden: provider runtime reconstructing protocol facts from stale metadata.

### `request.provider_semantic`

Provider-neutral outbound semantic request after Hub request governance and route selection.

- Identity: selected route target plus governed request.
- Canonical writer: Hub request outbound.
- Forbidden: direct response handlers, SSE transport, response outbound.

### `provider.wire_payload`

Final upstream provider HTTP body, headers, URL, method, and stream intent.

- Identity: provider attempt, provider key, runtime key, request ID.
- Canonical writer: provider runtime / provider outbound codec.
- Forbidden: Hub response pipeline, response converter, snapshot replay.
- Boundary: internal metadata and debug carriers must not be present.

### `response.provider_raw`

Raw provider response body/stream/status/headers before Hub response parsing.

- Identity: provider attempt and request ID.
- Canonical writer: provider runtime transport.
- Forbidden: client response projection writing back into provider raw truth.

### `response.hub_semantic`

Canonical Hub response after provider parsing and response Chat Process governance.

- Identity: request ID, provider protocol, entry endpoint.
- Canonical writer: Hub response inbound and response Chat Process owners.
- Forbidden: server handler semantic repair after response outbound.

### `response.client_payload`

Client-visible semantic response before HTTP/SSE framing.

- Identity: entry endpoint and client protocol.
- Canonical writer: Hub response outbound / protocol projection owner.
- Forbidden: continuation restore, request history repair, provider error policy.

### `metadata.runtime_control`

RouteCodex-owned internal control side-channel for route/runtime/stopless/servertool/error/scope decisions.

- Identity: request-scoped `MetadataCenter`.
- Canonical writer: metadata center family owners.
- Forbidden: provider wire body, SDK options, client normal response body.

### `metadata.request_truth`

Write-once request identity facts such as request ID, session ID, conversation ID, entry endpoint, and client request ID.

- Identity: request-scoped `MetadataCenter`.
- Canonical writer: inbound metadata materialization.
- Forbidden: continuation history, tmux/client attachment scope, response closeout.

### `metadata.response_observation`

Append-only response observations used for lifecycle closeout and diagnostics.

- Identity: request-scoped `MetadataCenter`.
- Canonical writer: response observation owners.
- Forbidden: request-side mutation and response closeout repair.

### `error.chain`

Unified provider/runtime/direct/executor error chain from source raise to client projection.

- Identity: failure event plus runtime scope.
- Canonical writer: ErrorErr chain owners.
- Forbidden: local retry policy in provider/direct caller, fallback success projection.

### `route.selection`

Virtual Router selected target and route decision.

- Identity: routing group, route, provider key, runtime key, request scope.
- Canonical writer: Virtual Router / Hub route bridge.
- Forbidden: provider runtime or handler local target substitution.

### `provider_runtime.observation`

Provider runtime health/success/error observation that feeds router policy.

- Identity: provider key, runtime key, provider family, process scope.
- Canonical writer: provider runtime ingress/error reporter.
- Forbidden: session-storm or client projection rewriting provider availability truth.

### `continuation.scope_state`

Responses continuation save/restore state.

- Identity: entry protocol, continuation owner, port/routing group, session/conversation scope, response ID.
- Canonical writer: Chat Process continuation owner.
- Forbidden: handler/outbound/SSE save or restore between `resp_chatprocess save` and next `req_chatprocess restore`.

### `dryrun.provider_request_probe`

Local-only diagnostic probe that returns final provider request without touching upstream.

- Identity: current local dry-run request or replayed sample.
- Canonical writer: debug dry-run owner plus provider request cut point.
- Forbidden: becoming a second provider request builder or response converter.

### `snapshot.debug_sample`

Debug/sample artifact of request/response/provider state.

- Identity: endpoint, port, request ID, phase.
- Canonical writer: debug snapshot owners.
- Forbidden: becoming runtime truth or reconstructing normal payload semantics.

### `sse.transport_frame`

Client-visible stream frames after semantic response projection.

- Identity: response stream and client protocol.
- Canonical writer: SSE projection/transport owners.
- Forbidden: schema judgment, continuation save/restore, provider response repair.

### `servertool.followup_state`

Servertool/stopless hook state and client-visible CLI projection state.

- Identity: Chat Process lifecycle, request scope, flow ID.
- Canonical writer: servertool/stopless Chat Process owners.
- Forbidden: provider runtime, SSE transport, handler post-projection repair.

## Resource Operation Rules

- Every resource operation must bind to a `feature_id`.
- Every write operation must name an owning lifecycle node.
- Every mainline resource flow must stay adjacent to the edge it describes.
- Side-channel resources must be explicitly listed as side-channel reads/writes.
- Normal payload resources must not embed side-channel resource fields.
- Direct passthrough is still resource-bound; it is not a shortcut around ownership.

## Refactor Rule

Runtime refactors may start only after resource ownership and resource flow are machine-validated. Refactor one resource operation at a time, prove the old implementation is no longer an owner, and physically delete duplicate or wrong-layer code after verification.
