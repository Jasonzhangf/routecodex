# V4 Standard Plugin Library (M5) — Test Design

Design ID: `V4-STANDARD-PLUGINS-001`
Date: 2026-08-17
Scope: the M5 standard plugin library (`routecodex-v4-standard-plugins`) —
typed descriptors, typed `PluginHandle` implementations registered by
immutable plugin id, catalog admission, deterministic per-node
`NodePluginPlan` compilation and NodeContainer/cordis-bridge blackbox
execution. Red fixtures must precede implementation; this design is the
required pre-implementation test contract.

## 1. Lifecycle under test

```text
standard descriptors (typed, keyless, deterministic)
  -> catalog admission (PluginCatalog::register with artifact/contract bytes)
  -> per-node authoring (category plugin sets + role/resource/effect/phase/order)
  -> deterministic NodePluginPlan compile (phase -> DAG -> order -> identity)
  -> three-way hash binding (graph == manifest == loaded plan)
  -> NodeContainer declare/publish/execute via typed StandardHandleRegistry
  -> typed NodeExecutionOutput (data / control / diagnostics)
```

No V3 runtime, no product migration, no real provider/auth material, no
second runtime/kernel and no cross-node dispatch. The baseline is keyless and
behavior-minimal: every plugin is a deterministic mock/validator that never
claims real product semantics.

## 2. Categories and plugins under test

| category | plugin ids (immutable) | kind/effect | node roles |
|---|---|---|---|
| contracts | `v4.std.contract.input_validate`, `v4.std.contract.output_validate` | validator / read_only | request_inbound, response_outbound |
| diagnostic | `v4.std.diagnostic.debug_observe`, `v4.std.diagnostic.timing`, `v4.std.diagnostic.snapshot_record` | debug/observer/snapshot / diagnostic_only | request_chat_process |
| control | `v4.std.control.scope_consume`, `v4.std.control.payload_cycle_record` | control / control_only | metadata-center owner, payload-cycle owner |
| error | `v4.std.error.typed_intake`, `v4.std.error.projection_adapter` | operator / control_only | error_source, error_projection |
| protocol | `v4.std.protocol.wire_codec_proto`, `v4.std.response.protocol_decode`, `v4.std.response.client_semantic_projection`, `v4.std.response.sse_frame_boundary`, `v4.std.response.frame_build` | operator / semantic or projection | request_outbound, response_inbound, response_outbound |
| chat-process | `v4.std.chat_process.request_governance`, `v4.std.chat_process.response_governance` | operator / semantic | request_chat_process, response_chat_process |
| routing | `v4.std.routing.route_facts_producer`, `v4.std.routing.route_facts_consumer` | operator / control_only | request classification, selection plan |
| provider | `v4.std.provider.wire_build`, `v4.std.provider.capability_mock`, `v4.std.provider.auth_handle_mock`, `v4.std.provider.wire_mock`, `v4.std.provider.transport_mock` | validator/read-only or operator/semantic | Hub provider-semantic projection, provider wire boundary |

Every descriptor declares an exact active `node_id` / `role_id` / `position`,
valid resource axis (V4 resource map), effect, phase, order, owner
(`routecodex-v4-standard-plugins`) and canonical sha256 artifact/contract
hashes. Registration is idempotent by immutable plugin id; identity drift is
a conflict.

## 3. White-box tests (crate unit tests)

| test | positive | negative (red) |
|---|---|---|
| descriptors | all standard descriptors pass `validate_descriptor` against the standard resource registry | tampered role/resource/effect -> rejected |
| hashes | artifact/contract hashes are deterministic sha256 of canonical bytes | non-canonical hash -> rejected |
| handles | every plugin id has exactly one typed handle in `StandardHandleRegistry` | unknown id -> `None` (unregistered handle fail-fast) |
| effect guards | semantic writes data, control-only writes control, diagnostic only emits | read-only/diagnostic `write_data` -> `EffectViolation`; control-only `write_data` -> `EffectViolation` |
| side channels | `ExecCtx` binds current `PlanEntry.reads/writes`; metadata-only and error-only handles can access only their declared control resource; control/error/diagnostic facts never enter `data` | metadata handle reads error or writes route facts; error handle reads/writes metadata; handle catches an access error; broad carrier access; payload field carrying control marker -> executor still fails |
| no fallback | handle error propagates as `HandleError` | swallowed error / silent strip -> test fails |

## 4. L2 module tests (tests/ directory, cargo test + test-consumer)

### 4.1 Catalog admission

- Positive: `register_standard_library` registers every standard plugin into
  `PluginCatalog`; snapshot contains all entries; dependency resolution is
  clean; re-registration is idempotent.
- Negative: flipped artifact byte -> `ArtifactHashMismatch`; flipped contract
  byte -> `ContractHashMismatch`; identity conflict -> `DuplicateConflict`.

### 4.2 Deterministic plan compilation

- Positive: per-node authoring with different category sets and orders
  compiles into distinct deterministic `NodePluginPlan`s; same semantics with
  different authoring order -> identical plan hash; plan `verify()` passes.
- Negative: protocol selection group zero/multi active -> `ZeroSelection` /
  `MultiSelection`; order tie -> `Tie`; unauthorized write -> `UnauthorizedWrite`;
  missing `before` target -> `MissingDependency`; retired node id, active-node
  role/position mismatch and non-adjacent provider-semantic reversal are rejected.

### 4.3 NodeContainer blackbox

- Positive: a compiled standard plan with three-way hash bindings declares,
  publishes and executes through `NodeContainer` with
  `StandardHandleRegistry`; typed output carries data + control +
  diagnostics; lifecycle reaches disposed.
- Negative: plan-hash drift -> `PlanHashMismatch`; unregistered handle ->
  `UnregisteredHandle`; diagnostic handle writing data -> `EffectViolation`
  (never silently stripped); undeclared control-resource read/write ->
  `ResourceAccessViolation`; execute before publish -> `InvalidState`.
- Isolation pair: metadata-only execution preserves pre-existing error/route
  resources byte-for-byte; error-only execution preserves metadata center.

### 4.4 Test-consumer regression (active-link conventions)

- The consumer lib and its L2 tests build through
  `routecodex-v4-build-link test-consumer` with
  `--deps routecodex-v4-base-node` (frozen, Active surface) and
  `--source-deps routecodex-v4-plugin-contract,routecodex-v4-plugin-plan,routecodex-v4-plugin-catalog,routecodex-v4-cordis-bridge,routecodex-v4-node-container`
  (mutable, source-path convention). No frozen source path dependency.

### 4.5 Response data-plane adjacency

- Positive: provider raw decoding preserves protocol metadata and output item
  fields; Node 04 -> Node 05 -> Node 06 preserves `requestId` and client wire
  payload bytes.
- Negative: missing/non-array output, non-object output items, invalid item
  `type`, missing request identity and non-adjacent writes fail fast.

## 5. Architecture parity gate (`verify-v4-standard-plugins.mjs`)

Positive locks: module registry entry with `owned_paths` + gates; function-map
`v4.plugin.standard_library` binding real Rust symbols; verification-map gates
registered; `.appsdk` resource `v4.plugin.standard_library` stays
`contract_bound` with contract owner; `plugin-library.contract.json` keeps
category/side-channel/keyless/no-fallback rules; source tokens prove the typed
registry and category modules; forbidden tokens (payload reconstruction,
fallback, second runtime, cross-node dispatch, provider-specific hardcode)
absent. The bridge gate rejects broad `read_control` / `write_control` APIs and
requires both serial and diagnostic contexts to bind `PlanEntry.reads/writes`;
the standard-library gate requires resource-scoped calls and the matching
mainline symbols.

Red self-tests (run with `--red-self-test`) mutate copies and assert each
negative class fails: contract rule removed, module unregistered, gate
unregistered, function-map symbol missing, resource drifted to active,
forbidden source token reintroduced, retired node selector, active-node
role/position mismatch, provider-semantic reversal, broad control access and
missing plan-resource binding.

## 6. Known gaps (M5 baseline)

- Provider-specific request codecs, real provider transport and real
  routing/decision semantics remain out of scope; response data-plane
  projection is schema-bound and provider-agnostic.
- The standard library does not yet drive the M6 PluginManager candidate
  pipeline or the M7 WebUI; those consume the same catalog/plan surface later.
- The real Cordis host still registers only the M3 `v4.test.*` handles; wiring
  the standard handle registry into a real production node is a later-phase
  integration that must first prove per-node dispatch budgets.
