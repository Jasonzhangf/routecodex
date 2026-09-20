# V3 upstream invalid-request provider scope fix — 2026-09-20

## Bug

- Bug: `5c8f01f`
- Request: `openai-responses-router-gpt-5.5-20260920T065810875-327287-13816`
- Failure: `kdns:key2:deepseek-v4.1-flash` returned an HTTP-200 SSE error frame
  with `error.type=invalid_request_error` and upstream text `403 request
  illegal (code 11140)`.
- Before the fix, `request_local_provider_failure_scope()` treated
  `invalid_request_error` as local provider compat. The provider family was
  not excluded and provider health/cooldown was not updated.

## Owner And Change

- Owner: `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
  `request_local_provider_failure_scope()`.
- Only `ProviderReqCompat06ProviderCompat` and
  `provider_request_compat_error` remain candidate-local and health-neutral.
- Upstream response-stage failures, including
  `V3ProviderRespInbound01Raw/invalid_request_error`, are provider scoped.

## Verification

Red evidence before the source fix:

```text
left:  {"first:key:test"}
right: {"first:key:sibling", "first:key:test"}
```

Green evidence on the candidate:

- Focused regression:
  `relay_upstream_invalid_request_error_excludes_provider_family_and_records_health`
  PASS 1/1.
- Provider compat tests PASS 5/5.
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
