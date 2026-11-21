# V3 Hub Relay request semantics test design

## Scope

This source slice owns only `V3HubReqInbound01ClientRaw` through
`V3HubReqChatProcess04Governed`. It does not own execution planning, target resolution, provider
wire projection, response semantics, runtime configuration, Server cutover, or live Relay.

## Lifecycle and white-box cases

1. Req01 -> Req02 moves the original payload into one Chat-semantic owner and preserves entry
   protocol, invocation source, transport intent, and protocol data without JSON round trips.
2. Req03 classifies `New`, `RemoteProviderOwned`, or `RouteCodexLocalOwned` from an explicit
   continuation lookup and an exact entry/server/group/session scope match. Req03 never restores.
3. Req04 restores local canonical context only for `RouteCodexLocalOwned`, then runs request tool
   governance, history/context governance, and the static servertool request hook profile.
4. Every Req01 -> Req04 owning operation emits deterministic entry and exit hook events.
5. A required hook failure is explicit. A disabled optional servertool hook emits a typed no-op.

## Positive and negative locks

- Positive: new, remote, and local classifications; local restore ordering; JSON/SSE transport
  intent preservation; enabled and disabled servertool profiles.
- Negative: scope mismatch, missing continuation binding, ambiguous local-plus-remote ownership,
  unrepresentable inbound input, required hook failure, Req03 restore residue, Req04 bypass,
  non-adjacent conversion, dynamic hook registry, and a second Relay lifecycle.

## Ownership budget

Req01 owns one `serde_json::Value`. Req02 moves it into one Chat request. Req03 and Req04 move that
same owner forward. Continuation lookup and hooks borrow typed facts. The existing Relay payload-copy
budget and ownership checks cover accidental full-payload copies. The retired request-semantics
source scanner no longer locks private function bodies or JSON helper spellings.

## Verification

- Focused Rust integration tests: `hub_relay_request_semantics`.
- Req04 preserves orphan, missing-ID, duplicate-ID, cross-turn and kind-mismatched
  tool history. Custom output association survives an intervening assistant message.
- Public HTTP regression `issue13d6279_representable_history_roundtrip` in
  `openai_chat_relay_controlled` checks first-attempt provider shape, invalid model
  arguments, client tool argument parsing and the resulting error follow-up.
  Run with `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p
  routecodex-v3-server --test openai_chat_relay_controlled -- --nocapture --test-threads=1`.
- Public Responses regression `issue13d6279_responses_custom_history_roundtrip` in
  `multi_listener_server` checks orphan output, cross-turn custom history, complete raw
  custom input, actual client parser error receipt and its paired follow-up. The upstream
  rejects changed shape. Each client request must use exactly one provider attempt.
  Run with `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p
  routecodex-v3-server --test multi_listener_server issue13d6279_ -- --nocapture --test-threads=1`.
- Behavioral consumers cover lossless normalization, tool/history handling, hook order and required
  hook failures. The registered static-hook and compile-fail gates retain their own boundaries.
- Shared V3 architecture, resource, module-boundary, Rust-only, static-hook, compile-fail, fmt,
  Clippy, and workspace gates.

Passing this design proves only the Relay request-side source slice. Continuation E2E, live Relay,
response semantics, and config-published hook resources remain pending.
