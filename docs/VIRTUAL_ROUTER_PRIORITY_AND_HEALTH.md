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

## Selection Engine I/O (for API/WebUI alignment)

The core selection call is conceptually:

```
input: {
  routeName,
  tier.targets[],
  request features (tokens/tools/attachments),
  metadata (sessionId/conversationId/antigravitySessionId, excludedProviderKeys, instructions),
  provider registry,
  quotaView? (optional),
  health state
}

output: {
  providerKey | null,
  poolTargets,
  tierId,
  failureHint?
}
```

When no `providerKey` is selectable in the current pool, the router continues to the next pool/route according to routing policy.
This means selection output is always deterministic and explainable via `failureHint` and hit logs.

## Session Binding (Claude/Gemini)

`antigravitySessionBinding` is configured under:

- `virtualrouter.loadBalancing.aliasSelection.antigravitySessionBinding`
- Allowed values: `"lease"` (default), `"strict"`

Current implementation scope:

- Antigravity **Gemini** aliases use session binding/lease.
- Antigravity **Claude** aliases are not bound by Gemini lease scope.
- Strict binding depends on persisted Antigravity signature pin state (session ↔ alias pin).

Rules:

- `"lease"`:
  - session prefers its last committed alias when that alias is still selectable;
  - can rotate to another alias when needed (quota/health/exclusion), then commits the new alias on provider success.
- `"strict"`:
  - once a session has a pinned alias, it will not rotate to another Antigravity Gemini alias;
  - if pinned alias becomes unavailable, router falls back to other providers/routes instead of cross-alias retry.

Persistence behavior:

- With persistence available: strict pin survives restart and binding is restored.
- Without persistence / degraded persistence: host clears pins for safety, so router will not keep stale strict stickiness.

## quotaView Gating Principle

`quotaView` is the source of truth when injected:

- Router availability uses `quotaView` (`inPool`, `cooldownUntil`, `blacklistUntil`).
- Router-local cooldown TTLs are bypassed in quotaView mode.
- Health/series cooldown signals are still recorded, but final selectability is gated by quotaView.

If `quotaView` is absent:

- router falls back to local health/cooldown state for availability decisions.

## Config Example (WebUI field names)

Use the same field names in JSON and WebUI forms:

```json
{
  "virtualrouter": {
    "loadBalancing": {
      "strategy": "round-robin",
      "aliasSelection": {
        "sessionLeaseCooldownMs": 300000,
        "antigravitySessionBinding": "lease"
      },
      "healthWeighted": {
        "enabled": true,
        "baseWeight": 100,
        "minMultiplier": 0.5,
        "beta": 0.1,
        "halfLifeMs": 600000,
        "recoverToBestOnRetry": true
      }
    }
  }
}
```

For strict mode:

```json
{
  "virtualrouter": {
    "loadBalancing": {
      "aliasSelection": {
        "antigravitySessionBinding": "strict"
      }
    }
  }
}
```

## Migration Notes (legacy sticky/health -> current model)

- Legacy sticky-first behavior:
  - moved to explicit routing instructions and session-binding policy.
- Legacy router-local health dominance:
  - in quota mode, replaced by `quotaView` gating to avoid split-brain decisions.
- Legacy implicit alias stickiness:
  - replaced by explicit `aliasSelection.antigravitySessionBinding` (`lease`/`strict`) and observable hit reasons.

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

## Context-weighted selection (preserve large windows)

Some clients have a fixed maximum usable context (e.g. `200k`). When multiple candidates are all "safe" for the current
request, we want to bias traffic toward smaller effective safe windows early, so that larger windows remain available
later when context grows.

This is implemented as an additional multiplier on top of existing weights (health-weighted / legacy), and is only
applied inside the same pool bucket and only for candidates in `ContextAdvisor.safe`.

Config (under `virtualrouter.loadBalancing.contextWeighted`):

- `enabled` (default `false`)
- `clientCapTokens` (default `200000`)
- `gamma` (default `1`, proportional compensation)
- `maxMultiplier` (default `2`)

Effective safe window (`T_safeEff`) used for compensation:

- `T_eff = min(modelMaxTokens, clientCapTokens)`
- `reserve = ceil(T_eff * (1 - warnRatio))` (warnRatio comes from `virtualrouter.contextRouting.warnRatio`, default `0.9`)
- `slack = max(0, modelMaxTokens - clientCapTokens)`
- `reserveEff = max(0, reserve - slack)` (models with slack can "absorb" the reserve)
- `T_safeEff = T_eff - reserveEff`

Then, within the bucket:

- `multiplier = min(maxMultiplier, (max(T_safeEff) / T_safeEff) ^ gamma)`
