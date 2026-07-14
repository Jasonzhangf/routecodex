# Cross Protocol Matrix Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.cross_protocol_matrix_payload_copy_budget`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
- Resource: `debug.cross_protocol_matrix_chat_projection`

## Risk

The cross-protocol parity matrix canonicalizer is diagnostic-only, but it previously JSON-cloned the complete chat request and tool schemas before normalizing a few provider-specific fields. Large captured `messages`, `tools`, and schema branches were copied even when the canonicalizer only needed path-local mutation isolation.

## Positive Tests

- `tests/scripts/cross-protocol-matrix-payload-copy-budget.spec.ts` proves `canonicalizeChat` returns a separate top-level canonical owner.
- The same test proves metadata, message, and tool-call mutations do not mutate the source chat object.
- The same test proves unchanged tool parameter schemas retain exact reference identity.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify(chat || {}))`.
- Source residue rejects `JSON.parse(JSON.stringify(fn.parameters))`.
- Source residue rejects `structuredClone(` and `deepClone(` in this diagnostic canonicalizer.

## Verification

- `pnpm jest tests/scripts/cross-protocol-matrix-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `git diff --check -- sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs tests/scripts/cross-protocol-matrix-payload-copy-budget.spec.ts docs/goals/full-pipeline-cross-protocol-matrix-payload-copy-budget-test-design.md docs/design/payload-copy-hotspot-inventory.md docs/architecture/resource-operation-map.yml docs/architecture/function-map.yml docs/architecture/verification-map.yml docs/architecture/mainline-call-map.yml`

## Boundary

This slice is source/Jest evidence for a debug parity utility only. It does not modify provider config, `config.toml`, `~/.rcc`, global install state, live routing, provider runtime, MetadataCenter, or normal client/provider payload truth.
