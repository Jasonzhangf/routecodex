# V3 Responses Direct MVP Test Design

## Objective

Build the first RouteCodex V3 executable path: Rust server `/v1/responses` -> Rust runtime kernel -> static Responses direct flow -> Rust Responses provider -> Rust server response.

This document defines the test contract. Current implementation evidence is recorded below and remains subject to the listed gates.

## Feature scope

`feature_id: v3.responses_direct_mvp_architecture`

MVP includes:

- Rust config crate
- Rust server crate
- Rust runtime crate
- Rust Responses provider crate
- Rust CLI crate
- static hook registry
- one OpenAI-compatible Responses direct provider path

MVP excludes:

- relay
- continuation
- servertool/stopless
- TypeScript bridge
- dynamic hook loading
- V2 compatibility execution

## Positive lifecycle tests

### Config

- Valid single-provider config compiles to `V3Config02ValidatedManifest`.
- Manifest includes server bind, route group, default tier, Responses provider endpoint/model, and `auth_env`.
- Manifest excludes secret values.

### Server

- `/v1/responses` POST parses into `V3Server03HttpRequestRaw`.
- Server rejects wrong method/path without invoking runtime.
- Server calls runtime and only frames returned runtime output.

### Runtime

- Runtime executes nodes in order:
  `Config -> ServerRaw -> Req -> Route -> DirectPolicy -> ProviderWire -> Transport -> ProviderRaw -> ClientPayload -> ServerFrame`.
- Static hook registry contains only declared Responses direct hooks.
- Flow module cannot run lifecycle independently.

### Provider

- Provider builds OpenAI-compatible Responses request.
- Provider reads auth only through `auth_env`.
- Provider returns raw status/headers/body to runtime.

### End-to-end blackbox

- A minimal `/v1/responses` request receives an upstream-compatible response.
- Provider-facing captured request equals current request semantics plus typed manifest transport fields.
- Client-facing response contains no internal resource/debug/error carrier.

## Negative tests

### No shortcuts

- CLI cannot import provider transport internals.
- Server cannot import provider transport internals.
- Responses direct flow cannot call HTTP client directly.
- Shared functions cannot import runtime resources.
- Modules cannot duplicate shared parser/validator/projector logic.
- Shared functions cannot perform IO, transport, env secret reads, lifecycle advancement, fallback, repair, sanitize, or relay decisions.

### Config fail-fast

- Unknown config field fails.
- Missing default tier fails.
- Empty provider pool fails.
- Missing `auth_env` fails.
- Secret-like config value in manifest path fails.

### Direct boundary

- Direct path must not call provider-wire preflight.
- Direct path must not sanitize/repair Responses tool history.
- Direct path must not rebuild from raw metadata/snapshot/debug artifact.
- Direct path must not force relay.

### Provider boundary

- Provider must not choose route target.
- Provider must not project client response.
- Provider must not convert provider error into success.

### Server boundary

- Server must not decide direct policy.
- Server must not save/restore continuation.
- Server must not repair provider response shape.

## Compile/source gates

Implemented package scripts:

- `npm run verify:v3-rust-only`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-static-hook-registry`
- `npm run verify:v3-resource-map`
- `npm run test:v3-compile-fail`
- `npm run test:v3-responses-direct-unit`
- `npm run test:v3-responses-direct-blackbox`

Expected checks:

- `v3/**/*.ts` absent.
- HTTP client usage only in `routecodex-v3-provider-responses`.
- server listener usage only in `routecodex-v3-server`.
- config file IO only in `routecodex-v3-config`.
- full lifecycle executor only in `routecodex-v3-runtime`.
- flow modules export hook registration only.
- provider API key values absent from manifest/debug/error/client payload.

## Completion gates for source implementation

Source-level completion requires:

1. compile-fail tests proving forbidden imports/constructors fail
2. unit tests for config/server/runtime/provider crates
3. provider-facing blackbox proving final wire request
4. client-facing blackbox proving no internal leak
5. architecture gates for V3 map parse/sync
6. `cargo test` for all V3 crates
7. no TypeScript in V3 MVP source

Runtime completion later requires:

1. build V3 binary
2. run local V3 server
3. call real `/v1/responses` or controlled upstream fixture
4. prove provider wire and client response evidence
5. record exact command/log/sample path

Without runtime evidence, report only "V3 source gates passed", not "V3 runtime complete".

## Current implementation evidence

The controlled-upstream harness now covers:

- JSON Responses direct request/response.
- SSE response body and content-type preservation.
- provider-facing current request body preservation.
- provider auth resolution through an env-var handle without secret leakage.
- typed node order through `V3Server11HttpFrame`.
- provider failure projection through the typed V3 error chain.
- wrong method/path rejection before runtime entry.
- CLI smoke through the same runtime kernel.

Required commands remain canonical in `docs/architecture/v3-verification-map.yml`; a completion claim requires all of them to pass in the current worktree.
