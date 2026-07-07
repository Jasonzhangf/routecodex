# Config Materialization Rust Closeout Plan

## Goal And Acceptance Criteria

Move runtime config materialization from TypeScript into Rust so Virtual Router and Hub Pipeline consume a deterministic compiled runtime manifest instead of sharing handwritten TS config expansion and declaration surfaces.

Acceptance:

- Rust owns the rules currently in `buildVirtualRouterInputV2()`: routingPolicyGroup flattening, provider v2 inclusion, provider-port inclusion, forwarder target expansion, `applyPatch` normalization, and `hitLog` extraction.
- Server bootstrap consumes a Rust compiled manifest/artifact, not `buildRouterBootstrapConfigV2()`.
- Virtual Router consumes only the compiled VR artifact.
- Hub Pipeline consumes only the compiled pipeline/runtime config artifact.
- Upper layers do not re-read authoring `userConfig.virtualrouter.providers` as runtime truth.
- Stale TS shims are physically deleted after all imports are gone; no fail-fast guard is kept without a caller.

## Scope And Boundaries

In scope:

- `src/config/user-config-loader.ts` materialization logic currently behind `buildVirtualRouterInputV2()`.
- deleted `src/config/virtual-router-types.ts` stale shim.
- HTTP server bootstrap/runtime setup call sites that consume router input/artifacts.
- Rust NAPI entrypoint and Rust config materialization module under `router-hotpath-napi`.
- Function map, verification map, residue gates, and rustification docs.

Out of scope:

- Provider transport/auth runtime rewrite.
- WebUI config editor ownership rewrite.
- Provider config writer/codec semantics unless a small boundary adapter is required.
- Route selection behavior changes without a red test proving current behavior is wrong.
- Full HTTP server Rust migration.

## Design Principles

- Authoring config and runtime compiled manifest are separate contracts.
- TypeScript may read files and pass raw JSON/TOML-decoded records; it must not decide VR runtime semantics.
- Rust config materialization must fail fast, with no fallback or dual path.
- Do not put WebUI/admin provider config writer logic into Virtual Router selection modules.
- Keep provider config codec/writer as authoring IO surfaces unless explicitly migrated in a separate goal.
- Preserve payload semantics; do not trim real config/request data for speed.

## Technical Plan

Primary Rust owner candidates:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/config_bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/config.rs`
- New module if needed: `virtual_router_engine/runtime_config_materialization.rs`

TS callers to change:

- `src/config/user-config-loader.ts`
- `src/server/runtime/http-server/http-server-bootstrap.ts`
- `src/server/runtime/http-server/http-server-runtime-setup.ts`
- `src/server/runtime/http-server/index.ts`

Rust entrypoint shape:

- Add a native JSON entrypoint such as `compileRouteCodexRuntimeManifestJson`.
- Input should include decoded root config, decoded provider configs or provider root path data, and requested routingPolicyGroup.
- Output should include a deterministic runtime manifest with at least:
  - `virtualRouterBootstrapInput` or final VR artifacts
  - active routingPolicyGroup
  - provider runtime registry/profile view
  - forwarder config after target expansion
  - provider-port bindings needed by runtime
  - servertool/applyPatch/hitLog normalized config
  - pipeline config view consumed by Hub Pipeline

## Required Reference Cleanup

- Replace `buildRouterBootstrapConfigV2()` imports in server runtime with the Rust compiler facade.
- Remove upper-layer reads of authoring `userConfig.virtualrouter.providers` for runtime provider truth; consume compiled provider registry/artifacts instead.
- Keep `virtual-router-contracts.ts` hidden behind native facades until generated Rust declarations exist.
- After generated declarations or manifest types exist, migrate facade type exports away from `virtual-router-contracts.ts` and delete the handwritten contracts file.
- Do not create a new handwritten TS barrel to hide the old contracts.

## Risks And Mitigations

- Risk: provider files are not loaded before Rust bootstrap, causing empty provider config.
  Mitigation: red test must reproduce provider-file-only config and provider-port-only inclusion before migration.
- Risk: forwarder target expansion loses auth alias/model validation.
  Mitigation: Rust tests must cover `providerId`, `providerKey`, alias fanout, model mismatch, missing provider, and missing auth aliases.
- Risk: config materialization is confused with route selection.
  Mitigation: keep route selection tests separate; materialization only produces compiled inputs/artifacts.
- Risk: server runtime keeps fallback reads from authoring config.
  Mitigation: add residue gate banning runtime provider truth reads from `userConfig.virtualrouter.providers` outside config compiler/diagnostic-only surfaces.

## Test Plan

Red-first focused tests:

- Provider v2 files load into runtime manifest without `virtualrouter.providers` pre-materialized.
- Per-port providerBinding provider ids are included even when not present in routing.
- routingPolicyGroup flattening selects only the requested group and tags route params.
- Forwarders expand `providerId` targets into concrete provider keys and reject invalid model/auth/provider references.
- `applyPatch` freeform authoring mode normalizes to runtime client mode.

Required gates:

- Rust focused tests for the new config materialization module.
- `npm run build:native-hotpath`
- `npm run verify:llmswitch-core-tsc`
- focused server bootstrap/config Jest tests
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-ci-longtail`

Live validation, only after code gates pass:

- Managed restart via `routecodex restart --port <port>`.
- `/health` version check.
- Same-entry route/dry-run or stopless probe using the active config/profile.

## Implementation Steps

1. Add red tests for current `buildVirtualRouterInputV2()` materialization behaviors.
2. Add Rust materialization structs/functions and focused Rust tests.
3. Expose the NAPI JSON entrypoint and required export gate.
4. Add a TS native facade that only passes decoded config/provider records and parses native output.
5. Switch server bootstrap from `buildRouterBootstrapConfigV2()` to the Rust compiler facade.
6. Switch runtime setup/index provider-truth reads to compiled artifacts.
7. Add residue gates banning server runtime imports of `buildRouterBootstrapConfigV2()` and fallback authoring-config provider truth reads.
8. Delete `src/config/virtual-router-types.ts` after imports are gone.
9. Update function map, verification map, rustification state, loop log, memory, and lessons.
10. Run full gates and then live validation if runtime behavior changed.

## Definition Of Done

- No server runtime production import of `buildRouterBootstrapConfigV2()`.
- No runtime fallback to authoring `userConfig.virtualrouter.providers` for provider truth.
- `virtual-router-types.ts` is deleted.
- VR production TS runtime remains zero.
- Minimal TS surface count decreases or the remaining blockers are updated with exact generated-declaration/API-migration reasons.
- Required gates and live validation pass, or live validation gap is explicitly reported.
