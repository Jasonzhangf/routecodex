# Config Module

## Purpose
Centralized config loading and path resolution for RouteCodex. Configs live in `~/.routecodex/`; this module only handles loading and validation.

## Key Files
- `routecodex-config-loader.ts`: Load user config, apply legacy defaults, generate provider profiles
- `auth-file-resolver.ts`: Resolve `authfile-*` references and cache key files
- `config-paths.ts` + `unified-config-paths.ts`: Parse `ROUTECODEX_CONFIG*` env vars and default paths

## Flow
```
User Config → Config Paths → routecodex-config-loader → bootstrapVirtualRouterConfig → Hub Pipeline
```

## Do / Don't
**Do**
- Use `routecodex-config-loader` for all config loading
- Pass raw config to `bootstrapVirtualRouterConfig` without manual patching
- Support env vars and `authfile-*` references

**Don't**
- Store decrypted secrets back into config
- Manually merge runtime data or patch configs on the fly
- Implement provider-specific logic here

## CLI Usage
```bash
routecodex validate --config ~/.routecodex/config.json
```
