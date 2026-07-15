# V3 Hub Relay Payload-Copy Runtime Probes Test Design

Feature: `v3.hub_relay_payload_copy_runtime_probes`

## Scope and boundary

This slice adds probes and source/mutation gates only. It does not wire Relay into Server, implement
continuation persistence, execute servertool, change V2/P6, or prove live Relay. The runtime source
under test remains owned by the Relay request/response/resource workers.

## Lifecycle under test

1. Relay JSON request moves from `V3HubReqInbound01ClientRaw` through Req04 governance.
2. Relay SSE response keeps one provider response payload through Resp01-Resp04 and reaches the
   single `V3ServerRespOutbound06ClientFrame` transport exit without full-stream materialization.
3. Local continuation truth is retained from lookup through Req04 restore, remains available after
   the lookup owner is released, and is released when the governed request outcome is dropped.
4. A servertool response is governed at Resp03, commits one canonical local context at Resp04, and
   the following request restores local context before Req04 servertool governance.

## White-box probes

| Probe | Positive assertion | Negative risk locked |
| --- | --- | --- |
| Relay JSON | large nested request remains semantically equal after Req01-Req04 | runtime full-payload clone or JSON round-trip |
| Relay SSE | normalized kind is SSE, canonical context shares finalized payload, one response exit remains | SSE collection/materialization or second exit |
| Local continuation | context survives lookup drop until governed outcome drop; restore precedes servertool | early release, restore outside Req04, retained duplicate truth |
| Servertool roundtrip | Resp03 detects followup, Resp04 stores one shared context, next Req04 restores before servertool | servertool-owned response exit or duplicated context payload |

The runtime probes verify observable ownership behavior. The source gate verifies the corresponding
implementation mechanism: move-at-boundary request ownership, `Arc<Value>` response/context truth,
the two bounded `Arc::clone` operations at Resp04 commit and Req04 restore, and absence of clone /
serialization / stream-collection substitutes.

## Source gate and mutation fixtures

The gate rejects:

- unbounded `deep_clone`, `deepClone`, or full-payload `.clone()` paths;
- `serde_json::to_string`/`from_str` or `to_value`/`from_value` cloning round-trips;
- SSE `collect`, `collect::<Vec<_>>`, `body_text`, or full-buffer materialization;
- Debug/snapshot payloads used as request, response, or continuation truth;
- hook planning that retains, owns, or clones the current-node business payload;
- removal of the canonical `Arc::ptr_eq` response ownership assertion or the Req04 restore point.

Every forbidden family has a mutation fixture that must make the verifier fail.

## Verification map

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_payload_copy_runtime_probes -- --nocapture`
- `npm run verify:v3-relay-payload-copy-budget`
- `npm run test:v3-relay-payload-copy-budget-red-fixtures`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-cargo-fmt`
- `git diff --check`

## Completion limit

Passing this design proves only that the current Relay source slice has executable payload-copy
probes and mutation-backed source gates. It does not prove live Relay, continuation storage E2E,
servertool execution, Server cutover, global installation, restart, or production replacement.
