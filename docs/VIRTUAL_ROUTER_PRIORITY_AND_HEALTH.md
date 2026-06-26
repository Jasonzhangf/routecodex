# Virtual Router: Priority + Health-Weighted Selection

This document describes how RouteCodex/llmswitch-core selects a `providerKey` from a route pool, with emphasis on:

- `mode: "priority"` pools (strict priority, failover only when needed)
- `mode: "round-robin"` pools (health-weighted AWRR)
- How health signals affect selection order and weights

## Terms

- **providerKey**: `providerId.<keyAlias>.<modelId>` (example: `antigravity.gbplasu1.claude-sonnet-4-5-thinking`)
- **pool**: A `RoutePoolTier` (`routing.<routeName>[]`), containing `targets` and a `mode`
- **quotaView**: Shadow regression input used by tests to prove TS quota data cannot override Rust route truth. It is not a selection source of truth.

## Selection Engine I/O (for API/WebUI alignment)

The core selection call is conceptually:

```
input: {
  routeName,
  tier.targets[],
  request features (tokens/tools/attachments),
  metadata (sessionId/conversationId/antigravitySessionId, excludedProviderKeys, instructions),
  provider registry,
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

## Provider stickiness

Provider sticky and alias sticky queues are not Virtual Router primitives.
Non-continuation requests are routed only by the current request, pool policy, quota, and health.

Continuation handling is separate:

- direct/remote Responses continuation restores the recorded provider key because upstream owns the context;
- local/relay continuation restores local context only and does not pin a provider.

## Shadow Regression Principle

`quotaView` is retained only as a shadow regression surface in tests.

- Rust route truth remains authoritative.
- TS `quotaView` may be poisoned in tests to prove it cannot override Rust decisions.
- `quotaView` must not be treated as the primary selection source in docs or runtime wiring.

## Config Example (WebUI field names)

Use the same field names in JSON and WebUI forms:

```json
{
  "virtualrouter": {
    "loadBalancing": {
      "strategy": "round-robin",
      "healthWeighted": {
        "enabled": true,
        "baseWeight": 100,
        "minMultiplier": 0.5,
        "beta": 0.1,
        "halfLifeMs": 600000
      }
    }
  }
}
```

## Migration Notes (legacy sticky/health -> current model)

- Legacy sticky-first behavior:
  - moved to explicit routing instructions and session-binding policy.
- Legacy router-local health dominance:
  - replaced by Rust route truth; TS shadow inputs are only used to prove they cannot override it.
- Legacy implicit alias stickiness:
  - removed. Use normal pool priority/weighted routing plus shared health cooldown.

## Priority Pools (`mode: "priority"`)

Goal: always use the highest-priority candidate first, and only fall back when the current best becomes unavailable.

### Base priority (config order)

When targets do not carry explicit per-target priority metadata at runtime, the router derives a deterministic base score from the target list ordering:

- Treat each contiguous `(providerId, modelId)` block in `tier.targets` as a **target group**
  - This matches how `bootstrapVirtualRouterConfig()` expands a single routing entry into multiple auth aliases
- Group base scores: `100, 90, 80, ...` (step `10`) by appearance order
- Inside a group (different aliases for the same provider+model), alias scores: `100, 99, 98, ...` (step `1`)

This makes it difficult for a single transient failure to instantly flip priority to the next target, while still allowing repeated errors to degrade a key.

### What “exhausted” means

In priority mode, a higher-priority key is considered exhausted only when it is **not selectable** due to:

- health manager unavailable (tripped/cooldown)
- routing instructions / user exclusions

Only then will routing advance to the next candidate in priority order.

## Round-Robin Pools (`mode: "round-robin"`) — Health-Weighted AWRR

Goal: evenly distribute traffic across healthy keys, while reducing the hit rate of recently failing keys (without starving them).

Implementation: deterministic smooth weighted round-robin (no randomness).

### Health-weighted weights (AWRR)

If enabled (`loadBalancing.healthWeighted.enabled=true`) and Rust health metadata is available, the router computes:

- `weight = baseWeight * multiplier`
- `multiplier` decreases with recent error signals
- `multiplier` recovers over time using exponential decay (half-life)
- `multiplier` is floored by `minMultiplier` (prevents starvation)

Defaults live in:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health_weighted.rs`

Key knobs (configurable under `loadBalancing.healthWeighted`):

- `baseWeight` (default `100`)
- `minMultiplier` (default `0.5`)
- `beta` (default `0.1`) — one error reduces weight by ~10%
- `halfLifeMs` (default `10min`)

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
