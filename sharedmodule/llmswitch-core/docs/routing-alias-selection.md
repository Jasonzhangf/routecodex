# Virtual Router – Alias Selection Strategies

This doc describes how VirtualRouterEngine can handle multiple auth aliases for the same provider+model.

## Problem

Some upstream gateways behave poorly when requests rapidly switch across keys/aliases (e.g. repeated 429
capacity errors even though local quota tracking still shows availability). For these providers, it is
safer to "stick" to one alias until it fails, instead of round-robin across aliases.

## Config Surface

Alias selection is configured via `virtualrouter.loadBalancing.aliasSelection`:

```json
{
  "virtualrouter": {
    "loadBalancing": {
      "strategy": "round-robin",
      "aliasSelection": {
        "enabled": true,
        "defaultStrategy": "none",
        "providers": {
          "antigravity": "sticky-queue"
        }
      }
    }
  }
}
```

If a provider has no explicit override, the engine may apply a data-only default table
(`DEFAULT_PROVIDER_ALIAS_SELECTION`).

## Strategies

### `none`

No alias-level selection is applied. Normal pool selection (priority / round-robin / weighted) continues
to operate on individual provider keys.

### `sticky-queue`

Behavior (per `providerId::modelId`):

1. Initialize a queue of aliases using config order (`tier.targets`), filtered to the aliases that exist
   in the current candidate set.
2. Always select only the **queue head alias** while it remains available.
3. On error, rotate the failed alias to the tail and stick to the next alias:
   - A "retry attempt" is signaled by `excludedProviderKeys` (the failing provider key is excluded).
   - If `excludedProviderKeys` contains a key belonging to `providerId::modelId`, that alias is moved
     to the tail.
4. If the head alias becomes unavailable (health/cooldown/quota), rotate until an available alias is
   found.

State scope:

- The queue is **global within a VirtualRouterEngine instance** (process-wide for the running server),
  and does not depend on `sessionId` / `conversationId`.

