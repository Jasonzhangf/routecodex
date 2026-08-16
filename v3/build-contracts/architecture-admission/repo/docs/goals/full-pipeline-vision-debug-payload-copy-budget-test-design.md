# Vision Debug Payload Copy Budget Test Design

## Scope

`feature_id: debug.vision_snapshot_payload_copy_budget` owns the debug-only vision snapshot projection before `writeProviderSnapshot`. It does not own provider wire semantics, snapshot stage policy, redaction, queueing, persistence, or live request/response payloads.

## Lifecycle

1. Vision debug selection validates the environment flag, route, request identity, and entry port.
2. `buildVisionSnapshotPayload` creates a small wrapper that borrows the current payload and optional extras.
3. `writeProviderSnapshot` decides whether the stage is enabled.
4. If enabled, `buildSnapshotPayload` synchronously creates the independent redacted object graph before asynchronous queueing.
5. The borrowed wrapper releases after the call; the writer-owned redacted graph releases after snapshot IO.

## Positive Cases

- The vision projection borrows the payload and extras instead of cloning them.
- The unified snapshot builder creates a distinct redacted graph synchronously.
- Mutating the caller payload after writer materialization does not change the writer-owned graph.
- Entry-port routing remains unchanged.

## Negative Cases

- Disabled snapshot stages do not pay a pre-writer payload clone.
- The vision helper contains no JSON stringify/parse clone helper.
- Circular or non-JSON values cannot trigger fallback mutation or silent payload loss at the vision projection layer.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/providers/core/runtime/vision-debug-utils.payload-copy-budget.spec.ts tests/providers/core/runtime/vision-debug-utils.snapshot-entry-port.spec.ts --runInBand`
- `npx tsc --noEmit --pretty false`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts --runInBand`
- Target `git diff --check`

## Known Gap

The unified snapshot writer still intentionally materializes one independent redacted graph and may serialize it for queue budgeting and persistence. Those copies remain owned by the separate snapshot budget; this slice removes only the redundant pre-writer clone.
