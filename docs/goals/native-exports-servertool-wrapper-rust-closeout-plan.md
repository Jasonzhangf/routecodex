# Native Exports Servertool Wrapper Rust Closeout Plan

## Target

Shrink the largest remaining Hub Pipeline adjacent TypeScript module by removing the hand-written servertool wrapper fan-out from `src/modules/llmswitch/bridge/native-exports.ts`.

The intended end state is:

- `sharedmodule/llmswitch-core/src` remains zero production TypeScript.
- Servertool / stopless / followup semantics remain Rust-owned.
- `native-exports.ts` keeps only host binding load, fail-fast native invocation, and unavoidable host bridge IO.
- The 63 servertool `*WithNative` wrapper surface is either deleted, replaced by a single typed native action bridge, or moved to generated/declaration-only surface where still needed by callers.

## Acceptance Criteria

- `src/modules/llmswitch/bridge/native-exports.ts` no longer contains the large hand-written servertool wrapper block headed by `SERVERTOOL ORCHESTRATION WRAPPERS`.
- Active callers no longer import per-capability servertool wrapper functions when a single native action/capability bridge is sufficient.
- No servertool semantics are reimplemented in TypeScript.
- Missing native export, malformed native result, and JSON parse failure still fail fast.
- No fallback, compatibility shim, dual path, silent skip, or best-effort behavior is introduced.
- `sharedmodule/llmswitch-core/src` remains production TS zero.

## Scope

In scope:

- `src/modules/llmswitch/bridge/native-exports.ts`
- Direct callers of servertool wrapper functions under:
  - `src/modules/llmswitch/bridge/**`
  - `src/server/runtime/http-server/**`
  - `tests/servertool/**`
  - `tests/sharedmodule/**`
- Servertool / Hub Pipeline architecture maps and residue gates that mention the wrapper surface.
- Required tests and build gates listed below.

Out of scope:

- Changing Rust servertool semantics unless a missing Rust capability is proven by caller migration.
- Changing provider routing, same-protocol direct, retry/reroute, or provider error policy.
- Live release install or managed restart unless the implementation changes runtime behavior beyond source/package bridge contraction.
- Rewriting `responses-conversation-store-host.ts` or `routing-integrations.ts` in this goal.

## Design Principles

- Rust/NAPI is the only semantic truth for Hub Pipeline, Chat Process, servertool, stopless, and followup policy.
- TypeScript may only load native binding, serialize inputs, parse outputs, and perform host IO.
- One generic fail-fast invocation path is preferred over many hand-written `*WithNative` wrappers.
- Do not preserve dead exports for compatibility. If a caller is dead, delete the caller or test reference.
- If a wrapper is still needed only for test ergonomics, move it to a test helper and keep production bridge thin.

## Technical Plan

1. Inventory the wrapper fan-out.
   - Locate all exports in the `SERVERTOOL ORCHESTRATION WRAPPERS` block in `native-exports.ts`.
   - For each wrapper, classify active callers as production, test-only, script-only, or dead.
   - Record wrappers with zero active callers and delete them first.

2. Introduce or reuse a single native capability invocation primitive.
   - Prefer existing `invokeRouterHotpathJsonCapability(...)` if it already provides strict error handling.
   - If inadequate, narrow it without adding fallback:
     - require binding exists
     - require capability is a function
     - stringify input deterministically
     - require non-empty string output for JSON capabilities
     - parse JSON or throw explicit error

3. Migrate production callers.
   - Replace imports of `planServertool*WithNative`, `resolveServertool*WithNative`, `buildServertool*WithNative`, and similar servertool wrapper exports with either:
     - a small domain-local host IO helper, or
     - direct generic native action invocation.
   - Keep domain-local helpers only where they remove repeated host IO or typing noise.
   - Do not move policy decisions into caller files.

4. Move test-only shape helpers out of production bridge.
   - If tests require the old wrapper-shaped API, create or extend a test helper under `tests/sharedmodule/helpers/`.
   - That helper may call native directly, but must not become a production import target.

5. Update maps and gates.
   - Update `docs/architecture/function-map.yml`.
   - Update `docs/architecture/verification-map.yml`.
   - Update relevant wiki/review docs if they list `native-exports.ts` as owner of servertool wrapper details.
   - Update residue audit to forbid restoring the deleted servertool wrapper block in `native-exports.ts`.

6. Review architecture.
   - Confirm servertool semantics remain in Rust.
   - Confirm TypeScript bridge has no fallback or second implementation.
   - Confirm no unrelated provider/direct/routing behavior changed.

## File Checklist

Primary:

- `src/modules/llmswitch/bridge/native-exports.ts`

Likely callers:

- `src/modules/llmswitch/bridge/**`
- `src/server/runtime/http-server/**`
- `tests/servertool/**`
- `tests/sharedmodule/**`

Maps/gates:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `scripts/verify-servertool-rust-only.mjs`

## Risks

- Some callers may rely on wrapper return coercions rather than Rust output shape.
  - Mitigation: add focused tests before deleting wrapper coercions.
- Tests may import production bridge for convenience.
  - Mitigation: move convenience helpers to `tests/sharedmodule/helpers/`.
- Generic invocation can become too loose.
  - Mitigation: fail fast on missing function, non-string output, empty output, and JSON parse errors.
- Mechanical migration may hide live behavior change.
  - Mitigation: run focused servertool and Hub Pipeline residue tests plus build gates.

## Verification Matrix

Required source gates:

- `npm run verify:servertool-rust-only`
- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`
- `npm run verify:llmswitch-rustification-audit -- --json`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-deleted-path`
- `npm run verify:architecture-thin-wrapper-only`
- `npm run verify:architecture-fallback-denylist`

Required focused tests:

- `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `npm run jest:run -- --runInBand --runTestsByPath tests/servertool/servertool-cli-native-bridge.spec.ts`
- Any additional touched caller tests.

Required build checks:

- `npm run verify:llmswitch-core-tsc`
- `npx tsc -p tsconfig.json --noEmit --pretty false`
- `npm run build:base`
- `git diff --check`

Optional runtime verification:

- Only if runtime behavior changes beyond wrapper contraction: install managed artifact and validate via global `routecodex restart --port <port>` plus same-entry smoke.

## Implementation Steps

1. Run caller inventory with exact symbol search for the servertool wrapper exports.
2. Delete wrappers with no active callers.
3. Add or tighten the generic native invocation primitive.
4. Migrate production callers to the primitive or small domain-local IO helpers.
5. Move test-only wrapper conveniences to test helpers.
6. Update residue gates and architecture maps.
7. Run focused tests and required gates.
8. Review staged diff for unrelated dirty files.
9. Commit only this closeout slice.
10. Record stable facts in `MEMORY.md` if the closeout changes durable project truth.

## Definition of Done

- The servertool wrapper fan-out is gone from `native-exports.ts`.
- No production TypeScript owns servertool semantics.
- The core llmswitch production TS count remains zero.
- All required gates pass.
- The commit contains only scoped wrapper closeout changes and no unrelated dirty work.
