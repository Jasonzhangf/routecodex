// feature_id: sse.responses_encode_projection
// canonical_builder: build_responses_sse_event_sequence_json
import type {
  ResponsesResponse,
  ResponsesSseEvent
} from '../../types/index.js';
import { buildResponsesSseEventSequenceWithNative } from '../../../native/router-hotpath/native-responses-sse-event-payload.js';

export interface ResponsesSequencerConfig {
  chunkSize: number;
  enableTimestampGeneration: boolean;
  enableSequenceNumbers: boolean;
}

export interface ResponsesSequencerContext {
  requestId: string;
  model: string;
}

export const DEFAULT_RESPONSES_SEQUENCER_CONFIG: ResponsesSequencerConfig = {
  chunkSize: 0,
  enableTimestampGeneration: true,
  enableSequenceNumbers: true
};

export async function* sequenceResponse(
  response: ResponsesResponse,
  context: ResponsesSequencerContext,
  config: ResponsesSequencerConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
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
