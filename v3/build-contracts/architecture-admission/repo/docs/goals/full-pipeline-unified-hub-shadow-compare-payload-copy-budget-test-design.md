# Unified Hub Shadow Compare Payload Copy Budget Test Design

## Scope

`feature_id: debug.unified_hub_shadow_compare_payload_copy_budget` owns only the debug script `scripts/unified-hub-shadow-compare.mjs`. The script runs a black-box Hub shadow comparison and writes diagnostic error samples when candidate output differs from baseline output. It does not own Hub Pipeline runtime semantics, provider wire payloads, routing policy, client response projection, MetadataCenter, or live server behavior.

## Lifecycle

1. The script loads a request sample and runs Hub once with shadow metadata.
2. The script builds two debug wrappers: baseline provider output and candidate provider output.
3. `diffPayloads` recursively compares the wrappers by borrowing their object graphs.
4. If no diff exists, no artifact is written and no debug payload is retained.
5. If a diff exists, `writeCompareErrorSample` persists the complete baseline and candidate debug wrappers plus bounded diff paths.
6. Comparison state releases when the script exits.

## Positive Cases

- Real differences still produce diff paths.
- Real differences still write complete baseline and candidate debug wrappers through the existing artifact writer.
- Console rendering still uses `stableStringify` only after a real diff is detected.

## Negative Cases

- The script must not call `JSON.parse(JSON.stringify(...))` to deep-clone complete baseline or candidate outputs before comparison.
- The script must not retain a `cloneJsonSafe` helper or any replacement whole-payload clone helper for comparison.
- The debug projection must not become provider payload, client payload, routing truth, or MetadataCenter truth.

## Project Boundary

This slice removes one debug-only comparison copy from a script. It does not change the request/response normal path, direct path, provider configuration, `config.toml`, `~/.rcc`, global install, restart, or live runtime behavior.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/unified-hub-shadow-compare-payload-copy-budget.spec.ts --runInBand`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Known Gap

This is source/Jest evidence for removing a script-level debug clone. It does not prove installed-runtime RSS improvement. RSS claims still require release/global install, aggregate restart, health version alignment, and representative large-payload replay measurement.
