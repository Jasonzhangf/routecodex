# ErrorErr04 -> ErrorErr05 Rust Closeout Test Design

## Lifecycle

`ErrorErr04RouterPolicyApplied -> Rust execution-decision planner -> ErrorErr05ExecutionDecision -> TS effect executor`.

Rust owns classification consumption, exclusion/reroute decision, attempt-budget override, default-pool exhaustion, and `mayProject`. TS may record attempts, mutate the request-local excluded-key set exactly as directed, wait on abortable backoff, emit telemetry/logs, and execute the returned plan.

## Whitebox contract

- Positive: recoverable provider failure with an alternative returns `exclude_and_reroute`, adds only current provider, and keeps `mayProject=false`.
- Positive: current tier exhausted while default tier exists still returns retry/reroute and `mayProject=false`.
- Positive: verified last provider may retry within budget without premature exclusion.
- Negative: protocol-boundary failure never excludes or retries and is explicitly projectable.
- Negative: host response-contract/followup failures never masquerade as provider availability failures.
- Negative: empty current pool alone never proves global exhaustion when default pool remains available.
- Terminal: only current pool empty after exclusion plus default pool unavailable may set `policyExhausted=true` and `mayProject=true`.

## Module blackbox

- `request-executor-retry-execution-plan.ts` calls one owner-specific Rust planner and applies returned effects only.
- TS must not call `resolveProviderFailureClassification`, `resolveProviderFailureActionPlan`, `resolveProviderRetryExclusionPlan`, or locally derive `mayProject`/`policyExhausted`.
- Missing/invalid native output fails fast; no TS fallback planner.

## Project blackbox

- Provider 401/403/429/503 and stream-incomplete failures reroute while any route/default candidate exists.
- Client disconnect stays health-neutral and does not reroute/project provider 4xx.
- Success path remains unchanged.
- Already-terminal exhaustion projects once; non-terminal/still-running paths never project early.

## Required gates

- `npm run verify:error-pipeline-contract`
- `npm run verify:provider-failure-ban-blackbox`
- focused Rust planner tests and executor bridge tests
- `npm run verify:function-map-compile-gate`
- `npm run verify:hub-pipeline-native-reference-gate`
- `npm run verify:llmswitch-rustification-audit`
- native/base build, installed-runtime managed restart, same-entry success/failure replay

## Known gap

Current TS executor still imports and composes classification, action, exclusion, availability, and retry decisions. Red residue fixture must stay red until one Rust planner owns the full pure decision.
