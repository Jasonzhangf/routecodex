# V3 Responses Direct MVP Implementation Plan

> This is the P6 business-flow plan. Config, Server, Debug, Error, Router, and Target prerequisites are ordered by [V3 Foundation Implementation Order](./v3-foundation-implementation-order.md). Existing early direct code does not override those prerequisites.

## Objective

Implement the first RouteCodex V3 executable path under `v3/`: Rust config -> Rust server `/v1/responses` -> Rust runtime kernel -> static Responses direct hooks -> Rust Responses provider -> Rust server response.

This plan implements `feature_id: v3.responses_direct_mvp_architecture`.

## Implementation Status

P0-P5 are the current verified foundation. The authoritative P5 request path stops at
`V3Target10ConcreteProviderSelected` before provider send. The first P6 Provider slice now binds
the generic Rust Responses Provider nodes `12-14` and adjacent edges `10-12` to real source and
controlled-upstream tests. Direct policy creation, client projection, and Server framing remain
separate completion boundaries unless their own maps and gates are updated.

Early Responses direct Rust code under `v3/` is not completion evidence by itself. Only source
symbols that are bound in the maps and covered by current gates may be treated as implemented. The
generic Provider slice is source-bound through `V3Provider12ResponsesWirePayload`,
`V3Transport13ResponsesHttpRequest`, and `V3ProviderResp14Raw`; full `/v1/responses` Server
usability is still pending.

## Acceptance Criteria

- V3 source lives only under `v3/`.
- V3 MVP has no TypeScript source.
- Rust crates exist for config, server, runtime, Responses provider, and CLI.
- Runtime kernel is the only full lifecycle executor.
- Flow modules only register static hooks and cannot run independent lifecycles.
- `/v1/responses` direct follows the typed node chain and cannot shortcut from server or CLI to provider transport.
- Direct provider wire preserves current request semantics and does not preflight, sanitize, repair, raw replay, force relay, or fallback.
- Config manifest contains auth env-var handles/names only, never secret values.
- Controlled-upstream blackbox proves provider-facing wire and client-facing response.

## Scope

### In Scope

- `v3/Cargo.toml` workspace.
- `routecodex-v3-config` crate.
- `routecodex-v3-server` crate.
- `routecodex-v3-runtime` crate.
- `routecodex-v3-provider-responses` crate.
- `routecodex-v3-cli` crate.
- Static hook registry.
- V3 source/compile gates.
- Controlled-upstream `/v1/responses` direct blackbox.
- V3 map/wiki/doc sync from `binding_pending` toward anchored symbols only after source verification.

### Out of Scope

- Relay.
- Responses continuation.
- servertool / stopless.
- Dynamic hook loading.
- TypeScript bridge.
- V2 compatibility execution.
- Global install replacement.
- Live RouteCodex restart.
- Real provider call unless separately authorized.

## Design References

- `docs/design/v3-routecodex-rust-module-boundaries.md`
- `docs/design/v3-routecodex-runtime-resource-contract.md`
- `docs/goals/v3-responses-direct-mvp-test-design.md`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/wiki/v3-responses-direct-mainline.md`

## Technical Plan

### 1. Preflight

- Refresh `.agent-collab` KILL_SWITCH, claims, and active run state.
- Re-run `npm run verify:v3-architecture-docs`.
- Confirm no same-semantic claim conflict.
- Do not edit old runtime paths under `sharedmodule/llmswitch-core/` for this V3 slice.

### 2. Reuse the P0-P5 Rust Workspace

Current foundation crates:

```text
v3/
  Cargo.toml
  crates/
    routecodex-v3-config/
    routecodex-v3-server/
    routecodex-v3-runtime/
    routecodex-v3-provider-responses/
    routecodex-v3-cli/
```

Do not recreate Config, Server, Runtime, CLI, Debug, Error, Virtual Router, or Target owners. P6
adds only the generic Responses protocol Provider boundary and Runtime-owned adjacent orchestration.
Existing prototype symbols are candidates for review, not architectural truth.

### 3. Add V3 Boundary Gates First

Add package scripts and verifier scripts for:

- `verify:v3-rust-only`
- `verify:v3-module-boundaries`
- `test:v3-source-gate-red-fixtures`
- `verify:v3-static-hook-registry`
- `verify:v3-resource-map`
- `test:v3-compile-fail`
- `test:v3-responses-direct-unit`
- `test:v3-responses-direct-blackbox`
- `test:v3-workspace`

Required gate rules:

- no `v3/**/*.ts`
- provider HTTP transport only in `routecodex-v3-provider-responses`
- HTTP listener only in `routecodex-v3-server`
- config authoring file IO only in `routecodex-v3-config`
- full lifecycle executor only in `routecodex-v3-runtime`
- flow modules expose hook registration only
- no dynamic hook loading/discovery
- no secret values in manifest/debug/error/client payload
- no direct preflight/sanitize/repair/raw replay/forced relay/fallback

### 4. Consume the P1-P5 Contracts

- Consume `V3Config05ManifestPublished`; do not reopen or reinterpret `config.v3.toml`.
- Consume `V3Target10ConcreteProviderSelected`; do not rerun Virtual Router or Target selection.
- Treat provider identity, endpoint, canonical model, and auth handle as typed selected-target data.
- Resolve the auth secret only in Provider transport.
- Fail fast on missing or malformed selected-target fields. No legacy config path or default synthesis.

### 5. Implement Runtime Node Types

Implement typed nodes:

```text
V3Server03HttpRequestRaw
V3Req04StandardizedResponses
V3Router05RequestClassified
V3Router06RoutePoolResolved
V3Router07OpaqueTargetHitOnce
V3Target08KindClassified
V3Target09CandidateSetExpanded
V3Target10ConcreteProviderSelected
V3ResponsesDirect11Policy
V3Provider12ResponsesWirePayload
V3Transport13ResponsesHttpRequest
V3ProviderResp14Raw
V3Resp15ClientPayload
V3Server16HttpFrame
```

P0-P5 own nodes `03-10`; P6 owns only adjacent transitions `10->11->12->13->14->15->16`.
Only adjacent builders are allowed. Do not add cross-node `From` conversions or duplicate DTO shapes.

### 6. Implement Static Hook Registry

Implement:

- `V3HookPoint`
- `V3RegisteredHook`
- `V3HookRegistry`
- `register_responses_direct_hooks()`

Allowed hook set:

- `ResponsesDirectRouteHook`
- `ResponsesDirectRequestProjectionHook`
- `ResponsesDirectProviderTransportHook`
- `ResponsesDirectResponseProjectionHook`
- `ResponsesDirectErrorHook`

Hook outputs are typed plans/effects. Hooks do not call next lifecycle nodes themselves.

### 7. Implement Responses Provider

Implement provider wire/transport/raw response split:

- `wire.rs`
- `transport.rs`
- `raw_response.rs`

Provider rules:

- `routecodex-v3-provider-responses` is a generic Rust Responses protocol Provider; it must not
  contain hard-coded deployment provider IDs, route groups, fixture identities, or provider-family branches
- current request semantics remain provider wire
- auth secret is resolved only at transport point from `auth_env`
- provider returns raw status/headers/body/stream or source error
- provider does not select route or project client response

### 8. Implement Runtime Kernel

Implement a single runtime lifecycle executor for Responses direct:

```text
manifest
  -> server raw
  -> req standardized
  -> router classify/pool/one opaque hit
  -> target classify/expand/select
  -> direct policy
  -> provider wire
  -> transport request
  -> provider raw
  -> client payload
  -> server frame plan
```

All errors enter `V3Error*`. Provider errors cannot become success.

### 9. Implement Rust Server `/v1/responses`

Server responsibilities:

- bind/listen
- accept POST `/v1/responses`
- parse request envelope
- call runtime kernel
- emit JSON/SSE frame

Server must not:

- select provider
- send provider HTTP
- decide direct policy
- save/restore continuation
- repair provider response

### 10. Implement CLI Smoke

CLI may expose:

```text
routecodex-v3 serve --config <fixture>
routecodex-v3 smoke responses-direct --config <fixture>
```

CLI must call server/runtime public entrypoints and must not call provider transport directly.

### 11. Controlled-Upstream Blackbox

Run a controlled upstream fixture:

```text
client -> V3 server /v1/responses -> runtime -> provider transport -> controlled upstream -> runtime projection -> server response
```

Capture:

- provider-facing request
- client-facing response
- node order trace
- error-chain behavior
- secret/internal/debug carrier absence

### 12. Documentation and Map Sync

After final symbols exist and the required gates pass:

- update `docs/architecture/v3-mainline-call-map.yml` from `binding_pending` toward anchored real symbols
- update P6 resource `binding_status` only with the corresponding verified adjacent source edge
- update `docs/architecture/v3-verification-map.yml` planned gates to actual gates
- update wiki checklist
- update `note.md`
- promote durable facts to `MEMORY.md`
- run MemoryPalace mine + marker search

## Risk and Mitigation

- Risk: V3 accidentally reuses old llmswitch-core lifecycle.
  - Mitigation: source gate forbids V3 MVP implementation outside `v3/`.
- Risk: direct path shortcuts server/CLI to provider.
  - Mitigation: compile/source gates plus compile-fail tests.
- Risk: hook slice becomes lifecycle owner.
  - Mitigation: hook registry gate blocks `run_pipeline`/full executor exports in flow modules.
- Risk: config leaks secrets.
  - Mitigation: manifest tests and secret absence scans.
- Risk: direct path grows repair/fallback.
  - Mitigation: direct no-preflight/no-sanitize/no-repair/no-raw-replay/no-relay/no-fallback gate.

## Verification Matrix

| Area | Gate |
| --- | --- |
| Docs/maps | `npm run verify:v3-architecture-docs` |
| Rust workspace | `cargo test --manifest-path v3/Cargo.toml --workspace` |
| Rust-only | `npm run verify:v3-rust-only` |
| Module boundary | `npm run verify:v3-module-boundaries` |
| Source red fixtures | `npm run test:v3-source-gate-red-fixtures` |
| Static hooks | `npm run verify:v3-static-hook-registry` |
| Resource map | `npm run verify:v3-resource-map` |
| Compile-fail | `npm run test:v3-compile-fail` |
| Unit | `npm run test:v3-responses-direct-unit` |
| Blackbox | `npm run test:v3-responses-direct-blackbox` |
| Existing architecture baseline | `npm run verify:resource-operation-map`, `npm run verify:architecture-mainline-call-map`, `npm run verify:function-map-compile-gate` |

## Definition of Done

- V3 Rust workspace exists and compiles.
- V3 source gates exist and pass.
- Config/server/runtime/provider/CLI crates have focused tests.
- Controlled-upstream `/v1/responses` blackbox passes.
- Provider-facing wire capture and client-facing response capture are recorded.
- No TypeScript V3 MVP source exists.
- No fallback/repair/sanitize/forced relay exists in Responses direct.
- No deployment provider ID or provider-specific branch exists in the generic Responses Provider.
- Every P6 edge `10->11->12->13->14->15->16` and its resource is machine-queryable; unverified
  edges remain `binding_pending` without caller/callee symbols or source paths.
- V3 docs/maps/wiki reflect real symbols and gates.
- `note.md`, `MEMORY.md`, and MemoryPalace search are updated.

## General Rust Responses Provider implementation slice

The first P6 implementation slice ends at `V3ProviderResp14Raw`. It replaces the obsolete `07/08/09` Provider
prototype with the canonical `12/13/14` contracts and leaves the client projection and Server framing nodes
pending. The Provider wire owner moves the existing request value, changes only the selected upstream `model`,
and preserves all other standard and extension fields. The transport request carries only an auth handle; the
secret is resolved at the Reqwest call boundary. JSON bodies remain raw bytes, while SSE uses a validated raw
event stream whose transport, malformed framing, and client-disconnect failures are explicit typed errors.
