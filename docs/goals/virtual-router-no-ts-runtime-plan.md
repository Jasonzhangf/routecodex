# Virtual Router No-TS Runtime Plan

## Target

Eliminate the TypeScript runtime and wrapper layer from Virtual Router. The final runtime owner for Virtual Router selection, bootstrap, provider registry, routing state, stop/pre-command state, health/quota policy, error policy ingress, status/log projection, and native API exposure must be Rust under:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`

This plan is stricter than the current thin-shell policy. Current docs and gates still allow `sharedmodule/llmswitch-core/src/router/virtual-router/**` as a TS bridge; this goal changes that contract.

## Acceptance Criteria

1. No production TypeScript file remains under `sharedmodule/llmswitch-core/src/router/virtual-router/**`, except temporary test fixtures or generated type declarations explicitly proven non-runtime and scheduled for deletion.
2. No production source imports `sharedmodule/llmswitch-core/src/router/virtual-router/**` or `sharedmodule/llmswitch-core/dist/router/virtual-router/**` as a runtime path.
3. `engine-selection/native-*.ts` is physically deleted or replaced by a generated non-authoritative binding artifact that is not a hand-written runtime wrapper.
4. `docs/architecture/function-map.yml` no longer lists the TS VR directory as an allowed runtime path for `vr.*` features.
5. Architecture gates fail if a new VR TS runtime file, wrapper, or import is added.
6. Existing VR behavior remains green through Rust tests, native parity tests, and blackbox routing tests.

## In Scope

- Rust VR API surface and bootstrap entrypoints.
- VR config bootstrap and provider profile materialization.
- `VirtualRouterEngine` facade replacement.
- Provider registry and target/runtime key resolution.
- Routing instruction state, stop-message state, pre-command state, and their persistence.
- Provider error/success ingress into VR policy.
- VR status and hit-log projection.
- Native export manifest and binding loading strategy.
- Function-map, verification-map, package scripts, and residue gates.
- Physical deletion of obsolete TS files after Rust replacement and verification.

## Out Of Scope

- Provider transport/auth implementation rewrite.
- HTTP server full Rust migration.
- Hub Pipeline full Rust-only host migration, except imports needed to remove VR TS paths.
- Servertool full Rust binary migration, except calls that currently depend on VR TS state/wrapper files.
- Changing route selection semantics without a red test proving a current bug.

## Design Principles

- Rust is the only VR runtime truth.
- TS cannot be a thin shell, semantic shim, loader policy, event fanout, or runtime state owner for VR.
- No fallback, no dual path, no silent sanitizer. Missing Rust capability must fail fast.
- Delete obsolete TS physically after replacement is live and tested.
- Move by closeout slices. Each slice needs its own gate and evidence; do not claim completion from aggregate line-count reduction.
- Preserve request/response semantics. Do not trim or rewrite real transport payload to make migration easier.

## Current Evidence Baseline

- `sharedmodule/llmswitch-core/src/router/virtual-router` currently has production TS runtime files.
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection` is the largest wrapper surface and must not remain as hand-written TS.
- Rust VR truth already exists for route selection, routing bootstrap, provider bootstrap/registry, routing state store, health/quota, instructions, direct model, and NAPI proxy under `virtual_router_engine`.
- Existing docs currently permit TS thin shells:
  - `docs/ARCHITECTURE.md`
  - `docs/agent-routing/10-runtime-ssot-routing.md`
  - `docs/architecture/function-map.yml`

## Migration Slices

### Slice 0: Contract And Gate Flip

Files:

- `docs/ARCHITECTURE.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `package.json`
- `scripts/architecture/verify-*.mjs`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`

Work:

1. Replace “TS thin shell allowed” language for VR with “VR runtime TS forbidden”.
2. Add `verify:vr-no-ts-runtime`.
3. Gate rules must scan both `src` and `dist` runtime imports.
4. Gate must fail on:
   - production TS files under VR runtime path,
   - hand-written `engine-selection/native-*.ts`,
   - imports from deleted VR TS runtime paths,
   - function-map allowed paths that re-allow VR TS.

Verification:

- `npm run verify:vr-no-ts-runtime`
- `npm run verify:architecture-ci`
- `npx tsc --noEmit --pretty false`

### Slice 1: Rust Bootstrap Single Entrypoint

Rust owner:

- `virtual_router_engine/config_bootstrap.rs`
- `virtual_router_engine/provider_bootstrap.rs`
- `virtual_router_engine/routing/bootstrap.rs`
- new or existing Rust module for full bootstrap orchestration

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/*.ts`
- matching dist artifacts

Work:

1. Add a Rust entrypoint that accepts the full virtual router config input and returns the full bootstrap result:
   - normalized `config`,
   - provider profiles,
   - runtime entries,
   - target runtime map,
   - routing table.
2. Move remaining TS extraction rules from `bootstrap.ts` into Rust, including forwarder target collection and root/virtualrouter section resolution.
3. Update Hub/config loader callers to consume the Rust bootstrap entrypoint.
4. Delete TS bootstrap files once callers are migrated.

Verification:

- `cargo test -p router-hotpath-napi virtual_router_engine::routing --lib -- --nocapture`
- `cargo test -p router-hotpath-napi virtual_router_engine::provider_bootstrap --lib -- --nocapture`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/virtual-router-bootstrap-native-config.spec.ts tests/sharedmodule/provider-model-real-config.spec.ts --runInBand`
- `npm run verify:vr-no-ts-runtime`

### Slice 2: Rust Engine Runtime API

Rust owner:

- `virtual_router_engine/napi_proxy.rs`
- `virtual_router_engine/engine/core.rs`
- `virtual_router_engine/engine/route.rs`
- `virtual_router_engine/engine/events.rs`
- `virtual_router_engine/engine/status.rs`

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-logging.ts`
- matching dist artifacts

Work:

1. Expose a Rust VR runtime API that replaces the TS `VirtualRouterEngine` class.
2. Move runtime path injection, stop marker parse/clean, persisted state merge/prune, status snapshot, and hit-log projection into Rust or a non-VR host projection path.
3. Update Hub Pipeline to receive/use the Rust engine API directly.
4. Delete TS engine facade and logging helper after imports are gone.

Verification:

- `cargo test -p router-hotpath-napi virtual_router_engine --lib -- --nocapture`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts tests/servertool/virtual-router-servertool-routing.spec.ts --runInBand`
- `npm run verify:vr-no-ts-runtime`

### Slice 3: Provider Registry And Target Resolution

Rust owner:

- `virtual_router_engine/provider_registry.rs`
- `virtual_router_engine/routing/direct_model.rs`
- `virtual_router_engine/routing/selection.rs`

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/provider-registry.ts`
- direct tests importing the TS registry must be moved to Rust or to blackbox runtime API tests.

Work:

1. Ensure Rust owns capability defaults, alias/key/model resolution, runtime key resolution, and target metadata construction.
2. Replace any TS caller that reads provider registry directly with Rust API or bootstrap result data.
3. Delete TS provider registry.

Verification:

- `cargo test -p router-hotpath-napi virtual_router_engine::provider_registry --lib -- --nocapture`
- `cargo test -p router-hotpath-napi virtual_router_engine::routing::direct_model --lib -- --nocapture`
- Relevant provider model Jest tests migrated or rewritten against Rust API.

### Slice 4: Routing State, Stop State, And Pre-Command State

Rust owner:

- `virtual_router_engine/routing_state_store.rs`
- `virtual_router_engine/instructions/**`
- Rust stop/pre-command state codec modules if split is needed.

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/routing-state-store.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions/**`
- `sharedmodule/llmswitch-core/src/router/virtual-router/routing-stop-message-state-codec.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/routing-pre-command-state-codec.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/stop-message-state-sync.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/stop-message-markers.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/stop-message-file-resolver.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/pre-command-file-resolver.ts`

Work:

1. Rust owns persistent key validation, path resolution, atomic write, recover, JSON schema, serialize/deserialize, merge/prune, and stop/pre-command file resolution.
2. Servertool and Hub code must stop importing TS routing state/store modules.
3. Replace call sites with Rust state API.
4. Delete TS state and instruction files.

Verification:

- `cargo test -p router-hotpath-napi virtual_router_engine::routing_state_store --lib -- --nocapture`
- `cargo test -p router-hotpath-napi virtual_router_engine::instructions --lib -- --nocapture`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/routing-state-store-observability.spec.ts tests/sharedmodule/routing-state-continuation-matrix.spec.ts tests/servertool/routing-instructions.spec.ts tests/servertool/stop-message-auto.spec.ts --runInBand`
- `npm run verify:servertool-rust-only`
- `npm run verify:vr-no-ts-runtime`

### Slice 5: Provider Error/Success Ingress

Rust owner:

- `virtual_router_engine/engine/events.rs`
- Rust error chain modules for `ErrorErr04RouterPolicyApplied`

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.ts`

Work:

1. Remove TS hook maps and event fanout as a policy center.
2. Provider/runtime error reporting should submit `ErrorErr01/02/03` source/classification into the Rust router policy API.
3. Rust returns the policy decision/event projection needed by executor/host.
4. Delete TS ingress once all imports are gone.

Verification:

- `cargo test -p router-hotpath-napi virtual_router_engine::engine::events --lib -- --nocapture`
- `npm run verify:architecture-error-chain-bypass`
- `npm run verify:provider-failure-ban-blackbox`
- Focused provider failure policy Jest suites.

### Slice 6: Native Wrapper Surface Removal

Rust owner:

- `router-hotpath-napi` exported API
- generated binding manifest if needed
- Rust contract/help descriptors

TS deletion candidates:

- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/**`
- matching dist artifacts

Work:

1. Replace hand-written `native-*.ts` wrappers with one of:
   - direct Rust service/binary boundary,
   - generated binding artifact with no hand-written runtime logic,
   - Rust-owned API consumed by existing Node host outside VR namespace during transition.
2. Move required export list into Rust self-describing manifest.
3. Update all Hub/servertool/conversion callers.
4. Delete `engine-selection`.

Verification:

- `cargo test -p router-hotpath-napi --lib -- --nocapture`
- `npm run verify:architecture-ci`
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:llmswitch-rustification-audit`
- `npx tsc --noEmit --pretty false`
- `npm run build:min`

### Slice 7: Final Residue And Dist Cleanup

Files:

- `sharedmodule/llmswitch-core/src/router/virtual-router/**`
- `sharedmodule/llmswitch-core/dist/router/virtual-router/**`
- tests and scripts importing deleted paths
- docs and plans referencing TS VR owners

Work:

1. Delete remaining source and dist-side VR TS artifacts.
2. Rewrite tests to hit Rust API, Rust unit tests, or blackbox HTTP/Hub paths.
3. Update docs to mark deleted TS paths as forbidden resurrection paths.
4. Update residue audit allowlists and remove obsolete exceptions.

Verification:

- `find sharedmodule/llmswitch-core/src/router/virtual-router -type f` returns no production TS runtime files.
- `rg "router/virtual-router" src sharedmodule scripts tests docs -g "*.ts" -g "*.mjs" -g "*.md" -g "*.yml"` shows only allowed docs/tests references.
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:architecture-ci`
- `npm run verify:llmswitch-rustification-audit`
- `cargo test -p router-hotpath-napi --lib -- --nocapture`
- `npx tsc --noEmit --pretty false`
- `npm run build:min`
- `git diff --check`

## Risk Matrix

| Risk | Mitigation |
|---|---|
| Hidden dynamic imports from dist VR paths | Gate must scan `importCoreDist`, dynamic `import()`, scripts, tests, and built dist references. |
| Deleting TS before Rust API parity | Each slice must migrate callers first, then delete TS, then run focused parity/blackbox tests. |
| Wrapper removal breaks Hub/servertool imports | Slice 6 must update all callers in one bounded change and run `tsc` plus architecture gates. |
| State persistence regression | Keep Rust state store tests plus existing routing-state Jest until caller migration is complete. |
| Error policy second center returns | `verify:architecture-error-chain-bypass` and provider failure blackbox gates must remain mandatory. |
| Docs continue allowing TS resurrection | Function-map/verification-map/docs must be updated in Slice 0 and rechecked in final residue. |

## Execution Rules

1. Before each slice, locate current callers with `rg`; do not rely on memory.
2. For every deleted TS file, prove imports are gone before deletion and add or update a residue gate.
3. Do not keep dead code as “unused compatibility”.
4. Do not add fallback from Rust back to TS.
5. Do not change provider/runtime/Hub payload semantics unless the slice explicitly requires a caller boundary update.
6. Treat tests that import deleted TS internals as migration targets, not as reasons to keep TS runtime files.
7. Record verified findings in `note.md`; promote durable facts to `MEMORY.md` only after tests pass.

## Definition Of Done

- VR has no production TS runtime/wrapper directory.
- Rust owns the complete VR runtime API and all VR state/policy semantics.
- Architecture/function-map gates make TS VR resurrection fail.
- Existing VR routing, health/quota, servertool routing, state persistence, and provider error policy tests pass.
- Build and typecheck pass.
- Obsolete docs and test imports are updated or deleted.
