# rustification-governance gate matrix

This file is the L2 approval matrix for `rustification-governance`. It turns a
report-only rustification finding into an assisted, owner-scoped action only
when the owner, adjacent mainline edge, tests, replay/smoke evidence, and
checker are all known.

L2 remains disabled by default in `STATE.md`. A human-approved L2 run may use
only one matrix row and one owner path.

## Global L2 Entry Gate

Every L2 run must satisfy all items below before editing:

| Gate | Required evidence |
| --- | --- |
| State | `STATE.md` has `kill_switch: inactive`, and human approval explicitly enables this L2 item. |
| Scope | One `watchlist_id` from this matrix, one `item_id`, one owner feature, and one owner path. |
| Owner | `docs/architecture/function-map.yml` resolves the unique `feature_id`, allowed paths, forbidden paths, and required tests. |
| Mainline | `docs/architecture/mainline-call-map.yml` resolves the adjacent Hub/VR/provider/server edge when runtime behavior is affected. |
| Verification | `docs/architecture/verification-map.yml` resolves unit/contract/integration/smoke/build gates. |
| Checker | A separate verifier pass or separate worker is identified before approval. |
| Worktree | `git status --short` is reviewed; unrelated dirty files are not staged, reset, checked out, or deleted. |
| Safety | No auth, secrets, provider account, payment, production config, migration, broad cleanup, broad kill, fallback, disabled test, weakened assertion, or TS semantic duplicate. |

## Matrix

### `hub_pipeline_semantics`

Purpose: prove Hub request/response semantics are Rust-owned and TypeScript is
only orchestration or a native shell.

| Layer | Required gates |
| --- | --- |
| Owner | Hub Pipeline Rust crates under `sharedmodule/llmswitch-core/rust-core/` plus mapped native entry wrappers only. |
| Feature map | Hub request/response Chat Process, tool governance, servertool followup, continuation, history/reasoning owner features. |
| Mainline | Adjacent edges covering `HubReqInbound02Standardized -> HubReqChatProcess03Governed`, `HubReqChatProcess03Governed -> VrRoute04SelectedTarget`, `HubRespInbound02Parsed -> HubRespChatProcess03Governed`, and `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`. |
| Whitebox | `npm run verify:llmswitch-rustification-audit`; Rust-only gates for responses history/protocol, tool normalization, servertool, continuation, function-map compile, and mainline map compile as listed in `verification-map.yml`. |
| Blackbox | Old failing sample or live-equivalent replay through the same HTTP entry when the touched semantic changes request/response behavior. |
| Quality | No TS-owned tool governance, continuation repair, history repair, required_action inference, payload sanitize, provider patching, fallback, or provider special case in Hub stages. |
| Evidence | run log must include classification, owner feature, owner path, mainline edge ids, gates run, replay/sample path if required, and remaining TS shell role. |
| Escalate | Owner cannot be resolved, TS semantics remain public/imported, Rust-only gate missing, replay unavailable for behavior change, or checker unavailable. |

### `virtual_router_semantics`

Purpose: prove Virtual Router route selection and reroute/failure policy are
Rust-owned without Hub/provider payload repair.

| Layer | Required gates |
| --- | --- |
| Owner | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` and mapped VR native entrypoints. |
| Feature map | Virtual Router route/forwarder/failure-policy owner features and provider runtime ingress policy features. |
| Mainline | Adjacent edges covering `HubReqChatProcess03Governed -> VrRoute04SelectedTarget` and `VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic`. |
| Whitebox | `npm run verify:llmswitch-rustification-audit`; `npm run verify:provider-failure-ban-blackbox`; `npm run verify:function-map-compile-gate`; `npm run verify:architecture-mainline-call-map`; focused VR/forwarder tests listed in `verification-map.yml`. |
| Blackbox | Routing/failure replay when selection, pool exhaustion, default tier, health/quota, or provider failure semantics change. |
| Quality | No provider-key branch in Hub/VR, no TS route selection duplicate, no default pool empty acceptance, no provider error rethrow before Rust policy decision, no payload patching in VR. |
| Evidence | run log must include route/failure classification, owner feature, mainline edge ids, gates run, replay path if required, and any `ts_io_shell_ok` wrapper paths. |
| Escalate | VR selection owner unclear, provider-specific branch found outside provider runtime, default tier invariant unverified, or required replay unavailable. |

### `server_io_boundary`

Purpose: distinguish allowed TypeScript server IO shells from TypeScript-owned
Hub semantics.

| Layer | Required gates |
| --- | --- |
| Owner | HTTP/server handler, Responses handler, SSE writer, MetadataCenter attach/release, and process lifecycle features as mapped in architecture docs. |
| Feature map | Server IO and response projection features, plus Hub feature only if the server code attempts semantic repair. |
| Mainline | Adjacent edges covering `ServerReqInbound01ClientRaw -> HubReqInbound02Standardized` and `HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`. |
| Whitebox | Focused HTTP handler/SSE tests for touched owner; `npm run verify:function-map-compile-gate`; `npm run verify:architecture-mainline-call-map`; Rust-only Hub gates if server code previously held semantics. |
| Blackbox | HTTP/SSE replay through the real entry for any change to request admission, stream framing, timeout, metadata release, or client response projection. |
| Quality | TS may own IO only. No TS continuation restore/save, tool list injection/cropping, servertool followup orchestration, provider payload repair, required_action inference, or fallback success projection. |
| Evidence | run log must classify each server path as `ts_io_shell_ok` or `ts_semantic_debt`, list exact forbidden semantic branches if found, and name required owner/gates. |
| Escalate | Server code still owns semantic behavior, map lacks server boundary owner, replay cannot run for IO behavior change, or migration would require end-to-end Rust IO approval. |

### `provider_transport_boundary`

Purpose: distinguish allowed TypeScript provider transport shells from
TypeScript-owned provider/Hub semantics.

| Layer | Required gates |
| --- | --- |
| Owner | Provider runtime wire codec/transport/auth/error capture owner features, with provider-specific logic contained inside provider runtime only. |
| Feature map | Provider runtime, outbound codec, inbound parser, and error capture features. |
| Mainline | Adjacent edges covering `HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`, `ProviderReqOutbound06WirePayload -> ProviderReqOutbound07TransportRequest`, `ProviderRespInbound01Raw -> HubRespInbound02Parsed`, and error entry into `ErrorErr01SourceRaised -> ErrorErr02HostCaptured`. |
| Whitebox | Focused provider runtime/codec/parser tests for touched owner; `npm run verify:llmswitch-rustification-audit`; provider error/reroute gates listed in `verification-map.yml`. |
| Blackbox | Provider replay or recorded fixture replay when provider wire body, stream parse, auth, retry/reroute error capture, or upstream response parse changes. |
| Quality | Provider-specific differences stay in provider runtime. No Hub/VR provider special case, no TS fallback conversion, no metadata in provider wire body/options, no swallowed parse/transport errors. |
| Evidence | run log must classify each provider path as `rust_ssot`, `native_shell_ok`, `ts_io_shell_ok`, or `ts_semantic_debt`, and list any runtime-only provider-specific exceptions. |
| Escalate | Transport migration would touch auth/secrets/live provider config, provider-specific logic leaks into Hub/VR, replay fixture missing for behavior change, or owner cannot be resolved. |

## L2 Run Log Required Fields

Each L2 JSONL entry in `loop-run-log.md` must include enough text in existing
fields to reconstruct:

- `watchlist_id`
- `item_id`
- `owner_feature_id`
- `mainline_edge` or `not_applicable`
- `owner_path`
- `classification_before`
- `classification_after`
- `whitebox_gates`
- `blackbox_gates`
- `checker`
- `evidence_paths`
- `residual_risk`

If these fields are missing, the entry can record `outcome: "fix-proposed"` but
must not be treated as approved.

## Completion Rule

L2 is complete only when:

1. The approved owner-scoped diff is committed or explicitly left uncommitted by
   Jason.
2. Required whitebox gates pass.
3. Required blackbox/live gates pass or are explicitly marked unavailable with
   escalation.
4. The checker records approval evidence.
5. `loop-run-log.md` has one JSONL entry with the required fields above.
