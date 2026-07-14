# Responses SSE Capture Payload Copy Budget Test Design

## Scope

`feature_id: debug.responses_sse_capture_payload_copy_budget` owns only the debug capture request projection in `scripts/responses-sse-capture.mjs`.

## Lifecycle

The CLI loads either a complete Responses sample or converts one chat sample through the existing native codec. It then applies capture-only top-level overrides before explicitly sending one SSE request and writing diagnostic artifacts.

## Positive Cases

- The capture request owns a separate top-level object so `model`, `tool_choice`, `instructions`, and `stream` changes cannot mutate the loaded or converted source request.
- Unchanged `input`, `tools`, parameter schemas, metadata, and extension branches retain exact reference identity.
- Removing `instructions` affects only the capture request owner.
- Importing the script for tests performs no provider config read, provider initialization, network IO, or artifact write.

## Negative Cases

- The script must not use `JSON.parse(JSON.stringify(...))`, `structuredClone`, `deepClone`, or a full recursive copy helper for request preparation.
- The source request must not be mutated.
- The debug projection must not become provider/client payload truth, route selection truth, MetadataCenter state, provider configuration, or live runtime state.
- This slice must not change any existing field emitted by the capture CLI.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/responses-sse-capture-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `node scripts/architecture/verify-no-fallback-diff.mjs --files scripts/responses-sse-capture.mjs`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Completion Boundary

This slice proves debug-script source and behavior ownership only. It does not execute a provider request, modify provider configuration, or prove installed-runtime RSS reduction.
