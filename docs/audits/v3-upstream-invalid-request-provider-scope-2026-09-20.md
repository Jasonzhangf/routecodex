# V3 upstream invalid-request provider scope fix — 2026-09-20

## Bug

- Bug: `5c8f01f`
- Request: `openai-responses-router-gpt-5.5-20260920T065810875-327287-13816`
- Failure: `kdns:key2:deepseek-v4.1-flash` returned an HTTP-200 SSE error frame
  with `error.type=invalid_request_error` and upstream text `403 request
  illegal (code 11140)`.
- The request-local invalid-request classification must remain candidate
  scoped: the failed model is excluded, but sibling models in the same provider
  family remain eligible and provider health/cooldown is not mutated.

## Owner And Change

- Owner: `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
  `request_local_provider_failure_scope()`.
- `ProviderReqCompat06ProviderCompat`, `provider_request_compat_error`, and
  `invalid_request_error` remain candidate-local and health-neutral.
- Provider transport and genuine provider-health failures remain
  provider-scoped.

## Verification

The first candidate widened `invalid_request_error` to provider scope and the
workspace gate exposed the regression:

```text
goaichat_glm_http400_switches_sibling_model_client_never_400_or_502_json FAILED
goaichat_glm_http400_switches_sibling_model_client_never_400_or_502_sse FAILED
left: 502
right: 502
```

Green evidence after the correction:

- Focused regression:
  `relay_upstream_invalid_request_error_keeps_same_provider_sibling_health_neutral`
  PASS 1/1.
- GLM400 JSON/SSE isolation tests PASS 2/2.
- Provider failure policy tests PASS 50/50.
- `npm run test:v3-provider-action-gate` PASS.
- `npm run verify:v3-provider-action-gate` PASS.
- `npm run test:v3-provider-action-gate-red-fixtures` PASS (54 mutations
  rejected).
- `npm run test:v3-provider-session-cooldown` PASS.
- `npm run verify:v3-provider-session-cooldown` PASS.
- `npm run test:v3-provider-session-cooldown-red-fixtures` PASS (30/30).
- `npm run test:v3-provider-health-contract` PASS.
- `npm run verify:v3-provider-key-health-model-binding` PASS.
- `npm run test:v3-provider-key-health-model-binding-red-fixtures` PASS.
- `npm run test:v3-provider-global-cooldown-persistence` PASS 7/7.
- `npm run verify:v3-resource-map` PASS.
- `npm run verify:v3-module-boundaries` PASS.
- `npm run verify:v3-architecture-ci` PASS 39/39 sub-gates.
- `cargo +stable fmt --manifest-path v3/Cargo.toml --all -- --check` PASS.
- `git diff --check` PASS.

## Runtime Boundary

This record proves source-candidate verification only. Merge, rebuild, managed
restart, and same-entry replay are reported separately after review PASS.
