# Provider Debug Hooks Payload Copy Budget Test Design

## Scope

`feature_id: provider.debug_example_hooks_payload_copy_budget` owns only debug hook observation mechanics in `src/debug/hooks` and the provider debug output formatter. It does not own provider wire payloads, client responses, routing, MetadataCenter, Hub Pipeline, or provider configuration.

## Lifecycle

1. A caller passes the current request/response/config object to `BidirectionalHookManager.executeHookChain`.
2. Hook callbacks read or transform the original current object according to the existing hook contract.
3. The debug manager computes diagnostic size metrics by bounded traversal, not by materializing a full JSON string.
4. When debug dataFlow is enabled, it records a bounded diagnostic snapshot instead of a complete deep clone.
5. Detailed debug output formats oversized data and change values with bounded previews and never serializes the full live payload only to decide or preview truncation.

## Positive Cases

- Hook callbacks still receive the original full current object.
- Debug metrics return numeric size estimates for ordinary request payloads.
- Circular and non-JSON diagnostic values do not crash debug size/snapshot handling.
- Detailed debug output can show a bounded preview for oversized payloads.

## Negative Cases

- `httpRequestMonitoringHook` must not call `JSON.stringify(request).length`.
- `BidirectionalHookManager` must not use `JSON.stringify` as the size counter for every hook.
- `BidirectionalHookManager` must not create `JSON.parse(JSON.stringify(data))` dataFlow snapshots.
- The bounded debug snapshot must not retain complete large tool arrays or original nested object references.
- Change-detail logging must not stringify an entire `newValue` subtree.

## Project Boundary

- This slice is debug-only and may budget/summarize internal observations.
- It must not trim, omit, reorder, or summarize any live client request, provider request, provider response, or client response.
- It must not move request/response data into MetadataCenter or any routing/provider truth resource.
- No provider config, `config.toml`, global install, restart, or live runtime change is part of this slice.

## Required Gates

- `npm run jest:run -- --runInBand --runTestsByPath tests/providers/core/hooks/debug-example-hooks.spec.ts`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts --runInBand`
- Target `git diff --check`

## Known Gap

This removes debug-only payload serialization and full dataFlow clones. It does not prove process RSS improvement; installed-runtime concurrent replay is still required for RSS claims.
