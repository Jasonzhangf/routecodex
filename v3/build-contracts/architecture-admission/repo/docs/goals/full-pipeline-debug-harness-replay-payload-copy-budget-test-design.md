# Debug Harness Replay Payload Copy Budget Test Design

## Scope

`feature_id: debug.harness_replay_payload_copy_budget` owns the M6 provider harness replay execution copy in `src/debug/harness/provider.ts`. It is a child slice of `debug.unified_surface`; it does not own provider wire payloads, live client/provider request semantics, routing, MetadataCenter, Hub Pipeline, provider configuration, or snapshot persistence.

## Lifecycle

1. `ReplayRunner` loads a captured debug snapshot and passes its request payload to `ProviderPreprocessHarness`.
2. The harness creates exactly one independent execution copy before attaching non-enumerable provider runtime metadata.
3. Provider `createContext`, `preprocessRequest`, or `postprocessResponse` may mutate the execution copy.
4. The captured replay input remains unchanged and reusable for inspection or another replay.
5. The execution copy and attached runtime metadata release when the harness result and provider call release them.

## Positive Cases

- Provider preprocess receives the complete request semantics, including nested values and circular identity supported by `structuredClone`.
- Provider preprocess may mutate the execution copy and return the mutation.
- Runtime metadata is attached to the execution copy and remains available to provider context/output handling.
- The harness creates one independent execution graph before provider mutation.

## Negative Cases

- Provider mutation must not change the captured replay input or its nested objects.
- Runtime metadata must not be attached to the captured replay input.
- The harness must not use `JSON.parse(JSON.stringify(...))` or another compatibility fallback that changes BigInt, circular, undefined, or typed-value semantics.
- The necessary replay isolation copy must not be removed until the harness input type provides a verifiable unique-ownership transfer contract.
- This debug-only copy must not be reused as live provider/client payload truth or stored in MetadataCenter.

## Project Boundary

- Node.js `>=20 <26` is the runtime contract, so `structuredClone` is the single explicit clone mechanism.
- File snapshot fetch currently returns newly parsed objects, but `ExecutionHarness.executeForward` is a public surface and `SnapshotStore` does not promise unique ownership. The harness therefore cannot assume ownership transfer from every caller.
- No provider config, `config.toml`, `~/.rcc`, global install, restart, or live runtime mutation is part of this slice.

## Required Gates

- `npm run jest:run -- --runInBand --runTestsByPath tests/debug/harness-provider-payload-copy-budget.spec.ts`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:debug-unified-surface`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts --runInBand`
- Target `git diff --check`

## Known Gap

This classifies and locks one necessary debug replay isolation copy. It does not reduce normal request/response pipeline residency and does not prove process RSS improvement.
