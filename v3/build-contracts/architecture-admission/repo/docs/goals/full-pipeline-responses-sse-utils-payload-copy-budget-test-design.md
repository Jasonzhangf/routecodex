# Responses SSE Utils Payload Copy Budget Test Design

## Scope

`feature_id: debug.responses_sse_utils_payload_copy_budget` owns only completed-response extraction in `sharedmodule/llmswitch-core/scripts/lib/responses-sse-utils.mjs`.

## Lifecycle

The debug golden-roundtrip script loads events into a request-local array, extracts the completed Responses object, immediately sends it into the existing JSON-to-SSE encoder, and then releases both event and response references.

## Positive Cases

- A complete `response.completed` event returns the exact response object reference without mutation or a second object graph.
- Response fields, nested output, usage, metadata, and extension values remain unchanged.
- When no completed event exists, aggregation still builds the same independent synthesized response.

## Negative Cases

- Completed-response extraction must not use JSON stringify/parse, `structuredClone`, `deepClone`, or recursive copying.
- The internal aggregator must not retain an unreachable duplicate `response.completed` return path after the outer completed-event pre-scan.
- This debug projection must not become provider/client live payload truth, route truth, MetadataCenter state, or provider configuration.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/responses-sse-utils-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Completion Boundary

This slice proves debug golden-roundtrip source and behavior ownership only. It does not change runtime SSE handling or prove installed-runtime RSS reduction.
