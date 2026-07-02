import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

// feature_id: sse.anthropic_gemini_stream_projection
// canonical_builder: build_gemini_sse_event_sequence_json
export type GeminiSseEventSequenceNativeEvent = Record<string, unknown> & {
  type: string;
  event: string;
  protocol: 'gemini-chat';
  direction: 'json_to_sse';
  data: Record<string, unknown>;
};

function parseNativeGeminiEventSequence(raw: string): GeminiSseEventSequenceNativeEvent[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const events: GeminiSseEventSequenceNativeEvent[] = [];
    for (const event of parsed) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return null;
      }
      const row = event as Record<string, unknown>;
      if (
        typeof row.type !== 'string'
        || typeof row.event !== 'string'
        || row.protocol !== 'gemini-chat'
        || row.direction !== 'json_to_sse'
        || !row.data
        || typeof row.data !== 'object'
        || Array.isArray(row.data)
      ) {
        return null;
      }
      events.push(row as GeminiSseEventSequenceNativeEvent);
    }
    return events;
  } catch {
    return null;
  }
}

export function buildGeminiSseEventSequenceWithNative(input: {
  response: unknown;
  config?: Record<string, unknown>;
}): GeminiSseEventSequenceNativeEvent[] {
  const capability = 'buildGeminiSseEventSequenceJson';
  const fail = (reason?: string) => failNative<GeminiSseEventSequenceNativeEvent[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let inputJson: string;
  try {
    inputJson = JSON.stringify({
      response: input.response,
      config: input.config ?? {}
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Gemini SSE event sequence result');
    }
    const parsed = parseNativeGeminiEventSequence(raw);
    if (!parsed) {
      return fail('invalid Gemini SSE event sequence result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
