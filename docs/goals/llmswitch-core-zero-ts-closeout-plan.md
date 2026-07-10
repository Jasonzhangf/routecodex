# llmswitch-core Zero TS Closeout Plan

## Goal

Close all 12 remaining `sharedmodule/llmswitch-core/src` minimal TypeScript surface entries in one coordinated Rustification pass.

Final target: no hand-authored production TS remains in the current llmswitch-core minimal surface manifest, including native shells, type shells, diagnostic shells, and Node IO shells.

## Acceptance Criteria

- `docs/loops/rustification/minimal-ts-surface.json` no longer lists the 12 current entries.
- `npm run verify:llmswitch-minimal-ts-surface -- --json` reports:
  - `entries: 0`
  - `current non-native prod TS files: 0`
  - `explicit native-linked TS shells: 0`
- `npm run verify:llmswitch-rustification-audit -- --json` reports:
  - `nonNativeFileCount: 0`
  - `nonNativeLocTotal: 0`
- All runtime semantics previously behind TS shells are owned by Rust or by generated, deterministic bindings.
- No fallback, compatibility dual path, or second TS owner is introduced.
- Changes are committed with exact intended files only.

## Scope

### Current 12 Closeout Targets

1. `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
2. `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
3. `sharedmodule/llmswitch-core/src/runtime/user-data-paths.ts`
4. `sharedmodule/llmswitch-core/src/telemetry/stats-center.ts`
5. `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts`
6. `sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.ts`
7. `sharedmodule/llmswitch-core/src/conversion/hub/types/json.ts`
8. `sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.ts`
9. `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts`
10. `sharedmodule/llmswitch-core/src/servertool/types.ts`
11. `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
12. `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-policy.ts`

### In Scope

- Remove hand-authored TS source files above, including type-only and facade-only files.
- Move remaining semantics into Rust crates under:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/`
  - other existing Rust crates only when already owning the feature.
- Replace TS compile surfaces with generated declarations or Rust-owned deterministic artifacts where required.
- Update package barrels, imports, tests, architecture maps, verification gates, wiki/manifest files, and CI wiring.
- Add red gates that fail if any deleted TS target or equivalent bridge owner returns.
- Update `note.md`, `MEMORY.md`, and relevant local skill lessons.

### Out of Scope

- No provider behavior redesign.
- No VR routing policy changes unrelated to eliminating TS shells.
- No live config migration or edits to real `~/.rcc` files.
- No fallback path to keep TS running if Rust/generation fails.
- No broad reset/checkout or unrelated dirty-worktree cleanup.

## Design Principles

- Rust owns runtime truth. TS may not remain as a semantic, diagnostic, facade, or type truth for the 12 targets.
- Generated artifacts are allowed only if deterministic, build-owned, and guarded; hand-authored TS in `sharedmodule/llmswitch-core/src` is not an acceptable end state.
- IO shells must be replaced by one of:
  - Rust-backed host API exposed through existing native boundary,
  - server/runtime owner outside llmswitch-core minimal source surface,
  - deterministic generated binding consumed by the Node host.
- Type shells must be replaced by generated `.d.ts` or Rust schema-derived declarations, not by moving equivalent handwritten declarations elsewhere.
- Native shells must be removed by moving call sites to the generated/native binding owner or by collapsing the facade into existing runtime host code outside the minimal surface.
- Every deletion needs a source import/reference gate before and after removal.

## Technical Plan

### Phase 1: Snapshot and Red Gate

1. Re-run current baseline gates:
   - `npm run verify:llmswitch-minimal-ts-surface -- --json`
   - `npm run verify:llmswitch-rustification-audit -- --json`
2. Add/update a dedicated zero-TS gate that names all 12 target paths and fails while any exists.
3. Add import/reference scans over source/test/scripts/docs architecture files, excluding generated outputs, `dist`, `target`, `.mempalace`, `.local-index`, and archived samples.

### Phase 2: Type Shell Removal

Targets:
- `chat-envelope.ts`
- `json.ts`
- `standardized.ts`
- `virtual-router-contracts.ts`
- `servertool/types.ts`

Actions:
- Identify all live imports.
- Replace handwritten TS declarations with Rust schema/generated declaration outputs or relocate compile-only host declarations to deterministic generated artifacts outside `src`.
- Remove source barrels and package exports that publish these TS files.
- Add gates forbidding re-export or direct import of deleted type shell paths.

### Phase 3: Native Facade Removal

Targets:
- `hub-pipeline.ts`
- `native-router-hotpath-policy.ts`

Actions:
- Move host call sites to the canonical generated/native binding access layer.
- Keep fail-fast behavior at the native binding boundary.
- Remove facade imports and required export duplication.
- Ensure native unavailable/error object behavior remains explicit and covered.

### Phase 4: Diagnostic and Stats Shell Removal

Targets:
- `hub-stage-timing.ts`
- `stats-center.ts`

Actions:
- Move stage timing observation into Rust-owned effect/trace output or generated diagnostic records.
- Remove TS mutation of MetadataCenter debug snapshots for timing truth.
- Remove `stats-center.ts` bridge consumer by moving `getStatsCenter()` consumption to a Rust/generator-owned or server-runtime-owned boundary.
- Add gates forbidding timing/stats policy from reappearing in TS under llmswitch-core source.

### Phase 5: Host IO Shell Removal

Targets:
- `provider-response.ts`
- `responses-conversation-store.ts`
- `user-data-paths.ts`

Actions:
- For `provider-response.ts`, move stream materialization, response store coordination, usage persistence trigger, SSE frame construction, and MetadataCenter closeout orchestration into a Rust-owned or generated host boundary. The Node host may pass raw stream handles only if the owning source is outside the llmswitch-core minimal TS surface and has no response semantics.
- For `responses-conversation-store.ts`, replace Map/FS/timer singleton with a Rust-backed store or generated host lifecycle boundary. TS must not own continuation scope/persistence predicates or materialization decisions.
- For `user-data-paths.ts`, make Rust own env/path/default-root resolution and expose only generated host declarations. Preserve existing path semantics through parity tests.
- Delete the old TS files and update all package/runtime imports.

### Phase 6: Map, Wiki, Manifest, and CI Sync

- Update:
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - relevant manifests under `docs/architecture/manifests/`
  - relevant wiki pages and rendered HTML
  - `docs/loops/rustification/minimal-ts-surface.json`
  - `sharedmodule/llmswitch-core/config/rustification-audit-baseline.json` only after the gate proves a true shrink.
- Render architecture wiki/html if any source pages changed.
- Update package scripts and CI references so deleted tests/files are not invoked.

## Risks and Mitigations

- Risk: deleting type shells breaks Node host compile.
  - Mitigation: generate deterministic declarations first, then delete handwritten TS and verify root/sharedmodule TypeScript.
- Risk: provider-response IO removal changes SSE/client output behavior.
  - Mitigation: lock JSON/SSE parity and focused provider-response tests before deletion; run old same-entry samples where available.
- Risk: continuation store migration loses scope isolation.
  - Mitigation: run responses continuation contract gates and focused store tests before and after host IO replacement.
- Risk: generated files become a hidden TS fallback.
  - Mitigation: gates must distinguish generated declarations from hand-authored runtime TS and forbid semantic logic in generated artifacts.
- Risk: broad worktree staging catches other workers' changes.
  - Mitigation: stage exact intended paths or verify status contains only intended files before commit.

## Verification Matrix

### Required Local Gates

- `npm run verify:llmswitch-minimal-ts-surface -- --json`
- `npm run verify:llmswitch-rustification-audit -- --json`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `npx tsc --noEmit --pretty false`
- `npm run build:native-hotpath`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-review-surface-light`
- `git diff --check`

### Focused Regression Areas

- provider-response JSON/SSE projection and MetadataCenter isolation
- responses continuation store save/restore/materialization
- user-data path/env parity
- provider failure policy native boundary
- HubPipeline native engine lifecycle
- servertool rust-only residue
- VR contract/bootstrap compile consumers

### Build and Runtime Gates

- `npm run build:base`
- Relevant package build for `sharedmodule/llmswitch-core`
- Managed live replay only if runtime behavior changed beyond source/build boundary. If not performed, report it explicitly as a remaining gap.

## Implementation Steps

1. Snapshot current 12 targets and add a red zero-TS gate.
2. Remove type shells with generated declarations and import rewiring.
3. Collapse native facade shells into generated/native binding owners.
4. Move diagnostic/stats host shell responsibilities out of llmswitch-core TS source.
5. Replace host IO shells with Rust-backed/generated host boundaries.
6. Delete all 12 target source files.
7. Update architecture maps, manifests, wiki/html, package exports, CI, and rustification baselines.
8. Run focused tests, TypeScript, native build, architecture gates, minimal surface gate, rustification audit, build base, and diff check.
9. Update `note.md`, `MEMORY.md`, and local skill lessons.
10. Mine/search MemPalace for the new closeout fact.
11. Commit exact intended files.

## Definition of Done

- All 12 listed paths are physically absent or no longer hand-authored production TS under `sharedmodule/llmswitch-core/src`.
- Minimal TS surface manifest has no remaining entries.
- Rustification audit reports zero non-native files and zero non-native LOC.
- Function/mainline/verification maps point to Rust/generated owners only.
- No TS fallback, compatibility path, duplicate owner, or hidden semantic shell remains.
- Verification evidence is recorded in `note.md` and durable conclusions in `MEMORY.md`.
- A commit exists for the closeout.

## 2026-07-11 Current Closeout Audit

- Source/doc-only gates now report literal zero hand-authored production TS in `sharedmodule/llmswitch-core/src`: `verify:llmswitch-zero-ts-closeout`, strict shell reference audit, minimal TS surface, and rustification audit all pass with zero production/non-native TS metrics.
- Source inventory via `git ls-files 'sharedmodule/llmswitch-core/src/**/*.ts'` finds only test files plus two declaration artifacts: `native/router-hotpath/virtual-router-contracts.d.ts` and `servertool/types.d.ts`. Production runtime TS files are absent.
- Architecture gates pass: function-map compile gate, mainline call-map, mainline manifest sync, deleted-path, thin-wrapper-only, VR no-TS runtime, servertool Rust-only, and Responses history protocol contract.
- Build gates pass: `verify:llmswitch-core-tsc`, root `tsc --noEmit`, `build:native-hotpath`, and `build:base`.
- Installed runtime evidence: `routecodex --version`, `rcc --version`, `~/.rcc/install/current/package.json`, and `/health` on ports `4444`, `5520`, `5555`, and `10000` all report `0.90.3789`; health responses are `ready=true` and `pipelineReady=true`.
- No new runtime behavior was changed in this audit slice, so no managed restart or live replay is claimed for this documentation/evidence closeout.
