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



export interface GeminiSseStreamNativeInput {
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface GeminiSseStreamNativeOutput {
  events: Record<string, unknown>[];
  stats: Record<string, unknown>;
}

export function buildGeminiSseStreamWithNative(
  input: GeminiSseStreamNativeInput
): GeminiSseStreamNativeOutput {
  const capability = 'GeminiSseStreamJson';
  const fail = (reason?: string) => failNative<GeminiSseStreamNativeOutput>(capability, reason);
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
      return fail('empty Gemini SSE stream result');
    }
    const parsed = JSON.parse(raw) as { events?: unknown[]; stats?: Record<string, unknown> };
    if (!parsed || !Array.isArray(parsed.events) || !parsed.stats) {
      return fail('invalid Gemini SSE stream result');
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
export function buildGeminiSseEventSequenceWithNative(input: {
  response: unknown;
  requestId?: string;
  model?: string;
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

function parseNativeGeminiDecodeResponse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.candidates)) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

export function buildGeminiJsonFromSseWithNative(input: {
  bodyText: string;
  requestId: string;
  model?: string;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'buildGeminiJsonFromSseJson';
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
      request_id: input.requestId,
      ...(input.model ? { model: input.model } : {}),
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
      return fail('empty Gemini SSE decode result');
    }
    const parsed = parseNativeGeminiDecodeResponse(raw);
    if (!parsed) {
      return fail('invalid Gemini SSE decode result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}


// Wire-level SSE frames output (canonical owner: Rust build_gemini_sse_stream_frames_json).
export interface GeminiSseStreamFramesNativeInput {
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface GeminiSseStreamFramesNativeOutput {
  frames: string[];
  stats: Record<string, unknown>;
}

export function buildGeminiSseStreamFramesWithNative(
  input: GeminiSseStreamFramesNativeInput
): GeminiSseStreamFramesNativeOutput {
  const capability = 'GeminiSseStreamFramesJson';
  const fail = (reason?: string) => failNative<GeminiSseStreamFramesNativeOutput>(capability, reason);
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
      return fail('empty gemini SSE frames result');
    }
    const parsed = JSON.parse(raw) as { frames?: string[]; stats?: Record<string, unknown> };
    if (!parsed || !Array.isArray(parsed.frames) || !parsed.stats) {
      return fail('invalid gemini SSE frames result');
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
