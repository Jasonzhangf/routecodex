# llmswitch-core Source Directory

## Overview
This directory contains the source code for `@jsonstudio/llms` (formerly `rcc-llmswitch-core`), the Hub Pipeline and conversion engine for RouteCodex V2.

## Architecture Principles
1. **Single Execution Path**: All traffic flows through Hub Pipeline → Provider V2 → Upstream AI
2. **Hub Pipeline owns tools & routing**: Host/server/provider code must not repair tool calls or decide routes
3. **Provider layer = transport**: V2 providers handle auth, HTTP, retries only
4. **Fail fast**: Upstream errors bubble via error handling centers
5. **Config-driven**: Host consumes `bootstrapVirtualRouterConfig` output only

## Directory Structure
```
src/
├── bridge/                    # Bridge between Host and Hub Pipeline
├── config-unified/            # Unified configuration system
├── conversion/                # Protocol conversion layer (front-half + back-half)
│   ├── codecs/               # Protocol codec implementations
│   ├── compat/               # Provider compatibility profiles
│   ├── config/               # Conversion configuration
│   ├── hub/                  # Hub Pipeline implementation
│   ├── pipeline/             # Pipeline nodes and stages
│   ├── responses/            # Responses protocol specific conversion
│   └── shared/               # Shared conversion utilities
├── filters/                   # Request/response filtering
│   ├── builtin/              # Built-in filter implementations
│   ├── config/               # Filter configuration
│   ├── special/              # Special purpose filters
│   └── utils/                # Filter utilities
├── guidance/                  # Guidance and instruction handling
├── http/                      # HTTP utilities for conversion
├── router/                    # Routing logic
│   └── virtual-router/       # Virtual Router implementation
├── servertool/                # Server tool integration
├── sse/                       # SSE ↔ JSON conversion (all protocols)
│   ├── json-to-sse/          # JSON to SSE conversion
│   ├── sse-to-json/          # SSE to JSON conversion
│   ├── registry/             # Codec registry
│   └── shared/               # Shared SSE utilities
├── telemetry/                 # Telemetry and metrics collection
└── tools/                     # Tool-related utilities

## Key Entry Points
- `bootstrapVirtualRouterConfig(config)`: Initialize virtual router from user config
- Hub Pipeline: Main processing engine for all requests

## Build & Release
```bash
npm run build    # Compile TypeScript and generate dist/
npm pack         # Create tarball for npm publish
```

## Related Documentation
- `README.md` (root) - Package overview and architecture
- `AGENTS.md` - Working agreement and principles
