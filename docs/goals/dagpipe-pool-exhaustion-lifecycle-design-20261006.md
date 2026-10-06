# Bounded Pool Exhaustion Lifecycle Design

- task_id: dagpipe-parallel-foundation-20261005
- worker_id: exhaustion-design
- alignment_r2: exhaustion-evidence-r2 (2026-10-06 UTC); folds in the
  independent design review r1 PASS (oauth/gpt-6.1-sol) with its two P2
  corrections, and the parent public RED on the legitimate OpenAI Chat ->
  Responses Relay entry. No implementation review PASS is claimed.
- parent: /root (goal orchestrator; owns acceptance, independent design review,
  product implementation and integration)
- identity: fresh GCM design worker, not goal orchestrator
- input_sha: 3ee73753f5b638c863f0870994b9aea57ae15e87
- worktree: /Volumes/Intel/playground/routecodex/dagpipe-exhaustion-design-20261006
- scope: one design document plus records; no product code, test, map, graph,
  commit, push, or runtime lifecycle change
- status: design aligned to review r1 and to the parent public RED on base
  `3ee73753f`; product implementation and implementation review remain
  parent-owned and pending

This document is a bounded design, not an implementation and not a review
verdict. It closes the zero-candidate part of the prior exhaustion-contract
audit. It reuses that audit's valid source observations and does not re-audit
the whole exhaustion surface.

## 1. Contract And Problem

The user contract for a model request is:

1. While at least one healthy, eligible candidate remains, RouteCodex switches
   to it and completes the request.
2. When the eligible pool is COMPLETELY exhausted, RouteCodex must promptly
   disconnect the current response for THIS request, record truthful internal
   Error evidence, and send no provider error client frame and no fabricated
   success.
3. An independent Provider background owner keeps probing. A successful
   semantic probe restores admission for a NEW request only. It must never
   resume an exhausted request.

The contract must also preserve: preceding-tier advisory probes, health-neutral
capacity reselection, client cancellation, exact provider identity, real
external statuses, the three separate graphs, and the existing single health
store. No local continuation and no payload-carried control state is allowed.

The source audit found a request-owned wait/resume branch before any provider
attempt when every eligible candidate is already cooled and the caller enables
exhaustion rescue (`provider_cooldown_rescue.rs:493-609`). Public behavior is
confirmed separately below. The branch exists in the runtime selection owner,
but the standard public `/v1/responses` entry does NOT reach it: the Server
first runs a fresh, rescue-less protocol plan and terminates exhaustion at the
entry boundary (§3.6, §10.2). The intended change still removes waiting for the
exhausted request under points 2 and 3, because the branch remains reachable
from other runtime entries.

## 2. Scope And Non-Goals

In scope: the exact pre-attempt selection path in
`v3/crates/routecodex-v3-runtime/src/provider_cooldown_rescue.rs`, its Direct
and Relay callers, its Error05 terminal handoff, the minimal owner-correct
product change, the physical ablation of hold-only helpers/tests, and the maps,
tests and black-box controls that must change.

Non-goals:

- No product code, test, map, graph, manifest, or runtime change in this worker.
- No change to the §8 `ProviderLocalFailure` design; it is DISTINCT and cannot
  authorize this lifecycle modification.
- No second graph, no second health store, no generic retry abstraction, and no
  request fallback.
- No re-audit of routing, provider transport, SSE projection, or unrelated
  error paths.

## 3. Source Trace: Entry, Caller, Owner, Operator@Version

### 3.1 Shared selection owner (the hold-semantics owner)

- File: `v3/crates/routecodex-v3-runtime/src/provider_cooldown_rescue.rs`
- Lifecycle owner: `V3TargetInterpreter` and the runtime admission wrappers.
  The request graph assigns concrete selection to
  `routecodex.v3.operation.plan_execution@1` (REQ04).
  `routecodex.v3.operation.resolve_target@1` (REQ03) only returns an opaque
  route target; it must not select concrete providers or own health recovery.
- `select_v3_expanded_target_with_admission_rescue` (line 86): admission-aware
  wrapper. It calls the exhaustion wrapper, then loops on capacity admission.
- `select_v3_expanded_target_with_exhaustion_rescue` (line 342): the owner of
  the pre-attempt cooldown hold. On an initial `Err(exhausted)` it enters the
  request-owned wait/resume loop at line 504.
- `resolve_v3_relay_target_outcome_with_admission_rescue` (line 294): Relay
  wrapper; forwards `allow_exhaustion_rescue_probe` and maps the result.

### 3.2 Direct entry and caller

- Responses Direct kernel:
  `v3/crates/routecodex-v3-runtime/src/kernel.rs`.
  - `execute_v3_responses_direct_runtime_kernel_core_resident` calls
    `select_v3_expanded_target_with_admission_rescue` at line 335.
  - On `V3AdmittedTargetSelectionAfterRescue::Exhausted` (line 354) it builds
    `build_v3_error_01_source_raised(V3ErrorSourceKind::TargetPoolExhausted,
    "V3Target10ConcreteProviderSelected", "selected_target_exhausted", ...)`
    and returns `direct_runtime_helpers_stream::
    target_exhausted_output_with_observability` (line 368).
- Generic Direct kernel:
  `v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs`.
  - `execute_v3_direct_runtime_kernel_core_resident` calls the wrapper at
    line 246 and handles `Exhausted` at line 269 with the same
    `target_exhausted_output_with_observability` handoff at line 287.
- Direct flag: the real Direct entry builds its core state with the default
  `allow_exhaustion_rescue_probe = true`
  (`direct_kernel_entrypoints.rs:11`; `direct_state.rs:219`). The only
  disabling call is the dry-run path (`direct_protocol_plan.rs:450`). So Direct
  does NOT disable exhaustion rescue on the live path.

### 3.3 Relay entry and caller

- Responses Relay:
  `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs`.
  - `execute_v3_responses_relay_runtime_inner` calls
    `resolve_v3_relay_target_outcome_with_admission_rescue` at line 189 and
    handles `Exhausted` at line 205.
  - It builds a `V3ResponsesRelayProviderFailure` with `status: 502`,
    `provider_status: None`, `policy_error_type: "selected_target_exhausted"`,
    and `provider_id: "none"` (lines 206-220), then returns
    `terminalize_v3_responses_relay_provider_failure` (line 224).
- Relay flag: every Relay entry passes
  `allow_exhaustion_rescue_probe = true`
  (`responses_relay_runtime.rs:169/207/239`), so the runtime selection is
  enabled to hold. Whether the hold actually fires depends on reaching the
  runtime selector at all (§3.6).
- Generic Relay core:
  `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs` calls the
  relay wrapper at line 645.
- Anthropic Relay:
  `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs` calls
  the relay wrapper at line 547.

### 3.4 Error05 decision owner

- File: `v3/crates/routecodex-v3-error/src/lib.rs`
- Operator: `routecodex.v3.error.err05_execution_decision@1`
  (graph node `error_err05_execution_decision`).
- `build_v3_error_03_target_local_action_from_v3_error_02` (line 863): sets
  `retry_eligible = provider_failure && candidates_remaining > 0` and
  `exhaustion_effect = "target_pool_exhausted"` when
  `candidates_remaining == 0`.
- `build_v3_error_04_target_exhaustion_decision_with_provider_availability`
  (line 904): sets `target_exhausted` true when a provider failure has
  `route_pool_remaining_after_exclusion == 0 && !default_pool_available`.
- `build_v3_error_05_execution_decision_from_v3_error_04` (line 939): returns
  `ProjectTerminal` for a provider failure with no remaining candidate and no
  default pool (line 954). It returns `WaitThenReselect { recovery }` only when
  `route_pool_remaining_after_exclusion > 0 || default_pool_available`, and
  that branch panics if no recovery witness is present. Every other source kind
  (including `TargetPoolExhausted`) takes the default
  `RejectNonProviderError` action (line 955).
- `V3Error05ExecutionDecision::try_into_terminal` (line 536): accepts
  `ProjectTerminal` only for `ProviderFailure` (lines 539-545) and accepts
  `RejectNonProviderError` for all other source kinds (line 549). Both are
  valid terminals; the exact action differs per caller.
- Direct terminal disposition: `kernel/direct_runtime_helpers_stream.rs`
  `error_output_with_observability` (line 911) forwards a `TargetPoolExhausted`
  source through `run_error` (which yields `RejectNonProviderError`) and then
  sets `terminal_disposition = NoResponse` separately (line 917);
  `target_exhausted_output_with_observability` (line 922) sets `NoResponse` or
  `ExternalHttp(witness)` (lines 932-935).
- `provider_terminal_disposition` (line 1056): maps the witness to
  `ExternalHttp` or `NoResponse`; the comment states the witness is
  provider-private evidence and never a client projection.
- Relay terminalization: `v3/crates/routecodex-v3-runtime/src/hub_v1/
  responses_relay_failures.rs::terminalize_v3_responses_relay_provider_failure`
  (line 363) calls `V3ErrorHandlingCenter::decide_provider` with
  `candidates_remaining: 0` (line 380) and stores the disposition (line 389).

### 3.5 Background probe owner (future-request admission)

- File: `v3/crates/routecodex-v3-server/src/lib.rs`
- `spawn_v3_server_aggregate_with_admin_and_hooks_sidecar_socket` spawns the
  managed aggregate background task at line 644.
- The task runs a startup probe batch, then a 1s interval that calls
  `probe_health.run_due_provider_health_probes(now_ms, false, ...)`
  (line 654 / line 688).
- Probe success clears the cooldown and publishes an availability generation.
  A later NEW request observes the restored availability and selects normally.
  This owner already provides the required independent recovery path.

### 3.6 Server entry boundary (why the public entry does not reach the hold)

- File: `v3/crates/routecodex-v3-server/src/endpoint_handlers.rs` and
  `v3/crates/routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs`.
- For a `/v1/responses` request, the Server runs a fresh protocol plan BEFORE
  any runtime selection (`endpoint_handlers.rs:164-245` ->
  `plan_v3_responses_protocol_execution_with_provider_health`,
  `direct_protocol_plan.rs:1`). The plan is enabled unless the input has an
  unpaired `function_call_output`
  (`scope_metadata.rs:25`, `responses_entry_facts_allow_fresh_protocol_plan`).
- The plan performs concrete selection with the NON-rescue selector
  `select_v3_target_with_session_then_global` (`direct_protocol_plan.rs:146`).
  It never calls `select_v3_expanded_target_with_exhaustion_rescue`.
- On an already-cooled pool the plan selection returns `Err`, so the plan
  returns `protocol_plan_failure` with `TargetPoolExhausted`
  (`direct_protocol_plan.rs:156-169`). The handler then returns
  `provider_terminal_response(..., NoResponse, ...)`
  (`endpoint_handlers.rs:191-215`, terminal call at line 208): a transport
  break, before the Direct or Relay runtime is invoked.
- Consequence: an already-cooled request on the standard public
  `/v1/responses` entry (Direct or Relay) terminates at the Server boundary and
  never enters the runtime hold loop. The hold loop is only reachable when this
  fresh protocol plan is skipped.

## 4. Missing Error05 Zero-Candidate Analysis

The prior audit located two recovery drivers: a request-owned cooldown wait in
`provider_cooldown_rescue.rs` and an aggregate-owned background probe in
`server/src/lib.rs`. The missing analysis was: which of the three possible
await/resume points in the zero-candidate path can actually hold THIS request.
The three candidate points are (a) decision execution, (b) provider action
admission / recovery witness, and (c) terminal admission.

### 4.1 Decision execution does not await

`V3ErrorHandlingCenter::decide_provider` (error `lib.rs` line 1096) is a
synchronous function. It builds Error02..Error05 in one call and returns. With
`candidates_remaining == 0` and no default pool, a `ProviderFailure` source
yields `ProjectTerminal` (line 954); a `TargetPoolExhausted` source yields the
default `RejectNonProviderError` (line 955). Both are synchronous terminal
actions. There is no await in the Error03/Error04/Error05 builders. Decision
execution therefore cannot hold or resume the exhausted request.

### 4.2 Provider action admission / recovery witness cannot await on exhaustion

The only Error05 action that involves waiting is
`WaitThenReselect { recovery }`. Its construction is gated on
`route_pool_remaining_after_exclusion > 0 || default_pool_available`
(error `lib.rs` lines 946-947). With a complete pool exhaustion both are false,
so Error05 takes a terminal action (`ProjectTerminal` for `ProviderFailure`,
`RejectNonProviderError` for `TargetPoolExhausted`), and `try_into_terminal`
(line 536) accepts the matching action. No recovery witness is created for
this request on exhaustion. The `V3Error05RecoveryAdmissionWitness` (line 419)
and its consumer `wait_for_recovery_witness`
(`provider_action_gate.rs` line 300) are reachable only through the
remaining-candidate `WaitThenReselect` branch. Therefore the Error05 / provider
action layer cannot await or resume the exhausted request either.

### 4.3 Terminal admission does not await

- Direct: `target_exhausted_output_with_observability`
  (`kernel/direct_runtime_helpers_stream.rs` line 922) is synchronous. It sets
  `terminal_disposition` from the witness (line 933). No await.
- Relay: `terminalize_v3_responses_relay_provider_failure`
  (`responses_relay_failures.rs` line 363) is synchronous. It calls the sync
  decision center and stores disposition/projection. No await.

### 4.4 Verdict: only the selection hold loop awaits and resumes

The single component that awaits on a completely exhausted pool and then
resumes the SAME request is
`select_v3_expanded_target_with_exhaustion_rescue`
(`provider_cooldown_rescue.rs` line 342), in the block at lines 493-609:

- Line 493: `if !allow_exhaustion_rescue_probe { return Exhausted(...) }`.
- Lines 496-501: compute `rescue_deadline` from
  `attempt_store.residence_timeout_ms` or `V3_PROVIDER_RESCUE_DEFAULT_TIMEOUT_MS`
  (600_000 ms).
- Line 504: `loop { ... }`.
- Line 545: `run_exhaustion_rescue_probes` for the whole expanded set.
- Line 584 / 594: `wait_for_availability_change` or a sleep until the next
  probe deadline or the residence deadline.
- Line 529 (inside the loop): `Ok(selected) => return Selected(selected)` —
  this is the resume of the SAME request after recovery.

This block runs BEFORE any provider attempt and is upstream of Error05. When it
is reached with `0` candidates it holds the request instead of letting the
Error05 terminal fire. It is the exact owner of the hold semantics.

Reachability matters: the standard public `/v1/responses` entry runs the fresh,
rescue-less protocol plan first (§3.6), so it terminates at the Server boundary
and never reaches this loop. The loop is reachable from runtime entries that
skip that plan, for example the in-request Relay re-selection path
(`resolve_v3_relay_target_outcome_with_admission_rescue` is always called with
`allow_exhaustion_rescue_probe = true` from
`responses_relay_runtime_inner.rs:191`; the Relay runtime itself can also be
entered with a pre-set initial target, §3.6). The parent reproduced the public
held request on base `3ee73753f` through the legitimate OpenAI Chat -> Responses
Relay entry: the already-cooled request did not transport-disconnect within the
1.5s `DISCONNECT_BUDGET` (§10.2). The source branch and the public held request
are both confirmed.

### 4.5 FUTURE admission vs waiting THIS request

- Recording a FUTURE admission means the shared health store publishes an
  availability generation that a later NEW request reads during its own
  selection. The background owner in `server/src/lib.rs` already does this.
- Waiting THIS request means the current request blocks in the line 504 loop
  and then returns `Selected` from line 529. That is the retired behavior.

The fix must keep the first and physically remove the second. The
`allow_exhaustion_rescue_probe` flag currently conflates both: it gates the
preserved preceding-tier advisory probe (line 446) AND the retired hold loop
(line 493). The flag must stay for the advisory probe, but the hold loop must
go.

The concrete selection that owns this branch is
`routecodex.v3.operation.plan_execution@1` (REQ04) via `V3TargetInterpreter` and
the runtime admission wrappers. `routecodex.v3.operation.resolve_target@1`
(REQ03) only returns an opaque route target; it does not select providers and
does not own the exhaustion hold.

## 5. Lifecycle Endpoints

All endpoints keep the single health store, the three separate graphs, and the
no-client-error boundary.

| Endpoint | Trigger | Behavior after the change | Typed owner |
| --- | --- | --- | --- |
| Success | At least one healthy eligible candidate | Select and complete; unchanged | REQ04 `plan_execution` / `V3TargetInterpreter` -> Provider |
| Exhausted (zero candidate) | Initial selection `Err(exhausted)` with all eligible candidates cooled | Return `Exhausted` immediately; no wait, no resume | `select_v3_expanded_target_with_exhaustion_rescue` (REQ04 `plan_execution`) |
| Exhausted (Direct terminal) | `Exhausted` at kernel | Build `TargetPoolExhausted` -> Error05 `RejectNonProviderError`, then set `NoResponse` disposition and disconnect transport; no error frame, no fabricated success | `kernel.rs` / `v3_direct_core.rs` / `direct_runtime_helpers_stream.rs` |
| Exhausted (Relay terminal) | `Exhausted` at relay wrapper | Build `selected_target_exhausted` ProviderFailure -> Error05 `ProjectTerminal`, `NoResponse` disposition, terminal projection, transport break | `responses_relay_runtime_inner.rs` / `responses_relay_failures.rs` |
| Failure (source raised) | Non-exhaustion source (clock, invalid budget, probe transport) | `Failed(source)` unchanged; typed Error01 source, no client error frame | Error chain |
| Cancellation | Client disconnect | Request-local, health-neutral; `ClientDisconnected`; unchanged | Error05 `ClientDisconnect` branch |
| Disconnect | Terminal exhaustion | Break transport with incomplete transfer; no error semantics | Server / SSE / Relay transport |
| Resource cleanup | After terminal or success | Admission lease released if unused; probe permits dropped; no cross-request state | Provider action gate / health store |

## 6. Minimal Owner-Correct Product Change

Owner: `v3/crates/routecodex-v3-runtime/src/provider_cooldown_rescue.rs`,
function `select_v3_expanded_target_with_exhaustion_rescue` (line 342).

Change: after the initial `Err(exhausted)` binding at line 491, return
`V3TargetSelectionAfterRescue::Exhausted(initial_exhaustion)` unconditionally.
Delete the `if !allow_exhaustion_rescue_probe` guard, the `rescue_deadline`
computation, and the entire `loop` (lines 493-609). This makes a completely
exhausted eligible pool terminal at the selection boundary, so the existing
Direct and Relay terminal handoffs fire promptly whenever the branch is
reached. The standard public `/v1/responses` entry already terminates earlier
at the Server protocol plan (§3.6); this change removes the residual hold
branch for the runtime entries that still reach it. The parent public RED now
reproduces the held request through the legitimate OpenAI Chat -> Responses
Relay entry (§10.2), so implementation is authorized on this source branch.

Keep unchanged:

- The preceding-tier advisory probe block at lines 446-489
  (`allow_exhaustion_rescue_probe && !rescue_candidates.is_empty()` ->
  `run_cooldown_rescue_probes_for_candidates`). This is a distinct behavior:
  it fires only when a later tier IS selected and probes cooled preceding-tier
  members before committing. It does not hold or resume the request.
- The capacity reselect path in
  `select_v3_expanded_target_with_admission_rescue` (line 86). It already
  passes `allow_exhaustion_rescue_probe = false` for capacity retries and does
  not mutate health or wait (lines 126-141).
- The `allow_exhaustion_rescue_probe` parameter itself, because the advisory
  block still uses it.

No new graph node, no new store, no generic retry abstraction, and no request
fallback is introduced. The change deletes control flow; it does not add any.

## 7. Physical Ablation Of Retired Hold Semantics

After the change, verify callers and physically remove the hold-only symbols
(no wrapper, no `#[allow(dead_code)]` retention):

- `V3_PROVIDER_RESCUE_DEFAULT_TIMEOUT_MS` (`provider_cooldown_rescue.rs`
  line 164): used only by the deleted loop.
- `V3ProviderFailureRuntimeHealth::run_exhaustion_rescue_probes`
  (line 283): used only by the deleted loop (and one test, see below).
- `next_provider_cooldown_probe_deadline` (line 612): used only by the deleted
  loop.
- `v3_exhaustion_is_cooldown_only` (line 638): used only by the deleted loop.
- `v3_availability_is_cooldown_recovery_only` (line 665): used only by
  `v3_exhaustion_is_cooldown_only`.

Retain:

- `run_cooldown_rescue_probes_for_candidates` (line 167): still called by the
  advisory probe block.
- `availability_generation` / `wait_for_availability_change`
  (`routecodex-v3-provider-responses/src/health.rs` lines 329/333): keep them;
  they remain valid health-store primitives with their own tests
  (`health_tests.rs`), and the background owner uses the generation publication
  path.
- `provider_cooldown_probe_next_deadline_ms`
  (`health/probe_schedule.rs` line 49): keep; it has non-hold callers
  (`health/manual.rs`, `health_tests.rs`).

Test ablation (verify first, then remove or repurpose): the following tests in
`v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests/
cooldown_exhaustion.rs` assert the retired hold/resume semantics and must be
removed or rewritten to assert immediate terminal exhaustion:

- `fresh_cooldown_only_exhaustion_runs_one_rescue_probe_and_resumes_same_request`
  (line 199)
- `stale_rescue_probe_completion_does_not_abort_reselection_of_next_provider`
  (line 266)
- `cooldown_only_exhaustion_waits_for_successful_rescue_probe` (line 379)
- `cooldown_only_exhaustion_probe_failure_keeps_waiting_for_later_recovery`
  (line 489)
- `cooldown_only_exhaustion_retries_when_next_probe_is_due` (line 599)
- `cooldown_only_exhaustion_bounds_rescue_wait_with_residence_deadline`
  (line 692)
- `auth_key_cooldown_holds_selection_until_probe_recovery` (line 787)
- `auth_key_cooldown_holds_selection_until_successful_probe_recovery` (line 898)

Also re-point or remove `run_exhaustion_rescue_probes` usage in
`v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests/
responses_probe_terminal.rs` (line 111); that test calls the ablated symbol
directly. Its probe-transport intent can move to the retained advisory or
background path, but that is an implementation decision for the parent.

Keep (do not remove): `request_local_provider_failure_excludes_all_auth_keys_for_provider`
(line 154), `request_local_exclusion_without_cooldown_probe_success_stays_terminal`
(line 741), and the later-tier / capacity tests at lines 981, 1162, 1289.
These cover preserved behavior.

## 8. Graph Decision

Existing graphs:

- Request graph: `docs/architecture/dagpipe/v3.operation_runner.request.graph.json`
  (id `v3.operation_runner.request`).
- Error graph: `docs/architecture/dagpipe/v3.operation_runner.error.graph.json`
  (id `v3.operation_runner.error`, version `1`). Nodes:
  `error_err01_source_raised`, `error_err02_host_captured`,
  `error_err03_runtime_classified`, `error_err04_router_policy_applied`,
  `error_err05_execution_decision`, `error_err06_client_projected`, chained
  linearly with one source and one sink.

Decision: no topology patch to the error graph. The static error graph already
models the correct linear chain and the correct terminal sink. The candidate
defect is a request-owned wait in the Runtime selection layer, which is UPSTREAM
of Error01 and therefore outside the error graph. The source branch and the
public held request are confirmed through the legitimate OpenAI Chat ->
Responses Relay entry (§10.2). Both caller
paths traverse the
same linear graph Error01 -> Error02 -> Error03 (`target_pool_exhausted`) ->
Error04 (`target_exhausted`) -> Error05 -> Error06, but the Error05 ACTION
differs by source kind and both are valid terminals:

- Direct: the kernel raises Error01 with
  `source_kind = TargetPoolExhausted`. Error05 then takes the default
  `RejectNonProviderError` action (`error/src/lib.rs:955`), which
  `try_into_terminal` accepts for non-`ProviderFailure` sources
  (`error/src/lib.rs:549`). The Direct helper then sets the
  `NoResponse`/`ExternalHttp` disposition separately
  (`direct_runtime_helpers_stream.rs:911-935`).
- Relay: the relay wrapper builds a ProviderFailure with
  `policy_error_type = "selected_target_exhausted"`
  (`responses_relay_runtime_inner.rs:208-222`), so Error05 takes
  `ProjectTerminal` (`error/src/lib.rs:954`) and terminalization stores the
  disposition (`responses_relay_failures.rs:363`).

Shared conclusion: neither terminal handoff waits or resumes the request. The
earlier text that described the Direct path as `ProjectTerminal` was
inaccurate; the actions differ but both terminalize synchronously.

The request graph's concrete-selection operator is REQ04 `plan_execution`
(`V3TargetInterpreter`), which reads health/availability/exclusions and writes
the resolved target. REQ03 `resolve_target` stays a single node that returns
only an opaque route target; it must not carry concrete-selection or exhaustion
semantics. The change does not add a node, edge, or back-edge. No exact graph
patch is required; if a future reviewer disagrees, the only permissible patch
is to annotate the REQ04 `plan_execution` operator's semantic contract with
"complete eligible-pool exhaustion returns terminal without waiting". The
topology must not change.

## 9. Maps Needing Contract/Binding Edits (for the parent)

No map is edited by this worker. The parent's implementation must update:

1. `docs/architecture/v3-resource-operation-map.yml`,
   resource `v3.provider.cooldown_probe_state` (around line 1208). Revise
   `exhaustion_rescue_rule`, `generation_state`, and `in_flight_rule` (lines
   1220-1222) so that the background owner is the explicit future-request
   recovery driver and a request never waits/resumes on complete exhaustion.
2. `docs/architecture/v3-function-map.yml`,
   feature `v3.provider_global_subscription_probe` (line 4679). Remove the
   ablated symbol `V3ProviderFailureRuntimeHealth::run_exhaustion_rescue_probes`
   (line 4755); keep `select_v3_expanded_target_with_exhaustion_rescue`
   (line 4757) and the advisory probe symbols.
3. `docs/architecture/v3-verification-map.yml`,
   the same feature (around lines 3121-3175). Tighten the positive/negative
   contract and add the new public Direct and Relay already-cooled black-box
   gates (section 10).
4. `docs/architecture/v3-mainline-call-map.yml`,
   chain `v3.provider_admission_rescue_entrypoints` (line 7057). Add one concise
   exhaustion-terminal semantic condition to each Direct/Relay step; keep the
   existing capacity and advisory-probe clauses.
5. `docs/architecture/v3-mainline-call-map.yml` error chain (around line 8776)
   and `v3-resource-operation-map.yml` lines 1139-1148 / 3444-3462: the current
   text already says terminal means no client commit. Add a clarification only
   if the reviewer finds the zero-candidate terminal path under-specified.

`docs/architecture/dagpipe/modules.json` and both graph JSON files likely need
no change (section 8).

## 10. Tests, Black-Box Controls, Regression Commands

### 10.1 Already-covered controls (do not regress)

- `responses_provider_concurrency_all_full_exhausts_without_queueing`
  (`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs` line 4733):
  capacity exhaustion, no queueing. Keep.
- `responses_direct_provider_http_error_never_reaches_the_client`
  (line 6437): provider-error boundary. Keep.
- `responses_selection_exhaustion_never_reaches_the_client` (line 6748):
  first-send exhaustion. Keep.

These do NOT, by themselves, cover a request that enters with the pool ALREADY
cooled.

### 10.2 Public already-cooled evidence (confirmed RED on the legitimate Chat -> Responses Relay entry)

The parent host run of the frozen `req09_pool_exhaustion_recovery_blackbox.rs`
consumer on `3ee73753f` returned exit 101
(`exhaustion-chat-consumer-20261006-r2/parent-chat-public-r1.log`,
`parent-chat-public-r1.exit`; lines 1731-1751). The log records
`running 3 tests`, then:

- `req09_pool_exhaustion_relay_openai_chat_to_responses_disconnects_before_recovery_blackbox`
  FAILED at the already-cooled assertion: "the already-cooled request must
  transport-disconnect before recovery; it did not within 1.5s".
- `req09_pool_exhaustion_disconnects_then_recovers_for_a_new_request_blackbox`
  passed.
- `req09_pool_exhaustion_relay_responses_to_openai_chat_disconnects_then_recovers_blackbox`
  passed.

The failing case is a legitimate cross-protocol entry: `POST
/v1/chat/completions` with ordinary Chat `messages`, OpenAI Chat Relay to a
Responses provider, and a stable `x-routecodex-session-id`. It does not use an
unpaired `function_call_output`, fabricated remote history, or a local
continuation. The test first cools the only eligible identity with a controlled
503, then sends an already-cooled request. That request is held past the 1.5s
`DISCONNECT_BUDGET`, so the request-owned hold loop at
`provider_cooldown_rescue.rs:493-609` is reachable from this public entry. This
is the required public RED.

The earlier green results remain valid controls and limit evidence:
`exhaustion-public-consumer/relay-entry-r4/parent-same-session-red.log` and the
earlier `exhaustion-public-consumer/entry-cooled-r3/parent-main359-red.log`
showed the `/v1/responses` Direct and Responses Relay already-cooled requests
disconnect promptly. Those entries run the fresh, rescue-less protocol plan
first (§3.6), so they do not reach the runtime hold loop. The earlier orphan
probe that used an unpaired `function_call_output` is retained only as a
rejected discriminator; it is not the basis of the new RED.

Confirmed reason the standard public `/v1/responses` already-cooled request
disconnects promptly instead of holding (§3.6): the Server runs a fresh,
rescue-less protocol plan before the runtime (`endpoint_handlers.rs:164-245` ->
`direct_protocol_plan.rs:146`). On an already-cooled pool that plan returns
`TargetPoolExhausted` (`direct_protocol_plan.rs:156-169`), and the handler
returns `provider_terminal_response(NoResponse)` (`endpoint_handlers.rs:208`),
so the runtime hold loop is never reached. The in-request Responses Relay
re-selection after the first 503 also terminates immediately, because the
failed candidate is request-locally excluded
(`responses_relay_runtime_inner.rs:498`), so
`v3_exhaustion_is_cooldown_only` returns false
(`provider_cooldown_rescue.rs:638`) and `Exhausted` is returned at line 542.
The legitimate Chat -> Responses Relay entry does not use that fresh Responses
protocol plan, so it reaches the hold branch and reproduces the defect.

The earlier claim that "Direct's caller disables exhaustion rescue" is WRONG:
the real Direct path also enables it
(`direct_kernel_entrypoints.rs:11` + `direct_state.rs:219`; the disable at
`direct_protocol_plan.rs:450` is dry-run only). Both Direct and Relay enable
the flag; the boundary plan, not the flag, is why the standard public
already-cooled Responses requests terminate promptly.

The fix must keep the future-admission path and remove the current-request
wait/resume path. A later NEW request is restored only when the independent
background or management probe succeeds and publishes the restored availability
generation.

### 10.3 Required new public Direct + Relay black-box controls

Add real public consumers that, from a real aggregate server and a real loopback
upstream:

1. Direct `/v1/responses`: pre-cool the only eligible identity, then send a
   request. Assert prompt transport disconnect for THIS request before any
   recovery, no client HTTP error status, no provider error detail, and the
   request never reaches the upstream. Then let the background probe succeed and
   assert a NEW request returns `200` with the healthy payload.
2. Relay (cross-protocol) entry: same shape through the Relay runtime, asserting
   the same no-error-frame / no-resume / new-request-recovery contract.
3. A negative control: with one healthy eligible candidate remaining, assert the
   request still switches and completes (no false exhaustion).
4. A cancellation control: a client disconnect during exhaustion stays
   request-local and health-neutral.

### 10.4 Regression commands

Unit/policy (runtime):

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs \
  -p routecodex-v3-runtime \
  --lib provider_failure_runtime_policy::tests::cooldown_exhaustion
```

Public black-box (server), Direct, Responses Relay, and legitimate Chat ->
Responses Relay:

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs \
  -p routecodex-v3-server \
  --test req09_pool_exhaustion_recovery_blackbox -- --nocapture
```

Compile-only first, then full run on a host where loopback bind is permitted.
On `3ee73753f` the parent run returns exit 101: the legitimate Chat -> Responses
case fails the already-cooled 1.5s disconnect assertion while the two
`/v1/responses` controls pass. The exact public controls are
`req09_pool_exhaustion_disconnects_then_recovers_for_a_new_request_blackbox`,
`req09_pool_exhaustion_relay_responses_to_openai_chat_disconnects_then_recovers_blackbox`,
and
`req09_pool_exhaustion_relay_openai_chat_to_responses_disconnects_before_recovery_blackbox`.
Do not weaken the already-cooled assertions to turn any run green.

## 11. Validation Record (this worker)

Commands run from the worktree root at input SHA
`3ee73753f5b638c863f0870994b9aea57ae15e87`. Exact commands, results, and any raw
errors are also recorded in `notes.md`.

```sh
dagpipe graph validate docs/architecture/dagpipe/v3.operation_runner.request.graph.json
dagpipe graph validate docs/architecture/dagpipe/v3.operation_runner.error.graph.json
git diff --check
```

See `notes.md` and `result.md` in the records directory for the observed
exit codes and output.

Alignment r2 (`exhaustion-evidence-r2`, 2026-10-06 UTC) is documentation-only:
it read the design review r1 PASS
(`.agent-collab/review/pool-exhaustion-design-r1-20261006/review.final.md`),
the new public evidence
(`exhaustion-public-consumer/relay-entry-r4/parent-same-session-red.log` +
`.exit`), and the read-only source listed in §3.6. It ran only
`git diff --check` (see `result.md`). No product, test, map, graph, commit,
push, install, restart, or runtime action was taken.

## 12. Open Items And Non-Claims

- This is a design. No behavior is fixed. No implementation review PASS is
  claimed. The independent design review r1 (oauth/gpt-6.1-sol) completed with
  PASS and two P2 corrections, which this alignment folds in; that is design
  admission only, not implementation approval.
- CONFIRMED RED: the source hold branch
  (`provider_cooldown_rescue.rs:493-609`) exists, and the legitimate OpenAI Chat
  -> Responses Relay already-cooled request is held past the 1.5s
  `DISCONNECT_BUDGET` on `3ee73753f` (§10.2). The standard `/v1/responses`
  Direct and Responses Relay controls terminate promptly at the Server protocol
  plan (§3.6, §10.2).
- The earlier unpaired-`function_call_output` probe is retained only as a
  rejected discriminator. The legitimate Chat -> Responses Relay entry supplies
  the public RED that authorizes product change on this source branch.
- The parent owns any design delta review, implementation, integration, and
  retained evidence/cleanup. Public reproduction is complete.
- The §8 `ProviderLocalFailure` design is DISTINCT and does not authorize this
  change.
