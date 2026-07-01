# Server Runtime SSE Error Handler Cleanup Plan

## Target

Continue the server runtime pre-rustification cleanup by auditing and, if confirmed wrong, removing the raw-string fallback path in `src/server/runtime/http-server/executor/sse-error-handler.ts`.

## Acceptance Criteria

- The next slice has one unique owner and one minimal code path.
- If the raw-string path is obsolete fallback, it is physically removed and guarded by a focused test or source gate.
- If it is legitimate ErrorErr06 client projection, no code is changed and the reason is recorded in `note.md`.
- No provider/client payload semantics are changed outside the SSE error projection owner.
- The worktree is committed only after verification passes.

## Scope

In scope:
- `src/server/runtime/http-server/executor/sse-error-handler.ts`
- Direct callers such as provider response conversion error extraction.
- Focused tests/gates covering this exact fallback marker.

Out of scope:
- `port-config-validator.ts` legacy config compatibility.
- retry payload snapshot reconstruction.
- provider response tool fallback logic.
- route shutdown exception fallback.
- Any runtime payload cleanup or request/response semantic conversion.

## Design Rules

- SSE remains transport/error projection only, not semantic owner.
- Error projection belongs to the explicit error chain; no silent fallback.
- Do not add dual paths, compatibility shims, or payload salvage.
- Do not touch unrelated dirty files or generated build side effects.

## Verification Matrix

- Focused Jest/source gate for the exact owner.
- `npx tsc --noEmit --pretty false`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-fallback-denylist`
- `git diff --check`
- `build:base` only if the slice changes runtime/build behavior materially.

## Execution Steps

1. Confirm current `git status --short`.
2. Read `sse-error-handler.ts`, direct callers, and existing tests.
3. Classify the raw-string path as either obsolete fallback or valid ErrorErr06 projection.
4. Add/adjust the focused red gate first.
5. Remove only the confirmed wrong path or record no-change rationale.
6. Run the verification matrix.
7. Update `note.md` with evidence.
8. Commit the verified slice only.

## Done Definition

- The next cleanup slice is either removed with tests or explicitly rejected as not removable with evidence.
- Standard gates pass.
- The repository is clean after commit.
