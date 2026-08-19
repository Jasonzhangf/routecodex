# V4 Real Runtime Admission Review Surface

status: design
manifest: `v4/contracts/real-runtime-admission.manifest.json`
owner_feature_id: `v4.runtime.independent_admission`

## Entry

```text
compiled manifest -> rccv4 -> HTTP listener
```

Required client entrypoints:

| Method | Path | Projection |
| --- | --- | --- |
| GET | `/health` | JSON |
| GET | `/v1/models` | JSON |
| POST | `/v1/responses` | JSON |
| POST | `/v1/responses` | SSE |

## Mainline

```text
routecodex-v4-runtime-bin
  -> routecodex-v4-server
  -> V4ServerReqInbound01ClientRaw
  -> V4ServerSseIn02FrameBoundary
  -> V4HubReqInbound03Normalized
  -> V4HubReqChatProcess04Governed
  -> V4HubReqOutbound05ProviderSemantic
  -> V4ProviderReqCompat06Compat
  -> V4ProviderSseOut07WireBoundary
  -> V4ProviderSseIn01FrameBoundary
  -> V4HubRespInbound02Parsed
  -> V4HubRespChatProcess03Governed
  -> V4HubRespOutbound04ClientSemantic
  -> V4ServerSseOut05FrameBoundary
  -> V4ServerRespOutbound06ClientFrame
```

The module-level admission edges are governance bindings. They are separate
from the frozen pipeline node graph; only the canonical `V4*` data-flow edges
above participate in node-topology validation.

Each arrow is an adjacent transition. The runtime owns semantic node
transitions; the provider owns only upstream transport and provider error
source; the server owns listener and client framing; the router owns typed
target selection.

## Control Boundary

Routing, retry, health, scope, error, debug, secret handles, manifest digest,
and request identity remain typed side-channel or error-chain facts. They must
not enter provider/client normal payloads. Payload cannot reconstruct control
state. Leakage fails at the owning boundary.

## Phase 0 Red Checklist

- [ ] independent `routecodex-v4-runtime-bin` and `rccv4`
- [ ] compiled manifest digest and drift fail-fast
- [ ] real provider config/auth/HTTP transport
- [ ] independent HTTP listener and four entrypoints
- [ ] Responses JSON and SSE adaptor/projector
- [ ] typed provider Error01-06 source path
- [ ] V3 zero-read/zero-call/zero-restart/zero-modify evidence

Phase 0 must remain red for these implementation items. Later phases replace
the baseline-red gate with implementation-specific positive and negative gates.

## Canonical Evidence

- `v4/contracts/real-runtime-admission.manifest.json`
- `v4/docs/goals/v4-real-runtime-admission-plan.md`
- `v4/.appsdk/maps/resource-map.json`
- `v4/.appsdk/maps/function-map.json`
- `v4/.appsdk/maps/mainline-call-map.json`
- `v4/.appsdk/maps/module-registry.json`
- `v4/.appsdk/maps/verification-map.json`
