# Antigravity 429 + sticky-queue contract (standard behavior)

This document defines the *default* behavior for Antigravity routing under transient 429s. It is a hard requirement
for the "standard" execution path; any alternative behavior is considered legacy compatibility.

> Status: stable as of 2026-02-02.

## Contract (3 rules)

1) **Success sticks**  
   Once an alias is selected for a `(providerId=antigravity, modelId)` group, routing keeps selecting that alias
   until the alias becomes unavailable (error / cooldown / blacklist).

2) **429/403 verify cool down + avoid all Antigravity on immediate retry**  
   For Antigravity gateway-protected errors (notably **HTTP 429** and **403 verify**), the host:
   - immediately excludes the current `providerKey` for the next retry attempt, and
   - sets `__rt.antigravityAvoidAllOnRetry=true`, so Virtual Router will prefer **non-Antigravity** candidates if any exist.

   Rationale: switching Antigravity accounts rapidly within a single request (especially during 4xx/429 states) can
   cascade into cross-account verification (403 verify) events. Retrying within the same request should be conservative.

3) **Alias rotation happens across requests, not within a single request**  
   Multi-alias load balancing remains `sticky-queue` for Antigravity, but it is applied **across requests** (via cooldown/health),
   not by hammering all aliases inside one request's retry loop.

## Where this is implemented

- **Retry hint plumbing (`excludedProviderKeys`, `__rt.antigravityAvoidAllOnRetry`)**:
  - `src/server/runtime/http-server/request-executor.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection.ts`
- **Sticky-queue selection (Antigravity default)**:
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/alias-selection.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection-select.ts`
- **Capacity-style 429 cooldown (alias-level for Antigravity / gemini-cli)**:
  - `src/manager/modules/quota/provider-quota-daemon.model-backoff.ts`
  - `src/manager/modules/quota/provider-quota-daemon.events.ts`
