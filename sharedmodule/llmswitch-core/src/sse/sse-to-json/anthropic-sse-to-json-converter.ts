// feature_id: sse.anthropic_gemini_stream_projection
import type {
  AnthropicMessageResponse,
  SseToAnthropicJsonOptions,
  SseToAnthropicJsonContext
} from '../types/index.js';
import { buildAnthropicJsonFromSseWithNative } from '../../native/router-hotpath/native-anthropic-sse-event-payload.js';
import { ErrorUtils } from '../shared/utils.js';

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 300_000;

export class AnthropicSseToJsonConverter {
  private contexts = new Map<string, SseToAnthropicJsonContext>();

  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToAnthropicJsonOptions
  ): Promise<AnthropicMessageResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      const bodyText = await this.collectBodyText(sseStream, context);
      const resultStartedAt = Date.now();
      const response = buildAnthropicJsonFromSseWithNative({
        bodyText,
        requestId: options.requestId,
        model: options.model,
        config: {
          reasoningMode: options.reasoningMode,
          reasoningTextPrefix: options.reasoningTextPrefix
        }
      }) as unknown as AnthropicMessageResponse;
      context.eventStats.builderMs = Math.max(0, Date.now() - resultStartedAt);
      context.isCompleted = true;
      context.eventStats.endTime = Date.now();
      this.attachDecodeStats(response, context);
      return response;
    } catch (error) {
      context.eventStats.errors = (context.eventStats.errors ?? 0) + 1;
      throw this.wrapError('ANTHROPIC_SSE_TO_JSON_FAILED', error as Error, options.requestId);
    } finally {
      this.contexts.delete(options.requestId);
    }
  }

  private createContext(options: SseToAnthropicJsonOptions): SseToAnthropicJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options,
      startTime: Date.now(),
      eventStats: {
        totalEvents: 0,
        contentBlocks: 0,
        toolUseBlocks: 0,
        thinkingBlocks: 0,
        textBlocks: 0,
        errors: 0,
        chunkCount: 0,
        byteCount: 0,
        parserMs: 0,
        builderMs: 0,
        messageStopSeen: false,
        startTime: Date.now()
      },
      isCompleted: false
    };
  }

  private async collectBodyText(
    stream: AsyncIterable<string | Buffer>,
    context: SseToAnthropicJsonContext
  ): Promise<string> {
    const chunks: string[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const now = Date.now();
      const text = typeof next.value === 'string' ? next.value : next.value.toString();
      context.eventStats.firstFrameAtMs ??= now;
      context.eventStats.lastFrameAtMs = now;
      context.eventStats.firstChunkAtMs ??= now;
      context.eventStats.lastChunkAtMs = now;
      context.eventStats.chunkCount = (context.eventStats.chunkCount ?? 0) + 1;
      context.eventStats.byteCount = (context.eventStats.byteCount ?? 0) + Buffer.byteLength(text);
      chunks.push(text);
    }
    return chunks.join('');
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context: SseToAnthropicJsonContext
  ): Promise<IteratorResult<T>> {
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private resolveTimeoutState(context: SseToAnthropicJsonContext): {
    timeoutMs: number;
    anchorMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  } {
    const options = context.options;
    if (context.eventStats.firstFrameAtMs === undefined) {
      const configured = Number(options?.firstFrameTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        anchorMs: context.startTime,
        code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
      };
    }
    if (!context.isCompleted) {
      const configured = Number(options?.preAnchorIdleTimeoutMs ?? options?.noContentTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS,
        anchorMs: context.eventStats.lastFrameAtMs ?? context.eventStats.firstFrameAtMs ?? context.startTime,
        code: 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
      };
    }
    const configured = Number(options?.contentIdleTimeoutMs);
    return {
      timeoutMs: Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_CONTENT_IDLE_TIMEOUT_MS,
      anchorMs: context.eventStats.lastChunkAtMs ?? context.eventStats.firstChunkAtMs ?? context.startTime,
      code: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    };
  }

  private async raceWithTimeoutState<T>(
    pending: Promise<IteratorResult<T>>,
    context: SseToAnthropicJsonContext
  ): Promise<IteratorResult<T>> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutState = this.resolveTimeoutState(context);
    const remainingTimeoutMs = Math.max(1, timeoutState.anchorMs + Math.max(1, timeoutState.timeoutMs) - Date.now());
    try {
      return await Promise.race([
        pending,
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(
            () => reject(this.createSemanticTimeoutError(timeoutState)),
            remainingTimeoutMs
          );
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

  private attachDecodeStats(response: AnthropicMessageResponse, context: SseToAnthropicJsonContext): void {
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        ...context.eventStats,
        streamMs:
          context.eventStats.firstChunkAtMs !== undefined && context.eventStats.lastChunkAtMs !== undefined
            ? Math.max(0, context.eventStats.lastChunkAtMs - context.eventStats.firstChunkAtMs)
            : undefined,
        eventSpanMs: undefined
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    const explicitCode =
      typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code?: string }).code).trim()
        : '';
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
    const wrapped = ErrorUtils.createError(error.message, code, {
      requestId,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    }) as Error & {
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
    const upstreamCode = explicitUpstreamCode || explicitCode;
    if (upstreamCode) {
      wrapped.upstreamCode = upstreamCode === 'TERMINATED' ? 'UPSTREAM_STREAM_TERMINATED' : upstreamCode;
      (wrapped.context as Record<string, unknown>).upstreamCode = wrapped.upstreamCode;
    }
    if (explicitCode === 'TERMINATED' && explicitStatusCode === undefined) {
      wrapped.status = 502;
      wrapped.statusCode = 502;
      (wrapped.context as Record<string, unknown>).statusCode = 502;
    }
    if (explicitCode === 'TERMINATED' && explicitRetryable === undefined) {
      wrapped.retryable = true;
      (wrapped.context as Record<string, unknown>).retryable = true;
    }
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }
}
