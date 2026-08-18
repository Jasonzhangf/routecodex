# LLMS Engine Shadow Payload Copy Budget Test Design

## Scope

`feature_id: debug.llms_engine_shadow_payload_copy_budget` owns only the debug shadow comparator in `src/utils/llms-engine-shadow.ts` and its tracked JavaScript mirror. It does not own Hub Pipeline, provider wire, client response, routing, or shadow enablement policy.

## Lifecycle

1. The shadow caller provides baseline and candidate output objects.
2. The comparator recursively compares both objects while treating configured paths as ignored subtrees.
3. If no non-ignored difference exists, the call returns without writing an artifact or retaining either payload.
4. If a difference exists, the debug writer persists the original full baseline and candidate outputs plus bounded diff paths.
5. All comparison state releases when the call returns; no cloned comparison trees are retained.

## Positive Cases

- A difference outside an excluded path writes one artifact.
- The artifact preserves complete baseline and candidate outputs, including values at excluded compare paths.
- `diffPaths` contains only non-excluded differences.

## Negative Cases

- A difference only at an excluded path writes no artifact.
- The comparator does not mutate baseline or candidate objects, including when they contain values that cannot pass through JSON serialization.
- The TS and tracked JS surfaces contain no JSON stringify/parse comparison clone or clone helper.

## Project Boundary

- The optimization changes only internal debug comparison mechanics.
- It must not trim the persisted artifact when a real non-excluded difference exists.
- It must not move payloads into MetadataCenter or any request/response normal-payload resource.
- No provider configuration, global install, restart, or live runtime change is part of this slice.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/utils/llms-engine-shadow-payload-copy-budget.spec.ts --runInBand`
- `npx tsc --noEmit --pretty false`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts --runInBand`
- Target `git diff --check`

## Known Gap

This slice removes two debug-only full object graph clones per sampled comparison. It does not prove process RSS improvement; installed-runtime concurrent replay is required for any RSS claim.
