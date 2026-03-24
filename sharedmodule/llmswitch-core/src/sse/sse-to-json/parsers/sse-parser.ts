import type {
  ResponsesSseEvent,
  ResponsesSseEventType,
  ChatSseEvent,
  AnthropicSseEvent,
  GeminiSseEvent,
  BaseSseEvent
} from '../../types/index.js';
import {
  failNativeRequired,
  isNativeDisabledByEnv
} from '../../../router/virtual-router/engine-selection/native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';

export interface SseParserConfig {
  enableStrictValidation: boolean;
  enableEventRecovery: boolean;
  maxEventSize: number;
  allowedEventTypes: Set<string>;
}

export interface SseParseResult {
  success: boolean;
  event?: BaseSseEvent;
  error?: string;
  rawData: string;
}

export const DEFAULT_SSE_PARSER_CONFIG: SseParserConfig = {
  enableStrictValidation: true,
  enableEventRecovery: true,
  maxEventSize: 1024 * 1024,
  allowedEventTypes: new Set([
    'chunk',
    'done',
    'error',
    'heartbeat',

    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.reasoning_text.delta',
    'response.reasoning_text.done',
    'response.reasoning_signature.delta',
    'response.reasoning_image.delta',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.required_action',
    'response.completed',
    'response.done',
    'response.error',
    'response.cancelled',

    'response.start',
    'output_item.start',
    'content_part.start',
    'content_part.delta',
    'function_call.start',
    'function_call.delta',
    'function_call.done',
    'reasoning.start',
    'reasoning.delta',
    'reasoning.done',
    'required_action',

    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',

    'gemini.data',
    'gemini.done'
  ])
};

export interface RawSseEvent {
  id?: string;
  event: string;
  data: string;
  retry?: string;
  timestamp?: number;
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function failNative<T>(capability: string, reason?: string): T {
  return failNativeRequired<T>(capability, reason);
}

function assembleSseEventFromLinesWithNative(lines: string[]): RawSseEvent | null {
  const capability = 'assembleSseEventFromLinesJson';
  const fail = (reason?: string) => failNative<RawSseEvent | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payload: string;
  try {
    payload = JSON.stringify(Array.isArray(lines) ? lines : []);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payload);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    const event = typeof row.event === 'string' ? row.event : '';
    const data = typeof row.data === 'string' ? row.data : '';
    if (!event) {
      return fail('missing event');
    }
    return {
      event,
      data,
      id: typeof row.id === 'string' ? row.id : undefined,
      retry: typeof row.retry === 'string' ? row.retry : undefined,
      timestamp: typeof row.timestamp === 'number' ? row.timestamp : undefined
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function inferSseEventTypeFromDataWithNative(rawEvent: RawSseEvent, config: SseParserConfig): string | null {
  const capability = 'inferSseEventTypeFromDataJson';
  const fail = (reason?: string) => failNative<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let rawEventJson: string;
  let allowedEventTypesJson: string;
  try {
    rawEventJson = JSON.stringify(rawEvent);
    allowedEventTypesJson = JSON.stringify(Array.from(config.allowedEventTypes));
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawEventJson, config.enableStrictValidation, allowedEventTypesJson);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return null;
    }
    if (typeof parsed !== 'string') {
      return fail('invalid payload');
    }
    return parsed.trim() ? parsed.trim() : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function detectSseProtocolKindWithNative(
  eventType: string
): 'chat' | 'responses' | 'anthropic' | 'gemini' {
  const capability = 'detectSseProtocolKindJson';
  const fail = (reason?: string) =>
    failNative<'chat' | 'responses' | 'anthropic' | 'gemini'>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(eventType);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === 'chat' || parsed === 'responses' || parsed === 'anthropic' || parsed === 'gemini') {
      return parsed;
    }
    return fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function validateSseEventTypeWithNative(eventType: string, config: SseParserConfig): boolean {
  const capability = 'validateSseEventTypeJson';
  const fail = (reason?: string) => failNative<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let allowedEventTypesJson: string;
  try {
    allowedEventTypesJson = JSON.stringify(Array.from(config.allowedEventTypes));
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(eventType, config.enableStrictValidation, allowedEventTypesJson);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'boolean') {
      return fail('invalid payload');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function assembleSseEvent(lines: string[]): RawSseEvent | null {
  return assembleSseEventFromLinesWithNative(lines);
}

function safeJsonParse(data: string): unknown {
  try {
    if (data === '[DONE]') {
      return '[DONE]';
    }

    return JSON.parse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON data: ${message}`);
  }
}

function validateEventType(eventType: string, config: SseParserConfig): boolean {
  return validateSseEventTypeWithNative(eventType, config);
}

function inferEventTypeFromData(rawEvent: RawSseEvent, config: SseParserConfig): string | null {
  return inferSseEventTypeFromDataWithNative(rawEvent, config);
}

function createBaseEvent(
  rawEvent: RawSseEvent,
  config: SseParserConfig,
  _rawData: string
): BaseSseEvent {
  const baseEvent: BaseSseEvent = {
    type: rawEvent.event,
    timestamp: rawEvent.timestamp ?? Date.now(),
    data: null,
    sequenceNumber: typeof rawEvent.id === 'string' ? Number(rawEvent.id) : 0
  };

  try {
    if (rawEvent.data) {
      const parsedData = safeJsonParse(rawEvent.data);
      baseEvent.data = parsedData;
      if (
        parsedData &&
        typeof parsedData === 'object' &&
        'sequence_number' in parsedData &&
        typeof (parsedData as { sequence_number?: number }).sequence_number === 'number'
      ) {
        baseEvent.sequenceNumber = (parsedData as { sequence_number: number }).sequence_number;
      }
    }
  } catch (error) {
    if (config.enableEventRecovery) {
      baseEvent.data = { error: 'Invalid JSON', raw: rawEvent.data };
      baseEvent.type = 'error';
    } else {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  return baseEvent;
}

function createChatEvent(baseEvent: BaseSseEvent): ChatSseEvent {
  return {
    type: baseEvent.type,
    event: baseEvent.type as ChatSseEvent['event'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'chat' as const,
    direction: 'sse_to_json' as const
  };
}

function createResponsesEvent(baseEvent: BaseSseEvent): ResponsesSseEvent {
  return {
    type: baseEvent.type as ResponsesSseEventType,
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'responses' as const,
    direction: 'sse_to_json' as const
  };
}

function createAnthropicEvent(baseEvent: BaseSseEvent): AnthropicSseEvent {
  return {
    type: baseEvent.type as AnthropicSseEvent['type'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'anthropic-messages',
    direction: 'sse_to_json'
  } as AnthropicSseEvent;
}

function createGeminiEvent(baseEvent: BaseSseEvent): GeminiSseEvent {
  return {
    type: baseEvent.type as GeminiSseEvent['type'],
    event: baseEvent.type as GeminiSseEvent['type'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'gemini-chat',
    direction: 'sse_to_json'
  };
}

function detectEventType(eventType: string): 'chat' | 'responses' | 'anthropic' | 'gemini' {
  return detectSseProtocolKindWithNative(eventType);
}

export function parseSseEvent(
  sseText: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): SseParseResult {
  const result: SseParseResult = {
    success: false,
    rawData: sseText
  };

  try {
    const lines = sseText.split('\n').map(line => line.replace(/\r$/, ''));

    const rawEvent = assembleSseEvent(lines);
    if (!rawEvent) {
      result.error = 'Invalid SSE event format';
      return result;
    }

    const inferred = inferEventTypeFromData(rawEvent, config);
    if (inferred) {
      rawEvent.event = inferred;
    }

    if (config.enableStrictValidation && sseText.length > config.maxEventSize) {
      result.error = `Event size ${sseText.length} exceeds maximum ${config.maxEventSize}`;
      return result;
    }

    if (!validateEventType(rawEvent.event, config)) {
      result.error = `Invalid event type: ${rawEvent.event}`;
      return result;
    }

    const baseEvent = createBaseEvent(rawEvent, config, sseText);

    const protocol = detectEventType(rawEvent.event);
    if (protocol === 'chat') {
      result.event = createChatEvent(baseEvent);
    } else if (protocol === 'anthropic') {
      result.event = createAnthropicEvent(baseEvent);
    } else if (protocol === 'gemini') {
      result.event = createGeminiEvent(baseEvent);
    } else {
      result.event = createResponsesEvent(baseEvent);
    }

    result.success = true;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

export function* parseSseStream(
  sseData: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): Generator<SseParseResult> {
  const events = sseData.split('\n\n').filter(event => event.trim() !== '');

  for (const eventData of events) {
    const result = parseSseEvent(eventData, config);

    if (result.success || config.enableEventRecovery) {
      yield result;
    }
  }
}

export async function* parseSseStreamAsync(
  asyncSseData: AsyncIterable<string>,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): AsyncGenerator<SseParseResult> {
  let buffer = '';

  for await (const chunk of asyncSseData) {
    buffer += chunk;

    while (true) {
      const eventEnd = buffer.indexOf('\n\n');
      if (eventEnd === -1) {
        break;
      }

      const eventData = buffer.substring(0, eventEnd);
      buffer = buffer.substring(eventEnd + 2);

      const result = parseSseEvent(eventData, config);

      if (result.success || config.enableEventRecovery) {
        yield result;
      }
    }
  }

  if (buffer.trim() !== '') {
    const result = parseSseEvent(buffer, config);
    if (result.success || config.enableEventRecovery) {
      yield result;
    }
  }
}

export function createSseParser(config?: Partial<SseParserConfig>) {
  const finalConfig = { ...DEFAULT_SSE_PARSER_CONFIG, ...config };

  return {
    parseEvent(sseText: string): SseParseResult {
      return parseSseEvent(sseText, finalConfig);
    },

    *parseStream(sseData: string): Generator<SseParseResult> {
      yield* parseSseStream(sseData, finalConfig);
    },

    async *parseStreamAsync(asyncSseData: AsyncIterable<string>): AsyncGenerator<SseParseResult> {
      yield* parseSseStreamAsync(asyncSseData, finalConfig);
    },

    getConfig(): SseParserConfig {
      return { ...finalConfig };
    },

    addEventType(eventType: string): void {
      finalConfig.allowedEventTypes.add(eventType);
    },

    removeEventType(eventType: string): void {
      finalConfig.allowedEventTypes.delete(eventType);
    }
  };
}
