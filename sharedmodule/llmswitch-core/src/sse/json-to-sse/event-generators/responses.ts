// feature_id: sse.responses_encode_projection
// Responses JSON->SSE event sequence semantics are Rust-owned.
// This anchor file exists for the SSE architecture boundary gate; runtime code
// must call native wrappers directly instead of restoring TS event generators.

import type { ResponsesSequencerConfig, ResponsesSequencerContext } from '../sequencers/responses-sequencer.js';

export type ResponsesEventGeneratorConfig = ResponsesSequencerConfig;

export function createDefaultResponsesContext(requestId: string, model: string): ResponsesSequencerContext {
  return { requestId, model };
}
