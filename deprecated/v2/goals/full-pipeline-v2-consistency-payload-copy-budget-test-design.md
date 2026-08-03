# Archived V2 Consistency Payload Copy Budget Test Design

> **Status**: Retired with the V2 consistency tooling under `deprecated/v2`.
> This is historical source-level evidence, not an active V3 verification gate.

## Feature

- `feature_id`: `debug.v2_consistency_payload_copy_budget`
- Owner: `deprecated/v2/consistency/comprehensive-consistency-test.mjs`
- Resource: `debug.v2_consistency_summary_projection`

## Risk

The comprehensive V2 consistency script retained one summary object but repeatedly serialized and parsed it before assignment, report persistence, and console display. Those JSON round trips created redundant debug-only object graphs and the assignment expression did not update the authoritative summary slot.

## Positive Tests

- `deprecated/v2/tests/scripts/v2-consistency-payload-copy-budget.spec.ts` proves `runAllTests` writes the generated summary into `this.testResults.summary`.
- The same test proves report/display paths borrow the authoritative summary instead of cloning it.
- The script remains parseable through `node --check`.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify`.
- Source residue rejects generic `structuredClone(` and `deepClone(` helpers.

## Verification

- `pnpm jest deprecated/v2/tests/scripts/v2-consistency-payload-copy-budget.spec.ts --runInBand`
- `node --check deprecated/v2/consistency/comprehensive-consistency-test.mjs`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- target `git diff --check`

## Boundary

This slice is debug/reporting-only. It does not modify live request/response/error truth, provider config, `config.toml`, `~/.rcc`, MetadataCenter, routing, global install, restart, or live provider replay.
