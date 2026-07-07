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

## 2026-07-07 VR/Hub Config Interface Closeout Addendum

### Objective

Close the interface between config, Virtual Router, and Hub Pipeline so VR and Hub consume only Rust-produced config/runtime artifacts. This is an interface closeout, not a broad rewrite of host IO.

### Acceptance Criteria

- `Virtual Router <- config` consumes only Rust materialized/compiled artifacts, not TS-built routing/provider/forwarder/runtime truth.
- `Hub Pipeline <- config` consumes only Rust `pipelineRuntimeConfig` / runtime manifest carrier, not TS-rebuilt config semantics.
- `src/config/routecodex-config-loader.ts` remains a native host-env shell only.
- Any remaining TS config files are explicitly classified as host IO/cache/type/native binding shells, not semantic owners.
- Dead TS helpers/imports found during the audit are physically deleted after dependency checks and gates.
- No real `~/.rcc` config/provider file is modified to make code pass.
- No live start/restart occurs until offline blackbox parity and focused gates pass.

### Scope

In scope:

- `VR <- config` call edges and runtime artifacts.
- `Hub Pipeline <- config` call edges and runtime artifacts.
- Server bootstrap/runtime setup config consumption.
- Function map, mainline call map, verification map, and residue gates for those edges.
- Dead imports/helpers that only existed for old TS materialization or old bridge shapes.

Out of scope:

- Provider runtime transport/auth rewrite.
- WebUI/admin config editor rewrite.
- Full config directory physical zero-TS if the remaining file is only host IO/cache/type shell.
- Live server restart unless explicitly requested after offline gates pass.

### Execution Plan

1. Read `AGENTS.md`, `docs/agent-routing/05-foundation-contract.md`, `docs/agent-routing/00-entry-routing.md`, and `.agents/skills/rcc-dev-skills/SKILL.md`.
2. Query MemoryPalace and then function map / mainline call map / verification map for config, VR, and Hub Pipeline features.
3. Build a concrete call-edge list for `VR <- config` and `Hub Pipeline <- config`; mark each edge as Rust artifact, TS shell, or TS semantic owner.
4. Add or update blackbox/parity tests before changing any wiring that can affect startup/runtime config.
5. Fix only the unique owner. Do not add fallback, dual paths, or TS compensating logic.
6. Delete dead TS helpers/imports once no caller remains.
7. Update function map, mainline call map, verification map, MEMORY/note/local lesson when new reusable rules are learned.
8. Run focused gates, build, TypeScript, Rust tests, map gates, minimal TS surface, rustification audit, and diff check.

### Verification Matrix

- Pre-wire blackbox/parity tests for any changed config interface.
- Focused config loader/materialization/provider loader tests.
- Focused VR bootstrap/route artifact tests if VR input shape changes.
- Focused Hub Pipeline runtime config tests if pipelineRuntimeConfig or manifest carrier changes.
- `cargo test -p router-hotpath-napi config_file_codec --lib -- --nocapture`.
- `cargo test -p router-hotpath-napi runtime_config_materialization --lib -- --nocapture`.
- `npm run build:native-hotpath`.
- `npx tsc -p tsconfig.json --noEmit --pretty false`.
- `npm run verify:function-map-compile-gate`.
- `npm run verify:llmswitch-minimal-ts-surface -- --json`.
- `npm run verify:llmswitch-rustification-audit`.
- `git diff --check`.

### Completion Signal

- Report the final `VR <- config` and `Hub Pipeline <- config` interface states.
- List remaining TS config files with one of: removable now, host IO/cache/type shell, or blocked with exact reason.
- Commit exact slice after gates pass.
- State explicitly whether live validation was not run and why.

## 2026-07-07 Remaining Config TS Classification

Machine-readable source:

- `docs/loops/rustification/config-ts-surface.json`
- Gate: `tests/grep/config-codec-gate.spec.ts` / `remaining src/config TypeScript files are explicitly classified`

Audit result:

- Removable now: none.
- Reason: every tracked `src/config/*.ts` / `src/config/*.d.ts` file has live source/test/package callers or is a public declaration artifact. No zero-reference config TS file remains after the VR/Hub artifact closeout.
- Runtime semantic owner status: Rust-owned. Remaining TS files are native shells, host IO/cache/env shells, or type/declaration shells only.

Current classification:

| File | Classification | Why not removable now |
| --- | --- | --- |
| `src/config/auth-file-resolver.ts` | host IO/cache shell | Public class owns host object lifecycle and in-process key cache; Rust owns authfile planning/key resolution. |
| `src/config/config-paths.ts` | native shell | Stable public wrapper imported by CLI/server/admin; Rust owns path resolution. |
| `src/config/provider-config-codec.ts` | host IO shell | Single-file read API and injected sync fs boundary; Rust owns format detect/decode/coerce. |
| `src/config/provider-config-writer.ts` | host IO shell | Async writer is native; sync `fsImpl` init/test boundary remains host-only until caller migration. |
| `src/config/provider-v2-loader.ts` | native shell | Public provider-root loader API; Rust owns scan/read/coerce/duplicate validation. |
| `src/config/routecodex-config-loader.ts` | native shell | Public runtime config loader API; Rust owns full load/materialize/profile projection. |
| `src/config/toml-basic.ts` | native shell | Public TOML parse/serialize wrapper; Rust owns TOML semantics. |
| `src/config/toml-comment-preserving.ts` | native shell | Public comment-preserving scalar patch wrapper; Rust owns patch semantics. |
| `src/config/unified-config-paths.ts` | native shell | Public class facade; Rust owns config path planning. |
| `src/config/user-config-codec.ts` | host IO shell | User config read API and injected sync fs boundary; Rust owns format detect/decode. |
| `src/config/user-config-loader.ts` | native shell/type shell | Direct materialization/manifest API and manifest type surface; Rust owns all runtime config semantics. |
| `src/config/user-config-writer.ts` | native shell | Public writer/scalar patch facade; Rust owns write/patch semantics. |
| `src/config/user-data-paths.d.ts` | type shell | Published declaration artifact for the path API. |
| `src/config/user-data-paths.ts` | host env/native shell | RCC subdir constants and `process.env` publication; Rust owns path resolution. |
