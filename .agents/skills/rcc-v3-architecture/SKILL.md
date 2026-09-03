---
name: rcc-v3-architecture
description: V3 pipeline, protocol, resource, and Rust ownership rules.
---

# RCC V3 Architecture

## Scope

V3 Hub Pipeline, Direct/Relay, Virtual Router, provider wire, protocol projection, continuation, Stopless, servertool, or architecture maps.

## Shape

```text
request: client -> inbound -> continuation -> Chat Process -> target -> outbound -> compat -> wire
response: raw -> compat -> inbound -> Chat Process -> continuation save -> outbound -> client
error: source -> classify -> local action -> exhaustion -> execution decision -> client projection
```

Request and response graphs stay separate. Error, health, availability, debug, and metadata stay side-channel resources.

## Owners

- Rust Chat Process: semantic governance.
- Virtual Router: classification and target selection.
- Provider runtime: transport/auth/provider compatibility.
- Adjacent codecs: protocol conversion.
- Direct: same-protocol passthrough.
- Relay: registered adjacent projection.
- Continuation: save at response Chat Process exit; restore at next request Chat Process entry.
- Stopless: registered Rust Req04/Resp03 owners only.

## Boundary Gate

Before edit: resource map -> function map -> mainline map -> verification map -> source/wiki. Reject unclear owner, edge, path, or resource relation. After edit: inspect imports, helpers, payload fields, new edges, and duplicate logic before tests.

## Protocol Rules

- Preserve source semantics at inbound.
- Match target wire spec at outbound.
- Unsupported/lossy mapping stays explicit and adjacent.
- Never use metadata, raw payload, handler, SSE, or provider runtime to restore semantics.
- Never merge protocol graphs into an untyped path.

## Runtime Gates

```text
target tests -> build -> global install -> `routecodex restart` -> all health -> same-entry replay -> review
```

Use generated V3 HTML review pages. Source maps: `docs/architecture/v3-resource-operation-map.yml`, `v3-function-map.yml`, `v3-mainline-call-map.yml`, `v3-verification-map.yml`.
