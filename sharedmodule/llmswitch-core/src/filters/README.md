# Filters Module

## Overview
Filters module provides request and response filtering capabilities for the Hub Pipeline. Filters can modify, validate, or transform data at various stages of request processing.

## Directory Structure
```
src/filters/
├── index.ts                  # Module entry point and exports
├── engine.ts                 # Filter execution engine
├── types.ts                  # Filter type definitions
├── builtin/                  # Built-in filter implementations
│   └── ...
├── config/                   # Filter configuration schemas
├── special/                  # Special purpose filters (reasoning, tools, etc.)
└── utils/                    # Filter utilities
```

## Key Components

### Filter Engine
Executes filters in a defined order:
- Pre-processing filters (before conversion)
- Post-processing filters (after conversion)
- Response filters

### Built-in Filters
| Filter | Purpose |
|--------|----------|
| `reasoning-extractor` | Extract reasoning content from responses |

### Special Filters
Specialized filters for:
- Reasoning content handling
- Tool call filtering
- Metadata extraction

## Usage
```typescript
import { FilterEngine } from './engine.js';
const engine = new FilterEngine(config);
await engine.execute(request, context);
```

## Related Documentation
- Root README.md - Package overview and architecture principles
