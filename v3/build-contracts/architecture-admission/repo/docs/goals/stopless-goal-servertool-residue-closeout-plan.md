# Stopless / Goal / Servertool Residue Closeout Plan

## Purpose

This plan exists because the active metadata-center goal is still valid for `MetadataCenter` contract/gate closeout, but it is not sufficient to drive the separate end-state Jason now wants: physically removing unused `stopless / stop-message / goal-state / servertool` residue once owner truth and gates are narrowed.

This plan is not a replacement for the active metadata-center goal. It is the parallel closeout plan that prevents the repo from staying in a contradictory state where:

1. `MetadataCenter` is being converged toward one request-scoped truth, while
2. docs / maps / gates still keep stopless or goal-state families as active runtime owners without a deliberate keep-or-delete decision.

## Current Proven Facts

### Fact 1: the active metadata-center goal is still valid

The goal at:

- `/Users/fanzhang/.codex/attachments/5e9487b8-30ba-4b6b-a816-f32202d1325f/pasted-text-1.txt`

still matches the current repo truth for:

- one request-scoped `MetadataCenter`
- `request_truth` write-once inbound identity
- `continuation_context` / `runtime_control` write boundaries
- no flat metadata / `__rt` / top-level control residue reactivation
- contract/gate-first closeout

Primary evidence:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/metadata-center-mainline-source.md`
- `docs/architecture/wiki/responses-continuation-mainline-source.md`

### Fact 2: stopless/servertool residue is still active in architecture truth

The repo still documents and gates stopless/servertool semantics as active runtime owners.

Primary evidence:

- `docs/architecture/function-map.yml`
  - `feature_id: hub.servertool_stopless_cli_continuation`
  - `Stopless canonical control is runtime_control.stopless`
  - `hasStoplessDirectiveInRequestPayload(...) -> runtime_control.stopMessageEnabled`
- `docs/architecture/verification-map.yml`
  - stopless CLI projection / runtime metadata validation
  - stopless-directive entry write validation
- `docs/architecture/wiki/servertool-ownership-map.md`
  - multiple `hub.servertool_*` active features remain
- `docs/architecture/wiki/stopless-session-mainline-source.md`
  - stopless lifecycle remains a maintained review surface

### Fact 3: the current repo cannot honestly claim stopless/goal/servertool family is already removable as a whole

Because architecture truth still names those families as owners, any physical deletion must first narrow or delete the corresponding owner/map/gate truth. Otherwise the repo will violate its own architecture contracts.

## Goal

Close stopless / stop-message / goal-state / servertool residue in the correct order:

1. classify each residue as either:
  - active runtime owner,
  - stale residue with no consumer,
  - dead residue with no consumer;
2. keep only what current runtime truth still proves necessary;
3. physically delete dead residue and stale architecture claims;
4. leave the repo with one coherent story across code, docs, maps, and gates.

## Non-Goals

- Do not pretend this plan replaces the active metadata-center goal.
- Do not delete active runtime owners before their owner/gate truth is changed.
- Do not keep dead code merely because a wiki, map, or gate still mentions it.
- Do not introduce fallback, dual-truth compensation, or silent compatibility paths.

## Required Owner Audit

Before deleting any residue, audit these buckets and classify each symbol/path as `active`, `transitional`, or `dead`.

### A. Stopless / stop-message runtime-control fields

Audit at minimum:

- `runtime_control.stopless`
- `runtime_control.stopMessageEnabled`
- `runtime_control.stopMessageExcludeDirect`
- any `stoplessGoalStatus`
- any `stopMessageCompareContext`
- any top-level runtime-control residue:
  - `metadata.stopMessageEnabled`
  - `routecodexPortStopMessageEnabled`
  - remaining `serverToolLoopState` / `stopMessageState` projections

Questions:

1. Which readers are still live in Rust?
2. Which writers are still authoritative?
3. Which fields are stale residue and can be removed after reader migration?

### B. Stopless / servertool architecture truth

Audit at minimum:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/servertool-ownership-map.md`
- `docs/architecture/wiki/stopless-session-mainline-source.md`
- `docs/architecture/wiki/servertool-followup-call-graph.md`
- `docs/architecture/wiki/mainline-call-graph.md`
- relevant `docs/design/*stopmessage*` / `docs/stop-message-auto.md`

Questions:

1. Which feature rows still correspond to live runtime owners?
2. Which rows only exist because earlier stopless migration work stopped halfway?
3. Which wiki pages become invalid once active owner rows are removed?

### C. Goal-state residue

Audit any remaining:

- `goal`
- `goal-state`
- `stoplessGoalStatus`
- workflow/state docs or tests that require a goal-specific closeout path

Questions:

1. Is there any live runtime owner left?
2. Is it only a stale state field or dead test contract?
3. Can it be physically deleted now without changing runtime semantics?

## Execution Order

### Phase 1: owner truth lock

1. Record file-level evidence for all remaining stopless/goal/servertool residues.
2. For each residue family, decide:
   - keep as active owner for now,
   - narrow to transitional compatibility only,
   - delete.
3. Update:
   - `docs/architecture/function-map.yml`
   - `docs/architecture/verification-map.yml`
   - `docs/architecture/mainline-call-map.yml`
   - metadata/wiki review surfaces
4. Tighten gates so deleted or downgraded owner claims cannot silently return.

Completion for Phase 1:

- repo docs/maps/gates no longer overclaim dead or transitional residues as active truth.

### Phase 2: runtime reader/writer convergence

1. Migrate any still-live readers away from top-level runtime-control residue or legacy fields.
2. Keep `MetadataCenter` family truth as the only surviving control carrier where applicable.
3. Remove stale residue only after proving no active reader still depends on it.

Completion for Phase 2:

- remaining stopless/stop-message control fields are either:
  - active center-backed truth with a single owner, or
  - deleted.

### Phase 3: physical deletion

Delete only after Phases 1-2 make the deletion honest:

1. dead TS shells
2. stale Rust/TS metadata fields
3. stale tests that encode deleted semantics
4. stale wiki pages / generated review surfaces
5. stale gate references

Completion for Phase 3:

- no dead stopless/goal/servertool residue remains merely “not used”.

## Mandatory Gates

At minimum, rerun after each closeout slice:

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-metadata-center-manifest-code-sync`
- `npm run verify:architecture-metadata-center-write-boundaries`
- `npm run verify:servertool-rust-only`

If wiki or rendered review surfaces change, also run:

- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `npm run verify:architecture-mainline-node-id-consistency`

## Acceptance Standard

This closeout is complete only when all of the following are true:

1. no active architecture truth overclaims dead stopless/goal/servertool owners;
2. all still-live stopless/servertool control semantics have one coherent owner path;
3. top-level runtime-control residue is either proven necessary current truth or physically deleted;
4. no dead goal-state / stop-message / stopless docs, tests, gates, or code remain in the repo as “historical leftovers”;
5. required gates pass with the new, narrower truth.

## Immediate Next Slice

The next concrete slice should be:

1. audit all remaining consumers of:
   - `stopMessageEnabled`
   - `stopMessageExcludeDirect`
   - `routecodexPortStopMessageEnabled`
   - `stoplessGoalStatus`
2. classify each consumer as active / transitional / dead;
3. update function-map + verification-map notes accordingly before deleting any mirror.
