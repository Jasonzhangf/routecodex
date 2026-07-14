# Full-Pipeline Payload Copy Cleanup Plan

## Objective

Reduce RouteCodex request-lifecycle memory amplification by removing semantically unnecessary deep copies and duplicate full-payload ownership across the request, response, error, retry, continuation, provider-response effect, registry, debug/snapshot, and JS/Rust bridge paths.

The client request, provider wire request, provider response, and client response must remain semantically equivalent. This work changes ownership and materialization timing, not payload meaning.

## Acceptance Criteria

1. Every known full-payload copy is classified as:
   - an unavoidable boundary copy under the current N-API JSON-string contract;
   - a normal-path copy that has been removed or proven semantically necessary;
   - a debug/error/snapshot copy governed by an explicit memory budget and lifecycle.
2. Normal-path high-impact copies use move, borrow, `Option::take`, object removal, or lazy materialization instead of clone-then-discard behavior.
3. No optimization trims, summarizes, omits, or changes any live client/provider payload field.
4. Request, response, and error topology remains adjacent-node-only and continues to obey the existing owner maps.
5. Each modified slice has red/source evidence, a unique source owner, focused green tests, and an architecture residue gate where regression is statically detectable.
6. Remaining copies are documented with their owner, retention lifetime, necessity, and future removal condition.
7. Source/native/build closure and live RSS closure are reported separately. RSS improvement is claimed only after release installation and representative concurrent large-payload replay.

## Scope

### In Scope

- Request ingress, normalization, Chat Process, Virtual Router handoff, outbound planning, and provider wire construction.
- Server handler/executor handoff residency, including simultaneous `body`, `hubBody`, pipeline metadata, and request-context reachability.
- Provider response ingress, response Chat Process, response projection, StreamPipe, and runtime effect execution.
- Retry seed and retry/reentry payload materialization.
- Responses continuation save, restore, consume, alias cleanup, and release.
- Responses reasoning, payload snapshot, passthrough, and output-text registries.
- Provider-response effect plans and host-side effect consumers.
- Error samples, contract observations, trace payloads, and snapshot recorder payload retention.
- JS/Rust bridge serialization inventory and a separately approved zero-copy contract design, if required.
- Resource/function/mainline/verification map bindings and regression gates for payload ownership.

### Out of Scope

- Changing provider configuration or enabling direct passthrough in `config.toml`.
- Using route/provider configuration to bypass large payloads.
- Special-casing `additional_tools` as a memory workaround.
- Trimming or summarizing any live request or response.
- Moving protocol data into MetadataCenter.
- Provider-specific logic in Hub Pipeline or Virtual Router.
- Replacing the N-API JSON contract without an explicit contract/versioning design and approval.
- Release, deployment, migration, or production configuration changes without explicit authorization.

## Canonical Inputs

- `docs/design/payload-copy-hotspot-inventory.md`
- `docs/design/request-payload-copy-budget.md`
- `docs/architecture/resource-operation-map.yml`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/request-mainline-call-graph.md`
- `docs/architecture/wiki/response-mainline-call-graph.md`
- `docs/architecture/wiki/error-mainline-call-graph.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`

The hotspot inventory is the execution ledger. This plan defines the completion contract and must not become a second, divergent inventory.

## Design Principles

1. Ownership moves forward. Once a stage has produced the next canonical node, the previous full payload must be released unless a documented lifecycle owner still requires it.
2. Materialization is lazy. Retry, continuation, debug, and error payloads are copied only when the corresponding operation actually occurs.
3. Side channels stay separate. Metadata, errors, snapshots, and diagnostics cannot become alternate live-payload truth.
4. One semantic owner per copy. A retained full payload must have one resource owner, one release point, and one verification gate.
5. Owned APIs are internal; compatibility wrappers stay thin. Rust internals should consume owned values where possible while N-API wrappers preserve the external contract.
6. Duplicate response representations are forbidden. Effect plans may carry semantic projections, but not multiple equivalent full response bodies.
7. Rust remains the Hub Pipeline and Chat Process semantic truth. TS may perform host IO and bridge calls but must not recreate ownership policy.
8. No fallback or dual-path compensation. An invalid ownership transition fails explicitly and is fixed at the unique source.

## Technical Plan

### Phase 1: Inventory and Measurement Contract

- Complete the hotspot inventory for request, response, error, retry, continuation, registries, effects, snapshots, and bridge crossings.
- Record for each hotspot: allocation operation, payload size class, owner, consumers, release point, normal/error/debug path, and status.
- Lock the inventory shape with `tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts`, so every row carries class/lifecycle, owner, release/gate evidence, and status before closeout claims.
- Add source scans for prohibited clone patterns where the intended ownership rule is statically expressible.
- Define benchmark fixtures representing top-level `tools`, `input[].type=additional_tools`, long conversation input, retry, continuation, JSON response, and SSE response.
- Record baseline peak RSS, heap, payload bytes, concurrency, request residency, retry count, and output size before making live improvement claims.

### Phase 2: Request Mainline

- Preserve borrowed first-attempt retry seeds and materialize only on actual retry/reentry.
- Continue replacing Hub request-stage clone chains with owned transitions or borrowed views:
  - normalized payload to standardized request;
  - standardized request to request Chat Process;
  - governed request to Virtual Router;
  - selected route to request outbound;
  - provider semantic envelope to provider wire payload.
- Do not retain raw, normalized, standardized, governed, and outbound full bodies simultaneously.
- Replace handler/executor `body` plus `hubBody` dual residency with one authoritative handoff only after response conversion, dry-run, continuation, and error-projection consumers are proven not to require independent full-body ownership.
- Keep the Hub native request argument payload-only. The host may keep `input.body` as the current request owner before the bridge, but the JSON object passed to Rust must not contain a second top-level `body` when `payload` already carries the Hub request.
- Keep raw-entry evidence request-scoped on the TS source metadata, but exclude `__raw_request_body` from the shallow metadata projection serialized into Rust. RequestExecutor capture and client restoration continue to consume the source reference after Hub returns.
- Borrow request-body metadata for whitelist projection instead of JSON round-tripping it; the whitelist output remains the independent server transport carrier.
- Prove every retained origin snapshot is required by response conversion, servertool followup, or continuation; otherwise remove it at the owning node.

### Phase 3: Response Mainline and Effects

- Move response typed nodes through adjacent owned transitions:
  - `ProviderRespInbound01Raw -> HubRespInbound02Parsed` consumes the canonical provider response payload;
  - `HubRespInbound02Parsed -> HubRespChatProcess03Governed` and `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic` accept `FnOnce(Value) -> Result<Value, E>` transforms so the stage payload is not cloned just to call the next owner;
  - final client payload leaves the typed node with `into_payload()`.
- Reject regression patterns that revive `canonical_payload.clone()`, `resp_chatprocess_03.payload().clone()`, `project_normal_response_payload`, or response object clone helper functions.
- Keep the full response only in the top-level `HubRespOutbound04ClientSemantic/rawPayload`; StreamPipe carries transport metadata only, and legacy effect-owned `payload/body` fails fast.
- Trace every `RuntimeStateWrite` consumer and remove its full payload when `usage`, continuation/store effects, and response record projections are sufficient.
- Split semantic response truth from runtime bookkeeping without reconstructing response semantics in TS.
- Introduce owned effect materialization/result builders where the caller owns the plan and can `remove`/`take` values.
- Ensure JSON and SSE paths do not materialize both complete buffered and streamed representations unless the entry contract requires both.

### Phase 4: Registries and Continuation

- Register already-parsed owned Rust values without serialize/parse deep cloning.
- Consume one-shot registry fields with `Option::take()` and release aliases in the same owner operation.
- Audit continuation state field by field. Retain only semantic truth required for the next valid restore, while preserving the Responses continuation immutable interval.
- Define explicit release for consumed, terminal, invalid, and expired continuation entries.
- Add positive and negative tests for alias isolation, owner/scope isolation, still-running state, terminal release, and already-consumed entries.

### Phase 5: Retry, Error, Debug, and Snapshot Budgets

- Keep retry snapshots lazy and create a fresh owned payload only when an attempt needs independent mutation.
- Define byte/count/lifetime budgets for debug traces, contract observations, errorsamples, and snapshot recorder artifacts.
- Replace provider debug hook full-payload size serialization and complete dataFlow clones with traversal-based metrics and bounded diagnostic projections.
- Budgeting may summarize or omit internal observability copies only. It must never alter live request/response truth or error-chain semantics.
- Ensure disabled observability performs no payload serialization.
- Ensure enabled observability releases in-memory materializations after bounded IO and does not retain provider/client payloads in process-wide state.

### Phase 6: JS/Rust Boundary Decision

- Treat current `JSON.stringify -> N-API -> serde_json::Value -> JSON -> JSON.parse` crossings as an explicit contract limit.
- Count and minimize the number of native crossings before redesigning the transport.
- Keep `native-json-invoker.ts` as the host-side JSON call-mechanics owner for monitored narrow bridge files. Broad `native-exports.ts` may still expose direct wrappers under the current JSON-string contract, but those wrappers must not be used as evidence that a payload copy was removed.
- Boundary inventory evidence from 2026-07-13: `native-exports.ts` still contains 38 `JSON.stringify` and 28 `JSON.parse` occurrences, including full payload/body/requestSemantics/snapshot arguments. This is source/native contract evidence only, not live RSS evidence.
- If boundary copies remain the dominant measured cost, produce a separate versioned design for Rust-owned handles, external buffers, binary encoding, or streaming transfer.
- Do not introduce a second bridge contract as fallback. A boundary migration requires one authoritative contract, compatibility/removal plan, and live equivalence evidence.

### Phase 7: Architecture and Closeout

- Update resource, function, mainline call, verification, lifecycle manifest, and wiki bindings when an ownership edge or owner changes.
- Add architecture gates against duplicate payload/body fields, clone-then-clear registries, eager retry snapshots, metadata payload leakage, and non-adjacent payload reconstruction.
- Remove dead compatibility semantics after dependency checks; do not leave dormant alternatives.
- Review the complete diff for correctness, topology violations, provider special cases, fallback behavior, and hidden payload retention.
- Distill confirmed reusable rules to project memory and the RouteCodex development skill, then re-mine and verify retrieval.

## Primary Source Areas

- `src/modules/llmswitch/bridge/native-exports.ts`
- `src/modules/llmswitch/bridge/provider-response-effects.ts`
- `src/modules/llmswitch/bridge/snapshot-recorder.ts`
- `src/server/runtime/http-server/executor/retry-payload-snapshot.ts`
- `src/server/handlers/responses-handler.ts`
- `src/server/handlers/handler-utils.ts`
- `src/server/runtime/http-server/executor-pipeline.ts`
- `src/server/runtime/http-server/request-executor-provider-response.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/effect_plan.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_reasoning_registry.rs`
- Responses continuation store and shared conversation owner modules identified by the current function/mainline maps.

This list is a navigation aid, not permission to distribute the same ownership rule across multiple files.

## Risks and Controls

| Risk | Control |
| --- | --- |
| Moving a value too early breaks a later semantic consumer | Trace all consumers through the mainline call map; add positive and negative lifecycle tests before replacing the clone |
| Borrowed first-attempt payload is mutated by a downstream stage | Keep mutation behind an owned stage boundary; test reference identity and retry restoration independently |
| Continuation cleanup loses intermediate tool state | Preserve the immutable save/restore interval and test pending, terminal, invalid-owner, and already-consumed states |
| Removing a response copy breaks SSE or record publication | Verify JSON and SSE separately, including provider/client semantic equivalence and continuation effects |
| Debug budget accidentally trims live payload | Enforce side-channel ownership and source gates forbidding debug summaries as normal payload inputs |
| Registry `take()` changes alias semantics | Consume and clear aliases atomically in the unique registry owner; test cross-alias isolation |
| Boundary redesign creates dual contracts | Keep redesign outside this implementation until explicitly approved; require a versioned migration and physical old-path removal |
| Dirty worktree causes unrelated changes to be included | Refresh `.agent-collab`, claim semantic IDs, patch/stage/test only exact task files, and never reset/checkout |

## Verification Matrix

| Area | Required Evidence |
| --- | --- |
| Inventory | Every hotspot has class, owner, release point, status, and required gate; `tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts` passes |
| Request path | Focused Rust/Jest tests, `verify:request-payload-copy-budget`, ownership source scan |
| Response effects | Focused effect-plan tests, provider-response tests, Hub stage residue audit, JSON/SSE equivalence |
| Registries | Focused Rust registry tests, N-API Jest tests, relevant response projection tests |
| Continuation | Positive/negative owner/scope/lifecycle tests and existing Responses continuation gates |
| Retry | First-attempt no-copy test, retry materialization test, mutation-isolation test |
| Debug/error/snapshot | Disabled-path no-serialization test, budget enforcement tests, error semantic equivalence |
| Architecture | Resource map, function map, mainline call map, manifest/wiki sync, architecture review gates |
| Native/build | Target `rustfmt --check`, target `git diff --check`, `build:native-hotpath`, base build |
| Live memory | Global release install, one aggregate restart, all configured ports healthy/version-aligned, representative concurrent large-payload replay with RSS/heap/residency evidence |

## RuntimeStateWrite Slice Test Design

Lifecycle:

- Input: `HubRespOutbound04ClientSemantic` owns the canonical client response.
- Projection: response effect planning may derive usage and submit-tool-output retention signals.
- Host: `publishResponsesRecordPlanJson` receives the canonical response separately and consumes only `runtimeStateWrite.usage` plus `keepForSubmitToolOutputs`.
- Release: effect materialization must not retain another complete response or a nested response record.

White-box positive cases:

- Usage survives effect normalization unchanged.
- `keepForSubmitToolOutputs=true` survives effect normalization and continuation finalization.
- Canonical response output and StreamPipe behavior remain unchanged.

White-box negative cases:

- `RuntimeStateWrite` cannot contain `payload`, `responseRecord`, `requestId`, or `clientProtocol`.
- Effect materialization strips legacy duplicate response fields rather than returning them to TS.
- Malformed runtime-state outer shapes remain fail-fast.

Module black-box:

- Provider-response host still records scoped Responses continuation from its separate `response` argument.
- Usage planning still receives the normalized usage object.
- Non-Responses and unscoped Responses continue to emit no continuation store operation.

Project black-box:

- JSON and SSE responses remain semantically equivalent at the client boundary.
- No internal runtime-state field enters provider or client payloads.

Known gap:

- Source/native gates prove ownership-shape reduction, not process RSS reduction. RSS claims require installed-runtime concurrent large-payload replay.

## Required Final Gates

- `npm run verify:request-payload-copy-budget`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- Relevant focused request, response-effect, registry, continuation, retry, and debug/error Jest/Rust gates recorded in the hotspot inventory
- `npm run build:native-hotpath`
- `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`
- Target-file `rustfmt --check`
- Target-file `git diff --check`

Live RSS closure additionally requires the project-prescribed global install, one aggregate `routecodex restart --port <locator-port>`, health/version verification for every configured member port, and concurrent replay of representative large requests. Without those steps, the result is source/native/build closure only.

## Current Completion Audit (2026-07-14T07:38Z)

This table is derived from the current worktree, not from claim status alone. A green focused slice does not close a broader lifecycle row when source-visible full-payload copies or required final gates remain.

| Requirement | Current evidence | Judgment | Remaining proof/action |
| --- | --- | --- | --- |
| Complete hotspot inventory | `docs/design/payload-copy-hotspot-inventory.md` is locked by `tests/sharedmodule/payload-copy-hotspot-inventory.spec.ts` and covers request, response, retry, continuation, registry, effect, debug/error/snapshot, and JS/Rust boundary classes | proven for inventory shape; lifecycle closeout statuses still mixed | Reconcile `partial/open` rows only after their current source residues and gates are closed |
| JS/Rust boundary classification | `native-exports.ts` retains JSON-string N-API crossings; inventory records these as the current contract limit | proven contract limitation, not zero-copy | No bridge redesign in this goal without a separately approved versioned contract |
| Hub request stage ownership | Hub engine uses `take/remove` for normalized and standardized stage outputs; Responses capture and standardization use `BridgeInputToChatBorrowedInput` to borrow `input` and `tools`; request budget gates have passed | source-proven for request-stage clones | Final parent closeout still needs current-worktree native/base builds after the remaining handler/executor and continuation rows close; standardized output projections that must be independently owned remain contract-required |
| Handler/executor residency | Rust-bound Hub invocation no longer carries duplicate top-level `body` and excludes `__raw_request_body` from Rust metadata; build/base evidence exists | partial | Handler still retains raw request, pipeline body, and request context together. Required consumer-by-consumer proof for origin release is incomplete and the residency audit claim remains active |
| Response typed nodes and StreamPipe | Current engine moves typed response payloads with `into_payload`; StreamPipe effect carries codec/request id only; focused response typed/effect and native build evidence exists | source-proven | Final parent closeout still needs current-worktree native/base builds and response effect gate rerun |
| RuntimeStateWrite narrowing | Current engine derives runtime-state payload separately and prior focused effect evidence rejects duplicate response fields | source-proven | Re-run provider-response focused gates and Hub stage residue against the final worktree |
| Responses reasoning registry consume | `responses_reasoning_registry.rs` uses `Option::take()` for reasoning, output text, payload snapshot, and passthrough payload consume paths | source-proven | Re-run focused registry tests, response outbound semantics, and native build against final worktree |
| Effect-plan owned materialization | Prior red/green evidence covers owned effect materialization and request-stage result builders | source-proven | Re-run effect-plan/provider-response gates against final worktree |
| Retry seed laziness | `prepareRequestPayloadRetrySeed()` is borrowed on first attempt and does not eagerly clone; restore now fails explicitly when `structuredClone` cannot materialize a borrowed or snapshot seed, without JSON or shallow-spread compensation | source-proven | Focused retry Jest 4/4, `npm run verify:request-payload-copy-budget`, TypeScript, no-fallback diff, inventory gate, and target diff check passed. Final parent closeout still needs aggregate native/base builds |
| Continuation release | `release_request_payload` exists and focused release tests passed | partial | Pending immutable-interval retention and native/store JSON boundary copies remain open; continuation claims have not published final closeout/transfer evidence |
| Snapshot/error/debug budgets | Disabled snapshot serialization, move-only queue ownership, bounded contract observations, hook projections, errorsample and debug-script copy budgets have focused gates. Rust snapshot retention is now bounded by both 10 jobs and 8 MiB, including provider/forced-full diagnostics | source/native budget proven | Enabled snapshot host normalization/write/persistence still crosses the current JSON N-API boundary multiple times; this is explicitly retained as a versioned-boundary redesign backlog rather than an unbounded-copy gap |
| Provider configuration/direct passthrough constraint | No payload-copy slice modified provider configuration, `config.toml`, or `~/.rcc` | proven | Preserve through final diff audit |
| Final source/native/build closure | On 2026-07-14 the aggregate worktree passed request/snapshot copy-budget gates, resource/function/mainline gates, `npm run build:native-hotpath`, and `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`; the later snapshot queue byte-budget slice separately passed focused gates and `npm run build:native-hotpath` | source/native gates currently green for the snapshot slice, but final aggregate base is not re-proven after every partial row | Re-run full final gates after request/handler/continuation rows close; earlier green builds do not prove the unresolved ownership contracts |
| MemoryPalace retrieval | The routecodex wing now returns the canonical cleanup plan, hotspot inventory, request copy-budget memory, and current source anchors for the cleanup query | proven for canonical cleanup retrieval | Continue mining only newly confirmed closeout facts; retrieval is no longer a parent blocker |
| Live RSS reduction | No authorized final installed-runtime concurrent large-payload measurement was performed for this aggregate goal | intentionally unverified | Report source/native optimization only unless Jason separately authorizes release/install/restart/live measurement |

### Audit Decision

The parent goal is not complete. The decisive remaining source issues are request-context/standardized retained clones, handler residency, and continuation pending retention. Snapshot queue byte/count retention is now bounded; its remaining repeated host JSON crossings are classified under the current N-API boundary redesign backlog. Existing active claims prevent broad duplicate owner edits; they require checked handoff, owner completion, or a narrow source-proven forward fix.

## Execution Order

1. Refresh MemoryPalace, resource/function/mainline/verification maps, mainline source, hotspot inventory, `.agent-collab` runs/claims/events, and kill switch.
2. Establish or renew semantic claims for the feature/resource/gate being changed.
3. Update the inventory and write a test design for the next slice.
4. Capture a failing test or source-scan red result before changing the owner.
5. Modify only the unique owner and physically remove superseded semantics.
6. Run focused green tests, formatting, source residue gates, and target diff checks.
7. Update maps, manifest, wiki, inventory status, and verification bindings when contracts changed.
8. Repeat by normal-path memory impact: request mainline, response effects, registries/continuation, retry, then debug/error/snapshot.
9. Run the full source/native/build gate set and architecture review.
10. Run approved release/install/restart/live replay only when live closure is in scope.
11. Append evidence to `note.md`, promote confirmed truths to `MEMORY.md` and the local skill, then mine/search MemoryPalace.

## Definition of Done

- The inventory covers the complete in-scope lifecycle and contains no unclassified full-payload copy.
- Every high-priority normal-path deep copy is removed or has evidence that its independent ownership is semantically required.
- Debug/error/snapshot copies have enforceable byte/count/lifetime budgets and cannot become live truth.
- Retry and continuation copies are lazy, scoped, and explicitly released.
- Request, response, error, metadata, and snapshot chains remain isolated and topology-compliant.
- All required focused, architecture, native, and base-build gates pass.
- Live RSS reduction is either demonstrated with release/runtime replay evidence or explicitly reported as unverified.
- Final reporting states what changed, verification evidence, unavoidable copies, remaining risks/backlog, and the next action.
