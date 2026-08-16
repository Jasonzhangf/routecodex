# Full-Pipeline Snapshot Payload Copy Budget Test Design

## Lifecycle

1. The host recorder receives a borrowed live stage payload.
2. Disabled snapshot and disabled trace-payload paths must not serialize or retain the full payload.
3. Enabled snapshot recording may materialize one diagnostic-owned payload at the current JS/Rust contract boundary.
4. Rust owns normalization, bounded queue transfer, file persistence, and diagnostic error-sample projection.
5. Queue enqueue and synchronous persistence move the diagnostic payload forward without clone-then-discard ownership.
6. The queue, writer, stage trace, and request-local recorder release all diagnostic payload ownership when their bounded lifecycle ends.

## White-Box Positive Cases

- `SnapshotHookOptions` moves into the bounded async queue without a pre-enqueue clone.
- Synchronous persistence sanitizes the stage on the owned options value rather than cloning the complete diagnostic payload.
- Snapshot JSON and payload-contract/tool-surface error-sample output remain semantically equivalent.
- Existing queue capacity, drop-on-full, request isolation, and file-retention behavior remain unchanged.
- Queue retention is bounded by both item count and estimated bytes, including provider/forced-full diagnostic payloads.
- Trace payload capture remains explicit and disabled by default.

## White-Box Negative Cases

- `SnapshotHookOptions` must not derive `Clone`.
- The queue sender must not receive `options.clone()`.
- The synchronous writer must not create `normal` from `options.clone()`.
- An individual payload larger than the queue byte budget must be dropped before queue ownership is retained.
- Disabled trace payload capture must not execute `JSON.stringify(payload)`.
- Snapshot/error-sample budgeting must not trim or mutate the live request, provider wire request, provider response, or client response.

## Module Black-Box

- Snapshot recorder host planning still emits the existing endpoint, stage, request ID, provider, protocol, port, group request, and runtime metadata fields.
- Snapshot stage contract and owner gates remain green.
- Focused Rust tests cover owned queue/write preparation and existing snapshot file/error-sample behavior.

## Project Black-Box

- Provider/client payload semantics and configuration remain unchanged.
- Snapshot resources stay diagnostic-only and cannot become request/response truth.
- Native hotpath and base builds remain green.

## Known Gap

This slice removes duplicate full diagnostic ownership inside the Rust queue and synchronous writer. The current host snapshot path still crosses the JSON N-API boundary for normalization, write-option planning, and persistence. Those crossings remain open in the hotspot inventory until a single authoritative native record operation replaces them; no RSS reduction may be claimed from source gates alone.
