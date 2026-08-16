# Internal Error Numbering Debug System Plan

## 1. Goal And Acceptance Criteria

Goal: introduce a repo-wide internal debug error numbering system that assigns stable internal `500-*` codes by pipeline module and sub-step, while keeping external/upstream/client-visible errors outside the internal error envelope.

Acceptance criteria:

- A new top-level mainline source exists for internal debug error numbering, with machine-readable manifest, function-map entry, verification-map entry, and wiki review surface.
- Every internal runtime failure that is owned by RouteCodex can be represented as an internal debug error code without changing client-visible external error semantics.
- Request-chain internal failures start at `500-1xx`.
- Response-chain internal failures start at `500-2xx`.
- Other RouteCodex internal modules start at `500-3xx`.
- Each pipeline module owns exactly one primary module number block; sub-errors inside that module use sub-numbers.
- External/upstream errors are not wrapped as internal errors. They may be linked by correlation fields but must preserve upstream semantic identity.
- The system is extensible by registry entry plus tests, not by ad hoc string constants at call sites.
- Static gates reject duplicate code ownership, invalid number ranges, internal envelope leakage into provider wire/client normal payload, and external-error wrapping.

## 2. Scope And Boundaries

In scope:

- Internal debug error code registry.
- Internal error envelope used for debug artifacts, logs, snapshots, policy observation, and internal diagnostics.
- Mainline source for internal debug error code assignment and projection to debug surfaces.
- Gate scripts and focused tests proving range ownership and internal/external separation.
- Minimal integration with existing `debug.unified_surface` and `error.mainline`.

Out of scope:

- Replacing `ErrorErr01-06` provider/runtime error policy chain.
- Changing provider failover/reroute behavior.
- Changing `ErrorErr06ClientProjected` public HTTP/SSE response semantics.
- Mapping provider/upstream HTTP status into internal `500-*` codes.
- Creating fallback or recovery paths from debug artifacts.

Hard boundary:

- Internal error code means "RouteCodex-owned failure classification for debugging".
- External error means "upstream/provider/client-originated error identity". It stays external and must not be wrapped as internal success/failure truth.

## 3. Design Principles

1. Internal codes are side-channel/debug truth, not client protocol truth.
2. External errors are linked, not wrapped.
3. Code ownership is registry-owned and gate-checked.
4. Module blocks are stable contracts. Published numbers cannot be reused or silently redefined.
5. Pipeline phase boundaries remain aligned with existing topology:
   - request: `ServerReqInbound01ClientRaw -> HubReqInbound02Standardized -> HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload -> ProviderReqOutbound07TransportRequest`
   - response: `ProviderRespInbound01Raw -> HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`
   - error policy: existing `ErrorErr01-06` chain remains policy truth.
6. Debug surfaces can consume runtime failures read-only but must not own runtime policy.

## 4. Top-Level Mainline Source

Add a new lifecycle:

```yaml
lifecycle_id: internal_error_numbering.mainline
owner_feature_id: debug.internal_error_numbering
owner_module: src/debug/internal-error
entrypoint:
  node_id: IntErrNum01SourceObserved
  wiki_page: docs/architecture/wiki/internal-error-numbering-mainline-source.md
  call_map_chain_id: internal_error_numbering.mainline
node_ids:
  - IntErrNum01SourceObserved
  - IntErrNum02ModuleBlockResolved
  - IntErrNum03SubcodeAssigned
  - IntErrNum04EnvelopeBuilt
  - IntErrNum05DebugArtifactProjected
  - IntErrNum06ExternalLinked
  - IntErrNum07ClientBoundaryPreserved
```

Mainline semantics:

```text
IntErrNum01SourceObserved
  -> IntErrNum02ModuleBlockResolved
  -> IntErrNum03SubcodeAssigned
  -> IntErrNum04EnvelopeBuilt
  -> IntErrNum05DebugArtifactProjected
  -> IntErrNum06ExternalLinked
  -> IntErrNum07ClientBoundaryPreserved
```

Node responsibilities:

| node | owner | responsibility | forbidden |
| --- | --- | --- | --- |
| `IntErrNum01SourceObserved` | source module caller | pass internal failure origin, stage, owner feature, and optional external link | classify external error as internal |
| `IntErrNum02ModuleBlockResolved` | registry | resolve module primary block from registry | infer block from message/string path |
| `IntErrNum03SubcodeAssigned` | registry | validate subcode belongs to module block and published meaning | allocate dynamic code at runtime |
| `IntErrNum04EnvelopeBuilt` | envelope builder | build internal debug envelope | write provider/client normal payload |
| `IntErrNum05DebugArtifactProjected` | debug surface | write diag/snapshot/log/policy observation | affect retry/reroute/fallback |
| `IntErrNum06ExternalLinked` | linker | attach external error reference when present | wrap upstream error as internal error |
| `IntErrNum07ClientBoundaryPreserved` | boundary guard | prove public projection stayed in `ErrorErr06` or original upstream semantics | expose internal code as client normal payload by default |

Add artifacts:

- `docs/architecture/wiki/internal-error-numbering-mainline-source.md`
- `docs/architecture/mainline-manifests/internal-error-numbering.mainline.yml`
- `docs/architecture/wiki/html/internal-error-numbering-mainline-source.html`
- `docs/architecture/function-map.yml` feature `debug.internal_error_numbering`
- `docs/architecture/verification-map.yml` feature `debug.internal_error_numbering`
- `docs/architecture/mainline-call-map.yml` chain `internal_error_numbering.mainline`
- `docs/architecture/mainline-binding-budget.yml` budget for the new chain

## 5. Numbering Contract

Internal code string format:

```text
500-<moduleBlock><subcode>
```

Where:

- `500` means RouteCodex internal debug error family.
- `1xx` means request pipeline.
- `2xx` means response pipeline.
- `3xx` means other RouteCodex internal modules.
- The first digit after the dash is the lane.
- The last two digits are module/sub-step allocation inside the lane.

Published range:

| range | lane | owner category |
| --- | --- | --- |
| `500-100` to `500-199` | request | request pipeline internal failures |
| `500-200` to `500-299` | response | response pipeline internal failures |
| `500-300` to `500-399` | other | server/runtime/config/debug/snapshot/CLI/internal modules |

Initial module block allocation:

| code block | pipeline node / module | owner feature |
| --- | --- | --- |
| `500-10x` | `ServerReqInbound01ClientRaw` / server request adapter | `server.responses_request_handler_bridge_surface` or current request handler owner |
| `500-11x` | `HubReqInbound02Standardized` | `hub.req_inbound_responses_context_capture` |
| `500-12x` | `HubReqChatProcess03Governed` | `hub.req_chatprocess_governance` |
| `500-13x` | `VrRoute04SelectedTarget` | `vr.route_selection` / `vr.provider_forwarder_runtime` |
| `500-14x` | `HubReqOutbound05ProviderSemantic` | `hub.req_outbound_provider_semantic` |
| `500-15x` | `ProviderReqOutbound06WirePayload` | provider runtime/outbound codec owner |
| `500-16x` | `ProviderReqOutbound07TransportRequest` host-side transport invocation | provider runtime/transport caller owner |
| `500-20x` | `ProviderRespInbound01Raw` | provider runtime/inbound transport owner |
| `500-21x` | `HubRespInbound02Parsed` | response inbound parser/materializer owner |
| `500-22x` | `HubRespChatProcess03Governed` | `hub.servertool_followup` / response chat-process owner |
| `500-23x` | `HubRespOutbound04ClientSemantic` | response outbound projection owner |
| `500-24x` | `ServerRespOutbound05ClientFrame` | server response handler/SSE bridge owner |
| `500-30x` | `debug.unified_surface` and internal debug artifact projection | `debug.unified_surface` |
| `500-31x` | metadata center internal boundary violations | `hub.metadata_center_mainline` |
| `500-32x` | runtime lifecycle internal failures | `runtime.lifecycle.*` |
| `500-33x` | config/schema/load internal failures | config owner features |
| `500-34x` | servertool internal execution/orchestration failures | servertool owner features |
| `500-35x` | architecture/gate/runtime policy violations | gate/policy observation owner |

Rules:

- Each module gets one primary `500-<lane><module>` block.
- Subcodes must be explicitly registered before use.
- `500-199`, `500-299`, and `500-399` are reserved for lane-level unknown internal errors only in tests; production callers must not use them unless registry explicitly marks them as `reserved_terminal`.
- No code may be allocated from provider/upstream HTTP status.
- No code may be generated from message text.
- Codes are stable. Rename description, not code. If semantics change materially, allocate a new subcode and retire the old one.

## 6. Internal Envelope

Canonical type:

```typescript
type InternalDebugErrorCode = `500-${number}`;

interface InternalDebugErrorEnvelope {
  internalCode: InternalDebugErrorCode;
  moduleBlock: string;
  lane: 'request' | 'response' | 'other';
  nodeId: string;
  ownerFeatureId: string;
  stage: string;
  message: string;
  severity: 'error' | 'fatal' | 'policy_violation';
  requestId?: string;
  pipelineId?: string;
  port?: number;
  traceId?: string;
  externalLink?: ExternalErrorLink;
  details?: Record<string, unknown>;
}

interface ExternalErrorLink {
  kind: 'provider' | 'upstream' | 'client' | 'transport';
  status?: number;
  code?: string;
  providerKey?: string;
  upstreamRequestId?: string;
  message?: string;
}
```

Envelope rules:

- `internalCode` is required only for internal errors.
- `externalLink` is optional and only records relation to an external error.
- `externalLink` must not be converted into `internalCode`.
- `InternalDebugErrorEnvelope` must not be emitted in provider wire payload.
- `InternalDebugErrorEnvelope` must not be emitted in client normal response body by default.
- Public debug/admin endpoints may expose the envelope only under explicit debug routes.

## 7. External Error Separation

External errors include:

- provider HTTP status/error body,
- upstream SSE/JSON error event,
- client disconnect,
- malformed client request,
- provider quota/auth/account errors,
- transport errors whose source is outside RouteCodex.

Separation rules:

- Existing `ErrorErr01-06` chain remains responsible for policy and client projection.
- `mapErrorToHttp` must not wrap external errors into `500-*`.
- Provider/runtime errors may link to internal envelope only when RouteCodex itself fails while handling them, e.g. parser bug, invariant violation, bad internal state, debug writer failure.
- A provider `401/403/429/5xx` remains provider/upstream identity. It can be associated with `externalLink`, not converted into `500-15x`.
- Client-visible error payload may include internal debug code only if an explicit debug mode/admin endpoint is used and a leak gate permits it. Default client path must not leak internal code.

## 8. Extension Model

Adding a new internal error code requires:

1. Add registry entry in the single source registry.
2. Reference existing `nodeId` from topology/mainline.
3. Bind `ownerFeatureId` to function-map.
4. Add focused positive test proving valid envelope build.
5. Add focused reverse test proving invalid range/duplicate owner fails.
6. Add leak test if the module touches provider wire or client response.
7. Regenerate/render wiki/manifest if mainline or module block changes.

Registry entry shape:

```typescript
interface InternalErrorCodeRegistryEntry {
  code: InternalDebugErrorCode;
  lane: 'request' | 'response' | 'other';
  nodeId: string;
  ownerFeatureId: string;
  moduleBlock: string;
  title: string;
  description: string;
  severity: 'error' | 'fatal' | 'policy_violation';
  allowedSourceFiles: string[];
  externalLinkPolicy: 'none' | 'optional' | 'required';
  clientExposure: 'never' | 'debug_endpoint_only';
  status: 'active' | 'reserved' | 'retired';
}
```

Required extension gates:

- code format matches range,
- lane matches range,
- node exists in topology/mainline docs,
- owner feature exists in function-map and verification-map,
- duplicate code forbidden,
- duplicate active `(nodeId, title)` forbidden,
- active source path must be inside allowed owner paths,
- retired code cannot be reused.

## 9. Implementation Files

New source:

```text
src/debug/internal-error/
  index.ts
  registry.ts
  envelope.ts
  external-link.ts
  projection.ts
  guards.ts
```

Expected exports:

- `createInternalDebugErrorRegistry`
- `resolveInternalDebugErrorCode`
- `buildInternalDebugErrorEnvelope`
- `linkExternalError`
- `assertInternalDebugErrorDoesNotLeakToClient`
- `assertInternalDebugErrorDoesNotLeakToProvider`

Docs and architecture:

```text
docs/architecture/wiki/internal-error-numbering-mainline-source.md
docs/architecture/mainline-manifests/internal-error-numbering.mainline.yml
docs/goals/internal-error-numbering-debug-system-plan.md
```

Scripts:

```text
scripts/architecture/verify-internal-error-numbering.mjs
scripts/architecture/render-architecture-wiki-pages.mjs
```

Tests:

```text
tests/debug/internal-error-numbering.registry.spec.ts
tests/debug/internal-error-numbering.envelope.spec.ts
tests/debug/internal-error-numbering.external-boundary.spec.ts
tests/debug/internal-error-numbering.leak-gate.spec.ts
tests/architecture/internal-error-numbering-mainline.spec.ts
```

Existing files to update:

```text
docs/architecture/function-map.yml
docs/architecture/verification-map.yml
docs/architecture/mainline-call-map.yml
docs/architecture/mainline-binding-budget.yml
docs/architecture/wiki/coverage-matrix.md
docs/architecture/README.md
package.json
src/debug/index.ts
src/debug/diag/error-artifact.ts
src/server/utils/http-error-mapper.ts
tests/server/utils/http-error-mapper-public-leak.spec.ts
```

## 10. Integration Plan

Phase A: Contract first.

- Add `debug.internal_error_numbering` to function-map.
- Add verification-map entry.
- Add mainline call-map chain.
- Add mainline manifest.
- Add wiki source and render HTML.
- Add binding budget.
- Add gate script skeleton that fails on missing registry/gates.

Phase B: Registry and envelope.

- Add `src/debug/internal-error/registry.ts`.
- Add request/response/other initial registry blocks.
- Add envelope builder.
- Add external link type and helper.
- Export through `src/debug/index.ts`.

Phase C: Debug artifact integration.

- Extend `DebugErrorDiagArtifactRecord` with optional `internalError?: InternalDebugErrorEnvelope` and optional `externalError?: ExternalErrorLink`.
- Keep legacy fields `message/code/status/statusCode/details/stack` for compatibility.
- Add tests proving external provider error is recorded as `externalError`, not `internalError`.

Phase D: Boundary guards.

- Add provider/client leak guard helpers.
- Add static gate scanning normal provider/client projection files for `internalCode` leakage.
- Extend public leak tests.

Phase E: Minimal runtime adoption.

- Add one internal request-path call site, one response-path call site, and one debug/other call site as proof slices.
- Use real internal invariant violations only, not provider/upstream errors.
- Add paired positive and reverse tests for each slice.

Phase F: Closeout.

- Run focused tests and architecture gates.
- Update `note.md`.
- Promote only verified stable conclusions to `MEMORY.md`.
- If a reusable debugging rule emerges, update `.agents/skills/rcc-dev-skills` lessons.

## 11. Risk And Mitigation

Risk: internal codes leak to normal client payload.

- Mitigation: `clientExposure: never` default plus leak gate.

Risk: provider HTTP status gets reclassified as internal code.

- Mitigation: external boundary tests for `401/403/429/5xx` and client disconnect.

Risk: duplicate policy center emerges.

- Mitigation: design states internal numbering is debug-only; `ErrorErr01-06` remains policy truth.

Risk: registry becomes documentation-only.

- Mitigation: only exported builder can construct internal envelope; tests reject ad hoc `500-*` strings in active code outside registry/tests/docs.

Risk: code ranges become too small.

- Mitigation: allocate one decimal module block per current pipeline node; if exhausted, append a new registry version and document migration. Do not use `500-10a` or `500-10.1`.

## 12. Test Plan

Positive tests:

- Registry accepts every initial active code.
- Envelope builder creates request `500-1xx`, response `500-2xx`, and other `500-3xx`.
- Debug diag artifact can store internal envelope and external link separately.
- Mainline manifest and wiki node IDs match call-map.

Reverse tests:

- Duplicate code fails.
- Wrong lane/range pair fails.
- Unknown owner feature fails.
- External provider `401/403/429/5xx` cannot be converted to internal envelope.
- Client disconnect cannot be projected as internal `500-*`.
- Internal envelope cannot appear in provider wire payload.
- Internal envelope cannot appear in default client response body.
- Ad hoc `500-*` strings outside registry/tests/docs fail the gate.

Required gates:

- `npm run verify:internal-error-numbering`
- `npm run verify:debug-unified-surface`
- `npm run verify:error-pipeline-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-mainline-node-id-consistency`
- focused Jest tests under `tests/debug/internal-error-numbering*.spec.ts`
- `git diff --check`

Live validation:

- Replay or issue one real request that triggers a RouteCodex-owned internal invariant/debug error if a safe sample exists.
- Replay one external provider error sample and prove it remains external-linked, not internal-wrapped.
- If safe live samples are unavailable, state the missing live gap and do not claim live closeout.

## 13. Definition Of Done

- `internal_error_numbering.mainline` is queryable in wiki, manifest, call-map, function-map, and verification-map.
- `src/debug/internal-error` is the only source owner for internal debug error code registry and envelope construction.
- Internal request/response/other codes follow `500-1xx/2xx/3xx`.
- External/upstream/client errors are not wrapped as internal errors.
- Provider wire payload and normal client response payload do not leak internal envelopes.
- Gates and focused tests pass.
- `note.md` records the verified result and remaining risks.
