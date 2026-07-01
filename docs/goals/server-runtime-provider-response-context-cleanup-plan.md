# Server Runtime Provider Response Context Cleanup Plan

## Target

Remove the remaining provider-response converter dependency on `adapterContext` as a control-plane truth source. `adapterContext` may remain only as the bridge input object carrying the already-bound `MetadataCenter`; it must not be used as a fallback source for `providerProtocol`, runtime control, debug snapshot, request context, or response semantics.

## Acceptance Criteria

- `src/server/runtime/http-server/executor/provider-response-converter.ts` reads provider protocol from the pipeline `MetadataCenter`/response metadata bag only.
- Missing `runtime_control.providerProtocol` fails fast from the metadata-center truth path.
- No post-bridge sync/backwrite or adapter-context fallback read is reintroduced.
- Existing response bridge behavior stays semantically unchanged for valid metadata-center input.
- Unrelated SSE, servertool, package, and build-info dirty files are not staged or changed by this slice.

## Scope

In scope:
- Provider response converter control-plane read path.
- Focused source/behavior gates for adapter-context fallback removal.
- Function/mainline/verification map updates only if the existing map cannot uniquely locate this owner.

Out of scope:
- Direct request payload cleanup.
- SSE transport semantics.
- Stopless/servertool behavior changes.
- Virtual router or provider runtime selection policy.

## Design Principles

- MetadataCenter is the only RouteCodex control-plane truth carrier.
- Request/response payload data and bridge adapter input must not become second control truth.
- Server runtime remains IO/orchestration only; no new semantic fallback or duplicated governance.
- Fail fast on missing required control truth; do not synthesize, infer, or fallback.

## Implementation Plan

1. Lock the current owner from `docs/architecture/function-map.yml` and `docs/architecture/mainline-call-map.yml`.
2. Add/extend a red source contract in `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts` forbidding:
   - `adapterContext?: Record<string, unknown>` on `readProviderProtocolForProviderResponseConverter`
   - `args.metadata ?? args.adapterContext`
   - calling provider-protocol read with `adapterContext`
3. Update `readProviderProtocolForProviderResponseConverter` to accept metadata only.
4. Remove the redundant post-build bridge provider-protocol re-read with adapter context; reuse the validated metadata-center value.
5. Keep `buildBridgeAdapterContext` only as bridge IO construction with the same bound `MetadataCenter`.
6. Run focused tests and architecture gates.
7. Update `note.md` with red/fix/verification evidence.
8. Commit only this slice.

## Verification Matrix

- Focused Jest:
  - `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.metadata-center-provider-protocol.spec.ts`
- Typecheck:
  - `npx tsc --noEmit --pretty false`
- Architecture:
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-fallback-denylist`
- Hygiene:
  - `git diff --check`
- Build:
  - `npm run build:base`

## Definition Of Done

- Red test/gate proves the adapter-context fallback existed.
- Implementation removes the fallback from the unique owner.
- Focused tests, typecheck, architecture gates, diff check, and build pass.
- Commit contains only provider-response context cleanup files plus `note.md` evidence.
