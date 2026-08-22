# V4 Response Continuation Control-Plane Plan

## Goal and acceptance criteria

Let the V4 response chain `continuation_commit` and `continuation_release` typed handles really write continuation truth into `v4.scope.session` (`routecodex-v4-runtime::V4ScopeRegistry`). When done:

- `ScopeRegistry::bind` is called at the exit of `V4HubRespChatProcess03Governed` (not via diagnostic fact)
- `ScopeRegistry::release` is called at terminal release
- The allowed_writers of `v4.scope.session` remain `V4ScopeRegistry::bind` / `V4ScopeRegistry::release` (do not change truth source owner)
- The save to restore immutable interval is locked (duplicate restore, restore after release, cross-owner, cross-protocol, cross-session, cross-port, cross-conversation, missing full input all fail fast)
- Control semantics never enter `v4.response.normal_payload` or client wire

## Key gaps

1. `routecodex-v4-cordis-bridge` has no typed slot for `v4.scope.session`. `control_resource_key()` only supports metadata_center / payload_cycle / error_chain / route_facts / target_selection. `ExecCtx::write_control_resource("v4.scope.session", ...)` from a standard plugin immediately ResourceAccessViolates.

2. The bridge has no path into runtime ScopeRegistry. Even with the slot, data only goes into the `control` JSON; real `ScopeRegistry::bind` still goes through runtime.

3. Runtime has a private `ContinuationCommit` NodePlugin (not a typed handle). It uses `ExecutionContext` plus `RuntimeRegistries`, not `ExecCtx`. The standard plugin path is fully separate.

## Step 1: cordis-bridge adds the typed continuation slot

File: `v4/crates/routecodex-v4-cordis-bridge/src/lib.rs`

- Add `"v4.scope.session" => Some("scope_session")` to `control_resource_key()`
- Add `ScopeSessionValue` typed struct (entry_protocol, owner, port, session_scope, conversation_scope, request_id, full_input_hash, operation bind or release, sequence)
- In `NodeExecutionInput.control` deserializer (deny_unknown_fields), allow `"scope_session"`
- When a standard plugin writes `v4.scope.session`, the bridge serializes the typed struct into `control["scope_session"]`

New unit tests:
- positive: bridge accepts `v4.scope.session` read and write
- negative: unknown control resource key still ResourceAccessViolation
- negative: scope_session struct field missing fail fast

Do not touch `routecodex-v4-plugin-contract` or `routecodex-v4-plugin-plan` (they only declare resource_id list).

## Step 2: runtime exposes typed bridge runner

File: `v4/crates/routecodex-v4-runtime/src/lib.rs`

- Add `pub fn bind_scope_via_bridge(control: &serde_json::Value, scope: &mut ScopeRegistry) -> Result<ScopeRecord, ScopeError>` that reads `control["scope_session"]` and calls `scope.bind(key, request_id, Some(full_input_hash))`
- Add `pub fn release_scope_via_bridge(control: &serde_json::Value, scope: &mut ScopeRegistry) -> Result<ScopeRecord, ScopeError>`
- Validate: forbid bind and release across request boundary, owner mismatch, port mismatch, session and conversation mismatch, missing full_input_hash, already bound, already released, restore after release
- Add L2 tests for the above (positive and negative pairs)

## Step 3: standard plugin descriptor and typed handle

File: `v4/crates/routecodex-v4-standard-plugins/src/continuation_control.rs` (new)

- descriptors: `v4.std.continuation.commit` and `v4.std.continuation.release`
- node_id: `V4ChatProcess03ContinuationCommit` / `V4RespContinuationCommitted`
- role_id: `response_continuation` (contract fix: from Worker A `response_chat_process` to `response_continuation`)
- position: 5 for commit, 7 for release
- reads: `v4.response.normal_payload`, `v4.control.metadata_center`
- writes: `v4.scope.session`

- typed handle `commit`: extract entry_protocol, owner, port, session and conversation scope from normal_payload, build ScopeSessionValue{operation=bind} and write via `ExecCtx::write_control_resource("v4.scope.session", value)`
- typed handle `release`: operation=release

## Step 4: chain wiring and plan compile

File: `v4/crates/routecodex-v4-standard-plugins/src/lib.rs`

- Add `pub mod continuation_control`
- Register commit and release handles in StandardHandleRegistry

File: `v4/contracts/skeleton-plan.contract.json`

- Append commit and release to V4HubRespChatProcess03Governed plugins list
- Recompute plan_hash and update contract

File: `v4/contracts/node-graph.contract.json`

- Keep registered nodes V4ChatProcess03ContinuationCommit and V4RespContinuationCommitted (already exist)
- Do not modify role_subclasses (response_continuation role already present)

File: `v4/scripts/architecture/verify-v4-standard-plugins.mjs`

- Add NODE_PERMISSIONS rows:
  - V4ChatProcess03ContinuationCommit reads=v4.response.normal_payload,v4.control.metadata_center writes=v4.scope.session
  - V4RespContinuationCommitted reads=v4.scope.session writes=v4.scope.session
- Standard plugin descriptor count 21 to 23

## Step 5: tests

Unit:
- commit typed struct built correctly
- release typed struct built correctly
- commit fail-fast on missing scope facts
- release fail-fast on missing prior bind

L2 (new file `tests/l2_continuation_control_plane.rs`):
- positive: bind then restore returns same continuation_truth
- positive: bind then release then restore fails (RestoreAfterRelease)
- positive: release without bind fails (NotBound)
- negative: bind twice on same key fails (AlreadyBound)
- negative: bind with mismatched owner fails (OwnerMismatch)
- negative: bind with mismatched entry protocol fails (EntryProtocolMismatch)
- negative: bind with mismatched port fails (PortMismatch)
- negative: bind with mismatched session scope fails (SessionMismatch)
- negative: bind with mismatched conversation scope fails (ConversationMismatch)
- negative: bind without full_input_hash fails (FullInputMissing)
- negative: restore twice fails (ImmutableIntervalViolation)
- negative: restore on chat or messages entry fails (EntryProtocolMismatch)

runtime L2 (in `routecodex-v4-runtime/tests/l2_runtime.rs`):
- positive: control scope_session bind leads to ScopeRegistry binding exists
- positive: control scope_session release leads to ScopeRegistry binding released
- negative: bind fails on missing control scope_session key

## Step 6: architecture gate sync

File: `v4/docs/architecture/v4-resource-operation-map.yml`
- Append `bind_scope_via_bridge` and `release_scope_via_bridge` to v4.scope.session owner_symbols (do not touch allowed_writers truth source)

File: `v4/.appsdk/maps/mainline-call-map.json`
- Append two edges at the end of response chain edges:
  - V4ChatProcess03ContinuationCommit to V4RespContinuationCommitted (owner: routecodex-v4-runtime::ScopeRegistry::bind_via_bridge)
  - V4RespContinuationCommitted to V4ServerRespOutbound06ClientFrame (edge already exists)

File: `v4/.appsdk/maps/verification-map.json`
- Add new gate `v4_continuation_control_plane_l2`

File: `v4/.appsdk/maps/function-map.json`
- Append `control_resource_key("v4.scope.session")` to v4.plugin.bridge entry_symbols
- Append `bind_scope_via_bridge` and `release_scope_via_bridge` to v4.control.scope entry_symbols

## Scope and boundaries

In scope:
- cordis-bridge typed slot plus scope_session struct
- runtime bind and release via bridge runners
- standard plugin continuation_control.rs
- plan and contract sync
- NODE_PERMISSIONS and architecture map sync
- L2 positive and negative tests

Out of scope:
- standard plugin data-plane (response_inbound, response_outbound, response_governance, tool_harvest) owned by Worker A
- request-side continuation_classify and continuation_restore (already in runtime; not touched)
- restart and online verification (this is internal V4; do not restart V3 server)
- DSH Review (triggered by integration owner after Worker A merge)

## DoD

- 21 standard plugin descriptors upgrade to 23 (plus commit and release)
- cordis-bridge accepts `v4.scope.session` typed slot
- runtime bind_via_bridge and release_via_bridge real-call ScopeRegistry
- 12 L2 positive and negative tests PASS
- 12 architecture gates PASS (inherited from Worker A) plus 2 new runtime gates PASS
- git diff --check passes
- No forbidden path violation (do not touch standard-plugins data-plane)
- v4.scope.session truth source owner (V4ScopeRegistry) unchanged
