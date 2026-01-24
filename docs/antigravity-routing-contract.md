# Antigravity 429 + sticky-queue contract (standard behavior)

This document defines the *default* behavior for Antigravity routing under transient 429s. It is a hard requirement
for the "standard" execution path; any alternative behavior is considered legacy compatibility.

## Contract (3 rules)

1) **Success sticks**  
   Once an alias is selected for a `(providerId=antigravity, modelId)` group, routing keeps selecting that alias
   until the alias becomes unavailable (error / cooldown / blacklist).

2) **429 cools down + rotates to tail**  
   For capacity-style 429s (e.g. upstream "model capacity exhausted"), routing:
   - immediately applies a short cooldown to the failing `providerKey` (alias-level for Antigravity), and
   - on retry, rotates the failing alias to the tail of the sticky-queue, so the next attempt prefers a different alias.

3) **Fallback only when exhausted**  
   Retrying stays within Antigravity for the same model as long as any usable alias remains.
   Only when all aliases are excluded/cooling/blacklisted does routing fall back to other providers/routes.

## Where this is implemented

- **Retry hint plumbing (excludedProviderKeys)**: `src/server/runtime/http-server/request-executor.ts`
- **Sticky-queue selection + alias rotation**:
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/alias-selection.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection-select.ts`
- **Capacity-style 429 cooldown (alias-level for Antigravity)**:
  - `src/manager/modules/quota/provider-quota-daemon.model-backoff.ts`
  - `src/manager/modules/quota/provider-quota-daemon.events.ts`

