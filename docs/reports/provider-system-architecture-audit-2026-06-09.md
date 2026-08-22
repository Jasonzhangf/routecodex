# Provider System Architecture Audit - 2026-06-09

## Scope

This audit covers the RouteCodex provider runtime architecture around provider execution, direct passthrough, provider failure policy, ErrorErr chain ownership, metadata isolation, and function-map / verification-map coverage.

Primary files inspected:

- `src/providers/core/runtime/base-provider.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `src/providers/core/runtime/provider-error-catalog.ts`
- `src/providers/core/runtime/provider-failure-policy-impl.ts`
- `src/providers/core/utils/provider-error-reporter.ts`
- `src/server/runtime/http-server/index.ts`
- `src/server/runtime/http-server/provider-direct-pipeline.ts`
- `src/server/runtime/http-server/router-direct-pipeline.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`
- `src/server/utils/http-error-mapper.ts`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`

## Target Architecture

Provider/runtime/direct/executor errors must use one explicit error chain:

```text
ErrorErr01SourceRaised
  -> ErrorErr02HostCaptured
  -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied
  -> ErrorErr05ExecutionDecision
  -> ErrorErr06ClientProjected
```

Error is a contract module, not a second `ErrorHandlingCenter`.

- `provider-error-reporter.ts` owns ErrorErr01/02 capture and report.
- `provider-error-catalog.ts` / `provider-failure-policy-impl.ts` own ErrorErr03 classification.
- llmswitch-core provider runtime ingress / Rust Virtual Router owns ErrorErr04 router policy application.
- Request/direct executor code consumes ErrorErr05 execution decisions only.
- `http-error-mapper.ts` owns ErrorErr06 client projection only.

## Findings

### F1. Provider runtime local retry was a bypass

Before closeout, `BaseProvider` had provider-local `autoRetry` logic that caught provider send failures and called `sendRequestInternal(processedRequest)` again inside the provider runtime. That bypassed the ErrorErr / Router policy path for intermediate failures and could silently absorb errors before policy classification.

Required fix: physically remove provider-local retry semantics and ensure a provider send failure enters `handleRequestError -> ErrorErr01-06`.

Current closeout status: fixed. `BaseProvider` now has a single `sendRequestInternal(processedRequest)` call. `src/providers/core/runtime/auto-retry-error-codes.ts`, `ProviderRuntimeProfile.autoRetry`, and provider profile `autoRetry` metadata were removed.

### F2. Provider-direct lacked the router-direct ErrorErr hook

`router-direct-pipeline.ts` already exposed an `onProviderError` hook and rethrew the original provider error after awaited reporting. `provider-direct-pipeline.ts` lacked the same boundary, so provider-mode direct failures depended on provider internals and were not locked by the direct path contract.

Required fix: add a provider-direct audit context and awaited `onProviderError` hook, then wire the HTTP server caller to `resolveRequestExecutorProviderFailurePlan`.

Current closeout status: fixed. Provider-direct now calls `await options.onProviderError?.(error, auditContext)` and rethrows the original error. The HTTP server logs `provider-direct.send.error` and consumes the ErrorErr05 decision wrapper without rewriting direct payloads.

### F3. Error module was not queryable in function-map as a full contract

Before closeout, `error.provider_failure_policy` and `error.backoff_action_queue` existed, but the function map did not expose a top-level ErrorErr contract, ErrorErr05 consumer boundary, or ErrorErr06 projection owner.

Required fix: add function-map and verification-map rows with source anchors and required gates.

Current closeout status: fixed. Added:

- `error.pipeline_contract`
- `error.execution_decision_consumer`
- `error.client_projection`

Existing rows remain:

- `error.provider_failure_policy`
- `error.backoff_action_queue`

### F4. Architecture gates needed to enforce the written rule

The previous architecture checks covered some raw bypass patterns, but did not explicitly forbid provider-local retry revival, autoRetry config/runtime revival, or provider-direct ErrorErr bypass.

Required fix: add a static architecture gate and wire it into architecture CI.

Current closeout status: fixed. Added `scripts/architecture/verify-error-pipeline-contract.mjs` and package script `verify:error-pipeline-contract`; wired into `verify:architecture-ci`.

The gate checks:

- `BaseProvider` has exactly one `sendRequestInternal(processedRequest)` call.
- `BaseProvider` request catch awaits ErrorErr reporting before rethrow.
- production provider request/runtime paths do not call fire-and-forget `emitProviderError`.
- provider runtime/config/profile code does not expose `autoRetry`.
- `auto-retry-error-codes.ts` stays physically deleted.
- provider-direct exposes and awaits `onProviderError`.
- HTTP server provider-direct path logs `provider-direct.send.error` and tags `source: 'provider-direct'`.
- provider policy/direct/executor modules do not import or depend on `ErrorHandlingCenter`.
- raw `reportProviderErrorToRouterPolicy({ ... })` construction remains inside the ErrorErr02 owner.

### F5. Metadata leak boundary was not the primary blocker

Existing metadata boundary gates passed during the audit. The main architectural issue was not normal payload metadata leakage; it was control-plane determinism around local retry, direct error reporting, and queryable Error owners.

## Verification Evidence

Passing evidence collected during closeout:

```bash
npm run llmswitch:ensure
npm run verify:provider-failure-ban-blackbox
npm run verify:error-pipeline-contract
npm run verify:architecture-error-chain-bypass
npm run verify:function-map-compile-gate
npm run verify:architecture-provider-specific-leaks
npm run verify:architecture-metadata-leak-boundary
npm run verify:architecture-fallback-denylist
npx tsc --noEmit --pretty false
npm run build:min
npm run jest:run -- --runInBand --runTestsByPath \
  tests/server/runtime/http-server/provider-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/router-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/error-pipeline-contract.spec.ts \
  tests/providers/core/runtime/provider-auto-retry-business-error.spec.ts \
  tests/providers/core/runtime/provider-2056-classification.spec.ts \
  tests/providers/core/runtime/provider-error-catalog.spec.ts \
  tests/server/http-server/http-server-bootstrap.deepseekweb.spec.ts \
  tests/server/runtime/http-server/http-server-runtime-setup.provider-merge.spec.ts
```

Observed blackbox result:

- `verify:provider-failure-ban-blackbox` returned `{ "ok": true }`.
- 503 on primary entered `[provider-switch]` and rerouted to backup.
- Port isolation scenario preserved independent 5555/6666 state.

Runtime smoke:

- Temporary `dist` server on random local port returned `/health` HTTP 200 and `/v1/models` HTTP 200 with 292 models on built version `0.90.3045`; because it used minimal config, `pipelineReady=false` there is not a release readiness signal.
- Existing live ports `5520` and `5555` returned `/health` HTTP 200 with `status=ok`, `ready=true`, `pipelineReady=true`, version `0.90.3044`, and `/v1/models` HTTP 200 with 292 models. The new build was not installed/restarted onto those live ports during this audit.

## Remaining Risks

1. The old `emitProviderError` wrapper remains exported for compatibility with existing tests and any non-request observation callers, but production `src` paths are now gated away from using it outside the ErrorErr02 owner.
2. `provider-error-classifier.ts` is still a provider runtime adapter around catalog/failure-policy inputs; it should not grow into a second classification center.
3. This audit built `dist` but did not install/restart the live RouteCodex service with version `0.90.3045`; live GET smoke proves the current installed runtime remains healthy, not that the new build is deployed.

## Closeout Rule

Future provider/runtime/direct/executor error work must first locate the ErrorErr node owner in `docs/architecture/function-map.yml`, then run the required verification-map gates. Do not add provider-local retry, `autoRetry`, local cooldown/health policy, raw Router policy event construction, or direct payload rewrites.
