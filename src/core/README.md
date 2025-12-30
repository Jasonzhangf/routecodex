# Core Module
## Overview
Core module contains fundamental system-level components that are shared across the entire RouteCodex application.

## Directory Structure
```
src/core/
└── provider-health-manager.ts  # Provider health monitoring and status management
```

## Key Components

### ProviderHealthManager
Monitors the health status of all configured providers, tracking:
- Provider availability and response times
- Error rates and failure counts
- Circuit breaker state (healthy/degraded/unhealthy)
- Automatic recovery detection

## Usage
```typescript
import { ProviderHealthManager } from './provider-health-manager.js';

const healthManager = new ProviderHealthManager();
const status = await healthManager.getProviderStatus('openai');
```

## Related Documentation
- `src/modules/pipeline/validation/` - Configuration validation
- `docs/error-handling-v2.md` - Error handling architecture
