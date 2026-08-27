# V4 control-event and SSE/provider boundary audit

## Control signal matrix

All control semantics are request-local typed events carried by `MetadataCenter` or the typed error chain. They are never serialized into normal protocol metadata, provider wire payloads, or client response bodies.

| Domain | Typed event kind | Owning boundary | Negative invariant |
| --- | --- | --- | --- |
| routing | `Route` | virtual router | route facts cannot appear in payload |
| switching | `Switching` | execution policy | switch state cannot be reconstructed from payload |
| retry | `Retry` | error/execution policy | retry state cannot enter provider body |
| provider selection | `ProviderSelection` | provider selection policy | provider key cannot enter client body |
| health | `Health` | availability owner | health state is not protocol metadata |
| continuation | `Continuation` | response/request Chat Process | local/relay state cannot be saved |
| stopless | `Stopless` | Chat Process | guidance is not a control field |
| servertool | `Servertool` | servertool control owner | control fields cannot enter tool output |
| error | `Error` | Error chain | intermediate failure is not client SSE success |
| scope | `Scope` | scope registry | a signal cannot cross request/session/port scope |

The positive lifecycle is `register -> consume -> release`; duplicate, cross-scope, metadata-derived, payload-reconstructed, and control-to-payload writes fail fast. Coverage is enforced by `routecodex-v4-control/tests/l2_control.rs`.

## SSE/client/provider boundary

```text
provider transport bytes -> provider protocol normalization
    -> runtime semantic frame validation/projection
    -> server ResponseStream client framing
```

The provider owns transport and raw bytes only. Runtime owns semantic frame decisions and continuation/error control. Server owns client framing and backpressure. The SSE stream does not publish frames to the Cordis event bus and does not read client metadata as control state.

Payload bytes remain complete. Native async provider chunks use shared `Bytes` ownership and bounded splitting; no payload fields are removed to reduce allocation. The changed provider test directly proves chunk-cap and concatenation equality; runtime-bin and server stream behavior remain covered by their existing focused suites. Control-plane coverage is the ten-domain lifecycle test plus payload/metadata leakage negatives.

## 2026-08-27 master audit result

The boundary was checked against the current Rust call sites and focused tests:

| Boundary | Owner | Allowed representation | Forbidden coupling | Result |
| --- | --- | --- | --- | --- |
| provider transport -> runtime | `routecodex-v4-provider` / runtime adapter | raw bytes or bounded `Bytes` chunks | client frame/protocol projection in provider | PASS |
| runtime semantic stream | `routecodex-v4-runtime-bin` | runtime-owned `ProviderSseSource`, typed frame validation and event/error decisions | provider-specific client response logic | PASS |
| runtime -> client server | `routecodex-v4-server` | `ResponseStream` client bytes and backpressure | provider status/tool/continuation decisions | PASS |
| control plane | `routecodex-v4-control` | scoped typed event register/consume/release and error chain | normal payload, protocol metadata, SSE data | PASS |

The runtime adapter is the only provider-to-runtime seam: `ProviderSseSource` exposes read/wait operations and the server sees only `ResponseStream`. No provider type or provider status is exported through the server API. Provider chunks use `Bytes` and bounded splitting; runtime frame buffering is the semantic framing boundary and therefore may materialize a complete frame before validation. Client framing materializes only the projected client frame. These copies preserve byte-for-byte payload semantics and are covered by positive nested-payload tests and malformed/terminal negatives.

The audit does not authorize payload trimming or control-field stripping. Any control look-alike arriving in payload is treated as business data and cannot create an event; the inverse (writing a control event into payload) fails fast. No local/relay continuation state is accepted by this SSE path; only direct provider-owned continuation can reach the registered continuation event owner.
