import type {
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
    'response.failed',
    'response.incomplete',
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

interface SseStreamChunkNativeResult {
  events: SseParseResult[];
  remainingBuffer: string;
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

export function assembleSseEvent(lines: string[]): RawSseEvent | null {
  return assembleSseEventFromLinesWithNative(lines);
}

function parseSseEventWithNative(
  sseText: string,
  config: SseParserConfig
): SseParseResult {
  const capability = 'parseSseEventWithConfigJson';
  const fail = (reason?: string) => failNative<SseParseResult>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  let configJson: string;
  try {
    configJson = JSON.stringify({
      ...config,
      allowedEventTypes: Array.from(config.allowedEventTypes)
    });
  } catch {
    return fail('json stringify failed');
  }

  try {
    const raw = fn(sseText, configJson);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    return {
      success: row.success === true,
      rawData: typeof row.rawData === 'string' ? row.rawData : sseText,
      event: (row.event as BaseSseEvent | undefined) ?? undefined,
      error: typeof row.error === 'string' ? row.error : undefined
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseSseStreamWithNative(
  sseData: string,
  config: SseParserConfig
): SseParseResult[] {
  const capability = 'parseSseStreamWithConfigJson';
  const fail = (reason?: string) => failNative<SseParseResult[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  let configJson: string;
  try {
    configJson = JSON.stringify({
      ...config,
      allowedEventTypes: Array.from(config.allowedEventTypes)
    });
  } catch {
    return fail('json stringify failed');
  }

  try {
    const raw = fn(sseData, configJson);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.map((item): SseParseResult => {
      const row = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};
      return {
        success: row.success === true,
        rawData: typeof row.rawData === 'string' ? row.rawData : '',
        event: (row.event as BaseSseEvent | undefined) ?? undefined,
        error: typeof row.error === 'string' ? row.error : undefined
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseSseStreamChunkWithNative(
  sseBuffer: string,
  config: SseParserConfig,
  flushTail: boolean
): SseStreamChunkNativeResult {
  const capability = 'parseSseStreamChunkWithConfigJson';
  const fail = (reason?: string) => failNative<SseStreamChunkNativeResult>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }

  let configJson: string;
  try {
    configJson = JSON.stringify({
      ...config,
      allowedEventTypes: Array.from(config.allowedEventTypes)
    });
  } catch {
    return fail('json stringify failed');
  }

  try {
    const raw = fn(sseBuffer, configJson, flushTail);
    if (typeof raw !== 'string' || raw.length === 0) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    const eventsRaw = Array.isArray(row.events) ? row.events : [];
    const events = eventsRaw.map((item): SseParseResult => {
      const entry = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};
      return {
        success: entry.success === true,
        rawData: typeof entry.rawData === 'string' ? entry.rawData : '',
        event: (entry.event as BaseSseEvent | undefined) ?? undefined,
        error: typeof entry.error === 'string' ? entry.error : undefined
      };
    });
    return {
      events,
      remainingBuffer: typeof row.remainingBuffer === 'string' ? row.remainingBuffer : ''
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function parseSseEvent(
  sseText: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): SseParseResult {
  return parseSseEventWithNative(sseText, config);
}

export function* parseSseStream(
  sseData: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): Generator<SseParseResult> {
  yield* parseSseStreamWithNative(sseData, config);
}

export async function* parseSseStreamAsync(
  asyncSseData: AsyncIterable<string>,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): AsyncGenerator<SseParseResult> {
  let buffer = '';

  for await (const chunk of asyncSseData) {
    buffer += chunk;
    const parsedChunk = parseSseStreamChunkWithNative(buffer, config, false);
    buffer = parsedChunk.remainingBuffer;
    for (const result of parsedChunk.events) {
      yield result;
    }
  }

  if (buffer.trim() !== '') {
    const parsedTail = parseSseStreamChunkWithNative(buffer, config, true);
    for (const result of parsedTail.events) {
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
