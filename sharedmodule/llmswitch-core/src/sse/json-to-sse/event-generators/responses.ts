// feature_id: sse.responses_encode_projection
// Responses JSON->SSE event sequence semantics are Rust-owned.
// This anchor file exists for the SSE architecture boundary gate; runtime code
// must call native wrappers directly instead of restoring TS event generators.

export interface ResponsesEventGeneratorConfig {
  chunkSize?: number;
  enableIdGeneration?: boolean;
  enableTimestampGeneration?: boolean;
  enableSequenceNumbers?: boolean;
}

export function createDefaultResponsesContext(requestId: string, model: string): { requestId: string; model: string } {
  return { requestId, model };
}
