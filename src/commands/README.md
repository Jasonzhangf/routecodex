# CLI Commands

## Overview
CLI commands provide entry points for validation, provider updates, and debugging. All commands delegate to Hub Pipeline for actual processing.

## Commands
- `validate`: Load config and run Hub Pipeline validation
- `provider-update`: Fetch provider templates/models from upstream

## Architecture
Commands follow the single execution path principle:
```
CLI Args → Config Load → bootstrapVirtualRouterConfig → Hub Pipeline → Response
```

## Key Files
- `validate.ts`: Configuration validation via Hub Pipeline
- `provider-update.ts`: Provider metadata update orchestration
## Do / Don't
**Do**
- Always delegate to Hub Pipeline for actual processing
- Use `routecodex-config-loader.ts` for config loading
- Pass `virtualRouter` + `targetRuntime` to Hub Pipeline

**Don't**
- Bypass Hub Pipeline for provider operations
- Manually patch or merge configs
- Implement tool governance in CLI commands
