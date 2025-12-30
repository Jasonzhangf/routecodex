# llmswitch Module
## Overview
llmswitch module provides the bridge between RouteCodex Host and the shared llmswitch- core Hub Pipeline. This is the single entry point for all Hub Pipeline interactions.
## Directory Structure
```src/modules/llmswitch/
├── bridge. ts                  # Main Hub Pipeline bridge and entry point
├── core- loader. ts            # llmswitch-core loading (symlink or npm version)
└── pipeline- registry. ts      # Pipeline registry and configuration```## Key Components### BridgeThe main bridge implementation:- Creates Hub Pipeline instances- Handles request routing to pipeline
- Manages response streaming and SSE conversion### CoreLoaderLoads llmswitch-core from:- Local symlink (`node_modules/@jsonstudio/llms` → `sharedmodule/llmswitch-core`)
- NPM package (`@jsonstudio/llms`) for release builds### PipelineRegistryMaintains registry of:- Active pipeline instances
- Pipeline configurations- Runtime metadata mappings## Usage```typescriptimport { createHubPipeline } from './bridge. js';const pipeline = await createHubPipeline({ virtualRouter, targetRuntime });```## Do / Don't
**Do**
- Use as the single entry point for Hub Pipeline calls
- Pass `virtualRouter` and `targetRuntime` from `bootstrapVirtualRouterConfig`
- Handle SSE conversion through the bridge**Don't**
- Call Hub Pipeline directly from other modules
- Implement custom routing logic here
- Store pipeline state across requests## Related Documentation
- `AGENTS. md` - Architecture principles and responsibilities
- `sharedmodule/llmswitch-core/README.md` - Hub Pipeline details
