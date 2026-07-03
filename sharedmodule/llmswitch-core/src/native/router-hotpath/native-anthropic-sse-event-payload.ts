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



export interface AnthropicSseStreamNativeInput {
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface AnthropicSseStreamNativeOutput {
  events: Record<string, unknown>[];
  stats: Record<string, unknown>;
}

export function buildAnthropicSseStreamWithNative(
  input: AnthropicSseStreamNativeInput
): AnthropicSseStreamNativeOutput {
  const capability = 'AnthropicSseStreamJson';
  const fail = (reason?: string) => failNative<AnthropicSseStreamNativeOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let inputJson: string;
  try {
    const requestId = input.requestId ?? input.model ?? '';
    inputJson = JSON.stringify({
      response: input.response,
      request_id: requestId,
      model: input.model ?? '',
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
      return fail('empty Anthropic SSE stream result');
    }
    const parsed = JSON.parse(raw) as { events?: unknown[]; stats?: Record<string, unknown> };
    if (!parsed || !Array.isArray(parsed.events) || !parsed.stats) {
      return fail('invalid Anthropic SSE stream result');
    }
    return {
      events: parsed.events as Record<string, unknown>[],
      stats: parsed.stats
    };
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
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
      request_id: input.requestId,
      model: input.model,
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


// Wire-level SSE frames output (canonical owner: Rust build_anthropic_sse_stream_frames_json).
export interface AnthropicSseStreamFramesNativeInput {
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface AnthropicSseStreamFramesNativeOutput {
  frames: string[];
  stats: Record<string, unknown>;
}

export function buildAnthropicSseStreamFramesWithNative(
  input: AnthropicSseStreamFramesNativeInput
): AnthropicSseStreamFramesNativeOutput {
  const capability = 'AnthropicSseStreamFramesJson';
  const fail = (reason?: string) => failNative<AnthropicSseStreamFramesNativeOutput>(capability, reason);
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
      return fail('empty anthropic SSE frames result');
    }
    const parsed = JSON.parse(raw) as { frames?: string[]; stats?: Record<string, unknown> };
    if (!parsed || !Array.isArray(parsed.frames) || !parsed.stats) {
      return fail('invalid anthropic SSE frames result');
    }
    return {
      frames: parsed.frames as string[],
      stats: parsed.stats
    };
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
