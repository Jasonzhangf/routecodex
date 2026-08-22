# RouteCodex V3 Rust Responses Direct MVP

## Trigger

Use this workflow for project-level V3 work under `v3/`, especially Rust config/server/runtime/provider/CLI and `/v1/responses` direct.

## Required order

- MemoryPalace search.
- V3 resource map.
- V3 mainline call map.
- V3 verification map and test design.
- Source gates.
- Rust implementation.
- Controlled-upstream blackbox.
- Map/wiki/memory sync.

## Ownership locks

- Runtime kernel is the only complete lifecycle executor.
- Static hook registry must contain callable function pointers/effects, and kernel must execute them. Hook-name metadata alone is not registration.
- Hook module orchestrates; Virtual Router owns the one opaque target hit, Target owns expansion/reselection, and response parsing/projecting lives in one shared Rust layer.
- Server owns listener, request entry, `V3Server16HttpFrame`, and JSON/SSE emission.
- Provider owns Responses wire, auth resolution at transport, HTTP send, and raw response capture.
- Config owns authoring file IO, strict schema validation, deterministic manifest, and auth env-var handle names.
- CLI calls config/server/runtime public entrypoints and never imports provider transport.

## Phase calibration lock

- Before a new phase, compare verified prior-phase stop node with resource/mainline/verification maps.
- Existing prototype source, unit tests, or controlled-upstream harness never upgrades phase status by itself.
- Keep every unverified phase edge/resource `binding_pending`; omit caller/callee symbol and file until source binding is checked.
- For P6, P0-P5 stop at `V3Target10ConcreteProviderSelected`; `10->11->12->13->14->15->16` stays pending until gate-first implementation.
- Generic protocol Provider gates must reject deployment provider IDs and provider-family branches in production source.
- Parallel runtime work is not a reason to wait: contract/map/gate worker continues non-overlapping edits,
  runs document and mutation-fixture gates independently, commits its exact scope, and hands shared
  surfaces to the runtime worker. Defer only checks that consume actively changing runtime files.
- In a multi-worker V3 run, set `CARGO_TARGET_DIR=.agent-collab/runs/<run_id>/cargo-target`
  (or another run-private directory) and keep the command session polled until its exit code is
  captured. Concurrent workers sharing `v3/target` can leave test binaries stopped in macOS
  `_dyld_start`; diagnose with an explicit-PID sample, do not call it a Rust test deadlock, and do
  not use broad process-kill commands.

## No-shortcut gates

- `verify:v3-rust-only`: no V3 TS/JS source.
- `verify:v3-module-boundaries`: transport/listener/config IO/lifecycle owner uniqueness and shared-vs-hook split.
- `verify:v3-static-hook-registry`: required static hooks exist and kernel executes every hook.
- `test:v3-compile-fail`: temporary Rust crates prove server/CLI cannot import provider transport; source scans alone are insufficient.
- Missing/unsupported content-type and malformed JSON fail explicitly through typed error nodes. Never default to JSON or text.
- SSE may be transported as equivalent bytes; no materialize/remap/repair.
- P3 Dry Run returns the current execution's transient snapshots and then releases the snapshot session; the registry must be empty after completion.
- Dry Run request/response projections must use the global Debug redaction owner. Returning a fixture payload directly is a secret leak.
- Runtime prototypes must consume the global Error crate; a second Runtime-local Error chain must be physically removed and source-gated against revival.
- Debug sink, malformed fixture, and disabled Dry Run failures must enter the global Error chain. Do not ignore `Result`, use `expect`, or continue with memory-only success.
- Debug must not own the Responses Direct business topology. It registers fixtures and side-channel artifacts; Runtime supplies the executed node trace. P6 Dry Run runs the same Runtime kernel and replaces only Transport13 with a no-network transport. Report `provider_pipeline_executed=true`, `provider_network_send=false`, and `stopped_before_network_send=true`; never claim pre-Provider termination after Provider12/Transport13 executed.
- P6 Direct is a migration source, not the final Hub topology. Before Relay or new protocols, create a new fixed Hub chain version with request/response Chat Process, continuation ownership, execution mode, routed/pinned target merge, provider protocol hooks, and a sole response exit. Freeze P6, migrate its behavior behind static hooks, cut over the sole Server entry, then physically delete the old chain; never insert nodes into published P6 numbering or keep a fallback dual path.
- Before migrating P6 behavior behind Hub hooks, first freeze a same-entry H2 equivalence baseline. The H2 harness must start the actual `routecodex-v3` CLI server with controlled upstreams and reject internal Runtime/Server/Provider helper calls or new H1 symbols; it must cover JSON, SSE, Target-local reselection, default exhaustion/Error01-06, Dry Run no-network, Debug side-channel isolation, full payload observations, secret redaction, and post-run port closure.
- Hub branching uses four independent axes: entry protocol, continuation ownership, execution mode, and provider wire protocol. Same protocol does not imply Direct, Responses does not imply remote continuation, and provider family/model prefix never selects a Hub branch. Non-GPT Responses providers may use RouteCodex-local continuation.
- Local continuation context is immutable from response Chat Process save to next request Chat Process restore. Store/transport may only perform round-trip-equivalent normalization, scope validation, expiry, and release; no tool/history repair, routing, Provider adaptation, request rebuild, Debug replay, or owner fallback is permitted.
- Server success output must enter `build_v3_server_16_http_frame_from_v3_resp_15` before HTTP emission. Do not let the emitter accept `V3Resp15ClientPayload` directly, and do not default missing content type at Server16.
- Provider health mutation methods remain crate-private. Target receives only the public availability reader contract; Router receives neither health nor availability dependencies.
- `V3Router06RoutePoolResolved` is a non-Clone one-shot token consumed by `hit_opaque_target_once`; compile-fail evidence must prove a second hit cannot reuse it.
- P5 Server requests must traverse the single Runtime-owned `V3Server03HttpRequestRaw -> V3Req04StandardizedResponses` types before Router. A Server-local duplicate node or direct Server03 -> Router edge is a shortcut.

## Minimum runtime evidence

- JSON provider-facing body equals current request body.
- SSE body and content-type remain equivalent.
- auth secret is resolved only at provider transport and absent from captured/client payloads.
- node trace includes every request/response node in order.
- provider error enters typed `V3Error01` through `V3Error05`; never success.
- wrong method/path never enters runtime.
- CLI smoke reaches the same runtime kernel.

## Canonical gates

```bash
cargo fmt --manifest-path v3/Cargo.toml --all -- --check
cargo clippy --manifest-path v3/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path v3/Cargo.toml --workspace -- --nocapture
npm run verify:v3-architecture-docs
npm run verify:v3-rust-only
npm run verify:v3-module-boundaries
npm run verify:v3-static-hook-registry
npm run verify:v3-resource-map
npm run test:v3-compile-fail
npm run test:v3-responses-direct-blackbox
npm run test:v3-workspace
```

## H1 Hub v1 static skeleton closeout

- Freeze P6 first with source and red-fixture gates; H1 must not cut Server, connect Provider network, implement Relay/continuation, migrate/delete P6, or claim Hub v1 requests are usable.
- H1 implementation scope is only opaque typed nodes, unique adjacent builders, independent branch-axis enums, callable closed static hooks, deterministic manifest validation, and explicit `not_implemented` hooks.
- Static skeleton edges may be anchored as `binding_kind: h1_typed_test` only when real test caller and builder symbols exist. Keep unimplemented production business hooks/resources `binding_pending`.
- Compile-fail private constructor fixtures must fail for private-field/type-boundary reasons. Build valid predecessor values through public builders before attempting private field writes; avoid `todo!()` or wrong field names that produce unrelated diagnostics.

## Relay review-surface closeout

- Four-worker Relay maps are closed only when every worker feature ID has declared resources, real or review-only mainline bindings, allowed/forbidden paths, npm-backed required gates, and matching verification-map completion limits. A feature name listed only in a parent `parallel_workers` array is not queryable closure.
- Gate scripts must resolve Rust symbols through the owning module tree after a single-file module is split; checking only `hub_v1.rs` creates false map drift when an exported symbol moves to `hub_v1/*.rs`.
- Mutation fixtures invoking an architecture verifier must copy every verifier input, including `package.json` when gate wiring is validated. Missing fixture inputs produce unrelated parser failures and invalidate the red-test proof.
- Relay copy-budget contract must explicitly reject unbounded deep copy, full SSE materialization, and Debug/snapshot copies as business or continuation truth. Lock each with a negative fixture, not prose alone.
