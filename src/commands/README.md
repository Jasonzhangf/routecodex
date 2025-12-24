# CLI Commands

## Overview
CLI commands provide entry points for validation, provider updates, and debugging. All commands delegate to Hub Pipeline for actual processing.

## Commands
- `validate`: Load config and run Hub Pipeline dry-run validation
- `provider-update`: Fetch provider templates/models from upstream
- `dry-run`: Execute node-level dry-run via debug toolkit

## Architecture
Commands follow the single execution path principle:
```
CLI Args → Config Load → bootstrapVirtualRouterConfig → Hub Pipeline → Response
```

## Key Files
- `validate.ts`: Configuration validation via Hub Pipeline
- `provider-update.ts`: Provider metadata update orchestration
- `dry-run.ts`: Debug toolkit integration

## Do / Don't
**Do**
- Always delegate to Hub Pipeline for actual processing
- Use `routecodex-config-loader.ts` for config loading
- Pass `virtualRouter` + `targetRuntime` to Hub Pipeline

**Don't**
- Bypass Hub Pipeline for provider operations
- Manually patch or merge configs
- Implement tool governance in CLI commands
