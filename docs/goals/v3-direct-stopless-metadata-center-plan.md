# V3 Direct Stopless MetadataCenter Lifecycle Plan

## Scope

Feature: `v3.direct_stopless_metadata_center`.

Goal: make `/v1/responses` same-protocol Direct participate in the StoplessCenter control lifecycle through a Direct-scoped MetadataCenter/runtime-control handle, while keeping Direct as provider passthrough + hooks and keeping Relay continuation/StoplessCenter separate.

## Problem source

Direct currently has a remote-continuation store, provider-health policy, request/response projection hooks, and SSE observation, but its stopless request hook only strips stale generated guidance. It does not load or write StoplessCenter state, does not inject the provider-visible `reasoningStop` schema guidance for Direct turns, and reports `stopless_activation=false` even when a Direct turn would need the same stopless lifecycle as Relay.

## Root cause

The StoplessCenter resource was correctly defined as a MetadataCenter/runtime-control truth, but the only concrete adapter handle is Relay-scoped (`V3ResponsesRelayStoplessControlState` / `Scope`). Direct has no equivalent handle, so Direct cannot bind the control state to `entryEndpoint + sessionId + conversationId + port + routingGroup` and cannot pair request-side guidance with response-side same-turn evidence.

## Design

1. Add Direct adapter handles under the existing semantic owner `StoplessCenterMetadataControl`:
   - `V3ResponsesDirectStoplessControlScope`
   - `V3ResponsesDirectStoplessControlState`
2. Derive the Direct stopless scope from the Direct continuation scope. Request-fallback scopes (`request:<requestId>`) and missing client session/conversation stay inactive and write nothing.
3. Run Direct request control only after the execution decision confirms `SameProtocolDirect`, so routing/capability selection is not polluted by stopless tools and Relay handoff receives the original payload.
4. On Direct request:
   - load Direct-scoped StoplessCenter state from the MetadataCenter-equivalent runtime-control handle;
   - run the existing Rust stopless Req04 hook;
   - store the same-turn `ProviderTurnInFlight` state or clear stale state if a restored control state could not be continued.
5. On Direct JSON response:
   - use the same Rust stopless response hook functions against a Direct-owned response control node;
   - update only Direct-scoped StoplessCenter state;
   - never write Relay StoplessCenter or local Relay continuation;
   - when a native upstream Direct response id is projected into a client-visible no-op tool bridge, commit a Direct remote locator for that native response id so the next `previous_response_id` stays Direct.
6. On Direct SSE response:
   - keep SSE transport-only; the wrapper only decodes/re-encodes frames and invokes the same Rust Direct stopless response control helper on terminal `response.completed` / `response.done` payloads;
   - state transitions remain in the Direct StoplessCenter handle, not in the SSE layer.
7. Direct normal payload isolation remains unchanged:
   - StoplessCenter state never enters provider body, client body, CLI args/stdout, debug snapshots, or continuation payload/history;
   - only current-turn provider-visible guidance/tool declaration and client-visible no-op CLI bridge are normal protocol projections.
   - if an upstream Direct response echoes injected stopless `instructions`, internal `reasoningStop` tools, or stopless-enforced `tool_choice`, Direct response control strips that echo before client projection while preserving original client-visible instructions.

## Lifecycle nodes

```text
V3Execution11ProtocolDecision(SameProtocolDirect)
  -> V3DirectStoplessReq01RuntimeControlLoaded
  -> V3DirectStoplessReq02NoopCliConsumed
  -> V3DirectStoplessReq03GuidanceToolInjected
  -> V3ResponsesDirect11Policy
  -> provider
  -> V3DirectResp14ProviderProjectionPrepared
  -> V3DirectStoplessResp01EvidenceObserved
  -> V3DirectStoplessResp02RuntimeControlUpdated
  -> V3DirectStoplessResp03NoopCliOrTerminalProjected
  -> V3DirectResp15ClientPayloadReady
```

These nodes are Direct-only internal control nodes. They do not re-enter Relay `V3HubRespChatProcess03Governed` and do not write Relay continuation.

## Test design

Red/green coverage required in the same change set:

1. Direct JSON active positive: scoped Direct request injects exactly one `reasoningStop`, completed no-summary provider response preserves visible text, projects no-input `routecodex hook run reasoningStop`, writes Direct StoplessCenter state, and does not create Relay state.
2. Direct next-turn positive: the no-op CLI output is consumed by Req04, stale CLI artifacts are removed, continuation guidance is appended, `reasoningStop` is re-injected, and Direct StoplessCenter transitions back to same-turn active state.
3. Direct terminal positive: canonical reasoning summary / accepted terminal evidence clears Direct StoplessCenter and passes through.
4. Direct inactive negative: request-fallback/missing client scope and `[features].stopless_center=false` pass through unchanged and do not write Direct StoplessCenter.
5. Direct SSE positive: active Direct terminal `response.completed` / `response.done` frames are projected through the same Rust helper and write Direct StoplessCenter; the SSE code remains a transport projection wrapper.
6. Existing Relay stopless tests stay green; Direct must not write `V3ResponsesRelayStoplessControlState`.
7. Architecture gates must reject StoplessCenter access outside declared Direct/Relay handles and must reject reintroducing `direct_stopless_center_write=forbidden`.

## Verification plan

Source gates:

```bash
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test responses_direct_tool_passthrough -- --nocapture
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test responses_direct_remote_continuation_integration -- --nocapture
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_stopless_center_semantics -- --nocapture
npm run verify:v3-stopless-resource-control
npm run test:v3-stopless-resource-control-red-fixtures
npm run verify:v3-mainline-caller-flow
npm run verify:v3-resource-map
npm run verify:v3-module-boundaries
npm run verify:v3-rust-only
npm run verify:v3-architecture-docs
npm run verify:v3-cargo-fmt
git diff --check
```

Runtime closeout after source gates:

```bash
RUSTUP_TOOLCHAIN=stable npm run install:v3
rccv3 config check -c /Volumes/extension/.rcc/config.v3.toml
rccv3 restart -c /Volumes/extension/.rcc/config.v3.toml
curl -fsS http://127.0.0.1:4444/health
curl -fsS http://127.0.0.1:5555/health
```

Then run a Direct `/v1/responses` provider-request dry-run and a small live/same-entry replay if configured provider credentials are available.

## Architecture compliance

- Rust runtime remains the semantic owner.
- Direct and Relay are separate adapter handles for one MetadataCenter semantic resource.
- Direct remains same-protocol provider passthrough + hooks; it does not route through Relay for stopless.
- Route selection is still capability/target selection only; stopless control starts after `SameProtocolDirect` decision.
- MetadataCenter carries only control state; request/response normal payloads keep user/model data only.
- No fallback path is added: missing scope/disabled feature is an explicit inactive contract, and errors remain fail-fast through Direct Error01-06 projection.
