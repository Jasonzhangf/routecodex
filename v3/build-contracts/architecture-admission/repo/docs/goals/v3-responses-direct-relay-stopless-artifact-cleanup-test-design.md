# V3 Responses Direct→Relay Stopless Current-Turn Boundary Test Design

## Goal

Prevent Req04 from interpreting or deleting historical Stopless-shaped call/output pairs. Stopless consumption requires same-scope MetadataCenter provenance and is limited to the current request suffix. Preserve every historical message, tool call, tool output, tool declaration, and argument byte.

## Lifecycle and owner

```text
Direct provider failure
  -> Error05 selects cross-protocol Relay target
  -> server passes original Responses payload into Relay
  -> ReqInbound converts the full inbound payload to Chat canonical payload
  -> Req04 sees no same-scope StoplessCenter provenance and preserves historical data
  -> ReqOutbound projects the governed Chat canonical payload to Anthropic wire
  -> ProviderReqCompat sees unique real tool ids and no call_stopless_reasoning history
```

Unique semantic owner: `V3HubReqChatProcess04Governed`, implemented by `apply_v3_stopless_request_hook_at_req04` in Rust. It may consume only a current-suffix pair backed by same-scope StoplessCenter state. Provider codecs, Virtual Router, server handler, SSE, configuration, and call-id guessing are forbidden repair points.

## White-box contract

- Input: Responses history containing two historical stopless CLI call/output pairs plus an unrelated real tool call/output pair.
- Positive: with same-scope MetadataCenter provenance, Req04 consumes only the matching current-suffix Stopless pair.
- Negative: without provenance, Req04 preserves every historical Stopless-shaped and ordinary call/result pair in order and does not emit `Req04StoplessResultParsed`.
- Unexpected: malformed or duplicate non-stopless tool identity continues through the existing explicit tool-governance/error contract; this fix must not silently repair it.

## Module black-box

`responses_direct_to_relay_req04_preserves_historical_stopless_pairs_on_anthropic_wire` executes the real Relay runtime with StoplessCenter enabled and captures the final Anthropic transport body.

- Before the fix: Req04 consumed the last Stopless-shaped pair solely from payload shape.
- After the fix: both historical Stopless-shaped pairs and the ordinary tool pair reach Anthropic wire in order.
- Preservation assertion: both historical call ids/stdout values plus `call_real_history` and `/workspace` remain present.

## Project black-box and live replay

After source gates, build, global install, and the single managed aggregate restart, replay the original zterm session `019fa867-f81f-7652-b58f-2290fa2cc98b` through port 5555 `/v1/responses`.

Pass criteria:

- no `MiniMax Anthropic tool call id call_stopless_reasoning is duplicated` event for the replay request;
- no malformed-arguments provider compatibility event after the adjacent codec fix is included;
- the request completes through the normal response chain;
- provider-bound history retains real tool calls/results and is not semantically trimmed;
- 5520, 5555, and 10000 health versions match the installed build.

## Required gates

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test responses_relay_stopless_anthropic_provider_wire_integration -- --nocapture`
- stopless state-machine and request/continuation suites registered under `v3.servertool_hook_skeleton_lifecycle`
- `npm run verify:v3-stopless-state-machine-docs`
- `npm run test:v3-stopless-state-machine-docs-red-fixtures`
- `npm run verify:v3-stopless-resource-control`
- `npm run test:v3-stopless-resource-control-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-cargo-fmt`
- build/global install/managed restart/health/exact zterm replay
- Codex review only after every preceding item has evidence

## Known pre-existing gate gaps

- At design time, the broader `hub_relay_request_semantics` suite has four fixtures that panic during ReqInbound because they omit a required Responses `input` surface.
- The broader `responses_relay_local_continuation_integration` suite has unrelated retained-tool/continuation fixture failures in the current dirty worktree.
- These are not proof against this focused fix, but they must be classified and cleared or explicitly reported before final closure; they cannot be hidden by weakening tests.
