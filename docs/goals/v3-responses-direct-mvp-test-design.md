# V3 Responses Direct MVP Test Design

## Objective

Build the first RouteCodex V3 executable path: Rust server `/v1/responses` -> Rust runtime kernel -> static Responses direct flow -> Rust Responses provider -> Rust server response.

This document defines the P6 test contract on top of verified P0-P5. Existing Responses direct
code is completion evidence only where current maps bind real source symbols and gates prove them.
The generic Rust Responses Provider is verified through `V3ProviderResp14Raw`; the full P6 source
chain is now bound through Runtime client projection and Server framing. Final completion still
requires the mapped gate stack and clean CLI controlled-upstream replay.

## Feature scope

`feature_id: v3.responses_direct_mvp_architecture`

Provider-only implementation slice: `feature_id: v3.responses_provider_runtime`.

MVP includes:

- Rust config crate
- Rust server crate
- Rust runtime crate
- Rust Responses provider crate
- Rust CLI crate
- static hook registry
- one generic OpenAI-compatible Responses direct protocol Provider path, selected entirely from typed config/Target data

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
  `Server03 -> Req04 -> Router05..07 -> Target08..10 -> Direct11 -> Provider12 -> Transport13 -> ProviderResp14 -> Resp15 -> Server16`.
- Static hook registry contains only declared Responses direct hooks.
- Flow module cannot run lifecycle independently.

### Provider

- Provider builds OpenAI-compatible Responses request.
- Provider behavior is invariant across arbitrary provider IDs; no deployment identity changes code path.
- Provider resolves auth only at the transport boundary through env or token-file handles.
- Provider returns typed raw JSON/SSE status/headers/body or typed source errors to runtime.

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
- Runtime cannot skip any transition in `10->11->12->13->14->15->16`.
- Provider cannot hard-code deployment provider IDs, fixture IDs, or provider-family routing branches.

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

Required package scripts:

- `npm run verify:v3-rust-only`
- `npm run verify:v3-module-boundaries`
- `npm run test:v3-source-gate-red-fixtures`
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
- map gate rejects anchored P6 edges without real adjacent caller/callee bindings.
- map gate rejects P6 resources that leave `binding_pending` before their adjacent source edge is verified.
- source red fixtures inject lifecycle shortcuts, duplicate owners, protocol leakage, forbidden repair/fallback,
  and provider-ID branches; each mutation must make its source gate fail.
- compile-fail fixtures prove Server/CLI cannot import Provider transport, non-owning crates cannot
  construct P6 nodes, and callers cannot skip adjacent P6 builders.

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

## Current baseline and red-first evidence

P0-P5 evidence proves only:

- Config, Server, Debug, Error/Provider health, Virtual Router, and Target owners are source-bound.
- The real P5 path reaches `V3Target10ConcreteProviderSelected` and stops before network send.
- P6 resources and edges may be anchored only after their real adjacent symbols, red gates, and
  controlled-upstream behavior agree.

Before P6 runtime implementation is accepted:

1. run source red fixtures and record that every forbidden mutation is caught
2. run compile-fail fixtures and record the expected compiler rejection reason
3. implement or retain code only at the unique owner and adjacent transition
4. run positive/negative unit and controlled-upstream blackboxes
5. bind each edge/resource only after source and runtime evidence agree

Required commands remain canonical in `docs/architecture/v3-verification-map.yml`; a completion claim requires all of them to pass in the current worktree.

## General Rust Responses Provider slice

The Provider-only P6 slice is complete only when `npm run test:v3-provider-responses` proves, against a real
controlled HTTP upstream, all of the following without entering the Server lifecycle:

- one Provider implementation serves multiple neutral provider instances without deployment-ID branches;
- the complete client request is preserved except for the selected canonical upstream model mapping;
- environment and token-file secret handles resolve only inside transport, and typed wire/transport/raw/error
  contracts never retain or print the secret value;
- JSON and SSE are distinct typed response bodies; SSE is consumed incrementally and malformed framing fails;
- 401, 503, connection failure, missing auth, and client disconnect remain typed errors and never become success;
- the Provider does not select a route, interpret a Forwarder, project a client response, or mutate health for a
  client disconnect.

This Provider-only slice anchors `V3Provider12ResponsesWirePayload`,
`V3Transport13ResponsesHttpRequest`, and `V3ProviderResp14Raw`. The full P6 goal separately anchors
`V3ResponsesDirect11Policy`, `V3Resp15ClientPayload`, and `V3Server16HttpFrame` with Runtime/Server
source, JSON/SSE blackboxes, and final CLI replay evidence.
