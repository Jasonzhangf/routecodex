// feature_id: sse.anthropic_gemini_stream_projection
// canonical_builder: build_anthropic_sse_event_sequence_json
import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

export type AnthropicSseEventSequenceNativeEvent = Record<string, unknown> & {
  type: string;
  event: string;
  protocol: 'anthropic-messages';
  direction: 'json_to_sse';
  data: Record<string, unknown>;
};

function parseNativeAnthropicEventSequence(raw: string): AnthropicSseEventSequenceNativeEvent[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const events: AnthropicSseEventSequenceNativeEvent[] = [];
    for (const event of parsed) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return null;
      }
      const row = event as Record<string, unknown>;
      if (
        typeof row.type !== 'string'
        || typeof row.event !== 'string'
        || row.protocol !== 'anthropic-messages'
        || row.direction !== 'json_to_sse'
        || !row.data
        || typeof row.data !== 'object'
        || Array.isArray(row.data)
      ) {
        return null;
      }
      events.push(row as AnthropicSseEventSequenceNativeEvent);
    }
    return events;
  } catch {
    return null;
  }
}

export function buildAnthropicSseEventSequenceWithNative(input: {
  response: unknown;
  config?: Record<string, unknown>;
}): AnthropicSseEventSequenceNativeEvent[] {
  const capability = 'buildAnthropicSseEventSequenceJson';
  const fail = (reason?: string) => failNative<AnthropicSseEventSequenceNativeEvent[]>(capability, reason);
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
      return fail('empty Anthropic SSE event sequence result');
    }
    const parsed = parseNativeAnthropicEventSequence(raw);
    if (!parsed) {
      return fail('invalid Anthropic SSE event sequence result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

function parseNativeAnthropicDecodeResponse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildAnthropicJsonFromSseWithNative(input: {
  bodyText: string;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'buildAnthropicJsonFromSseJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
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
      body_text: input.bodyText,
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
      return fail('empty Anthropic SSE decode result');
    }
    const parsed = parseNativeAnthropicDecodeResponse(raw);
    if (!parsed) {
      return fail('invalid Anthropic SSE decode result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
