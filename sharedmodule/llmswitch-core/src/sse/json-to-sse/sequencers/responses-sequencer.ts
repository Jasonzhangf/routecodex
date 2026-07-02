// feature_id: sse.responses_encode_projection
// canonical_builder: build_responses_sse_event_sequence_json
import type {
  ResponsesResponse,
  ResponsesSseEvent
} from '../../types/index.js';
import { buildResponsesSseEventSequenceWithNative } from '../../../native/router-hotpath/native-responses-sse-event-payload.js';
import type { ResponsesEventGeneratorConfig, ResponsesEventGeneratorContext } from '../event-generators/responses.js';
import { DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG } from '../event-generators/responses.js';

export const DEFAULT_RESPONSES_SEQUENCER_CONFIG: ResponsesEventGeneratorConfig = {
  ...DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
};

export async function* sequenceResponse(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
): AsyncGenerator<ResponsesSseEvent> {
  const events = buildResponsesSseEventSequenceWithNative({
    response,
    requestId: context.requestId,
    model: context.model,
    config: {
      chunkSize: config.chunkSize,
      enableTimestampGeneration: config.enableTimestampGeneration,
      includeSequenceNumbers: config.enableSequenceNumbers
    }
  });

  for (const event of events) {
    yield event as unknown as ResponsesSseEvent;
  }
}
