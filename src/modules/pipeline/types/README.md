# Pipeline Types Module
## Overview
Pipeline types module contains TypeScript type definitions for the Hub Pipeline, ensuring type safety and consistency between Host and llmswitch-core.
## Directory Structure
```src/modules/pipeline/types/
└── README. md                  # This file - type definitions overview
```## Key Types### Pipeline Base TypesCore types for pipeline operation:- `PipelineRequest` - Incoming request structure
- `PipelineResponse` - Response structure- `PipelineContext` - Execution context### Provider TypesProvider-related type definitions:- `ProviderRuntimeMetadata` - Runtime information for providers
- `ProviderHealthStatus` - Health check types### Transformation TypesConversion and compatibility type definitions.## Usage```typescriptimport { PipelineRequest } from '@jsonstudio/llms';const request: PipelineRequest = {  // ...};```## Do / Don't
**Do**
- Import types from llmswitch-core for consistency
- Use type guards and validators provided by the module**Don't**
- Duplicate types that exist in llmswitch-core
- Add business logic to type files## Related Documentation
- `src/types/` - Host-level type definitions
- `sharedmodule/llmswitch-core/dist/types/` - Source of truth for pipeline types
