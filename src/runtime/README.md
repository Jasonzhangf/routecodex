# Runtime Module
## Overview
Runtime module contains runtime configuration and flags that control the behavior of RouteCodex at startup and during execution.
## Directory Structure
```src/runtime/
└── runtime-flags. ts  # Runtime configuration flags and feature toggles
```## Key Components### RuntimeFlagsManages runtime- level feature flags that can be set via: - Environment variables
- CLI arguments- Configuration file overrides
## Common Flags| Flag | Description | Default |
|-----|-------------|---------| | `ROUTECODEX_PORT` | HTTP server port (dev mode) | 5506 |
| `RCC_PORT` | Release CLI port override | From config |
| `ROUTECODEX_ VERIFY_SKIP` | Skip build verification | false |
## Usage```typescript
import { RuntimeFlags, getRuntimeConfig } from './runtime-flags.js';const flags = new RuntimeFlags();if (flags.isDevMode()) {  // Dev mode behavior
}```## Related Documentation- `src/server/runtime/http-server/` - HTTP server implementation
- `AGENTS.md` - Build and release workflow
