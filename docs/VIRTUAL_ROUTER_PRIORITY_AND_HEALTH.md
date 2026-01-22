# Virtual Router: Priority + Health-Weighted Selection

This document describes how RouteCodex/llmswitch-core selects a `providerKey` from a route pool, with emphasis on:

- `mode: "priority"` pools (strict priority, failover only when needed)
- `mode: "round-robin"` pools (health-weighted AWRR)
- How quota/health signals affect selection order and weights

## Terms

- **providerKey**: `providerId.<keyAlias>.<modelId>` (example: `antigravity.gbplasu1.claude-sonnet-4-5-thinking`)
- **pool**: A `RoutePoolTier` (`routing.<routeName>[]`), containing `targets` and a `mode`
- **quotaView**: Host-injected view (`ProviderQuotaView`) that provides:
  - `inPool`, `cooldownUntil`, `blacklistUntil`
  - `priorityTier` (static)
  - `selectionPenalty`, `lastErrorAtMs`, `consecutiveErrorCount` (soft health signals)

## Priority Pools (`mode: "priority"`)

Goal: always use the highest-priority candidate first, and only fall back when the current best becomes unavailable.

### Base priority (config order)

When targets do not carry explicit per-target priority metadata at runtime, the router derives a deterministic base score from the target list ordering:

- Treat each contiguous `(providerId, modelId)` block in `tier.targets` as a **target group**
  - This matches how `bootstrapVirtualRouterConfig()` expands a single routing entry into multiple auth aliases
- Group base scores: `100, 90, 80, ...` (step `10`) by appearance order
- Inside a group (different aliases for the same provider+model), alias scores: `100, 99, 98, ...` (step `1`)

This makes it difficult for a single transient failure to instantly flip priority to the next target, while still allowing repeated errors to degrade a key.

### Error priority penalty (soft)

If `quotaView` provides `selectionPenalty` for a key, priority selection subtracts it from the derived base score:

```
effectivePriority = basePriority - selectionPenalty
```

`selectionPenalty` is produced by the host quota daemon:

- `selectionPenalty = consecutiveErrorCount` when the last error is within `ROUTECODEX_QUOTA_ERROR_PRIORITY_WINDOW_MS` (default `10min`)
- Resets to `0` on a successful response

This is a *soft* preference signal (it does not exclude the key); exclusion is controlled by `inPool/cooldownUntil/blacklistUntil`.

### What “exhausted” means

In priority mode, a higher-priority key is considered exhausted only when it is **not selectable** due to:

- health manager unavailable (tripped/cooldown)
- quotaView exclusion (`inPool=false` / active `cooldownUntil` / active `blacklistUntil`)
- routing instructions / user exclusions

Only then will routing advance to the next candidate in priority order.

## Round-Robin Pools (`mode: "round-robin"`) — Health-Weighted AWRR

Goal: evenly distribute traffic across healthy keys, while reducing the hit rate of recently failing keys (without starving them).

Implementation: deterministic smooth weighted round-robin (no randomness).

### Health-weighted weights (AWRR)

If enabled (`loadBalancing.healthWeighted.enabled=true`) and `quotaView` provides error metadata, the router computes:

- `weight = baseWeight * multiplier`
- `multiplier` decreases with `consecutiveErrorCount`
- `multiplier` recovers over time using exponential decay (half-life)
- `multiplier` is floored by `minMultiplier` (prevents starvation)

Defaults live in:

- `sharedmodule/llmswitch-core/src/router/virtual-router/health-weighted.ts`

Key knobs (configurable under `loadBalancing.healthWeighted`):

- `baseWeight` (default `100`)
- `minMultiplier` (default `0.5`)
- `beta` (default `0.1`) — one error reduces weight by ~10%
- `halfLifeMs` (default `10min`)
- `recoverToBestOnRetry` — on router retries, prefer the healthiest key first

## Model-capacity 429 handling (host quota)

Some upstreams report `HTTP 429` with capacity semantics (e.g. “No capacity available for model …”).
This is not “quota depleted” locally; switching keys often does not help.

RouteCodex treats this as a *model-series* cooldown:

- On capacity-exhausted 429, host applies an immediate cooldown to the entire `${providerId}.${modelId}` series
- Default cooldown: `60s`

Implementation:

- `src/manager/modules/quota/provider-quota-daemon.model-backoff.ts`

