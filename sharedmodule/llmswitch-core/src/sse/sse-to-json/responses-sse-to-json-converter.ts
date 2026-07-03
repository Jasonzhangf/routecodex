/**
 * Responses SSE -> JSON converter.
 * TS owns stream IO / timeout / abort plumbing only.
 * Final response materialization is delegated to native Rust owner.
 */

// feature_id: sse.responses_decode_projection
import { Readable } from 'stream';
import type {
  ResponsesResponse,
  ResponsesSseEvent,
  SseToResponsesJsonContext,
  SseToResponsesJsonOptions,
  ResponsesEventStats,
  ResponsesSseEventStream
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createSseParser } from './parsers/sse-parser.js';
import { parseRespFormatEnvelopeWithNative } from '../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import { RESPONSES_SSE_EVENT_TYPES } from './shared/sse-event-validator.js';

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 300_000;

const hasExplicitToolWrapperProgress = (text: string): boolean => {
  if (!text) {
    return false;
  }
  return (
    /<tool_call\b/i.test(text)
    || /<function_calls?\b/i.test(text)
    || /<<\s*RCC_TOOL_CALLS(?:_JSON)?/i.test(text)
    || /<use_mcp_tool\b/i.test(text)
  );
};

export class ResponsesSseToJsonConverterRefactored {
  async convertSseToJson(
    sseStream: ResponsesSseEventStream | Readable | AsyncIterable<string | Buffer>,
    options: Partial<SseToResponsesJsonOptions> = {}
  ): Promise<ResponsesResponse> {
    const context = this.createContext(options);

    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    let abortableStream: Readable | null = null;
    const rawChunks: string[] = [];

    try {
      const parser = createSseParser({
        enableStrictValidation: true,
        enableEventRecovery: false,
        allowedEventTypes: new Set(RESPONSES_SSE_EVENT_TYPES)
      });

      const readableStream = this.createReadableStream(sseStream);
      abortableStream = readableStream;

      if (abortSignal && !abortSignal.aborted) {
        const onAbort = () => {
          context.isCompleted = true;
          abortableStream?.destroy();
        };
        abortSignal.addEventListener('abort', onAbort);
        abortHandler = () => abortSignal.removeEventListener('abort', onAbort);
      }

      for await (const parseResult of parser.parseStreamAsync(this.captureChunkStrings(readableStream, context, rawChunks))) {
        if (context.isCompleted) {
          break;
        }

        if (parseResult.success && parseResult.event) {
          const event = parseResult.event as ResponsesSseEvent;
          this.updateStats(context, event);
          options.onEvent?.(event);

          const eventType = event.type as string;
          if (
            eventType === 'response.done'
            || eventType === 'response.error'
            || eventType === 'response.cancelled'
          ) {
            context.isCompleted = true;
            break;
          }
          continue;
        }

        if (!parseResult.success || !parseResult.event) {
          throw new Error(`Failed to parse SSE event: ${parseResult.error || 'missing event'}`);
        }
      }

      if (abortSignal?.aborted) {
        const reason = (abortSignal as { reason?: unknown }).reason;
        const err = reason instanceof Error ? reason : new Error(String(reason ?? 'CLIENT_DISCONNECTED'));
        Object.assign(err, { code: 'CLIENT_DISCONNECTED', name: 'AbortError' });
        throw err;
      }

      const response = this.materializeFinalResponse(rawChunks.join(''));
      context.isCompleted = true;
      context.endTime = Date.now();
      context.duration = context.endTime - context.startTime;
      options.onCompletion?.(response);
      this.attachDecodeStats(response, context);
      return response;
    } catch (error) {
      context.isCompleted = true;
      context.endTime = Date.now();
      context.duration = context.endTime - context.startTime;
      options.onError?.(error as Error);
      throw this.wrapError('SSE_TO_JSON_ERROR', error as Error, context.requestId);
    } finally {
      abortHandler?.();
    }
  }

  private materializeFinalResponse(bodyText: string): ResponsesResponse {
    const trimmed = bodyText.trim();
    if (!trimmed) {
      throw new Error('Empty SSE body text');
    }
    const parsed = parseRespFormatEnvelopeWithNative({
      protocol: 'openai-responses',
      payload: {
        mode: 'sse',
        bodyText
      }
    });
    const envelope = parsed.envelope;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new Error('Native responses SSE materializer returned invalid envelope');
    }
    const payload = (envelope as Record<string, unknown>).payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Native responses SSE materializer returned invalid payload');
    }
    return payload as unknown as ResponsesResponse;
  }

  private createReadableStream(sseStream: ResponsesSseEventStream | Readable | AsyncIterable<string | Buffer>): Readable {
    if (sseStream instanceof Readable) {
      return sseStream;
    }
    return Readable.from(this.convertAsyncIterableToStream(sseStream));
  }

  private async *convertAsyncIterableToStream(sseStream: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
    for await (const chunk of sseStream) {
      if (typeof chunk === 'string') {
        yield Buffer.from(chunk);
        continue;
      }
      if (Buffer.isBuffer(chunk)) {
        yield chunk;
        continue;
      }
      if (chunk instanceof Uint8Array) {
        yield Buffer.from(chunk);
        continue;
      }
      throw new Error('Responses SSE decode requires wire string, Buffer, or Uint8Array chunks');
    }
  }

  private async *captureChunkStrings(
    stream: Readable,
    context: SseToResponsesJsonContext,
    rawChunks: string[]
  ): AsyncGenerator<string> {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const now = Date.now();
      context.eventStats.firstFrameAtMs ??= now;
      context.eventStats.lastFrameAtMs = now;
      const chunk = next.value;
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString()
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : (() => {
                throw new Error('Responses SSE decode requires wire string, Buffer, or Uint8Array chunks');
              })();
      rawChunks.push(text);
      yield text;
    }
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context: SseToResponsesJsonContext
  ): Promise<IteratorResult<T>> {
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private resolveTimeoutState(context: SseToResponsesJsonContext): {
    timeoutMs: number;
    anchorMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  } {
    if (context.eventStats.firstFrameAtMs === undefined) {
      const configured = Number(context.options.firstFrameTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        anchorMs: context.startTime,
        code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
      };
    }
    if (context.eventStats.firstContentAtMs === undefined) {
      const configured = Number(context.options.preAnchorIdleTimeoutMs ?? context.options.noContentTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS,
        anchorMs: context.eventStats.lastFrameAtMs ?? context.eventStats.firstFrameAtMs ?? context.startTime,
        code: 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
      };
    }
    const configured = Number(context.options.contentIdleTimeoutMs);
    return {
      timeoutMs: Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_CONTENT_IDLE_TIMEOUT_MS,
      anchorMs: context.eventStats.lastContentAtMs ?? context.eventStats.firstContentAtMs ?? context.startTime,
      code: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    };
  }

  private async raceWithTimeoutState<T>(
    pending: Promise<IteratorResult<T>>,
    context: SseToResponsesJsonContext
  ): Promise<IteratorResult<T>> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutState = this.resolveTimeoutState(context);
    const remainingTimeoutMs = Math.max(1, timeoutState.anchorMs + Math.max(1, timeoutState.timeoutMs) - Date.now());
    try {
      return await Promise.race([
        pending,
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => reject(this.createSemanticTimeoutError(timeoutState)), remainingTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private createSemanticTimeoutError(timeoutState: {
    timeoutMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  }): Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    upstreamCode?: string;
    requestExecutorProviderErrorStage?: string;
  } {
    const { code, timeoutMs } = timeoutState;
    const message =
      code === 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
        ? `Upstream stream produced no frame within ${timeoutMs}ms`
        : code === 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
          ? `Upstream stream produced frames but no semantic progress within ${timeoutMs}ms`
          : `Upstream stream idle after semantic content for ${timeoutMs}ms`;
    const error = new Error(message) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    error.code = code;
    error.status = 504;
    error.statusCode = 504;
    error.retryable = true;
    error.upstreamCode = code;
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return error;
  }

  private markSemanticContentSeen(context: SseToResponsesJsonContext): void {
    const now = Date.now();
    context.eventStats.firstContentAtMs ??= now;
    context.eventStats.lastContentAtMs = now;
  }

  private updateStats(context: SseToResponsesJsonContext, event: ResponsesSseEvent): void {
    context.eventStats.totalEvents++;
    context.eventStats.eventTypes[event.type] = (context.eventStats.eventTypes[event.type] || 0) + 1;

    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0 && hasExplicitToolWrapperProgress(delta)) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      default:
        break;
    }

    if (event.type === 'response.error') {
      context.eventStats.errorCount++;
    }

    context.eventStats.lastEventTime = event.timestamp;
  }

  private wrapError(code: string, originalError: Error, requestId: string): Error {
    const explicitUpstreamCode =
      typeof (originalError as { upstreamCode?: unknown }).upstreamCode === 'string'
        ? String((originalError as { upstreamCode?: string }).upstreamCode).trim()
        : '';
    const explicitStatusCode =
      typeof (originalError as { statusCode?: unknown }).statusCode === 'number'
        ? Number((originalError as { statusCode?: number }).statusCode)
        : typeof (originalError as { status?: unknown }).status === 'number'
          ? Number((originalError as { status?: number }).status)
          : undefined;
    const explicitRetryable =
      typeof (originalError as { retryable?: unknown }).retryable === 'boolean'
        ? Boolean((originalError as { retryable?: boolean }).retryable)
        : undefined;
    const wrapped = ErrorUtils.createError(
      `${code}: ${originalError.message}`,
      code,
      {
        requestId,
        originalError,
        requestExecutorProviderErrorStage: 'provider.sse_decode'
      }
    ) as Error & {
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
      context?: Record<string, unknown>;
    };
    if (explicitStatusCode !== undefined) {
      wrapped.status = explicitStatusCode;
      wrapped.statusCode = explicitStatusCode;
      (wrapped.context as Record<string, unknown>).statusCode = explicitStatusCode;
    }
    if (explicitRetryable !== undefined) {
      wrapped.retryable = explicitRetryable;
      (wrapped.context as Record<string, unknown>).retryable = explicitRetryable;
    }
    if (explicitUpstreamCode) {
      wrapped.upstreamCode = explicitUpstreamCode;
      (wrapped.context as Record<string, unknown>).upstreamCode = explicitUpstreamCode;
    }
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }

  private createContext(options: Partial<SseToResponsesJsonOptions>): SseToResponsesJsonContext {
    const eventStats: ResponsesEventStats = {
      totalEvents: 0,
      eventTypes: {},
      startTime: Date.now(),
      errorCount: 0
    };
    const requestId = typeof options.requestId === 'string' && options.requestId.trim()
      ? options.requestId.trim()
      : 'responses-sse-decode';

    return {
      requestId,
      model: options.model ?? '',
      options: options as SseToResponsesJsonOptions,
      startTime: Date.now(),
      currentResponse: {},
      eventStats,
      isCompleted: false,
      isResponseCreated: false,
      isInProgress: false
    };
  }

  private attachDecodeStats(response: ResponsesResponse, context: SseToResponsesJsonContext): void {
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        ...context.eventStats,
        firstFrameAtMs: context.eventStats.firstFrameAtMs,
        lastFrameAtMs: context.eventStats.lastFrameAtMs,
        firstContentAtMs: context.eventStats.firstContentAtMs,
        lastContentAtMs: context.eventStats.lastContentAtMs
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }
}

export const ResponsesSseToJsonConverter = ResponsesSseToJsonConverterRefactored;
