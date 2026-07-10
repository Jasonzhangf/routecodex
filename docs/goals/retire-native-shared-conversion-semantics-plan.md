# Retire Native Shared Conversion Semantics TS Wrapper Plan

## Goal

Eliminate `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts` from production source. Runtime semantics must remain Rust/NAPI truth. TypeScript may remain only as host native IO glue or test-only direct native helpers.

## Acceptance Criteria

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts` is physically absent from production source.
- No active production, script, or test import depends on the deleted production wrapper path or its dist output, except residue absent-file locks.
- Any still-needed direct native helper surface is moved under `tests/sharedmodule/helpers/` or an existing host native owner such as `src/modules/llmswitch/bridge/native-exports.ts`.
- No new production TS wrapper, compatibility shim, fallback path, or dual-path bridge replaces the deleted file.
- `prodTsShellCount` drops below the current baseline `13`; `nonNativeFileCount=0` remains true.

## Scope

In scope:

- Audit every import/text reference to `native-shared-conversion-semantics`.
- Classify each export by final owner:
  - host runtime native IO glue
  - test-only direct native helper
  - dead script/coverage surface
  - already covered by another Rust/host native export
- Move test-only glue to `tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts` or merge into existing test helper files.
- Update scripts to call direct Rust NAPI or host `native-exports` instead of sharedmodule dist wrapper.
- Delete obsolete coverage/matrix scripts that exist only to exercise the deleted production wrapper.
- Update function-map, verification-map, denylist/residue gates, and rustification baseline.

Out of scope:

- Changing Rust semantics.
- Adding new TS semantic policy, parser, projection, continuation, or response governance.
- Touching unrelated dirty worktree files.
- Reworking provider runtime behavior.
- Reviving previously deleted wrappers.

## Design Principles

- Rust/NAPI is the only semantic owner.
- Production TS must not inspect, repair, normalize, or decide Hub Pipeline semantics.
- Test-only direct native glue is allowed only under `tests/`.
- Host bridge glue may call NAPI directly, but must stay native-call/stringify/parse/fail-fast only.
- Deleted production wrappers stay deleted; no compatibility facade under `sharedmodule/llmswitch-core/src/native/router-hotpath/`.

## Technical Plan

1. Establish current graph:
   - Run `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`.
   - Run `git grep -n "native-shared-conversion-semantics" -- ':!**/dist/**'`.
   - Record production importers, scripts, tests, and docs.

2. Migrate tests:
   - Create or extend test-only direct native helper under `tests/sharedmodule/helpers/`.
   - Update root/sharedmodule tests to import the test helper.
   - Keep helper code limited to native binding lookup, JSON stringify/parse, and fail-fast behavior.

3. Migrate scripts:
   - Replace `dist/native/router-hotpath/native-shared-conversion-semantics.js` loads with direct NAPI helper or host `dist/modules/llmswitch/bridge/native-exports.js`.
   - Remove obsolete coverage/matrix entries whose only purpose is the deleted wrapper.

4. Migrate production references:
   - If a live production importer exists, route it through the correct existing host owner or direct Rust NAPI call.
   - Do not create a new production wrapper file.

5. Delete the wrapper:
   - Physically remove `native-shared-conversion-semantics.ts`.
   - Update rustification baseline and shell audit expectations.
   - Add/adjust residue absent-file locks.

6. Re-audit next blocker:
   - After deletion, re-run shell audit.
   - Identify whether `native-hub-pipeline-req-inbound-semantics.ts` still has production importers.
   - Do not start that second deletion in this goal unless it is a direct prerequisite for deleting `native-shared-conversion-semantics.ts`.

## Risks And Controls

- Risk: moving wrapper exports creates a new production TS semantic owner.
  - Control: host changes may only call Rust NAPI and parse fail-fast results.

- Risk: scripts silently keep requiring deleted dist output.
  - Control: active stale path scan must cover `scripts/`, root `tests/`, `src/`, and `sharedmodule/llmswitch-core/src`.

- Risk: residue gates treat test-only helper as production.
  - Control: function-map production allowed paths must prefer Rust source and host bridge owners; test helpers belong in tests/contracts.

- Risk: dirty worktree contains unrelated changes.
  - Control: stage only scoped files; do not touch unrelated dirty files.

## Verification Plan

Required:

- `npm run verify:llmswitch-core-tsc`
- `npm run verify:llmswitch-ts-shell-reference-audit`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-fallback-denylist`
- Focused Jest for migrated helper users.
- `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- Active stale path scan for `native-shared-conversion-semantics`.
- `git diff --check`
- `npm run build:base`

## Definition Of Done

- The production wrapper file is deleted.
- All active references are migrated to Rust/host native exports or test-only helpers.
- `prodTsShellCount` is below `13`.
- `nonNativeFileCount=0`.
- Verification commands have current passing evidence.
- Scoped commit is created without unrelated dirty files.
