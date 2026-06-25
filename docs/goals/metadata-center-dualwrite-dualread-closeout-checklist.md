# Metadata Center Dual-Write / Dual-Read Closeout Checklist

## Current Contract Gap

Current metadata center state is transitional, not complete dual-write / dual-read.

- JS `MetadataCenter` is the primary registry and write surface.
- Rust receives `metadataCenterSnapshot` and has partial typed readers.
- Some runtime controls still read from `metadata.runtime_control`, `metadata.__rt`, or top-level projections.
- `docs/architecture/mainline-call-map.yml` marks `metadata.center.mainline` step `mtc-03` as `partial`.
- `docs/architecture/function-map.yml` splits metadata center into transitional sub-features, but does not yet define a single dual-write API owner.

Target contract:

```text
all metadata writes
  -> one MetadataCenter API
  -> JS mirror + Rust center updated together
  -> all metadata reads
  -> one MetadataCenter API
  -> Rust typed center first, JS mirror only during migration
  -> payload residue removed after Rust closeout
```

## Phase 0: Map And Gate First

### Function Map Changes

Add or promote a dedicated feature row:

```yaml
feature_id: hub.metadata_center_dualwrite_api
status: active
summary: "single metadata read/write API that updates JS mirror and Rust center together during migration"
owner_kind: rust_migration
owner_scope: "all request-scoped metadata control write/read operations"
owner_module: src/server/runtime/http-server/metadata-center
canonical_types:
  - MetadataCenterFamily
  - MetadataCenterRuntimeControl
  - MetadataCenterRustSnapshot
  - MetadataCenterDualWriteEnvelope
canonical_builders:
  - writeMetadataCenterSlot
  - readMetadataCenterSlot
  - buildMetadataCenterRustSnapshot
  - applyMetadataCenterRustWriteResult
allowed_paths:
  - src/server/runtime/http-server/metadata-center
  - sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts
  - sharedmodule/llmswitch-core/src/native/router-hotpath
  - sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/metadata_center
  - sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src
  - tests
  - docs
forbidden_paths:
  - src/providers
  - src/client
  - sharedmodule/llmswitch-core/src/servertool/handlers
required_tests:
  - tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts
  - tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts
  - tests/sharedmodule/hub-pipeline-preselected-route.spec.ts
  - tests/servertool/stopless-metadata-center.spec.ts
  - sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/metadata_center
required_gates:
  - npm run verify:function-map-compile-gate
  - npm run verify:architecture-metadata-center-manifest-code-sync
  - npm run verify:metadata-center-dualwrite-api
migration_target: rust
```

Update existing `hub.metadata_center_mainline` notes:

- `mtc-03` is no longer just "partial runtime-control carrier"; it is the dual-write transition node.
- JS registry core remains a migration mirror, not the final owner.
- Rust center is the final owner for control semantics.
- Payload residue (`runtime_control`, `__rt`, top-level projections) is migration-only and must have a deletion plan.

### Verification Map Changes

Add the same feature to `docs/architecture/verification-map.yml` with:

- unit:
  - JS API contract tests for one-write two-centers behavior.
  - Rust typed center builder/reader tests.
  - NAPI/native bridge tests for snapshot/write-result shape.
- contract:
  - no direct writes to control fields outside the API.
  - no direct reads from `runtime_control` / `__rt` where a typed center reader exists.
  - all declared families/slots exist in TS type, JS state bucket, Rust type, builder, reader, and test.
- smoke:
  - `npm run verify:metadata-center-dualwrite-api`.
  - `npm run verify:architecture-metadata-center-manifest-code-sync`.
  - `npm run verify:function-map-compile-gate`.

### Gate Changes

Create `scripts/verify-metadata-center-dualwrite-api.mjs`.

Gate must fail on:

- `writeRuntimeControl(` outside approved API implementation/tests.
- direct `metadata.runtime_control =` or `metadata.__rt =` business writes outside bridge projection code.
- direct Rust reads of `metadata.get("runtime_control")` or `metadata.get("__rt")` in modules that already have `MetadataCenterReader` coverage.
- new metadata families/slots in TS without matching Rust types.
- Rust metadata center fields without matching TS types.
- stopless/servertool control writes outside the unified API.

Gate allowlist must be explicit and temporary:

- existing migration projection in `hub-pipeline-execute-request-stage.ts`.
- existing tests that assert legacy residue is ignored or migrated.
- documented bridge code that only serializes the center snapshot for Rust, not business logic.

## Phase 1: Single API Shape

### Required API

TS facade during migration:

```ts
writeMetadataCenterSlot({
  family,
  key,
  value,
  writer,
  reason,
  target,
  expectedScope
});

readMetadataCenterSlot({
  family,
  key,
  source,
  expectedScope
});
```

Rust equivalent:

```rust
write_metadata_center_slot(center, family, key, value, writer, reason);
read_metadata_center_slot(center, family, key);
```

Rules:

- Business code cannot call `MetadataCenter.writeRuntimeControl` directly.
- Business code cannot mutate `metadata.runtime_control`, `metadata.__rt`, or top-level control fields.
- All request-scoped control metadata must be written once through the unified API.
- Multi-session runtime must not read/write by global recent metadata lookup. Live reads and writes stay bound to the current request metadata object and may pass `expectedScope { requestId, sessionId }`; mismatches fail fast.
- Closeout may keep a bounded per-session released-snapshot buffer for audit/debug only. Default capacity is 10 snapshots per session; this buffer must not become a live fallback or continuation truth source.
- The API writes both:
  - JS mirror: existing request-local JS `MetadataCenter`.
  - Rust center input: typed snapshot/write envelope for native.
- Rustification complete state removes JS writes and keeps the API name stable.

## Phase 2: Field Coverage

### Families

All of these must be represented in TS and Rust:

- `request_truth`
- `continuation_context`
- `runtime_control`
- `provider_observation`
- `client_attachment_scope`
- `debug_snapshot`

### Runtime Control Slots

These are in scope for unified API:

- `routeHint`
- `routeName`
- `routeId`
- `providerProtocol`
- `retryProviderKey`
- `preselectedRoute`
- `serverToolFollowup`
- `serverToolFollowupSource`
- `stoplessGoalStatus`
- `stoplessGoal`
- `stopless`
- `stopMessageState`
- `serverToolLoopState`
- `stopMessageCompareContext`
- `stopMessageEnabled`
- `stopMessageExcludeDirect`
- `stopMessageClientInject`
- `streamIntent`
- `clientAbort`

### Stopless Canonical Rule

`runtime_control.stopless` is canonical.

Migration mirrors:

- `serverToolLoopState`
- `stopMessageState`

Required behavior:

- stopless write goes through unified API once.
- API materializes any required migration mirrors.
- Rust reader consumes canonical `stopless` first.
- legacy mirrors are read only when canonical stopless is absent.
- after Rust closeout, mirror writes and reads are physically deleted.

## Phase 3: Read Migration Order

1. `retryProviderKey`, `routeHint`, `preselectedRoute`
2. `stopMessageEnabled`, `stopMessageExcludeDirect`
3. `stopless`, `serverToolLoopState`, `stopMessageState`, `stopMessageCompareContext`
4. `serverToolFollowup`, `serverToolFollowupSource`, `stoplessGoalStatus`, `stoplessGoal`
5. `provider_observation`
6. `client_attachment_scope`
7. `debug_snapshot`

For every field:

- add Rust type field.
- add Rust builder test.
- add Rust reader test.
- add JS API dual-write test.
- switch live reader to typed center first.
- add negative test proving residue-only input is ignored once migration for that field is complete.
- remove allowlist entry from `verify:metadata-center-dualwrite-api`.

## Phase 4: Write Migration Order

1. Request entry capture:
   - `buildRequestMetadata`
   - `decorateMetadataForAttempt`
2. Responses continuation attach:
   - `buildResponsesPipelineMetadataForHttp`
   - `attachResponsesRequestContextToResultForHttp`
3. Runtime route controls:
   - route hint / retry / preselected route
4. Servertool controls:
   - followup
   - stopless
   - stop-message state
5. Provider observation:
   - target
   - model
   - compatibility profile
   - finish reason
6. Response closeout:
   - release current request center
   - forbid cross-request reuse

## Phase 5: Required Tests

### White-Box

- JS unified API writes JS mirror and Rust snapshot envelope in one call.
- Rust typed builder parses every family/slot declared by TS types.
- Rust reader prefers typed center over `runtime_control` / `__rt`.
- Missing center fails fast where control metadata is required.
- stopless write increments and persists `repeatCount` through canonical center state.
- stopless invalid/no-schema feedback is readable from Rust without payload residue.

### Provider-Facing Black-Box

- Provider request receives route/stopless/web-search/servertool controls only through the governed request path.
- Provider request does not contain internal metadata center payload.
- stopless round 2 carries corrective guidance generated from center state.

### Client-Facing Black-Box

- Client response never leaks `metadataCenter`, `runtime_control`, `__rt`, or internal control fields.
- stopless CLI projection still returns the expected `exec_command`.
- third consecutive no-schema/invalid-schema stops CLI rewrite by returning a normal visible stop response, not hard empty stop.

## Phase 6: Deletion Plan

After a field is fully Rust-center read/write:

- delete direct writer code.
- delete direct reader code.
- delete projection residue.
- delete allowlist entry.
- keep regression tests that prove residue cannot revive.

Final deletion targets:

- business writes to `metadata.runtime_control`.
- business writes to `metadata.__rt`.
- business top-level control projections.
- JS-only metadata center state machine after Rust owner is complete.

## Completion Criteria

- `metadata.center.mainline` `mtc-03` becomes `anchored`.
- `hub.metadata_center_dualwrite_api` exists in function map and verification map.
- `verify:metadata-center-dualwrite-api` passes.
- all metadata center families and slots have TS + Rust type/read/write coverage.
- stopless live sample shows repeatCount progresses `1 -> 2 -> 3` through center state.
- no new direct payload control writes are accepted by gate.
- JS mirror removal plan is explicit before the final Rust-only closeout.
