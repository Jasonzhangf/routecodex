# Quota Manager V3 (Core-Owned)

## Goal
Make **quota / cooldown / blacklist / auth-verify gating** a *single source of truth* and stop producing router-local cooldown state.

- Routing path remains: `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`.
- VirtualRouter **consumes** quota view only; it must not invent cooldown/health decisions in host/server/provider layers.

## Where it lives
- **llmswitch-core**: `sharedmodule/llmswitch-core/src/quota/*`
  - `QuotaManager` state machine + persistence contract (`QuotaStore`)
  - Outputs `ProviderQuotaView` (consumed by VirtualRouter selection)
- **routecodex host**: `src/manager/modules/quota/antigravity-quota-manager.ts`
  - Implements `QuotaStore` (I/O only)
  - Subscribes to `providerErrorCenter` + `providerSuccessCenter` and forwards events into core `QuotaManager`
  - Feeds Antigravity external quota snapshot into `QuotaManager.updateProviderPoolState(...)`

## Inputs
1) Provider errors (from Provider V2 → `emitProviderError(...)`)
2) Provider successes (from HTTP server → `providerSuccessCenter.emit(...)`)
3) External quota snapshots (Antigravity quota API refresh)
4) Static metadata per providerKey (authType / priorityTier / apikeyDailyResetTime)

## Outputs
- `quotaView(providerKey) -> ProviderQuotaViewEntry`
  - `inPool`, `cooldownUntil`, `blacklistUntil`
  - `selectionPenalty`, `lastErrorAtMs`, `consecutiveErrorCount`

## Key semantics
- **HTTP 402** (apikey daily cost limit): blacklist until `resetAt` (prefer upstream `resetAt`, else use `apikeyDailyResetTime`, default `12:00` local).
- **Antigravity OAuth auth verification required**: blacklist the whole `antigravity.<alias>.*` group with `authIssue=google_account_verification`.
- **Antigravity thought-signature missing**: cooldown Gemini series keys under `antigravity.<alias>.*` to avoid request storms.

## Config
You can set the default daily reset time used for **HTTP 402 without upstream `resetAt`**:

```json
{
  "virtualrouter": {
    "quota": {
      "apikeyDailyResetTime": "16:00Z"
    }
  }
}
```

- Format:
  - `"HH:MM"` = local time (server timezone)
  - `"HH:MMZ"` = UTC time
- Default: `"12:00"` (local)

## Persistence
- Core `QuotaManager` persists via host `QuotaStore` at `~/.routecodex/quota/quota-manager.json`.
- Legacy fallback migration reads `~/.routecodex/quota/provider-quota.json` when the new snapshot is missing.
