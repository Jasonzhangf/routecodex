# Internal Metadata Center Migration Plan

## Goal And Acceptance

Goal: migrate all remaining non-protocol internal control carriers such as `__routecodex*` out of normal request/response payloads and into `MetadataCenter` or runtime-only side channels, while preserving behavior and standard protocol semantics.

Acceptance:

- Runtime `__routecodex*` `payload_side_channel` count reaches `0`.
- Runtime `__sse_*` files remain `0`.
- Request/response/client/provider payloads do not carry internal control fields.
- `MetadataCenter.runtime_control` is the unique truth for request route control and servertool followup control.
- Provider/local runtime markers no longer use `__routecodex*` names; they become typed local fields, local symbols, WeakMaps, or explicit local state.
- Standard protocol fields stay legal. In particular, same-protocol direct `event: response.metadata` remains allowed for ordinary provider metadata, while internal control keys inside it still fail fast.
- Guard surfaces remain in place and fail if removed or if internal carriers re-enter payloads.

## Current Audit Baseline

Verified on 2026-06-18 before migration:

- `npm run audit:custom-payload-carriers` PASS.
- `npm run audit:custom-payload-carrier-owner-queryability` PASS.
- `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS.

Current counts:

| Carrier | Runtime files | Runtime hits | Current disposition |
| --- | ---: | ---: | --- |
| `__routecodex*` | 25 | 72 | initial split by category; only `payload_side_channel=10` was direct MetadataCenter migration |
| `__sse_*` | 0 | 0 | runtime clean; keep gates and clean stale tests/docs separately |
| `response.metadata` | 4 | 11 | standard protocol/guard/contract surface, not a blanket delete target |

`__routecodex*` runtime category split:

| Category | Files | Resolution |
| --- | ---: | --- |
| `payload_side_channel` | 10 | migrate to `MetadataCenter.runtime_control` / runtime side-channel |
| `guard_surface` | 5 | keep fail-fast guards during and after migration |
| `local_runtime_marker` | 6 | rename to typed local fields / Symbols / WeakMaps / local state |
| `contract_or_test_surface` | 4 | update only after runtime migration changes |

Current progress after Lane D local-marker slice on 2026-06-18:

- `audit:custom-payload-carriers` reports `__routecodex*` runtime files `9`, runtime hits `14`.
- `payload_side_channel` is down from `10` to `0`.
- Runtime `__sse_*` files remain `0`.
- Removed route-control payload-side-channel runtime hits from:
  - `src/server/runtime/http-server/index.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/tests.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
- `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` now only retains stale-field delete guard text and is classified as `guard_surface`, not payload truth.
- Removed response-followup payload-side-channel runtime hits from:
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs`
- Removed local runtime marker `__routecodex*` names from:
  - `src/providers/core/runtime/http-request-executor.ts`
  - `src/providers/core/runtime/provider-request-header-orchestrator.ts`
  - `src/providers/core/runtime/transport/oauth-header-preflight.ts`
  - `src/providers/core/utils/provider-error-reporter.ts`
  - `src/providers/core/utils/snapshot-writer-buffer.ts`
  - `src/server/runtime/http-server/daemon-admin-routes.ts`

Current category split after Lane D:

| Category | Files | Current resolution |
| --- | ---: | --- |
| `payload_side_channel` | 0 | complete; keep deleted/residue gates |
| `guard_surface` | 6 | keep as fail-fast/deleted-residue guards |
| `local_runtime_marker` | 0 | complete for `__routecodex*` markers |
| `contract_or_test_surface` | 3 | update after runtime truth is migrated |

Owner queryability after Lane D:

- `__routecodex*`: `unique-owner=8`, `ambiguous-owner=1`, `missing-owner=0`, `missing-verification=0`.
- `response.metadata`: `unique-owner=4`, `ambiguous-owner=0`, `missing-owner=0`, `missing-verification=0`.

Latest verification evidence:

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-followup-dispatch.contract.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts --runInBand` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts --runInBand` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts --runInBand` PASS.
- `cd sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi && cargo test chat_node_result_semantics --lib` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS.

## Execution Topology And Locks

This migration is a topology cleanup, not a protocol rewrite. The work must
move internal control truth from normal payload surfaces into the already
declared `MetadataCenter` / runtime side-channel topology, then lock the old
payload carriers as deleted residue.

```text
[Topo01AuditCarrierDiscovery]
  owner: scripts/architecture/audit-custom-payload-carriers.mjs
  output: current runtime carrier hits and disposition categories
  gate: npm run audit:custom-payload-carriers
  |
  v
[Topo02ManifestDispositionBudget]
  owner: docs/architecture/custom-payload-carrier-runtime-manifest.yml
  output: each hit classified as payload_side_channel / guard_surface /
          local_runtime_marker / contract_or_test_surface
  gate: npm run verify:architecture-custom-payload-carrier-runtime-manifest
  |
  v
[Topo03LaneOwnerSelection]
  owner: docs/architecture/function-map.yml + docs/architecture/verification-map.yml
  output: unique owner, allowed files, required tests, required gates
  gate: npm run audit:custom-payload-carrier-owner-queryability
  |
  v
[Topo04RuntimeTruthMigration]
  owner: lane-specific code owner
  output: payload writer/reader removed; MetadataCenter or local runtime state is truth
  gates: focused red/green tests + lane required gates
  |
  v
[Topo05DeletedResidueLock]
  owner: scripts/architecture/* containment/deleted-path gates
  output: old payload carrier cannot re-enter runtime payloads
  gates: verify:architecture-custom-payload-carrier-containment,
         verify:architecture-no-custom-payload-carriers,
         verify:architecture-ci-longtail
  |
  v
[Topo06ReviewSurfaceSync]
  owner: function map + verification map + mainline call map + wiki/manifest
  output: docs and gates point to the new truth path only
  gates: verify:function-map-compile-gate,
         verify:architecture-review-surface
```

Topology lock rules:

- `Topo01 -> Topo02` is read-only. Do not change code before the current carrier category and owner are known.
- `Topo02 -> Topo03` must preserve one owner per hit. Ambiguous owners must be fixed in map/manifest before code migration.
- `Topo03 -> Topo04` is the only implementation step. Each slice changes the smallest writer/reader pair that owns one runtime truth.
- `Topo04 -> Topo05` must be immediate for completed fields. A removed payload field without a deleted/residue gate is not complete.
- `Topo05 -> Topo06` must update review surfaces in the same change set as the runtime migration. Docs that still point to old payload truth count as drift.
- Standard protocol payload remains legal. `response.metadata` as a Responses SSE event is not an internal carrier; only internal keys inside it are illegal.

## Current Execution Cursor

The next implementation slice starts at Lane B. Lane A has already moved route
control runtime truth out of flat `metadata.__routecodex*` and into
`MetadataCenter.runtime_control` plus the Rust NAPI runtime side-channel.

```text
done:
  Lane A request route control
    metadata.__routecodexPreselectedRoute
    metadata.__routecodexRetryProviderKey
  Lane B response followup semantics
    requestSemantics.__routecodex.serverToolFollowup
    requestSemantics.__routecodex.serverToolFollowupSource
    requestSemantics.__routecodex.stoplessGoalStatus
  Lane D local runtime marker rename
    provider/runtime local markers no longer use __routecodex* names
  latest audit:
    payload_side_channel=0
    local_runtime_marker=0
    __sse_* runtime files=0

next:
  Lane C guard/deleted-residue locks
  review surface sync
  final architecture/build/live validation
```

Lane B must be executed as a three-hop source-to-sink migration:

```text
[Followup01Materializer]
  owner: server.servertool_followup_dispatch_surface
  file: src/server/runtime/http-server/executor/servertool-followup-dispatch.ts
  old output: requestSemantics.__routecodex.*
  new output: MetadataCenter.runtime_control.* or explicit runtime side-channel
  red gate: materializer must not create requestSemantics.__routecodex
  |
  v
[Followup02ResponseConverterReader]
  owner: server.provider_response_conversion_host
  file: src/server/runtime/http-server/executor/provider-response-converter.ts
  old input: options.requestSemantics.__routecodex
  new input: MetadataCenter/runtime side-channel only
  red gate: converter must not read old requestSemantics.__routecodex
  |
  v
[Followup03RustResidueContract]
  owner: hub.servertool_followup / hub.response_post_servertool_client_projection
  file: sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs
  old residue: __routecodex followup semantic naming
  new contract: typed followup semantics with no payload-side-channel name
  red gate: runtime manifest reports payload_side_channel=0
```

Lane B is complete when the runtime manifest no longer lists the three
followup files under `payload_side_channel` and the audit keeps reporting
`payload_side_channel=0`.

## Source-To-Sink Migration Topology

### Route Control Topology

```text
old payload truth:
  metadata.__routecodexPreselectedRoute
  metadata.__routecodexRetryProviderKey

new side-channel truth:
  MetadataCenter.runtime_control.preselectedRoute
  MetadataCenter.runtime_control.retryProviderKey

source writers:
  src/server/runtime/http-server/index.ts
  src/server/runtime/http-server/executor/request-executor-attempt-state.ts

bridge/readers:
  sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts
  sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs
  sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs
  sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs
  sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs

client/provider payload:
  no __routecodex*
```

Route-control order is writer first, bridge second, Rust reader third, residue
gate last. The TS bridge must never fabricate an old flat key while migrating
the Rust side.

### Servertool Followup Topology

```text
old payload-like runtime truth:
  requestSemantics.__routecodex.serverToolFollowup
  requestSemantics.__routecodex.serverToolFollowupSource
  requestSemantics.__routecodex.stoplessGoalStatus

new side-channel truth:
  MetadataCenter.runtime_control.serverToolFollowup
  MetadataCenter.runtime_control.serverToolFollowupSource
  MetadataCenter.runtime_control.stoplessGoalStatus

source writer/materializer:
  src/server/runtime/http-server/executor/servertool-followup-dispatch.ts

reader/projector:
  src/server/runtime/http-server/executor/provider-response-converter.ts
  sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs

client/provider payload:
  no requestSemantics.__routecodex
```

Followup order is materializer first, reader second, Rust residue third, guard
lock last. The provider response converter must be a pure reader of side-channel
truth; it must not reconstruct `requestSemantics.__routecodex`.

### Local Runtime Marker Topology

```text
old local marker names:
  __routecodexRequestInfo
  __routecodexAuthPreflightFatal
  __routecodexProviderErrorReported
  __routecodexProviderSnapshotErrorBuffer
  __routecodexDaemonAdminAuthRequired
  __routecodexDaemonAdminApiKeyConfigured
  __routecodexDaemonAdminLocalBypassEnabled
  __routecodexDaemonAdminExpectedApiKey

new local truth:
  typed local field, local Symbol, WeakMap, or module-local state

forbidden target:
  MetadataCenter, unless the value is request-scoped runtime control truth
  request payload
  response payload
  provider SDK options/body
```

Local markers are not route/followup control truth. They should be renamed or
made private local state, then locked by containment/residue gates.

### Guard And Protocol Topology

```text
standard protocol payload:
  response.metadata event is legal for same-protocol Responses SSE

internal control payload:
  __routecodex*
  __sse_*
  internal keys inside response.metadata

guard action:
  fail fast when internal control appears in normal payload
  do not silently delete and continue
```

Guard files stay alive during migration. After the corresponding runtime field
is removed, update the guard from allowlist classification to deleted/residue
classification rather than dropping protection.

## MetadataCenter Target Topology

Canonical manifest: `docs/architecture/metadata-center-manifest.yml`.

```text
Client / Server Entry
  |
  v
[MetaReq01InboundSeeded]
  - family: request_truth
  - slots: requestId, pipelineId, entryEndpoint, sessionId, conversationId, clientRequestId, portScope
  |
  v
[MetaReq02TruthMaterialized]
  - family: request_truth
  - write-once truth after inbound standardization
  |
  v
[MetaReq03ContinuationAttached]
  - family: continuation_context
  - slots: responsesRequestContext, responsesResume, previousResponseId, responseId, toolOutputs,
           continuationOwner, resumeFrom, chainId, stickyScope
  |
  v
[MetaReq04RuntimeControlBound]
  - family: runtime_control
  - route slots: routeHint, routeName, routeId, providerProtocol, providerFamily,
                 retryProviderKey, preselectedRoute
  - followup slots: serverToolFollowup, serverToolFollowupSource, stoplessGoalStatus
  - control slots: stopMessageEnabled, stopMessageExcludeDirect, streamIntent, clientAbort
  |
  v
[MetaReq05ProviderObservationProjected]
  - family: provider_observation
  - slots: target, providerKey, assignedModelId, modelId, clientModelId,
           compatibilityProfile, responseSemantics, finishReason
  |
  v
[MetaResp06ResponseObserved]
  - families: provider_observation, debug_snapshot
  |
  v
[MetaResp07ServertoolContextProjected]
  - family: runtime_control
  - servertool followup projection reads/writes here, not requestSemantics.__routecodex
  |
  v
[MetaResp08CloseoutReleased]
  - closeout marks all request-scoped families released
```

Payload boundary:

```text
Normal request/response payload
  - protocol fields only
  - no __routecodex*
  - no __sse_*
  - no internal response.metadata keys

MetadataCenter / runtime side-channel
  - request_truth
  - continuation_context
  - runtime_control
  - provider_observation
  - client_attachment_scope
  - debug_snapshot

Local runtime state only
  - provider error de-dup markers
  - auth preflight local fatal markers
  - daemon-admin local auth flags
  - snapshot buffering state
```

## Request Node Metadata Write Topology

Request nodes must not write metadata by default. A request-stage write is
legal only when it materializes one of the canonical `MetadataCenter` families
needed by later runtime stages. All other metadata mutation must be removed
rather than renamed.

```text
[ReqMetaWrite00NoDefault]
  rule: request node does not create, merge, backfill, patch, or scrub metadata
        unless it owns one canonical MetadataCenter family write.
  forbidden targets:
    - request payload
    - response payload
    - provider body
    - provider SDK options
    - direct passthrough body
    - SSE wrapper semantic fields
    - ad hoc payload side-channel keys
  |
  v
[ReqMetaWrite01InboundTruth]
  node: MetaReq01InboundSeeded / MetaReq02TruthMaterialized
  family: request_truth
  allowed purpose: bind requestId, pipelineId, entryEndpoint, session scope,
                   client request id, and port scope for this request only
  write policy: write-once, no semantic payload rewrite
  |
  v
[ReqMetaWrite02Continuation]
  node: MetaReq03ContinuationAttached
  family: continuation_context
  allowed purpose: bind already-validated Responses continuation scope,
                   owner, chain, tool outputs, and resume truth
  write policy: request-scoped, no ordinary chat/messages continuation pickup
  |
  v
[ReqMetaWrite03RuntimeControl]
  node: MetaReq04RuntimeControlBound
  family: runtime_control
  allowed purpose: route/retry/followup/stream/client-abort control needed by
                   runtime decisions
  canonical slots:
    routeHint, routeName, routeId, providerProtocol, providerFamily,
    retryProviderKey, preselectedRoute, serverToolFollowup,
    serverToolFollowupSource, stoplessGoalStatus, stopMessageEnabled,
    stopMessageExcludeDirect, streamIntent, clientAbort
  |
  v
[ReqMetaWrite04ProviderObservation]
  node: MetaReq05ProviderObservationProjected
  family: provider_observation
  allowed purpose: record selected target/provider/model compatibility truth
                   after route/outbound selection
  write policy: observation only, not route policy source
```

### Request Write Allowlist

| Family | Legal writer intent | Illegal lookalike |
| --- | --- | --- |
| `request_truth` | request identity and entry-scope binding | copying raw payload metadata forward |
| `continuation_context` | validated Responses continuation restore/materialize scope | normal chat/messages auto-resume or partial prefix repair |
| `runtime_control` | runtime decisions that cannot live in protocol payload | `metadata.__routecodex*`, `requestSemantics.__routecodex`, `__sse_*`, provider options flags |
| `provider_observation` | selected target/model/compatibility/finish observation | using observation to reroute or patch payload |
| `debug_snapshot` | debug/replay artifacts outside live payload | normal live-path metadata carrier |

Request-stage code must delete all non-allowlisted writes. Do not replace an
old payload-side-channel field with a new generic metadata key. If the value is
not needed by a later runtime decision, it should not be written.

### Request Write Removal Checklist

For every request-side metadata mutation, classify it before changing code:

1. Is it a protocol field from the client request?
   - Keep it in the protocol payload unchanged.
   - Do not copy it into internal metadata unless a canonical family needs it.

2. Is it required by a later runtime decision in the same request/response
   closeout?
   - Write exactly one canonical `MetadataCenter` slot.
   - Record owner, writer symbol, stage, write policy, and required gate.

3. Is it only a debug/snapshot/local marker?
   - Move it to debug snapshot or module-local typed state.
   - Do not put it in request/response/provider payload.

4. Is it stale compatibility, backfill, wrapper glue, or a duplicate of another
   truth source?
   - Physically remove it and add a deleted-residue gate.

The expected end state is not "all old fields renamed to MetadataCenter". The
expected end state is "only necessary runtime-control truth is written, and all
unnecessary request-node metadata writes are gone".

### Request Write Gates To Add Or Tighten

- A request-node metadata-write audit that fails on:
  - `metadata.__routecodex*`
  - `requestSemantics.__routecodex`
  - `__sse_*`
  - writes to `payload.metadata`, `rawBody.metadata`, provider SDK options, or
    direct passthrough body for internal control
  - new `MetadataCenter.writeRuntimeControl(...)` slots not declared in
    `docs/architecture/metadata-center-manifest.yml`
- A manifest/code-sync gate requiring every MetadataCenter write to carry a
  declared family, slot, owning feature, writer symbol, stage, write policy, and
  required verification mapping.
- A deleted-residue gate for each removed request-side writer. Reintroducing an
  old side-channel key must fail even if the value is not currently consumed.
- A review-surface gate requiring function-map, mainline-call-map, wiki, and
  manifest to describe the same request metadata nodes and canonical slots.

## Migration Lanes

### Lane A: Request Route Control

Purpose: migrate route pin and retry pin from flat `metadata.__routecodex*` into `MetadataCenter.runtime_control`.

Fields:

- `metadata.__routecodexRetryProviderKey`
- `metadata.__routecodexPreselectedRoute`

Target slots:

- `runtime_control.retryProviderKey`
- `runtime_control.preselectedRoute`

Execution order:

1. `hub.metadata_center_attempt_merge`
   - File: `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
   - Role: narrow writer for retry provider pin.
   - Change: write `retryProviderKey` to `MetadataCenter.writeRuntimeControl(...)`; stop writing flat `metadataForAttempt.__routecodexRetryProviderKey`.

2. `server.http_runtime_entry`
   - File: `src/server/runtime/http-server/index.ts`
   - Role: entry writer + router-direct relay bridge.
   - Change: write `preselectedRoute` and `retryProviderKey` to attached MetadataCenter runtime control; stop adding flat `__routecodex*` to relay metadata.

3. `hub.request_stage_pipeline_bridge`
   - File: `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
   - Role: TS -> Rust bridge copier.
   - Change: stop copying `normalized.metadata.__routecodexPreselectedRoute`; project only typed runtime-control truth to Rust ingress.

4. Rust route readers/carriers
   - Files:
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
   - Change: read typed runtime-control route pins, not flat `metadata.__routecodex*`.

Ordering constraint: Rust readers must not be migrated before TS writers can supply the new side-channel truth.

### Lane B: Response Followup Semantics

Purpose: migrate servertool/stopless followup control out of `requestSemantics.__routecodex`.

Fields:

- `requestSemantics.__routecodex.serverToolFollowup`
- `requestSemantics.__routecodex.serverToolFollowupSource`
- `requestSemantics.__routecodex.stoplessGoalStatus`

Target slots:

- `runtime_control.serverToolFollowup`
- `runtime_control.serverToolFollowupSource`
- `runtime_control.stoplessGoalStatus`

Execution order:

1. `server.servertool_followup_dispatch_surface`
   - File: `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
   - Role: materializer / mutating reader.
   - Change: `materializeFollowupRequestSemantics(...)` must no longer create or update `requestSemantics.__routecodex`; it must use MetadataCenter runtime control or explicit runtime side-channel.

2. `server.provider_response_conversion_host`
   - File: `src/server/runtime/http-server/executor/provider-response-converter.ts`
   - Role: pure reader.
   - Change: stop reading `options.requestSemantics?.__routecodex`; consume MetadataCenter/runtime side-channel only.

3. Rust followup residues
   - File: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs`
   - Change only after TS followup materializer/reader has stopped emitting/reading old semantics.

Ordering constraint: the pure reader must not be changed before the materializer stops rebuilding the old field.

### Lane C: Guard Surfaces

Purpose: keep fail-fast protections while migration removes payload truth.

Guard files:

- `src/server/handlers/handler-response-common.ts`
- `src/server/handlers/handler-utils.ts`
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `src/server/runtime/http-server/executor-metadata.ts`
- `src/server/runtime/http-server/executor/servertool-followup-metadata.ts`

Rules:

- Do not delete guards just because the fields are being migrated.
- After migration, update guards from allowlisted current tokens to deleted/residue gates.
- `response.metadata` remains standard protocol semantics; guards must reject internal keys inside it, not reject the event itself.

### Lane D: Local Runtime Markers

Purpose: remove `__routecodex*` names from local-only runtime state without routing them through payloads.

Markers:

- `__routecodexRequestInfo`
- `__routecodexAuthPreflightFatal`
- `__routecodexProviderErrorReported`
- `__routecodexProviderSnapshotErrorBuffer`
- `__routecodexDaemonAdminAuthRequired`
- `__routecodexDaemonAdminApiKeyConfigured`
- `__routecodexDaemonAdminLocalBypassEnabled`
- `__routecodexDaemonAdminExpectedApiKey`

Files:

- `src/providers/core/runtime/http-request-executor.ts`
- `src/providers/core/runtime/provider-request-header-orchestrator.ts`
- `src/providers/core/runtime/transport/oauth-header-preflight.ts`
- `src/providers/core/utils/provider-error-reporter.ts`
- `src/providers/core/utils/snapshot-writer-buffer.ts`
- `src/server/runtime/http-server/daemon-admin-routes.ts`

Resolution:

- Use typed local fields, local Symbols, WeakMaps, or module-local state.
- Do not put these markers in MetadataCenter unless they are request-scoped runtime control truth.
- Do not expose them to client/provider payloads.

## File Checklist

### P0 request-route writers

| File | Role | Target |
| --- | --- | --- |
| `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` | retry pin writer | `MetadataCenter.runtime_control.retryProviderKey` |
| `src/server/runtime/http-server/index.ts` | route/retry writer + relay bridge | `MetadataCenter.runtime_control.preselectedRoute/retryProviderKey` |

### P0 response-followup writers/readers

| File | Role | Target |
| --- | --- | --- |
| `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` | followup materializer | `MetadataCenter.runtime_control.serverToolFollowup/serverToolFollowupSource/stoplessGoalStatus` |
| `src/server/runtime/http-server/executor/provider-response-converter.ts` | followup reader | read runtime-control truth only |

### P1 TS/Rust bridges

| File | Role | Target |
| --- | --- | --- |
| `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` | TS -> Rust route bridge | no flat `__routecodexPreselectedRoute` copy |
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs` | Rust route metadata ingress | typed route control |
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs` | Rust request-stage reader | typed preselected route |
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs` | typed carrier | typed retry pin |
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs` | VR retry pin reader | typed retry pin |
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs` | Rust followup residue | typed followup runtime control |

## Verification Matrix

Run after every slice:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-containment
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min
git diff --check
```

Request-route focused tests:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/http-server/executor-metadata.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/index.request-truth-contract.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand
```

Response-followup focused tests:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-followup-model-pin-regression.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/responses-handler.stop-followup-metadata.blackbox.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts --runInBand
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts --runInBand
```

Local marker focused gates:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:error-pipeline-contract
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/providers/core/utils/provider-error-reporter.spec.ts --runInBand
```

Full architecture closeout:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface
```

Runtime smoke is required for any slice that changes server entry, direct/retry routing, response followup dispatch, or provider-response conversion.

## Red Tests And Gates To Add

Before or with the first implementation slice:

- Add a red test proving `request-executor-attempt-state` no longer writes flat `__routecodexRetryProviderKey`.
- Add a red test proving `http-server/index.ts` no longer writes flat `__routecodexPreselectedRoute`.
- Add a red test proving `servertool-followup-dispatch.ts` no longer materializes `requestSemantics.__routecodex`.
- Add a runtime manifest gate requiring `payload_side_channel` count to monotonically decrease or match an explicitly updated migration budget.
- Add deleted-content gates for each removed runtime field once its lane is complete.

Do not add a blanket `rg "__routecodex"` zero gate until guard surfaces, local marker renames, and contract/deleted-path tests have been intentionally migrated.

## Drift-Lock Gate Plan

These gates are the process locks that prevent the cleanup from drifting back
into payload-side-channel behavior:

1. Runtime manifest budget lock
   - Source: `docs/architecture/custom-payload-carrier-runtime-manifest.yml`
   - Rule: `payload_side_channel` may only decrease. Any increase requires a
     new dated migration entry and an explicit owner/test mapping.
   - Gate: `npm run verify:architecture-custom-payload-carrier-runtime-manifest`.

2. Deleted field residue lock
   - Source: deleted-path / containment scripts.
   - Rule: once a runtime field is migrated, the old field name moves from
     migration budget to deleted residue. Runtime writers/readers must fail the
     gate if they recreate it.
   - Required old fields after Lane B:
     - `requestSemantics.__routecodex`
     - `serverToolFollowup` under `__routecodex`
     - `serverToolFollowupSource` under `__routecodex`
     - `stoplessGoalStatus` under `__routecodex`

3. Payload boundary lock
   - Rule: client payload, provider payload, SDK options, direct passthrough
     body, and SSE wrapper frames can contain only protocol-standard fields.
   - Gate: `npm run verify:architecture-custom-payload-carrier-containment`.
   - Explicit exception: `event: response.metadata` is a protocol event, not an
     internal carrier. Internal keys inside the event still fail.

4. Owner queryability lock
   - Rule: every remaining internal carrier reference must have one owner,
     allowed path, forbidden path, and verification mapping.
   - Gate: `npm run audit:custom-payload-carrier-owner-queryability`.
   - Lane B cannot be closed while `chat_node_result_semantics.rs` remains
     ambiguous for the migrated followup carrier.

5. Review-surface lock
   - Source: `function-map.yml`, `verification-map.yml`,
     `mainline-call-map.yml`, wiki markdown/html, topology manifests.
   - Rule: review surfaces must point to `MetadataCenter.runtime_control` or
     local runtime state, never old payload-side-channel fields.
   - Gates:
     - `npm run verify:function-map-compile-gate`
     - `npm run verify:architecture-mainline-call-map`
     - `npm run verify:architecture-review-surface`

6. SSE wrapper lock
   - Rule: SSE code can parse/emit standard SSE protocol only. It cannot attach
     custom semantic fields or parse RouteCodex internal carriers.
   - Gate: `npm run audit:custom-payload-carriers` must keep
     `__sse_* runtime files=0`.

Closeout is not valid until all six locks are green and the final audit shows
`payload_side_channel=0`.

## Risks And Controls

| Risk | Control |
| --- | --- |
| retry provider pin breaks after migration | migrate narrow attempt writer first; run direct/retry route tests and live health |
| preselected route relay loses target | migrate entry writer before TS/Rust bridge; keep focused preselected-route tests |
| followup dispatch stops recognizing stopless/servertool state | migrate materializer before reader; run followup model-pin and blackbox tests |
| legal `response.metadata` event gets blocked | keep direct SSE metadata guard tests green |
| guard removal hides leakage | do not remove guard surfaces; convert them into deleted/residue gates only after runtime fields are gone |
| local provider markers leak or break error policy | rename local markers with focused error/provider/snapshot tests |

## Completion Definition

- `audit:custom-payload-carriers` reports `__routecodex* payload_side_channel=0`.
- `audit:custom-payload-carrier-owner-queryability` reports no missing owner and no missing verification.
- `verify:architecture-custom-payload-carrier-runtime-manifest` has no stale entries for removed payload side-channel files.
- `verify:architecture-ci`, `verify:architecture-ci-longtail`, `verify:function-map-compile-gate`, and `build:min` pass.
- Focused request-route, response-followup, local-marker, and client response metadata guard tests pass.
- At least one live/runtime smoke validates changed server entry or followup behavior if those paths were touched.
- `note.md` and `MEMORY.md` record final verified counts, commands, and remaining intentional guard/contract tokens.
