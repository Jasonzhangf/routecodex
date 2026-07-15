# V3 Hub v1 H2 P6 Responses Direct Characterization

feature_id: v3.responses_direct_h2_equivalence_harness

## Scope

H2 creates the migration baseline for moving the verified P6 Responses Direct path behind the new
Hub v1 skeleton after H1 lands. It does not implement Hub v1 hooks, does not switch the server entry,
does not use H1 Rust symbols, and does not change P6 runtime behavior.

P6 remains the migration source, not the final Hub v1 implementation. All Hub v1 request/response
mainline edges stay binding_pending until their real source bindings exist and are verified.
This baseline uses no H1 Rust symbols.

## Baseline Owner Map

| Scenario | Current P6 owner and edge | Positive evidence | Negative lock | Gate |
| --- | --- | --- | --- | --- |
| json_baseline | v3.responses_direct.required_mainline v3-rd-09..14; Runtime kernel, generic Provider, Server16 frame | CLI-controlled-upstream replay proves raw client JSON, provider wire body, raw provider JSON, and client JSON response | client body cannot contain Debug/Error/node trace control fields; provider wire cannot contain RouteCodex internals | npm run test:v3-h2-p6-controlled-replay |
| sse_baseline | same P6 chain; SSE differs only at Provider raw bytes and final Server frame | CLI-controlled-upstream replay proves SSE content-type, event order, terminal [DONE], and single V3Resp15ClientPayload -> V3Server16HttpFrame exit | no materialize/repair response shell; no second SSE semantic owner | npm run test:v3-h2-p6-controlled-replay |
| target_local_reselection | V3Error01..06 plus Target-local action inside same Runtime kernel | first provider 503 enters Error chain, V3TargetLocalReselected fires, second provider succeeds, V3Router07OpaqueTargetHitOnce count remains one | no repeated VR hit, no return to upper pool, no provider error as success | npm run test:v3-h2-p6-controlled-replay |
| default_pool_exhaustion | default pool target expansion and terminal Error projection | two controlled failing Providers under the explicit default pool are both attempted; final response is V3Error06ClientProjected with target_exhausted=true and candidates_remaining=0 | default pool cannot be skipped; provider errors cannot become success; final error only after all selected default candidates fail | npm run test:v3-h2-p6-controlled-replay |
| dry_run_no_network | Runtime-owned P6 Dry Run with no-network transport effect | dry run traverses Provider12/Transport13/ProviderResp14/Resp15 and returns provider_pipeline_executed=true, provider_network_send=false, stopped_before_provider_send=true | no second pipeline; stopped_before_provider_send denotes suppression of the Provider network-send effect, not skipping Provider12/Transport13; controlled upstream receives zero dry-run requests | npm run test:v3-h2-p6-controlled-replay |
| debug_side_channel | Debug runtime owns logs/snapshots/raw capture as side-channel only | replay confirms node logs and request IDs are visible via debug endpoints and the dry-run snapshot session is released | secrets, Debug state, Error chain, and node trace do not enter provider wire payload or client normal body | npm run test:v3-h2-p6-controlled-replay |

The target-local reselection and default pool exhaustion scenarios are explicit H2 behaviors. Debug
side-channel is an evidence surface, never a business payload owner.
Debug side-channel remains isolated from normal payloads.

## Harness Contract

- The replay starts the actual routecodex-v3 server start --config <temp-config> CLI binary.
- Controlled upstreams are local HTTP servers observed through provider-facing requests only.
- The harness does not call spawn_v3_server_aggregate, Runtime kernels, Provider functions, H1 typed
  nodes, or any internal server entry.
- The replay writes a sanitized evidence artifact under
  v3/target/h2-p6-controlled-replay/latest-evidence.json; this path is generated evidence, not a
  source truth file.
- The red gate npm run test:v3-h2-equivalence-red-fixtures proves the harness fails if CLI entry,
  default pool, dry-run no-network, or scenario documentation coverage is removed.

## Required Gates

- npm run verify:v3-h2-equivalence-harness
- npm run test:v3-h2-equivalence-red-fixtures
- npm run test:v3-h2-p6-controlled-replay
- npm run test:v3-provider-responses
- npm run test:v3-responses-direct-unit
- npm run test:v3-responses-direct-blackbox
- npm run verify:v3-architecture-docs
- npm run verify:v3-module-boundaries
- npm run verify:v3-resource-map
- npm run verify:v3-cargo-fmt
- npm run verify:v3-clippy
- npm run test:v3-workspace

## Handoff Rule

When H1 exposes Hub v1 hook symbols, H2 must compare Hub v1 Direct against this exact P6 baseline.
If equivalence requires changing P6 runtime, H1 runtime, Config declarations, Server entry switching,
or old P6 deletion, write a handoff with owner, target hook, sample, and required gate instead of
editing that owner from H2.
