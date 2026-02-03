# Routing Policy Schema (Control Plane)

## Goal
Provide a **serializable** routing policy snapshot for WebUI, and a single write path that updates the user config on disk and triggers a controlled restart.

This policy is **not** a separate runtime config. It is a stable subset of the user config that maps to llmswitch-core Virtual Router inputs.

## Read: `GET /daemon/control/snapshot`
The response includes:
- `routing.policy` (nullable)
- `routing.policyHash` (nullable; `sha256(stableStringify(policy))`)

The policy is read best-effort from the current server `configPath` on disk.

## Write: `POST /daemon/control/mutate`
Action:
- `routing.policy.set` `{ policy }`

Behavior:
- Writes the policy fields into `virtualrouter.*` in the config file.
- Reloads the current server runtime from disk (best-effort) without cutting the HTTP response.
- Sends `SIGUSR2` to other local servers (best-effort) so they restart and pick up the new config.

## Policy object (V1)
Canonical snapshot shape:

```json
{
  "schemaVersion": 1,
  "virtualrouter": {
    "routing": { "default": ["provider.model"] },
    "loadBalancing": { "strategy": "round-robin" },
    "classifier": {},
    "health": {},
    "contextRouting": {},
    "webSearch": {},
    "execCommandGuard": {},
    "clock": {}
  }
}
```

Notes:
- `virtualrouter.routing` is required; other fields are optional.
- For compatibility, `routing.policy.set` also accepts a flattened input shape (`{ routing, loadBalancing, ... }`) and will normalize it into the canonical form.
- The control plane does **not** interpret or validate routing semantics; llmswitch-core remains the single source of truth for routing behavior.

