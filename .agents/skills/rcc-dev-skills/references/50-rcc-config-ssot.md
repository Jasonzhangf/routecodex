# V3 Config and Runtime Evidence

## When

Use for listener, provider, auth handle, model, route pool, install, restart, health, or live replay work.

## Truth Order

1. User-specified active V3 config; otherwise `~/.rcc/config.v3.toml`.
2. Provider files explicitly referenced by that V3 authoring.
3. `rccv3 config check` compiled manifest/result.
4. Installed binary identity and managed lifecycle status.
5. All configured listener health endpoints.
6. Same-entry request artifacts and request-id logs.

Derived snapshots and old logs are evidence inputs, never configuration truth.

## Inspect

```bash
rccv3 --version
rccv3 config check -c <active-config>
rccv3 status -c <active-config>
rg -n '<request-id>|<provider>|<model>' ~/.rcc/codex-samples ~/.rcc/logs
```

Redact credentials. Do not infer provider/model/endpoint from names or old memory.

## Change And Prove

1. Record sanitized pre-change config and runtime identity.
2. Edit only declared authoring/provider owner.
3. Validate without starting service:

```bash
rccv3 config check -c <active-config>
```

4. After verified source gates, install and restart once:

```bash
npm run install:v3
rccv3 --version
rccv3 restart -c <active-config>
```

5. Check every listener for expected version, identity, and readiness.
6. Replay target entry; bind request id to provider-bound request, raw response/error, and client response.

Config check proves compilation only. Health proves listener/runtime load only. Neither proves provider selection, switching, protocol projection, or business success.
