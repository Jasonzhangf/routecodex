# Integration Notes

1. Introduce a `StageRunner` inside `HubPipeline.execute` that loads the stage manifest per protocol and sequentially executes `req_inbound → req_process → req_outbound`.
2. Each stage module should expose a factory `(deps) => StageHandler` to keep dependencies (format adapters, semantic mappers, router engine, SSE codecs) injectable for testing.
3. StageRecorder MUST reference the exact stage id defined in this directory. Avoid ad-hoc names (e.g., "hub-inbound").
4. `ResponsesOpenAIPipelineCodec` and `provider-response.ts` should reuse the same stage modules to keep Responses semantics capture/restoration consistent (via `ChatEnvelope.semantics.responses.*`, not legacy `metadata.responsesContext`).
5. Tests (`responses-in-out-closed-loop`, `responses-sse-closed-loop`, `scripts/test-responses-roundtrip.mjs`) must assert stage ordering by reading recorder snapshots once the runner is wired.
