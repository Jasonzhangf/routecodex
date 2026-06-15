# /goal: Direct Path Error Reroute + Candidate Exhaustion

## Target
Close the router-direct / provider-direct error flow so provider execution errors always return to the unified policy center, count + cool down + reroute, and only project to the client when the candidate set is exhausted. Rust Virtual Router remains the single owner of `primary_exhausted -> default_pool` selection; host code may only consume the plan, never synthesize fallback.

## Reference Docs
- [docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md](/Users/fanzhang/Documents/github/routecodex/docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md) (main plan, F1-F10 + D1-D4 + Phase 6.5)
- [docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md](/Users/fanzhang/Documents/github/routecodex/docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md) (out-of-scope SSE incomplete gap, registered separately)
- [docs/error-handling-v2.md](/Users/fanzhang/Documents/github/routecodex/docs/error-handling-v2.md) §1.0
- [docs/design/provider-failure-policy-ssot.md](/Users/fanzhang/Documents/github/routecodex/docs/design/provider-failure-policy-ssot.md) Rule 1/3/4 boundaries
- `docs/architecture/function-map.yml` + `docs/architecture/verification-map.yml` (feature_id + gate)

## Execution Rules
1. Single policy center: VR + ProviderFailurePolicy + `request-executor-error-action-queue`. No second center.
2. `router-direct` / `provider-direct` keep payload/response passthrough; delete error passthrough.
3. Direct consumer must consume `ErrorErr05ExecutionDecision`; no client-visible provider 4xx while candidates remain.
4. `client_disconnect` (HTTP_499 + `client abort request`) classification must move upstream into `error.provider_failure_policy`; `affectsHealth=false`.
5. `ErrorErr06ClientProjected` requires `policyExhausted` / `candidateExhausted` marker; otherwise reject projection.
6. `primary_exhausted -> default_pool` stays Rust-owned; host only consumes the plan.
7. Physically delete legacy error design (direct report-only rethrow, 4xx early projection, local default fallback).
8. dev-flow: red test -> unique owner edit -> green -> old sample live replay -> live probe.
9. Reverse tests mandatory: `special_400` must not trigger reroute; only-one-provider pool must not loop; success must not be misclassified as failure.
10. `feature_id` edits sync function-map + verification-map + source anchor.

## Verification
1. Unit: `provider-failure-policy-client-disconnect-499`, `http-error-mapper-499-client-disconnect`, `http-error-mapper.policy-exhausted-gate`, `router-direct-pipeline.candidate-exhaustion`, `provider-direct-pipeline.candidate-exhaustion` (forward + reverse).
2. Gates: `verify:error-pipeline-contract`, `verify:provider-failure-ban-blackbox`, `verify:function-map-compile-gate`, `verify:architecture-error-chain-bypass`, `verify:architecture-provider-specific-leaks`, `verify:architecture-thin-wrapper-only`, `tsc --noEmit`.
3. Rust: `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`.
4. Live replay 5555 旧样本 (499 + `client abort request`): no client-visible 499 / `client abort request` body.
5. Live probe: 2+ candidates + 1 provider 5xx must switch to candidate 2.
6. Live probe: `client_disconnect` (force SSE close) - client must not receive 499.
7. Build/install/restart: `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`.
8. `/health` green on 5555/5520/10000; live `/v1/responses` SSE returns `response.completed` + `response.done`.

## Completion
- Red -> green for all 5 spec files, old sample live replay, new live probe, gate, build/install/restart all PASS.
- Legacy error design physically deleted.
- function-map + verification-map + source anchor synced.
- `note.md` condensed to `MEMORY.md`.
- Final report: what changed / how verified / remaining risk / next step.
