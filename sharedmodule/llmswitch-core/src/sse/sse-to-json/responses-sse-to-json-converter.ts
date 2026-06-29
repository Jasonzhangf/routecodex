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
  private config: {
    timeoutMs: number;
    enableEventValidation: boolean;
    enableSequenceValidation: boolean;
    strictMode: boolean;
    validateOutputItems: boolean;
  } = {
    timeoutMs: 900_000,
    enableEventValidation: true,
    enableSequenceValidation: false,
    strictMode: false,
    validateOutputItems: true
  };

  private contexts = new Map<string, SseToResponsesJsonContext>();

  constructor(config?: Partial<ResponsesSseToJsonConverterRefactored['config']>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async convertSseToJson(
    sseStream: ResponsesSseEventStream | Readable | AsyncIterable<string | Buffer>,
    options: SseToResponsesJsonOptions
  ): Promise<ResponsesResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    let abortableStream: Readable | null = null;
    const rawChunks: string[] = [];

    try {
      const parser = createSseParser({
        enableStrictValidation: this.config.enableEventValidation,
        enableEventRecovery: !this.config.strictMode
      });

      const readableStream = this.createReadableStream(sseStream);
      abortableStream = readableStream;

      if (abortSignal && !abortSignal.aborted) {
        const onAbort = () => {
          context.isCompleted = true;
          try {
            abortableStream?.destroy();
          } catch {
            // best effort
          }
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
          if (this.config.enableSequenceValidation && !this.validateSequenceNumber(event, context)) {
            throw new Error(`Invalid sequence number: ${event.sequenceNumber}`);
          }
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

        if (!parseResult.success && this.config.strictMode) {
          throw new Error(`Failed to parse SSE event: ${parseResult.error}`);
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
      throw this.wrapError('SSE_TO_JSON_ERROR', error as Error, options.requestId);
    } finally {
      abortHandler?.();
      this.clearContext(options.requestId);
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

  private resolveSseFailureMetadata(error: Error): {
    upstreamCode: string;
    statusCode: number;
    retryable: boolean;
  } {
    const explicitUpstreamCode =
      typeof (error as { upstreamCode?: unknown }).upstreamCode === 'string'
        ? String((error as { upstreamCode?: string }).upstreamCode).trim()
        : '';
    const explicitStatusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? Number((error as { statusCode?: number }).statusCode)
        : typeof (error as { status?: unknown }).status === 'number'
          ? Number((error as { status?: number }).status)
          : undefined;
    const explicitRetryable =
      typeof (error as { retryable?: unknown }).retryable === 'boolean'
        ? Boolean((error as { retryable?: boolean }).retryable)
        : undefined;
    const errorCode = typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code?: string }).code).trim().toUpperCase()
      : '';
    const normalized = error.message.toLowerCase();
    const normalizedUpstreamCode = explicitUpstreamCode.toLowerCase();
    if (
      normalizedUpstreamCode.includes('context_length_exceeded')
      || normalizedUpstreamCode.includes('context_window_exceeded')
      || normalizedUpstreamCode.includes('model_context_window_exceeded')
      || errorCode === 'CONTEXT_LENGTH_EXCEEDED'
      || normalized.includes('context_length_exceeded')
      || normalized.includes('context window')
    ) {
      return {
        upstreamCode: explicitUpstreamCode || 'context_length_exceeded',
        statusCode: explicitStatusCode ?? 400,
        retryable: explicitRetryable ?? false
      };
    }
    if (explicitUpstreamCode || explicitStatusCode !== undefined || explicitRetryable !== undefined) {
      return {
        upstreamCode: explicitUpstreamCode || errorCode || 'SSE_TO_JSON_ERROR',
        statusCode: explicitStatusCode ?? 502,
        retryable: explicitRetryable ?? true
      };
    }
    if (errorCode === 'UPSTREAM_STREAM_IDLE_TIMEOUT' || normalized.includes('upstream_stream_idle_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_IDLE_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT' || normalized.includes('upstream_stream_no_content_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT' || normalized.includes('upstream_stream_content_idle_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_TIMEOUT' || normalized.includes('upstream_stream_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_HEADERS_TIMEOUT' || normalized.includes('upstream_headers_timeout')) {
      return { upstreamCode: 'UPSTREAM_HEADERS_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_INCOMPLETE' || normalized.includes('stream incomplete')) {
      return { upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE', statusCode: 502, retryable: true };
    }
    if (errorCode === 'TERMINATED' || normalized.includes('terminated')) {
      return { upstreamCode: 'UPSTREAM_STREAM_TERMINATED', statusCode: 502, retryable: true };
    }
    return { upstreamCode: errorCode || 'SSE_TO_JSON_ERROR', statusCode: 502, retryable: true };
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
      yield Buffer.from(this.serializeEventToSSE(chunk as Partial<ResponsesSseEvent> | Record<string, unknown>));
    }
  }

  private serializeEventToSSE(event: Partial<ResponsesSseEvent> | Record<string, unknown>): string {
    const type = typeof event.type === 'string' ? event.type : 'data';
    const data = event.data ? JSON.stringify(event.data) : '';
    return `event: ${type}\ndata: ${data}\n\n`;
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
          : this.serializeEventToSSE(chunk as Partial<ResponsesSseEvent> | Record<string, unknown>);
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

  private validateSequenceNumber(event: ResponsesSseEvent, context: SseToResponsesJsonContext): boolean {
    if (typeof event.sequenceNumber !== 'number') {
      context.lastSequenceNumber += 1;
      event.sequenceNumber = context.lastSequenceNumber;
      return true;
    }
    if (event.sequenceNumber <= context.lastSequenceNumber) {
      return false;
    }
    context.lastSequenceNumber = event.sequenceNumber;
    return true;
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

    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
      case 'response.required_action':
      case 'response.done':
        context.eventStats.messageEventsCount++;
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        context.eventStats.outputItemsCount++;
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        context.eventStats.contentPartsCount++;
        break;
      case 'response.output_text.delta':
      case 'response.output_text.done':
        context.eventStats.deltaEventsCount++;
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
        context.eventStats.reasoningEventsCount++;
        break;
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        context.eventStats.functionCallEventsCount++;
        break;
      case 'response.error':
        context.eventStats.errorCount++;
        break;
      default:
        break;
    }

    context.eventStats.lastEventTime = event.timestamp;
  }

  private wrapError(code: string, originalError: Error, requestId: string): Error {
    const failure = this.resolveSseFailureMetadata(originalError);
    const wrapped = ErrorUtils.createError(
      `${code}: ${originalError.message}`,
      code,
      {
        requestId,
        originalError,
        upstreamCode: failure.upstreamCode,
        statusCode: failure.statusCode,
        retryable: failure.retryable,
        requestExecutorProviderErrorStage: 'provider.sse_decode'
      }
    ) as Error & {
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    wrapped.status = failure.statusCode;
    wrapped.statusCode = failure.statusCode;
    wrapped.retryable = failure.retryable;
    wrapped.upstreamCode = failure.upstreamCode;
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }

  private createContext(options: SseToResponsesJsonOptions): SseToResponsesJsonContext {
    const eventStats: ResponsesEventStats = {
      totalEvents: 0,
      eventTypes: {},
      startTime: Date.now(),
      outputItemsCount: 0,
      contentPartsCount: 0,
      deltaEventsCount: 0,
      reasoningEventsCount: 0,
      functionCallEventsCount: 0,
      messageEventsCount: 0,
      errorCount: 0
    };

    return {
      requestId: options.requestId,
      model: options.model,
      options,
      startTime: Date.now(),
      currentResponse: {},
      eventStats,
      isCompleted: false,
      isResponseCreated: false,
      isInProgress: false,
      lastSequenceNumber: -1
    };
  }

  getContext(requestId: string): SseToResponsesJsonContext | undefined {
    return this.contexts.get(requestId);
  }

  clearContext(requestId: string): void {
    this.contexts.delete(requestId);
  }

  getActiveContexts(): Map<string, SseToResponsesJsonContext> {
    return new Map(this.contexts);
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
