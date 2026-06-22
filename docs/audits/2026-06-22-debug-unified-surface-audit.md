# 2026-06-22 Debug Unified Surface Audit

## Scope

Read-only architecture audit for the planned debug unified surface migration.

Goal:

- identify the current split owners,
- define the required diagnostics taxonomy,
- and establish the M0 governance shell before runtime migration begins.

Primary goal doc:

- `docs/goals/debug-unified-surface-goal.md`

## Verified Findings

1. There is no current single debug owner feature.
   - `src/debug/` exists as a toolkit facade, but function-map does not currently treat it as the sole owner.
   - existing registered debug-related features are still split across snapshot and provider hook surfaces.

2. `diag` and `diagnostics` are currently conflated in common language but not in code ownership.
   - error diag artifact writing exists in server handlers (`~/.rcc/diag/error-*.json` style evidence dump).
   - runtime diagnostics contracts remain in VR/Hub runtime structures and routes.
   - usage log inline `diag=` is logger rendering, not runtime policy or snapshot storage.

3. Runtime diagnostics must not be migrated into debug ownership.
   - current VR diagnostics ownership already says HTTP diagnostics may expose Rust VR forwarder status only.
   - any migration that moves route-selection or runtime-status semantics into debug would violate existing owner boundaries.

4. The migration must be per-module, not a bulk refactor.
   - current residues are structurally different: snapshot store, snapshot writers, logger, harness/replay, provider hooks, policy reporting, and diag artifacts each have different owner/risk/test surfaces.

## Required M0 Deliverables

- `feature_id: debug.unified_surface` in function-map
- `feature_id: debug.unified_surface` in verification-map
- `docs/architecture/wiki/debug-unified-surface-mainline-source.md`
- `docs/architecture/mainline-manifests/debug-unified-surface.mainline.yml`
- `chain_id: debug.unified_surface.mainline` in `docs/architecture/mainline-call-map.yml`
- explicit diagnostics taxonomy:
  - `debug.diag_error_artifact`
  - runtime diagnostics remain with runtime owners
  - inline log `diag=` remains logger-owned

## Non-goals for M0

- no runtime code migration
- no forced renaming of runtime diagnostics fields
- no snapshot writer consolidation yet
- no provider debug hook rewrites yet

## Next Module

M1 `debug.diag_error_artifact`

Why first:

- it has the clearest ownership bug surface,
- it currently includes direct file writes from handlers,
- and replay/debug scripts already depend on those artifacts as evidence inputs.

Exit criteria for M1:

- ad hoc handler file writing replaced by one debug diag writer contract
- replay reader stops hardcoding local machine diag path
- silent diag write failure path removed
