# V4 Real Runtime Admission Plan

status: design
owner_feature_id: v4.runtime.independent_admission
owner_module: routecodex-v4-governance

## Objective

Build an independent `rccv4` canary that cold-starts from the V4 compiled
manifest and completes real upstream request/response loops for `/health`,
`/v1/models`, and `/v1/responses` in both JSON and SSE modes. The canary must
not read, call, start, stop, install over, or modify the V3 runtime.

## Scope and ownership

| Module | Owner | Owned paths | Allowed responsibility | Forbidden responsibility |
| --- | --- | --- | --- | --- |
| governance | `routecodex-v4-governance` | `.appsdk/**`, `contracts/**`, `docs/**`, `scripts/**`, `Cargo.toml`, `package*.json` | admission contract, compiled-manifest identity, maps, gates, CI wiring | runtime/provider/server semantics |
| runtime | `routecodex-v4-runtime` | `crates/routecodex-v4-runtime/**` | Hub request/response semantic nodes, provider-wire build, provider-raw parse | HTTP/TLS, auth, route selection, client listener |
| provider | `routecodex-v4-provider` | `crates/routecodex-v4-provider/**` | shared provider config read, auth handle materialization, HTTP/TLS transport, provider error source | Hub governance, client projection, route selection |
| protocol plugins | `routecodex-v4-standard-plugins` | `crates/routecodex-v4-standard-plugins/**` | provider plugin and protocol adaptor descriptors/handles | second runtime, second codec, secret persistence |
| router | `routecodex-v4-router` | `crates/routecodex-v4-router/**` | typed target selection from compiled provider candidates | payload patching, provider transport, protocol conversion |
| server | `routecodex-v4-server` | `crates/routecodex-v4-server/**` | independent listener, HTTP admission, client JSON/SSE emission | provider auth, route policy, payload cleanup |

The allowed mainline is:

```text
compiled manifest
  -> rccv4 server cold start
  -> ServerReqInbound
  -> Hub request nodes
  -> typed router decision
  -> Hub provider semantic
  -> provider adaptor/wire build
  -> provider transport
  -> provider raw response
  -> Hub response nodes
  -> ServerRespOutbound JSON/SSE
```

Only adjacent node transitions are permitted. Control state, routing,
availability, retry, scope, error facts, debug facts, and secret handles stay
in typed side channels or the error chain and must never enter provider/client
normal payloads. Leakage fails at the owning boundary; no silent stripping,
fallback, or handler compensation is allowed.

## Provider and protocol design

The shared provider configuration shape is the input contract. A provider
plugin owns provider identity, model capabilities, auth-handle references,
endpoint and transport declarations. A protocol adaptor plugin owns the
adjacent semantic-to-wire and raw-to-semantic conversion for one upstream
protocol. Secrets are read only at transport time from the existing provider
configuration/secret files; they are never compiled into the manifest,
payload, diagnostic trace, or logs.

The first real provider fixtures are the existing Fable and MiniMax M3
configurations under `~/.rcc/provider`. They are test inputs, not V4 config
copies and not mock upstreams. The runtime must fail explicitly when a
provider configuration, auth handle, protocol adaptor, or upstream response
is invalid.

## Phase gates

### Phase 0: contract and red admission

- Add the machine-readable admission manifest and register all resources,
  functions, adjacent edges, modules, tests, and gates as `design` or
  `binding pending`.
- Add a red gate proving the current baseline has no independent binary,
  listener, compiled-manifest cold start, real provider transport, or JSON/SSE
  upstream path.
- Record V3 isolation as an explicit negative contract.

### Phase 1: compiled-manifest cold start

- Compile and validate one deterministic V4 runtime manifest with a digest.
- Add `routecodex-v4-runtime-bin` and the independent `rccv4` identity.
- Startup consumes only the compiled manifest and fails on digest drift.

### Phase 2: provider plugin and adaptor

- Read the shared provider config shape without copying secrets into V4
  artifacts.
- Materialize auth handles only inside provider transport.
- Add real Responses JSON/SSE adaptor and the Fable/MiniMax M3 provider
  plugin registrations.

### Phase 3: server and request/response mainline

- Add independent listener, `/health`, `/v1/models`, and Responses JSON/SSE
  admission/emission.
- Connect exactly one runtime/provider/router mainline and typed error source.
- Add paired success/failure tests, malformed SSE tests, and disconnect
  health-neutral tests.

### Phase 4: real online validation

- Build and install only the V4 canary identity on an unused canary port.
- Replay real upstream success and failure samples through the same HTTP
  entrypoints; capture manifest digest, binary identity, request IDs, and
  response evidence.
- Independently verify V3 health and zero V3 calls/restarts/modifications.

### Phase 5: closeout

- Remove mock production success paths and stale mock active map/gate entries.
- Run `npm ci --ignore-scripts`, `npm run verify:ci`, AppSDK compile/verify/
  admission, build/install/live replay, and architecture checks.
- Run DSH Review only after the runtime evidence is complete. Commit and push
  only after review PASS and exact evidence alignment.

## Verification matrix

| Requirement | Required evidence |
| --- | --- |
| independent identity | `rccv4 --version`, binary hash, no V3 install mutation |
| compiled cold start | manifest digest, startup log, drift-negative test |
| real provider | provider request/response bytes from real upstream, no mock transport |
| health/models | live HTTP 200 responses from the canary |
| JSON Responses | live non-stream upstream response and request ID |
| SSE Responses | live upstream SSE frames and terminal event |
| failure path | real upstream failure, typed Error01-06 evidence, explicit client error |
| SSE/disconnect | malformed SSE and client disconnect remain health-neutral |
| isolation | V3 health remains green; no V3 call/restart/config/artifact diff |
| no mock path | source/map/gate scan and physical deletion of mock production path |

## Non-goals

- Performance tuning, batching, caching, or broad protocol parity.
- Reusing or modifying V3 runtime/config/install/log/sample state.
- Mock upstreams or test-only success paths in the production binary.
