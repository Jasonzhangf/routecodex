# Server + SSE Refactor Plan

## Phase 1: Bridge & Server Initialization

1. Extend `src/modules/llmswitch/bridge.ts`
   - Add helpers (e.g., `registerPipelineConfig`, `registerCompatibilityProfiles`) that call llmswitch-core `PipelineConfigManager` and compatibility registry.
   - Accept `LLMSWITCH_PIPELINE_CONFIG` env override so the core can reload the assembler document.

2. Update startup sequence (`src/index.ts`, `src/server-v2/core/route-codex-server-v2.ts`)
   - After generating `merged-config.<port>.json`, pass `conversionV3.pipelineConfig` and `conversionV3.compatibilityProfiles` to the bridge helpers.
   - Set `process.env.LLMSWITCH_PIPELINE_CONFIG = mergedConfigPath` to give llmswitch-core a canonical file path.

3. Handler context wiring
   - Ensure `RouteCodexServerV2.attachRouteMeta` keeps provider metadata available to every HTTP handler.
   - Include `providerId/providerType/providerProtocol` in request metadata before calling llmswitch-core.

## Phase 2: Remove pipeline-level compatibility modules

1. `sharedmodule/config-core` exporter no longer emits `modules.compatibility` inside pipeline definitions.
2. `src/modules/pipeline/config/pipeline-assembler.ts`
   - Drop all compatibility normalization and defaults.
   - Pipelines contain only provider / llmSwitch / workflow modules.
3. `src/modules/pipeline/core/base-pipeline.ts` & manager
   - Remove compatibility module loading/metrics/snapshots.
   - Main pipeline chain becomes provider → llmSwitch → workflow (compat handled entirely in llmswitch-core).

## Phase 3: Provider metadata propagation

1. `routeMeta` from config-core should include `providerType` & `providerProtocol`; assembler writes them into provider configs.
2. Provider implementations (`openai-standard`, `responses-provider`, etc.)
   - Attach `providerId/providerType/providerProtocol/entryEndpoint` to request metadata.
   - `ResponsesProvider` should pass `providerProtocol='openai-responses'` when invoking `buildResponsesRequestFromChat`.
3. Server handlers (`handleChat/Responses/Messages`)
   - After `selectRouteName`, read routeMeta to populate `sharedReq.route/provider` fields.
   - Ensure llmswitch-core sees accurate provider metadata for compatibility matching.

## Phase 4: Legacy compatibility cleanup

- Once the above path is validated, remove `src/modules/pipeline/modules/compatibility/**` and related docs/examples.
- All compatibility profiles live in config-core and execute inside llmswitch-core.

## Validation

- Use replay scripts (`replay:responses:chat-sse`, `replay:responses:loop`, `replay:chat:bridge`) against the running server to verify SSE output matches golden samples.
- Dry-run GLM/Qwen/LMStudio providers to confirm compatibility profiles in llmswitch-core trigger correctly.
