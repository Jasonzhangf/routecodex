# Pipeline Orchestrator Module
## Overview
Pipeline orchestrator module manages the execution context and lifecycle of Hub Pipeline operations, providing coordination between different pipeline stages.
## Directory Structure
```src/modules/pipeline/orchestrator/
└── pipeline- context. ts       # Pipeline execution context management
```## Key Components### PipelineContextManages:- Request/response context across pipeline stages- State tracking for streaming responses
- Error propagation and recovery## Usage```typescriptimport { PipelineContext } from './pipeline-context. js';const context = new PipelineContext(requestId);```## Related Documentation
- `src/modules/llmswitch/bridge. ts` - Main pipeline bridge
