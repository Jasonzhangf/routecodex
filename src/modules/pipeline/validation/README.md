# Pipeline Validation Module

## Overview
Pipeline validation module provides configuration validation for the Hub Pipeline, ensuring that pipeline configurations are valid before execution.

## Directory Structure
```
src/modules/pipeline/validation/
└── config-validator.ts       # Configuration validation logic
```

## Key Components

### ConfigValidator
Validates pipeline configurations:
- Schema validation against llmswitch-core types
- Provider reference verification
- Route configuration checks

## Usage
```typescript
import { validatePipelineConfig } from './config-validator.js';
const result = await validatePipelineConfig(config);
```

## Related Documentation
- `src/modules/config/` - Configuration path resolution
