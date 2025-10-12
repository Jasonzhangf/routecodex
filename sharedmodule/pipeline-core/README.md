RouteCodex Pipeline Core (Phase 1)

Goal
- Provide a standalone build target for the pipeline framework: PipelineManager, PipelineAssembler, and module interfaces (Compatibility/Provider) with a stable import surface for routers.

Phase-1 Status
- This package re-exports implementations from the current repository (src/modules/pipeline/**) to enable incremental migration without behavior changes.
- In later phases, concrete implementations will be moved here and plugins (providers/compat) will be externalized.

Exports
- Interfaces: module contracts from pipeline-interfaces
- Core: PipelineManager, PipelineAssembler
- LLMSwitch: AnthropicOpenAIConverter (SSE/tool_use event synthesis facade)

Usage
import { PipelineManager, PipelineAssembler } from '@routecodex/pipeline-core';

Build
- npm run build (from this workspace)

Notes
- Do not publish this Phase-1 package to npm. It is a workspace-only build target used to de-risk the extraction.

