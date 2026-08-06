# Virtual Router ErrorErr05 Rustification Closeout Plan

## Goal

Close the remaining Virtual Router rustification gap on the availability/default-floor handoff into `ErrorErr05ExecutionDecision`.

Final state: Virtual Router availability, default-pool floor, remaining-candidate truth, last-provider truth, and router-direct reroute/rethrow decision inputs are produced by Rust-owned contracts. TypeScript executor/direct code may only pass request/runtime data into Rust, apply the returned plan, perform IO/logging, and project already-classified errors.

## Acceptance Criteria

- `vr.route_availability.mainline` has no Virtual Router-owned partial edge; `vra-04` is either anchored to a Rust-owned decision contract or explicitly moved under a non-VR ErrorErr05 consumer with no duplicated VR semantics.
- TS no longer computes default-pool availability, route-pool authority, last-provider truth, or remaining route candidates for VR availability decisions.
- `direct-decision.ts`, `request-executor.ts`, `index.ts`, and `request-executor-pipeline-attempt.ts` consume Rust/native decision output only.
- No fallback, local re-interpretation, provider-specific branch, silent recovery, or dual TS/Rust truth is introduced.
- Function map, mainline call map, verification map, wiki/mainline docs, and gates are synchronized.
- Completion is claimed only after focused white-box tests, black-box executor/direct tests, architecture gates, build, and same-entry smoke/replay evidence pass.

## Scope

In scope:

- Rust owner under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**` or a Rust `ErrorErr05` decision contract module if ownership is more precise.
- Native bridge under `src/modules/llmswitch/bridge/native-exports.ts`.
- TS consumer cleanup in:
  - `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
  - `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
  - `src/server/runtime/http-server/request-executor.ts`
  - `src/server/runtime/http-server/index.ts`
  - `src/server/runtime/http-server/direct-decision.ts`
- Contract docs:
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/architecture/verification-map.yml`
  - `docs/architecture/wiki/mainline-call-graph.md`
  - `docs/architecture/wiki/virtual-router-route-availability-mainline-source.md`
- Focused tests and architecture gates.

Out of scope unless required by the closeout:

- Full HTTP server Rust migration.
- Provider runtime transport/auth rewrites.
- Hub Pipeline non-routing rustification.
- Broad cleanup of unrelated dirty files or version bumps.

## Design Principles

- Rust owns route availability semantics; TS owns only transport, orchestration, IO, and projection.
- The decision contract must expose explicit states instead of booleans that force TS to recompute meaning.
- Empty ordinary route pool is not terminal while default pool still has an available last provider.
- Unknown target, route-not-configured, default-empty, and candidate-exhausted are distinct explicit states.
- No fallback path is allowed. Missing native capability or invalid Rust decision output must fail fast.
- Delete obsolete TS semantic helpers after replacement; do not leave unused duplicate logic.
- Multi-worker safety: do not reset, checkout, or remove unrelated changes. Stage only files touched for this task.

## Technical Plan

### Rust contract

Create or extend a Rust native contract that consumes:

- route name and selected/attempt route pool,
- route-scoped tiers and default-route tiers,
- excluded provider keys,
- primary-exhausted plan output where applicable,
- Rust VR availability/default-floor state where available,
- retry execution context needed by ErrorErr05.

The Rust output must include explicit fields such as:

- `mayProject`
- `shouldReroute`
- `defaultPoolAvailable`
- `remainingRouteCandidates`
- `routePoolAuthoritative`
- `verifiedLastProvider`
- `reasonCode`
- optional structured blocker/default-pool explanation for diagnostics.

Prefer a single declarative decision object over multiple TS-consumed primitive helpers.

### TS cleanup

Replace these TS-owned semantics:

- `resolveDefaultTierAvailableForErrorErr05`
- `buildErrorErr05DefaultAvailabilityTiers` if it does more than pass config shape unchanged
- `resolveRoutePoolAuthoritativeForRetry`
- `isReselectedExcludedProviderVerifiedLastProvider`
- `countRemainingRouteCandidates`
- direct/executor local recomputation of default-pool availability and remaining candidates

Acceptable TS after cleanup:

- extracting raw config/runtime data without semantic filtering,
- calling the Rust/native decision function,
- applying the returned plan,
- logging exact returned fields,
- fail-fast validation of malformed native output.

### Maps and docs

Update maps so the ownership is queryable:

- `vr.route_availability_floor` remains Rust SSOT.
- `virtual_router.primary_exhausted_to_default_pool` remains Rust SSOT.
- `error.execution_decision_consumer` may remain TS consumer only if it no longer owns VR availability semantics.
- `vr.route_availability.mainline` `vra-04` must not remain an ambiguous partial due to TS recomputation.

## Risk Points

- Accidentally moving ErrorErr05 orchestration into VR instead of only moving VR availability truth.
- Keeping TS booleans that still require local interpretation.
- Treating direct-path behavior as a fallback reroute instead of consuming explicit router policy.
- Breaking client-disconnect projection; client disconnect remains health-neutral and must not mutate excluded providers.
- Reusing stale route pools or metadata after a reroute; stale preselected route must be cleared where required by existing tests.

## Verification Matrix

White-box Rust:

- Rust unit tests for default-pool available vs default-empty.
- Rust unit tests for ordinary-route exhausted but default last-provider available.
- Rust unit tests for excluded provider reselected with verified last-provider vs alternatives still present.
- Rust unit tests for unknown target and route-not-configured explicit states.

TS/native bridge:

- Native wrapper validates malformed/missing capability fail-fast.
- TS consumer tests prove no local candidate/default-pool recomputation is needed.

Black-box executor/direct:

- `tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts`
- `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
- `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`
- `tests/server/handlers/responses-handler.routing-empty-pool.spec.ts`
- Add or update tests for positive and reverse cases:
  - success: ordinary route exhausted, default pool still available -> no terminal projection.
  - failure: route pool and default pool both empty -> terminal provider-not-available projection.
  - non-terminal: candidate exhausted but Rust says default available -> reroute/retry path.
  - already-terminal/client-disconnect: no provider mutation, no cooldown, correct projection.

Architecture/build gates:

- `npm run verify:vr-no-ts-runtime`
- `npm run verify:vr-forwarder-runtime`
- `npm run verify:vr-route-availability-default-floor`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-binding-pending-gate`
- `npm run verify:function-map-compile-gate`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`
- `git diff --check`

Live/replay:

- Use same-entry HTTP/direct or relay smoke that exercises provider failure with default pool still available.
- Use VR diagnostics status/dry-run before and after if a managed port is available.
- If no live endpoint is available, explicitly report the missing live evidence and do not claim production closeout.

## Implementation Steps

1. Re-read owner and mainline docs for `vr.route_availability_floor`, `virtual_router.primary_exhausted_to_default_pool`, and `error.execution_decision_consumer`.
2. Add failing tests that prove TS currently owns or can mis-own default-pool/remaining-candidate/last-provider decisions.
3. Implement the Rust decision contract and native export.
4. Replace TS helpers with a single native decision consumer path.
5. Physically delete obsolete TS semantic helpers and update tests to assert the new contract.
6. Update function map, mainline call map, verification map, and wiki source.
7. Run focused tests, architecture gates, build, and live/replay validation.
8. Do an architecture review: confirm no fallback, duplicate truth, provider-specific branch, MetadataCenter data-plane misuse, or handler/executor-local route policy remains.
9. Append durable findings to `MEMORY.md` or local skill only if a reusable new rule was learned.
10. Commit only this task's files with precise staging if validation is sufficient and worktree has unrelated changes.

## Definition of Done

- `vra-04` is no longer a VR rustification gap.
- TS executor/direct layers no longer compute VR availability/default-floor truth.
- Required tests and gates pass with evidence.
- Live/replay evidence is captured or the remaining live gap is stated plainly.
- Docs and maps match the code.
- No unrelated worker changes are modified, reverted, staged, or committed.
