# AWRR: Health-Weighted Round Robin (Design)

Status: **Design-only** (implementation pending approval)
Last updated: **2026-01-22**

## Background / Problem

In a multi-key pool, pure priority or naive round-robin can lead to:

- **Over-hitting a single “best” key** (hot-spot), while other healthy keys are underused.
- **Starvation** of a degraded key (never selected), making recovery detection slow and creating “dead” keys.
- After upstream errors (notably transient 429 capacity), requests may **bubble to the HTTP client too early** instead of:
  - quickly trying a healthier candidate, or
  - continuing to route to available tiers/routes (default/backup) when possible.

We want a selection strategy that:

1) starts fair (equal share),
2) reduces selection probability for recently failing keys (but never to zero),
3) gradually restores probability as time passes without errors,
4) remains deterministic and testable (no randomness),
5) does **not** cross-contaminate between aliases (no “model-level” shared cooldown across keys/aliases).

## Goals

- **Fair use of healthy keys**: when multiple keys are healthy, they should all be selected over time.
- **Penalty, not ban**: an unhealthy key stays selectable, but less frequently.
- **Floor guarantee**: selection probability for a key must not drop below **50% of its initial share** within the same pool/tier.
- **Time-based recovery**: without new errors, a key’s share should slowly return to baseline.
- **Retry recovery preference**: for a retry attempt (e.g. request metadata carries `excludedProviderKeys`), routing should “snap back”
  to the **currently healthiest** candidate first.
- **Alias isolation**: health/penalty is per `providerKey` (includes alias), never shared between aliases.

## Non-goals

- This design does not change provider transport behavior (retries/backoff are still provider-layer concerns).
- This design does not “repair” tool calls or rewrite payload semantics.
- This design does not introduce cross-model or cross-alias global capacity tracking.

## Architecture Placement (Rule: llmswitch-core owns routing)

This design splits responsibilities as:

- Host (RouteCodex) provides a `quotaView(providerKey) -> ProviderQuotaViewEntry`.
  - It is the **source of truth** for “recent errors” metadata per providerKey.
- `sharedmodule/llmswitch-core` computes weights and selects a providerKey.
  - Routing + selection policy lives here.

## Proposed API/Data Model

### 1) Extend `ProviderQuotaViewEntry`

Add optional fields to support time-decayed penalty:

- `selectionPenalty?: number` (existing; derived from recent error activity)
- `lastErrorAtMs?: number | null` (new; per-providerKey)
- `consecutiveErrorCount?: number` (new; per-providerKey, resets to 0 on success)

Hard exclusion continues to use:

- `inPool`, `cooldownUntil`, `blacklistUntil` (if blocked, do not select)

### 2) New derived values (llmswitch-core)

For each candidate providerKey, llmswitch-core computes:

- `multiplier m ∈ [minMultiplier, 1]`
- `weight = baseWeight * m`

Where:

- `minMultiplier = 0.5` (the “50% of initial share” floor)

## Weight Formula

We use time-decayed effective error intensity to allow gradual recovery.

### Parameters

- `baseWeight = 100` (resolution; does not change ratios)
- `halfLifeMs = 10 * 60 * 1000` (10 minutes)
- `beta = 0.1` (penalty slope; tuned so repeated errors quickly reduce share but respect floor)
- `minMultiplier = 0.5`

### Computation

Given `nowMs`, `lastErrorAtMs`, `consecutiveErrorCount`:

1) If `lastErrorAtMs` is missing, treat as no recent error.

2) Time decay:

```
decay = exp(-ln(2) * (nowMs - lastErrorAtMs) / halfLifeMs)
effectiveErrors = consecutiveErrorCount * decay
```

3) Multiplier:

```
m = clamp(minMultiplier, 1.0, 1.0 - beta * effectiveErrors)
```

This ensures:

- No error → `effectiveErrors=0` → `m=1` (equal baseline share).
- Recent repeated errors → `m` drops quickly but never below `minMultiplier`.
- As time passes without errors → `decay→0` → `m` recovers toward 1.0.

## Selection Algorithm

### Baseline: Smooth Weighted Round Robin (SWRR)

Use a deterministic SWRR implementation in the load balancer:

- No randomness; stable and testable.
- Any candidate with `weight >= 1` will be selected eventually.

We compute `weights` per request from quotaView, then select via SWRR within:

- the current route tier bucket (priorityTier grouping), and
- the current pool’s candidate ordering (after filtering).

### Retry path: “recover-to-best”

If a request is a retry attempt (detected via routing metadata, e.g. `excludedProviderKeys` is non-empty):

- Bypass SWRR; pick the candidate with the highest `m` (healthiest).
- Tie-break deterministically (stable order or round-robin pointer).

Note: this “retry” is **router-level re-routing** after a providerKey failed (to avoid picking the same key again in the same
request chain). It is not the same thing as provider HTTP retries to the same upstream endpoint.

Rationale: after an error, we want the next attempt to “snap back” to the best-known key, reducing the chance of repeated
failures; once stable again, SWRR resumes fair rotation.

## Behavioral Guarantees

- **No starvation**: as long as a key is not hard-blocked and `weight >= 1`, it will be selected eventually.
- **Floor**: `m >= 0.5` ensures a key’s chance cannot be crushed to near-zero by penalty alone.
- **Recovery**: time decay ensures that without new errors, `m` increases toward 1.0.
- **Isolation**: weights are computed strictly per `providerKey` and never shared across alias/model.

## Configuration / Tuning

We can start with fixed defaults (above), then optionally expose:

- `virtualrouter.loadBalancing.healthWeighted`:
  - `halfLifeMs`
  - `beta`
  - `minMultiplier` (default 0.5, must be in `(0,1]`)
  - `baseWeight` (default 100)

If config is not provided, use defaults.

## Tests (Coverage Requirements)

Add deterministic tests that cover:

1) **Fair baseline**: equal weights should rotate through all candidates (no single key always hit).
2) **Penalty reduces share**: a higher `consecutiveErrorCount` produces fewer hits over a fixed window.
3) **Floor enforced**: under extreme penalty, the degraded key still gets hits (non-zero) and does not starve.
4) **Time recovery**: with a mocked clock, as `nowMs` advances without errors, the key’s computed `m` increases.
5) **Retry recover-to-best**: when retry metadata is present, selection should be the healthiest candidate.
6) **Alias isolation**: two providerKeys with the same underlying “model name” must not share penalty/cooldown.

## Rollout Plan

1) Implement fields in host `quotaView` (per-providerKey only).
2) Implement SWRR + dynamic weights in llmswitch-core load balancer.
3) Switch selection to pass computed per-request weights into load balancer.
4) Add tests and run llmswitch-core matrix build.
5) Host build: `npm run build:dev` + `npm run install:global`.

## Open Questions (Need Approval)

1) Do we expose `halfLifeMs/beta/minMultiplier` as user-configurable now, or hardcode first?
2) “Initial share” definition: this design interprets it as equal share within the same pool bucket at `m=1.0`.
3) Retry detection: is `metadata.excludedProviderKeys` the canonical signal, or do we also mark retries explicitly?
