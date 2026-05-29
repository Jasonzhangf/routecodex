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
   The first two attempts may retry the same provider key with backoff; the third consecutive recoverable
   failure excludes that provider key for the current request and re-enters normal routing so backup pools can win.

3. **Cooldown removes the failing key from the candidate pool**
   Cross-request health/cooldown follows the shared 10m/30m/5h ladder. A cooled key is not selectable until
   passive reprobe makes it eligible again.

## Implementation truth

- Error classification: `src/providers/core/runtime/provider-failure-policy-impl.ts`
- Retry / reroute orchestration: `src/server/runtime/http-server/request-executor.ts`
- Candidate selection and health gating: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`

Do not reintroduce alias queue pinning or provider sticky rules for Antigravity. If a provider needs special
transport handling, implement it below provider runtime without changing Virtual Router selection semantics.
