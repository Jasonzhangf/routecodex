# Antigravity recoverable-error routing contract

This document defines the default Antigravity routing behavior for recoverable provider errors.
Provider sticky and alias queue pinning are no longer Virtual Router primitives.

> Status: updated 2026-05-29.

## Contract

1. **No provider sticky**
   Antigravity aliases are selected by the same Virtual Router pool rules as every other provider.
   A successful request does not pin the next non-continuation request to the same alias.

2. **Recoverable errors use the shared provider failure policy**
   HTTP 429/5xx/network-style recoverable errors are classified by the common provider failure policy.
   Any real provider error counts as one strike. Three consecutive strikes trigger a 30 minute cooldown for
   that provider key. If another provider is available in the current route chain, routing switches immediately
   instead of retrying the same provider key.

3. **Cooldown removes the failing key from the candidate pool**
   Cross-request health/cooldown follows the shared 3-strike/30 minute cooldown contract. A cooled key is not
   selectable until the cooldown expires and the provider becomes eligible again.

## Implementation truth

- Error classification: `src/providers/core/runtime/provider-failure-policy-impl.ts`
- Retry / reroute orchestration: `src/server/runtime/http-server/request-executor.ts`
- Candidate selection and health gating: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`

Do not reintroduce alias queue pinning, provider sticky rules, same-provider recoverable backoff, or passive
reprobe gates for Antigravity. If a provider needs special transport handling, implement it below provider
runtime without changing Virtual Router selection semantics.
