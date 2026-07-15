# V3 OpenAI Chat Relay Controlled Runtime

[Implementation plan](../../goals/v3-openai-chat-relay-runtime-integration-plan.md) ·
[Test design](../../goals/v3-openai-chat-relay-runtime-integration-test-design.md) ·
[Machine manifest](../manifests/v3.openai_chat_relay.controlled_runtime.mainline.yml) ·
[HTML review](html/v3-openai-chat-relay-controlled-runtime.html)

## Status

- Feature: `v3.openai_chat_relay_runtime_integration`.
- Evidence boundary: controlled Rust loopback JSON/SSE/error/isolation only.
- Live provider compatibility, install, restart, release, and production cutover remain pending.
- Responses Direct, Anthropic continuation, and Provider WebSocket owners are unchanged.

## Single lifecycle

```mermaid
flowchart LR
  S[V3OpenAiChatRelayRuntimeInput] --> R1[V3HubReqInbound01ClientRaw]
  R1 --> R2[V3HubReqInbound02Normalized]
  R2 --> R3[V3HubReqContinuation03Classified]
  R3 --> R4[V3HubReqChatProcess04Governed]
  R4 --> R5[V3HubReqExecution05Planned]
  R5 --> R6[V3HubReqTarget06Resolved]
  R6 --> R7[V3HubReqOutbound07ProviderSemantic]
  R7 --> R8[V3ProviderReqOutbound08WirePayload]
  R8 --> R9[V3ProviderReqOutbound09TransportRequest]
  R9 --> P[(OpenAI Chat upstream)]
  P --> P1[V3ProviderRespInbound01Raw]
  P1 --> P2[V3HubRespInbound02Normalized]
  P2 --> P3[V3HubRespChatProcess03Governed]
  P3 --> P4[V3HubRespContinuation04Committed]
  P4 --> P5[V3HubRespOutbound05ClientSemantic]
  P5 --> P6[V3ServerRespOutbound06ClientFrame]
```

The machine edge IDs are `v3-openai-chat-relay-01..15`. Server owns only HTTP entry and final
transport. Runtime owns OpenAI Chat protocol characterization, adjacent Hub orchestration,
provider invocation, response governance, and Error01–06 projection.

## JSON, SSE, error, isolation

| Surface | Controlled evidence | Locked risk |
|---|---|---|
| JSON | Loopback captures one `/v1/chat/completions` request and returns exact Chat response | model wire rewrite without messages/tools/tool-result loss |
| SSE | Shared incremental decoder; Runtime returns `V3OpenAiChatClientStream`; Server uses `Body::from_stream` | first frame does not wait for terminal; no full stream materialization |
| Error | Loopback 429 enters `V3Error01SourceRaised` through `V3Error06ClientProjected` | provider failure never becomes Resp01/success |
| Isolation | `metadata_center` fails before provider send; capture count stays unchanged | internal control truth never enters provider/client normal payload |

## Ownership checklist

- [x] Rust-only Runtime and Server wiring.
- [x] Existing Hub v1 Req01–Req09 and Resp01–Resp06 nodes only.
- [x] Static hook registry only; no dynamic discovery.
- [x] No fallback, second Runtime kernel, or Responses Direct re-entry.
- [x] No raw SSE body collection or Server-side Chat semantic parsing.
- [x] Source/mutation gates cover missing nodes, transport bypass, fallback, dynamic hooks,
  materialization, and side-channel leakage.
- [ ] Live provider replay and production lifecycle; explicitly outside this controlled slice.

## Required gates

```text
npm run test:v3-openai-chat-relay-runtime-integration
npm run verify:v3-openai-chat-relay-runtime-integration
npm run test:v3-openai-chat-relay-runtime-integration-red-fixtures
npm run verify:v3-module-boundaries
npm run verify:v3-rust-only
npm run verify:v3-architecture-docs
npm run verify:v3-resource-map
cargo fmt --manifest-path v3/Cargo.toml --all -- --check
CARGO_NET_OFFLINE=true cargo clippy --manifest-path v3/Cargo.toml --workspace --all-targets -- -D warnings
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml --workspace -- --nocapture
git diff --check
```
