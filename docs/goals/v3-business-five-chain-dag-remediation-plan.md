# V3 Business Five-Chain DAG Remediation Plan

Status: approved_design / plan_landed / p1_binding_candidate

Date: 2026-09-18

Baseline:

- Worktree: `/Users/fanzhang/Documents/github/routecodex/playground/main-live-0917`
- Branch: `main`
- HEAD: `ba3a144d0`
- Approved audit artifact: `docs/architecture/dags/v3-business-five-chain-dag-audit.html`
- Approved audit artifact SHA-256:
  `5edba1db9d1fc701fd0e997f70ea29545cd678f386315c1168054ab2efcfb4c9`

Execution boundary:

- This document is an execution contract for a later runtime change.
- It does not authorize a Runtime edit, commit, merge, install, restart, or
  production cutover by itself.
- Runtime work must use a fresh clean worktree from the latest `origin/main`
  and the project `rcc-dev-skills` workflow.
- The approved HTML is the design reference, not proof that the target runtime
  exists.

## 1. Goal

Complete the RouteCodex V3 business flow audit from the approved five-chain
model into a minimal, verifiable, traceable closed loop:

1. Request/response main chain
2. Error chain
3. Hook chain
4. Direct/Relay main chain
5. SSE processing chain

The required structural change is narrow:

- Keep the fixed Hub v1 skeleton.
- Bind existing business edges before adding anything.
- Replace the WebSearch request-local re-enter execution with a typed
  Hook -> Subagent -> typed result path.
- Bind the typed SSE tree to the existing single semantic exit.
- Make every requirement path reach a legal terminal node with auditable
  evidence.

The plan must not rewrite working Runtime behavior merely to satisfy the DAG
model. The migration order is fixed:

```text
binding -> verification -> evidence -> edge -> necessary node -> architecture
```

## 2. Scope

In scope:

- WebSearch request/response hook ownership.
- WebSearch subagent execution ownership and typed result contract.
- Removal of the request-local WebSearch re-enter path after parity.
- SSE typed-tree to `V3HubRespOutbound05ClientSemantic` binding.
- Error, Direct, Relay, JSON, and SSE terminal acceptance evidence.
- Architecture maps, manifests, wiki/review surfaces, and red fixtures needed
  to bind the above.

Out of scope:

- A second Virtual Router.
- A second response exit.
- Provider raw response to client.
- SSE semantic ownership.
- A new lifecycle or state machine for WebSearch.
- Continuation as a fixed main-chain node.
- V2 runtime, V2 config, V2 migration, or V2 fallback.
- P6 deletion, global install, restart, or production cutover without separate
  authorization.
- Broad Runtime refactoring or unrelated dead-code cleanup.

## 3. Frozen As-Is Facts

These facts are the baseline for the plan. They must be rechecked before each
runtime phase and treated as blockers if they no longer match.

### 3.1 Fixed Hub nodes

The fixed Hub v1 enum contains 15 nodes:

```text
V3HubReqInbound01ClientRaw
V3HubReqInbound02Normalized
V3HubReqChatProcess04Governed
V3HubReqExecution05Planned
V3HubReqTarget06Resolved
V3HubReqOutbound07ProviderSemantic
ProviderReqCompat06ProviderCompat
V3ProviderReqOutbound08WirePayload
V3ProviderReqOutbound09TransportRequest
V3ProviderRespInbound01Raw
ProviderRespCompat02ProviderCompat
V3HubRespInbound02Normalized
V3HubRespChatProcess03Governed
V3HubRespOutbound05ClientSemantic
V3ServerRespOutbound06ClientFrame
```

Current Runtime rejects a non-null `previous_response_id`. Continuation
`ReqContinuation03` and `RespContinuation04` are retired historical/control
evidence, not fixed As-Is nodes.

### 3.2 Current business chains

Request/response:

```text
Client
  -> Server03
  -> Req01 -> Req02 -> Req04 -> Req05 -> Req06
  -> Req07 -> Compat06 -> Req08 -> Req09
  -> Provider transport
  -> Resp01 -> Compat02 -> Resp02 -> Resp03
  -> Resp05 -> Server06
  -> Client terminal
```

Error:

```text
typed source failure
  -> Error01 -> Error02 -> Error03 -> Error04 -> Error05
  -> Error06 -> Resp05 -> Server06
```

Provider health mutation belongs to the Provider owner. Error plans retry,
reselect, or terminate; it does not own payload rewrite or SSE semantics.

Hook:

```text
Config manifest
  -> static Hub hook registry
  -> typed hook result / failure
  -> return to the same Hub node
```

Direct and Relay:

```text
same fixed Hub skeleton
  -> execution mode selects payload-rewrite ownership
  -> shared Resp05 semantic projection
  -> single Server06 frame exit
```

SSE:

```text
transport raw chunk
  -> decoded frame
  -> validated frame stream
  -> typed protocol tree / semantic projection
  -> Resp05
  -> Server06
```

SSE transport owns framing and lifecycle only. It must not infer success,
failure, terminality, retry, continuation, servertool, or routing state.

### 3.3 Known structural gaps

1. `execute_local_web_search_hop` in
   `v3/crates/routecodex-v3-runtime/src/hub_v1/web_search_hop.rs`
   reconstructs `Req01 -> Req09` and performs a second Provider attempt from
   the response-side path. This is the current request-local cycle.
2. The WebSearch feature remains `design` in the function and verification
   maps. Its eight mainline edges are `binding_pending`.
3. There is no typed WebSearch hook request/result contract, no typed subagent
   result boundary, and no `HookOutcome` binding for this path.
4. The static Hub hook registry exposes 30 node entry/exit slots, but many are
   `not_implemented`; a declared slot is not evidence of a working hook.
5. The optional hooks sidecar under `v3/crates/routecodex-v3-hooks` already
   contains typed event/handler/AppServer transport machinery. Reuse must be
   investigated before adding a new adapter.
6. `v3.sse.protocol_semantic_projection` remains `design`; the typed SSE tree
   to `Resp05` edge is not fully bound.
7. The core Hub manifests declare `live_cutover: false` and
   `global_install_restart: false`. Source or controlled tests cannot be
   reported as live acceptance.

## 4. Minimal To-Be DAG

The target is the existing fixed skeleton with only the necessary bindings and
one execution-owner replacement.

```text
Requirement / client input
  -> Req01 -> Req02 -> Req04 -> Req05 -> Req06
  -> Direct or Relay execution mode
  -> Req07 -> Compat06 -> Req08 -> Req09
  -> Provider attempt
  -> Resp01 -> Compat02 -> Resp02 -> Resp03
  -> Resp05 -> Server06
  -> Client terminal

Req04 / Resp03 hook
  -> WebSearchHookRequest
  -> WebSearchSubagentAdapter
  -> WebSearchResult
  -> HookOutcome
  -> return to the same Req04 / Resp03 node

Any provider, transport, hook, or protocol failure
  -> Error01 -> Error02 -> Error03 -> Error04 -> Error05
  -> Error06 -> Resp05 -> Server06

Provider JSON or SSE
  -> typed protocol tree / canonical semantic
  -> Resp05
  -> Server06
```

The To-Be DAG has no edge from a hook to `Req01`, no second Router, no second
Provider selection for the same business operation, and no provider-to-client
shortcut.

### 4.1 Node necessity

| Node | Exists because | Delete consequence |
| --- | --- | --- |
| Fixed Hub nodes | Preserve current protocol, control, and lifecycle boundaries. | Removes correctness or traceability. |
| Error01-06 | Preserve typed failure classification, action planning, exhaustion, and client projection. | Failure becomes implicit or success-wrapped. |
| Hook registry / typed hook result | Bind business hooks to the same node without creating another lifecycle. | Requirement-to-implementation traceability is lost. |
| WebSearchHookRequest | Carries query, call identity, scope, deadline, and policy. | Search execution has no typed contract. |
| WebSearchSubagentAdapter | Owns external search execution. | Search must re-enter Router/Provider or remain unbound. |
| WebSearchResult | Carries result, sources, status, usage, and typed error. | Result cannot be validated or audited. |
| HookOutcome | Returns control to the original node explicitly. | Hook behavior becomes an implicit side effect. |
| SSE typed tree | Preserves protocol semantics before the single client semantic exit. | SSE parsing or semantics leak into transport or client frame code. |
| Resp05 | Sole client semantic owner. | Multiple exits or protocol-specific client shapes appear. |
| Server06 | Sole client frame terminal. | Provider raw or transport fragments can escape. |

## 5. Phase Dependency DAG

```text
P0 Freeze and bind baseline
  |
  +--> P1 Bind existing edges / classify duplicates
  |      |
  |      +--> P2 Typed WebSearch hook contract
  |      |      |
  |      |      +--> P3 Reuse or add subagent adapter
  |      |             |
  |      |             +--> P4 Shadow parity
  |      |                    |
  |      |                    +--> P5 Switch owner and remove re-enter
  |      |
  |      +--> P6 SSE typed tree -> Resp05 binding
  |
  +--> P7 Cross-chain acceptance evidence
          |
          +--> P8 Cleanup and closure
```

`P6` may proceed in parallel with `P2`-`P5` after `P1`, but it must not change
the WebSearch contract or create a second semantic exit. `P7` requires `P5`,
`P6`, and the applicable `P0`-`P4` evidence.

## 6. Ownership and Path Boundaries

The exact final path list must be confirmed from the maps before implementation.
The following paths define the intended ownership boundary.

### 6.1 Architecture and evidence owner

Allowed:

- `docs/architecture/dags/v3-business-five-chain-dag-audit.html`
- `docs/goals/v3-business-five-chain-dag-remediation-plan.md`
- `docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml`
- `docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml`
- `docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml`
- `docs/architecture/manifests/v3.sse.transport_boundary.mainline.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- relevant `docs/architecture/wiki/**` review surfaces
- relevant `docs/goals/**` design and test-design documents

Forbidden:

- Runtime source changes in this ownership slice.
- Rewriting the approved HTML without a new approval.
- Treating the plan as runtime evidence.

### 6.2 WebSearch hook and runtime owner

Allowed after approval:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/web_search_hop.rs`
- the smallest necessary typed hook contract module selected by the resource
  and function maps
- focused tests under
  `v3/crates/routecodex-v3-runtime/tests/**`
- relevant map/manifest/wiki files listed above

Forbidden:

- Server-side search execution.
- SSE semantic handling.
- Virtual Router or Target owning search policy.
- Provider compat owning Chat Process governance.
- New fallback, downgrade, or success-wrapped search errors.
- A second Router or a second response exit.

### 6.3 Hooks sidecar / subagent owner

First inspect and reuse:

- `v3/crates/routecodex-v3-hooks/src/lib.rs`
- `v3/crates/routecodex-v3-hooks/src/appserver.rs`
- `v3/crates/routecodex-v3-hooks/src/handler.rs`
- `v3/crates/routecodex-v3-hooks/src/control.rs`
- `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs`
- `v3/crates/routecodex-v3-hooks/tests/**`

Only add a WebSearch-specific adapter if the existing typed event, handler, or
AppServer transport cannot express the required subagent operation without
changing unrelated semantics. The adapter must not become a general policy
engine.

### 6.4 SSE owner

Allowed:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree_projection.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_sse_tree.rs`
- `v3/crates/routecodex-v3-sse/src/lib.rs`
- the narrow server transport call sites needed to carry already-projected
  frames
- focused SSE tests and the SSE manifests above

Forbidden:

- SSE transport parsing business event names to decide semantics.
- SSE code selecting routes, providers, retries, continuation, or servertool.
- Provider raw frames crossing `Server06`.
- A second client semantic projection.

## 7. Phase Plan

### Phase 0: Freeze the approved design and baseline

Dependency: none.

Owner: architecture/evidence owner.

Exact work:

1. Record the approved HTML path and SHA-256.
2. Reconfirm the worktree, branch, HEAD, dirty files, and protected paths.
3. Re-read the fixed node enum, request/response manifests, four architecture
   maps, hook registry, WebSearch hop, servertool hooks, and SSE manifests.
4. Produce a current gate inventory from `package.json` and the maps.
5. Mark the plan as execution-not-started until a separate runtime worktree is
   created.

Gates:

```text
npm run verify:v3-resource-map
npm run verify:v3-mainline-caller-flow
npm run verify:v3-architecture-docs
npm run verify:v3-hub-pipeline-core-manifests
npm run test:v3-hub-pipeline-core-manifest-red-fixtures
npm run verify:v3-hub-v1-node-file-topology
npm run test:v3-hub-v1-node-file-topology-red-fixtures
git diff --check
```

Evidence:

- Baseline SHA and artifact hash.
- Gate command, exit code, timestamp, and output location.
- Map query results for the WebSearch and SSE owners.

Abort condition:

- The fixed node list, map owner, or manifest contract differs from this plan.
- The approved HTML hash differs without a new approval.

### Phase 1: Bind existing edges and classify duplicate edges

Dependency: Phase 0.

Owner: architecture/evidence owner with the affected runtime owner reviewing
symbols.

Exact work:

1. Classify all eight `v3-web-search-sm-*` edges as one of:
   - existing implementation binding;
   - redundant edge;
   - missing typed contract;
   - obsolete re-enter-only edge.
2. Classify the SSE `typed tree -> Resp05` edge as existing, pending, or
   duplicate.
3. Bind edges to real caller/callee symbols and files where the symbols already
   exist.
4. Remove only duplicate or obsolete edges after proving no correctness,
   traceability, verification, acceptance, or delivery property depends on
   them.
5. Update the maps and review surface together; do not leave a map-only claim
   with no source binding.

Gates:

```text
npm run verify:v3-resource-map
npm run verify:v3-mainline-caller-flow
npm run verify:v3-static-hook-registry
npm run verify:v3-relay-hook-resources
npm run test:v3-relay-hook-resources
npm run test:v3-relay-hook-resource-red-fixtures
npm run verify:v3-server-tool-center-audit
npm run verify:v3-architecture-docs
npm run verify:architecture-wiki-html-sync
git diff --check
```

Evidence:

- Before/after edge table.
- Every remaining edge has caller, callee, owner, status, and a focused test or
  an explicit `MISSING` marker.
- Every removed edge has a deletion rationale and a negative assertion.

### Phase 1 binding evidence (2026-09-18)

Worktree:

```text
../v3-business-five-chain-dag-0918
branch: codex/v3-business-five-chain-dag-0918
HEAD: ba3a144d0
```

The WebSearch chain keeps `status: design` because P2/P5 are still open. The
eight edges were bound to existing runtime symbols where possible, and edges
that describe the current request-local hop are marked as obsolete re-enter
transitions retained until P4/P5 parity.

| Edge | Before | After | Classification |
| --- | --- | --- | --- |
| `v3-web-search-sm-01` | binding_pending, `HubReqChatProcess03Governed` -> `V3WebSearch01RouteEvidenceClassified`, pending symbols | as_is_bound, `V3HubReqChatProcess04Governed` -> `V3WebSearch01RouteEvidenceClassified`, `govern_v3_servertool_request_at_req04` -> `apply_v3_web_search_request_hook_at_req04` | As-Is implementation binding; typed contract still missing |
| `v3-web-search-sm-02` | binding_pending, `V3WebSearch01RouteEvidenceClassified` -> `VrRoute04SelectedTarget`, pending symbols | as_is_bound, `V3WebSearch01RouteEvidenceClassified` -> `V3WebSearchBackendBindingCompiled`, `resolve_request_web_search_backend_binding` -> `resolve_web_search_mode_and_backend` | wrong dependency corrected; route-evidence classifier edge remains missing |
| `v3-web-search-sm-03` | binding_pending, `HubRespChatProcess03Governed` -> `V3ServerToolState01ControlScope`, pending symbols | as_is_bound, `apply_v3_tool_call_servertool_hook_at_resp03` -> `V3ServerToolCenter::store` | As-Is implementation binding; persistence scope is response-runtime-specific |
| `v3-web-search-sm-04` | binding_pending, pending symbols | obsolete, `execute_local_web_search_hop` -> `execute_local_web_search_hop` | obsolete re-enter transition retained until P4/P5 |
| `v3-web-search-sm-05` | binding_pending, pending symbols | obsolete, `execute_local_web_search_hop` -> `build_v3_provider_12_responses_wire_payload` | obsolete re-enter transition retained until P4/P5 |
| `v3-web-search-sm-06` | binding_pending, pending symbols | as_is_bound, `apply_v3_tool_call_servertool_hook_at_resp03` -> `intercept_local_web_search_call` | As-Is implementation binding; hosted result capture is partial |
| `v3-web-search-sm-07` | binding_pending, `HubRespOutbound04ClientSemantic`, pending symbols | obsolete, `V3WebSearch03SearchResultCaptured` -> `V3HubRespOutbound05ClientSemantic`, `project_web_search_result_into_finalized` -> same symbol | obsolete re-enter projection retained until P4/P5; Resp05 is the sole semantic exit |
| `v3-web-search-sm-08` | binding_pending, `HubReqChatProcess03Governed`, pending symbols | as_is_bound, `V3HubReqChatProcess04Governed` -> `V3WebSearch04ToolResultInjected`, `apply_v3_responses_relay_web_search_control_completion` -> same symbol | As-Is implementation binding; typed injection remains P2/P5 |
| `v3-responses-sse-tree-03` | binding_pending, `HubRespChatProcess03Governed` -> `HubRespOutbound04ClientSemantic`, `rewrite_v3_responses_sse_content` | binding_pending, `HubRespChatProcess03Governed` -> `V3HubRespOutbound05ClientSemantic`, pending direct typed-tree caller | duplicate/wrong target corrected, but no direct semantic-tree-to-Resp05 caller is proven; materialization currently returns canonical JSON and is projected through the adjacent JSON path |
| `v3-chat-sse-tree-02` | binding_pending, `HubRespChatProcess03Governed` -> `HubRespOutbound04ClientSemantic`, `rewrite_v3_openai_chat_sse_content` | anchored, `HubRespChatProcess03Governed` -> `V3HubRespOutbound05ClientSemantic`, `project_json_response` -> `build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_client_payload` | duplicate/wrong target corrected to the unique Resp05 semantic exit |
| `v3-responses-relay-typed-hook-catalog-01` | anchored, wrong target `HubRespOutbound04ClientSemantic` | anchored, target `V3HubRespOutbound05ClientSemantic` | edge binding corrected; no runtime semantic change |
| `v3-relay-typed-hook-catalog-01` | anchored, wrong target `HubRespOutbound04ClientSemantic` | anchored, target `V3HubRespOutbound05ClientSemantic` | edge binding corrected; no runtime semantic change |

No edge was removed in this phase. The `sm-02` target node was replaced from
the unbound `VrRoute04SelectedTarget` to the actual compiled backend binding.
The two obsolete re-enter transitions (`sm-04`, `sm-05`) and the obsolete
projection edge (`sm-07`) remain because P4/P5 replacement has not landed.

Gate evidence for this candidate:

```text
ROUTECODEX_V3_ADMISSION_WORKSPACE=1 node v3/scripts/architecture/render-v3-mainline-caller-flow.mjs
ROUTECODEX_V3_ADMISSION_WORKSPACE=1 node v3/scripts/architecture/verify-v3-mainline-caller-flow.mjs
node v3/scripts/architecture/verify-v3-resource-map.mjs
node v3/scripts/architecture/verify-v3-static-hook-registry.mjs
node v3/scripts/architecture/verify-v3-server-tool-center-audit.mjs
node v3/scripts/architecture/verify-v3-relay-hook-resources.mjs
node v3/scripts/tests/v3-relay-hook-resource-red-fixtures.mjs
node v3/scripts/architecture/verify-v3-hub-pipeline-core-manifests.mjs
node v3/scripts/tests/v3-hub-pipeline-core-manifest-red-fixtures.mjs
node v3/scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs
node v3/scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test hub_v1_h1_contract -- --test-threads=1
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-config --test config_v3_contract -- --test-threads=1
git diff --check
```

All listed gates passed. The relay-hook resource gate was also updated from the
pre-continuation 17-node expectation to the current 15-node fixed skeleton and
no longer requires a `Continuation` side-channel kind. This is a gate repair,
not a runtime change.

Abort condition:

- An edge cannot be bound to a unique owner.
- A proposed deletion would remove a required error or acceptance path.

### Phase 2: Define the typed WebSearch hook contract

Dependency: Phase 1.

Owner: WebSearch hook/runtime owner.

Exact work:

1. Define the smallest typed contract:
   - `WebSearchHookRequest`
   - `WebSearchResult`
   - `HookOutcome`
2. The request must carry only:
   - query;
   - call identity;
   - explicit scope;
   - deadline;
   - search policy or capability selector.
3. The result must carry only:
   - normalized result content;
   - source references;
   - status;
   - typed error;
   - usage or provider metadata needed by the existing response projection.
4. Keep control state in typed resources, not in normal request/response
   payload, metadata, debug logs, or implicit context.
5. Bind the contract to `Req04` and/or `Resp03` only where the existing hook
   profile declares the mount.
6. Add positive and negative unit tests before any runtime switch.

Gates:

```text
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib web_search -- --nocapture
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures
npm run verify:servertool-rust-only
npm run verify:v3-architecture-docs
git diff --check
```

Evidence:

- Contract source anchor and owner.
- Schema/type test output.
- Positive case: valid request produces typed result.
- Negative cases: missing query, invalid scope, expired deadline, malformed
  result, and control-state leakage all fail explicitly.

Abort condition:

- The contract needs payload fields that belong to Chat Process or provider
  compat.
- The contract requires a new lifecycle, a second state machine, or a second
  response exit.

### Phase 3: Reuse or add the subagent adapter

Dependency: Phase 2.

Owner: hooks sidecar/subagent owner.

Exact work:

1. Prove whether the existing hooks sidecar can carry the typed request and
   return the typed result without changing unrelated behavior.
2. Prefer an existing `AppServerTransport`, handler, or command boundary.
3. Add a WebSearch-specific adapter only if no existing unique owner can
   express the operation.
4. The adapter must:
   - call only a web-search-capable subagent;
   - return typed result or typed failure;
   - enforce scope and deadline;
   - never call Virtual Router, Target, or Provider transport directly;
   - never write the client frame.
5. Keep the adapter out of `routecodex-v3-server` and
   `routecodex-v3-sse`.

Gates:

```text
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks -- --nocapture
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-static-hook-registry
npm run verify:v3-architecture-docs
git diff --check
```

Evidence:

- Adapter decision record: reuse or new owner, with the rejected alternatives.
- Real or controlled subagent invocation evidence.
- Timeout, cancellation, malformed response, wrong scope, and unavailable
  subagent cases.
- Assertion that no Router/Provider re-entry occurred.

Abort condition:

- The available subagent cannot return a typed result.
- The sidecar requires changing the fixed Hub skeleton.
- The adapter would duplicate an existing unique owner.

### Phase 4: Shadow parity against the existing hop

Dependency: Phase 3.

Owner: WebSearch runtime owner with an independent verifier.

Exact work:

1. Keep the old `execute_local_web_search_hop` path available for shadow
   comparison only.
2. Run the same query and scope through:
   - old local hop;
   - new typed hook/subagent path.
3. Compare:
   - normalized result;
   - source references;
   - call identity pairing;
   - status/error classification;
   - provider attempt count;
   - client semantic projection;
   - JSON and SSE terminal behavior.
4. Record divergences as blockers; do not normalize them away with a fallback.
5. Require independent review of the parity evidence before Phase 5.

Gates:

```text
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures
npm run test:v3-hub-relay-runtime-closeout
npm run verify:v3-hub-relay-runtime-closeout
npm run test:v3-hub-relay-runtime-closeout-red-fixtures
npm run test:v3-relay-payload-copy-runtime-probes
npm run verify:v3-relay-payload-copy-budget
npm run test:v3-relay-payload-copy-budget-red-fixtures
git diff --check
```

Evidence:

- Query corpus and expected semantic result.
- Old/new comparison table.
- Provider attempt count for both paths.
- Re-entry counter proving the new path does not rebuild `Req01 -> Req09`.
- Independent review receipt tied to the exact candidate SHA.

Abort condition:

- Any semantic divergence without a proven equivalent representation.
- The new path has a second Provider attempt or any hidden fallback.
- The old path cannot be shadowed without affecting live behavior.

### Phase 5: Switch the owner and remove the re-enter path

Dependency: Phase 4 and independent review PASS.

Owner: WebSearch runtime owner.

Exact work:

1. Switch `Req04`/`Resp03` to the typed hook/subagent owner.
2. Preserve:
   - tool detection;
   - scope validation;
   - call ID pairing;
   - final response projection;
   - existing Error01-06 behavior.
3. Remove the request-local re-enter edge:
   - no reconstructed `Req01`;
   - no second `Req01 -> Req09` traversal;
   - no second Provider attempt for the same business operation.
4. Ablate only the WebSearch state phases that exist solely to support the
   re-enter path.
5. Keep the minimum state needed for legitimate cross-turn pairing, scope, and
   idempotency.
6. Update all maps, manifests, wiki surfaces, and red fixtures in the same
   candidate.

Gates:

```text
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures
npm run verify:v3-server-tool-center-audit
npm run verify:servertool-rust-only
npm run verify:v3-static-hook-registry
npm run verify:v3-resource-map
npm run verify:v3-mainline-caller-flow
npm run verify:v3-architecture-docs
npm run verify:v3-cargo-fmt
npm run verify:v3-clippy
git diff --check
```

Evidence:

- Source diff proving the re-enter edge is gone.
- Search success, timeout, wrong-scope, typed error, and no-reentry tests.
- State-phase ablation table: phase, deletion reason, replacement owner, and
  regression proof.
- Independent review PASS tied to the candidate SHA.

Abort condition:

- Any requirement path can still reach a second Router or Provider attempt.
- Any old phase is removed without a parity or negative test.
- Error behavior changes from explicit typed failure to success-wrapped output.

### Phase 6: Bind the SSE typed tree to Resp05

Dependency: Phase 1. May run in parallel with Phases 2-5.

Owner: SSE owner.

Exact work:

1. Bind the typed protocol tree to `V3HubRespOutbound05ClientSemantic`.
2. Keep SSE transport framing and lifecycle handling separate from semantic
   projection.
3. Preserve the single `Resp05 -> Server06` exit.
4. Prove that provider raw SSE, failed attempt prefixes, and reparsed HTTP JSON
   cannot cross `Server06`.
5. Keep JSON and SSE on the same finalized client semantic contract.
6. Do not materialize the full provider stream when the existing contract
   requires incremental projection.

Gates:

```text
npm run verify:v3-direct-sse-accept-skeleton
npm run verify:v3-direct-sse-full-attempt-commit
npm run test:v3-sse-transport-core
npm run test:v3-sse-transport-adapter
npm run verify:sse-architecture-boundary
npm run verify:v3-architecture-docs
npm run verify:architecture-wiki-html-sync
git diff --check
```

Evidence:

- Typed tree -> `Resp05` edge binding.
- JSON/SSE semantic-equivalence test.
- Provider raw -> client negative test.
- Failed-attempt prefix -> client negative test.
- Incremental-frame or copy-budget evidence where applicable.
- Direct SSE controlled replay remains separate from live replay.

Abort condition:

- SSE transport starts classifying business events.
- A second client semantic exit appears.
- Full stream materialization is required only to make the test pass.

### Phase 7: Cross-chain acceptance evidence

Dependency: Phases 5 and 6, with applicable Phase 0-4 evidence.

Owner: architecture/evidence owner with the affected runtime owners.

Exact work:

1. Run the acceptance matrix in Section 8.
2. Record one evidence bundle per row:
   - request ID;
   - main SHA;
   - artifact version and hash when a built artifact is used;
   - worktree and candidate SHA;
   - entry protocol;
   - Direct or Relay mode;
   - JSON or SSE intent;
   - node trace;
   - provider attempt count;
   - re-entry counter;
   - terminal result;
   - error code where applicable;
   - exact command and timestamp.
3. Keep source, tests, build, install, restart, health, and same-entry replay
   as separate evidence layers.
4. Do not claim live acceptance from controlled tests.
5. Require independent review for runtime/protocol changes before merge.

Gates:

```text
npm run verify:v3-hub-pipeline-core-manifests
npm run test:v3-hub-pipeline-core-manifest-red-fixtures
npm run verify:v3-mainline-caller-flow
npm run verify:v3-resource-map
npm run verify:v3-architecture-docs
npm run test:v3-hub-relay-runtime-closeout
npm run verify:v3-hub-relay-runtime-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run verify:v3-direct-sse-accept-skeleton
npm run verify:v3-direct-sse-full-attempt-commit
npm run verify:sse-architecture-boundary
git diff --check
```

Evidence:

- Completed acceptance matrix.
- Node traces for all five chains.
- Independent review receipt tied to the exact candidate SHA.
- Explicit statement of any row not executed, with reason and remaining risk.

Abort condition:

- Any row cannot reach a legal terminal node.
- Any row reaches Provider raw, `Resp03`, Server frame, or subagent raw output
  without a typed terminal projection.
- Any evidence layer is inferred from another layer.

### Phase 8: Cleanup and closure

Dependency: Phase 7 PASS and applicable merge authorization.

Owner: task owner with the project lifecycle owner.

Exact work:

1. Confirm the merged main SHA and clean main tree if merge is authorized.
2. Rebuild affected artifacts from main when applicable.
3. Reinstall and restart only through the declared lifecycle path and only with
   separate authorization.
4. Replay the original business entries through the real entrypoint.
5. Confirm health and runtime loaded the intended artifact.
6. Record OTA or distribution evidence only when a versioned artifact changes.
7. Remove only artifacts, temporary files, logs, forwards, processes, and
   worktrees created by this task.
8. Close the bug or feature only after the closure criteria in Section 10
   pass.

Evidence:

- Main SHA and clean-tree proof.
- Artifact version/hash and build provenance.
- Install/restart/health evidence when applicable.
- Same-entry replay evidence.
- Cleanup inventory showing only task-created resources were removed.

Abort condition:

- Main is not clean.
- The running artifact cannot be tied to the merged main.
- A required live evidence layer is missing.
- Cleanup would remove pre-existing or another owner's resources.

## 8. Acceptance Matrix

Every row must end at a legal terminal and must record the exact evidence
bundle described in Phase 7.

| ID | Case | Expected path | Negative assertions | Required evidence |
| --- | --- | --- | --- | --- |
| A1 | WebSearch success | Req04/Resp03 hook -> typed request -> subagent -> typed result -> same node -> Resp05 -> Server06 | No Req01 re-entry, no second Router, no second Provider attempt | Query/result, call ID, source refs, node trace, attempt count |
| A2 | WebSearch timeout | typed request -> adapter timeout -> Error01 -> Error06 -> Resp05 -> Server06 | No success-wrap, no fallback search, no partial client success | Deadline, timeout error, Error01-06 trace |
| A3 | WebSearch wrong scope | typed request rejected before dispatch -> Error01 -> Error06 | No cross-session/tool state access, no Provider call | Scope input, rejection point, state isolation proof |
| A4 | WebSearch typed error | adapter typed failure -> Error chain -> client terminal | No raw adapter error, no payload/control leak | Typed error code, client projection, trace |
| A5 | No re-entry | Search completes and returns to same node | No reconstructed Req01, no Req09 replay, one business operation | Re-entry counter equals zero, attempt count equals one search operation |
| A6 | JSON success | Req01 -> Req09 -> Provider -> Resp01 -> Resp03 -> Resp05 -> Server06 | No provider raw, no second exit | JSON response hash, node trace |
| A7 | SSE success | typed SSE tree -> Resp05 -> Server06 | No provider raw, no failed attempt prefix, no SSE business semantics | SSE frame sequence, terminal frame, JSON/SSE semantic comparison |
| A8 | Provider failure | Provider failure -> Error01 -> Error06 -> Resp05 -> Server06 | No direct Provider-to-client error, no silent retry outside Error policy | Provider status, Error trace, client terminal |
| A9 | Direct mode | Shared fixed skeleton -> Resp05 -> Server06 | No second semantic owner, no Relay-only shortcut | Direct node trace, terminal evidence |
| A10 | Relay mode | Shared fixed skeleton -> Resp05 -> Server06 | No second semantic owner, no Direct-only shortcut | Relay node trace, terminal evidence |
| A11 | JSON/SSE semantic parity | Same finalized semantic at Resp05 | No protocol-specific semantic repair after Resp05 | Semantic comparison and terminal comparison |
| A12 | Provider exhaustion | Error01 -> Error03 -> Error04 -> Error05 -> Error06 | No partial response commit, no success-wrapped exhaustion | Attempt list, exhaustion trace, client terminal |

## 9. Closure Violations to Resolve

| Violation | Current condition | Resolution phase | Closure proof |
| --- | --- | --- | --- |
| A. Orphan Requirement | WebSearch subagent requirement has no typed hook path. | Phase 2-5 | Typed request/result and subagent evidence. |
| B. Orphan Implementation | Local WebSearch hop exists while maps remain `design`. | Phase 1, 5 | Binding and source-owner alignment. |
| C. Unverified Implementation | Re-enter path and SSE typed-tree edges lack sufficient focused verification. | Phase 4-7 | Positive and negative tests per edge. |
| D. Unbound Verification | Existing gates do not prove the subagent path. | Phase 2-4 | New contract and parity gates. |
| E. Missing Acceptance | No single business-level acceptance bundle covers JSON, SSE, Error, WebSearch, Direct, and Relay. | Phase 7 | Acceptance matrix with terminal evidence. |
| F. Missing Evidence | `live_cutover:false`; Direct SSE live replay pending. | Phase 7-8 | Separated source/controlled/live evidence. |
| G. Dependency Gap | WebSearch typed edge and SSE-to-Resp05 edge are missing or pending. | Phase 1, 2, 6 | Bound caller/callee edges. |
| H. Dead Node | Re-enter-only phases and duplicate pass-through edges are deletion candidates. | Phase 1, 5 | Ablation table and regression proof. |
| I. Cycle | WebSearch re-enters `Req01 -> Req09` from `Resp03`. | Phase 5 | No-reentry test and source diff. |
| J. Premature Closure | Main-chain binding does not prove WebSearch, SSE, or live acceptance. | Phase 7-8 | Final closure criteria. |

## 10. Final Closure Criteria

All items are required:

1. Every requirement path reaches a legal terminal node.
2. The fixed Hub skeleton still has one Direct/Relay semantic exit and one
   client frame exit.
3. WebSearch uses a typed hook/subagent result path and has no request-local
   re-entry.
4. WebSearch success, timeout, wrong scope, typed error, and no-reentry cases
   pass.
5. Provider failure and exhaustion enter Error01-06 and never write a partial
   client success.
6. JSON and SSE converge on the same finalized Resp05 semantic.
7. SSE transport owns framing only and cannot expose provider raw output.
8. Every new or changed edge has a caller, callee, owner, status, and focused
   positive plus negative verification.
9. All `binding_pending` and `design` edges affected by this plan are either
   `anchored` or explicitly deferred with a reason and owner.
10. The approved HTML, maps, manifests, wiki review surfaces, source, and tests
    agree.
11. No second Router, second response exit, provider-to-client shortcut,
    fallback, success-wrapped error, or payload/control-state leak exists.
12. Source, review, candidate, merge, build, install, restart, health, replay,
    and cleanup evidence are reported separately.
13. The final candidate and any live artifact are tied to exact SHAs and
    hashes.
14. Remaining risks are explicitly listed; no unresolved critical path is
    hidden behind a PASS claim.

## 11. Remaining Risks

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| Subagent search quality differs from provider-hosted web search | The target path changes execution owner. | Typed result contract, source references, parity corpus, timeout and error cases. |
| Hooks sidecar cannot provide the required subagent semantics | Existing sidecar is generic and may not expose the needed operation. | Reuse audit first; add only a minimal adapter if no unique owner exists. |
| Removing re-enter code too early | The current local hop may cover behavior not yet represented by the new path. | Shadow parity and independent review before Phase 5. |
| SSE semantics leak into transport | Typed tree to Resp05 binding is still pending. | Keep SSE transport semantics-free and prove negative boundaries. |
| Hook slots become governance overhead | Many static slots are not implemented. | Bind only required business edges; remove re-enter-only nodes. |
| Source-green evidence is mistaken for live acceptance | Core manifests declare `live_cutover:false`. | Keep evidence layers separate and require same-entry replay for live claims. |
| Map drift during implementation | Multiple maps, manifests, and review surfaces describe the same edge. | Update maps and source in one candidate and run all map/gate checks. |

## 12. Explicit Non-Actions

- Do not rewrite the working Runtime.
- Do not add a second Virtual Router.
- Do not add a second response exit.
- Do not route provider output directly to the client.
- Do not make SSE a business semantic owner.
- Do not delete the local WebSearch hop before typed subagent parity passes.
- Do not restore continuation as a fixed main-chain node.
- Do not restore V2, P6, or legacy fallback paths.
- Do not use a source-only PASS as live or production acceptance.
- Do not use destructive process cleanup; use explicit PID- or
  service-scoped shutdown only.

## 13. Plan Completion Signal

This plan is complete for execution when:

- Phase 0-8 are implemented in order with their applicable gates;
- the acceptance matrix is complete;
- the final closure criteria pass;
- and the task owner reports the exact source, review, candidate, merge,
  artifact, runtime, replay, and cleanup evidence separately.

Until then, the correct status is `INCOMPLETE` or `UNVERIFIED`, not `DONE`.
