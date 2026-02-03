# Daemon Control Plane (single WebUI entry)

## Goal
WebUI connects to **one** RouteCodex server port and can:
- discover all local servers
- broadcast restart
- manage quota (disable / recover / reset / refresh)
- fetch a unified snapshot (servers + quota + routing hits)

## Endpoints (daemon-admin, localhost-only, password-auth)
### `GET /daemon/control/snapshot`
Returns:
- discovered local servers (ports + pids + version + ready)
- quota snapshot (provider states + antigravity raw snapshot)
- `virtualRouterConfig` (current runtime config snapshot)
- `policy` + `policyHash` (best-effort read of routing policy from `configPath` on disk; `policy` is a stable, serializable subset of the user config)
- `antigravityAliasLeases` (best-effort read of `~/.routecodex/state/antigravity-alias-leases.json` when present; used for session lease/binding observability)
- `llmsStats` (llmswitch-core stats center snapshot; includes routing hits)

### `POST /daemon/control/mutate`
Body: `{ action: string, ... }`

Supported actions:
- `servers.restart` (broadcast): sends `SIGUSR2` to other servers; self uses runtime reload when available
- `quota.refresh`
- `quota.disable` `{ providerKey, mode: "cooldown"|"blacklist", durationMs }`
- `quota.recover` `{ providerKey }`
- `quota.reset` `{ providerKey }`
- `routing.policy.set` `{ policy }` (writes policy into config file and triggers best-effort broadcast restart)
- `runtime.restart` (reload config from disk for current server)

## Discovery
- Uses `~/.routecodex/sessions/*_<port>` + env ports (`ROUTECODEX_PORT/RCC_PORT`) + dev default `5555`.
- Probes `/health` and filters `server=routecodex`.
