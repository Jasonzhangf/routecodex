# Repository Root Retirement and V3/V4 Integration

Status: approved execution
Date: 2026-08-16

## Objective

Reduce the repository root to governance and thin cross-version orchestration while preserving two physically isolated product build domains. Execute in this order:

1. Remove proven dead root files that have no runtime, build, test, package, map, or CI consumer.
2. Integrate and verify the V4 independent build domain.
3. Integrate and verify the V3 independent build domain.
4. After both isolated domains build and test successfully, remove the entire `deprecated/` archive and every active contract or gate that treats it as a permanent source root.

## Phase boundaries

### Phase 1: zero-consumer retirement

- Delete obsolete root delivery logs, raw vendor page captures, and dead Node-host documentation.
- Delete retired V2 examples and plans instead of moving new material into `deprecated/`.
- Do not remove a file that is still an active V3 or V4 build input; its source-path deletion must be atomic with the owning migration.
- Keep `deprecated/` temporarily because its removal is admitted only after V4 and V3 positive build evidence exists.

### Phase 2: V4 build domain

- Consume the checked V4 build-isolation handoff commit only after its required gates and DSH Review pass.
- V4 owns its package/lock/toolchain/scripts/tests/contracts/docs and all mutable outputs below `v4/`.
- Root retains only thin `npm --prefix v4 ...` dispatch and repository-level CI orchestration.

### Phase 3: V3 build domain

- Consume the checked V3 build-isolation handoff commit only after its required gates and DSH Review pass.
- V3 owns its package/lock/toolchain/crates/scripts/tests/install/pack and all mutable outputs below `v3/`.
- Active V3 builds must not dynamically read root authoring; deterministic admission artifacts live under `v3/build-contracts/`.

### Phase 4: deprecated archive removal

- Preconditions: V4 `verify:ci` passes from `v4/`; V3 `verify:ci`, install, and pack gates pass from `v3/`; root thin dispatchers pass; no active machine map, source, script, package, or CI reference requires `deprecated/`.
- Delete `deprecated/` physically.
- Remove `deprecated/v2` ownership, allowlists, archive gates, docs, and red fixtures that require the archive to exist.
- Preserve no fallback, compatibility loader, package input, or hidden copy of the retired archive.

## Required evidence

- Exact changed-path and consumer audit for each deletion.
- Phase-specific positive and negative isolation gates.
- Clean build outputs confined to their owning version directory.
- Root dispatcher and unrelated-CWD verification.
- AppSDK admission where declared by the version project.
- DSH Review with no blocking P0/P1 finding after final code/build/config changes.
- Final `git diff --check`, repository filesystem governance, V3/V4 full build gates, and clean worktree.

## Completion signal

The task is complete only when the integrated branch contains ordered, reviewable commits for root retirement, V4 integration, V3 integration, and final `deprecated/` removal; both version-local build domains pass from clean installs; root has no product build input or output; and the worktree is clean.
