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
