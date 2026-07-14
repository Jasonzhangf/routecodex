# Responses FAI Capture Payload Copy Budget Test Design

## Scope

`feature_id: debug.responses_fai_capture_payload_copy_budget` owns only the debug probe/capture script `scripts/responses-fai-capture.mjs`.

## Lifecycle

The CLI reads one provider configuration and either one explicit sample body or one built-in base payload. Built-in compatibility variants are attempted sequentially until one provider request succeeds. Variant preparation is diagnostic-only and must not materialize all complete request graphs before the first attempt.

## Positive Cases

- The variant builder is lazy: requesting early variants does not materialize later tool projections.
- Every variant owns a separate top-level object so adding `model` and `stream` cannot mutate the base payload.
- Unchanged `input`, `tools`, parameter schema, and content branches retain exact reference identity.
- Tool-shape variants allocate only their replacement `tools` array and changed tool wrappers.
- Importing the script for tests performs no config read, provider initialization, network IO, or artifact write.

## Negative Cases

- The script must not use `JSON.parse(JSON.stringify(...))`, `structuredClone`, `deepClone`, or an eagerly materialized variants array.
- An explicitly supplied invalid sample must fail-fast. It must not silently switch to generated variants.
- Debug projections must not become provider/client payload truth, route selection truth, MetadataCenter state, or provider configuration.
- This slice must not alter the actual provider request fields emitted for any existing variant.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/responses-fai-capture-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-fallback-denylist`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Completion Boundary

This slice proves debug-script source and behavior ownership only. It does not execute a provider request, modify provider configuration, or prove installed-runtime RSS reduction.
