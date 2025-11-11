# Hybrid Pipeline Adapter

This directory contains the hybrid pipeline adapter that enables seamless migration between V1 and V2 architectures.

## Components

### Core Files
- **hybrid-config-types.ts** - Type definitions for hybrid configuration and metrics
- **hybrid-pipeline-manager.ts** - Main unified pipeline manager that routes between V1/V2
- **traffic-splitter.ts** - Intelligent traffic splitting based on various strategies
- **hybrid-assembler.ts** - Assembly logic that creates hybrid pipeline from config
- **health-monitor.ts** - Health monitoring and comparison between V1 and V2
- **index.ts** - Public exports

## Key Features

### 1. Unified Interface
The `HybridPipelineManager` implements the same interface as existing pipeline managers, ensuring backward compatibility.

### 2. Traffic Splitting Strategies
- **Hash-based**: Consistent routing based on request ID
- **User-based**: Route by user ID for consistent experience
- **Endpoint-based**: Different split ratios per API endpoint
- **Provider-based**: Different split ratios per provider

### 3. Progressive Migration
Automatic gradual migration from V1 to V2 with configurable schedules:
- Start with small V2 percentage
- Gradually increase over time
- Health-based adjustments
- Automatic fallback on errors

### 4. Health Monitoring
Real-time health comparison between V1 and V2:
- Success rate monitoring
- Latency tracking
- Error analysis
- Automatic recommendations

### 5. Fail Fast & Rollback
- No hidden fallback mechanisms
- Explicit error handling
- Immediate rollback on critical issues
- Full visibility into routing decisions

## Usage Example

```typescript
import { HybridPipelineAssembler } from './hybrid-adapter/index.js';

// Assemble hybrid pipeline from merged config
const { manager, routePools, routeMeta, mode } = await HybridPipelineAssembler.assemble(mergedConfig);

// Use like a regular pipeline manager
const response = await manager.processRequest(request);

// Get metrics and health status
const metrics = manager.getMetrics();
const healthMonitor = new HealthMonitor();
healthMonitor.start();
```

## Configuration

Add hybrid configuration to your system config:

```json
{
  "system": {
    "pipelineMode": "hybrid",
    "trafficSplit": {
      "v2Percentage": 20,
      "criteria": {
        "byHash": true,
        "byEndpoint": true,
        "byProvider": true
      },
      "endpointOverrides": {
        "/v1/chat/completions": 30,
        "/v1/messages": 10
      }
    },
    "enableProgressiveMigration": true,
    "migrationDurationHours": 24,
    "enableHealthBasedRouting": true
  }
}
```

## Migration Path

1. **V1 Mode** (Default) - All traffic to V1, V2 disabled
2. **Hybrid Mode** - Gradual migration with health monitoring
3. **V2 Mode** - All traffic to V2, V1 as fallback

The system supports seamless transitions between modes without downtime.
