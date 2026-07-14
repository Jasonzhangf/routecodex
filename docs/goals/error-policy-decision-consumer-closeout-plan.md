# Error Policy Decision Consumer Closeout Plan

## 0. Problem Lock

This task is not a local patch.

The current behavior "provider error returns directly to client" is architecturally wrong. The fix must be a root-cause closeout that restores a single unified error path for every provider execution error:

`ErrorErr01 -> ErrorErr02 -> ErrorErr03 -> ErrorErr04 -> ErrorErr05 -> ErrorErr06`

The goal is to make the error center the only execution decision owner, keep provider switching active while route/default candidates still exist, and only project to client when the entire eligible pool is exhausted.

## 1. Objective

Close the provider error handling gap at the architecture level, not with a local patch.

All provider execution errors from relay, router-direct, and provider-direct must enter the unified `ErrorErr01 -> ErrorErr06` chain. `ErrorErr05ExecutionDecision` must be the only execution decision consumed before any client-visible projection. If route/default candidates remain, the system must continue by switching to the next eligible target. Only when the route pool and default pool are both exhausted may `ErrorErr06ClientProjected` return an error to the client.

## 2. Delivery Goals

1. Red tests lock the current bypass before implementation.
2. `provider-direct` and `router-direct` no longer compute-and-drop `ErrorErr05` results.
3. Direct paths consume the same decision contract as relay/request-executor.
4. `ErrorErr05ExecutionDecision` is the only projection gate.
5. Short error waits and provider cooldown are clearly separated:
   - action queue owns blocking wait sequence;
   - Rust VR health/policy owns provider strike/cooldown.
6. Existing report-only / rethrow-only direct behavior is physically removed or converted to a typed execution action.
7. Architecture docs, function map, mainline map, and verification map remain queryable and consistent.
8. Completion includes whitebox tests, blackbox tests, build/type gates, and live online replay.
9. No fallback, no second routing center, no silent client projection before `ErrorErr05` is consumed.

## 3. Scope

### In Scope

- `provider-direct` provider send/processIncomingDirect error path.
- `router-direct` provider execution error path.
- Relay/request-executor decision consumer parity.
- `ErrorErr05ExecutionDecision` consumption contract.
- `ErrorErr06ClientProjected` projection gate.
- Error action wait sequence contract if it differs from the target policy.
- Rust VR provider strike/cooldown verification for 3 strikes and 30-minute cooldown.
- Function map / verification map / mainline call map / wiki manifest updates when owner or edge changes.

### Out of Scope

- Provider payload transformation.
- Tool governance / Chat Process / servertool behavior unless a provider error crosses that path.
- Local fallback or second routing center in Host.
- Silent catch, best-effort retry, or compatibility shim that bypasses `ErrorErr05`.

## 4. Architecture Rules

1. Provider errors are not payload passthrough. Direct paths may passthrough request/response bodies, but error policy must be unified.
2. `ErrorErr05ExecutionDecision` must be consumed, not just constructed.
3. A caller may project to client only when `mayProject === true` and `policyExhausted === true`.
4. `mayProject` must remain derived from `routePoolRemainingAfterExclusion.length === 0 && defaultPoolAvailable === false`.
5. Host may not synthesize default routing. Default availability must come from VR/routing group truth.
6. `client_disconnect` remains health-neutral, non-reroutable, and non-provider-visible.
7. `special_400` remains request/contract-visible and must not poison provider health.
8. All other provider execution errors are eligible to switch provider until route/default candidates are exhausted.
9. No fallback, no swallowed exception, no report-only center, no rethrow-only direct branch.
10. In `priority` route mode, the highest-priority available target must remain selected until it becomes unavailable by health/exclusion; lower-priority targets such as `asxs` / `XL` may only appear after `ykk` is no longer selectable.

## 5. Required Red Tests First

Add or update tests so they fail on the current implementation before code changes.

### Red Test Group A: Decision Result Must Not Be Dropped

- `provider-direct` constructs an `ErrorErr05ExecutionDecision` with `mayProject=false`; the direct pipeline must not rethrow original provider error.
- Current expected red: `executeProviderDirectPipeline` calls `onProviderError` then `throw error`.
- Target green: caller receives a typed decision action to reroute or re-enter, not raw provider error.

### Red Test Group B: Direct Paths Must Consume ErrorErr05

- `provider-direct` 401/403/429/5xx/network error with available alternative/default provider must not be client-visible.
- `router-direct` 401/403/429/5xx/network error with available alternative/default provider must not be client-visible.
- Reverse case: when route pool and default pool are both empty, client projection is allowed.

### Red Test Group C: Projection Gate

- Calling client projection with `mayProject=false` must fail with `EARLY_PROJECTION_BLOCKED`.
- Legacy `details.policyExhausted` / `candidateExhausted` cannot authorize projection.
- Only full `ErrorErr05ExecutionDecision` can authorize `ErrorErr06`.

### Red Test Group D: Wait and Cooldown Policy

- Error action queue exposes the target wait sequence. Current target is `1s -> 2s -> 3s`; tests must assert exactly that sequence.
- Rust VR health/policy must prove three consecutive provider failures trip the provider into 30-minute cooldown.
- Success resets consecutive failure state.
- Cooldown expiry makes provider eligible again.

## 6. Implementation Process

### Phase 0: Map and Contract Lock

1. Read `docs/error-handling-v2.md`.
2. Read `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`.
3. Read `docs/design/provider-failure-policy-ssot.md`.
4. Read `docs/architecture/function-map.yml`, `verification-map.yml`, and `mainline-call-map.yml` for:
   - `error.provider_failure_policy`
   - `error.execution_decision_consumer`
   - `error.client_projection`
   - `virtual_router.primary_exhausted_to_default_pool`
5. Confirm unique owner and required gates before editing code.
6. If owner/query fails in one or two lookups, repair map/mainline first.

### Phase 1: Red Tests

1. Add focused unit/contract red tests for direct decision consumers.
2. Add blackbox red tests for provider-direct and router-direct candidate exhaustion.
3. Add projection gate red tests for `mayProject=false`.
4. Add or update wait/cooldown tests for target sequence and 3-strike cooldown.
5. Run the new focused tests and record red evidence in `note.md`.

### Phase 2: Typed Execution Action

Replace "compute decision then discard" with a typed action returned from the error consumer.

Required action model:

```text
ErrorErr05ExecutionDecision
  -> consume_error_err_05_execution_decision
  -> one of:
     - switch_current_pool_candidate
     - switch_default_pool_candidate
     - retry_same_provider_when_policy_allows
     - project_client_error_only_when_mayProject
     - terminate_client_disconnect
     - fail_fast_contract_error
```

Rules:

- `provider-direct` and `router-direct` must use this same action model.
- `provider-direct` must not always rethrow.
- `executeProviderDirectPipeline` must not unconditionally `throw error` after `onProviderError`.
- If a direct path cannot reroute by itself, it must return a typed re-entry request to the owning HTTP/VR layer rather than projecting.

### Phase 3: Direct Path Re-entry / Reroute

Implement direct-path continuation without creating a second router.

Valid options:

- Use existing VR/default-pool planner and re-enter the normal Hub/RequestExecutor path with explicit excluded providers.
- Or make direct path delegate to the unified executor consumer when `ErrorErr05` says `mayProject=false`.

Invalid options:

- Host-local fallback list.
- Provider-direct local routing table.
- Retrying by catching and mutating payload.
- Reusing `mapErrorToHttp` as the decision point.

### Phase 4: Projection Gate Enforcement

1. Ensure all HTTP handler projection paths require full `ErrorErr05ExecutionDecision` when projecting provider errors.
2. Delete any legacy projection based on raw provider status/code/message.
3. Keep `client_disconnect` non-projectable as currently specified.
4. Ensure `special_400` remains explicit and does not enter provider cooldown.

### Phase 5: Wait and Cooldown Alignment

1. Decide target wait sequence from current product rule:
   - For target `1s -> 2s -> 3s`, update code, docs, tests, and server contract output together.
   - If keeping `1s -> 2s -> 3s`, update product doc and confirm with Jason before implementation.
2. Keep provider cooldown in Rust VR health/policy, not TS action queue.
3. Verify:
   - three consecutive failures count against the same provider;
   - success resets consecutive count;
   - after threshold, provider is cooled for 30 minutes;
   - after cooldown expiry, provider re-enters selection.

### Phase 6: Docs and Gates

Update all affected artifacts in same change set:

- `docs/error-handling-v2.md`
- `docs/design/provider-failure-policy-ssot.md`
- `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- generated architecture wiki/manifest if required by existing scripts
- `.agents/skills/rcc-dev-skills/references/92-lessons-2026-06.md` only if a reusable workflow lesson is confirmed

## 7. Blackbox Test Design

Blackbox tests must prove runtime behavior from real entrypoints, not helper internals.

### Positive blackbox

1. First provider fails while another route/default candidate exists.
2. System switches to the next eligible provider.
3. Client receives the final success response, not the first provider error.
4. Logs show `ErrorErr05` was consumed before any client projection.

### Reverse blackbox

1. `client_disconnect` does not switch provider and does not poison health.
2. `special_400` remains client-visible and does not trigger provider switching.
3. When route pool and default pool are both empty, only then does the client see the projected error.

### Online replay rule

1. Blackbox cannot be a synthetic unit helper only.
2. After local green, replay on a real managed port.
3. Capture request id, sample path, health output, client body, and provider-switch evidence.
4. If live behavior differs from local behavior, treat the local result as incomplete.

## 8. Test Targets

### Whitebox / Contract Tests

- `tests/red-tests/error_chain_may_project_gate.test.ts`
- `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
- `tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts`
- `tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts`
- New or updated direct consumer tests proving returned action is consumed.
- Rust VR health/policy tests for 3-strike/30-minute cooldown.

### Blackbox Tests

Blackbox tests must exercise actual request entry behavior, not just helper functions.

Required cases:

1. `provider-direct` blackbox:
   - first provider returns 401/403/429/5xx;
   - another candidate/default provider is available;
   - client receives success from the switched provider;
   - raw first provider error is not visible to client.
2. `router-direct` blackbox:
   - same provider failure matrix;
   - route/default pool still has target;
   - no client-visible error before exhaustion.
3. Exhaustion blackbox:
   - route pool empty and default unavailable;
   - client receives mapped provider error through `ErrorErr06`;
   - error body does not leak provider secrets or raw auth details.
4. Reverse blackbox:
   - `client_disconnect` does not switch provider and does not poison health.
   - `special_400` is client-visible and does not switch provider.

### Architecture Gates

- `npm run verify:error-pipeline-contract`
- `npm run verify:provider-failure-ban-blackbox`
- `npm run verify:architecture-error-chain-bypass`
- `npm run verify:architecture-provider-specific-leaks`
- `npm run verify:architecture-nonadjacent-conversion`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:architecture-mainline-call-map`

### Build / Type Gates

- `npx tsc -p tsconfig.json --noEmit --pretty false`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- `npm run build:base`
- Rust focused cargo tests for VR health/default pool/error policy.

## 9. Online Replay / Live Verification

After local tests and build pass, install and restart the target managed port.

Required live procedure:

1. Build and install with Node 22:
   - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
2. Restart managed port:
   - `routecodex restart --port 5555`
3. Health gate:
   - `curl http://127.0.0.1:5555/health`
   - must show `status=ok`, `ready=true`, `pipelineReady=true`, installed version.
4. Live provider-error replay:
   - configure or select a route where the first provider deterministically returns 401/403/429/5xx or controlled provider failure;
   - ensure route/default has at least one healthy alternative;
   - send real request through `/v1/responses` and `/v1/chat/completions` when both entries are supported by the target route;
   - verify client does not receive first provider error;
   - verify logs show `ErrorErr05` decision consumed and provider switched;
   - verify final response comes from next provider/default provider.
5. Live exhaustion replay:
   - use a controlled route where all route/default candidates fail or are unavailable;
   - verify client error appears only after `mayProject=true`;
   - verify error projection is via `ErrorErr06`.
6. Live cooldown replay:
   - generate three consecutive failures for one provider in controlled route;
   - verify provider enters 30-minute cooldown in VR health/policy logs or state;
   - verify next request skips cooled provider and selects another target;
   - after simulated/controlled expiry or test clock fixture, verify provider becomes eligible again.
7. Priority-mode replay:
   - use a controlled `priority` pool where `ykk` is valid;
   - verify live requests keep selecting `ykk` and do not drift to `asxs` / `XL`;
   - then make `ykk` unavailable and verify lower-priority targets become eligible only after the failover condition is real.

## 10. Completion Criteria

The task is only complete when all of the following are true:

1. The unified error chain is the only path for provider execution errors.
2. Provider-direct and router-direct both consume `ErrorErr05` instead of returning raw provider errors.
3. The client only receives an error after route/default candidates are exhausted.
4. Whitebox, blackbox, reverse blackbox, build/type, architecture gates, and live replay all pass.
5. The live replay proves the fix on a real managed port, not just in tests.

Evidence to capture:

- request IDs;
- `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`;
- `~/.rcc/logs/server-<port>.log`;
- health output;
- final client response;
- provider switch logs;
- cooldown state/log evidence.

## 9. Acceptance Criteria

The work is complete only when all are true:

1. Current direct-path bypass has a red test that fails before implementation.
2. Red tests are green after implementation.
3. `provider-direct` no longer discards `ErrorErr05` result.
4. `provider-direct` no longer always rethrows provider error.
5. `router-direct` and relay share the same projection gate semantics.
6. Client-visible provider errors are impossible while route/default candidates remain.
7. `client_disconnect` and `special_400` reverse paths are still correct.
8. Wait sequence and 3-strike/30-minute cooldown are tested and documented.
9. Function map, verification map, mainline map, and docs are updated.
10. Whitebox tests, blackbox tests, architecture gates, build/type gates, and live replay all pass.
11. `note.md` records red evidence, green evidence, live request IDs, and remaining risks.
12. Verified reusable lessons are appended to `MEMORY.md` or local skill references only when backed by evidence.

## 10. Non-Goals / Anti-Patterns

- Do not fix this by only changing `provider-direct-pipeline.ts` catch behavior.
- Do not add another fallback/default provider list in Host.
- Do not add special handling for one provider or one HTTP status.
- Do not allow `onProviderError` to remain report-only.
- Do not let `mapErrorToHttp` decide whether routing should continue.
- Do not claim completion without blackbox and live replay.

## 11. Implementation Checklist

This section is the execution contract for the work. It is intentionally operational, not descriptive.

### 11.1 Fix sequence

1. Lock the current red sample and make it reproducible.
2. Confirm the unique owner for the bypass is the direct-path error consumer, not payload conversion or VR selection.
3. Add or update the minimal red tests first.
4. Change the unified error decision consumer so direct paths consume `ErrorErr05` instead of dropping it.
5. Ensure `mayProject=false` cannot reach client projection.
6. Re-run the focused tests and keep only the owner-level fix.
7. Run blackbox verification on the same request shape.
8. Re-run live managed-port replay and capture logs, request IDs, and sample paths.
9. Update docs, maps, and notes only after the runtime behavior is verified.

### 11.2 Delivery artifacts

The change is not deliverable unless all of the following exist and are consistent:

- updated source code for the unique error decision consumer;
- updated unit/contract tests for direct paths and projection gates;
- updated blackbox tests for provider-direct and router-direct;
- updated reverse blackbox tests for `client_disconnect` and `special_400`;
- updated verification gates and architecture maps where the owner or edge changed;
- live managed-port replay evidence with request IDs and log paths;
- note entry with red evidence, green evidence, and residual risk.

### 11.3 Test objectives

The test suite must prove all of the following:

- provider errors do not return directly while route/default candidates still exist;
- direct paths consume the same `ErrorErr05` contract as relay;
- `mayProject` is the only projection gate;
- `client_disconnect` stays health-neutral and non-reroutable;
- `special_400` stays client-visible and does not poison provider health;
- wait/backoff follows the target sequence exactly;
- provider strike counting and cooldown follow the 3-strike / 30-minute policy;
- client-visible error only appears after all eligible candidates are exhausted.

### 11.4 Blackbox requirements

Blackbox must be done at real entrypoints, not helper internals.

- Positive blackbox: first provider fails, system switches, client receives success from the next provider.
- Exhaustion blackbox: all eligible candidates fail, client receives projected error only after `mayProject=true`.
- Reverse blackbox: `client_disconnect` does not switch provider; `special_400` remains visible and health-neutral.
- Provider-direct and router-direct must both be covered.

### 11.5 Live replay requirements

After local green, rerun the same scenario on a managed live port.

- Use `routecodex restart --port <port>` and verify `/health`.
- Reproduce the same request shape from the blackbox case.
- Capture request ID, sample directory, server log path, client body, and provider-switch evidence.
- If live behavior differs from local behavior, the local result is incomplete and must not be claimed as done.

### 11.6 Completion signal

This task is complete only when:

- the direct-path bypass is gone at the owner level;
- red tests, whitebox tests, blackbox tests, build/type gates, and live replay all pass;
- the client only sees provider errors after pool exhaustion;
- the final evidence is written back into `note.md`.
