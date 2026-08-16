# Retire Hub Resp Semantics TS Wrappers Plan

## Goal

Eliminate the remaining Hub Pipeline response-side production TS wrapper shells:

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-outbound-tools.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.ts`

Runtime semantics must remain Rust/NAPI truth. TS may exist only as test-only direct native glue or minimal host/native IO glue when a real production consumer remains.

## Acceptance Criteria

- The two split wrapper files are physically absent from production source.
- `native-hub-pipeline-resp-semantics.ts` is either physically absent from production source or has a documented live production importer and contains only native-call/stringify/parse/fail-fast glue.
- Active production source, scripts, tests, and architecture maps do not import deleted production wrapper paths except residue absent-file locks.
- Shell audit decreases from the current baseline:
  - current `prodTsShellCount=16`
  - expected after split wrapper deletion: at most `14`
  - expected if aggregate can also be moved test-only/deleted: at most `13`
- `nonNativeFileCount=0` remains true.

## Scope

In scope:

- Move direct tests that import resp split wrappers to aggregate owner or test-only helper.
- Merge native-call/stringify/parse/fail-fast glue into the smallest remaining aggregate owner when needed.
- Move aggregate response helper surface to test-only helper if it has no production importer.
- Update function-map, verification-map, no-fallback denylist, residue audit, and observability tests.
- Add absent-file locks for every retired production wrapper.

Out of scope:

- Changing Rust semantics.
- Adding fallback or dual-path behavior.
- Reworking provider runtime behavior.
- Touching unrelated dirty worktree files.
- Reintroducing old TS response governance, tool parsing, continuation, or projection semantics.

## Design Principles

- Rust/NAPI remains the only semantic owner.
- Deleted wrappers stay physically deleted; no compatibility shim under production source.
- Test-only direct native helpers are allowed only under `tests/`.
- Production TS must not inspect response tool semantics, repair response payloads, or implement protocol policy.
- Prefer small commits after each verified deletion.

## Technical Plan

1. Audit current graph:
   - Run `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`.
   - Confirm production importers for inbound/outbound split wrappers are only `native-hub-pipeline-resp-semantics.ts`.

2. Retire inbound split wrapper:
   - Move required test-only direct native glue to `tests/sharedmodule/helpers/` or merge into `native-hub-pipeline-resp-semantics.ts`.
   - Update direct imports in:
     - `sharedmodule/llmswitch-core/tests/hub/resp-semantics-native-echo.spec.ts`
     - `tests/sharedmodule/native-semantics-parsers-observability.spec.ts`
     - residue tests and architecture maps.
   - Delete `native-hub-pipeline-resp-semantics-inbound-tools.ts`.
   - Run focused gates and commit.

3. Retire outbound split wrapper:
   - Repeat the same flow for `native-hub-pipeline-resp-semantics-outbound-tools.ts`.
   - Ensure response client projection and Responses payload helpers still call Rust NAPI only.
   - Run focused gates and commit.

4. Retire aggregate wrapper if possible:
   - Re-run shell audit.
   - If `native-hub-pipeline-resp-semantics.ts` has no production importer, move any remaining direct-test helper surface to `tests/sharedmodule/helpers/` and delete the production aggregate.
   - If a live production importer remains, reduce it to a minimal aggregate shell and document the remaining owner/importer in `note.md` and `MEMORY.md`.

## Risks And Controls

- Risk: Large mechanical merge creates hidden TS semantic owner.
  - Control: Only move native-call/stringify/parse/fail-fast glue; do not add payload policy.

- Risk: Residue audit flags old parser names after consolidation.
  - Control: Rename local parser helpers when they collide with retired public-symbol deny rules.

- Risk: Jest command without project runner fails on ESM/import.meta.
  - Control: Use `npm run jest:run -- --runInBand --runTestsByPath ...`.

- Risk: Dirty worktree contains unrelated provider/build-info changes.
  - Control: Stage only scoped files for each commit.

## Verification Plan

Required after each deletion:

- `npm run verify:llmswitch-core-tsc`
- `npm run verify:llmswitch-ts-shell-reference-audit`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:architecture-fallback-denylist`
- `npm run verify:function-map-compile-gate` when architecture maps change
- Focused Jest:
  - `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
  - `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/native-semantics-parsers-observability.spec.ts -t "resp inbound|resp outbound"`
  - `npm run jest:run -- --runInBand --runTestsByPath sharedmodule/llmswitch-core/tests/hub/resp-semantics-native-echo.spec.ts`
- Active stale path scan with `git grep`.
- Targeted `git diff --check`.
- `npm run build:base` before final closeout commit.

## Implementation Steps

1. Read current status and confirm unrelated dirty files.
2. Audit references for both split wrappers.
3. Retire inbound split wrapper, verify, commit.
4. Retire outbound split wrapper, verify, commit.
5. Re-audit aggregate wrapper and delete/move test-only if possible.
6. Update `note.md` and `MEMORY.md`.
7. Run final verification stack.
8. Report commits, metrics, verification, and remaining TS shells.

## Definition Of Done

- Response-side Hub Pipeline split wrapper TS files are gone from production source.
- `prodTsShellCount` drops below current baseline `16`.
- `nonNativeFileCount=0`.
- No active import of retired paths outside residue absent-file locks.
- Final result is committed in scoped commits with unrelated dirty worktree files untouched.
