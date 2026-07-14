# V3 Responses Direct MVP Implementation Plan

> This is the P6 business-flow plan. Config, Server, Debug, Error, Router, and Target prerequisites are ordered by [V3 Foundation Implementation Order](./v3-foundation-implementation-order.md). Existing early direct code does not override those prerequisites.

## Objective

Implement the first RouteCodex V3 executable path under `v3/`: Rust config -> Rust server `/v1/responses` -> Rust runtime kernel -> static Responses direct hooks -> Rust Responses provider -> Rust server response.

This plan implements `feature_id: v3.responses_direct_mvp_architecture`.

## Implementation Status

The Rust workspace, config compiler, static hook registry, runtime kernel, Responses provider, Rust server, CLI, source gates, unit tests, CLI smoke, and controlled-upstream JSON/SSE blackboxes are implemented under `v3/`.

Completion remains conditional on the current-worktree verification stack, architecture baseline gates, documentation/map sync, collaboration evidence, and MemoryPalace indexing listed below.

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
- V3 map/wiki/doc sync from `design_pending` toward anchored symbols as implementation lands.

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

### 2. Create Rust Workspace Skeleton

Create:

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

Each crate starts with minimal compiling Rust modules and explicit public entrypoints. No runtime behavior is claimed until tests prove it.

### 3. Add V3 Boundary Gates First

Add package scripts and verifier scripts for:

- `verify:v3-rust-only`
- `verify:v3-module-boundaries`
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

### 4. Implement Config Manifest Compiler

Implement `V3Config01AuthoringSurface -> V3Config02ValidatedManifest`.

Minimum config fields:

- server bind/port
- default route group
- default tier
- Responses provider id/type/base_url/model/auth_env

Fail fast for:

- unknown fields
- missing default tier
- empty provider pool
- missing `auth_env`
- secret-like literal in manifest path
- legacy config fallback attempt

### 5. Implement Runtime Node Types

Implement typed nodes:

```text
V3Server03HttpRequestRaw
V3Req04StandardizedResponses
V3Route05SelectedTarget
V3ResponsesDirect06Policy
V3Provider07ResponsesWirePayload
V3Transport08ResponsesHttpRequest
V3ProviderResp09Raw
V3Resp10ClientPayload
V3Server11HttpFrame
```

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
  -> route selected
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

After symbols exist:

- update `docs/architecture/v3-mainline-call-map.yml` from `design_pending` toward anchored real symbols
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
- V3 docs/maps/wiki reflect real symbols and gates.
- `note.md`, `MEMORY.md`, and MemoryPalace search are updated.
