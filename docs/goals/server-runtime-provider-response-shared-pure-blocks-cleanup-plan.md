# Server Runtime Provider Response Shared Blocks Cleanup Plan

## Target And Acceptance

Goal: remove native-backed TypeScript fallback logic from `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts`, keeping Rust/NAPI as the only semantic owner for migrated provider-response shared pure blocks.

Acceptance:
- Native-backed exports fail fast when the native binding or required native function is missing.
- No `withNativeBinding`, silent native-load catch, or `return fallback()` path remains in the file.
- Local non-native helpers that are explicit server/executor policy glue are preserved unless separately proven obsolete.
- A source/gate test prevents the deleted fallback mechanism from returning.
- The slice is verified and committed without staging unrelated dirty files.

## Scope

In scope:
- `provider-response-shared-pure-blocks.ts` native-backed fallback removal.
- Focused Jest/source gate for deleted fallback markers.
- Existing focused shared-block tests and native Rust tests for affected blocks.
- Function-map/fallback-denylist/typecheck verification.

Out of scope:
- Stopless/servertool behavior changes.
- Direct request cleanup or provider payload rewriting.
- SSE handler/outbound semantics.
- Unrelated dirty tests under `tests/server/handlers/`.

## Design Principles

- Rust/NAPI is the only owner for migrated shared pure semantics.
- TS may only call required native functions and parse native JSON results.
- No fallback, no silent native failure, no duplicated TS semantic parser.
- Server executor remains orchestration/glue only.

## Technical Plan

Primary file:
- `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts`

Candidate test file:
- `tests/server/runtime/http-server/executor/provider-response-shared-pure-blocks.spec.ts`

Native owners:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_response_shared_pure_blocks/payload_extraction.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/failure_policy.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`

Steps:
1. Add a red source test forbidding `withNativeBinding`, TS fallback wording, silent catch, and `return fallback()` in `provider-response-shared-pure-blocks.ts`.
2. Replace `getBinding()/withNativeBinding()` with required-native helpers.
3. Convert native-backed functions to required native calls.
4. Preserve local helpers only where no Rust owner exists and they are not fallback.
5. Run focused and mapped verification.
6. Commit only this slice.

## Risks

- Some exports may still be local glue rather than native-backed; do not delete them without owner confirmation.
- Native export names are camelCase in TS and snake/module-owned in Rust; verify binding type coverage before changing call sites.
- Existing unrelated dirty SSE tests must stay unstaged.

## Verification Matrix

Required:
- Focused Jest for `provider-response-shared-pure-blocks.spec.ts`.
- Rust `cargo test -p router-hotpath-napi provider_response_shared_pure_blocks --lib -- --nocapture`.
- Rust `cargo test -p router-hotpath-napi failure_policy --lib -- --nocapture`.
- `npx tsc --noEmit --pretty false`.
- `npm run verify:function-map-compile-gate`.
- `npm run verify:architecture-fallback-denylist`.
- `git diff --check`.

Runtime/live verification:
- Not required unless this slice changes runtime payload shape or provider/client observable behavior. This slice should be fail-fast ownership cleanup only.

## Done Definition

- Deleted TS fallback mechanism is locked by test/gate.
- All required checks pass.
- Commit created for this slice.
- Remaining server Rustification candidates are reported separately.
