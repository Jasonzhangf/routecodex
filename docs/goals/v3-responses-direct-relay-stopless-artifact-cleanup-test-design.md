# V3 Responses Direct→Relay Stopless Artifact Cleanup Test Design

## Goal

Prevent RouteCodex-generated historical `call_stopless_reasoning` CLI call/output pairs from re-entering an Anthropic provider request after a Responses Direct failure hands the original client payload to Relay. Preserve every non-stopless message, tool call, tool output, tool declaration, and argument byte.

## Lifecycle and owner

```text
Direct provider failure
  -> Error05 selects cross-protocol Relay target
  -> server passes original Responses payload into Relay
  -> ReqInbound converts the full inbound payload to Chat canonical payload
  -> Req04 stopless governance removes generated CLI artifacts from Chat canonical data
  -> ReqOutbound projects the governed Chat canonical payload to Anthropic wire
  -> ProviderReqCompat sees unique real tool ids and no call_stopless_reasoning history
```

Unique semantic owner: `V3HubReqChatProcess04Governed`, implemented by `apply_v3_stopless_request_hook_at_req04` and `strip_v3_stopless_request_artifacts_at_req04` in Rust. Provider codecs, Virtual Router, server handler, SSE, configuration, and stable stopless call-id generation are forbidden repair points.

## White-box contract

- Input: Responses history containing two historical stopless CLI call/output pairs plus an unrelated real tool call/output pair.
- Positive: Req04 removes every generated stopless call, output, CLI command, CLI stdout, and generated continuation guidance from Chat canonical payload data.
- Negative: Req04 preserves the real call id, tool name, arguments, and output; it does not deduplicate arbitrary tool calls or randomize `call_stopless_reasoning`.
- Unexpected: malformed or duplicate non-stopless tool identity continues through the existing explicit tool-governance/error contract; this fix must not silently repair it.

## Module black-box

`responses_direct_to_relay_req04_strips_all_historical_stopless_pairs_before_anthropic_wire` executes the real Relay runtime with StoplessCenter enabled and captures the final Anthropic transport body.

- Before the fix: the body contains two `tool_use` blocks with id `call_stopless_reasoning` and matching tool results.
- After the fix: no stopless call id, CLI command, or CLI stdout reaches the provider body.
- Preservation assertion: `call_real_history` and `/workspace` remain present on Anthropic wire.

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
