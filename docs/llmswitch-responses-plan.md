# RouteCodex Responses Integration Plan

## Goals
- Add full Responses protocol support via pipeline.
- Maintain compatibility with chat workflows and monitoring.
- Provide reliable regression coverage using captured monitor samples.

## Workstreams

### 1. Responses ⇄ Chat Conversion Module
- Refine `llmswitch-response-chat.ts` to handle request normalization, tool mapping, and SSE events.
- Implement streaming parser for Responses events (output_text/tool calls) and map to chat deltas.
- Ensure round-trip conversion retains instructions, include/store flags, metadata.
- Capture request context per `requestId` for mapping responses.
- Add metadata annotations (`entryProtocol`, `targetProtocol`).

### 2. Pipeline Routing for /v1/responses
- Update `ProtocolHandler` to build `SharedPipelineRequest` for responses.
- Reuse heartbeat + stream bridging for chat; add Responses bridge.
- Record monitor events for pipeline outputs.
- Support fallback to transparent proxy when pipeline disabled.

### 3. Config & Type Updates
- Extend virtual router schemas (`inputProtocol/outputProtocol`) to include `'responses'`.
- Update config assemblers (compat-compat engine, exporter) to select `llmswitch-response-chat` when protocol is responses.
- Adjust defaults to keep chat using openai switch.
- Validate user config parsing and refactoring-agent types.

### 4. Regression Fixtures & Tests
- Store monitor samples (e.g., `responses_1760615123370`) under `tests/fixtures` with parsed event JSON.
- Write unit tests for converter: request normalization, response conversion, streaming events.
- Add integration tests invoking pipeline manager with responses fixture and verifying mapping.

### 5. Documentation & Cleanup
- Document Responses support: configuration steps (`inputProtocol: responses`, `wireApi`).
- Update README/modules docs to describe new switch and streaming behavior.
- Provide testing instructions referencing fixtures.
- Clean up temporary artifacts (archives) and ensure git ignores as needed.
- Summarize changes in CHANGELOG when ready.

## Execution Order
1. Finalize module conversion (Workstream 1).
2. Implement pipeline path (Workstream 2).
3. Adjust configuration/types (Workstream 3).
4. Add tests & fixtures (Workstream 4).
5. Update documentation & cleanup (Workstream 5).

## Monitoring & Verification
- Use `tests/fixtures/responses_1760615123370` for text streaming coverage.
- Capture additional function-call samples if needed (already in monitor set).
- After implementation, run unit/integration suites and manual pipeline dry-run for `/v1/responses`.

## Open Questions
- Need to confirm if heartbeat behavior should apply to Responses SSE.
- Determine whether Responses final payload needs additional fields (e.g., usage breakdown) for clients.
