# Provider Auth Module

Default auth is API key (`apikey-auth.ts`).

## Independent Grok provider (token-file + multi-token)

- Code: `grok-auth.ts` (provider-local only)
- Activate: `providerId=grok` and/or `auth.rawType=grok`
- Token SSOT: `~/.rcc/provider/grok/auth/*.json` only (multi-token pool)
- Wire headers: **Grok Build / cli-chat-proxy** (not bare official API)
- OAuth/login/refresh: aligned with opencode xAI plugin (Grok-CLI public client)
  - browser OAuth loopback `127.0.0.1:56121`
  - device-code grant
  - refresh_token + JWT exp skew (120s) + single-flight
- Does **not** belong in Hub/VR/server modules

### Black-box header alignment (Grok Build / cli-chat-proxy)

| Header | Source |
| --- | --- |
| `Authorization: Bearer <access>` | token file `key` after refresh |
| `X-XAI-Token-Auth: xai-grok-cli` | auth provider |
| `x-grok-model-override` | family profile from request model |
| `x-grok-client-surface` / `x-grok-client-version` | config headers or family defaults |

### Config note

`apiKey = "grok-token-file-mode"` is an **inert placeholder** for generic apikey resolve only. Real credentials live only in `auth/*.json`.
