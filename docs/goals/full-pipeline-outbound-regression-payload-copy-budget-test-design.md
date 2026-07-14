# Outbound Regression Payload Copy Budget Test Design

## Scope

`feature_id: debug.outbound_regression_payload_copy_budget` owns only the provider-execution isolation copy in `scripts/outbound-regression-codex-samples.mjs`.

## Lifecycle

The diagnostic CLI loads one captured Codex request, builds one chat request, and reuses it across selected provider regression attempts. Provider converters and provider runtimes may mutate their input, so each attempt requires one independent execution graph that releases after that attempt.

## Positive Cases

- The execution copy preserves complete structured-clone semantics, including circular references, `BigInt`, `undefined`, and nested values.
- Provider-side mutation of the execution copy cannot alter the built regression request.
- Exactly one named clone owner is used immediately before provider conversion/send.
- Importing the script for tests performs no sample/config scan, provider initialization, rate wait, network IO, or artifact write.

## Negative Cases

- The script must not use JSON stringify/parse cloning.
- Clone failure must fail fast. It must not return the caller-owned object.
- The necessary execution copy must not become provider/client live payload truth, route truth, MetadataCenter state, provider configuration, or process-global retained state.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/outbound-regression-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `node scripts/architecture/verify-no-fallback-diff.mjs --files scripts/outbound-regression-codex-samples.mjs`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Completion Boundary

This slice classifies one necessary debug execution copy and removes only unsafe fallback clone paths. It does not execute provider regressions, modify provider configuration, or prove installed-runtime RSS reduction.
