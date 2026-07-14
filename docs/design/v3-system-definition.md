# RouteCodex V3 System Definition

## Status and scope

This document defines the complete V3 module surface before the request pipeline is implemented. V3 is a new Rust project under `v3/`; it does not execute V2 code and does not provide V2 config compatibility.

The first planned executable business lifecycle is `/v1/responses` direct. P0-P5 currently stop
before provider send; P6 Responses direct remains contract-bound and `binding_pending`. Relay,
continuation, servertool, and remaining protocol flows stay explicit pending nodes; they are not
removed from architecture and cannot be implemented as independent lifecycles.

## System invariants

1. `routecodex-v3-runtime` is the only complete request lifecycle executor.
2. Every request follows adjacent typed nodes. Server, CLI, router, target, provider, debug, and error modules cannot skip nodes or create a second complete lifecycle.
3. Flow modules register compile-time static hooks. No dynamic hook discovery or runtime plugin loading exists in V3.
4. Shared pure functions own small reusable semantics. Modules orchestrate those functions and typed node transitions.
5. `V3ConfigStore` is the only config file read/write interface.
6. Config parses and validates declarations; it does not interpret routing or execute selection policy.
7. Virtual Router selects one opaque target exactly once.
8. Target Interpreter expands and selects within that target. It never returns to Virtual Router while an internal candidate remains.
9. Error owns classification and action plans. Provider owns health state and executes provider-health actions.
10. Debug is one side-channel system. Debug data never becomes request, provider, or client payload truth.
11. There is no fallback, silent repair, success wrapping, or alternative execution path.
12. V3 runtime semantics are Rust-only. TypeScript is outside the V3 MVP.

## Authoritative modules

| Module | Required standard flow | Owns | Explicitly does not own |
| --- | --- | --- | --- |
| Config | file source -> parse -> schema validate -> registry -> manifest | `config.v3.toml`, all declarations, reference graph validation, deterministic manifest | route hit, target expansion, policy execution, secret value resolution |
| Server | manifest listener projection -> bind all enabled listeners -> endpoint dispatch -> runtime call -> frame write | multi-address/multi-port listeners, endpoint/method/body framing | routing, provider selection, protocol governance, retry |
| Runtime | request entry -> adjacent node execution -> registered hook calls -> response/error return | only complete lifecycle, typed resource graph, hook order | config file IO, provider HTTP, local routing policy copies |
| Virtual Router | classify -> pool resolve -> one opaque target hit | server route-group binding, route pool selection, one target decision | target expansion, provider/key health, retry |
| Target Interpreter | target kind -> recursive expansion -> eligible candidates -> one concrete target | forwarder/provider target interpretation and target-local reselection | route-pool re-hit, provider transport, client error projection |
| Pipeline | input normalize -> chat governance -> provider adapt -> provider output; mirrored response chain | protocol conversion and chat/tool governance | listener, config IO, route selection, health state |
| Provider Responses | concrete target -> wire build -> transport -> raw response/source error | Responses wire/transport plus provider-local runtime health | Virtual Router policy, client protocol repair, global error policy |
| Error | source -> classify -> action plan -> exhaustion -> execution decision -> client projection | common error taxonomy and typed actions | health-state storage, route selection, success payload |
| Debug | event registration -> log/snapshot capture -> query/replay projection | console/file logs, node snapshots, dry-run registration and replay | business truth, retry policy, config IO |
| CLI | parse command -> `V3ConfigStore` -> server/runtime public API | executable entry and status output | second lifecycle, direct provider call, direct config IO |

## Config definition

The only V3 authoring path is `~/.rcc/config.v3.toml`. The schema is complete even when a consuming runtime feature is pending.

Required declaration families:

- servers: multiple server IDs, enabled state, bind address, port, route-group reference, protocol endpoints, feature references;
- providers: provider identity, base URL, auth handle declarations, multiple keys, canonical upstream model IDs, client aliases, capabilities, provider-local options;
- forwarders: virtual targets containing provider or forwarder targets, canonical model identity, provider model mapping, priority, weight, and round-robin declarations;
- routing groups: named pools bound per server, pool match declarations, selection policy, opaque target declarations, and a required non-empty `default` pool;
- features: independently parsed named switches and typed settings for server, debug, routing, target, provider, and protocol surfaces;
- debug: console/file logging declarations, snapshot policy declarations, dry-run registry declarations, paths and retention limits without embedding payload truth in the manifest;
- error: classification/action configuration declarations without executing policy during config compilation.

```text
V3Config01FileSource
  -> V3Config02AuthoringParsed
  -> V3Config03SchemaValidated
  -> V3Config04ResourceRegistryBuilt
  -> V3Config05ManifestPublished
```

The compiler rejects unknown fields, duplicate IDs, duplicate enabled listen addresses, invalid references, invalid auth handles, ambiguous aliases, empty default pools, recursive target cycles, and literal secrets where a secret handle is required.

Forwarder references may be recursive. Config validates the reference graph and rejects cycles, but leaves the graph opaque; Target Interpreter performs runtime expansion and selection.

The published manifest contains declarations and typed indexes only. It must not contain a selected route, expanded target, derived default provider tier, resolved secret value, or single-server compatibility projection.

## Server definition

Server consumes one published manifest and binds every enabled, unique listener. One listener failure is an explicit aggregate startup failure; V3 does not silently start a partial server set.

| Endpoint | Initial behavior |
| --- | --- |
| `GET /health` | implemented per listener; identifies server ID and manifest revision |
| `GET /v1/models` | implemented from the model catalog before Responses live closeout |
| `POST /v1/responses` | P5 no-network path verified; P6 Provider/response nodes pending |
| `POST /v1/messages` | pipeline node present; explicit `not_implemented` until Anthropic flow |
| `POST /v1/chat/completions` | pipeline node present; explicit `not_implemented` until OpenAI Chat flow |
| Gemini generic entry | pipeline node present; explicit `not_implemented` until Gemini flow |
| Debug status/log/snapshot/dry-run endpoints | implemented after Debug phase, before request pipeline implementation |

An unimplemented endpoint still traverses Server -> Debug event -> Error chain -> Server error frame. A handler-local hard-coded response is a forbidden shortcut.

## Virtual Router and Target Interpreter definition

Virtual Router executes exactly one visible hit:

```text
request facts -> server route group -> route pool -> opaque target
```

The required `default` pool is a configuration floor, not a second route pass. Target failures do not return for another pool selection.

Target Interpreter executes:

```text
opaque target
  -> classify concrete/forwarder
  -> recursively expand validated target graph
  -> query provider-owned availability
  -> select candidate by declared policy
  -> execute provider
  -> on typed action, reselect inside the same target
  -> return only success or TargetPoolExhausted
```

Nested forwarders remain transparent to the parent target after selection. Priority, weight, and round-robin apply at the target level where declared; they do not create additional Virtual Router hits.

## Error and Provider health definition

Error produces typed action plans; Provider owns and mutates health state.

```text
Provider source error
  -> Error classify
  -> Error action plan
  -> Provider applies health/cooldown action
  -> Target queries remaining provider availability
  -> Target-local reselect or TargetPoolExhausted
  -> Error client projection
```

Provider-local runtime state has three addressable scopes: provider instance, auth key/credential handle, and canonical model under that provider. The Error action identifies scope, reason, duration/condition, and retry eligibility. Provider stores cooldown, quota, concurrency, and availability state and applies the action. Virtual Router has no access to these states. Target may query a typed availability view; it cannot mutate health or invent cooldown policy.

## Debug definition

Debug must be operational before business pipeline implementation.

```text
node hook/event
  -> trace context
  -> console/file log sink
  -> optional transient snapshot collector
  -> diagnostic query projection
```

Normal live requests retain only the raw request, raw provider response, trace/event ledger, and error facts allowed by policy. They do not permanently retain every node payload.

Dry run registers a fixed raw request and/or raw provider response, executes the same runtime kernel with transport replaced by an explicit dry-run terminal effect, and temporarily collects registered node snapshots. Dry run cannot call a separate pipeline, reconstruct a shortened lifecycle, or read normal snapshots as request truth.

## Pipeline protocol definition

The configurable protocol set is closed to generic Responses, generic Anthropic, generic Gemini, and OpenAI Chat.

```text
Request: Input Normalize -> Chat Logic / Tool Governance -> Provider Protocol Normalize -> Provider Output
Response: Provider Raw Input -> Response Normalize -> Chat Logic / Tool Governance -> Client Protocol Normalize
```

Provider adapters and protocol compatibility belong to these pipeline/provider nodes; they cannot form separate complete lifecycles. Responses direct is the first registered flow. Relay is added only as later static hooks inside the same runtime skeleton.

## Completion language

- `defined`: contract, resource, mainline, and verification documents exist and pass document gates.
- `source implemented`: Rust source and local tests pass; no live claim is implied.
- `executable`: CLI can read a real valid `config.v3.toml` and bind all configured listeners.
- `MVP usable`: an installed V3 binary starts dedicated non-conflicting V3 listeners and a real `/v1/responses` request reaches an upstream through the complete typed lifecycle.
- `complete`: valid only for the explicitly named phase after all mapped gates and live evidence pass. It never means the entire V3 roadmap is finished.
